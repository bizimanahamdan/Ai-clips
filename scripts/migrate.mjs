import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const url = process.env.DATABASE_URL?.trim();
if (!url) {
  console.error("[migrate] DATABASE_URL is required");
  process.exit(1);
}

const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 15_000 });
try {
  console.log("[migrate] connecting to PostgreSQL…");
  await client.connect();
  await client.query(`CREATE TABLE IF NOT EXISTS clipforge_migrations (
    name text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  const directory = path.join(process.cwd(), "drizzle");
  const files = (await fs.readdir(directory)).filter((name) => name.endsWith(".sql")).sort();
  for (const name of files) {
    const applied = await client.query("SELECT 1 FROM clipforge_migrations WHERE name = $1", [name]);
    if (applied.rowCount) {
      console.log(`[migrate] already applied: ${name}`);
      continue;
    }
    const sql = await fs.readFile(path.join(directory, name), "utf8");
    const statements = sql.split("--> statement-breakpoint").map((item) => item.trim()).filter(Boolean);
    await client.query("BEGIN");
    try {
      for (const statement of statements) await client.query(statement);
      await client.query("INSERT INTO clipforge_migrations(name) VALUES ($1)", [name]);
      await client.query("COMMIT");
      console.log(`[migrate] applied: ${name}`);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }
  console.log("[migrate] database is ready");
} catch (error) {
  console.error("[migrate] failed:", error.message);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => undefined);
}
