import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { authMiddleware, generateToken, requireRole, type JwtPayload } from "./auth";
import { scrapeFormFields } from "./scraper";
import { loginSchema, registerSchema, proxyConfigSchema, createAgentSchema } from "@shared/schema";
import type { FormField } from "@shared/schema";
import { z } from "zod";
import bcrypt from "bcryptjs";
import axios from "axios";
import { autoFillForm, type AutoFillProgress, type ProxyConfig as BrowserProxyConfig } from "./browser";

const sseClients = new Map<string, import("express").Response[]>();

function sendSSE(submissionId: string, data: AutoFillProgress) {
  const clients = sseClients.get(submissionId) || [];
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  clients.forEach((c) => {
    try { c.write(msg); } catch {}
  });
  if (data.step === "complete" || data.step === "error") {
    clients.forEach((c) => {
      try { c.end(); } catch {}
    });
    sseClients.delete(submissionId);
  }
}

const ZIP_FIELD_NAMES = ["zip", "zipcode", "zip_code", "postal", "postalcode", "postal_code"];
const STATE_FIELD_NAMES = ["state", "state_name"];

function extractGeoTarget(formData: Record<string, string>): { type: "zip" | "state" | null; value: string } {
  for (const key of Object.keys(formData)) {
    if (ZIP_FIELD_NAMES.includes(key.toLowerCase()) && formData[key]?.trim()) {
      return { type: "zip", value: formData[key].trim() };
    }
  }
  for (const key of Object.keys(formData)) {
    if (STATE_FIELD_NAMES.includes(key.toLowerCase()) && formData[key]?.trim()) {
      return { type: "state", value: formData[key].trim().toLowerCase().replace(/\s+/g, "_") };
    }
  }
  return { type: null, value: "" };
}

function buildGeoProxyUsername(baseUsername: string, geo: { type: "zip" | "state" | null; value: string }): string {
  if (!geo.type) return baseUsername;
  return `${baseUsername}-${geo.type}-${geo.value}`;
}

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {

  app.post("/api/auth/login", async (req, res) => {
    try {
      const parsed = loginSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: "Invalid email or password format" });
      }

      const user = await storage.getUserByEmail(parsed.data.email);
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
      const user = await storage.getUser(req.params.id);
      if (!user) return res.status(404).json({ message: "User not found" });
      const updated = await storage.updateUser(req.params.id, { isActive: !user.isActive });
      return res.json(updated);
    } catch (error: any) {
      return res.status(500).json({ message: error.message });
    }
  });

  app.delete("/api/admin/users/:id", authMiddleware, requireRole("admin"), async (req, res) => {
    try {
      await storage.deleteUser(req.params.id);
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
        proxySiteIds: z.array(z.string()).nullable().optional(),
      });
      const parsed = bodySchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: "Invalid proxy configuration" });
      }

      await storage.updateUser(req.user!.userId, {
        proxyHost: parsed.data.proxyHost,
        proxyPort: parsed.data.proxyPort,
        proxyUsername: parsed.data.proxyUsername,
        proxyPassword: parsed.data.proxyPassword,
        proxyType: parsed.data.proxyType,
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
      return res.json({
        proxyHost: user.proxyHost || "",
        proxyPort: user.proxyPort || 0,
        proxyUsername: user.proxyUsername || "",
        proxyPassword: user.proxyPassword || "",
        proxyType: user.proxyType || "http",
        proxySiteIds: user.proxySiteIds ?? null,
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

      const response = await axios.get("https://api.ipify.org?format=json", {
        proxy: {
          host: user.proxyHost,
          port: user.proxyPort,
          auth: {
            username: user.proxyUsername || "",
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
    const submissionId = req.params.id;

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
      let geoUsername: string | null = null;
      let browserProxy: BrowserProxyConfig | null = null;

      if (agent.parentUserId) {
        const parentUser = await storage.getUser(agent.parentUserId);
        if (parentUser && parentUser.proxyHost && parentUser.proxyPort && parentUser.proxyUsername && parentUser.proxyPassword) {
          // Check proxy site assignment: null = all sites, array = specific sites
          const proxyAppliesToSite =
            parentUser.proxySiteIds === null ||
            (Array.isArray(parentUser.proxySiteIds) && parentUser.proxySiteIds.includes(siteId));

          if (proxyAppliesToSite) {
            const geo = extractGeoTarget(formData);
            geoUsername = buildGeoProxyUsername(parentUser.proxyUsername, geo);
            proxyHost = parentUser.proxyHost;
            proxyPort = parentUser.proxyPort;
            proxyLocation = geo.type ? `${geo.type}-${geo.value}` : null;
            browserProxy = {
              host: parentUser.proxyHost,
              port: parentUser.proxyPort,
              username: geoUsername,
              password: parentUser.proxyPassword,
              protocol: parentUser.proxyType || "http",
            };
          }
        }
      }

      const submission = await storage.createSubmission({
        agentId: req.user!.userId,
        siteId,
        formData,
        proxyHost,
        proxyPort,
        proxyLocation,
        status: "running",
      });

      res.json({
        ...submission,
        geoUsername,
      });

      const fields = (site.fields || []) as FormField[];

      autoFillForm(
        site.url,
        fields,
        formData,
        site.submitSelector,
        browserProxy,
        (progress) => sendSSE(submission.id, progress)
      ).then(async (result) => {
        await storage.updateSubmission(submission.id, {
          status: result.success ? "success" : "failed",
          screenshot: result.screenshot,
          duration: result.duration,
          errorMessage: result.errorMessage,
        });
      }).catch(async (err) => {
        await storage.updateSubmission(submission.id, {
          status: "failed",
          errorMessage: err.message,
        });
        sendSSE(submission.id, { step: "error", detail: err.message, percent: 100, timestamp: Date.now() });
      });
    } catch (error: any) {
      return res.status(500).json({ message: error.message });
    }
  });

  await storage.ensureAdmin();

  return httpServer;
}
