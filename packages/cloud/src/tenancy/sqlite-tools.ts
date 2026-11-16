/**
 * SQLite file operations shared by the registry, exports and backups. Each opens its own short-lived
 * connection; none touches the host's runtime handle.
 */
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

/**
 * Consistent online copy (safe while another connection writes, WAL included) to one self-contained file,
 * the method of `backupDatabase` (`apps/api/src/cli/db-tools.ts:31`): `sqlite.backup()`, then
 * `journal_mode=DELETE` so no `-wal`/`-shm` companion is needed.
 */
export async function onlineCopy(src: string, dest: string): Promise<void> {
  if (!existsSync(src)) throw new Error("source database not found");
  if (existsSync(dest)) throw new Error("refusing to overwrite an existing file");
  mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
  const db = new Database(src, { readonly: true, fileMustExist: true });
  try {
    await db.backup(dest);
  } finally {
    db.close();
  }
  const copy = new Database(dest);
  try {
    copy.pragma("journal_mode = DELETE");
  } finally {
    copy.close();
  }
  chmodSync(dest, 0o600);
}

/** `quick_check` (fast) or `integrity_check` (full). True when SQLite answers exactly `ok`. */
export function checkIntegrity(path: string, full = true): boolean {
  let db: Database.Database | undefined;
  try {
    db = new Database(path, { readonly: true, fileMustExist: true });
    const rows = db.pragma(full ? "integrity_check" : "quick_check") as Record<string, string>[];
    return rows.length === 1 && Object.values(rows[0] ?? {})[0] === "ok";
  } catch {
    return false;
  } finally {
    db?.close();
  }
}

/** As `assertGlideworthDb` (`apps/api/src/cli/db-tools.ts:14-25`): integrity, then a `households` table. */
export function isGlideworthDb(path: string): boolean {
  if (!checkIntegrity(path, true)) return false;
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    return !!db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='households'")
      .get();
  } finally {
    db.close();
  }
}

/** Number of applied Drizzle migrations (the tenant schema version), 0 for a fresh or foreign file. */
export function schemaVersionOf(path: string): number {
  if (!existsSync(path)) return 0;
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const has = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='__drizzle_migrations'")
      .get();
    if (!has) return 0;
    return (db.prepare("SELECT count(*) AS n FROM __drizzle_migrations").get() as { n: number }).n;
  } finally {
    db.close();
  }
}

/**
 * Row count and a content checksum of every table (SHA-256 over the rows in rowid order, each row as JSON).
 * Restore verification compares these between a live file and a restored copy.
 */
export function tableDigests(path: string): Record<string, { rows: number; sha256: string }> {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const tables = (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all() as { name: string }[]
    ).map((t) => t.name);
    const out: Record<string, { rows: number; sha256: string }> = {};
    for (const name of tables) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
      const h = createHash("sha256");
      let rows = 0;
      let order = "rowid";
      try {
        db.prepare(`SELECT rowid FROM "${name}" LIMIT 0`).all();
      } catch {
        order = "1"; // WITHOUT ROWID table: order by the first column
      }
      for (const r of db.prepare(`SELECT * FROM "${name}" ORDER BY ${order}`).iterate()) {
        h.update(JSON.stringify(r, (_k, v) => (Buffer.isBuffer(v) ? v.toString("base64") : v)));
        h.update("\n");
        rows++;
      }
      out[name] = { rows, sha256: h.digest("hex") };
    }
    return out;
  } finally {
    db.close();
  }
}

/** SHA-256 of a whole file (streams it; tenant files can be a few hundred MiB). */
export async function fileSha256(path: string): Promise<string> {
  const { createReadStream } = await import("node:fs");
  const h = createHash("sha256");
  for await (const chunk of createReadStream(path)) h.update(chunk as Buffer);
  return h.digest("hex");
}

/** Bytes of a database including its WAL. */
export function dbBytes(path: string): number {
  let n = 0;
  for (const f of [path, `${path}-wal`]) if (existsSync(f)) n += statSync(f).size;
  return n;
}

/** Latest modification time of a database and its WAL (ms), or 0 when the file is missing. */
export function dbMtime(path: string): number {
  let t = 0;
  for (const f of [path, `${path}-wal`]) if (existsSync(f)) t = Math.max(t, statSync(f).mtimeMs);
  return t;
}

/**
 * Exact change marker of a database and its WAL: full-precision mtime (sub-millisecond, as the file system
 * reports it) and size of each file. Two equal markers mean no write happened in between, with no wall-clock
 * comparison involved.
 */
export function dbFingerprint(path: string): string {
  return [path, `${path}-wal`]
    .map((f) => {
      if (!existsSync(f)) return "-";
      const s = statSync(f);
      return `${s.mtimeMs}/${s.size}`;
    })
    .join("|");
}

export function removeDbFiles(path: string): void {
  for (const f of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`])
    rmSync(f, { force: true });
}
