/**
 * Workspaces and members (spec 2.3, 3.6, 3.8, 3.9, 8.3).
 *
 * Control-plane operations: listing, membership lookup, rename, MCP-writes switch, invitations (create, list,
 * revoke, accept, bound to the invited address, single use, 7-day expiry, seat limits), members, role change,
 * removal, leaving, ownership transfer, support grants. The tenant `users` mirror is kept in step through
 * `registry.with(accountId, r => r.members…)` (TenantMemberPort).
 *
 * Tenant lifecycle: `create` (control rows in one transaction, then provisioning; rows removed if provisioning
 * fails), `exportDatabase` / `openExport` (consistent copy, 24 h, single download), and deletion. Deletion of a
 * workspace or of a person is a recorded, resumable task (`lifecycle_tasks`): each step is idempotent and the
 * task row says which step is next, so a crash part-way is completed by `resumeLifecycle()` on the next start
 * or sweep. Access ends at the first step (`status='deleting'`, or the user disabled and signed out).
 *
 * Ordering rule for the mirror: changes that remove access (removal, leaving, downgrade, transfer) touch the
 * tenant first and the control plane second, so a failure leaves access unchanged rather than half-revoked;
 * changes that add access (accept, upgrade) write the control plane first (the source of truth; the mirror is
 * reconciled on every tenant open if the second step fails).
 */
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { newTrialRecord, type PricingConfig } from "@glideworth/billing";
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lte, ne, or, sql } from "drizzle-orm";
import type { RateLimiter } from "../abuse/rate-limiter.js";
import { normalizeEmail } from "../accounts/email.js";
import { assertRecentAuthIn } from "../accounts/reauth.js";
import { hashToken } from "../accounts/tokens.js";
import type { ControlAudit } from "../audit.js";
import { type Kek, newDataKey, wrapDataKey } from "../backups/keys.js";
import { closeAccountCheckoutSessions } from "../billing/glue.js";
import type { ControlDb } from "../control/db.js";
import type { MailOutbox } from "../control/outbox.js";
import {
  accounts,
  exports,
  invitations,
  lifecycleTasks,
  memberships,
  sessions,
  subscriptions,
  supportGrants,
  tenantKeys,
  tenantSchedules,
  trialGrants,
  usageCounters,
  users,
} from "../control/schema.js";
import { withWriterLock } from "../control/writer-lock.js";
import type { Keyring } from "../crypto/keyring.js";
import {
  isAccountId,
  newAccountId,
  newId,
  randomBase32,
  randomToken,
  safeEqual,
  TOKEN_RE,
} from "../crypto/random.js";
import { CloudError } from "../errors.js";
import type { BillingService, Mailer, TemplateData, TemplateId } from "../external-types.js";
import { type Logger, silentLogger } from "../log/index.js";
import { exportPath, exportsDir, isExportId } from "../tenancy/paths.js";
import type { TenantRegistry } from "../tenancy/registry.js";
import { onlineCopy } from "../tenancy/sqlite-tools.js";
import { stripControl } from "../text.js";
import type {
  AccountId,
  InvitationView,
  Membership,
  Role,
  SessionContext,
  TenantRuntimeBase,
  UserId,
  WorkspaceSummary,
} from "../types.js";
import { tenantLogin } from "./login.js";

const DAY = 24 * 3600 * 1000;
export const INVITATION_TTL_MS = 7 * DAY;
export const SUPPORT_GRANT_MAX_DAYS = 7;
const NAME_MAX = 100;

export { tenantLogin };

export interface WorkspacesDeps {
  db: ControlDb;
  registry: TenantRegistry<TenantRuntimeBase>;
  billing: BillingService;
  mailer: Mailer;
  audit: ControlAudit;
  keys: Keyring;
  publicUrl: string;
  now?: () => Date;
  /** Not in spec 8.3. */
  log?: Logger;
  /** Not in spec 8.3: invitation mail limits (5 per address per hour, 20 per workspace per day). */
  limiter?: RateLimiter;
  /** Not in spec 8.3, needed by `create`: trial length and the trial product. */
  pricing?: Pick<PricingConfig, "trialDays" | "trialProductId">;
  /** Not in spec 8.3, needed by `create`: wraps the new workspace's backup data key. */
  kek?: Kek;
  /** Not in spec 8.3, needed by exports: `GLIDEWORTH_DATA_DIR`. */
  dataDir?: string;
  /** Not in spec 8.3: must-send mail (export-ready, account-deleted). Without it those mails go direct. */
  outbox?: MailOutbox;
  /** Not in spec 8.3: crypto-shredding on deletion (`BackupService.shred`). Without it only the key row goes. */
  backups?: { shred(accountId: AccountId): Promise<void> };
}

/** The steps of a workspace deletion, in order (each idempotent). */
export const WORKSPACE_DELETE_STEPS = [
  "cancel_billing",
  "destroy_files",
  "shred_keys",
  "control_rows",
  "notify",
  "finish",
] as const;
/** The steps of a person's deletion. */
export const USER_DELETE_STEPS = ["workspaces", "user_row"] as const;
export const EXPORT_TTL_MS = 24 * 3600 * 1000;

interface DeletionState {
  workspaceName: string;
  recipients: Array<{ userId: string; email: string; name: string }>;
  [k: string]: unknown;
}

const forbidden = (msg = "only the workspace owner can do this") =>
  new CloudError(403, "FORBIDDEN", msg);
const notFound = (what: string) => new CloudError(404, "NOT_FOUND", `no such ${what}`);
const invalidInvitation = () =>
  new CloudError(400, "INVALID_TOKEN", "this invitation is invalid, already used or has expired");

function cleanWorkspaceName(name: unknown): string {
  if (typeof name !== "string") throw new CloudError(400, "VALIDATION", "name is required");
  const s = stripControl(name.normalize("NFKC")).trim();
  if (s.length < 1 || s.length > NAME_MAX)
    throw new CloudError(400, "VALIDATION", `name must be 1-${NAME_MAX} characters`);
  return s;
}

export class WorkspacesService {
  private readonly db: ControlDb;
  private readonly clock: () => Date;
  private readonly log: Logger;
  private readonly publicUrl: string;

  constructor(protected readonly d: WorkspacesDeps) {
    this.db = d.db;
    this.clock = d.now ?? (() => new Date());
    this.log = d.log ?? silentLogger;
    this.publicUrl = d.publicUrl.replace(/\/+$/, "");
  }

