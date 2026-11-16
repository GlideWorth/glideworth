/**
 * Per-workspace quotas (spec 6.1). Per-minute limits live in the in-memory limiter, keyed by account id;
 * daily limits in `usage_counters` (survive restarts), one row per (account, metric, UTC day). Every key
 * contains the account id, so exhausting one workspace's budget never throttles another.
 */
import { and, eq, sql } from "drizzle-orm";
import type { RateLimiter } from "./abuse/rate-limiter.js";
import type { ControlDb } from "./control/db.js";
import { usageCounters } from "./control/schema.js";
import { CloudError } from "./errors.js";
import type { PlanLimits } from "./external-types.js";
import type { AccountId, EntitlementsService, Metric } from "./types.js";

export const METRICS: readonly Metric[] = [
  "api_request",
  "job",
  "worker_ms",
  "webhook_delivery",
  "share_read",
];

/** The daily limit of each metric (worker time is counted in milliseconds). */
export function dailyLimit(metric: Metric, l: PlanLimits): number {
  switch (metric) {
    case "api_request":
      return l.apiRequestsPerDay;
    case "job":
      return l.jobsPerDay;
    case "worker_ms":
      return l.workerSecondsPerDay * 1000;
    case "webhook_delivery":
      return l.webhookDeliveriesPerDay;
    case "share_read":
      return l.shareReadsPerDay;
  }
}

const utcDay = (d: Date) => d.toISOString().slice(0, 10);
const nextUtcMidnight = (d: Date) =>
  new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)).toISOString();

export class QuotaService {
  private readonly clock: () => Date;

  constructor(
    private readonly d: {
      db: ControlDb;
      limiter: RateLimiter;
      entitlements: EntitlementsService;
      now?: () => Date;
    },
  ) {
    this.clock = d.now ?? (() => new Date());
  }

  /** One API request: 1,200/min (RATE_LIMITED + retryAfter) and 100,000/day (QUOTA_EXCEEDED) per workspace. */
  admitRequest(accountId: AccountId): { remaining: number } {
    const limits = this.d.entitlements.get(accountId).limits;
    const minute = this.d.limiter.hit(
      `quota:api:${accountId}`,
      limits.apiRequestsPerMinute,
      60_000,
    );
    if (!minute.allowed)
      throw new CloudError(429, "RATE_LIMITED", "too many requests for this workspace; slow down", {
        retryAfterSeconds: Math.max(1, Math.ceil(minute.retryAfterMs / 1000)),
      });
    const left = this.take(accountId, "api_request", 1, limits);
    return { remaining: Math.min(minute.remaining, left) };
  }

  /** Check and count `amount` of a daily metric; QUOTA_EXCEEDED (with metric and reset time) when it would pass. */
  admit(accountId: AccountId, metric: Exclude<Metric, "api_request">, amount = 1): void {
    this.take(accountId, metric, amount, this.d.entitlements.get(accountId).limits);
  }

  /** Count without checking (worker time is known only after the work). */
  record(accountId: AccountId, metric: Metric, amount: number): void {
    if (!Number.isFinite(amount) || amount <= 0) return;
    const day = utcDay(this.clock());
    this.d.db
      .insert(usageCounters)
      .values({ accountId, metric, day, value: Math.round(amount) })
      .onConflictDoUpdate({
        target: [usageCounters.accountId, usageCounters.metric, usageCounters.day],
        set: { value: sql`${usageCounters.value} + ${Math.round(amount)}` },
      })
      .run();
  }

  usage(accountId: AccountId, day?: string): Record<Metric, number> {
    const d = day ?? utcDay(this.clock());
    const out = Object.fromEntries(METRICS.map((m) => [m, 0])) as Record<Metric, number>;
    for (const r of this.d.db
      .select()
      .from(usageCounters)
      .where(and(eq(usageCounters.accountId, accountId), eq(usageCounters.day, d)))
      .all())
      if ((METRICS as readonly string[]).includes(r.metric)) out[r.metric as Metric] = r.value;
    return out;
  }

  /** Not in spec 8.3: drop counters older than `days` (default 400, the audit retention). */
  prune(days = 400): number {
    const cutoff = utcDay(new Date(this.clock().getTime() - days * 86_400_000));
    return this.d.db
      .delete(usageCounters)
      .where(sql`${usageCounters.day} < ${cutoff}`)
      .run().changes;
  }

  private take(accountId: AccountId, metric: Metric, amount: number, limits: PlanLimits): number {
    const now = this.clock();
    const day = utcDay(now);
    const limit = dailyLimit(metric, limits);
    // Read and increment in one transaction: two concurrent writers cannot both take the last unit.
    return this.d.db.transaction((tx) => {
      const cur =
        tx
          .select({ value: usageCounters.value })
          .from(usageCounters)
          .where(
            and(
              eq(usageCounters.accountId, accountId),
              eq(usageCounters.metric, metric),
              eq(usageCounters.day, day),
            ),
          )
          .get()?.value ?? 0;
      if (cur + amount > limit)
        throw new CloudError(429, "QUOTA_EXCEEDED", "the daily limit of your plan is used up", {
          metric,
          limit,
          resetsAt: nextUtcMidnight(now),
        });
      tx.insert(usageCounters)
        .values({ accountId, metric, day, value: amount })
        .onConflictDoUpdate({
          target: [usageCounters.accountId, usageCounters.metric, usageCounters.day],
          set: { value: sql`${usageCounters.value} + ${amount}` },
        })
        .run();
      return limit - cur - amount;
    });
  }
}
