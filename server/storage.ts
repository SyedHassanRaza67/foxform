import { db } from "./db";
import { eq, and, desc, sql } from "drizzle-orm";
import {
  users, sites, submissions, agentSites,
  type User, type InsertUser, type Site, type InsertSite,
  type Submission, type FormField
} from "@shared/schema";
import bcrypt from "bcryptjs";

export interface IStorage {
  getUser(id: string): Promise<User | undefined>;
  getUserByEmail(email: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;
  updateUser(id: string, data: Partial<User>): Promise<User | undefined>;
  deleteUser(id: string): Promise<void>;
  getAllUsers(): Promise<User[]>;
  getUsersByParent(parentId: string): Promise<User[]>;
  getAgentsByParent(parentId: string): Promise<User[]>;

  createSite(site: InsertSite): Promise<Site>;
  getSite(id: string): Promise<Site | undefined>;
  getSitesByOwner(ownerId: string): Promise<Site[]>;
  updateSite(id: string, data: Partial<Site>): Promise<Site | undefined>;
  deleteSite(id: string): Promise<void>;

  assignSiteToAgent(agentId: string, siteId: string): Promise<void>;
  removeSiteFromAgent(agentId: string, siteId: string): Promise<void>;
  getAgentSiteIds(agentId: string): Promise<string[]>;
  getSitesForAgent(agentId: string): Promise<Site[]>;

  createSubmission(data: Partial<Submission>): Promise<Submission>;
  updateSubmission(id: string, data: Partial<Submission>): Promise<Submission | undefined>;
  getSubmissionsByAgent(agentId: string): Promise<Submission[]>;
  getSubmissionsBySite(siteId: string): Promise<Submission[]>;
  getAllSubmissions(): Promise<Submission[]>;
  getSubmissionCount(): Promise<number>;
  getTotalSiteCount(): Promise<number>;

  ensureAdmin(): Promise<void>;
}

export class DatabaseStorage implements IStorage {
  async getUser(id: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.id, id));
    return user;
  }

  async getUserByEmail(email: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.email, email));
    return user;
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    const hashedPassword = await bcrypt.hash(insertUser.password, 10);
    const [user] = await db.insert(users).values({
      ...insertUser,
      password: hashedPassword,
    }).returning();
    return user;
  }

  async updateUser(id: string, data: Partial<User>): Promise<User | undefined> {
    const [user] = await db.update(users).set(data).where(eq(users.id, id)).returning();
    return user;
  }

  async deleteUser(id: string): Promise<void> {
    await db.delete(agentSites).where(eq(agentSites.agentId, id));
    await db.delete(users).where(eq(users.id, id));
  }

  async getAllUsers(): Promise<User[]> {
    return db.select().from(users).orderBy(desc(users.createdAt));
  }

  async getUsersByParent(parentId: string): Promise<User[]> {
    return db.select().from(users).where(eq(users.parentUserId, parentId));
  }

  async getAgentsByParent(parentId: string): Promise<User[]> {
    return db.select().from(users).where(
      and(eq(users.parentUserId, parentId), eq(users.role, "agent"))
    );
  }

  async createSite(site: InsertSite): Promise<Site> {
    const [created] = await db.insert(sites).values(site).returning();
    return created;
  }

  async getSite(id: string): Promise<Site | undefined> {
    const [site] = await db.select().from(sites).where(eq(sites.id, id));
    return site;
  }

  async getSitesByOwner(ownerId: string): Promise<Site[]> {
    return db.select().from(sites).where(eq(sites.ownerId, ownerId)).orderBy(desc(sites.createdAt));
  }

  async updateSite(id: string, data: Partial<Site>): Promise<Site | undefined> {
    const [site] = await db.update(sites).set(data).where(eq(sites.id, id)).returning();
    return site;
  }

  async deleteSite(id: string): Promise<void> {
    await db.delete(agentSites).where(eq(agentSites.siteId, id));
    await db.delete(sites).where(eq(sites.id, id));
  }

  async assignSiteToAgent(agentId: string, siteId: string): Promise<void> {
    const existing = await db.select().from(agentSites).where(
      and(eq(agentSites.agentId, agentId), eq(agentSites.siteId, siteId))
    );
    if (existing.length === 0) {
      await db.insert(agentSites).values({ agentId, siteId });
    }
  }

  async removeSiteFromAgent(agentId: string, siteId: string): Promise<void> {
    await db.delete(agentSites).where(
      and(eq(agentSites.agentId, agentId), eq(agentSites.siteId, siteId))
    );
  }

  async getAgentSiteIds(agentId: string): Promise<string[]> {
    const rows = await db.select().from(agentSites).where(eq(agentSites.agentId, agentId));
    return rows.map(r => r.siteId);
  }

  async getSitesForAgent(agentId: string): Promise<Site[]> {
    const siteIds = await this.getAgentSiteIds(agentId);
    if (siteIds.length === 0) return [];
    const allSites: Site[] = [];
    for (const siteId of siteIds) {
      const site = await this.getSite(siteId);
      if (site && site.isActive) allSites.push(site);
    }
    return allSites;
  }

  async createSubmission(data: Partial<Submission>): Promise<Submission> {
    const [sub] = await db.insert(submissions).values(data as any).returning();
    return sub;
  }

  async updateSubmission(id: string, data: Partial<Submission>): Promise<Submission | undefined> {
    const [sub] = await db.update(submissions).set(data as any).where(eq(submissions.id, id)).returning();
    return sub;
  }

  async getSubmissionsByAgent(agentId: string): Promise<Submission[]> {
    return db.select().from(submissions).where(eq(submissions.agentId, agentId)).orderBy(desc(submissions.createdAt));
  }

  async getSubmissionsBySite(siteId: string): Promise<Submission[]> {
    return db.select().from(submissions).where(eq(submissions.siteId, siteId)).orderBy(desc(submissions.createdAt));
  }

  async getAllSubmissions(): Promise<Submission[]> {
    return db.select().from(submissions).orderBy(desc(submissions.createdAt));
  }

  async getSubmissionCount(): Promise<number> {
    const result = await db.select({ count: sql<number>`count(*)` }).from(submissions);
    return Number(result[0]?.count || 0);
  }

  async getTotalSiteCount(): Promise<number> {
    const result = await db.select({ count: sql<number>`count(*)` }).from(sites);
    return Number(result[0]?.count || 0);
  }

  async ensureAdmin(): Promise<void> {
    const adminEmail = process.env.ADMIN_EMAIL || "admin@proxyform.com";
    const adminPassword = process.env.ADMIN_PASSWORD || "Admin@123";

    const existing = await this.getUserByEmail(adminEmail);
    if (!existing) {
      await this.createUser({
        name: "Admin",
        email: adminEmail,
        password: adminPassword,
        role: "admin",
        isActive: true,
      });
      console.log(`Admin user created: ${adminEmail}`);
    }
  }
}

export const storage = new DatabaseStorage();
