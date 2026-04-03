import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { pool } from "./db";
import { authMiddleware, generateToken, requireRole, type JwtPayload } from "./auth";
import { scrapeFormFields } from "./scraper";
import { loginSchema, registerSchema, proxyConfigSchema, createAgentSchema } from "@shared/schema";
import type { FormField } from "@shared/schema";
import { z } from "zod";
import bcrypt from "bcryptjs";
import axios from "axios";
import { autoFillForm, extractTrustedFormData, type AutoFillProgress, type ProxyConfig as BrowserProxyConfig } from "./browser";
import { getWorkingProxy } from "./proxy-tester";

const sseClients = new Map<string, import("express").Response[]>();
const abortControllers = new Map<string, AbortController>();

function normalizeProxyHost(host: string): string {
  const stripped = host.trim().replace(/^[a-z][a-z0-9+\-.]*:\/\//i, "").split("/")[0].trim();
  return stripped.replace(/:\d+$/, "");
}

function sendSSE(submissionId: string, data: AutoFillProgress) {
  const clients = sseClients.get(submissionId) || [];
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  clients.forEach((c) => {
    try { c.write(msg); } catch { }
  });
  if (data.step === "complete" || data.step === "error") {
    clients.forEach((c) => {
      try { c.end(); } catch { }
    });
    sseClients.delete(submissionId);
  }
}

const ZIP_FIELD_NAMES = ["zip", "zipcode", "zip_code", "postal", "postalcode", "postal_code"];
const STATE_FIELD_NAMES = ["state", "state_name"];
const COUNTRY_FIELD_NAMES = ["country", "country_code", "country_name"];

const US_STATE_CODES: Record<string, string> = {
  alabama: "al", alaska: "ak", arizona: "az", arkansas: "ar", california: "ca",
  colorado: "co", connecticut: "ct", delaware: "de", florida: "fl", georgia: "ga",
  hawaii: "hi", idaho: "id", illinois: "il", indiana: "in", iowa: "ia",
  kansas: "ks", kentucky: "ky", louisiana: "la", maine: "me", maryland: "md",
  massachusetts: "ma", michigan: "mi", minnesota: "mn", mississippi: "ms", missouri: "mo",
  montana: "mt", nebraska: "ne", nevada: "nv", new_hampshire: "nh", new_jersey: "nj",
  new_mexico: "nm", new_york: "ny", north_carolina: "nc", north_dakota: "nd", ohio: "oh",
  oklahoma: "ok", oregon: "or", pennsylvania: "pa", rhode_island: "ri", south_carolina: "sc",
  south_dakota: "sd", tennessee: "tn", texas: "tx", utah: "ut", vermont: "vt",
  virginia: "va", washington: "wa", west_virginia: "wv", wisconsin: "wi", wyoming: "wy",
};

function lookupStateCode(stateValue: string): string | null {
  const normalized = stateValue.toLowerCase().replace(/\s+/g, "_").replace(/[^a-z_]/g, "");
  // Accept a 2-letter input only if it's actually a valid state abbreviation
  const allCodes = new Set(Object.values(US_STATE_CODES));
  if (normalized.length === 2 && allCodes.has(normalized)) return normalized;
  return US_STATE_CODES[normalized] ?? null;
}

// Consolidated geo extraction
function extractGeoTargets(formData: Record<string, string>, fields?: import("@shared/schema").FormField[]): { zip: string | null; state: string | null; county: string | null; country: string | null } {
  let zip: string | null = null;
  let state: string | null = null;
  let county: string | null = null;
  let country: string | null = null;

  // 1. Explicit geoRole assignment wins
  if (fields && fields.length > 0) {
    const zipField = fields.find((f) => f.geoRole === "zip");
    if (zipField && formData[zipField.name]?.trim()) {
      zip = formData[zipField.name].trim();
    }
    const stateField = fields.find((f) => f.geoRole === "state");
    if (stateField && formData[stateField.name]?.trim()) {
      state = formData[stateField.name].trim();
    }
    const countyField = fields.find((f) => f.geoRole === "county");
    if (countyField && formData[countyField.name]?.trim()) {
      county = formData[countyField.name].trim();
    }
  }

  // 2. Fallback: name-based heuristics (only if not already found via roles)
  if (!zip) {
    for (const key of Object.keys(formData)) {
      if (matchesZipField(key) && formData[key]?.trim()) {
        zip = formData[key].trim();
        break;
      }
    }
  }

  if (!state) {
    for (const key of Object.keys(formData)) {
      if (matchesStateField(key) && formData[key]?.trim()) {
        state = formData[key].trim();
        break;
      }
    }
  }

  if (!county) {
    for (const key of Object.keys(formData)) {
      if (matchesCountyField(key) && formData[key]?.trim()) {
        county = formData[key].trim();
        break;
      }
    }
  }

  // Country: check form data by field name heuristics, default to "us" if not found
  for (const key of Object.keys(formData)) {
    if (matchesCountryField(key) && formData[key]?.trim()) {
      country = formData[key].trim().toLowerCase();
      break;
    }
  }
  if (!country) {
    country = "us"; // Default country fallback
  }

  return { zip, state, county, country };
}

function buildStateFallbackUsername(baseUsername: string, stateCode: string): string {
  if (baseUsername.includes("zip-{zip}")) {
    return baseUsername.replace("zip-{zip}", `state-${stateCode}`);
  }
  if (baseUsername.includes("{zip}")) {
    return baseUsername.replace(/\{zip\}/g, stateCode);
  }
  return `${baseUsername}-state-${stateCode}`;
}
const ZIP_KEYWORDS = ["zip", "postal"];
const STATE_KEYWORDS = ["state"];
const COUNTY_KEYWORDS = ["county", "parish", "borough"];
const COUNTRY_KEYWORDS = ["country"];

function matchesZipField(key: string): boolean {
  const k = key.toLowerCase();
  if (ZIP_FIELD_NAMES.includes(k)) return true;
  // Match prefix: zip_code, postal_address, etc.
  if (ZIP_KEYWORDS.some((kw) => k === kw || k.startsWith(kw + "-") || k.startsWith(kw + "_") || k.startsWith(kw + " "))) return true;
  // Match suffix / middle: billing_zip, address_zip_code, address_postal, etc.
  return ZIP_KEYWORDS.some((kw) => k.includes("_" + kw) || k.includes("-" + kw) || k.includes(" " + kw));
}

function matchesStateField(key: string): boolean {
  const k = key.toLowerCase();
  if (STATE_FIELD_NAMES.includes(k)) return true;
  // Match prefix: state_code, state_name, etc.
  if (STATE_KEYWORDS.some((kw) => k === kw || k.startsWith(kw + "-") || k.startsWith(kw + "_") || k.startsWith(kw + " "))) return true;
  // Match suffix / middle: billing_state, shipping_state, etc.
  return STATE_KEYWORDS.some((kw) => k.includes("_" + kw) || k.includes("-" + kw) || k.includes(" " + kw));
}

function matchesCountyField(key: string): boolean {
  const k = key.toLowerCase();
  // Stringent check to avoid phone numbers (e.g. 5057017913) being picked up
  if (COUNTY_KEYWORDS.some((kw) => k === kw || k.startsWith(kw + "_") || k.startsWith(kw + "-") || k.startsWith(kw + " "))) return true;
  if (COUNTY_KEYWORDS.some((kw) => k.endsWith("_" + kw) || k.endsWith("-" + kw) || k.endsWith(" " + kw))) return true;
  return false;
}

function matchesCountryField(key: string): boolean {
  const k = key.toLowerCase();
  if (COUNTRY_FIELD_NAMES.includes(k)) return true;
  if (COUNTRY_KEYWORDS.some((kw) => k === kw || k.startsWith(kw + "_") || k.startsWith(kw + "-") || k.startsWith(kw + " "))) return true;
  if (COUNTRY_KEYWORDS.some((kw) => k.endsWith("_" + kw) || k.endsWith("-" + kw) || k.endsWith(" " + kw))) return true;
  return false;
}





export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {

  app.get("/api/health", async (_req, res) => {
    try {
      const dbStatus = await pool.connect().then(c => { c.release(); return "connected"; }).catch(e => `error: ${e.message}`);
      res.json({
        status: "ok",
        database: dbStatus,
        time: new Date().toISOString(),
        env: {
          node: process.env.NODE_ENV
        }
      });
    } catch (err: any) {
      res.status(500).json({ status: "error", message: err.message });
    }
  });

  app.post("/api/auth/login", async (req, res) => {
    try {
      const parsed = loginSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: "Invalid email or password format" });
      }

      console.log(`[auth] Attempting login for email: ${parsed.data.email}`);
      const user = await storage.getUserByEmail(parsed.data.email);
      console.log(`[auth] User lookup result: ${user ? "Found" : "Not Found"}`);
      if (!user) {
        return res.status(401).json({ message: "Invalid credentials" });
      }

      if (!user.isActive) {
        return res.status(403).json({ message: "Account is disabled" });
      }

      const valid = await bcrypt.compare(parsed.data.password, user.password);
      if (!valid) {
        return res.status(401).json({ message: "Invalid credentials" });
      }

      await storage.updateUser(user.id, { lastActive: new Date() });

      const token = generateToken({ userId: user.id, email: user.email, role: user.role });
      const { password, ...userWithoutPassword } = user;
      return res.json({ token, user: userWithoutPassword });
    } catch (error: any) {
      return res.status(500).json({ message: error.message });
    }
  });

  app.post("/api/auth/register", async (req, res) => {
    try {
      const parsed = registerSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: "Invalid registration data" });
      }

      const existing = await storage.getUserByEmail(parsed.data.email);
      if (existing) {
        return res.status(409).json({ message: "Email already registered" });
      }

      const user = await storage.createUser({
        name: parsed.data.name,
        email: parsed.data.email,
        password: parsed.data.password,
        role: "user",
        isActive: true,
      });

      const token = generateToken({ userId: user.id, email: user.email, role: user.role });
      const { password, ...userWithoutPassword } = user;
      return res.json({ token, user: userWithoutPassword });
    } catch (error: any) {
      return res.status(500).json({ message: error.message });
    }
  });

  app.get("/api/auth/me", authMiddleware, async (req, res) => {
    try {
      const user = await storage.getUser(req.user!.userId);
      if (!user) return res.status(404).json({ message: "User not found" });
      const { password, ...userWithoutPassword } = user;
      return res.json(userWithoutPassword);
    } catch (error: any) {
      return res.status(500).json({ message: error.message });
    }
  });

  app.get("/api/admin/users", authMiddleware, requireRole("admin"), async (_req, res) => {
    try {
      const allUsers = await storage.getAllUsers();
      const usersWithStats = await Promise.all(allUsers.map(async (u) => {
        const userSites = await storage.getSitesByOwner(u.id);
        const userSubmissions = await storage.getSubmissionsByAgent(u.id);
        const { password, ...rest } = u;
        return {
          ...rest,
          totalSites: userSites.length,
          totalSubmissions: userSubmissions.length,
        };
      }));
      return res.json(usersWithStats);
    } catch (error: any) {
      return res.status(500).json({ message: error.message });
    }
  });

  app.patch("/api/admin/users/:id/toggle", authMiddleware, requireRole("admin"), async (req, res) => {
    try {
      const user = await storage.getUser(req.params.id as string);
      if (!user) return res.status(404).json({ message: "User not found" });
      const updated = await storage.updateUser(req.params.id as string, { isActive: !user.isActive });
      return res.json(updated);
    } catch (error: any) {
      return res.status(500).json({ message: error.message });
    }
  });

  app.delete("/api/admin/users/:id", authMiddleware, requireRole("admin"), async (req, res) => {
    try {
      await storage.deleteUser(req.params.id as string);
      return res.json({ success: true });
    } catch (error: any) {
      return res.status(500).json({ message: error.message });
    }
  });

  app.post("/api/admin/users", authMiddleware, requireRole("admin"), async (req, res) => {
    try {
      const { name, email, password, role } = req.body;
      if (!name || !email || !password) {
        return res.status(400).json({ message: "Name, email, and password are required" });
      }
      const existing = await storage.getUserByEmail(email);
      if (existing) return res.status(409).json({ message: "Email already exists" });

      const user = await storage.createUser({ name, email, password, role: role || "user", isActive: true });
      const { password: _, ...userWithoutPassword } = user;
      return res.json(userWithoutPassword);
    } catch (error: any) {
      return res.status(500).json({ message: error.message });
    }
  });

  app.get("/api/admin/stats", authMiddleware, requireRole("admin"), async (_req, res) => {
    try {
      const allUsers = await storage.getAllUsers();
      const totalSites = await storage.getTotalSiteCount();
      const totalSubmissions = await storage.getSubmissionCount();
      const activeUsers = allUsers.filter(u => u.isActive).length;

      return res.json({
        totalUsers: allUsers.length,
        totalSites,
        totalSubmissions,
        activeUsers,
      });
    } catch (error: any) {
      return res.status(500).json({ message: error.message });
    }
  });

  app.post("/api/sites/scrape", authMiddleware, requireRole("user"), async (req, res) => {
    try {
      const { url } = req.body;
      if (!url) return res.status(400).json({ message: "URL is required" });

      const result = await scrapeFormFields(url);
      return res.json(result);
    } catch (error: any) {
      return res.status(500).json({ message: `Failed to scrape: ${error.message}` });
    }
  });

  app.post("/api/sites", authMiddleware, requireRole("user"), async (req, res) => {
    try {
      const { name, url, formSelector, submitSelector, fields } = req.body;
      if (!name || !url) return res.status(400).json({ message: "Name and URL required" });

      const site = await storage.createSite({
        ownerId: req.user!.userId,
        name,
        url,
        formSelector,
        submitSelector,
        fields: fields || [],
        isActive: true,
      });
      return res.json(site);
    } catch (error: any) {
      return res.status(500).json({ message: error.message });
    }
  });

  app.get("/api/sites", authMiddleware, requireRole("user"), async (req, res) => {
    try {
      const userSites = await storage.getSitesByOwner(req.user!.userId);
      return res.json(userSites);
    } catch (error: any) {
      return res.status(500).json({ message: error.message });
    }
  });

  app.get("/api/sites/:id", authMiddleware, async (req, res) => {
    try {
      const site = await storage.getSite(req.params.id);
      if (!site) return res.status(404).json({ message: "Site not found" });
      if (site.ownerId !== req.user!.userId && req.user!.role !== "admin") {
        return res.status(403).json({ message: "Access denied" });
      }
      return res.json(site);
    } catch (error: any) {
      return res.status(500).json({ message: error.message });
    }
  });

  app.delete("/api/sites/:id", authMiddleware, requireRole("user"), async (req, res) => {
    try {
      const site = await storage.getSite(req.params.id);
      if (!site) return res.status(404).json({ message: "Site not found" });
      if (site.ownerId !== req.user!.userId) {
        return res.status(403).json({ message: "Access denied" });
      }
      await storage.deleteSite(req.params.id);
      return res.json({ success: true });
    } catch (error: any) {
      return res.status(500).json({ message: error.message });
    }
  });

  app.put("/api/sites/:id", authMiddleware, requireRole("user"), async (req, res) => {
    try {
      const site = await storage.getSite(req.params.id);
      if (!site) return res.status(404).json({ message: "Site not found" });
      if (site.ownerId !== req.user!.userId) {
        return res.status(403).json({ message: "Access denied" });
      }
      const { fields } = req.body;
      if (!Array.isArray(fields)) {
        return res.status(400).json({ message: "fields array required" });
      }

      const updated = await storage.updateSite(req.params.id, { fields });
      return res.json(updated);
    } catch (error: any) {
      return res.status(500).json({ message: error.message });
    }
  });

  app.post("/api/agents", authMiddleware, requireRole("user"), async (req, res) => {
    try {
      const parsed = createAgentSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: "Invalid agent data" });
      }

      const existing = await storage.getUserByEmail(parsed.data.email);
      if (existing) return res.status(409).json({ message: "Email already exists" });

      const agent = await storage.createUser({
        name: parsed.data.name,
        email: parsed.data.email,
        password: parsed.data.password,
        role: "agent",
        isActive: true,
        parentUserId: req.user!.userId,
      });

      for (const siteId of parsed.data.siteIds) {
        await storage.assignSiteToAgent(agent.id, siteId);
      }

      const { password, ...agentWithoutPassword } = agent;
      return res.json({ ...agentWithoutPassword, assignedSiteIds: parsed.data.siteIds });
    } catch (error: any) {
      return res.status(500).json({ message: error.message });
    }
  });

  app.get("/api/agents", authMiddleware, requireRole("user"), async (req, res) => {
    try {
      const agents = await storage.getAgentsByParent(req.user!.userId);
      const agentsWithSites = await Promise.all(agents.map(async (a) => {
        const siteIds = await storage.getAgentSiteIds(a.id);
        const { password, ...rest } = a;
        return { ...rest, assignedSiteIds: siteIds };
      }));
      return res.json(agentsWithSites);
    } catch (error: any) {
      return res.status(500).json({ message: error.message });
    }
  });

  app.get("/api/submissions", authMiddleware, requireRole("user"), async (req, res) => {
    try {
      const agents = await storage.getAgentsByParent(req.user!.userId);
      const agentIds = agents.map(a => a.id);

      const allSubs = [];
      for (const agentId of agentIds) {
        const subs = await storage.getSubmissionsByAgent(agentId);
        allSubs.push(...subs);
      }

      return res.json(allSubs.sort((a, b) => new Date(b.createdAt!).getTime() - new Date(a.createdAt!).getTime()));
    } catch (error: any) {
      return res.status(500).json({ message: error.message });
    }
  });

  app.delete("/api/agents/:id", authMiddleware, requireRole("user"), async (req, res) => {
    try {
      const agent = await storage.getUser(req.params.id);
      if (!agent || agent.parentUserId !== req.user!.userId) {
        return res.status(404).json({ message: "Agent not found" });
      }
      await storage.deleteUser(req.params.id);
      return res.json({ success: true });
    } catch (error: any) {
      return res.status(500).json({ message: error.message });
    }
  });

  app.put("/api/proxy", authMiddleware, requireRole("user"), async (req, res) => {
    try {
      const bodySchema = proxyConfigSchema.extend({
        proxyStateUsername: z.string().optional(),
        proxyCountyUsername: z.string().optional(),
        proxyCountryUsername: z.string().optional(),
        proxySiteIds: z.array(z.string()).nullable().optional(),
      });
      const parsed = bodySchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: "Invalid proxy configuration" });
      }

      await storage.updateUser(req.user!.userId, {
        proxyHost: normalizeProxyHost(parsed.data.proxyHost),
        proxyPort: parsed.data.proxyPort,
        proxyUsername: parsed.data.proxyUsername,
        proxyPassword: parsed.data.proxyPassword,
        proxyType: parsed.data.proxyType,
        proxyStateUsername: parsed.data.proxyStateUsername ?? null,
        proxyCountyUsername: parsed.data.proxyCountyUsername ?? null,
        proxyCountryUsername: parsed.data.proxyCountryUsername ?? null,
        proxySiteIds: parsed.data.proxySiteIds !== undefined ? parsed.data.proxySiteIds : null,
      });

      return res.json({ success: true });
    } catch (error: any) {
      return res.status(500).json({ message: error.message });
    }
  });

  app.get("/api/proxy", authMiddleware, requireRole("user"), async (req, res) => {
    try {
      const user = await storage.getUser(req.user!.userId);
      if (!user) return res.status(404).json({ message: "User not found" });

      // Clean up stale proxySiteIds — remove IDs for sites that no longer exist
      let proxySiteIds = user.proxySiteIds ?? null;
      if (Array.isArray(proxySiteIds) && proxySiteIds.length > 0) {
        const userSites = await storage.getSitesByOwner(req.user!.userId);
        const validIds = new Set(userSites.map((s) => s.id));
        const filtered = proxySiteIds.filter((id) => validIds.has(id));
        proxySiteIds = filtered.length === 0 ? null : filtered;
      }

      return res.json({
        proxyHost: user.proxyHost ? normalizeProxyHost(user.proxyHost) : "",
        proxyPort: user.proxyPort || 0,
        proxyUsername: user.proxyUsername || "",
        proxyPassword: user.proxyPassword || "",
        proxyType: user.proxyType || "http",
        proxyStateUsername: user.proxyStateUsername || "",
        proxyCountyUsername: user.proxyCountyUsername || "",
        proxyCountryUsername: user.proxyCountryUsername || "",
        proxySiteIds,
      });
    } catch (error: any) {
      return res.status(500).json({ message: error.message });
    }
  });

  app.post("/api/proxy/test", authMiddleware, requireRole("user"), async (req, res) => {
    try {
      const user = await storage.getUser(req.user!.userId);
      if (!user || !user.proxyHost || !user.proxyPort) {
        return res.status(400).json({ success: false, message: "No proxy configured. Save your proxy settings first." });
      }

      // Substitute a test zip/state into the template for testing
      const testUsername = (user.proxyUsername || "")
        .replace(/\{zip\}/g, "90210")
        .replace(/\{state\}/g, "ca");
      const response = await axios.get("https://api.ipify.org?format=json", {
        proxy: {
          host: normalizeProxyHost(user.proxyHost),
          port: user.proxyPort,
          auth: {
            username: testUsername,
            password: user.proxyPassword || "",
          },
          protocol: user.proxyType || "http",
        },
        timeout: 10000,
      });

      return res.json({ success: true, ip: response.data.ip });
    } catch (error: any) {
      return res.status(400).json({ success: false, message: `Proxy test failed: ${error.message}` });
    }
  });

  app.get("/api/agent/sites", authMiddleware, requireRole("agent"), async (req, res) => {
    try {
      const agentSites = await storage.getSitesForAgent(req.user!.userId);
      return res.json(agentSites);
    } catch (error: any) {
      return res.status(500).json({ message: error.message });
    }
  });

  app.get("/api/agent/submissions", authMiddleware, requireRole("agent"), async (req, res) => {
    try {
      const subs = await storage.getSubmissionsByAgent(req.user!.userId);
      return res.json(subs);
    } catch (error: any) {
      return res.status(500).json({ message: error.message });
    }
  });

  app.get("/api/agent/submissions/:id/progress", authMiddleware, requireRole("agent"), async (req, res) => {
    const submissionId = req.params.id as string;

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write("\n");

    if (!sseClients.has(submissionId)) {
      sseClients.set(submissionId, []);
    }
    sseClients.get(submissionId)!.push(res);

    req.on("close", () => {
      const clients = sseClients.get(submissionId) || [];
      sseClients.set(submissionId, clients.filter((c) => c !== res));
    });
  });

  app.post("/api/agent/submissions", authMiddleware, requireRole("agent"), async (req, res) => {
    try {
      const submissionPayload = z.object({
        siteId: z.string().min(1),
        formData: z.record(z.string(), z.string()),
      }).safeParse(req.body);

      if (!submissionPayload.success) {
        return res.status(400).json({ message: "Invalid submission: site ID (string) and form data (object) required" });
      }

      const { siteId, formData } = submissionPayload.data;

      const assignedSiteIds = await storage.getAgentSiteIds(req.user!.userId);
      if (!assignedSiteIds.includes(siteId)) {
        return res.status(403).json({ message: "Site not assigned to you" });
      }

      const agent = await storage.getUser(req.user!.userId);
      if (!agent) return res.status(404).json({ message: "Agent not found" });

      const site = await storage.getSite(siteId);
      if (!site) return res.status(404).json({ message: "Site not found" });

      let proxyHost: string | null = null;
      let proxyPort: number | null = null;
      let proxyLocation: string | null = null;
      let proxyMethod: string | null = "none";
      let browserProxy: BrowserProxyConfig | null = null;
      let proxyConfigured = false;

      if (agent.parentUserId) {
        const parentUser = await storage.getUser(agent.parentUserId);
        if (parentUser && parentUser.proxyHost && parentUser.proxyPort && parentUser.proxyUsername && parentUser.proxyPassword) {
          let effectiveSiteIds = parentUser.proxySiteIds;
          if (Array.isArray(parentUser.proxySiteIds) && parentUser.proxySiteIds.length > 0) {
            const parentSites = await storage.getSitesByOwner(agent.parentUserId);
            const validIds = new Set(parentSites.map((s) => s.id));
            const stillValid = parentUser.proxySiteIds.filter((id) => validIds.has(id));
            effectiveSiteIds = stillValid.length === 0 ? null : stillValid;
          }

          const proxyAppliesToSite =
            effectiveSiteIds === null ||
            (Array.isArray(effectiveSiteIds) && effectiveSiteIds.includes(siteId));

          if (proxyAppliesToSite) {
            proxyConfigured = true;

            // Extract ZIP and state from the form data submitted by the agent
            const { zip: zipValue, state: stateCode, county: countyValue, country: countryValue } = extractGeoTargets(formData, (site.fields || []) as FormField[]);
            const zipUsernameTemplate = parentUser.proxyUsername || null; // e.g. user-zip-{zip}
            const stateUsernameTemplate = parentUser.proxyStateUsername || null; // e.g. user-state-{state}
            const countyUsernameTemplate = parentUser.proxyCountyUsername || null; // e.g. user-county-{county}
            const countryUsernameTemplate = parentUser.proxyCountryUsername || null; // e.g. user-country-{country}

            console.log(`[submission] [${siteId}] Geo extracted — zip: ${zipValue}, state: ${stateCode}, county: ${countyValue}, country: ${countryValue}`);

            let workingResult;
            try {
              workingResult = await getWorkingProxy(
                zipValue,
                stateCode,
                countyValue,
                countryValue,
                {
                  host: normalizeProxyHost(parentUser.proxyHost),
                  port: parentUser.proxyPort,
                  password: parentUser.proxyPassword,
                  type: parentUser.proxyType || "http"
                },
                zipUsernameTemplate,
                stateUsernameTemplate,
                countyUsernameTemplate,
                countryUsernameTemplate
              );
            } catch (proxyError: any) {
              console.error(`[submission] [${siteId}] Proxy resolution failed:`, proxyError.message);
              return res.status(400).json({ message: proxyError.message });
            }

            browserProxy = workingResult.primary;
            const fallbackProxy = workingResult.fallback;
            proxyMethod = workingResult.method;
            proxyHost = browserProxy.host;
            proxyPort = browserProxy.port;
            proxyLocation = browserProxy.label || null;

            console.log(`[submission] Proxy resolved — method: ${proxyMethod}, primary: ${browserProxy.username}, fallback: ${fallbackProxy?.username || "none"}, location: ${proxyLocation}`);

            const fields = (site.fields || []) as FormField[];
            const submission = await storage.createSubmission({
              agentId: req.user!.userId,
              siteId,
              formData,
              proxyHost,
              proxyPort,
              proxyLocation,
              proxyMethod: proxyMethod,
              status: "running",
            });

            console.log(`[submission] [${submission.id}] Initiating auto-fill for ${site.url} via proxy...`);
            const controller = new AbortController();
            abortControllers.set(submission.id, controller);

            autoFillForm(
              site.url,
              fields,
              formData,
              site.submitSelector,
              browserProxy,
              (progress) => {
                if (progress.step === "error") console.error(`[submission] [${submission.id}] Error: ${progress.detail}`);
                sendSSE(submission.id, progress);
              },
              fallbackProxy,
              controller.signal
            ).then(async (result) => {
              console.log(`[submission] [${submission.id}] Complete — success: ${result.success}`);
              await storage.updateSubmission(submission.id, {
                status: result.success ? "success" : "failed",
                duration: result.duration,
                errorMessage: result.errorMessage,
                extractedData: result.extractedData,
              });
              // Independently extract TrustedForm / Journaya URLs in a separate browser session
              extractTrustedFormData(site.url, browserProxy).then(async (tfData) => {
                if (Object.keys(tfData).length > 0) {
                  const existing = await storage.getSubmission(submission.id);
                  const merged = { ...(existing?.extractedData as Record<string, string> || {}), ...tfData };
                  await storage.updateSubmission(submission.id, { extractedData: merged });
                  console.log(`[trusted-form] [${submission.id}] Saved TrustedForm data:`, tfData);
                }
              }).catch(() => { /* non-fatal */ });
            }).catch(async (err) => {
              console.error(`[submission] [${submission.id}] Fatal Error:`, err.message);
              await storage.updateSubmission(submission.id, {
                status: "failed",
                errorMessage: err.message,
              });
              sendSSE(submission.id, { step: "error", detail: err.message, percent: 100, timestamp: Date.now() });
            }).finally(() => {
              abortControllers.delete(submission.id);
            });

            return res.json({
              ...submission,
              geoUsername: browserProxy?.username,
            });
          }
        }
      }

      // 2. Regular submission (no proxy or proxy not applicable to this site)
      const fields = (site.fields || []) as FormField[];
      const submission = await storage.createSubmission({
        agentId: req.user!.userId,
        siteId,
        formData,
        proxyHost,
        proxyPort,
        proxyLocation,
        proxyMethod: proxyMethod,
        status: "running",
      });

      const controller = new AbortController();
      abortControllers.set(submission.id, controller);

      autoFillForm(
        site.url,
        fields,
        formData,
        site.submitSelector,
        null,
        (progress) => sendSSE(submission.id, progress),
        null,
        controller.signal
      ).then(async (result) => {
        await storage.updateSubmission(submission.id, {
          status: result.success ? "success" : "failed",
          duration: result.duration,
          errorMessage: result.errorMessage,
          extractedData: result.extractedData,
        });
        // Independently extract TrustedForm / Journaya URLs in a separate browser session
        extractTrustedFormData(site.url, null).then(async (tfData) => {
          if (Object.keys(tfData).length > 0) {
            const existing = await storage.getSubmission(submission.id);
            const merged = { ...(existing?.extractedData as Record<string, string> || {}), ...tfData };
            await storage.updateSubmission(submission.id, { extractedData: merged });
            console.log(`[trusted-form] [${submission.id}] Saved TrustedForm data:`, tfData);
          }
        }).catch(() => { /* non-fatal */ });
      }).catch(async (err) => {
        await storage.updateSubmission(submission.id, {
          status: "failed",
          errorMessage: err.message,
        });
        sendSSE(submission.id, { step: "error", detail: err.message, percent: 100, timestamp: Date.now() });
      }).finally(() => {
        abortControllers.delete(submission.id);
      });

      return res.json(submission);
    } catch (error: any) {
      return res.status(500).json({ message: error.message });
    }
  });

  try {
    await storage.ensureAdmin();
    console.log("[init] Admin check completed.");
  } catch (err: any) {
    console.warn("[init] Admin creation failed (this might be normal if DB is not ready):", err.message);
  }

  return httpServer;
}
