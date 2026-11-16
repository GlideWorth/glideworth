/**
 * Database operations behind `pnpm backup`, `pnpm restore` and `pnpm seed`. Plain functions so they
 * are testable; src/cli/admin.ts is the command-line wrapper.
 */
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { createSampleDocument, createUkSampleDocument } from "@glideworth/core/samples";
import Database from "better-sqlite3";
import { DB_FILE, LEGACY_DB_FILE } from "../config.js";
import { openDb } from "../db/client.js";
import { Services } from "../services.js";

const stamp = (d = new Date()) =>
  d.toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");

function assertGlideworthDb(path: string): void {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const check = db.pragma("integrity_check") as { integrity_check: string }[];
    if (check.length !== 1 || check[0]?.integrity_check !== "ok")
      throw new Error(
        `${path} failed the SQLite integrity check: ${JSON.stringify(check).slice(0, 300)}`,
      );
    const has = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='households'")
      .get();
    if (!has) throw new Error(`${path} is not a Glideworth database (no 'households' table)`);
  } finally {
    db.close();
  }
}

/**
 * Consistent online backup (safe while the server is running, WAL included) to a single file.
 * Default destination: `<db dir>/backups/<db name>-<timestamp>.db`, so `glideworth-<timestamp>.db` for the
 * default database, including a pre-rename `cairn.db` still in use.
 */
export async function backupDatabase(dbPath: string, out?: string): Promise<string> {
  const src = resolve(dbPath);
  if (!existsSync(src)) throw new Error(`database not found: ${src}`);
  const name = basename(src) === LEGACY_DB_FILE ? basename(DB_FILE, ".db") : basename(src, ".db");
  const dest = resolve(out ?? join(dirname(src), "backups", `${name}-${stamp()}.db`));
  if (existsSync(dest)) throw new Error(`refusing to overwrite ${dest}`);
  mkdirSync(dirname(dest), { recursive: true });
  const db = new Database(src, { readonly: true, fileMustExist: true });
  try {
    await db.backup(dest);
  } finally {
    db.close();
  }
  // A backup is ONE self-contained file: no -wal/-shm companions.
  const copy = new Database(dest);
  try {
    copy.pragma("journal_mode = DELETE");
  } finally {
    copy.close();
  }
  assertGlideworthDb(dest);
  return dest;
}

export interface RestoreResult {
  restoredFrom: string;
  /** Copy of the database that was replaced (null when there was none). */
  previous: string | null;
}

/**
 * Replace the database with a backup. STOP THE SERVER first. The current database is kept next to
 * it as `<db>.pre-restore-<timestamp>`; `force` is required when one exists. The restored file is
 * migrated to the current schema, so backups from older versions work.
 */
export async function restoreDatabase(
  from: string,
  dbPath: string,
  opts: { force?: boolean } = {},
): Promise<RestoreResult> {
  const src = resolve(from);
  const target = resolve(dbPath);
  if (!existsSync(src) || !statSync(src).isFile()) throw new Error(`backup not found: ${src}`);
  if (src === target) throw new Error("the backup and the live database are the same file");
  assertGlideworthDb(src);
  let previous: string | null = null;
  if (existsSync(target)) {
    if (!opts.force)
      throw new Error(`${target} exists; pass --force to replace it (a safety copy is kept)`);
    previous = `${target}.pre-restore-${stamp()}`;
    const live = new Database(target, { fileMustExist: true });
    try {
      await live.backup(previous);
    } finally {
      live.close();
    }
  }
  mkdirSync(dirname(target), { recursive: true });
  for (const f of [target, `${target}-wal`, `${target}-shm`]) rmSync(f, { force: true });
  // Copy through SQLite so a backup that still has a WAL is restored consistently.
  const s = new Database(src, { readonly: true });
  try {
    await s.backup(target);
  } finally {
    s.close();
  }
  const opened = openDb(target); // applies any newer migrations
  opened.close();
  return { restoredFrom: src, previous };
}

export type SampleName = "uk" | "us";

/**
 * Load a synthetic sample household from @glideworth/core samples (never real data). Fails with a clear
 * message when the household already exists, unless `replace`.
 */
export function seedSample(dbPath: string, opts: { sample?: SampleName; replace?: boolean } = {}) {
  const { db, close } = openDb(dbPath);
  try {
    const doc = (opts.sample ?? "uk") === "uk" ? createUkSampleDocument() : createSampleDocument();
    try {
      new Services(db).households.importDocument(
        doc,
        { kind: "system", label: "pnpm seed" },
        opts.replace ? "replace" : "create",
      );
    } catch (err) {
      if ((err as { code?: string }).code === "CONFLICT")
        // oxlint-disable-next-line eslint/preserve-caught-error -- the CLI message replaces the raw conflict error on purpose
        throw new Error(
          `household '${doc.household.id}' already exists; pass --replace to overwrite it`,
        );
      throw err;
    }
    return {
      householdId: doc.household.id,
      name: doc.household.name,
      plans: doc.plans.map((p) => p.id),
    };
  } finally {
    close();
  }
}