  // --------------------------------------------------------------------------------------- tenant lifecycle
  /**
   * Spec 2.3 Create: `accounts`, the owner's membership (`tenant_user_id='owner'`), the subscription
   * (`trialing_local`, with a trial only when the address never had one), the tenant data key and the schedule
   * in one transaction; then `registry.provision`. If provisioning fails, the rows (and a trial grant made here)
   * are removed again. A person owns at most one workspace.
   */
  async create(ownerUserId: UserId, name: string): Promise<AccountId> {
    const clean = cleanWorkspaceName(name);
    const { pricing, kek } = this.d;
    if (!pricing || !kek) throw new Error("workspace creation needs pricing and the backup KEK");
    const user = this.db.select().from(users).where(eq(users.id, ownerUserId)).get();
    if (!user || user.disabledAt) throw new CloudError(401, "UNAUTHORIZED", "sign in again");
    if (!user.emailVerifiedAt)
      throw new CloudError(403, "EMAIL_NOT_VERIFIED", "confirm your email address first");
    const now = this.clock();
    const id = newAccountId();
    const grantKey = this.d.keys.hmac("trial-grant", user.emailNormalized);
    const trialGranted = this.db.transaction((tx) => {
      const owns = tx
        .select({ id: accounts.id })
        .from(accounts)
        .where(
          and(
            eq(accounts.ownerUserId, ownerUserId),
            inArray(accounts.status, ["active", "suspended", "migration_failed", "deleting"]),
          ),
        )
        .get();
      if (owns) throw new CloudError(409, "CONFLICT", "you already own a workspace");
      tx.insert(accounts)
        .values({ id, name: clean, ownerUserId, status: "active", createdAt: now.toISOString() })
        .run();
      tx.insert(memberships)
        .values({
          accountId: id,
          userId: ownerUserId,
          role: "owner",
          tenantUserId: "owner",
          createdAt: now.toISOString(),
          createdBy: ownerUserId,
        })
        .run();
      const granted =
        tx
          .insert(trialGrants)
          .values({ emailHmac: grantKey, grantedAt: now.toISOString() })
          .onConflictDoNothing()
          .run().changes === 1;
      const rec = newTrialRecord(id, now, pricing, granted);
      tx.insert(subscriptions)
        .values({ ...rec, version: 0 })
        .run();
      tx.insert(tenantKeys)
        .values({
          accountId: id,
          wrappedDek: wrapDataKey(newDataKey(), id, kek),
          kekId: kek.id,
          createdAt: now.toISOString(),
        })
        .run();
      tx.insert(tenantSchedules).values({ accountId: id }).run();
      return granted;
    });
    try {
      await this.d.registry.provision(id);
    } catch (err) {
      this.db.transaction((tx) => {
        tx.delete(tenantSchedules).where(eq(tenantSchedules.accountId, id)).run();
        tx.delete(tenantKeys).where(eq(tenantKeys.accountId, id)).run();
        tx.delete(subscriptions).where(eq(subscriptions.accountId, id)).run();
        tx.delete(memberships).where(eq(memberships.accountId, id)).run();
        tx.update(sessions)
          .set({ activeAccountId: null })
          .where(eq(sessions.activeAccountId, id))
          .run();
        tx.delete(accounts).where(eq(accounts.id, id)).run();
        if (trialGranted) tx.delete(trialGrants).where(eq(trialGrants.emailHmac, grantKey)).run();
      });
      throw err;
    }
    this.d.audit.record({
      actorType: "user",
      actorId: ownerUserId,
      accountId: id,
      subjectUserId: ownerUserId,
      event: "workspace.created",
      detail: { kind: trialGranted ? "trial" : "no_trial" },
    });
    return id;
  }

  /**
   * Spec 3.8: owner, re-authenticated. A consistent copy of `tenant.db` (a valid self-host database) under
   * `exports/<id>.db` for 24 hours, single download; `export-ready` is mailed. Allowed while suspended.
   */
  async exportDatabase(s: SessionContext): Promise<{ exportId: string; expiresAt: string }> {
    const me = this.requireOwner(s);
    assertRecentAuthIn(this.db, s, this.clock());
    const dataDir = this.requireDataDir();
    if (this.d.limiter && !this.d.limiter.hit(`export:w:${me.accountId}`, 5, 24 * 3600_000).allowed)
      throw new CloudError(429, "RATE_LIMITED", "too many exports today; try again tomorrow");
    const exportId = newId("exp");
    const dest = exportPath(dataDir, exportId);
    mkdirSync(exportsDir(dataDir), { recursive: true, mode: 0o700 });
    await this.d.registry.with(
      me.accountId,
      async () => {
        await onlineCopy(this.d.registry.pathFor(me.accountId), dest);
      },
      { allowSuspended: true },
    );
    const now = this.clock();
    const expiresAt = new Date(now.getTime() + EXPORT_TTL_MS).toISOString();
    this.db
      .insert(exports)
      .values({
        id: exportId,
        accountId: me.accountId,
        requestedBy: s.userId,
        path: dest,
        bytes: statSync(dest).size,
        expiresAt,
      })
      .run();
    this.audit(s, "workspace.exported", me.accountId, { detail: { exportId } });
    this.mustSend(
      { email: s.email, name: s.name },
      "export-ready",
      s.userId,
      `export:${exportId}`,
      {
        name: s.name,
        url: `${this.publicUrl}/settings/workspace#export=${encodeURIComponent(exportId)}`,
        expiresAt,
      },
    );
    return { exportId, expiresAt };
  }

  /**
   * Spec 3.8: the owner of the session's workspace, within 24 hours, once. The download is claimed here
   * (single use even if two requests race); the caller streams the file and then calls `finishExport`.
   * Every failure is the same `NOT_FOUND` (another workspace's id, expired, used, malformed).
   */
  openExport(s: SessionContext, exportId: string): { path: string; filename: string } {
    const me = this.requireOwner(s);
    const nf = () => new CloudError(404, "NOT_FOUND", "no such export");
    if (!isExportId(exportId)) throw nf();
    const dataDir = this.requireDataDir();
    const now = this.clock().toISOString();
    const claimed = this.db
      .update(exports)
      .set({ downloadedAt: now })
      .where(
        and(
          eq(exports.id, exportId),
          eq(exports.accountId, me.accountId),
          isNull(exports.downloadedAt),
          gt(exports.expiresAt, now),
        ),
      )
      .run();
    const path = exportPath(dataDir, exportId);
    if (claimed.changes !== 1 || !existsSync(path)) throw nf();
    return { path, filename: `glideworth-workspace-${now.slice(0, 10)}.db` };
  }

  /** Not in spec 8.3: delete a downloaded export file (after streaming) and expired ones (sweeper). */
  finishExport(exportId: string): void {
    if (!isExportId(exportId) || !this.d.dataDir) return;
    rmSync(exportPath(this.d.dataDir, exportId), { force: true });
  }

  /** Not in spec 8.3: remove export files past 24 h or downloaded; rows go after 7 days. */
  sweepExports(): number {
    if (!this.d.dataDir) return 0;
    const now = this.clock();
    const rows = this.db
      .select()
      .from(exports)
      .where(
        or(lte(exports.expiresAt, now.toISOString()), sql`${exports.downloadedAt} IS NOT NULL`),
      )
      .all();
    for (const r of rows) this.finishExport(r.id);
    const cutoff = new Date(now.getTime() - 7 * 24 * 3600_000).toISOString();
    this.db.delete(exports).where(lte(exports.expiresAt, cutoff)).run();
    return rows.length;
  }

