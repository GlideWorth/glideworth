/**
 * Backups (spec 7): online SQLite copy of every changed tenant, gzip, AES-256-GCM with the tenant's data key
 * (envelope.ts), upload, record; restore with integrity, schema, checksum and tenant checks; a daily
 * verification of random tenants; retention pruning; crypto-shredding on deletion.
 *
 * Retention: every backup for 48 hours, then the newest per UTC day for 30 days. Backups of a tenant whose key
 * was destroyed are deleted at the next prune (they are unreadable from the moment the key is gone).
 */
import { randomInt } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { resolve } from "node:path";
import Database from "better-sqlite3";
import { and, desc, eq, inArray, isNotNull, isNull, lte } from "drizzle-orm";
import type { ControlDb } from "../control/db.js";
import { accounts, backups, tenantKeys } from "../control/schema.js";
import { newId } from "../crypto/random.js";
import { CloudError } from "../errors.js";
import type { Logger } from "../log/index.js";
import { controlDbPath, fileStamp, stagingDir, tenantPath } from "../tenancy/paths.js";
import type { TenantRegistry } from "../tenancy/registry.js";
import {
  checkIntegrity,
  dbFingerprint,
  dbMtime,
  fileSha256,
  isGlideworthDb,
  onlineCopy,
  removeDbFiles,
  schemaVersionOf,
  tableDigests,
} from "../tenancy/sqlite-tools.js";
import type { AccountId, ObjectStore, TenantRuntimeBase } from "../types.js";
import { BackupIntegrityError, openToFile, sealFile } from "./envelope.js";
import {
  controlBackupKey,
  escrowObjectKey,
  type Kek,
  KeyUnavailableError,
  unwrapDataKey,
} from "./keys.js";
import { ObjectNotFoundError } from "./object-store.js";

const HOUR = 3600_000;
const DAY = 24 * HOUR;
export const BACKUP_RETENTION = { keepAllMs: 48 * HOUR, dailyMs: 30 * DAY } as const;
/**
 * File systems stamp mtimes coarsely (Linux uses a cached clock that can lag by several milliseconds; ext3,
 * HFS+ and FAT keep 1 to 2 seconds). A write shortly after a backup began can therefore carry a timestamp at
 * or before the recorded backup time, so a bare `mtime <= createdAt` can skip a changed tenant.
 */
const MTIME_GRANULARITY_MS = 2000;

export interface BackupServiceDeps {
  db: ControlDb;
  registry: TenantRegistry<TenantRuntimeBase>;
  store: ObjectStore;
  kek: Kek;
  dataDir: string;
  region: string;
  log: Logger;
  now?: () => Date;
}

const utcDay = (iso: string) => iso.slice(0, 10);

export class BackupService {
  private readonly clock: () => Date;
  private readonly running = new Set<AccountId>();
  /** Change marker of each live file taken just before the snapshot of its newest backup (this process only). */
  private readonly snapshotMarks = new Map<AccountId, { backupId: string; mark: string }>();

  constructor(private readonly d: BackupServiceDeps) {
    this.clock = d.now ?? (() => new Date());
    if (!/^[a-z0-9-]{1,32}$/.test(d.region)) throw new Error("invalid backup region");
  }

  /** Back up every tenant changed since its last backup. */
  async sweep(): Promise<{ backedUp: number; failed: AccountId[] }> {
    const rows = this.d.db
      .select({ id: accounts.id })
      .from(accounts)
      .innerJoin(tenantKeys, eq(tenantKeys.accountId, accounts.id))
      .where(and(inArray(accounts.status, ["active", "suspended"]), isNull(tenantKeys.destroyedAt)))
      .all();
    let backedUp = 0;
    const failed: AccountId[] = [];
    for (const { id } of rows) {
      const path = this.d.registry.pathFor(id);
      if (!existsSync(path)) continue;
      const last = this.latest(id);
      if (last && this.unchangedSince(id, path, last)) continue;
      try {
        await this.backupTenant(id);
        backedUp++;
      } catch (err) {
        failed.push(id);
        this.d.log.error("backup.tenant_failed", { accountId: id, err });
      }
    }
    if (backedUp || failed.length)
      this.d.log.info("backup.sweep", { count: backedUp, remaining: failed.length });
    return { backedUp, failed };
  }

