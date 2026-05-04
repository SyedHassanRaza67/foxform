import { Pool, neonConfig } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import ws from "ws";
import * as schema from "@shared/schema";

neonConfig.webSocketConstructor = ws;

if (!process.env.DATABASE_URL) {
  console.error("[db] DATABASE_URL is not defined in the environment.");
  throw new Error("DATABASE_URL must be set.");
}

console.log("[db] Initializing database connection pool...");
export const pool = new Pool({ 
  connectionString: process.env.DATABASE_URL,
  max: 50, // Increase pool size for high concurrency (30-40+ agents)
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error("[db] Unexpected error on idle client", err);
});

export const db = drizzle({ client: pool, schema });

// Light check to verify connection on startup
(async () => {
  try {
    const client = await pool.connect();
    console.log("[db] Database connection established successfully.");
    client.release();
  } catch (err: any) {
    console.error("[db] Failed to connect to database:", err.message);
  }
})();
