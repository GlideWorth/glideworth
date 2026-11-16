import { mkdirSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { type BetterSQLite3Database, drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema.js";

export type Db = BetterSQLite3Database<typeof schema>;

/** Migrations live in apps/api/drizzle (dev) or dist/drizzle (built). */
function migrationsFolder(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return here.endsWith(join("dist", "db"))
    ? resolve(here, "..", "drizzle")
    : resolve(here, "..", "..", "drizzle");
}

/** Number of migrations shipped (the tenant schema version in cloud mode). */
export function migrationCount(): number {
  return readdirSync(migrationsFolder()).filter((f) => f.endsWith(".sql")).length;
}

export interface OpenDbOptions {
  /** Extra pragmas applied before migrating (cloud: busy_timeout, cache_size, max_page_count). */
  pragmas?: Record<string, string | number>;
}

const PRAGMA_NAME = /^[a-z_]+$/;

/**
 * Open (and migrate) a database. ':memory:' is supported for tests. Throws, leaving the file as it was, when a
 * migration fails (Drizzle runs the pending migrations in one transaction); the handle is closed then.
 */
export function openDb(
  path: string,
  opts: OpenDbOptions = {},
): { db: Db; sqlite: Database.Database; close: () => void } {
  if (path !== ":memory:") mkdirSync(dirname(resolve(path)), { recursive: true });
  const sqlite = new Database(path);
  try {
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("foreign_keys = ON");
    for (const [k, v] of Object.entries(opts.pragmas ?? {})) {
      if (!PRAGMA_NAME.test(k) || !/^-?[0-9]+$|^[A-Za-z]+$/.test(String(v)))
        throw new Error("invalid pragma");
      sqlite.pragma(`${k} = ${v}`);
    }
    const db = drizzle(sqlite, { schema });
    migrate(db, { migrationsFolder: migrationsFolder() });
    return { db, sqlite, close: () => sqlite.close() };
  } catch (err) {
    sqlite.close();
    throw err;
  }
}
