/**
 * Not in spec 8.3: the per-workspace hooks the host wires into one tenant runtime's services (spec 9 steps
 * 9-11). Every decision goes through `EntitlementsService.get` (read on each call, never cached), so a lapse,
 * a payment or a suspension takes effect on the next job, delivery or tick, and nothing here deletes anything.
 */
import { capScopes, readOnlyError } from "./entitlements.js";
import { CloudError } from "./errors.js";
import type { Logger } from "./log/index.js";
import type { QuotaService } from "./quotas.js";
import type { AccountId, EntitlementsService } from "./types.js";

export interface TenantPolicy {
  readonly accountId: AccountId;
  /** `JobsService` admission hook (after a cache miss, before enqueue): read-only, trials, jobs/day, worker time. */
  admitJob(kind: string, params?: { trials?: number }): void;
  /** Per-workspace job concurrency and queue length (spec 6.1: 1 running + 10 queued). */
  jobLimits(): { concurrent: number; queued: number };
  /** Per-job wall-time limit for the executor (abort and terminate). */
  maxJobMs(): number;
  /** Executor thread hook: worker milliseconds used. */
  recordWorkerMs(ms: number): void;
  /** `WebhooksService`: no outbound delivery while the workspace is not at full access. */
  webhooksSuppressed(): boolean;
  /** `WebhooksService`: counts one delivery; false when suppressed or the daily quota is used up. */
  admitWebhookDelivery(): boolean;
  maxWebhooks(): number;
  maxShareLinks(): number;
  maxApiKeys(): number;
  /** Public share-link read: QUOTA_EXCEEDED when the workspace's daily read quota is used up. */
  admitShareRead(): void;
  /** Scheduler: false while read-only or suspended. */
  schedulerEnabled(): boolean;
  /** Scopes capped by entitlement (see `capScopes`). */
  cap<S extends string>(scopes: readonly S[]): { scopes: S[]; limited: boolean };
}

export function createTenantPolicy(d: {
  entitlements: EntitlementsService;
  quotas: QuotaService;
  publicUrl: string;
  log: Logger;
}): (accountId: AccountId) => TenantPolicy {
  const billingUrl = `${d.publicUrl.replace(/\/+$/, "")}/settings/billing`;
  return (accountId) => {
    const ent = () => d.entitlements.get(accountId);
    return {
      accountId,
      admitJob(_kind, params = {}) {
        const e = ent();
        if (e.level !== "full") throw readOnlyError(e, billingUrl);
        if (params.trials !== undefined && params.trials > e.limits.maxMonteCarloTrials)
          throw new CloudError(400, "VALIDATION", "too many Monte Carlo trials for your plan", {
            limit: e.limits.maxMonteCarloTrials,
          });
        const used = d.quotas.usage(accountId).worker_ms;
        if (used >= e.limits.workerSecondsPerDay * 1000)
          throw new CloudError(429, "QUOTA_EXCEEDED", "the daily limit of your plan is used up", {
            metric: "worker_ms",
            limit: e.limits.workerSecondsPerDay * 1000,
          });
        d.quotas.admit(accountId, "job", 1);
      },
      jobLimits() {
        const l = ent().limits;
        return { concurrent: l.concurrentJobs, queued: l.queuedJobs };
      },
      maxJobMs: () => ent().limits.maxJobSeconds * 1000,
      recordWorkerMs: (ms) => d.quotas.record(accountId, "worker_ms", ms),
      webhooksSuppressed: () => ent().level !== "full",
      admitWebhookDelivery() {
        if (ent().level !== "full") return false;
        try {
          d.quotas.admit(accountId, "webhook_delivery", 1);
          return true;
        } catch {
          d.log.warn("quota.webhook_deliveries_exhausted", { accountId });
          return false;
        }
      },
      maxWebhooks: () => ent().limits.webhooks,
      maxShareLinks: () => ent().limits.shareLinks,
      maxApiKeys: () => ent().limits.apiKeys,
      admitShareRead: () => d.quotas.admit(accountId, "share_read", 1),
      schedulerEnabled: () => ent().level === "full",
      cap: (scopes) => capScopes(scopes, ent()),
    };
  };
}
