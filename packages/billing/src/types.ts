import type { PriceConfig } from "./pricing.js";

export type SubscriptionStatus =
  | "trialing_local"
  | "incomplete"
  | "incomplete_expired"
  | "trialing"
  | "active"
  | "past_due"
  | "unpaid"
  | "canceled"
  | "paused";

export type StripeSubscriptionStatus = Exclude<SubscriptionStatus, "trialing_local">;

/** One row per account (control-plane `subscriptions`). Times are ISO strings; `stripeUpdated` is epoch seconds. */
export interface SubscriptionRecord {
  accountId: string;
  status: SubscriptionStatus;
  productId: string;
  priceLookupKey: string | null;
  trialEndsAt: string | null;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  canceledAt: string | null;
  pastDueSince: string | null;
  compedUntil: string | null;
  /** `event.created` (seconds) of the last Stripe state applied; never decreases. */
  stripeUpdated: number | null;
  updatedAt: string;
}

export type AccessReason =
  | "trial"
  | "active"
  | "past_due_grace"
  | "comped"
  | "trial_expired"
  | "past_due"
  | "unpaid"
  | "canceled"
  | "paused"
  | "incomplete"
  | "no_subscription";

export interface Access {
  level: "full" | "read_only";
  reason: AccessReason;
  /** When this decision changes by the passage of time alone (trial end, grace end, period end), else null. */
  changesAt: string | null;
}

// --- Stripe gateway: the subset of Stripe we use.

export interface StripeSubscriptionView {
  id: string;
  customerId: string;
  status: StripeSubscriptionStatus;
  priceLookupKey: string | null;
  productId: string | null;
  currentPeriodEnd: number | null;
  cancelAtPeriodEnd: boolean;
  canceledAt: number | null;
  trialEnd: number | null;
  metadata: Record<string, string>;
}

export interface StripeEventView {
  id: string;
  type: string;
  created: number;
  livemode: boolean;
  objectId: string;
  object: Record<string, unknown>;
}

export interface StripePriceView {
  id: string;
  lookupKey: string;
  productId: string;
  active: boolean;
  unitAmount: number;
  currency: string;
  interval: "month" | "year";
  taxBehavior: string;
  currencyOptions: Record<string, { unitAmount: number; taxBehavior: string }>;
}

export interface StripeGateway {
  retrieveProduct(id: string): Promise<{ id: string; name: string; active: boolean } | null>;
  createProduct(
    p: { id: string; name: string; description?: string },
    idempotencyKey: string,
  ): Promise<{ id: string }>;
  listPricesByLookupKeys(keys: string[]): Promise<StripePriceView[]>;
  createPrice(
    p: { productId: string; price: PriceConfig },
    idempotencyKey: string,
  ): Promise<{ id: string }>;
  setPriceActive(id: string, active: boolean): Promise<void>;
  upsertPortalConfiguration(p: {
    prices: Array<{ productId: string; priceIds: string[] }>;
    returnUrl: string;
    existingId?: string;
  }): Promise<{ id: string }>;
  createCustomer(
    p: {
      email: string;
      name: string;
      accountId: string;
      /**
       * The owner's user id, stored as `posthog_person_distinct_id` so PostHog's revenue analytics can join the
       * customer to the person the web app identifies by that id.
       */
      personId?: string;
    },
    idempotencyKey: string,
  ): Promise<{ id: string }>;
  createCheckoutSession(
    p: {
      customerId: string;
      priceId: string;
      accountId: string;
      trialEnd: number | null;
      successUrl: string;
      cancelUrl: string;
      allowPromotionCodes: boolean;
      collectTaxIds: boolean;
      /** Unix seconds; Stripe accepts 30 minutes to 24 hours after creation (its default is 24 hours). */
      expiresAt?: number;
      /**
       * The currency Checkout charges in: the price's own currency, so every customer pays in it (the site says
       * prices are in USD). Without it Stripe picks a `currency_options` entry or, with Adaptive Pricing, the
       * customer's local currency.
       */
      currency: string;
    },
    idempotencyKey: string,
  ): Promise<{ id: string; url: string }>;
  /**
   * Ends an open Checkout Session so it can no longer be paid. Returns the session's final status: `expired`, or
   * `complete` when the customer finished it first (Stripe refuses to expire a completed session).
   */
  expireCheckoutSession(id: string): Promise<{ status: "open" | "complete" | "expired" }>;
  createPortalSession(p: {
    customerId: string;
    returnUrl: string;
    configurationId: string;
  }): Promise<{ url: string }>;
  retrieveSubscription(id: string): Promise<StripeSubscriptionView>;
  cancelSubscription(
    id: string,
    o: { prorate: boolean; invoiceNow: boolean },
  ): Promise<StripeSubscriptionView>;
  createRefund(
    p: { chargeId?: string; paymentIntentId?: string; amount?: number; reason: string },
    idempotencyKey: string,
  ): Promise<{ id: string }>;
  /** Throws `BillingError('SIGNATURE_INVALID')`. */
  constructEvent(
    rawBody: string,
    signatureHeader: string,
    secret: string,
    toleranceSeconds: number,
  ): StripeEventView;
  /**
   * Optional (an addition to 8.2): fetch an event over the authenticated API so the sweep can re-run events that
   * failed. Without it, failed events are retried only by Stripe's own redelivery.
   */
  retrieveEvent?(id: string): Promise<StripeEventView>;
}

