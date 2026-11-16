import type { PriceConfig } from "../pricing.js";
import { signPayload, constructEvent as verifyAndParse } from "../signature.js";
import type {
  StripeEventView,
  StripeGateway,
  StripePriceView,
  StripeSubscriptionView,
  StripeWebhookEndpointView,
  WebhookEndpointAdmin,
} from "../types.js";
import {
  PORTAL_METADATA_KEY,
  PORTAL_METADATA_VALUE,
  priceView,
  type RawPrice,
  type RawSubscription,
  refundReason,
  subscriptionView,
} from "./mapping.js";
import { portalConfigurationParams, STRIPE_API_VERSION } from "./stripe.js";

/** Shaped like the SDK's errors (`type`, `code`, `statusCode`) so error handling is exercised the same way. */
export class FakeStripeError extends Error {
  override readonly name = "FakeStripeError";
  constructor(
    readonly type: string,
    readonly code: string,
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

const missing = (what: string) =>
  new FakeStripeError("invalid_request_error", "resource_missing", 404, what);
const invalid = (what: string) =>
  new FakeStripeError("invalid_request_error", "parameter_invalid", 400, what);

interface FakeSubscription extends RawSubscription {
  object: "subscription";
  latest_invoice: string | null;
  interval: "month" | "year";
}
interface FakeSession {
  id: string;
  object: "checkout.session";
  mode: "subscription";
  customer: string;
  priceId: string;
  client_reference_id: string;
  metadata: Record<string, string>;
  trialEnd: number | null;
  status: "open" | "complete" | "expired";
  payment_status: "unpaid" | "paid" | "no_payment_required";
  subscription: string | null;
  url: string;
  params: Record<string, unknown>;
}
interface FakeInvoice {
  id: string;
  object: "invoice";
  customer: string;
  amount_due: number;
  amount_paid: number;
  status: "open" | "paid" | "void";
  hosted_invoice_url: string;
  charge: string | null;
  parent: {
    type: "subscription_details";
    subscription_details: { subscription: string; metadata: null };
  };
}
interface FakeCharge {
  id: string;
  object: "charge";
  customer: string;
  amount: number;
  amount_refunded: number;
  refunded: boolean;
  payment_intent: string;
  invoice: string;
}

const DAY = 86_400;
const periodSeconds = (interval: "month" | "year") => (interval === "year" ? 365 : 30) * DAY;
const clone = <T>(v: T): T => structuredClone(v);

/**
 * In-memory Stripe for tests (design 4.7). Implements the gateway contract (including the idempotency-key
 * semantics and the Checkout `trial_end` 48-hour rule) and offers helpers that move subscriptions through their
 * lifecycle and return the events Stripe would send. `sign()` produces a correctly signed request for any event.
 */
export class FakeStripeGateway implements StripeGateway, WebhookEndpointAdmin {
  calls: Array<{ method: string; args: unknown[] }> = [];
  /** Every event emitted, in order. */
  outbox: StripeEventView[] = [];
  readonly products = new Map<
    string,
    { id: string; name: string; description: string | null; active: boolean }
  >();
  readonly prices = new Map<string, RawPrice>();
  readonly customers = new Map<
    string,
    { id: string; email: string; name: string; metadata: Record<string, string>; deleted: boolean }
  >();
  readonly sessions = new Map<string, FakeSession>();
  readonly subscriptions = new Map<string, FakeSubscription>();
  readonly invoices = new Map<string, FakeInvoice>();
  readonly charges = new Map<string, FakeCharge>();
  readonly refunds = new Map<
    string,
    { id: string; charge: string; amount: number; reason: string; note: string }
  >();
  readonly portalConfigurations = new Map<
    string,
    { id: string; params: Record<string, unknown> }
  >();
  readonly webhookEndpoints = new Map<string, StripeWebhookEndpointView>();

  private readonly idempotency = new Map<string, { fingerprint: string; result: unknown }>();
  private readonly failures = new Map<string, unknown[]>();
  private seq = 0;
  private readonly clock: () => Date;

  constructor(o: { now?: () => Date } = {}) {
    this.clock = o.now ?? (() => new Date());
  }

  // --- test controls

  /** The next call of `method` throws `error` (default: a Stripe API connection error). */
  failNext(method: keyof StripeGateway | keyof WebhookEndpointAdmin, error?: unknown): void {
    const queue = this.failures.get(method) ?? [];
    queue.push(
      error ?? new FakeStripeError("api_connection_error", "connection_error", 0, "network down"),
    );
    this.failures.set(method, queue);
  }

  callsTo(method: string): Array<{ method: string; args: unknown[] }> {
    return this.calls.filter((c) => c.method === method);
  }

  private nowSeconds(): number {
    return Math.floor(this.clock().getTime() / 1000);
  }

  private id(prefix: string): string {
    this.seq += 1;
    return `${prefix}_fake${String(this.seq).padStart(6, "0")}`;
  }

  private enter(method: string, args: unknown[]): void {
    this.calls.push({ method, args: clone(args) });
    const queue = this.failures.get(method);
    if (queue && queue.length > 0) throw queue.shift();
  }

  private idempotent<T>(key: string, method: string, params: unknown, create: () => T): T {
    const fingerprint = JSON.stringify([method, params]);
    const prior = this.idempotency.get(key);
    if (prior) {
      if (prior.fingerprint !== fingerprint) {
        throw new FakeStripeError(
          "idempotency_error",
          "idempotency_key_in_use",
          400,
          "Keys for idempotent requests can only be used with the same parameters they were first used with.",
        );
      }
      return clone(prior.result as T);
    }
    const result = create();
    this.idempotency.set(key, { fingerprint, result: clone(result) });
    return result;
  }

  private emit<T extends { id: string }>(type: string, object: T): StripeEventView {
    const event: StripeEventView = {
      id: this.id("evt"),
      type,
      created: this.nowSeconds(),
      livemode: false,
      objectId: object.id,
      object: clone(object) as unknown as Record<string, unknown>,
    };
    this.outbox.push(event);
    return event;
  }

  /** A correctly signed webhook request for `event`, signed now with `secret` (or several secrets). */
  sign(
    event: StripeEventView,
    secret: string | string[],
    o: { timestamp?: number } = {},
  ): { body: string; header: string } {
    const body = JSON.stringify({
      id: event.id,
      object: "event",
      api_version: STRIPE_API_VERSION,
      created: event.created,
      livemode: event.livemode,
      pending_webhooks: 1,
      request: { id: null, idempotency_key: null },
      type: event.type,
      data: { object: event.object },
    });
    return { body, header: signPayload(body, secret, o.timestamp ?? this.nowSeconds()) };
  }

  /** An arbitrary event (for example a forged or unexpected one). */
  event(type: string, object: { id: string } & Record<string, unknown>): StripeEventView {
    return this.emit(type, object);
  }

  // --- StripeGateway

  async retrieveProduct(id: string) {
    this.enter("retrieveProduct", [id]);
    const p = this.products.get(id);
    return p ? { id: p.id, name: p.name, active: p.active } : null;
  }

  async createProduct(
    p: { id: string; name: string; description?: string },
    idempotencyKey: string,
  ) {
    this.enter("createProduct", [p, idempotencyKey]);
    return this.idempotent(idempotencyKey, "createProduct", p, () => {
      if (this.products.has(p.id)) {
        throw new FakeStripeError(
          "invalid_request_error",
          "resource_already_exists",
          400,
          "Product exists",
        );
      }
      this.products.set(p.id, {
        id: p.id,
        name: p.name,
        description: p.description ?? null,
        active: true,
      });
      return { id: p.id };
    });
  }

  async listPricesByLookupKeys(keys: string[]): Promise<StripePriceView[]> {
    this.enter("listPricesByLookupKeys", [keys]);
    const wanted = new Set(keys);
    return [...this.prices.values()]
      .filter((p) => p.lookup_key !== null && wanted.has(p.lookup_key))
      .map((p) => priceView(clone(p)))
      .filter((v): v is StripePriceView => v !== null);
  }

  async createPrice(p: { productId: string; price: PriceConfig }, idempotencyKey: string) {
    this.enter("createPrice", [p, idempotencyKey]);
    return this.idempotent(idempotencyKey, "createPrice", p, () => {
      if (!this.products.has(p.productId)) throw missing("No such product");
      for (const existing of this.prices.values()) {
        if (existing.lookup_key === p.price.lookupKey)
          throw invalid("A price with this lookup_key already exists");
      }
      const id = this.id("price");
      const options: NonNullable<RawPrice["currency_options"]> = {
        // Stripe echoes the primary currency inside currency_options; the mapping must drop it.
        [p.price.currency]: { unit_amount: p.price.unitAmount, tax_behavior: p.price.taxBehavior },
      };
      for (const [cur, opt] of Object.entries(p.price.currencyOptions)) {
        options[cur] = { unit_amount: opt.unitAmount, tax_behavior: opt.taxBehavior };
      }
      this.prices.set(id, {
        id,
        lookup_key: p.price.lookupKey,
        product: p.productId,
        active: true,
        unit_amount: p.price.unitAmount,
        currency: p.price.currency,
        recurring: { interval: p.price.interval },
        tax_behavior: p.price.taxBehavior,
        currency_options: options,
      });
      return { id };
    });
  }

  async setPriceActive(id: string, active: boolean) {
    this.enter("setPriceActive", [id, active]);
    const price = this.prices.get(id);
    if (!price) throw missing("No such price");
    price.active = active;
  }

  async upsertPortalConfiguration(p: {
    prices: Array<{ productId: string; priceIds: string[] }>;
    returnUrl: string;
    existingId?: string;
  }) {
    this.enter("upsertPortalConfiguration", [p]);
    const params = portalConfigurationParams(p) as unknown as Record<string, unknown>;
    let id = p.existingId;
    if (id && !this.portalConfigurations.has(id)) throw missing("No such configuration");
    if (!id) {
      id = [...this.portalConfigurations.values()].find(
        (c) =>
          (c.params.metadata as Record<string, string>)[PORTAL_METADATA_KEY] ===
          PORTAL_METADATA_VALUE,
      )?.id;
    }
    if (!id) id = this.id("bpc");
    this.portalConfigurations.set(id, { id, params });
    return { id };
  }

  async createCustomer(
    p: { email: string; name: string; accountId: string },
    idempotencyKey: string,
  ) {
    this.enter("createCustomer", [p, idempotencyKey]);
    return this.idempotent(idempotencyKey, "createCustomer", p, () => {
      const id = this.id("cus");
      this.customers.set(id, {
        id,
        email: p.email,
        name: p.name,
        metadata: { account_id: p.accountId },
        deleted: false,
      });
      return { id };
    });
  }

  async createCheckoutSession(
    p: {
      customerId: string;
      priceId: string;
      accountId: string;
      trialEnd: number | null;
      successUrl: string;
      cancelUrl: string;
      allowPromotionCodes: boolean;
      collectTaxIds: boolean;
    },
    idempotencyKey: string,
  ) {
    this.enter("createCheckoutSession", [p, idempotencyKey]);
    return this.idempotent(idempotencyKey, "createCheckoutSession", p, () => {
      const customer = this.customers.get(p.customerId);
      if (!customer || customer.deleted) throw missing("No such customer");
      const price = this.prices.get(p.priceId);
      if (!price?.active) throw invalid("Price is not active");
      // docs.stripe.com/api/checkout/sessions/create: subscription_data.trial_end "Has to be at least 48 hours in
      // the future."
      if (p.trialEnd !== null && p.trialEnd < this.nowSeconds() + 48 * 3600) {
        throw invalid("subscription_data[trial_end] must be at least 48 hours in the future");
      }
      const id = this.id("cs_test");
      this.sessions.set(id, {
        id,
        object: "checkout.session",
        mode: "subscription",
        customer: p.customerId,
        priceId: p.priceId,
        client_reference_id: p.accountId,
        metadata: { account_id: p.accountId },
        trialEnd: p.trialEnd,
        status: "open",
        payment_status: "unpaid",
        subscription: null,
        url: `https://checkout.stripe.test/c/pay/${id}`,
        params: clone(p) as unknown as Record<string, unknown>,
      });
      return { id, url: `https://checkout.stripe.test/c/pay/${id}` };
    });
  }

  async createPortalSession(p: { customerId: string; returnUrl: string; configurationId: string }) {
    this.enter("createPortalSession", [p]);
    if (!this.customers.has(p.customerId)) throw missing("No such customer");
    if (!this.portalConfigurations.has(p.configurationId)) throw missing("No such configuration");
    return { url: `https://billing.stripe.test/p/session/${this.id("bps")}` };
  }

  async retrieveSubscription(id: string): Promise<StripeSubscriptionView> {
    this.enter("retrieveSubscription", [id]);
    const sub = this.subscriptions.get(id);
    if (!sub) throw missing("No such subscription");
    return subscriptionView(clone(sub));
  }

  async cancelSubscription(id: string, o: { prorate: boolean; invoiceNow: boolean }) {
    this.enter("cancelSubscription", [id, o]);
    const sub = this.subscriptions.get(id);
    if (!sub) throw missing("No such subscription");
    if (sub.status !== "canceled" && sub.status !== "incomplete_expired") {
      sub.status = "canceled";
      sub.canceled_at = this.nowSeconds();
      sub.cancel_at_period_end = false;
      this.emit("customer.subscription.deleted", sub);
    }
    return subscriptionView(clone(sub));
  }

  async createRefund(
    p: { chargeId?: string; paymentIntentId?: string; amount?: number; reason: string },
    idempotencyKey: string,
  ) {
    this.enter("createRefund", [p, idempotencyKey]);
    return this.idempotent(idempotencyKey, "createRefund", p, () => {
      const charge = p.chargeId
        ? this.charges.get(p.chargeId)
        : [...this.charges.values()].find((c) => c.payment_intent === p.paymentIntentId);
      if (!charge) throw missing("No such charge");
      const remaining = charge.amount - charge.amount_refunded;
      const amount = p.amount ?? remaining;
      if (amount <= 0 || amount > remaining)
        throw invalid("Refund amount exceeds the remaining charge amount");
      const id = this.id("re");
      charge.amount_refunded += amount;
      charge.refunded = charge.amount_refunded === charge.amount;
      this.refunds.set(id, {
        id,
        charge: charge.id,
        amount,
        reason: refundReason(p.reason),
        note: p.reason,
      });
      this.emit("charge.refunded", charge as unknown as { id: string } & Record<string, unknown>);
      return { id };
    });
  }

  constructEvent(
    rawBody: string,
    signatureHeader: string,
    secret: string,
    toleranceSeconds: number,
  ) {
    this.calls.push({ method: "constructEvent", args: [] });
    return verifyAndParse(rawBody, signatureHeader, secret, toleranceSeconds, this.nowSeconds());
  }

  async retrieveEvent(id: string): Promise<StripeEventView> {
    this.enter("retrieveEvent", [id]);
    const event = this.outbox.find((e) => e.id === id);
    if (!event) throw missing("No such event");
    return clone(event);
  }

  // --- WebhookEndpointAdmin

  async listWebhookEndpoints() {
    this.enter("listWebhookEndpoints", []);
    return [...this.webhookEndpoints.values()].map(clone);
  }

  async createWebhookEndpoint(
    p: { url: string; enabledEvents: string[]; description: string; apiVersion: string },
    idempotencyKey: string,
  ) {
    this.enter("createWebhookEndpoint", [p, idempotencyKey]);
    return this.idempotent(idempotencyKey, "createWebhookEndpoint", p, () => {
      const id = this.id("we");
      this.webhookEndpoints.set(id, {
        id,
        url: p.url,
        enabledEvents: [...p.enabledEvents],
        description: p.description,
        apiVersion: p.apiVersion,
        status: "enabled",
      });
      return { id, secret: `whsec_fake_${id}` };
    });
  }

  async updateWebhookEndpoint(id: string, p: { enabledEvents: string[]; description: string }) {
    this.enter("updateWebhookEndpoint", [id, p]);
    const endpoint = this.webhookEndpoints.get(id);
    if (!endpoint) throw missing("No such webhook endpoint");
    endpoint.enabledEvents = [...p.enabledEvents];
    endpoint.description = p.description;
  }

  // --- lifecycle helpers (each returns the events Stripe would send, in the order it would send them)

  private sub(id: string): FakeSubscription {
    const sub = this.subscriptions.get(id);
    if (!sub) throw missing("No such subscription");
    return sub;
  }

  private priceOf(sub: FakeSubscription): RawPrice {
    const priceId = sub.items.data[0]?.price.id;
    const price = priceId ? this.prices.get(priceId) : undefined;
    if (!price) throw missing("No such price");
    return price;
  }

  private setPeriodEnd(sub: FakeSubscription, end: number): void {
    for (const item of sub.items.data) item.current_period_end = end;
  }

  private periodEnd(sub: FakeSubscription): number {
    return sub.items.data[0]?.current_period_end ?? this.nowSeconds();
  }

  private invoice(sub: FakeSubscription, amount: number, paid: boolean): FakeInvoice {
    const id = this.id("in");
    let chargeId: string | null = null;
    if (paid && amount > 0) {
      chargeId = this.id("ch");
      this.charges.set(chargeId, {
        id: chargeId,
        object: "charge",
        customer: refOf(sub.customer),
        amount,
        amount_refunded: 0,
        refunded: false,
        payment_intent: this.id("pi"),
        invoice: id,
      });
    }
    const invoice: FakeInvoice = {
      id,
      object: "invoice",
      customer: refOf(sub.customer),
      amount_due: amount,
      amount_paid: paid ? amount : 0,
      status: paid ? "paid" : "open",
      hosted_invoice_url: `https://invoice.stripe.test/i/${id}`,
      charge: chargeId,
      parent: {
        type: "subscription_details",
        subscription_details: { subscription: sub.id, metadata: null },
      },
    };
    this.invoices.set(id, invoice);
    sub.latest_invoice = id;
    return invoice;
  }

  private asObject<T extends { id: string }>(v: T): { id: string } & Record<string, unknown> {
    return v as unknown as { id: string } & Record<string, unknown>;
  }

  /**
   * Completes an open Checkout Session as if the customer paid (or started the carried-over trial).
   * Emits `customer.subscription.created`, `invoice.paid`, `checkout.session.completed`.
   */
  completeCheckout(sessionId: string, o: { trialEnd?: number } = {}): StripeEventView[] {
    const session = this.sessions.get(sessionId);
    if (!session) throw missing("No such checkout session");
    if (session.status !== "open") throw invalid("Checkout session is not open");
    const price = this.prices.get(session.priceId);
    if (!price?.lookup_key) throw missing("No such price");
    const interval = price.recurring?.interval === "year" ? "year" : "month";
    const now = this.nowSeconds();
    const trialEnd = o.trialEnd ?? session.trialEnd;
    const id = this.id("sub");
    const sub: FakeSubscription = {
      id,
      object: "subscription",
      customer: session.customer,
      status: trialEnd !== null ? "trialing" : "active",
      cancel_at_period_end: false,
      cancel_at: null,
      canceled_at: null,
      trial_end: trialEnd,
      metadata: { account_id: session.client_reference_id },
      items: {
        data: [
          {
            current_period_end: trialEnd ?? now + periodSeconds(interval),
            price: { id: price.id, lookup_key: price.lookup_key, product: price.product },
          },
        ],
      },
      latest_invoice: null,
      interval,
    };
    this.subscriptions.set(id, sub);
    const invoice = this.invoice(sub, trialEnd !== null ? 0 : (price.unit_amount ?? 0), true);
    session.status = "complete";
    session.subscription = id;
    session.payment_status = trialEnd !== null ? "no_payment_required" : "paid";
    const { params: _params, priceId: _priceId, trialEnd: _trialEnd, ...sessionObject } = session;
    return [
      this.emit("customer.subscription.created", sub),
      this.emit("invoice.paid", this.asObject(invoice)),
      this.emit("checkout.session.completed", this.asObject(sessionObject)),
    ];
  }

  /** A renewal (or trial-end) charge that fails: period advances, invoice stays open, status `past_due`. */
  failNextInvoice(subscriptionId: string): StripeEventView[] {
    const sub = this.sub(subscriptionId);
    const price = this.priceOf(sub);
    const invoice = this.invoice(sub, price.unit_amount ?? 0, false);
    this.setPeriodEnd(sub, this.periodEnd(sub) + periodSeconds(sub.interval));
    sub.status = "past_due";
    return [
      this.emit("invoice.payment_failed", this.asObject(invoice)),
      this.emit("customer.subscription.updated", sub),
    ];
  }

  /** A renewal that needs 3-D Secure: invoice open, status `past_due` until the customer authenticates. */
  requireAction(subscriptionId: string): StripeEventView[] {
    const sub = this.sub(subscriptionId);
    const price = this.priceOf(sub);
    const invoice = this.invoice(sub, price.unit_amount ?? 0, false);
    this.setPeriodEnd(sub, this.periodEnd(sub) + periodSeconds(sub.interval));
    sub.status = "past_due";
    return [
      this.emit("invoice.payment_action_required", this.asObject(invoice)),
      this.emit("customer.subscription.updated", sub),
    ];
  }

  /** Pays the latest open invoice (card updated, retry succeeded): status back to `active`. */
  payLatestInvoice(subscriptionId: string): StripeEventView[] {
    const sub = this.sub(subscriptionId);
    const open = sub.latest_invoice ? this.invoices.get(sub.latest_invoice) : undefined;
    if (open?.status !== "open") throw invalid("No open invoice");
    open.status = "paid";
    open.amount_paid = open.amount_due;
    const chargeId = this.id("ch");
    this.charges.set(chargeId, {
      id: chargeId,
      object: "charge",
      customer: refOf(sub.customer),
      amount: open.amount_due,
      amount_refunded: 0,
      refunded: false,
      payment_intent: this.id("pi"),
      invoice: open.id,
    });
    open.charge = chargeId;
    sub.status = "active";
    return [
      this.emit("invoice.paid", this.asObject(open)),
      this.emit("customer.subscription.updated", sub),
    ];
  }

  /** A successful renewal (or trial conversion): new period, paid invoice, status `active`. */
  renew(subscriptionId: string): StripeEventView[] {
    const sub = this.sub(subscriptionId);
    const price = this.priceOf(sub);
    const invoice = this.invoice(sub, price.unit_amount ?? 0, true);
    this.setPeriodEnd(sub, this.periodEnd(sub) + periodSeconds(sub.interval));
    sub.status = "active";
    return [
      this.emit("invoice.paid", this.asObject(invoice)),
      this.emit("customer.subscription.updated", sub),
    ];
  }

  /** Smart Retries exhausted: the Dashboard setting decides `unpaid` or `canceled`. */
  exhaustRetries(
    subscriptionId: string,
    outcome: "unpaid" | "canceled" = "canceled",
  ): StripeEventView[] {
    const sub = this.sub(subscriptionId);
    sub.status = outcome;
    if (outcome === "canceled") {
      sub.canceled_at = this.nowSeconds();
      return [this.emit("customer.subscription.deleted", sub)];
    }
    return [this.emit("customer.subscription.updated", sub)];
  }

  /** Patches the subscription and emits `customer.subscription.updated` (`deleted` when it becomes `canceled`). */
  setSubscription(id: string, patch: Partial<StripeSubscriptionView>): StripeEventView {
    const sub = this.sub(id);
    if (patch.status !== undefined) sub.status = patch.status;
    if (patch.cancelAtPeriodEnd !== undefined) sub.cancel_at_period_end = patch.cancelAtPeriodEnd;
    if (patch.currentPeriodEnd !== undefined && patch.currentPeriodEnd !== null) {
      this.setPeriodEnd(sub, patch.currentPeriodEnd);
    }
    if (patch.canceledAt !== undefined) sub.canceled_at = patch.canceledAt;
    if (patch.trialEnd !== undefined) sub.trial_end = patch.trialEnd;
    if (patch.metadata !== undefined) sub.metadata = { ...patch.metadata };
    if (patch.customerId !== undefined) sub.customer = patch.customerId;
    if (patch.priceLookupKey !== undefined && patch.priceLookupKey !== null) {
      const price = [...this.prices.values()].find((p) => p.lookup_key === patch.priceLookupKey);
      if (!price) throw missing("No such price");
      for (const item of sub.items.data)
        item.price = { id: price.id, lookup_key: price.lookup_key, product: price.product };
      sub.interval = price.recurring?.interval === "year" ? "year" : "month";
    }
    if (sub.status === "canceled" && sub.canceled_at === null) sub.canceled_at = this.nowSeconds();
    return this.emit(
      sub.status === "canceled" ? "customer.subscription.deleted" : "customer.subscription.updated",
      sub,
    );
  }

  /** Cancel in the portal: `cancel_at_period_end=true`. */
  cancelAtPeriodEnd(id: string): StripeEventView[] {
    const sub = this.sub(id);
    sub.canceled_at = this.nowSeconds();
    return [this.setSubscription(id, { cancelAtPeriodEnd: true })];
  }

  /** The period of a subscription set to cancel at period end ends: status `canceled`. */
  endPeriod(id: string): StripeEventView[] {
    const sub = this.sub(id);
    if (!sub.cancel_at_period_end) return this.renew(id);
    sub.status = "canceled";
    return [this.emit("customer.subscription.deleted", sub)];
  }

  trialWillEnd(id: string): StripeEventView[] {
    return [this.emit("customer.subscription.trial_will_end", this.sub(id))];
  }

  pause(id: string): StripeEventView[] {
    const sub = this.sub(id);
    sub.status = "paused";
    return [this.emit("customer.subscription.paused", sub)];
  }

  resume(id: string): StripeEventView[] {
    const sub = this.sub(id);
    sub.status = "active";
    return [this.emit("customer.subscription.resumed", sub)];
  }

  latestChargeOf(subscriptionId: string): string {
    const sub = this.sub(subscriptionId);
    const charge = [...this.charges.values()].findLast(
      (c) => this.invoices.get(c.invoice)?.parent.subscription_details.subscription === sub.id,
    );
    if (!charge) throw missing("No charge");
    return charge.id;
  }

  dispute(chargeId: string): StripeEventView[] {
    const charge = this.charges.get(chargeId);
    if (!charge) throw missing("No such charge");
    return [
      this.emit("charge.dispute.created", {
        id: this.id("dp"),
        object: "dispute",
        charge: charge.id,
        payment_intent: charge.payment_intent,
        amount: charge.amount,
        reason: "fraudulent",
        status: "needs_response",
      }),
    ];
  }

  earlyFraudWarning(chargeId: string): StripeEventView[] {
    const charge = this.charges.get(chargeId);
    if (!charge) throw missing("No such charge");
    return [
      this.emit("radar.early_fraud_warning.created", {
        id: this.id("issfr"),
        object: "radar.early_fraud_warning",
        charge: charge.id,
        payment_intent: charge.payment_intent,
        fraud_type: "made_with_stolen_card",
        actionable: true,
      }),
    ];
  }

  /** Customer deleted in the Dashboard: its subscriptions are canceled, then `customer.deleted`. */
  deleteCustomer(customerId: string): StripeEventView[] {
    const customer = this.customers.get(customerId);
    if (!customer) throw missing("No such customer");
    const events: StripeEventView[] = [];
    for (const sub of this.subscriptions.values()) {
      if (refOf(sub.customer) === customerId && sub.status !== "canceled") {
        sub.status = "canceled";
        sub.canceled_at = this.nowSeconds();
        events.push(this.emit("customer.subscription.deleted", sub));
      }
    }
    customer.deleted = true;
    events.push(
      this.emit("customer.deleted", { id: customerId, object: "customer", deleted: true }),
    );
    return events;
  }
}

function refOf(r: string | { id: string }): string {
  return typeof r === "string" ? r : r.id;
}
