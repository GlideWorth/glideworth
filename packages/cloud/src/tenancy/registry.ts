/**
 * Tenant registry (spec 2.3, 8.3): which customer's database a request reaches.
 *
 * - Every id is checked against `^t[a-z2-7]{15}$` before anything else (`pathFor` is the only path builder,
 *   tenancy/paths.ts); an invalid, unknown, deleting or deleted id is `NOT_FOUND` without touching a file.
 * - `acquire` reads `accounts.status` from the control plane on every call (no cache): `suspended` opens only
 *   with `allowSuspended` (owner export), `migration_failed` is `TENANT_UNAVAILABLE` (503).
 * - Open runtimes are cached (LRU of `maxOpen`) and leased with a reference count. Eviction (LRU pressure or
 *   idle time) never closes a runtime with a lease or with `busy()` true; when every slot is busy the cache
 *   grows and logs `tenant.cache_overflow`.
 * - Opening migrates (the host's `TenantOpener`). A failed open marks the account `migration_failed`, so it
 *   answers 503 instead of running half-migrated; the file is never created from scratch here (a missing file
 *   for an active account is an error, not an empty workspace). Before migrating a file whose schema is behind
 *   (`opener.schemaVersion`), a `pre-migrate/<ts>.db` copy is taken (kept 7 days).
 * - After opening, the member mirror is reconciled (control-plane memberships are the source of truth); if
 *   that fails the runtime is closed and the tenant is unavailable (fail closed: a stale mirror could keep a
 *   removed member's credentials working).
 * - Not in spec 8.3: a password reset marks the person's memberships (`oauth_revoke_pending_at`). Before every
 *   lease, the marked members' OAuth grants are revoked in the tenant and the mark is cleared; if that fails
 *   the tenant is unavailable (fail closed), so no request reaches a workspace where a reset is still owed.
 *   A workspace that could not be opened at reset time (suspended, migration failed, being restored) is
 *   therefore dealt with on its next successful lease, with no timer.
 */
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { resolve } from "node:path";
import Database from "better-sqlite3";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import type { ControlAudit } from "../audit.js";
import type { ControlDb } from "../control/db.js";
import { accounts, memberships, users } from "../control/schema.js";
import { isAccountId } from "../crypto/random.js";
import { CloudError } from "../errors.js";
import type { PlanLimits } from "../external-types.js";
import type { Logger } from "../log/index.js";
import type { AccountId, Lease, TenantOpener, TenantRuntimeBase } from "../types.js";
import { tenantLogin } from "../workspaces/login.js";
import { fileStamp, tenantPath } from "./paths.js";
import { dbBytes, schemaVersionOf } from "./sqlite-tools.js";

export interface TenantRegistryOptions<R extends TenantRuntimeBase> {
  dataDir: string;
  control: ControlDb;
  opener: TenantOpener<R>;
  limitsOf: (a: AccountId) => PlanLimits;
  maxOpen: number;
  idleMs?: number;
  log: Logger;
  /** Not in spec 8.3: records `member.connected_apps_revoked` when a reset's revocation is applied. */
  audit?: ControlAudit;
  now?: () => number;
  /** Not in spec 8.3: how long `close`/`destroy` wait for leases to drain (default 30 s). */
  drainMs?: number;
}

interface Entry<R> {
  runtime: R;
  leases: number;
  lastUsed: number;
}

const DEFAULT_IDLE_MS = 10 * 60 * 1000;
const PRE_MIGRATE_KEEP_MS = 7 * 24 * 3600 * 1000;
const OPEN_STATUSES = ["active", "suspended", "migration_failed"] as const;

const notFound = () => new CloudError(404, "NOT_FOUND", "no such workspace");
const unavailable = () =>
  new CloudError(
    503,
    "TENANT_UNAVAILABLE",
    "this workspace is temporarily unavailable; try again later",
  );
const suspended = () => new CloudError(403, "ACCOUNT_SUSPENDED", "this workspace is suspended");

/** PRAGMAs the host applies to a tenant handle (spec 2.3 Open): 5 s busy timeout, 1 MiB cache, storage cap. */
export function tenantPragmas(
  limits: Pick<PlanLimits, "storageMb">,
  pageSize = 4096,
): Record<string, number> {
  const maxPages = Math.max(1, Math.floor((limits.storageMb * 1024 * 1024) / pageSize));
  return { busy_timeout: 5000, cache_size: -1024, max_page_count: maxPages };
}

export class TenantRegistry<R extends TenantRuntimeBase> {
  private readonly cache = new Map<AccountId, Entry<R>>();
  /** Ids being closed for good, destroyed or restored: acquire refuses them until the operation ends. */
  private readonly exclusive = new Set<AccountId>();
  private readonly background = new Set<Promise<void>>();
  private readonly clock: () => number;