/** Webhook endpoint management, used only by the setup script (an addition to 8.2). */
export interface StripeWebhookEndpointView {
  id: string;
  url: string;
  enabledEvents: string[];
  description: string | null;
  apiVersion: string | null;
  status: string;
}

export interface WebhookEndpointAdmin {
  listWebhookEndpoints(): Promise<StripeWebhookEndpointView[]>;
  createWebhookEndpoint(
    p: { url: string; enabledEvents: string[]; description: string; apiVersion: string },
    idempotencyKey: string,
  ): Promise<{ id: string; secret?: string }>;
  updateWebhookEndpoint(
    id: string,
    p: { enabledEvents: string[]; description: string },
  ): Promise<void>;
}

// --- Store and notices

export type BillingNotice =
  | {
      kind: "trial-ending";
      accountId: string;
      trialEndsAt: string;
      /**
       * The first charge when the owner subscribed during the free trial (a Stripe trial carried over from the
       * local one, so the card is charged at its end); null for the no-card trial, which ends in read-only.
       */
      charge: { unitAmount: number; currency: string; interval: "month" | "year" } | null;
    }
  | { kind: "trial-expired"; accountId: string }
  | { kind: "payment-problem"; accountId: string; readOnlyFrom: string }
  | { kind: "payment-succeeded"; accountId: string; invoiceUrl: string | null }
  | { kind: "subscription-activated"; accountId: string }
  | { kind: "subscription-canceled"; accountId: string; accessUntil: string }
  | {
      kind: "dispute" | "early-fraud-warning" | "orphaned-event";
      accountId: string | null;
      stripeObjectId: string;
    };

export type StripeEventStatus = "processed" | "ignored" | "failed" | "orphaned";

/** Implemented by `@glideworth/cloud` on the control plane; `MemoryBillingStore` is the in-memory version. */
export interface BillingStore {
  getSubscription(accountId: string): SubscriptionRecord | null;
  /** Must keep `stripeUpdated` monotonic: a record whose `stripeUpdated` is lower than the stored one is rejected. */
  saveSubscription(rec: SubscriptionRecord): void;
  accountForCustomer(customerId: string): string | null;
  setCustomer(accountId: string, customerId: string): void;
  recordEvent(e: {
    id: string;
    type: string;
    created: number;
    livemode: boolean;
    accountId: string | null;
  }): "new" | "seen-unfinished" | "done";
  finishEvent(id: string, status: StripeEventStatus, errorCode?: string): void;
  failedEvents(limit: number): Array<{ id: string; attempts: number }>;
  /** True exactly once per (accountId, kind, dedupeKey). */
  claimNotice(accountId: string, kind: BillingNotice["kind"], dedupeKey: string): boolean;
  accountsWithTrialEndingBefore(iso: string): string[];
  ownerContact(accountId: string): { email: string; name: string } | null;
}

export interface WebhookOutcome {
  status: 200 | 400 | 500;
  eventId: string | null;
  result: "processed" | "duplicate" | "ignored" | "orphaned" | "failed" | "bad-signature";
}

/** Allowlisted, log-safe fields only: ids, codes, counts. Never emails, amounts, bodies or secrets. */
export type BillingLogFields = Record<string, string | number | boolean | null>;
export type BillingLogger = (
  level: "info" | "warn" | "error",
  event: string,
  fields: BillingLogFields,
) => void;