  /**
   * Spec 3.9: owner, re-authenticated, typing the workspace name. Access ends at once (`deleting`); the rest is
   * a resumable task (see `WORKSPACE_DELETE_STEPS`). If a later step fails the call still succeeds (the
   * workspace is already gone for everyone) and the sweeper finishes the task.
   */
  async delete(s: SessionContext, confirmName: string): Promise<void> {
    const me = this.requireOwner(s);
    assertRecentAuthIn(this.db, s, this.clock());
    const acct = this.db
      .select({ name: accounts.name })
      .from(accounts)
      .where(eq(accounts.id, me.accountId))
      .get();
    const typed =
      typeof confirmName === "string" ? stripControl(confirmName.normalize("NFKC")).trim() : "";
    if (!acct?.name || typed !== acct.name)
      throw new CloudError(400, "VALIDATION", "type the workspace name exactly to confirm");
    await this.deleteOwnedByUser(s.userId, me.accountId);
  }

  /**
   * Not in spec 8.3 (review finding 5): delete a workspace on behalf of its owner without a session context
   * (user deletion, operator-started deletion). Records the task, then runs it.
   */
  async deleteOwnedByUser(ownerUserId: UserId, accountId: AccountId): Promise<void> {
    if (!isAccountId(accountId)) throw new CloudError(404, "NOT_FOUND", "no such workspace");
    const acct = this.db.select().from(accounts).where(eq(accounts.id, accountId)).get();
    if (!acct || acct.status === "deleted")
      throw new CloudError(404, "NOT_FOUND", "no such workspace");
    if (acct.ownerUserId !== ownerUserId && acct.status !== "deleting")
      throw new CloudError(403, "FORBIDDEN", "only the workspace owner can do this");
    const recipients = this.db
      .select({ userId: users.id, email: users.email, name: users.name })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(eq(memberships.accountId, accountId))
      .all();
    const now = this.clock().toISOString();
    const started = this.db.transaction((tx) => {
      tx.update(accounts)
        .set({ status: "deleting" })
        .where(and(eq(accounts.id, accountId), ne(accounts.status, "deleted")))
        .run();
      return (
        tx
          .insert(lifecycleTasks)
          .values({
            id: newId("lc"),
            kind: "workspace_delete",
            subjectId: accountId,
            step: WORKSPACE_DELETE_STEPS[0],
            state: { workspaceName: acct.name ?? "", recipients } satisfies DeletionState,
            actorId: ownerUserId,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoNothing()
          .run().changes === 1
      );
    });
    if (started)
      this.d.audit.record({
        actorType: "user",
        actorId: ownerUserId,
        accountId,
        subjectUserId: ownerUserId,
        event: "workspace.deletion_started",
      });
    try {
      await this.runWorkspaceDeletion(accountId);
    } catch {
      // Recorded on the task; resumeLifecycle() completes it.
    }
  }

  /**
   * Not in spec 8.3 (review finding 5): delete a person (spec 3.9). The caller (`AccountsService.deleteUser`) has
   * checked re-authentication and that no owned workspace has other members. The user is disabled and signed
   * out in the first transaction, so access ends even if a later step has to be resumed.
   */
  async deleteUserAccount(
    userId: UserId,
    meta: { ip?: string | null; userAgent?: string | null } = {},
  ): Promise<void> {
    const now = this.clock().toISOString();
    this.db.transaction((tx) => {
      tx.update(users).set({ disabledAt: now, updatedAt: now }).where(eq(users.id, userId)).run();
      tx.delete(sessions).where(eq(sessions.userId, userId)).run();
      // Nobody joins a workspace of a person being deleted.
      const owned = tx
        .select({ id: accounts.id })
        .from(accounts)
        .where(eq(accounts.ownerUserId, userId))
        .all()
        .map((r) => r.id);
      if (owned.length)
        tx.update(invitations)
          .set({ revokedAt: now })
          .where(
            and(
              inArray(invitations.accountId, owned),
              isNull(invitations.acceptedAt),
              isNull(invitations.revokedAt),
            ),
          )
          .run();
      tx.insert(lifecycleTasks)
        .values({
          id: newId("lc"),
          kind: "user_delete",
          subjectId: userId,
          step: USER_DELETE_STEPS[0],
          state: { ip: meta.ip ?? null, userAgent: meta.userAgent ?? null },
          actorId: userId,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing()
        .run();
    });
    try {
      await this.runUserDeletion(userId);
    } catch {
      // Recorded on the task (the person is already disabled and signed out); resumeLifecycle() finishes it.
    }
  }

  /** Not in spec 8.3: finish every interrupted deletion (on start and from the sweeper). */
  async resumeLifecycle(): Promise<{ completed: number; failed: number }> {
    const tasks = this.db
      .select()
      .from(lifecycleTasks)
      .orderBy(asc(lifecycleTasks.createdAt))
      .all();
    let completed = 0;
    let failed = 0;
    for (const t of tasks) {
      try {
        if (t.kind === "workspace_delete") await this.runWorkspaceDeletion(t.subjectId);
        else await this.runUserDeletion(t.subjectId);
        completed++;
      } catch {
        failed++;
      }
    }
    return { completed, failed };
  }

  /** Not in spec 8.3: test hook, called before each deletion step (a throw simulates a crash there). */
  protected beforeStep(_kind: "workspace_delete" | "user_delete", _step: string): void {}

  private task(kind: "workspace_delete" | "user_delete", subjectId: string) {
    return this.db
      .select()
      .from(lifecycleTasks)
      .where(and(eq(lifecycleTasks.kind, kind), eq(lifecycleTasks.subjectId, subjectId)))
      .get();
  }

  private advance(id: string, step: string): void {
    this.db
      .update(lifecycleTasks)
      .set({ step, updatedAt: this.clock().toISOString() })
      .where(eq(lifecycleTasks.id, id))
      .run();
  }

  private failTask(id: string, attempts: number, err: unknown): void {
    const code = (err as { code?: unknown })?.code;
    this.db
      .update(lifecycleTasks)
      .set({
        attempts: attempts + 1,
        lastErrorCode:
          typeof code === "string"
            ? code.slice(0, 64)
            : ((err as Error)?.name ?? "Error").slice(0, 64),
        updatedAt: this.clock().toISOString(),
      })
      .where(eq(lifecycleTasks.id, id))
      .run();
  }

  private async runWorkspaceDeletion(accountId: AccountId): Promise<void> {
    const task = this.task("workspace_delete", accountId);
    if (!task) return;
    const state = task.state as DeletionState;
    let i = WORKSPACE_DELETE_STEPS.indexOf(task.step as (typeof WORKSPACE_DELETE_STEPS)[number]);
    if (i < 0) i = 0;
    try {
      for (; i < WORKSPACE_DELETE_STEPS.length; i++) {
        const step = WORKSPACE_DELETE_STEPS[i] as (typeof WORKSPACE_DELETE_STEPS)[number];
        this.beforeStep("workspace_delete", step);
        await this.workspaceStep(step, accountId, state, task.actorId);
        const next = WORKSPACE_DELETE_STEPS[i + 1];
        if (next) this.advance(task.id, next);
      }
    } catch (err) {
      this.failTask(task.id, task.attempts, err);
      this.log.error("workspace.delete_step_failed", {
        accountId,
        step: WORKSPACE_DELETE_STEPS[i] ?? null,
        attempts: task.attempts + 1,
        err,
      });
      throw err;
    }
  }

  private async workspaceStep(
    step: (typeof WORKSPACE_DELETE_STEPS)[number],
    accountId: AccountId,
    state: DeletionState,
    actorId: string | null,
  ): Promise<void> {
    const now = this.clock();
    switch (step) {
      case "cancel_billing": {
        const cancel = this.d.billing.cancelNow?.bind(this.d.billing);
        closeAccountCheckoutSessions(this.db, accountId);
        if (cancel) await withWriterLock(this.db, `billing:${accountId}`, () => cancel(accountId));
        return;
      }
      case "destroy_files":
        await this.d.registry.destroy(accountId);
        return;
      case "shred_keys":
        if (this.d.backups) await this.d.backups.shred(accountId);
        else
          this.db
            .update(tenantKeys)
            .set({ wrappedDek: null, destroyedAt: now.toISOString() })
            .where(eq(tenantKeys.accountId, accountId))
            .run();
        return;
      case "control_rows": {
        const exportIds = this.db
          .select({ id: exports.id })
          .from(exports)
          .where(eq(exports.accountId, accountId))
          .all();
        for (const e of exportIds) this.finishExport(e.id);
        this.db.transaction((tx) => {
          tx.delete(memberships).where(eq(memberships.accountId, accountId)).run();
          tx.delete(invitations).where(eq(invitations.accountId, accountId)).run();
          tx.delete(tenantSchedules).where(eq(tenantSchedules.accountId, accountId)).run();
          tx.delete(usageCounters).where(eq(usageCounters.accountId, accountId)).run();
          tx.delete(supportGrants).where(eq(supportGrants.accountId, accountId)).run();
          tx.delete(exports).where(eq(exports.accountId, accountId)).run();
          tx.update(sessions)
            .set({ activeAccountId: null })
            .where(eq(sessions.activeAccountId, accountId))
            .run();
        });
        return;
      }
      case "notify": {
        const purgedBy = new Date(now.getTime() + 30 * 24 * 3600_000).toISOString().slice(0, 10);
        for (const r of state.recipients ?? [])
          this.mustSend(
            { email: r.email, name: r.name },
            "account-deleted",
            r.userId,
            `deleted:${accountId}:${r.userId}`,
            {
              name: r.name,
              workspaceName: state.workspaceName ?? "",
              deletedAt: now.toISOString().slice(0, 10),
              backupsPurgedBy: purgedBy,
            },
          );
        return;
      }
      case "finish": {
        this.db.transaction((tx) => {
          // Tombstone: id, deleted_at and (in subscriptions) the Stripe customer id, for accounting.
          tx.update(accounts)
            .set({ status: "deleted", name: null, ownerUserId: null, deletedAt: now.toISOString() })
            .where(eq(accounts.id, accountId))
            .run();
          tx.delete(lifecycleTasks)
            .where(
              and(
                eq(lifecycleTasks.kind, "workspace_delete"),
                eq(lifecycleTasks.subjectId, accountId),
              ),
            )
            .run();
        });
        this.d.audit.record({
          actorType: actorId ? "user" : "system",
          actorId,
          accountId,
          subjectUserId: actorId,
          event: "workspace.deleted",
        });
        return;
      }
    }
  }

  private async runUserDeletion(userId: UserId): Promise<void> {
    const task = this.task("user_delete", userId);
    if (!task) return;
    let i = USER_DELETE_STEPS.indexOf(task.step as (typeof USER_DELETE_STEPS)[number]);
    if (i < 0) i = 0;
    try {
      for (; i < USER_DELETE_STEPS.length; i++) {
        const step = USER_DELETE_STEPS[i] as (typeof USER_DELETE_STEPS)[number];
        this.beforeStep("user_delete", step);
        if (step === "workspaces") await this.leaveAndDeleteWorkspaces(userId);
        else
          this.deleteUserRow(
            userId,
            task.state as { ip?: string | null; userAgent?: string | null },
          );
        const next = USER_DELETE_STEPS[i + 1];
        if (next) this.advance(task.id, next);
      }
    } catch (err) {
      this.failTask(task.id, task.attempts, err);
      this.log.error("user.delete_step_failed", {
        userId,
        step: USER_DELETE_STEPS[i] ?? null,
        attempts: task.attempts + 1,
        err,
      });
      throw err;
    }
  }

  private async leaveAndDeleteWorkspaces(userId: UserId): Promise<void> {
    const owned = this.db
      .select({ id: accounts.id })
      .from(accounts)
      .where(
        and(
          eq(accounts.ownerUserId, userId),
          inArray(accounts.status, ["active", "suspended", "migration_failed", "deleting"]),
        ),
      )
      .all();
    for (const o of owned) {
      const others = this.db
        .select({ n: sql<number>`count(*)` })
        .from(memberships)
        .where(and(eq(memberships.accountId, o.id), ne(memberships.userId, userId)))
        .get();
      if ((others?.n ?? 0) > 0)
        throw new CloudError(409, "CONFLICT", "owned workspace has other members");
      await this.deleteOwnedByUser(userId, o.id);
      if (this.task("workspace_delete", o.id)) throw new Error("workspace deletion unfinished");
    }
    // Workspaces of others (and leftovers of unfinished deletions): leave them, tenant mirror first.
    const rest = this.db
      .select({
        accountId: memberships.accountId,
        tenantUserId: memberships.tenantUserId,
        status: accounts.status,
      })
      .from(memberships)
      .innerJoin(accounts, eq(accounts.id, memberships.accountId))
      .where(eq(memberships.userId, userId))
      .all();
    for (const m of rest) {
      if (m.status === "active" || m.status === "suspended")
        await this.d.registry.with(m.accountId, (r) => r.members.remove(m.tenantUserId), {
          allowSuspended: true,
        });
      this.dropMembership(m.accountId, userId);
      this.d.audit.record({
        actorType: "user",
        actorId: userId,
        accountId: m.accountId,
        subjectUserId: userId,
        event: "member.left",
      });
    }
  }

  private deleteUserRow(
    userId: UserId,
    meta: { ip?: string | null; userAgent?: string | null },
  ): void {
    this.d.outbox?.forgetUser(userId);
    this.db.transaction((tx) => {
      tx.delete(memberships).where(eq(memberships.userId, userId)).run();
      // Cascades: sessions, tokens, recovery codes, known devices. trial_grants keeps only the address HMAC.
      tx.delete(users).where(eq(users.id, userId)).run();
      tx.delete(lifecycleTasks)
        .where(and(eq(lifecycleTasks.kind, "user_delete"), eq(lifecycleTasks.subjectId, userId)))
        .run();
    });
    this.d.audit.record({
      actorType: "user",
      actorId: userId,
      subjectUserId: userId,
      event: "user.deleted",
      ip: meta.ip ?? null,
      userAgent: meta.userAgent ?? null,
    });
  }

  private requireDataDir(): string {
    if (!this.d.dataDir) throw new Error("exports need dataDir");
    return this.d.dataDir;
  }

  /** Must-send mail through the outbox (retried), or directly when no outbox is configured. */
  private mustSend<T extends TemplateId>(
    to: { email: string; name?: string },
    id: T,
    userId: string | null,
    dedupeKey: string,
    data: TemplateData[T],
  ): void {
    if (this.d.outbox) {
      this.d.outbox.enqueue({ to, template: id, data, userId, dedupeKey });
      void this.d.outbox
        .drain()
        .catch((err: unknown) => this.log.error("outbox.drain_failed", { err }));
    } else this.sendMail(to, id, userId, data);
  }

  // ------------------------------------------------------------------------------------------- queries
  listForUser(userId: UserId): WorkspaceSummary[] {
    return this.db
      .select({ accountId: accounts.id, name: accounts.name, role: memberships.role })
      .from(memberships)
      .innerJoin(accounts, eq(accounts.id, memberships.accountId))
      .where(
        and(
          eq(memberships.userId, userId),
          inArray(accounts.status, ["active", "suspended", "migration_failed"]),
        ),
      )
      .orderBy(asc(memberships.createdAt))
      .all()
      .map((r) => ({
        accountId: r.accountId,
        name: r.name ?? "",
        role: r.role,
        access: this.d.billing.status(r.accountId).access,
      }));
  }

  membership(accountId: AccountId, userId: UserId): Membership | null {
    if (!isAccountId(accountId)) return null;
    const r = this.db
      .select({
        accountId: memberships.accountId,
        userId: memberships.userId,
        role: memberships.role,
        tenantUserId: memberships.tenantUserId,
        userName: users.name,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .innerJoin(accounts, eq(accounts.id, memberships.accountId))
      .where(
        and(
          eq(memberships.accountId, accountId),
          eq(memberships.userId, userId),
          inArray(accounts.status, ["active", "suspended", "migration_failed"]),
        ),
      )
      .get();
    return r ?? null;
  }

  /** Members with their email address, which only owners and editors may see (the route drops it for viewers). */
  members(s: SessionContext): Array<Membership & { userEmail: string }> {
    const me = this.requireMember(s);
    return this.db
      .select({
        accountId: memberships.accountId,
        userId: memberships.userId,
        role: memberships.role,
        tenantUserId: memberships.tenantUserId,
        userName: users.name,
        userEmail: users.email,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(eq(memberships.accountId, me.accountId))
      .orderBy(asc(memberships.createdAt))
      .all();
  }

  // ------------------------------------------------------------------------------------------ settings
  rename(s: SessionContext, name: string): void {
    const me = this.requireOwner(s);
    const clean = cleanWorkspaceName(name);
    this.db.update(accounts).set({ name: clean }).where(eq(accounts.id, me.accountId)).run();
    this.audit(s, "workspace.renamed", me.accountId);
  }

  setMcpWrites(s: SessionContext, enabled: boolean): void {
    const me = this.requireOwner(s);
    if (typeof enabled !== "boolean")
      throw new CloudError(400, "VALIDATION", "enabled must be a boolean");
    this.db.update(accounts).set({ mcpWrites: enabled }).where(eq(accounts.id, me.accountId)).run();
    this.audit(s, "workspace.mcp_writes_changed", me.accountId, { detail: { enabled } });
  }

  createSupportGrant(
    s: SessionContext,
    reason: string,
    days: number,
  ): { id: string; expiresAt: string } {
    const me = this.requireOwner(s);
    if (!Number.isInteger(days) || days < 1 || days > SUPPORT_GRANT_MAX_DAYS)
      throw new CloudError(400, "VALIDATION", `days must be 1-${SUPPORT_GRANT_MAX_DAYS}`);
    if (typeof reason !== "string" || reason.trim().length < 1 || reason.length > 500)
      throw new CloudError(400, "VALIDATION", "reason must be 1-500 characters");
    const now = this.clock();
    const id = newId("sg");
    const expiresAt = new Date(now.getTime() + days * DAY).toISOString();
    this.db
      .insert(supportGrants)
      .values({
        id,
        accountId: me.accountId,
        grantedByUserId: s.userId,
        reason: reason.trim(),
        expiresAt,
        createdAt: now.toISOString(),
      })
      .run();
    this.audit(s, "support_grant.created", me.accountId, { detail: { grantId: id, days } });
    return { id, expiresAt };
  }

  /** Not in spec 8.3: the owner's view of support grants. */
  listSupportGrants(s: SessionContext): Array<{
    id: string;
    reason: string;
    expiresAt: string;
    revokedAt: string | null;
    createdAt: string;
  }> {
    const me = this.requireOwner(s);
    return this.db
      .select({
        id: supportGrants.id,
        reason: supportGrants.reason,
        expiresAt: supportGrants.expiresAt,
        revokedAt: supportGrants.revokedAt,
        createdAt: supportGrants.createdAt,
      })
      .from(supportGrants)
      .where(eq(supportGrants.accountId, me.accountId))
      .orderBy(desc(supportGrants.createdAt))
      .all();
  }

  /** Not in spec 8.3: end a support grant early. */
  revokeSupportGrant(s: SessionContext, id: string): void {
    const me = this.requireOwner(s);
    const res = this.db
      .update(supportGrants)
      .set({ revokedAt: this.clock().toISOString() })
      .where(
        and(
          eq(supportGrants.id, typeof id === "string" ? id : ""),
          eq(supportGrants.accountId, me.accountId),
          isNull(supportGrants.revokedAt),
        ),
      )
      .run();
    if (res.changes !== 1) throw notFound("support grant");
    this.audit(s, "support_grant.revoked", me.accountId, { detail: { grantId: id } });
  }

  // --------------------------------------------------------------------------------------- invitations
  /** Invitation mail limits (5 per address per hour, 20 per workspace per day), shared by invite and resend. */
  private limitInvitationMail(accountId: AccountId, norm: string): void {
    if (!this.d.limiter) return;
    const perAddress = this.d.limiter.hit(
      `invite:a:${this.d.keys.hmac("ratelimit", norm).slice(0, 32)}`,
      5,
      3600_000,
    );
    const perAccount = this.d.limiter.hit(`invite:w:${accountId}`, 20, DAY);
    if (!perAddress.allowed || !perAccount.allowed)
      throw new CloudError(429, "RATE_LIMITED", "too many invitations; try again later", {
        retryAfterSeconds: Math.ceil(
          Math.max(perAddress.retryAfterMs, perAccount.retryAfterMs) / 1000,
        ),
      });
  }

  async invite(
    s: SessionContext,
    email: string,
    role: "editor" | "viewer",
  ): Promise<InvitationView> {
    const me = this.requireOwner(s);
    if (role !== "editor" && role !== "viewer")
      throw new CloudError(400, "VALIDATION", "role must be editor or viewer");
    const norm = typeof email === "string" ? normalizeEmail(email) : null;
    if (!norm) throw new CloudError(400, "VALIDATION", "a valid email address is required");
    this.limitInvitationMail(me.accountId, norm);
    const now = this.clock();
    const token = randomToken();
    const id = newId("inv");
    const expiresAt = new Date(now.getTime() + INVITATION_TTL_MS).toISOString();
    const workspaceName =
      this.db
        .select({ name: accounts.name })
        .from(accounts)
        .where(eq(accounts.id, me.accountId))
        .get()?.name ?? "";

    this.db.transaction((tx) => {
      const already = tx
        .select({ userId: memberships.userId })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(and(eq(memberships.accountId, me.accountId), eq(users.emailNormalized, norm)))
        .get();
      if (already) throw new CloudError(409, "CONFLICT", "that person is already a member");
      // A new invitation to the same address replaces the pending one.
      tx.update(invitations)
        .set({ revokedAt: now.toISOString() })
        .where(
          and(
            eq(invitations.accountId, me.accountId),
            eq(invitations.emailNormalized, norm),
            this.pending(now),
          ),
        )
        .run();
      this.assertSeat(tx, me.accountId, role, now, true);
      tx.insert(invitations)
        .values({
          id,
          accountId: me.accountId,
          emailNormalized: norm,
          role,
          tokenHash: hashToken(token),
          invitedBy: s.userId,
          expiresAt,
          createdAt: now.toISOString(),
        })
        .run();
    });
    this.audit(s, "member.invited", me.accountId, { detail: { role, invitationId: id } });
    this.sendMail({ email: email.trim() }, "invitation", null, {
      inviterName: s.name,
      workspaceName,
      role,
      url: `${this.publicUrl}/invite#token=${encodeURIComponent(token)}`,
      expiresInDays: INVITATION_TTL_MS / DAY,
    });
    return { id, email: norm, role, expiresAt, invitedBy: s.userId };
  }

  listInvitations(s: SessionContext): InvitationView[] {
    const me = this.requireOwner(s);
    const now = this.clock();
    return this.db
      .select()
      .from(invitations)
      .where(and(eq(invitations.accountId, me.accountId), this.pending(now)))
      .orderBy(asc(invitations.createdAt))
      .all()
      .map((r) => ({
        id: r.id,
        email: r.emailNormalized,
        role: r.role,
        expiresAt: r.expiresAt,
        invitedBy: r.invitedBy ?? "",
      }));
  }

  /**
   * Send a pending invitation again: a new token (the old link stops working) and a new 7-day expiry, the same
   * lifetime rules as a new invitation, under the same rate limits. An invitation that expired unanswered can be
   * resent while its seat is still free; one that was accepted or revoked cannot.
   */
  async resendInvitation(s: SessionContext, id: string): Promise<InvitationView> {
    const me = this.requireOwner(s);
    const inv = this.db
      .select()
      .from(invitations)
      .where(
        and(
          eq(invitations.id, typeof id === "string" ? id : ""),
          eq(invitations.accountId, me.accountId),
          isNull(invitations.acceptedAt),
          isNull(invitations.revokedAt),
        ),
      )
      .get();
    if (!inv) throw notFound("invitation");
    this.limitInvitationMail(me.accountId, inv.emailNormalized);
    const now = this.clock();
    const token = randomToken();
    const expiresAt = new Date(now.getTime() + INVITATION_TTL_MS).toISOString();
    this.db.transaction((tx) => {
      const already = tx
        .select({ userId: memberships.userId })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(
          and(
            eq(memberships.accountId, me.accountId),
            eq(users.emailNormalized, inv.emailNormalized),
          ),
        )
        .get();
      if (already) throw new CloudError(409, "CONFLICT", "that person is already a member");
      this.assertSeat(tx, me.accountId, inv.role, now, true, inv.id);
      const res = tx
        .update(invitations)
        .set({ tokenHash: hashToken(token), expiresAt })
        .where(
          and(
            eq(invitations.id, inv.id),
            isNull(invitations.acceptedAt),
            isNull(invitations.revokedAt),
          ),
        )
        .run();
      if (res.changes !== 1) throw notFound("invitation");
    });
    this.audit(s, "member.invitation_resent", me.accountId, {
      detail: { role: inv.role, invitationId: inv.id },
    });
    const workspaceName =
      this.db
        .select({ name: accounts.name })
        .from(accounts)
        .where(eq(accounts.id, me.accountId))
        .get()?.name ?? "";
    this.sendMail({ email: inv.emailNormalized }, "invitation", null, {
      inviterName: s.name,
      workspaceName,
      role: inv.role,
      url: `${this.publicUrl}/invite#token=${encodeURIComponent(token)}`,
      expiresInDays: INVITATION_TTL_MS / DAY,
    });
    return {
      id: inv.id,
      email: inv.emailNormalized,
      role: inv.role,
      expiresAt,
      invitedBy: inv.invitedBy ?? "",
    };
  }

  revokeInvitation(s: SessionContext, id: string): void {
    const me = this.requireOwner(s);
    const res = this.db
      .update(invitations)
      .set({ revokedAt: this.clock().toISOString() })
      .where(
        and(
          eq(invitations.id, typeof id === "string" ? id : ""),
          eq(invitations.accountId, me.accountId),
          isNull(invitations.acceptedAt),
          isNull(invitations.revokedAt),
        ),
      )
      .run();
    if (res.changes !== 1) throw notFound("invitation");
    this.audit(s, "member.invitation_revoked", me.accountId, { detail: { invitationId: id } });
  }

  /**
   * Not in spec 8.3: the invitation a token names, only while it can still be accepted (unused, not withdrawn,
   * not expired, its workspace active). Null for anything else, without saying which. Internal: callers decide
   * what to show (`previewInvitation`) or carry (`AccountsService.signUp`).
   */
  liveInvitation(token: unknown): {
    id: string;
    accountId: AccountId;
    role: "editor" | "viewer";
    emailNormalized: string;
    workspaceName: string;
  } | null {
    if (typeof token !== "string" || !TOKEN_RE.test(token)) return null;
    const hash = hashToken(token);
    const row = this.db
      .select({ inv: invitations, status: accounts.status, name: accounts.name })
      .from(invitations)
      .innerJoin(accounts, eq(accounts.id, invitations.accountId))
      .where(eq(invitations.tokenHash, hash))
      .get();
    if (!row || !safeEqual(row.inv.tokenHash, hash)) return null;
    const { inv } = row;
    if (inv.acceptedAt || inv.revokedAt || inv.expiresAt <= this.clock().toISOString()) return null;
    if (row.status !== "active") return null;
    return {
      id: inv.id,
      accountId: inv.accountId,
      role: inv.role,
      emailNormalized: inv.emailNormalized,
      workspaceName: row.name ?? "",
    };
  }

  /**
   * Not in spec 8.3: what the page an invitation link opens may show before anyone signs in: the workspace's
   * name and the role offered, both already in the invitation email. A token that is not live (unknown,
   * guessed, used, withdrawn, expired, workspace gone) gets the same `INVALID_TOKEN` as accepting it would,
   * so it learns nothing. The invited address and the inviter are never shown.
   */
  previewInvitation(token: unknown): { workspaceName: string; role: "editor" | "viewer" } {
    const inv = this.liveInvitation(token);
    if (!inv) throw invalidInvitation();
    return { workspaceName: inv.workspaceName, role: inv.role };
  }

  /**
   * Accept with a signed-in, verified user whose address is the invited one. A mismatch does not consume the
   * invitation and does not reveal the invited address. Seats are checked again here (another invitation may
   * have been accepted meanwhile).
   */
  async acceptInvitation(s: SessionContext, token: string): Promise<Membership> {
    if (typeof token !== "string" || !TOKEN_RE.test(token)) throw invalidInvitation();
    const user = this.db.select().from(users).where(eq(users.id, s.userId)).get();
    if (!user || user.disabledAt || !user.emailVerifiedAt)
      throw new CloudError(403, "EMAIL_NOT_VERIFIED", "confirm your email address first");
    const now = this.clock();
    const hash = hashToken(token);
    const tenantUserId = `usr_${randomBase32(16)}`;
    const accepted = this.db.transaction((tx) => {
      const inv = tx.select().from(invitations).where(eq(invitations.tokenHash, hash)).get();
      if (!inv || !safeEqual(inv.tokenHash, hash)) throw invalidInvitation();
      if (inv.acceptedAt || inv.revokedAt || inv.expiresAt <= now.toISOString())
        throw invalidInvitation();
      const acct = tx.select().from(accounts).where(eq(accounts.id, inv.accountId)).get();
      if (acct?.status !== "active") throw invalidInvitation();
      if (!safeEqual(inv.emailNormalized, user.emailNormalized))
        throw new CloudError(
          403,
          "FORBIDDEN",
          "this invitation was sent to a different email address",
        );
      const existing = tx
        .select()
        .from(memberships)
        .where(and(eq(memberships.accountId, inv.accountId), eq(memberships.userId, user.id)))
        .get();
      if (existing)
        throw new CloudError(409, "CONFLICT", "you are already a member of this workspace");
      this.assertSeat(tx, inv.accountId, inv.role, now, false, inv.id);
      const claimed = tx
        .update(invitations)
        .set({ acceptedAt: now.toISOString() })
        .where(
          and(
            eq(invitations.id, inv.id),
            isNull(invitations.acceptedAt),
            isNull(invitations.revokedAt),
          ),
        )
        .run();
      if (claimed.changes !== 1) throw invalidInvitation();
      tx.insert(memberships)
        .values({
          accountId: inv.accountId,
          userId: user.id,
          role: inv.role,
          tenantUserId,
          createdAt: now.toISOString(),
          createdBy: inv.invitedBy,
        })
        .run();
      return inv;
    });
    await this.mirror(accepted.accountId, (r) =>
      r.members.upsert({
        tenantUserId,
        login: tenantLogin(user.emailNormalized),
        name: user.name,
        role: accepted.role,
      }),
    );
    this.audit(s, "member.joined", accepted.accountId, {
      detail: { role: accepted.role, invitationId: accepted.id },
    });
    return {
      accountId: accepted.accountId,
      userId: user.id,
      role: accepted.role,
      tenantUserId,
      userName: user.name,
    };
  }

  // ----------------------------------------------------------------------------------------- members
  async changeRole(s: SessionContext, userId: UserId, role: "editor" | "viewer"): Promise<void> {
    const me = this.requireOwner(s);
    if (role !== "editor" && role !== "viewer")
      throw new CloudError(400, "VALIDATION", "role must be editor or viewer");
    const target = this.membership(me.accountId, userId);
    if (!target) throw notFound("member");
    if (target.role === "owner")
      throw new CloudError(
        409,
        "CONFLICT",
        "the owner role changes only by transferring ownership",
      );
    if (target.role === role) return;
    const now = this.clock();
    const login = this.loginFor(userId);
    const apply = () =>
      this.db.transaction((tx) => {
        if (role === "editor") this.assertSeat(tx, me.accountId, "editor", now, false);
        tx.update(memberships)
          .set({ role })
          .where(and(eq(memberships.accountId, me.accountId), eq(memberships.userId, userId)))
          .run();
      });
    const upsert = () =>
      this.mirror(me.accountId, (r) =>
        r.members.upsert({ tenantUserId: target.tenantUserId, login, name: target.userName, role }),
      );
    if (role === "viewer") {
      // Downgrade: tenant first (UsersService.update signs the person out and caps their keys).
      await upsert();
      apply();
    } else {
      apply();
      await upsert();
    }
    this.audit(s, "member.role_changed", me.accountId, {
      subject: userId,
      detail: { from: target.role, to: role },
    });
  }

  /** The owner cannot be removed (there must always be one): transfer ownership or delete the workspace. */
  async removeMember(s: SessionContext, userId: UserId): Promise<void> {
    const me = this.requireOwner(s);
    const target = this.membership(me.accountId, userId);
    if (!target) throw notFound("member");
    if (target.role === "owner")
      throw new CloudError(
        409,
        "CONFLICT",
        "the owner cannot be removed; transfer ownership or delete the workspace",
      );
    await this.mirror(me.accountId, (r) => r.members.remove(target.tenantUserId));
    this.dropMembership(me.accountId, userId);
    this.audit(s, "member.removed", me.accountId, {
      subject: userId,
      detail: { role: target.role },
    });
  }

  async leave(s: SessionContext): Promise<void> {
    const me = this.requireMember(s);
    if (me.role === "owner")
      throw new CloudError(
        409,
        "CONFLICT",
        "the owner cannot leave; transfer ownership or delete the workspace",
      );
    await this.mirror(me.accountId, (r) => r.members.remove(me.tenantUserId));
    this.dropMembership(me.accountId, s.userId);
    this.audit(s, "member.left", me.accountId, { detail: { role: me.role } });
  }

  /**
   * Owner, re-authenticated; the recipient must be an editor and must not own another workspace. Both people's
   * API keys and OAuth grants are revoked first (they belong to tenant user ids, which are swapped).
   */
  async transferOwnership(s: SessionContext, toUserId: UserId): Promise<void> {
    const me = this.requireOwner(s);
    assertRecentAuthIn(this.db, s, this.clock());
    if (toUserId === s.userId)
      throw new CloudError(400, "VALIDATION", "you already own this workspace");
    const to = this.membership(me.accountId, toUserId);
    if (!to) throw notFound("member");
    if (to.role !== "editor")
      throw new CloudError(409, "CONFLICT", "ownership can only go to an editor");
    const ownsOther = this.db
      .select({ id: accounts.id })
      .from(accounts)
      .where(
        and(
          eq(accounts.ownerUserId, toUserId),
          ne(accounts.id, me.accountId),
          inArray(accounts.status, ["active", "suspended", "migration_failed", "deleting"]),
        ),
      )
      .get();
    if (ownsOther) throw new CloudError(409, "CONFLICT", "that person already owns a workspace");

    await this.mirror(me.accountId, (r) => {
      r.members.revokeCredentials(me.tenantUserId);
      r.members.revokeCredentials(to.tenantUserId);
    });
    const parking = `swap_${randomBase32(12)}`;
    this.db.transaction((tx) => {
      const where = (u: string) =>
        and(eq(memberships.accountId, me.accountId), eq(memberships.userId, u));
      tx.update(memberships).set({ tenantUserId: parking }).where(where(s.userId)).run();
      tx.update(memberships)
        .set({ tenantUserId: me.tenantUserId, role: "owner" })
        .where(where(toUserId))
        .run();
      tx.update(memberships)
        .set({ tenantUserId: to.tenantUserId, role: "editor" })
        .where(where(s.userId))
        .run();
      tx.update(accounts).set({ ownerUserId: toUserId }).where(eq(accounts.id, me.accountId)).run();
    });
    const oldOwnerLogin = this.loginFor(s.userId);
    const newOwnerLogin = this.loginFor(toUserId);
    await this.mirror(me.accountId, (r) => {
      r.members.upsert({
        tenantUserId: me.tenantUserId,
        login: newOwnerLogin,
        name: to.userName,
        role: "owner",
      });
      r.members.upsert({
        tenantUserId: to.tenantUserId,
        login: oldOwnerLogin,
        name: me.userName,
        role: "editor",
      });
    });
    this.audit(s, "ownership.transferred", me.accountId, { subject: toUserId });
    for (const uid of [s.userId, toUserId]) {
      const u = this.db.select().from(users).where(eq(users.id, uid)).get();
      if (u)
        this.sendMail({ email: u.email, name: u.name }, "security-change", u.id, {
          name: u.name,
          change: "ownership-transferred",
          at: this.clock().toISOString(),
          securityUrl: `${this.publicUrl}/settings/security`,
        });
    }
  }

  // ------------------------------------------------------------------------------------------ internals
  /** The caller's membership of the session's active workspace (re-read on every call). */
  protected requireMember(s: SessionContext): Membership {
    if (!s.activeAccountId) throw new CloudError(403, "FORBIDDEN", "choose a workspace first");
    const m = this.membership(s.activeAccountId, s.userId);
    if (!m) throw new CloudError(403, "FORBIDDEN", "you are not a member of that workspace");
    return m;
  }

  protected requireOwner(s: SessionContext): Membership {
    const m = this.requireMember(s);
    if (m.role !== "owner") throw forbidden();
    return m;
  }

  private pending(now: Date) {
    return and(
      isNull(invitations.acceptedAt),
      isNull(invitations.revokedAt),
      gt(invitations.expiresAt, now.toISOString()),
    );
  }

  /**
   * Seat limits from the plan (`editors` counts the owner). Pending invitations count when inviting, so an owner
   * cannot over-invite; at acceptance only members (and other pending invitations are not reserved seats).
   */
  private assertSeat(
    tx: Pick<ControlDb, "select">,
    accountId: AccountId,
    role: "editor" | "viewer",
    now: Date,
    countPending: boolean,
    excludeInvitation?: string,
  ): void {
    const limits = this.d.billing.status(accountId).limits;
    const roles: Role[] = role === "editor" ? ["owner", "editor"] : ["viewer"];
    const limit = role === "editor" ? limits.editors : limits.viewers;
    const members =
      tx
        .select({ n: sql<number>`count(*)` })
        .from(memberships)
        .where(and(eq(memberships.accountId, accountId), inArray(memberships.role, roles)))
        .get()?.n ?? 0;
    const pending = countPending
      ? (tx
          .select({ n: sql<number>`count(*)` })
          .from(invitations)
          .where(
            and(
              eq(invitations.accountId, accountId),
              eq(invitations.role, role),
              this.pending(now),
              excludeInvitation ? ne(invitations.id, excludeInvitation) : undefined,
            ),
          )
          .get()?.n ?? 0)
      : 0;
    if (members + pending >= limit)
      throw new CloudError(
        409,
        "SEAT_LIMIT",
        `your plan allows ${limit} ${role === "editor" ? "editors" : "viewers"}`,
        {
          role,
          limit,
        },
      );
  }

  protected dropMembership(accountId: AccountId, userId: UserId): void {
    this.db.transaction((tx) => {
      tx.delete(memberships)
        .where(and(eq(memberships.accountId, accountId), eq(memberships.userId, userId)))
        .run();
      tx.update(sessions)
        .set({ activeAccountId: null })
        .where(and(eq(sessions.userId, userId), eq(sessions.activeAccountId, accountId)))
        .run();
    });
  }

  private loginFor(userId: UserId): string {
    const u = this.db
      .select({ e: users.emailNormalized })
      .from(users)
      .where(eq(users.id, userId))
      .get();
    return tenantLogin(u?.e ?? "member@invalid");
  }

  /**
   * After a password reset marked the person's memberships (`oauth_revoke_pending_at`): open each workspace
   * now, which makes the registry revoke their OAuth grants there (suspended ones included). Never throws. A
   * workspace that cannot be opened keeps its mark, and the registry revokes before its next lease, so
   * nothing is retried here.
   */
  async revokeOAuthGrantsNow(userId: UserId): Promise<void> {
    const marked = this.db
      .select({ accountId: memberships.accountId })
      .from(memberships)
      .where(and(eq(memberships.userId, userId), isNotNull(memberships.oauthRevokePendingAt)))
      .all();
    for (const { accountId } of marked) {
      try {
        await this.d.registry.with(accountId, () => undefined, { allowSuspended: true });
      } catch (err) {
        this.log.warn("workspaces.oauth_revoke_deferred", {
          accountId,
          userId,
          errCode: err instanceof CloudError ? err.code : "ERROR",
        });
      }
    }
  }

  /**
   * Not in spec 8.3: the person renamed themselves. The account's name (control-plane `users.name`) is the one
   * source; every workspace keeps a copy in its member mirror because its file stands alone (API key lists,
   * the names on credentials, a downloaded copy). Here each copy is brought in step now. Only the name moves:
   * the role written back is the one the workspace already has, so this cannot undo a role change made at the
   * same moment. Never throws: a workspace that cannot be opened now is corrected by the registry's
   * reconciliation the next time it opens.
   */
  async syncMemberName(userId: UserId): Promise<void> {
    const rows = this.db
      .select({
        accountId: memberships.accountId,
        tenantUserId: memberships.tenantUserId,
        role: memberships.role,
        name: users.name,
        email: users.emailNormalized,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .innerJoin(accounts, eq(accounts.id, memberships.accountId))
      .where(and(eq(memberships.userId, userId), inArray(accounts.status, ["active", "suspended"])))
      .all();
    for (const m of rows) {
      try {
        await this.d.registry.with(
          m.accountId,
          (r) => {
            const current = r.members.list().find((x) => x.tenantUserId === m.tenantUserId);
            r.members.upsert({
              tenantUserId: m.tenantUserId,
              login: tenantLogin(m.email),
              name: m.name,
              role: current?.role ?? m.role,
            });
          },
          { allowSuspended: true },
        );
      } catch (err) {
        this.log.warn("workspaces.member_name_deferred", {
          accountId: m.accountId,
          userId,
          errCode: err instanceof CloudError ? err.code : "ERROR",
        });
      }
    }
  }

  private async mirror(accountId: AccountId, fn: (r: TenantRuntimeBase) => void): Promise<void> {
    await this.d.registry.with(accountId, (r) => fn(r));
  }

  private audit(
    s: SessionContext,
    event: string,
    accountId: AccountId,
    o: { subject?: UserId; detail?: Record<string, string | number | boolean | null> } = {},
  ): void {
    this.d.audit.record({
      actorType: "user",
      actorId: s.userId,
      accountId,
      subjectUserId: o.subject ?? s.userId,
      event,
      ...(o.detail ? { detail: o.detail } : {}),
    });
  }

  private sendMail<T extends TemplateId>(
    to: { email: string; name?: string },
    id: T,
    userId: string | null,
    data: TemplateData[T],
  ): void {
    this.d.mailer
      .send(to, id, data, userId ? { userId } : {})
      .then((o) => {
        if (o.status === "failed")
          this.log.warn("workspaces.mail_failed", { template: id, errCode: o.code });
      })
      .catch((err: unknown) => this.log.error("workspaces.mail_error", { template: id, err }));
  }
}
