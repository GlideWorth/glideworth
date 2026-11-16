import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { type BetterSQLite3Database, drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { schema } from "./schema.js";

export type ControlDb = BetterSQLite3Database<typeof schema>;

/** `packages/cloud/drizzle`: two levels up from both `src/control` and `dist/control`. */
function migrationsFolder(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "drizzle");
}

/**
 * Open (and migrate) the control-plane database: WAL, foreign keys, 5 s busy timeout. The directory is
 * created `0700` and the file made `0600`. `:memory:` is supported for tests. Migrating an up-to-date
 * database is a no-op.
 */
export function openControlDb(path: string): { db: ControlDb; close(): void } {
  const memory = path === ":memory:";
  if (!memory) {
    const dir = dirname(resolve(path));
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const sqlite = new Database(path);
  try {
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("foreign_keys = ON");
    sqlite.pragma("busy_timeout = 5000");
    const db = drizzle(sqlite, { schema });
    migrate(db, { migrationsFolder: migrationsFolder() });
    if (!memory) chmodSync(resolve(path), 0o600);
    return { db, close: () => sqlite.close() };
  } catch (err) {
    sqlite.close();
    throw err;
  }
}
