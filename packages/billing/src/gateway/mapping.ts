import type {
  StripePriceView,
  StripeSubscriptionStatus,
  StripeSubscriptionView,
} from "../types.js";

/**
 * Minimal structural shapes of the Stripe objects we read (API version 2026-10-28.endive). `Stripe.Subscription`
 * and `Stripe.Price` from the SDK are assignable to these; the fake gateway builds plain objects of the same shape,
 * so both go through the same mapping code.
 */
type Ref = string | { id: string };

export interface RawSubscription {
  id: string;
  customer: Ref;
  status: string;
  cancel_at_period_end: boolean;
  cancel_at: number | null;
  canceled_at: number | null;
  trial_end: number | null;
  metadata: Record<string, string>;
  items: {
    data: Array<{
      // Since API 2025-03-31 the billing period lives on the subscription item, not on the subscription.
      current_period_end: number;
      price: { id: string; lookup_key: string | null; product: Ref };
    }>;
  };
}

export interface RawPrice {
  id: string;
  lookup_key: string | null;
  product: Ref;
  active: boolean;
  unit_amount: number | null;
  currency: string;
  recurring: { interval: string } | null;
  tax_behavior: string | null;
  currency_options?: Record<
    string,
    { unit_amount: number | null; tax_behavior: string | null }
  > | null;
}

const STATUSES: ReadonlySet<string> = new Set<StripeSubscriptionStatus>([
  "incomplete",
  "incomplete_expired",
  "trialing",
  "active",
  "past_due",
  "unpaid",
  "canceled",
  "paused",
]);

export const refId = (r: Ref): string => (typeof r === "string" ? r : r.id);

export function subscriptionView(raw: RawSubscription): StripeSubscriptionView {
  if (!STATUSES.has(raw.status)) {
    // An unknown status must not be guessed into access; failing makes the event retry and alerts.
    throw new Error(`Unknown subscription status ${JSON.stringify(raw.status).slice(0, 40)}`);
  }
  const item = raw.items.data[0];
  const itemPeriodEnd = item?.current_period_end ?? null;
  // A cancellation date (`cancel_at`) is treated like cancel-at-period-end with the earlier of the two ends, so a
  // scheduled cancellation set through either field lapses access at the right time.
  const periodEnd =
    raw.cancel_at !== null && itemPeriodEnd !== null
      ? Math.min(raw.cancel_at, itemPeriodEnd)
      : (raw.cancel_at ?? itemPeriodEnd);
  const metadata: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw.metadata ?? {}))
    if (typeof v === "string") metadata[k] = v;
  return {
    id: raw.id,
    customerId: refId(raw.customer),
    status: raw.status as StripeSubscriptionStatus,
    priceLookupKey: item?.price.lookup_key ?? null,
    productId: item ? refId(item.price.product) : null,
    currentPeriodEnd: periodEnd,
    cancelAtPeriodEnd: raw.cancel_at_period_end || raw.cancel_at !== null,
    canceledAt: raw.canceled_at,
    trialEnd: raw.trial_end,
    metadata,
  };
}

export function priceView(raw: RawPrice): StripePriceView | null {
  const interval = raw.recurring?.interval;
  if (
    raw.lookup_key === null ||
    raw.unit_amount === null ||
    (interval !== "month" && interval !== "year")
  ) {
    return null;
  }
  const currencyOptions: StripePriceView["currencyOptions"] = {};
  for (const [cur, opt] of Object.entries(raw.currency_options ?? {})) {
    // Stripe lists the primary currency among the options too; the config keeps it separate.
    if (cur === raw.currency) continue;
    currencyOptions[cur] = {
      unitAmount: opt.unit_amount ?? -1,
      taxBehavior: opt.tax_behavior ?? "unspecified",
    };
  }
  return {
    id: raw.id,
    lookupKey: raw.lookup_key,
    productId: refId(raw.product),
    active: raw.active,
    unitAmount: raw.unit_amount,
    currency: raw.currency,
    interval,
    taxBehavior: raw.tax_behavior ?? "unspecified",
    currencyOptions,
  };
}

/** Stripe's refund `reason` enum; anything else is sent as `requested_by_customer` with the text in metadata. */
export const STRIPE_REFUND_REASONS = ["duplicate", "fraudulent", "requested_by_customer"] as const;
export type StripeRefundReason = (typeof STRIPE_REFUND_REASONS)[number];
export function refundReason(reason: string): StripeRefundReason {
  return (STRIPE_REFUND_REASONS as readonly string[]).includes(reason)
    ? (reason as StripeRefundReason)
    : "requested_by_customer";
}

export const PORTAL_METADATA_KEY = "glideworth_managed";
export const PORTAL_METADATA_VALUE = "billing-portal-v1";