  async backupTenant(accountId: AccountId): Promise<{ objectKey: string; bytes: number }> {
    const path = this.d.registry.pathFor(accountId);
    if (!existsSync(path)) throw new CloudError(404, "NOT_FOUND", "no such workspace");
    if (this.running.has(accountId))
      throw new CloudError(409, "CONFLICT", "a backup is already running");
    this.running.add(accountId);
    try {
      const dek = this.dataKey(accountId);
      await this.escrow(accountId);
      return await this.backupFile(path, accountId, dek, `tenants/${accountId}`);
    } finally {
      this.running.delete(accountId);
    }
  }

  /**
   * The control plane, with its own KEK-derived key. Every `tenant_keys.wrapped_dek` is blanked in the copy
   * (and the file vacuumed, so the bytes are gone): a shredded tenant key must not survive in an old
   * control-plane backup. Keys come back from their escrow objects on restore (`restoreControlPlane`).
   */
  async backupControl(): Promise<{ objectKey: string }> {
    const client = (this.d.db as unknown as { $client: Database.Database }).$client;
    const staging = this.staging();
    const stamp = fileStamp(this.clock());
    const copy = resolve(staging, `control-${stamp}.db`);
    try {
      await client.backup(copy);
      const db = new Database(copy);
      try {
        db.pragma("journal_mode = DELETE");
        db.pragma("secure_delete = ON");
        db.prepare("UPDATE tenant_keys SET wrapped_dek = NULL").run();
        db.exec("VACUUM");
      } finally {
        db.close();
      }
      const res = await this.backupFile(copy, null, controlBackupKey(this.d.kek), "control", true);
      return { objectKey: res.objectKey };
    } finally {
      rmSync(copy, { force: true });
    }
  }

  async restoreTenant(
    accountId: AccountId,
    o: { at?: string; operatorId: string },
  ): Promise<{ restoredFrom: string; previous: string | null }> {
    this.d.registry.pathFor(accountId); // validates the id before anything else
    const acct = this.d.db.select().from(accounts).where(eq(accounts.id, accountId)).get();
    if (!acct || acct.status === "deleted" || acct.status === "deleting")
      throw new CloudError(404, "NOT_FOUND", "no such workspace");
    const row = this.pick(accountId, o.at);
    if (!row) throw new CloudError(404, "NOT_FOUND", "no backup at or before that time");
    const scratch = resolve(this.staging(), `restore-${accountId}-${fileStamp(this.clock())}.db`);
    let previous: string | null = null;
    try {
      await this.download(row, scratch, accountId);
      await this.d.registry.exclusively(accountId, async (dbPath) => {
        if (existsSync(dbPath)) {
          previous = tenantPath(this.d.dataDir, accountId, {
            kind: "pre-restore",
            stamp: fileStamp(this.clock()),
          });
          await onlineCopy(dbPath, previous);
        }
        removeDbFiles(dbPath);
        await onlineCopy(scratch, dbPath);
      });
    } finally {
      removeDbFiles(scratch);
    }
    if (acct.status === "migration_failed")
      this.d.db.update(accounts).set({ status: "active" }).where(eq(accounts.id, accountId)).run();
    // Open once now: migrations run, the member mirror is reconciled; a failure marks the tenant unavailable.
    await this.d.registry.with(accountId, () => undefined, { allowSuspended: true });
    this.d.log.info("backup.restored", { accountId, backupId: row.id, operatorId: o.operatorId });
    return { restoredFrom: row.objectKey, previous };
  }

