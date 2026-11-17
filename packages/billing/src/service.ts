import { accessFor, DAY_MS } from "./access.js";
import { BillingError, errorCodeOf } from "./errors.js";
import { DECLINE_EVENT_TYPES, isHandledEventType } from "./events.js";
import {
  findPrice,
  limitsFor,
  type PlanLimits,
  type PriceConfig,
  type PricingConfig,
} from "./pricing.js";
import { DEFAULT_TOLERANCE_SECONDS } from "./signature.js";
import {
  applyComp,
  applyCustomer,
  applyStripeSubscription,
  BLOCKS_NEW_CHECKOUT,
  LIVE_STRIPE_STATUSES,
  newTrialRecord,
} from "./state.js";
import type {
  Access,
  BillingLogger,
  BillingNotice,
  BillingStore,
  StripeEventView,
  StripeGateway,
  StripeSubscriptionView,
  SubscriptionRecord,
  WebhookOutcome,
} from "./types.js";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/** Design 4.2: carry the local trial into Stripe only with more than 48 h left. Stripe requires `trial_end` at
 * least 48 h after session creation; the extra 10 minutes absorb clock skew and request latency. */
export const TRIAL_CARRY_OVER_MIN_MS = 48 * HOUR_MS + 10 * MINUTE_MS;
/**
 * How long a Checkout Session stays payable (Stripe allows 30 minutes to 24 hours; its default is 24 hours). Short,
 * so an abandoned session does not linger; the session's `expires_at` is 60 to 70 minutes after creation, fixed per
 * 10-minute idempotency window so a retried request sends identical parameters.
 */
export const CHECKOUT_SESSION_TTL_MS = 60 * MINUTE_MS;
/** Design 4.6. */
export const CHECKOUT_LIMITS = {
  perAccount: { limit: 5, windowMs: HOUR_MS },
  perIp: { limit: 10, windowMs: HOUR_MS },
  breaker: { threshold: 20, windowMs: 10 * MINUTE_MS, pauseMs: 30 * MINUTE_MS },
} as const;
/** Design 4.3. */
export const WEBHOOK_TOLERANCE_SECONDS = DEFAULT_TOLERANCE_SECONDS;
export const WEBHOOK_MAX_BODY_BYTES = 1024 * 1024;
/** Sweep: failed events re-run per pass, and attempts after which an event is left to the operator. */
export const SWEEP_EVENT_BATCH = 50;
export const MAX_EVENT_ATTEMPTS = 25;

export interface BillingServiceDeps {
  gateway: StripeGateway;
  store: BillingStore;
  pricing: PricingConfig;
  /** Origin of the web app, for example `https://app.glideworth.com`. */
  publicUrl: string;
  webhookSecret: string;
  portalConfigurationId: string;
  notify: (n: BillingNotice) => Promise<void>;
  /** Consumes one unit of `key`'s budget; returns false when `limit` per `windowMs` is exhausted. */
  limiter: (key: string, limit: number, windowMs: number) => boolean;
  now?: () => Date;
  /** Optional structured logger (an addition to 8.2). Receives only ids and codes. */
  log?: BillingLogger;
}

/** Optional caller identity for `createCheckout` (an addition to 8.2); when given it must be a verified owner. */
export interface CheckoutActor {
  userId: string;
  role: "owner" | "editor" | "viewer";
  emailVerified: boolean;
}

type ProcessResult = "processed" | "orphaned";

interface SyncOutcome {
  result: ProcessResult;
  accountId: string | null;
  record: SubscriptionRecord | null;
  applied: boolean;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const refId = (v: unknown): string | null =>
  str(v) ?? (v && typeof v === "object" ? str((v as { id?: unknown }).id) : null);
const normEmail = (e: string) => e.trim().toLowerCase();

function invoiceSubscriptionId(invoice: Record<string, unknown>): string | null {
  const parent = invoice.parent as
    | { subscription_details?: { subscription?: unknown } }
    | null
    | undefined;
  return refId(parent?.subscription_details?.subscription) ?? refId(invoice.subscription);
}

export class BillingService {
  private readonly d: BillingServiceDeps;
  private readonly publicUrl: string;
  private readonly declines: number[] = [];
  private pausedUntil = 0;
  private readonly locks = new Map<string, Promise<void>>();
  private readonly priceCache = new Map<string, { id: string; until: number }>();

