import { createHash } from "node:crypto";
import type { Stripe } from "stripe";
import { BillingError } from "../errors.js";
import { constructEvent, eventViewFromObject } from "../signature.js";
import type { StripeGateway, StripePriceView, WebhookEndpointAdmin } from "../types.js";
import {
  PORTAL_METADATA_KEY,
  PORTAL_METADATA_VALUE,
  priceView,
  refundReason,
  subscriptionView,
} from "./mapping.js";

/**
 * The Stripe API version this package is written and tested against. It equals the version pinned by the
 * `stripe` 23.1.0 SDK; the compiler checks that (`Stripe.LatestApiVersion`). Webhook endpoints created by the setup
 * script use the same version so snapshot event payloads have the shape this code reads.
 */
export const STRIPE_API_VERSION = "2026-10-28.endive" satisfies Stripe.LatestApiVersion;

/** Creates the SDK client with the pinned API version. Loaded lazily so importing this package never loads `stripe`. */
export async function createStripeClient(secretKey: string): Promise<Stripe> {
  if (!/^(sk|rk)_(test|live)_[A-Za-z0-9]+$/.test(secretKey)) {
    throw new BillingError("CONFIG_INVALID", "Stripe secret key has an unexpected format");
  }
  const { Stripe: StripeClient } = await import("stripe");
  return new StripeClient(secretKey, {
    apiVersion: STRIPE_API_VERSION,
    maxNetworkRetries: 2,
    timeout: 20_000,
    appInfo: { name: "glideworth-billing" },
  });
}

function isResourceMissing(err: unknown): boolean {
  const e = err as { code?: unknown; statusCode?: unknown } | null;
  return e?.code === "resource_missing" || e?.statusCode === 404;
}

const chunk = <T>(xs: T[], n: number): T[][] =>
  Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

/** Portal configuration (design 4.1): payment method, invoices, cancel at period end, interval switch, tax id. */
export function portalConfigurationParams(p: {
  prices: Array<{ productId: string; priceIds: string[] }>;
  returnUrl: string;
}): Stripe.BillingPortal.ConfigurationCreateParams {
  const products = p.prices.filter((x) => x.priceIds.length > 0);
  return {
    business_profile: { headline: "Glideworth Cloud" },
    default_return_url: p.returnUrl,
    features: {
      customer_update: { enabled: true, allowed_updates: ["address", "name", "tax_id"] },
      invoice_history: { enabled: true },
      payment_method_update: { enabled: true },
      subscription_cancel: {
        enabled: true,
        mode: "at_period_end",
        proration_behavior: "none",
        cancellation_reason: {
          enabled: true,
          options: ["too_expensive", "missing_features", "switched_service", "unused", "other"],
        },
      },
      subscription_update:
        products.length > 0
          ? {
              enabled: true,
              default_allowed_updates: ["price"],
              products: products.map((x) => ({ product: x.productId, prices: x.priceIds })),
              // Monthly -> yearly is charged now; yearly -> monthly waits for the end of the paid year.
              proration_behavior: "always_invoice",
              schedule_at_period_end: { conditions: [{ type: "shortening_interval" }] },
              trial_update_behavior: "continue_trial",
            }
          : { enabled: false },
    },
    metadata: { [PORTAL_METADATA_KEY]: PORTAL_METADATA_VALUE },
  };
}