  /**
   * Daily restore test (spec 7): restore the latest backup of `n` random tenants into a scratch directory,
   * check integrity and the households table, the recorded checksum, and (when the live file has not changed
   * since the backup) every table's row count and content checksum against the live file; then open the copy
   * with migrations through the host's opener. Sets `verified_at`; alerts (log error) on failure.
   */
  async verifySample(n: number): Promise<{ verified: number; failed: AccountId[] }> {
    const candidates = this.d.db
      .selectDistinct({ id: backups.accountId })
      .from(backups)
      .innerJoin(accounts, eq(accounts.id, backups.accountId))
      .innerJoin(tenantKeys, eq(tenantKeys.accountId, backups.accountId))
      .where(
        and(
          isNotNull(backups.accountId),
          inArray(accounts.status, ["active", "suspended"]),
          isNull(tenantKeys.destroyedAt),
        ),
      )
      .all()
      .map((r) => r.id as string);
    for (let i = candidates.length - 1; i > 0; i--) {
      const j = randomInt(i + 1);
      [candidates[i], candidates[j]] = [candidates[j] as string, candidates[i] as string];
    }
    let verified = 0;
    const failed: AccountId[] = [];
    for (const id of candidates.slice(0, Math.max(0, n))) {
      const row = this.latest(id);
      if (!row) continue;
      const dir = resolve(this.staging(), `verify-${id}-${fileStamp(this.clock())}`);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const scratch = resolve(dir, "tenant.db");
      try {
        await this.download(row, scratch, id);
        const live = this.d.registry.pathFor(id);
        if (existsSync(live) && this.unchangedSince(id, live, row)) {
          const a = tableDigests(scratch);
          const b = tableDigests(live);
          if (JSON.stringify(a) !== JSON.stringify(b))
            throw new BackupIntegrityError("differs from live file");
        }
        const runtime = this.d.registry.options.opener.open(
          id,
          scratch,
          this.d.registry.options.limitsOf(id),
        );
        await runtime.close();
        this.d.db
          .update(backups)
          .set({ verifiedAt: this.clock().toISOString() })
          .where(eq(backups.id, row.id))
          .run();
        verified++;
      } catch (err) {
        failed.push(id);
        this.d.log.error("backup.verify_failed", { accountId: id, backupId: row.id, err });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    return { verified, failed };
  }

  /** Apply retention; delete every backup of a tenant whose key is destroyed. Returns objects deleted. */
  async prune(): Promise<number> {
    const now = this.clock().getTime();
    const all = this.d.db
      .select({
        id: backups.id,
        accountId: backups.accountId,
        objectKey: backups.objectKey,
        createdAt: backups.createdAt,
        destroyedAt: tenantKeys.destroyedAt,
      })
      .from(backups)
      .leftJoin(tenantKeys, eq(tenantKeys.accountId, backups.accountId))
      .orderBy(desc(backups.createdAt))
      .all();
    const doomed: typeof all = [];
    const keptDay = new Set<string>();
    for (const b of all) {
      const age = now - Date.parse(b.createdAt);
      if (b.accountId !== null && b.destroyedAt) doomed.push(b);
      else if (age <= BACKUP_RETENTION.keepAllMs)
        keptDay.add(`${b.accountId}|${utcDay(b.createdAt)}`);
      else if (
        age <= BACKUP_RETENTION.dailyMs &&
        !keptDay.has(`${b.accountId}|${utcDay(b.createdAt)}`)
      )
        keptDay.add(`${b.accountId}|${utcDay(b.createdAt)}`);
      else doomed.push(b);
    }
    let deleted = 0;
    for (let i = 0; i < doomed.length; i += 500) {
      const batch = doomed.slice(i, i + 500);
      try {
        await this.d.store.delete(batch.map((b) => b.objectKey));
        this.d.db
          .delete(backups)
          .where(
            inArray(
              backups.id,
              batch.map((b) => b.id),
            ),
          )
          .run();
        deleted += batch.length;
      } catch (err) {
        this.d.log.error("backup.prune_failed", { count: batch.length, err });
      }
    }
    this.cleanStaging(now);
    if (deleted) this.d.log.info("backup.pruned", { count: deleted });
    return deleted;
  }

  /** Crypto-shredding: destroy the tenant's data key (row and escrow object), then delete its backups. */
  async shred(accountId: AccountId): Promise<void> {
    this.d.registry.pathFor(accountId);
    const now = this.clock().toISOString();
    this.d.db
      .update(tenantKeys)
      .set({ wrappedDek: null, destroyedAt: now })
      .where(eq(tenantKeys.accountId, accountId))
      .run();
    await this.d.store.delete([escrowObjectKey(this.d.region, accountId)]);
    const rows = this.d.db.select().from(backups).where(eq(backups.accountId, accountId)).all();
    try {
      await this.d.store.delete(rows.map((r) => r.objectKey));
      this.d.db.delete(backups).where(eq(backups.accountId, accountId)).run();
    } catch (err) {
      // The key is gone already; prune() retries the object deletion.
      this.d.log.warn("backup.shred_delete_deferred", { accountId, count: rows.length, err });
    }
    this.snapshotMarks.delete(accountId);
    this.d.log.info("backup.shredded", { accountId });
  }

  /** Not in spec 8.3: age of the newest backup of each kind, for the console's health page. */
  newestAt(): { tenant: string | null; control: string | null; verified: string | null } {
    const t = this.d.db
      .select({ at: backups.createdAt })
      .from(backups)
      .where(isNotNull(backups.accountId))
      .orderBy(desc(backups.createdAt))
      .limit(1)
      .get();
    const c = this.d.db
      .select({ at: backups.createdAt })
      .from(backups)
      .where(isNull(backups.accountId))
      .orderBy(desc(backups.createdAt))
      .limit(1)
      .get();
    const v = this.d.db
      .select({ at: backups.verifiedAt })
      .from(backups)
      .where(isNotNull(backups.verifiedAt))
      .orderBy(desc(backups.verifiedAt))
      .limit(1)
      .get();
    return { tenant: t?.at ?? null, control: c?.at ?? null, verified: v?.at ?? null };
  }

  // ------------------------------------------------------------------------------------------- internals
  private staging(): string {
    const dir = stagingDir(this.d.dataDir);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  private cleanStaging(now: number): void {
    const dir = this.staging();
    for (const f of readdirSync(dir)) {
      const p = resolve(dir, f);
      if (statSync(p).mtimeMs < now - DAY) rmSync(p, { recursive: true, force: true });
    }
  }

  /**
   * True only when the live file certainly holds nothing the backup `row` lacks. With this process's own marker
   * for that backup, compare exact change markers (no clocks). Otherwise (after a restart) fall back to the
   * recorded time with a margin for coarse file-system timestamps: the worst case is one redundant backup,
   * never a skipped change.
   */
  private unchangedSince(
    accountId: AccountId,
    path: string,
    row: typeof backups.$inferSelect,
  ): boolean {
    const known = this.snapshotMarks.get(accountId);
    if (known?.backupId === row.id) return dbFingerprint(path) === known.mark;
    return dbMtime(path) + MTIME_GRANULARITY_MS <= Date.parse(row.createdAt);
  }

  private latest(accountId: AccountId) {
    return this.d.db
      .select()
      .from(backups)
      .where(eq(backups.accountId, accountId))
      .orderBy(desc(backups.createdAt))
      .limit(1)
      .get();
  }

  private pick(accountId: AccountId, at?: string) {
    if (at === undefined) return this.latest(accountId);
    if (Number.isNaN(Date.parse(at)))
      throw new CloudError(400, "VALIDATION", "at must be an ISO time");
    return this.d.db
      .select()
      .from(backups)
      .where(
        and(eq(backups.accountId, accountId), lte(backups.createdAt, new Date(at).toISOString())),
      )
      .orderBy(desc(backups.createdAt))
      .limit(1)
      .get();
  }

  private dataKey(accountId: AccountId): Uint8Array {
    const row = this.d.db
      .select()
      .from(tenantKeys)
      .where(eq(tenantKeys.accountId, accountId))
      .get();
    if (!row) throw new KeyUnavailableError("missing");
    return unwrapDataKey(row.wrappedDek, accountId, row.kekId, this.d.kek);
  }

  /** Write the wrapped key to `keys/<id>.key` once (the copy restore-control uses). */
  private async escrow(accountId: AccountId): Promise<void> {
    const row = this.d.db
      .select()
      .from(tenantKeys)
      .where(eq(tenantKeys.accountId, accountId))
      .get();
    if (!row?.wrappedDek || row.escrowedAt) return;
    const body = Buffer.from(
      JSON.stringify({ v: 1, accountId, kekId: row.kekId, wrappedDek: row.wrappedDek }),
      "utf8",
    );
    const { Readable } = await import("node:stream");
    await this.d.store.put(
      escrowObjectKey(this.d.region, accountId),
      Readable.from([body]),
      body.length,
    );
    this.d.db
      .update(tenantKeys)
      .set({ escrowedAt: this.clock().toISOString() })
      .where(and(eq(tenantKeys.accountId, accountId), isNull(tenantKeys.destroyedAt)))
      .run();
  }

  private async backupFile(
    src: string,
    accountId: AccountId | null,
    key: Uint8Array,
    prefix: string,
    alreadyCopied = false,
  ): Promise<{ objectKey: string; bytes: number }> {
    const now = this.clock();
    const stamp = fileStamp(now);
    const staging = this.staging();
    const plain = alreadyCopied ? src : resolve(staging, `${accountId ?? "control"}-${stamp}.db`);
    const enc = resolve(staging, `${accountId ?? "control"}-${stamp}.db.gz.enc`);
    // Marker first, snapshot second: a write in between is inside the snapshot and costs one extra backup.
    const mark = accountId ? dbFingerprint(src) : null;
    try {
      if (!alreadyCopied) await onlineCopy(src, plain);
      if (!checkIntegrity(plain, false)) throw new BackupIntegrityError("quick_check failed");
      const sha256 = await fileSha256(plain);
      const schemaVersion = accountId ? schemaVersionOf(plain) : null;
      await sealFile(plain, enc, key, {
        v: 1,
        tenant: accountId ?? "control",
        schemaVersion,
        createdAt: now.toISOString(),
        kekId: this.d.kek.id,
      });
      const bytes = statSync(enc).size;
      const iso = now.toISOString();
      const objectKey = `${this.d.region}/${prefix}/${iso.slice(0, 4)}/${iso.slice(5, 7)}/${stamp}.db.gz.enc`;
      await this.d.store.put(objectKey, createReadStream(enc), bytes);
      const backupId = newId("bk");
      this.d.db
        .insert(backups)
        .values({
          id: backupId,
          accountId,
          objectKey,
          bytes,
          sha256,
          schemaVersion,
          createdAt: iso,
        })
        .run();
      if (accountId && mark !== null) this.snapshotMarks.set(accountId, { backupId, mark });
      return { objectKey, bytes };
    } finally {
      if (!alreadyCopied) removeDbFiles(plain);
      rmSync(enc, { force: true });
    }
  }

  private async download(
    row: typeof backups.$inferSelect,
    dest: string,
    accountId: AccountId,
  ): Promise<void> {
    const key = this.dataKey(accountId);
    let body: NodeJS.ReadableStream;
    try {
      body = await this.d.store.get(row.objectKey);
    } catch (err) {
      if (err instanceof ObjectNotFoundError) throw new BackupIntegrityError("object missing");
      throw err;
    }
    const header = await openToFile(body as AsyncIterable<Buffer>, dest, key, {
      tenant: accountId,
    });
    if (header.kekId !== this.d.kek.id) throw new BackupIntegrityError("unexpected key id");
    if (!isGlideworthDb(dest)) throw new BackupIntegrityError("not a Glideworth database");
    if ((await fileSha256(dest)) !== row.sha256)
      throw new BackupIntegrityError("checksum mismatch");
  }
}

/**
 * Not in spec 8.3: restore the control plane from its newest backup at or before `at` (CLI `restore-control`,
 * run with the server stopped). The current file is kept as `control.db.pre-restore-<ts>`; tenant data keys
 * are put back from their escrow objects (a key shredded since the backup has no escrow object and stays gone).
 */
export async function restoreControlPlane(o: {
  store: ObjectStore;
  kek: Kek;
  region: string;
  dataDir: string;
  at?: string;
  log: Logger;
  now?: () => Date;
}): Promise<{ restoredFrom: string; previous: string | null; keysRestored: number }> {
  const clock = o.now ?? (() => new Date());
  const limit = o.at ? fileStamp(new Date(o.at)) : null;
  const keys = (await o.store.list(`${o.region}/control/`))
    .filter((k) => /\/\d{8}T\d{6,9}Z\.db\.gz\.enc$/.test(k))
    .filter((k) => limit === null || (k.split("/").pop() as string).slice(0, -10) <= limit)
    .sort((a, b) => ((a.split("/").pop() as string) < (b.split("/").pop() as string) ? -1 : 1));
  const chosen = keys.at(-1);
  if (!chosen)
    throw new CloudError(404, "NOT_FOUND", "no control-plane backup at or before that time");
  const staging = stagingDir(o.dataDir);
  mkdirSync(staging, { recursive: true, mode: 0o700 });
  const scratch = resolve(staging, `restore-control-${fileStamp(clock())}.db`);
  const dest = controlDbPath(o.dataDir);
  let previous: string | null = null;
  try {
    await openToFile(
      (await o.store.get(chosen)) as AsyncIterable<Buffer>,
      scratch,
      controlBackupKey(o.kek),
      {
        tenant: "control",
      },
    );
    if (!checkIntegrity(scratch, true)) throw new BackupIntegrityError("integrity check failed");
    if (existsSync(dest)) {
      previous = `${dest}.pre-restore-${fileStamp(clock())}`;
      await onlineCopy(dest, previous);
    }
    mkdirSync(resolve(o.dataDir, "control"), { recursive: true, mode: 0o700 });
    removeDbFiles(dest);
    await onlineCopy(scratch, dest);
  } finally {
    removeDbFiles(scratch);
  }
  let keysRestored = 0;
  const db = new Database(dest);
  try {
    db.pragma("journal_mode = WAL");
    const update = db.prepare(
      "UPDATE tenant_keys SET wrapped_dek = ?, escrowed_at = coalesce(escrowed_at, ?) WHERE account_id = ? AND kek_id = ? AND destroyed_at IS NULL",
    );
    for (const k of await o.store.list(`${o.region}/keys/`)) {
      try {
        const parts: Buffer[] = [];
        for await (const c of (await o.store.get(k)) as AsyncIterable<Buffer>)
          parts.push(Buffer.from(c));
        const j = JSON.parse(Buffer.concat(parts).toString("utf8")) as {
          accountId?: string;
          kekId?: string;
          wrappedDek?: string;
        };
        if (
          typeof j.accountId !== "string" ||
          typeof j.wrappedDek !== "string" ||
          typeof j.kekId !== "string"
        )
          continue;
        keysRestored += update.run(
          j.wrappedDek,
          clock().toISOString(),
          j.accountId,
          j.kekId,
        ).changes;
      } catch (err) {
        o.log.warn("backup.key_escrow_unreadable", { err });
      }
    }
  } finally {
    db.close();
  }
  o.log.info("backup.control_restored", { count: keysRestored });
  return { restoredFrom: chosen, previous, keysRestored };
}