  constructor(d: BillingServiceDeps) {
    if (!d.webhookSecret) throw new BillingError("CONFIG_INVALID", "webhookSecret is required");
    let url: URL;
    try {
      url = new URL(d.publicUrl);
    } catch {
      throw new BillingError("CONFIG_INVALID", "publicUrl is not a URL");
    }
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
      throw new BillingError("CONFIG_INVALID", "publicUrl must be https (http only for localhost)");
    }
    this.d = d;
    this.publicUrl = url.origin;
  }

  private now(): Date {
    return this.d.now ? this.d.now() : new Date();
  }

  private log(
    level: "info" | "warn" | "error",
    event: string,
    fields: Record<string, string | number | boolean | null>,
  ) {
    this.d.log?.(level, event, fields);
  }

  private get billingUrl(): string {
    return `${this.publicUrl}/settings/billing`;
  }

  /** Runs `fn` after every earlier call with the same key has finished (per-process serialisation). */
  private async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => mine);
    this.locks.set(key, tail);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.locks.get(key) === tail) this.locks.delete(key);
    }
  }

  /** Wraps a Stripe call: BillingErrors pass through, anything else becomes `STRIPE_UNAVAILABLE` (code only). */
  private async stripe<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof BillingError) throw err;
      throw new BillingError("STRIPE_UNAVAILABLE", "Stripe request failed", {
        code: errorCodeOf(err),
      });
    }
  }

  private accountKnown(accountId: string): boolean {
    return (
      this.d.store.ownerContact(accountId) !== null ||
      this.d.store.getSubscription(accountId) !== null
    );
  }

  private async sendNotice(n: BillingNotice, dedupeKey: string): Promise<boolean> {
    // Claim first, then send: at most once. A failed send is not repeated (the mailer retries transient errors).
    if (n.accountId !== null && !this.d.store.claimNotice(n.accountId, n.kind, dedupeKey))
      return false;
    await this.d.notify(n);
    return true;
  }

  // --- trial, status

  /** Creates the account's record on email verification. Idempotent: an existing record is returned unchanged. */
  startTrial(accountId: string, trialAllowed: boolean): SubscriptionRecord {
    const existing = this.d.store.getSubscription(accountId);
    if (existing) return existing;
    const record = newTrialRecord(accountId, this.now(), this.d.pricing, trialAllowed);
    this.d.store.saveSubscription(record);
    return record;
  }

  status(accountId: string): {
    record: SubscriptionRecord | null;
    access: Access;
    limits: PlanLimits;
  } {
    const record = this.d.store.getSubscription(accountId);
    return {
      record,
      access: accessFor(record, this.now(), this.d.pricing),
      limits: limitsFor(this.d.pricing, record?.productId),
    };
  }

  // --- checkout and portal

  async createCheckout(i: {
    accountId: string;
    ownerEmail: string;
    ownerName: string;
    lookupKey: string;
    ip: string;
    actor?: CheckoutActor;
    /** The id of an open session this one replaces (expired by the caller first); keeps the idempotency key fresh. */
    replaces?: string;
  }): Promise<{ url: string }> {
    const now = this.now();
    if (i.actor && (i.actor.role !== "owner" || !i.actor.emailVerified)) {
      throw new BillingError("FORBIDDEN", "Only the verified workspace owner can subscribe");
    }
    const found = findPrice(this.d.pricing, i.lookupKey);
    if (!found) throw new BillingError("UNKNOWN_PRICE", "Unknown price");
    if (!found.price.offered) throw new BillingError("NOT_OFFERED", "This price is not offered");
    const owner = this.d.store.ownerContact(i.accountId);
    if (!owner || normEmail(owner.email) !== normEmail(i.ownerEmail)) {
      throw new BillingError("FORBIDDEN", "Only the workspace owner can subscribe");
    }
    const { perAccount, perIp } = CHECKOUT_LIMITS;
    if (
      !this.d.limiter(
        `billing:checkout:account:${i.accountId}`,
        perAccount.limit,
        perAccount.windowMs,
      ) ||
      !this.d.limiter(`billing:checkout:ip:${i.ip}`, perIp.limit, perIp.windowMs)
    ) {
      throw new BillingError(
        "CHECKOUT_RATE_LIMITED",
        "Too many checkout attempts; try again later",
      );
    }
    if (now.getTime() < this.pausedUntil) {
      throw new BillingError("CHECKOUT_PAUSED", "Checkout is temporarily unavailable");
    }

    return this.withLock(`account:${i.accountId}`, async () => {
      let record = this.d.store.getSubscription(i.accountId);
      if (record?.stripeSubscriptionId) {
        // Decide on Stripe's current state, not on a possibly stale local copy.
        const subscriptionId = record.stripeSubscriptionId;
        const live = await this.stripe(() => this.d.gateway.retrieveSubscription(subscriptionId));
        if (BLOCKS_NEW_CHECKOUT.has(live.status)) {
          throw new BillingError(
            "ALREADY_SUBSCRIBED",
            "A subscription exists; manage it in the billing portal",
          );
        }
      }
      let customerId = record?.stripeCustomerId ?? null;
      if (!customerId) {
        const created = await this.stripe(() =>
          this.d.gateway.createCustomer(
            { email: i.ownerEmail, name: i.ownerName, accountId: i.accountId },
            `customer:${i.accountId}`,
          ),
        );
        customerId = created.id;
        this.d.store.setCustomer(i.accountId, customerId);
        record = applyCustomer(record, i.accountId, customerId, now, this.d.pricing);
        this.d.store.saveSubscription(record);
      }
      const trialEndMs = record?.trialEndsAt ? Date.parse(record.trialEndsAt) : Number.NaN;
      const trialEnd =
        Number.isFinite(trialEndMs) && trialEndMs - now.getTime() > TRIAL_CARRY_OVER_MIN_MS
          ? Math.floor(trialEndMs / 1000)
          : null;
      const priceId = await this.stripePriceId(found.product.id, found.price, now);
      const window = Math.floor(now.getTime() / (10 * MINUTE_MS));
      const expiresAt = Math.floor(
        ((window + 1) * 10 * MINUTE_MS + CHECKOUT_SESSION_TTL_MS) / 1000,
      );
      const checkoutCustomerId = customerId;
      const session = await this.stripe(() =>
        this.d.gateway.createCheckoutSession(
          {
            customerId: checkoutCustomerId,
            priceId,
            accountId: i.accountId,
            trialEnd,
            successUrl: `${this.billingUrl}?checkout=success`,
            cancelUrl: this.billingUrl,
            allowPromotionCodes: this.d.pricing.checkout.allowPromotionCodes,
            collectTaxIds: this.d.pricing.checkout.collectTaxIds,
            expiresAt,
          },
          // A double click within the same 10-minute window gets the same session back, not a second one. A session
          // that replaces an expired one gets a new key, or Stripe would hand the expired session back.
          `checkout:${i.accountId}:${i.lookupKey}:${trialEnd ?? "now"}:${window}${i.replaces ? `:after:${i.replaces}` : ""}`,
        ),
      );
      this.log("info", "billing.checkout_started", {
        accountId: i.accountId,
        lookupKey: i.lookupKey,
      });
      return { url: session.url };
    });
  }

  /**
   * Ends an open Checkout Session (the person changed their mind about the price, or came back without paying).
   * Returns `complete` when Stripe says the session was already finished: the caller must then not start another.
   */
  async expireCheckout(sessionId: string): Promise<"open" | "complete" | "expired"> {
    const { status } = await this.stripe(() => this.d.gateway.expireCheckoutSession(sessionId));
    this.log("info", "billing.checkout_expired", { sessionId, status });
    return status;
  }

  /**
   * The Stripe price for a configured lookup key, checked against the pricing file so a customer is never sent to
   * a price whose amount, currency, interval or tax behaviour differs from the configuration. Cached 10 minutes.
   */
  private async stripePriceId(productId: string, price: PriceConfig, now: Date): Promise<string> {
    const cached = this.priceCache.get(price.lookupKey);
    if (cached && cached.until > now.getTime()) return cached.id;
    const found = (
      await this.stripe(() => this.d.gateway.listPricesByLookupKeys([price.lookupKey]))
    ).filter((p) => p.lookupKey === price.lookupKey && p.active);
    const p = found[0];
    const matches =
      found.length === 1 &&
      p !== undefined &&
      p.productId === productId &&
      p.unitAmount === price.unitAmount &&
      p.currency === price.currency &&
      p.interval === price.interval &&
      p.taxBehavior === price.taxBehavior &&
      Object.keys(p.currencyOptions).length === Object.keys(price.currencyOptions).length &&
      Object.entries(price.currencyOptions).every(
        ([cur, opt]) =>
          p.currencyOptions[cur]?.unitAmount === opt.unitAmount &&
          p.currencyOptions[cur]?.taxBehavior === opt.taxBehavior,
      );
    if (!matches || !p) {
      this.log("error", "billing.price_mismatch", {
        lookupKey: price.lookupKey,
        found: found.length,
      });
      throw new BillingError(
        "CONFIG_INVALID",
        "Stripe price does not match the pricing file; run stripe:setup",
      );
    }
    this.priceCache.set(price.lookupKey, { id: p.id, until: now.getTime() + 10 * MINUTE_MS });
    return p.id;
  }

  async createPortal(accountId: string): Promise<{ url: string }> {
    const record = this.d.store.getSubscription(accountId);
    if (!record?.stripeCustomerId)
      throw new BillingError("NO_CUSTOMER", "No billing account yet; subscribe first");
    if (!this.d.portalConfigurationId) {
      throw new BillingError("CONFIG_INVALID", "GLIDEWORTH_STRIPE_PORTAL_CONFIGURATION is not set");
    }
    const customerId = record.stripeCustomerId;
    return this.stripe(() =>
      this.d.gateway.createPortalSession({
        customerId,
        returnUrl: this.billingUrl,
        configurationId: this.d.portalConfigurationId,
      }),
    );
  }

  // --- webhook

  /**
   * The signature check of `handleWebhook` on its own: no state is read or changed and nothing is logged. The
   * host runs it before taking a per-account lock, so an unsigned request cannot hold up a workspace's real
   * billing writes. `handleWebhook` checks again (and logs the refusal).
   */
  isSignedWebhook(rawBody: string, signatureHeader: string | undefined): boolean {
    if (Buffer.byteLength(rawBody, "utf8") > WEBHOOK_MAX_BODY_BYTES) return false;
    try {
      this.d.gateway.constructEvent(
        rawBody,
        signatureHeader ?? "",
        this.d.webhookSecret,
        WEBHOOK_TOLERANCE_SECONDS,
      );
      return true;
    } catch {
      return false;
    }
  }

  async handleWebhook(
    rawBody: string,
    signatureHeader: string | undefined,
  ): Promise<WebhookOutcome> {
    if (Buffer.byteLength(rawBody, "utf8") > WEBHOOK_MAX_BODY_BYTES) {
      this.log("warn", "stripe.signature_invalid", { reason: "body_too_large" });
      return { status: 400, eventId: null, result: "bad-signature" };
    }
    let event: StripeEventView;
    try {
      event = this.d.gateway.constructEvent(
        rawBody,
        signatureHeader ?? "",
        this.d.webhookSecret,
        WEBHOOK_TOLERANCE_SECONDS,
      );
    } catch (err) {
      const reason =
        err instanceof BillingError ? String(err.details?.reason ?? err.code) : errorCodeOf(err);
      this.log("warn", "stripe.signature_invalid", { reason });
      return { status: 400, eventId: null, result: "bad-signature" };
    }
    return this.processEvent(event);
  }

  private customerOfEvent(event: StripeEventView): string | null {
    if (event.type === "customer.deleted") return event.objectId;
    return refId(event.object.customer);
  }

  private async processEvent(event: StripeEventView): Promise<WebhookOutcome> {
    const now = this.now();
    const eventCustomer = this.customerOfEvent(event);
    const guessedAccount = eventCustomer ? this.d.store.accountForCustomer(eventCustomer) : null;
    const claim = this.d.store.recordEvent({
      id: event.id,
      type: event.type,
      created: event.created,
      livemode: event.livemode,
      accountId: guessedAccount,
    });
    if (claim === "done") return { status: 200, eventId: event.id, result: "duplicate" };
    if (claim === "new" && DECLINE_EVENT_TYPES.has(event.type)) this.countDecline(now);
    if (!isHandledEventType(event.type)) {
      this.d.store.finishEvent(event.id, "ignored");
      return { status: 200, eventId: event.id, result: "ignored" };
    }
    try {
      const result = await this.dispatch(event, eventCustomer);
      this.d.store.finishEvent(event.id, result);
      if (result === "orphaned") {
        this.log("warn", "billing.event_orphaned", { eventId: event.id, type: event.type });
        await this.sendNotice(
          { kind: "orphaned-event", accountId: null, stripeObjectId: event.objectId },
          event.id,
        );
      }
      return { status: 200, eventId: event.id, result };
    } catch (err) {
      const code = errorCodeOf(err);
      this.d.store.finishEvent(event.id, "failed", code);
      this.log("error", "billing.webhook_failed", { eventId: event.id, type: event.type, code });
      return { status: 500, eventId: event.id, result: "failed" };
    }
  }

  private countDecline(now: Date): void {
    const t = now.getTime();
    const { threshold, windowMs, pauseMs } = CHECKOUT_LIMITS.breaker;
    this.declines.push(t);
    while (this.declines.length > 0 && (this.declines[0] ?? t) <= t - windowMs)
      this.declines.shift();
    if (this.declines.length > threshold && t >= this.pausedUntil) {
      this.pausedUntil = t + pauseMs;
      this.log("error", "billing.checkout_paused", {
        declines: this.declines.length,
        pausedMinutes: pauseMs / MINUTE_MS,
      });
    }
  }

  private async dispatch(
    event: StripeEventView,
    eventCustomer: string | null,
  ): Promise<ProcessResult> {
    const o = event.object;
    switch (event.type) {
      case "checkout.session.completed": {
        if (o.mode !== "subscription") return "processed";
        const subscriptionId = refId(o.subscription);
        if (!subscriptionId)
          throw new BillingError("NO_SUBSCRIPTION", "Completed session has no subscription");
        const out = await this.syncSubscription(event, subscriptionId, eventCustomer);
        if (
          out.applied &&
          out.accountId &&
          out.record &&
          ["active", "trialing"].includes(out.record.status)
        ) {
          await this.sendNotice(
            { kind: "subscription-activated", accountId: out.accountId },
            subscriptionId,
          );
        }
        return out.result;
      }
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted":
      case "customer.subscription.paused":
      case "customer.subscription.resumed":
        return (await this.syncSubscription(event, event.objectId, eventCustomer)).result;
      case "customer.subscription.trial_will_end": {
        const out = await this.syncSubscription(event, event.objectId, eventCustomer);
        const rec = out.record;
        if (
          out.applied &&
          out.accountId &&
          rec?.status === "trialing" &&
          rec.trialEndsAt &&
          !rec.cancelAtPeriodEnd
        ) {
          await this.sendNotice(
            { kind: "trial-ending", accountId: out.accountId, trialEndsAt: rec.trialEndsAt },
            `trial:${rec.trialEndsAt}`,
          );
        }
        return out.result;
      }
      case "invoice.paid":
      case "invoice.payment_failed":
      case "invoice.payment_action_required": {
        const accountId = eventCustomer ? this.d.store.accountForCustomer(eventCustomer) : null;
        const subscriptionId =
          invoiceSubscriptionId(o) ??
          (accountId ? this.d.store.getSubscription(accountId)?.stripeSubscriptionId : null);
        if (!subscriptionId) return accountId ? "processed" : "orphaned";
        const out = await this.syncSubscription(event, subscriptionId, eventCustomer);
        if (out.result !== "processed" || !out.accountId || !out.record) return out.result;
        if (event.type === "invoice.paid") {
          const amountPaid = typeof o.amount_paid === "number" ? o.amount_paid : 0;
          if (amountPaid > 0) {
            await this.sendNotice(
              {
                kind: "payment-succeeded",
                accountId: out.accountId,
                invoiceUrl: str(o.hosted_invoice_url),
              },
              event.objectId,
            );
          }
        } else {
          const access = accessFor(out.record, this.now(), this.d.pricing);
          const readOnlyFrom =
            access.level === "full" && access.changesAt
              ? access.changesAt
              : this.now().toISOString();
          this.log("info", "billing.payment_failed", {
            accountId: out.accountId,
            eventId: event.id,
          });
          await this.sendNotice(
            { kind: "payment-problem", accountId: out.accountId, readOnlyFrom },
            event.objectId,
          );
        }
        return out.result;
      }
      case "charge.refunded": {
        const accountId = eventCustomer ? this.d.store.accountForCustomer(eventCustomer) : null;
        if (!accountId) return "orphaned";
        this.log("info", "billing.refund", { accountId, chargeId: event.objectId });
        const subscriptionId = this.d.store.getSubscription(accountId)?.stripeSubscriptionId;
        if (subscriptionId)
          return (await this.syncSubscription(event, subscriptionId, eventCustomer)).result;
        return "processed";
      }
      case "charge.dispute.created":
      case "radar.early_fraud_warning.created": {
        // Disputes and warnings reference a charge, not a customer; the operator resolves the account from the
        // charge in the Dashboard (the gateway has no charge lookup).
        const kind = event.type === "charge.dispute.created" ? "dispute" : "early-fraud-warning";
        this.log("error", `billing.${kind}`, { eventId: event.id, objectId: event.objectId });
        await this.sendNotice(
          { kind, accountId: null, stripeObjectId: event.objectId },
          event.objectId,
        );
        return "processed";
      }
      case "customer.deleted": {
        const accountId = this.d.store.accountForCustomer(event.objectId);
        if (!accountId) return "orphaned";
        this.log("warn", "billing.customer_deleted", { accountId });
        const subscriptionId = this.d.store.getSubscription(accountId)?.stripeSubscriptionId;
        if (subscriptionId)
          return (await this.syncSubscription(event, subscriptionId, eventCustomer)).result;
        return "processed";
      }
      default:
        return "processed";
    }
  }

  /**
   * Re-fetches the subscription and stores Stripe's current state (design 4.3 step 3). Serialised per customer
   * in this process; across processes the monotonic `stripeUpdated` stamp (read before the fetch) rejects a slow
   * handler's older write.
   */
  private async syncSubscription(
    event: StripeEventView,
    subscriptionId: string,
    eventCustomer: string | null,
  ): Promise<SyncOutcome> {
    return this.withLock(`customer:${eventCustomer ?? subscriptionId}`, async () => {
      const store = this.d.store;
      const guessed = eventCustomer ? store.accountForCustomer(eventCustomer) : null;
      const stampFloor = guessed ? (store.getSubscription(guessed)?.stripeUpdated ?? null) : null;
      const view = await this.d.gateway.retrieveSubscription(subscriptionId);

      // Which account does the fetched subscription belong to? Metadata first, then the customer mapping
      // (design 2.5); any disagreement is treated as unknown rather than guessed.
      const byCustomer = store.accountForCustomer(view.customerId);
      const byMetadata = str(view.metadata.account_id);
      const orphan = (why: string): SyncOutcome => {
        this.log("warn", "billing.subscription_unmatched", { subscriptionId: view.id, why });
        return { result: "orphaned", accountId: null, record: null, applied: false };
      };
      if (eventCustomer && eventCustomer !== view.customerId)
        return orphan("event_customer_mismatch");
      if (byCustomer && byMetadata && byCustomer !== byMetadata)
        return orphan("metadata_customer_mismatch");
      const accountId = byMetadata ?? byCustomer;
      if (!accountId || !this.accountKnown(accountId)) return orphan("unknown_account");
      const prev = store.getSubscription(accountId);
      if (!byCustomer && prev?.stripeCustomerId && prev.stripeCustomerId !== view.customerId) {
        return orphan("account_has_other_customer");
      }

      const now = this.now();
      const floor = guessed === accountId ? stampFloor : undefined;
      let outcome = applyStripeSubscription(
        prev,
        accountId,
        view,
        event.created,
        now,
        this.d.pricing,
        floor,
      );
      if (outcome.kind === "conflict" && prev?.stripeSubscriptionId) {
        // The stored subscription looks live locally; check Stripe before calling it a duplicate.
        const stored: StripeSubscriptionView = await this.d.gateway.retrieveSubscription(
          prev.stripeSubscriptionId,
        );
        if (!LIVE_STRIPE_STATUSES.has(stored.status)) {
          const refreshed = applyStripeSubscription(
            prev,
            accountId,
            stored,
            event.created,
            now,
            this.d.pricing,
            floor,
          );
          outcome = applyStripeSubscription(
            refreshed.record,
            accountId,
            view,
            event.created,
            now,
            this.d.pricing,
          );
        }
      }
      if (outcome.kind === "conflict") {
        this.log("error", "billing.duplicate_subscription", {
          accountId,
          storedSubscriptionId: prev?.stripeSubscriptionId ?? null,
          otherSubscriptionId: view.id,
        });
        return { result: "processed", accountId, record: outcome.record, applied: false };
      }
      if (outcome.kind === "superseded")
        return { result: "processed", accountId, record: outcome.record, applied: false };

      const record = outcome.record;
      store.saveSubscription(record);
      if (prev?.status !== record.status || prev?.cancelAtPeriodEnd !== record.cancelAtPeriodEnd) {
        this.log("info", "billing.subscription_changed", {
          accountId,
          subscriptionId: view.id,
          from: prev?.status ?? null,
          to: record.status,
          cancelAtPeriodEnd: record.cancelAtPeriodEnd,
        });
      }
      if (record.status === "canceled" || record.cancelAtPeriodEnd) {
        const accessUntil =
          record.cancelAtPeriodEnd && record.currentPeriodEnd
            ? record.currentPeriodEnd
            : (record.canceledAt ?? now.toISOString());
        await this.sendNotice({ kind: "subscription-canceled", accountId, accessUntil }, view.id);
      }
      return { result: "processed", accountId, record, applied: true };
    });
  }

  // --- sweep, operator actions

  /** Every five minutes: re-run failed events (if the gateway can fetch them) and run the local trial clock. */
  async sweep(): Promise<{ retried: number; noticesSent: number }> {
    let retried = 0;
    let noticesSent = 0;
    const retrieveEvent = this.d.gateway.retrieveEvent?.bind(this.d.gateway);
    if (retrieveEvent) {
      for (const failed of this.d.store.failedEvents(SWEEP_EVENT_BATCH)) {
        if (failed.attempts >= MAX_EVENT_ATTEMPTS) continue;
        try {
          const event = await retrieveEvent(failed.id);
          await this.processEvent(event);
          retried++;
        } catch (err) {
          this.log("warn", "billing.sweep_event_fetch_failed", {
            eventId: failed.id,
            code: errorCodeOf(err),
          });
        }
      }
    }

    const now = this.now();
    const horizon = new Date(
      now.getTime() + this.d.pricing.trialEndingNoticeDays * DAY_MS,
    ).toISOString();
    for (const accountId of this.d.store.accountsWithTrialEndingBefore(horizon)) {
      const rec = this.d.store.getSubscription(accountId);
      if (rec?.status !== "trialing_local" || !rec.trialEndsAt) continue;
      const notice: BillingNotice =
        Date.parse(rec.trialEndsAt) > now.getTime()
          ? { kind: "trial-ending", accountId, trialEndsAt: rec.trialEndsAt }
          : { kind: "trial-expired", accountId };
      try {
        if (await this.sendNotice(notice, `trial:${rec.trialEndsAt}`)) noticesSent++;
      } catch (err) {
        this.log("warn", "billing.notice_failed", {
          accountId,
          kind: notice.kind,
          code: errorCodeOf(err),
        });
      }
    }
    return { retried, noticesSent };
  }

  /** Workspace deletion: cancel immediately, without proration or a final invoice. Data is not touched here. */
  async cancelNow(accountId: string): Promise<void> {
    const record = this.d.store.getSubscription(accountId);
    const subscriptionId = record?.stripeSubscriptionId;
    if (
      !record ||
      !subscriptionId ||
      record.status === "canceled" ||
      record.status === "incomplete_expired"
    )
      return;
    await this.withLock(`customer:${record.stripeCustomerId ?? subscriptionId}`, async () => {
      // The owner is deleting the workspace; no "subscription canceled" email on top of the deletion email.
      this.d.store.claimNotice(accountId, "subscription-canceled", subscriptionId);
      const stampFloor = this.d.store.getSubscription(accountId)?.stripeUpdated ?? null;
      const view = await this.stripe(() =>
        this.d.gateway.cancelSubscription(subscriptionId, { prorate: false, invoiceNow: false }),
      );
      const now = this.now();
      const prev = this.d.store.getSubscription(accountId);
      const out = applyStripeSubscription(
        prev,
        accountId,
        view,
        Math.floor(now.getTime() / 1000),
        now,
        this.d.pricing,
        stampFloor,
      );
      if (out.kind === "applied") this.d.store.saveSubscription(out.record);
      this.log("info", "billing.canceled_now", { accountId, subscriptionId });
    });
  }

  /** Operator comp: full access until `until` (ISO), or remove it with null. */
  comp(accountId: string, until: string | null): void {
    if (until !== null && Number.isNaN(Date.parse(until)))
      throw new RangeError("until must be an ISO date or null");
    const prev = this.d.store.getSubscription(accountId);
    const iso = until === null ? null : new Date(until).toISOString();
    this.d.store.saveSubscription(applyComp(prev, accountId, iso, this.now(), this.d.pricing));
    this.log("info", "billing.comp", { accountId, until: iso });
  }

  /**
   * Operator refund (design 4.5). Idempotency key `refund:<chargeId>:<amount|full>`: a repeated click refunds once;
   * an identical second partial refund of the same charge within 24 hours is deduplicated by Stripe too.
   */
  async refund(i: {
    accountId: string;
    chargeId: string;
    amount?: number;
    reason: string;
    operatorId: string;
  }): Promise<{ id: string }> {
    if (!i.reason.trim()) throw new RangeError("reason is required");
    if (i.amount !== undefined && (!Number.isInteger(i.amount) || i.amount <= 0)) {
      throw new RangeError("amount must be a positive integer in minor units");
    }
    if (!/^(ch|py)_[A-Za-z0-9_]+$/.test(i.chargeId))
      throw new RangeError("chargeId must be a Stripe charge id");
    const record = this.d.store.getSubscription(i.accountId);
    if (!record?.stripeCustomerId)
      throw new BillingError("NO_CUSTOMER", "This account has no Stripe customer");
    const refund = await this.stripe(() =>
      this.d.gateway.createRefund(
        {
          chargeId: i.chargeId,
          ...(i.amount !== undefined ? { amount: i.amount } : {}),
          reason: i.reason,
        },
        `refund:${i.chargeId}:${i.amount ?? "full"}`,
      ),
    );
    this.log("info", "billing.refund_created", {
      accountId: i.accountId,
      chargeId: i.chargeId,
      refundId: refund.id,
      operatorId: i.operatorId,
    });
    return refund;
  }
}
