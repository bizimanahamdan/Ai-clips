import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

export type Database = ReturnType<typeof drizzle>;

const globalForDb = globalThis as typeof globalThis & {
  __clipforgePool?: Pool;
  __clipforgeDb?: Database;
};

/**
 * Lazily create the pool. Next.js evaluates server modules while building, so
 * connecting (or requiring DATABASE_URL) at module import time makes a valid
 * cloud build fail before runtime environment variables are available.
 */
export function getDb(): Database {
  if (globalForDb.__clipforgeDb) return globalForDb.__clipforgeDb;
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required at runtime. Add it to the cloud service environment.");
  }
  const pool = new Pool({
    connectionString: databaseUrl,
    max: Number(process.env.DATABASE_POOL_MAX || 10),
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
  });
  const database = drizzle(pool);
  globalForDb.__clipforgePool = pool;
  globalForDb.__clipforgeDb = database;
  pool.on("error", (error) => console.error("[database] idle client error:", error.message));
  return database;
}

/** Lazy compatibility facade; property access only initializes at request/job runtime. */
export const db = new Proxy({} as Database, {
  get(_target, property) {
    const value = Reflect.get(getDb(), property);
    return typeof value === "function" ? value.bind(getDb()) : value;
  },
});

export async function closeDb(): Promise<void> {
  await globalForDb.__clipforgePool?.end();
  globalForDb.__clipforgePool = undefined;
  globalForDb.__clipforgeDb = undefined;
}
