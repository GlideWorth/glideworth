import { limitsFor, type PlanLimits, type PricingConfig } from "./pricing.js";
import type { Access, AccessReason, SubscriptionRecord } from "./types.js";

export const DAY_MS = 86_400_000;

function ms(iso: string | null): number | null {
  if (iso === null) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

const full = (reason: AccessReason, changesAt: number | null): Access => ({
  level: "full",
  reason,
  changesAt: changesAt === null ? null : new Date(changesAt).toISOString(),
});
const readOnly = (reason: AccessReason): Access => ({
  level: "read_only",
  reason,
  changesAt: null,
});

/**
 * The access decision for one account (design 4.4). Pure: depends only on its arguments.
 *
 * Boundaries are half-open: access that ends "at" an instant is full strictly before it and read-only from it.
 * Lapse never deletes anything; the worst outcome is `read_only`.
 */
export function accessFor(
  sub: SubscriptionRecord | null,
  now: Date,
  cfg: Pick<PricingConfig, "pastDueGraceDays">,
): Access {
  if (sub === null) return readOnly("no_subscription");
  const t = now.getTime();
  // An operator comp overrides every subscription state while it runs (including past_due and canceled).
  const compedUntil = ms(sub.compedUntil);
  if (compedUntil !== null && t < compedUntil) return full("comped", compedUntil);
  return statusAccess(sub, t, cfg);
}

function statusAccess(
  sub: SubscriptionRecord,
  t: number,
  cfg: Pick<PricingConfig, "pastDueGraceDays">,
): Access {
  const trialEnd = ms(sub.trialEndsAt);
  const localTrialRunning = trialEnd !== null && t < trialEnd;
  switch (sub.status) {
    case "trialing_local":
      return localTrialRunning ? full("trial", trialEnd) : readOnly("trial_expired");
    case "active":
    case "trialing": {
      // Cancel at period end keeps full access until the period ends, even if the final `deleted` event is late.
      const periodEnd = ms(sub.currentPeriodEnd);
      if (sub.cancelAtPeriodEnd && periodEnd !== null) {
        return t < periodEnd ? full("active", periodEnd) : readOnly("canceled");
      }
      return full("active", null);
    }
    case "past_due": {
      const since = ms(sub.pastDueSince) ?? ms(sub.updatedAt);
      if (since === null) return readOnly("past_due");
      const graceEnd = since + cfg.pastDueGraceDays * DAY_MS;
      return t < graceEnd ? full("past_due_grace", graceEnd) : readOnly("past_due");
    }
    case "incomplete":
    case "incomplete_expired":
      return localTrialRunning ? full("trial", trialEnd) : readOnly("incomplete");
    case "unpaid":
      return readOnly("unpaid");
    case "canceled":
      return readOnly("canceled");
    case "paused":
      return readOnly("paused");
  }
}

export type AccountStatus = "active" | "suspended" | "deleting" | "deleted" | "migration_failed";

export interface EntitlementDecision {
  level: "full" | "read_only" | "suspended";
  reason: AccessReason | "suspended";
  limits: PlanLimits;
  trialEndsAt: string | null;
  changesAt: string | null;
  access: Access;
}

/**
 * The single entitlement rule (design 6.1) as a pure function. `@glideworth/cloud`'s `entitlements.get` reads the
 * account row and the subscription row and calls this. Any account status other than `active` means `suspended`
 * (no access except the owner's export and delete, which the cloud routes allow independently).
 */
export function entitlementFor(i: {
  accountStatus: AccountStatus;
  subscription: SubscriptionRecord | null;
  now: Date;
  pricing: PricingConfig;
}): EntitlementDecision {
  const access = accessFor(i.subscription, i.now, i.pricing);
  const limits = limitsFor(i.pricing, i.subscription?.productId);
  const trialEndsAt = i.subscription?.trialEndsAt ?? null;
  if (i.accountStatus !== "active") {
    return {
      level: "suspended",
      reason: "suspended",
      limits,
      trialEndsAt,
      changesAt: null,
      access,
    };
  }
  return {
    level: access.level,
    reason: access.reason,
    limits,
    trialEndsAt,
    changesAt: access.changesAt,
    access,
  };
}
