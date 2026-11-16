/**
 * Global check-in scheduler (spec 2.5, 2.6): one timer for the cell instead of one per `Services`. Each tick
 * reads `tenant_schedules` for due, active workspaces, skips any whose entitlement is not `full` (read-only
 * pauses the scheduler, spec 4.4) and runs `runDue` inside a lease of that workspace only. The result's
 * `nextRunAt` is recorded; failures back off exponentially (1 min, doubling, at most 6 h).
 */
import { and, asc, eq, isNotNull, lte } from "drizzle-orm";
import type { ControlDb } from "./control/db.js";
import { accounts, tenantSchedules } from "./control/schema.js";
import { isAccountId } from "./crypto/random.js";
import type { Logger } from "./log/index.js";
import type { TenantRegistry } from "./tenancy/registry.js";
import type { AccountId, EntitlementsService, TenantRuntimeBase } from "./types.js";

const MIN_BACKOFF_MS = 60_000;
const MAX_BACKOFF_MS = 6 * 3600_000;

export class CloudScheduler<R extends TenantRuntimeBase> {
  private timer: ReturnType<typeof setInterval> | null = null;
  private current: Promise<{ ran: number; skipped: number }> | null = null;
  private readonly clock: () => Date;

  constructor(
    private readonly d: {
      db: ControlDb;
      registry: TenantRegistry<R>;
      entitlements: EntitlementsService;
      runDue: (r: R) => Promise<{ nextRunAt: string | null }>;
      tickMs?: number;
      concurrency?: number;
      log: Logger;
      now?: () => Date;
    },
  ) {
    this.clock = d.now ?? (() => new Date());
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.d.tickMs ?? 60_000);
    this.timer.unref?.();
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async idle(): Promise<void> {
    while (this.current) await this.current;
  }

  /** The host calls this when a workspace's schedule changes (`CheckinsService` `onConfigChanged`). */
  scheduleChanged(accountId: AccountId, nextRunAt: string | null): void {
    if (!isAccountId(accountId)) return;
    const next =
      nextRunAt && !Number.isNaN(Date.parse(nextRunAt)) ? new Date(nextRunAt).toISOString() : null;
    this.d.db
      .insert(tenantSchedules)
      .values({ accountId, nextCheckinAt: next })
      .onConflictDoUpdate({ target: tenantSchedules.accountId, set: { nextCheckinAt: next } })
      .run();
  }

  /** One pass over due workspaces. Not in spec 8.3 as a public method; tests and the CLI drive it. */
  tick(): Promise<{ ran: number; skipped: number }> {
    if (this.current) return this.current;
    const p = this.runTick().finally(() => {
      this.current = null;
    });
    this.current = p;
    return p;
  }

  private async runTick(): Promise<{ ran: number; skipped: number }> {
    const now = this.clock();
    const due = this.d.db
      .select({
        accountId: tenantSchedules.accountId,
        failures: tenantSchedules.consecutiveFailures,
      })
      .from(tenantSchedules)
      .innerJoin(accounts, eq(accounts.id, tenantSchedules.accountId))
      .where(
        and(
          isNotNull(tenantSchedules.nextCheckinAt),
          lte(tenantSchedules.nextCheckinAt, now.toISOString()),
          eq(accounts.status, "active"),
        ),
      )
      .orderBy(asc(tenantSchedules.nextCheckinAt))
      .limit(1000)
      .all();
    let ran = 0;
    let skipped = 0;
    let next = 0;
    const worker = async () => {
      while (next < due.length) {
        const item = due[next++];
        if (!item) continue;
        if (this.d.entitlements.get(item.accountId, now).level !== "full") {
          skipped++;
          continue;
        }
        await this.runOne(item.accountId, item.failures);
        ran++;
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, this.d.concurrency ?? 2) }, worker));
    if (ran || skipped) this.d.log.info("scheduler.tick", { count: ran, remaining: skipped });
    return { ran, skipped };
  }

  private async runOne(accountId: AccountId, failures: number): Promise<void> {
    const started = this.clock();
    try {
      const { nextRunAt } = await this.d.registry.with(accountId, (r) => this.d.runDue(r));
      this.d.db
        .update(tenantSchedules)
        .set({
          lastCheckinAt: started.toISOString(),
          nextCheckinAt: nextRunAt ? new Date(nextRunAt).toISOString() : null,
          consecutiveFailures: 0,
        })
        .where(eq(tenantSchedules.accountId, accountId))
        .run();
    } catch (err) {
      const backoff = Math.min(MAX_BACKOFF_MS, MIN_BACKOFF_MS * 2 ** Math.min(failures, 20));
      this.d.db
        .update(tenantSchedules)
        .set({
          consecutiveFailures: failures + 1,
          nextCheckinAt: new Date(started.getTime() + backoff).toISOString(),
        })
        .where(eq(tenantSchedules.accountId, accountId))
        .run();
      this.d.log.warn("scheduler.run_failed", { accountId, attempts: failures + 1, err });
    }
  }
}
