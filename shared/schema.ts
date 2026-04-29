import { sql } from "drizzle-orm";
import { pgTable, text, varchar, boolean, integer, timestamp, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  password: text("password").notNull(),
  role: text("role").notNull().default("user"),
  isActive: boolean("is_active").notNull().default(true),
  parentUserId: varchar("parent_user_id"),
  proxyHost: text("proxy_host"),
  proxyPort: integer("proxy_port"),
  proxyUsername: text("proxy_username"),
  proxyPassword: text("proxy_password"),
  proxyType: text("proxy_type").default("http"),
  proxyStateUsername: text("proxy_state_username"),
  proxyCountyUsername: text("proxy_county_username"),
  proxyCountryUsername: text("proxy_country_username"),
  proxySiteIds: jsonb("proxy_site_ids").$type<string[] | null>().default(null),
  lastActive: timestamp("last_active").defaultNow(),
  createdAt: timestamp("created_at").defaultNow(),
});

export const formFieldSchema = z.object({
  label: z.string(),
  name: z.string(),
  type: z.string(),
  selector: z.string(),
  options: z.array(z.string()).optional(),
  required: z.boolean(),
  order: z.number(),
  geoRole: z.enum(["zip", "state", "county"]).nullable().optional(),
  hidden: z.boolean().optional(),
});

export type FormField = z.infer<typeof formFieldSchema>;

export const sites = pgTable("sites", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  ownerId: varchar("owner_id").notNull(),
  name: text("name").notNull(),
  url: text("url").notNull(),
  formSelector: text("form_selector"),
  submitSelector: text("submit_selector"),
  fields: jsonb("fields").$type<FormField[]>().default([]),
  googleSheetUrl: text("google_sheet_url"),
  notes: text("notes"),
  isActive: boolean("is_active").notNull().default(true),
  scrapedAt: timestamp("scraped_at").defaultNow(),
  createdAt: timestamp("created_at").defaultNow(),
});

export const agentSites = pgTable("agent_sites", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  agentId: varchar("agent_id").notNull(),
  siteId: varchar("site_id").notNull(),
});

export const submissions = pgTable("submissions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  agentId: varchar("agent_id").notNull(),
  siteId: varchar("site_id").notNull(),
  formData: jsonb("form_data").$type<Record<string, string>>().default({}),
  proxyHost: text("proxy_host"),
  proxyPort: integer("proxy_port"),
  proxyLocation: text("proxy_location"),
  proxyMethod: text("proxy_method"),
  status: text("status").notNull().default("pending"),
  screenshot: text("screenshot"),
  duration: integer("duration"),
  errorMessage: text("error_message"),
  extractedData: jsonb("extracted_data").$type<Record<string, string>>().default({}),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertUserSchema = createInsertSchema(users).omit({
  id: true,
  createdAt: true,
  lastActive: true,
});

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export const registerSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(6),
});

export const insertSiteSchema = createInsertSchema(sites).omit({
  id: true,
  createdAt: true,
  scrapedAt: true,
});

export const insertSubmissionSchema = createInsertSchema(submissions).omit({
  id: true,
  createdAt: true,
});

export const proxyConfigSchema = z.object({
  proxyHost: z.string().min(1),
  proxyPort: z.number().min(1).max(65535),
  proxyUsername: z.string().min(1),
  proxyPassword: z.string().min(1),
  proxyType: z.enum(["http", "https", "socks5"]),
});

export const createAgentSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(6),
  siteIds: z.array(z.string()),
});

export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;
export type InsertSite = z.infer<typeof insertSiteSchema>;
export type Site = typeof sites.$inferSelect;
export type Submission = typeof submissions.$inferSelect;
export type AgentSite = typeof agentSites.$inferSelect;
