import type { PricingConfig } from "./pricing.js";
import type {
  StripeSubscriptionStatus,
  StripeSubscriptionView,
  SubscriptionRecord,
} from "./types.js";

/**
 * Pure state transitions of the subscription record (design 4.4). The service reads, calls one of these, and saves.
 *
 *   (none) --workspace created--> trialing_local (no access) --checkout--> trialing | active | incomplete
 *   any Stripe status --webhook (re-fetched subscription)--> the fetched Stripe status
 *   operator: compedUntil (comp), cancelNow (canceled)
 *
 * The trial is a Stripe trial started in Checkout with a card; there is no local trial clock. Grace expiry and the
 * end of a period canceled at period end are not transitions: `accessFor` derives them from the stored times, so no
 * clock job is needed for access to lapse.
 */

/** Stripe subscription states that still bill or can return to billing without a new checkout. */
export const LIVE_STRIPE_STATUSES: ReadonlySet<StripeSubscriptionStatus> = new Set([
  "trialing",
  "active",
  "past_due",
  "unpaid",
  "paused",
  "incomplete",
]);

/** States in which a new Checkout must be refused (the owner should use the portal instead). */
export const BLOCKS_NEW_CHECKOUT: ReadonlySet<StripeSubscriptionStatus> = new Set([
  "trialing",
  "active",
  "past_due",
  "unpaid",
  "paused",
]);

export function isLive(rec: SubscriptionRecord | null): boolean {
  return (
    rec !== null &&
    rec.status !== "trialing_local" &&
    rec.stripeSubscriptionId !== null &&
    LIVE_STRIPE_STATUSES.has(rec.status)
  );
}

const iso = (seconds: number | null): string | null =>
  seconds === null ? null : new Date(seconds * 1000).toISOString();

/**
 * A new workspace's record: `trialing_local` (no Stripe subscription yet, so no access) until the owner completes
 * Checkout. `trialAvailable` says whether that Checkout starts a free trial: only when the address never had one
 * (`trialAllowed`) and `trialDays` is above 0.
 */
export function newAccountRecord(
  accountId: string,
  now: Date,
  cfg: Pick<PricingConfig, "trialDays" | "trialProductId">,
  trialAllowed: boolean,
): SubscriptionRecord {
  return {
    accountId,
    status: "trialing_local",
    productId: cfg.trialProductId,
    priceLookupKey: null,
    trialEndsAt: null,
    trialAvailable: trialAllowed && cfg.trialDays > 0,
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    canceledAt: null,
    pastDueSince: null,
    compedUntil: null,
    stripeUpdated: null,
    updatedAt: now.toISOString(),
  };
}

export type ApplyResult =
  | { kind: "applied"; record: SubscriptionRecord }
  /** The view is an older subscription of this account that has ended while a newer one is live. */
  | { kind: "superseded"; record: SubscriptionRecord }
  /** Two different live subscriptions for one account: kept the stored one; an operator must resolve it. */
  | { kind: "conflict"; record: SubscriptionRecord };

/**
 * Applies a subscription freshly fetched from Stripe. The event body is never an input: only its `created` time,
 * which becomes the monotonic `stripeUpdated` stamp (`max(stored, event.created)`).
 */
export function applyStripeSubscription(
  prev: SubscriptionRecord | null,
  accountId: string,
  view: StripeSubscriptionView,
  eventCreated: number,
  now: Date,
  cfg: Pick<PricingConfig, "trialProductId">,
  /** The stored stamp as read before the subscription was fetched (defaults to `prev.stripeUpdated`). */
  stampFloor?: number | null,
): ApplyResult {
  if (prev?.stripeSubscriptionId && prev.stripeSubscriptionId !== view.id) {
    const viewLive = LIVE_STRIPE_STATUSES.has(view.status);
    if (isLive(prev)) return { kind: viewLive ? "conflict" : "superseded", record: prev };
  }
  const sameSubscription = prev?.stripeSubscriptionId === view.id;
  const pastDueSince =
    view.status === "past_due"
      ? sameSubscription && prev?.status === "past_due" && prev.pastDueSince
        ? prev.pastDueSince
        : now.toISOString()
      : null;
  const record: SubscriptionRecord = {
    accountId,
    status: view.status,
    productId: view.productId ?? prev?.productId ?? cfg.trialProductId,
    priceLookupKey:
      view.priceLookupKey ?? (sameSubscription ? (prev?.priceLookupKey ?? null) : null),
    trialEndsAt: iso(view.trialEnd),
    // Any Stripe subscription, trial or not, uses up the workspace's trial.
    trialAvailable: false,
    stripeCustomerId: view.customerId,
    stripeSubscriptionId: view.id,
    currentPeriodEnd: iso(view.currentPeriodEnd),
    cancelAtPeriodEnd: view.cancelAtPeriodEnd,
    canceledAt: iso(view.canceledAt),
    pastDueSince,
    compedUntil: prev?.compedUntil ?? null,
    stripeUpdated: Math.max(
      (stampFloor === undefined ? prev?.stripeUpdated : stampFloor) ?? 0,
      eventCreated,
    ),
    updatedAt: now.toISOString(),
  };
  return { kind: "applied", record };
}

/** Operator comp: full access until `until` (ISO) regardless of Stripe state; `null` removes it. */
export function applyComp(
  prev: SubscriptionRecord | null,
  accountId: string,
  until: string | null,
  now: Date,
  cfg: Pick<PricingConfig, "trialDays" | "trialProductId">,
): SubscriptionRecord {
  const base = prev ?? newAccountRecord(accountId, now, cfg, false);
  return { ...base, compedUntil: until, updatedAt: now.toISOString() };
}

/** Records the Stripe customer on the account's record (creating a record without a trial if none exists). */
export function applyCustomer(
  prev: SubscriptionRecord | null,
  accountId: string,
  customerId: string,
  now: Date,
  cfg: Pick<PricingConfig, "trialDays" | "trialProductId">,
): SubscriptionRecord {
  const base = prev ?? newAccountRecord(accountId, now, cfg, false);
  return { ...base, stripeCustomerId: customerId, updatedAt: now.toISOString() };
}