  constructor(readonly options: TenantRegistryOptions<R>) {
    if (!Number.isInteger(options.maxOpen) || options.maxOpen < 1)
      throw new Error("maxOpen must be >= 1");
    this.clock = options.now ?? Date.now;
  }

  /** Throws `InvalidTenantIdError` on an id that fails the regex. */
  pathFor(accountId: AccountId): string {
    return tenantPath(this.options.dataDir, accountId);
  }

  /** Create the directory and database of a new account (rows already inserted by `WorkspacesService.create`). */
  async provision(accountId: AccountId): Promise<void> {
    const path = this.pathFor(accountId);
    const dir = tenantPath(this.options.dataDir, accountId, { kind: "dir" });
    if (existsSync(path))
      throw new CloudError(409, "CONFLICT", "workspace database already exists");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    let runtime: R | null = null;
    try {
      runtime = this.options.opener.open(accountId, path, this.options.limitsOf(accountId));
      this.reconcile(accountId, runtime, { all: true });
      chmodSync(path, 0o600);
      this.recordFile(accountId, path);
    } catch (err) {
      if (runtime) await runtime.close().catch(() => {});
      runtime = null;
      rmSync(dir, { recursive: true, force: true });
      this.options.log.error("tenant.provision_failed", { accountId, err });
      throw err;
    }
    await runtime.close();
  }

  /** NOT_FOUND | TENANT_UNAVAILABLE | ACCOUNT_SUSPENDED */
  acquire(accountId: AccountId, o: { allowSuspended?: boolean } = {}): Lease<R> {
    if (!isAccountId(accountId)) throw notFound();
    const row = this.options.control
      .select({ status: accounts.status })
      .from(accounts)
      .where(eq(accounts.id, accountId))
      .get();
    if (!row || row.status === "deleted" || row.status === "deleting") throw notFound();
    if (row.status === "migration_failed") throw unavailable();
    if (row.status === "suspended" && !o.allowSuspended) throw suspended();
    if (this.exclusive.has(accountId)) throw unavailable();

    let entry = this.cache.get(accountId);
    if (entry) {
      this.cache.delete(accountId); // re-insert: Map order is the LRU order
      this.cache.set(accountId, entry);
    } else {
      entry = { runtime: this.open(accountId), leases: 0, lastUsed: this.clock() };
      this.cache.set(accountId, entry);
      this.makeRoom(accountId);
    }
    const e = entry;
    this.revokePendingGrants(accountId, e.runtime);
    e.leases++;
    e.lastUsed = this.clock();
    let released = false;
    return {
      runtime: e.runtime,
      release: () => {
        if (released) return;
        released = true;
        e.leases--;
        e.lastUsed = this.clock();
      },
    };
  }

  async with<T>(
    accountId: AccountId,
    fn: (r: R) => T | Promise<T>,
    o: { allowSuspended?: boolean } = {},
  ): Promise<T> {
    const lease = this.acquire(accountId, o);
    try {
      return await fn(lease.runtime);
    } finally {
      lease.release();
    }
  }

  /** Close runtimes idle for `idleMs` with no lease and nothing running. Returns how many were closed. */
  async evictIdle(): Promise<number> {
    const cutoff = this.clock() - (this.options.idleMs ?? DEFAULT_IDLE_MS);
    const victims: Array<[AccountId, Entry<R>]> = [];
    for (const [id, e] of this.cache)
      if (e.leases === 0 && e.lastUsed <= cutoff && !e.runtime.busy()) victims.push([id, e]);
    for (const [id] of victims) this.cache.delete(id);
    await Promise.all(victims.map(([id, e]) => this.closeRuntime(id, e.runtime)));
    return victims.length;
  }

  /** Close one runtime for good (waits for its leases, up to `drainMs`). The next acquire opens it again. */
  async close(accountId: AccountId): Promise<void> {
    if (!isAccountId(accountId)) return;
    this.exclusive.add(accountId);
    try {
      await this.drainAndClose(accountId);
    } finally {
      this.exclusive.delete(accountId);
    }
  }

  /**
   * Not in spec 8.3: run `fn` with the runtime closed and no new lease possible (restore swaps the file here).
   * `fn` receives the database path.
   */
  async exclusively<T>(accountId: AccountId, fn: (dbPath: string) => Promise<T>): Promise<T> {
    const path = this.pathFor(accountId);
    if (this.exclusive.has(accountId)) throw unavailable();
    this.exclusive.add(accountId);
    try {
      await this.drainAndClose(accountId);
      return await fn(path);
    } finally {
      this.exclusive.delete(accountId);
    }
  }