/** Adapts the official SDK to `StripeGateway`. Thin: no business rules here. */
export function stripeGateway(client: Stripe): StripeGateway & WebhookEndpointAdmin {
  return {
    async retrieveProduct(id) {
      try {
        const p = await client.products.retrieve(id);
        return { id: p.id, name: p.name, active: p.active };
      } catch (err) {
        if (isResourceMissing(err)) return null;
        throw err;
      }
    },

    async createProduct(p, idempotencyKey) {
      const created = await client.products.create(
        { id: p.id, name: p.name, ...(p.description ? { description: p.description } : {}) },
        { idempotencyKey },
      );
      return { id: created.id };
    },

    async listPricesByLookupKeys(keys) {
      const out: StripePriceView[] = [];
      // `lookup_keys` takes at most 10 keys; the list returns only active prices unless `active=false` is asked.
      for (const group of chunk(keys, 10)) {
        for (const active of [true, false]) {
          const page = await client.prices.list({
            lookup_keys: group,
            active,
            limit: 100,
            expand: ["data.currency_options"],
          });
          for (const raw of page.data) {
            const view = priceView(raw);
            if (view) out.push(view);
          }
        }
      }
      return out;
    },

    async createPrice({ productId, price }, idempotencyKey) {
      const currencyOptions: Record<string, Stripe.PriceCreateParams.CurrencyOptions> = {};
      for (const [cur, opt] of Object.entries(price.currencyOptions)) {
        currencyOptions[cur] = { unit_amount: opt.unitAmount, tax_behavior: opt.taxBehavior };
      }
      const created = await client.prices.create(
        {
          product: productId,
          currency: price.currency,
          unit_amount: price.unitAmount,
          recurring: { interval: price.interval },
          lookup_key: price.lookupKey,
          tax_behavior: price.taxBehavior,
          ...(Object.keys(currencyOptions).length > 0 ? { currency_options: currencyOptions } : {}),
          nickname: price.lookupKey,
        },
        { idempotencyKey },
      );
      return { id: created.id };
    },

    async setPriceActive(id, active) {
      await client.prices.update(id, { active });
    },

    async upsertPortalConfiguration(p) {
      const params = portalConfigurationParams(p);
      let id = p.existingId;
      if (!id) {
        // Find the configuration this script made earlier so a second run updates instead of creating another.
        const list = await client.billingPortal.configurations.list({ active: true, limit: 100 });
        id = list.data.find((c) => c.metadata?.[PORTAL_METADATA_KEY] === PORTAL_METADATA_VALUE)?.id;
      }
      if (id) {
        const updated = await client.billingPortal.configurations.update(id, params);
        return { id: updated.id };
      }
      const digest = createHash("sha256").update(JSON.stringify(params)).digest("hex").slice(0, 24);
      const created = await client.billingPortal.configurations.create(params, {
        idempotencyKey: `portal-configuration:${digest}`,
      });
      return { id: created.id };
    },

    async createCustomer(p, idempotencyKey) {
      const created = await client.customers.create(
        { email: p.email, name: p.name, metadata: { account_id: p.accountId } },
        { idempotencyKey },
      );
      return { id: created.id };
    },

    async createCheckoutSession(p, idempotencyKey) {
      const session = await client.checkout.sessions.create(
        {
          mode: "subscription",
          customer: p.customerId,
          client_reference_id: p.accountId,
          line_items: [{ price: p.priceId, quantity: 1 }],
          // One currency for everyone: no local-currency conversion (Adaptive Pricing showed AED in the UAE).
          currency: p.currency,
          adaptive_pricing: { enabled: false },
          subscription_data: {
            metadata: { account_id: p.accountId },
            ...(p.trialEnd !== null ? { trial_end: p.trialEnd } : {}),
          },
          metadata: { account_id: p.accountId },
          automatic_tax: { enabled: true },
          // Required with an existing customer: Stripe Tax needs the address, tax id collection needs the name.
          customer_update: { address: "auto", name: "auto" },
          tax_id_collection: { enabled: p.collectTaxIds },
          billing_address_collection: "auto",
          allow_promotion_codes: p.allowPromotionCodes,
          success_url: p.successUrl,
          cancel_url: p.cancelUrl,
          ...(p.expiresAt !== undefined ? { expires_at: p.expiresAt } : {}),
        },
        { idempotencyKey },
      );
      if (!session.url) throw new BillingError("STRIPE_UNAVAILABLE", "Checkout session has no URL");
      return { id: session.id, url: session.url };
    },

    async expireCheckoutSession(id) {
      try {
        await client.checkout.sessions.expire(id);
        return { status: "expired" };
      } catch (err) {
        // Stripe refuses to expire a session that is no longer open; report what it became instead.
        const { status } = await client.checkout.sessions.retrieve(id);
        if (status === "complete") return { status: "complete" };
        if (status === "expired") return { status: "expired" };
        throw err;
      }
    },

    async createPortalSession(p) {
      const session = await client.billingPortal.sessions.create({
        customer: p.customerId,
        return_url: p.returnUrl,
        configuration: p.configurationId,
      });
      return { url: session.url };
    },

    async retrieveSubscription(id) {
      return subscriptionView(await client.subscriptions.retrieve(id));
    },

    async cancelSubscription(id, o) {
      try {
        return subscriptionView(
          await client.subscriptions.cancel(id, { prorate: o.prorate, invoice_now: o.invoiceNow }),
        );
      } catch (err) {
        // Cancelling twice is an error in Stripe; treat an already-canceled subscription as success.
        const current = subscriptionView(await client.subscriptions.retrieve(id));
        if (current.status === "canceled" || current.status === "incomplete_expired")
          return current;
        throw err;
      }
    },

    async createRefund(p, idempotencyKey) {
      const refund = await client.refunds.create(
        {
          ...(p.chargeId ? { charge: p.chargeId } : {}),
          ...(p.paymentIntentId ? { payment_intent: p.paymentIntentId } : {}),
          ...(p.amount !== undefined ? { amount: p.amount } : {}),
          reason: refundReason(p.reason),
          metadata: { glideworth_reason: p.reason.slice(0, 500) },
        },
        { idempotencyKey },
      );
      return { id: refund.id };
    },

    constructEvent(rawBody, signatureHeader, secret, toleranceSeconds) {
      return constructEvent(rawBody, signatureHeader, secret, toleranceSeconds);
    },

    async retrieveEvent(id) {
      return eventViewFromObject(await client.events.retrieve(id));
    },

    async listWebhookEndpoints() {
      const list = await client.webhookEndpoints.list({ limit: 100 });
      return list.data.map((w) => ({
        id: w.id,
        url: w.url,
        enabledEvents: [...w.enabled_events],
        description: w.description,
        apiVersion: w.api_version,
        status: w.status,
      }));
    },

    async createWebhookEndpoint(p, idempotencyKey) {
      const created = await client.webhookEndpoints.create(
        {
          url: p.url,
          enabled_events: p.enabledEvents as Stripe.WebhookEndpointCreateParams.EnabledEvent[],
          description: p.description,
          api_version: p.apiVersion as Stripe.WebhookEndpointCreateParams.ApiVersion,
        },
        { idempotencyKey },
      );
      // The signing secret (`created.secret`) is returned to the caller, which must never print it: the setup
      // script writes it only to a file given with --webhook-secret-file. Stripe returns it on creation only
      // for new endpoints; later it can be revealed in the Dashboard (Workbench > Webhooks).
      return created.secret ? { id: created.id, secret: created.secret } : { id: created.id };
    },

    async updateWebhookEndpoint(id, p) {
      await client.webhookEndpoints.update(id, {
        enabled_events: p.enabledEvents as Stripe.WebhookEndpointUpdateParams.EnabledEvent[],
        description: p.description,
      });
    },
  };
}