  /** Evict and remove the tenant directory (workspace deletion). The account must already be `deleting`. */
  async destroy(accountId: AccountId): Promise<void> {
    const dir = tenantPath(this.options.dataDir, accountId, { kind: "dir" });
    this.exclusive.add(accountId);
    try {
      await this.drainAndClose(accountId);
      rmSync(dir, { recursive: true, force: true });
    } finally {
      this.exclusive.delete(accountId);
    }
  }

  /**
   * Migrate every active, suspended or migration-failed tenant that is not open (open ones migrated when they
   * opened). A success clears `migration_failed`; a failure sets it.
   */
  async migrateAll(o: { concurrency: number }): Promise<{ ok: number; failed: AccountId[] }> {
    const ids = this.options.control
      .select({ id: accounts.id, status: accounts.status })
      .from(accounts)
      .where(inArray(accounts.status, [...OPEN_STATUSES]))
      .all();
    let ok = 0;
    const failed: AccountId[] = [];
    let next = 0;
    const worker = async () => {
      while (next < ids.length) {
        const row = ids[next++];
        if (!row || !isAccountId(row.id)) continue;
        if (this.cache.has(row.id)) {
          ok++;
          continue;
        }
        try {
          const runtime = this.open(row.id);
          await runtime.close();
          if (row.status === "migration_failed")
            this.options.control
              .update(accounts)
              .set({ status: "active" })
              .where(and(eq(accounts.id, row.id), eq(accounts.status, "migration_failed")))
              .run();
          ok++;
        } catch {
          failed.push(row.id);
        }
        await new Promise((r) => setImmediate(r));
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(o.concurrency, 16)) }, worker));
    if (failed.length)
      this.options.log.error("tenant.migrate_all_failed", { count: failed.length });
    return { ok, failed };
  }

  stats(): { open: number; leased: number; busy: number } {
    let leased = 0;
    let busy = 0;
    for (const e of this.cache.values()) {
      if (e.leases > 0) leased++;
      if (e.runtime.busy()) busy++;
    }
    return { open: this.cache.size, leased, busy };
  }

  /** Not in spec 8.3: is this tenant's runtime open right now (tests, ops console). */
  isOpen(accountId: AccountId): boolean {
    return this.cache.has(accountId);
  }

  async shutdown(): Promise<void> {
    const all = [...this.cache.entries()];
    this.cache.clear();
    await Promise.all(all.map(([id, e]) => this.closeRuntime(id, e.runtime)));
    await Promise.allSettled([...this.background]);
  }

  // ------------------------------------------------------------------------------------------- internals
  private open(accountId: AccountId): R {
    const path = this.pathFor(accountId);
    if (!existsSync(path)) {
      this.options.log.error("tenant.file_missing", { accountId });
      throw unavailable();
    }
    let runtime: R;
    try {
      this.preMigrateCopy(accountId, path);
      runtime = this.options.opener.open(accountId, path, this.options.limitsOf(accountId));
    } catch (err) {
      this.options.control
        .update(accounts)
        .set({ status: "migration_failed" })
        .where(and(eq(accounts.id, accountId), inArray(accounts.status, ["active", "suspended"])))
        .run();
      this.options.log.error("tenant.migration_failed", { accountId, err });
      throw unavailable();
    }
    try {
      this.reconcile(accountId, runtime);
    } catch (err) {
      this.options.log.error("tenant.reconcile_failed", { accountId, err });
      this.track(runtime.close().catch(() => {}));
      throw unavailable();
    }
    this.recordFile(accountId, path);
    return runtime;
  }

  /** Spec 2.3 Migrate: a consistent copy before a file whose schema is behind is migrated. */
  private preMigrateCopy(accountId: AccountId, path: string): void {
    const target = this.options.opener.schemaVersion;
    if (target === undefined || schemaVersionOf(path) >= target) return;
    const dir = tenantPath(this.options.dataDir, accountId, { kind: "pre-migrate-dir" });
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const now = this.clock();
    for (const f of readdirSync(dir)) {
      const full = resolve(dir, f);
      if (/^\d{8}T\d{6}\d{0,3}Z\.db$/.test(f) && statSync(full).mtimeMs < now - PRE_MIGRATE_KEEP_MS)
        rmSync(full, { force: true });
    }
    const dest = tenantPath(this.options.dataDir, accountId, {
      kind: "pre-migrate",
      stamp: fileStamp(new Date(now)),
    });
    if (existsSync(dest)) return;
    // VACUUM INTO: a consistent, compact, synchronous copy (open is synchronous).
    const db = new Database(path, { readonly: true, fileMustExist: true });
    try {
      db.prepare("VACUUM INTO ?").run(dest);
    } finally {
      db.close();
    }
    chmodSync(dest, 0o600);
    this.options.log.info("tenant.pre_migrate_copy", { accountId, schemaVersion: target });
  }

  /**
   * Control-plane memberships are the truth; the tenant `users` mirror (role and the person's name) is brought
   * in line with them.
   */
  private reconcile(accountId: AccountId, runtime: R, o: { all?: boolean } = {}): void {
    const want = this.options.control
      .select({
        tenantUserId: memberships.tenantUserId,
        role: memberships.role,
        name: users.name,
        email: users.emailNormalized,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(eq(memberships.accountId, accountId))
      .all();
    const have = new Map(runtime.members.list().map((m) => [m.tenantUserId, m]));
    const wanted = new Set<string>();
    for (const m of want) {
      wanted.add(m.tenantUserId);
      const cur = have.get(m.tenantUserId);
      // On provisioning every row is written (the owner's name); afterwards only missing rows, wrong roles and
      // names that differ from the account's (a rename that could not reach this workspace at the time).
      if (
        o.all ||
        cur?.role !== m.role ||
        (cur.name !== undefined && cur.name !== m.name.slice(0, 120))
      )
        runtime.members.upsert({
          tenantUserId: m.tenantUserId,
          login: tenantLogin(m.email),
          name: m.name,
          role: m.role,
        });
    }
    for (const id of have.keys()) if (!wanted.has(id)) runtime.members.remove(id);
  }

  /**
   * OAuth grants owed a revocation by a password reset (one indexed read when there are none). The tenant
   * write comes first: if clearing the mark then fails, the next lease revokes again, which is harmless.
   */
  private revokePendingGrants(accountId: AccountId, runtime: R): void {
    const { control, log, audit } = this.options;
    const pending = and(
      eq(memberships.accountId, accountId),
      isNotNull(memberships.oauthRevokePendingAt),
    );
    const due = control
      .select({ userId: memberships.userId, tenantUserId: memberships.tenantUserId })
      .from(memberships)
      .where(pending)
      .all();
    if (!due.length) return;
    try {
      for (const m of due) {
        const count = runtime.members.revokeOAuthGrants(m.tenantUserId);
        control
          .update(memberships)
          .set({ oauthRevokePendingAt: null })
          .where(and(pending, eq(memberships.userId, m.userId)))
          .run();
        log.info("tenant.oauth_grants_revoked", { accountId, userId: m.userId, count });
        if (count > 0)
          audit?.record({
            actorType: "user",
            actorId: m.userId,
            accountId,
            subjectUserId: m.userId,
            event: "member.connected_apps_revoked",
            detail: { reason: "password_reset", count },
          });
      }
    } catch (err) {
      log.error("tenant.oauth_revoke_failed", { accountId, err });
      throw unavailable();
    }
  }

  private recordFile(accountId: AccountId, path: string): void {
    this.options.control
      .update(accounts)
      .set({
        schemaVersion: schemaVersionOf(path),
        dbBytes: dbBytes(path),
        lastActiveAt: new Date(this.clock()).toISOString(),
      })
      .where(eq(accounts.id, accountId))
      .run();
  }

  private makeRoom(justOpened: AccountId): void {
    if (this.cache.size <= this.options.maxOpen) return;
    for (const [id, e] of this.cache) {
      if (this.cache.size <= this.options.maxOpen) return;
      if (id === justOpened || e.leases > 0 || e.runtime.busy()) continue;
      this.cache.delete(id);
      this.track(this.closeRuntime(id, e.runtime));
    }
    if (this.cache.size > this.options.maxOpen)
      this.options.log.warn("tenant.cache_overflow", {
        open: this.cache.size,
        limit: this.options.maxOpen,
      });
  }

  private async drainAndClose(accountId: AccountId): Promise<void> {
    const e = this.cache.get(accountId);
    if (!e) return;
    const deadline = Date.now() + (this.options.drainMs ?? 30_000);
    while (e.leases > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    if (e.leases > 0) this.options.log.warn("tenant.close_forced", { accountId, count: e.leases });
    this.cache.delete(accountId);
    await this.closeRuntime(accountId, e.runtime);
  }

  private async closeRuntime(accountId: AccountId, runtime: R): Promise<void> {
    try {
      await runtime.close();
    } catch (err) {
      this.options.log.error("tenant.close_failed", { accountId, err });
    }
  }

  private track(p: Promise<void>): void {
    this.background.add(p);
    void p.finally(() => this.background.delete(p));
  }
}
