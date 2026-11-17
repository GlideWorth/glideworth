import { describe, expect, it } from "vitest";
import { BillingError, type BillingErrorCode } from "../src/errors.js";
import { checkoutSessionParams } from "../src/gateway/stripe.js";
import { CHECKOUT_LIMITS } from "../src/service.js";
import { DAY, HOUR, harness, OWNER } from "./helpers.js";

async function code(p: Promise<unknown>): Promise<BillingErrorCode> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(BillingError);
    return (err as BillingError).code;
  }
  throw new Error("expected a BillingError");
}

const input = (accountId: string, patch: Record<string, unknown> = {}) => ({
  accountId,
  ownerEmail: OWNER(accountId).email,
  ownerName: OWNER(accountId).name,
  lookupKey: "cloud_monthly_v1",
  ip: "198.51.100.7",
  ...patch,
});

describe("checkout guards (design 4.2, 4.6)", () => {
  it("creates the customer once and a subscription-mode session with the configured options", async () => {
    const h = await harness();
    h.service.openAccount("tacct1", false);
    const { url } = await h.service.createCheckout(input("tacct1"));
    expect(url).toMatch(/^https:\/\/checkout\.stripe\.test\//);
    const [customerCall] = h.fake.callsTo("createCustomer");
    expect(customerCall?.args).toEqual([
      { email: OWNER("tacct1").email, name: OWNER("tacct1").name, accountId: "tacct1" },
      "customer:tacct1",
    ]);
    const session = [...h.fake.sessions.values()][0];
    expect(session?.params).toMatchObject({
      accountId: "tacct1",
      trialPeriodDays: null,
      successUrl: "https://app.glideworth.test/settings/billing?checkout=success",
      cancelUrl: "https://app.glideworth.test/settings/billing",
      allowPromotionCodes: false,
      collectTaxIds: true,
      currency: "usd",
    });
    expect(session?.priceId).toBe(
      [...h.fake.prices.values()].find((p) => p.lookup_key === "cloud_monthly_v1")?.id,
    );
    const record = h.store.getSubscription("tacct1");
    expect(record?.stripeCustomerId).toBe(session?.customer);
    expect(h.store.accountForCustomer(session?.customer ?? "")).toBe("tacct1");

    h.clock.advance(11 * 60_000);
    await h.service.createCheckout(input("tacct1", { lookupKey: "cloud_yearly_v1" }));
    expect(h.fake.callsTo("createCustomer")).toHaveLength(1);
    expect(h.fake.customers.size).toBe(1);
  });

  it("a double click returns the same session (idempotency key per 10-minute window)", async () => {
    const h = await harness();
    const a = await h.service.createCheckout(input("tacct1"));
    const b = await h.service.createCheckout(input("tacct1"));
    expect(b.url).toBe(a.url);
    expect(h.fake.sessions.size).toBe(1);
  });

  it("refuses unknown and non-offered lookup keys", async () => {
    const h = await harness();
    expect(
      await code(h.service.createCheckout(input("tacct1", { lookupKey: "cloud_weekly_v1" }))),
    ).toBe("UNKNOWN_PRICE");
    const yearly = h.cfg.products[0]?.prices.find((p) => p.lookupKey === "cloud_yearly_v1");
    if (!yearly) throw new Error("fixture");
    yearly.offered = false;
    expect(
      await code(h.service.createCheckout(input("tacct1", { lookupKey: "cloud_yearly_v1" }))),
    ).toBe("NOT_OFFERED");
    expect(h.fake.callsTo("createCheckoutSession")).toHaveLength(0);
  });

  it("refuses non-owners and unverified users", async () => {
    const h = await harness();
    expect(
      await code(h.service.createCheckout(input("tacct1", { ownerEmail: "editor@example.test" }))),
    ).toBe("FORBIDDEN");
    expect(await code(h.service.createCheckout(input("tunknown")))).toBe("FORBIDDEN");
    const editor = { userId: "u_2", role: "editor", emailVerified: true };
    expect(await code(h.service.createCheckout(input("tacct1", { actor: editor })))).toBe(
      "FORBIDDEN",
    );
    const unverified = { userId: "u_1", role: "owner", emailVerified: false };
    expect(await code(h.service.createCheckout(input("tacct1", { actor: unverified })))).toBe(
      "FORBIDDEN",
    );
    const owner = { userId: "u_1", role: "owner", emailVerified: true };
    await expect(
      h.service.createCheckout(input("tacct1", { actor: owner })),
    ).resolves.toHaveProperty("url");
    // Email comparison ignores case and surrounding space.
    const upper = ` ${OWNER("tacct1").email.toUpperCase()} `;
    await expect(
      h.service.createCheckout(input("tacct1", { ownerEmail: upper })),
    ).resolves.toHaveProperty("url");
    expect(h.fake.callsTo("createCustomer")).toHaveLength(1);
  });

  it("rate limits per account (5 per hour) and per IP (10 per hour)", async () => {
    const accounts = Array.from({ length: 12 }, (_, i) => `tacct${i + 1}`);
    const h = await harness({ accounts });
    for (let i = 0; i < CHECKOUT_LIMITS.perAccount.limit; i++) {
      await h.service.createCheckout(input("tacct1", { ip: `192.0.2.${i}` }));
    }
    expect(await code(h.service.createCheckout(input("tacct1", { ip: "192.0.2.99" })))).toBe(
      "CHECKOUT_RATE_LIMITED",
    );
    h.clock.advance(HOUR);
    await expect(
      h.service.createCheckout(input("tacct1", { ip: "192.0.2.98" })),
    ).resolves.toHaveProperty("url");

    const ip = "203.0.113.50";
    for (let i = 2; i < 2 + CHECKOUT_LIMITS.perIp.limit; i++)
      await h.service.createCheckout(input(`tacct${i}`, { ip }));
    expect(await code(h.service.createCheckout(input("tacct12", { ip })))).toBe(
      "CHECKOUT_RATE_LIMITED",
    );
  });

  it("circuit breaker: more than 20 payment failures in 10 minutes pause checkout for 30 minutes", async () => {
    const h = await harness();
    const failure = (i: number) =>
      h.fake.event("invoice.payment_failed", {
        id: `in_card_test_${i}`,
        object: "invoice",
        customer: `cus_card_test_${i}`,
      });
    for (let i = 0; i < CHECKOUT_LIMITS.breaker.threshold; i++) await h.deliver(failure(i));
    await expect(h.service.createCheckout(input("tacct1"))).resolves.toHaveProperty("url");
    // Redeliveries of the same events do not count again.
    await h.deliver(h.fake.outbox[0]!);
    await expect(h.service.createCheckout(input("tacct2"))).resolves.toHaveProperty("url");
    await h.deliver(failure(99));
    expect(await code(h.service.createCheckout(input("tacct2")))).toBe("CHECKOUT_PAUSED");
    expect(h.logs.some((l) => l.event === "billing.checkout_paused" && l.level === "error")).toBe(
      true,
    );
    h.clock.advance(30 * 60_000 - 1);
    expect(await code(h.service.createCheckout(input("tacct2")))).toBe("CHECKOUT_PAUSED");
    h.clock.advance(1);
    await expect(h.service.createCheckout(input("tacct2"))).resolves.toHaveProperty("url");
  });

  it("failures spread over more than 10 minutes do not trip the breaker", async () => {
    const h = await harness();
    for (let i = 0; i < 40; i++) {
      await h.deliver(
        h.fake.event("invoice.payment_failed", {
          id: `in_${i}`,
          object: "invoice",
          customer: `cus_${i}`,
        }),
      );
      h.clock.advance(60_000);
    }
    await expect(h.service.createCheckout(input("tacct1"))).resolves.toHaveProperty("url");
  });

  it("refuses ALREADY_SUBSCRIBED while Stripe says the subscription is live; allows after it ended", async () => {
    const h = await harness();
    const { subscriptionId, events } = await h.subscribe("tacct1");
    await h.deliverAll(events);
    h.clock.advance(HOUR);
    expect(await code(h.service.createCheckout(input("tacct1")))).toBe("ALREADY_SUBSCRIBED");
    for (const status of ["past_due", "unpaid", "paused", "trialing"] as const) {
      h.fake.setSubscription(subscriptionId, { status });
      expect(await code(h.service.createCheckout(input("tacct1")))).toBe("ALREADY_SUBSCRIBED");
    }
    h.clock.advance(HOUR); // stay under the per-account rate limit
    // Stripe already canceled it, the webhook has not arrived yet: the re-fetch lets the owner subscribe again.
    h.fake.setSubscription(subscriptionId, { status: "canceled" });
    expect(h.store.getSubscription("tacct1")?.status).toBe("active");
    await expect(h.service.createCheckout(input("tacct1"))).resolves.toHaveProperty("url");
    h.fake.setSubscription(subscriptionId, { status: "incomplete_expired" });
    h.clock.advance(HOUR);
    await expect(h.service.createCheckout(input("tacct1"))).resolves.toHaveProperty("url");
  });

  it("the first Checkout of a workspace with a trial available asks Stripe for a 7-day trial", async () => {
    const h = await harness();
    h.service.openAccount("tacct1", true);
    expect(h.service.status("tacct1").trialDays).toBe(7);
    await h.service.createCheckout(input("tacct1"));
    expect([...h.fake.sessions.values()].at(-1)?.params).toMatchObject({ trialPeriodDays: 7 });
  });

  it("no trial when the address already had one: Checkout charges at once", async () => {
    const h = await harness();
    h.service.openAccount("tacct1", false);
    expect(h.service.status("tacct1").trialDays).toBeNull();
    await h.service.createCheckout(input("tacct1"));
    expect([...h.fake.sessions.values()].at(-1)?.params).toMatchObject({ trialPeriodDays: null });
  });

  it("an abandoned Checkout keeps the trial; a cancelled trial is never offered again (resubscribing pays at once)", async () => {
    const h = await harness();
    h.service.openAccount("tacct1", true);
    await h.service.createCheckout(input("tacct1"));
    h.clock.advance(HOUR);
    expect(h.service.status("tacct1").trialDays).toBe(7);
    const { subscriptionId, events } = await h.subscribe("tacct1");
    await h.deliverAll(events);
    expect(h.store.getSubscription("tacct1")).toMatchObject({
      status: "trialing",
      trialAvailable: false,
    });
    // Cancelled in the portal during the trial: access to the trial end, then read-only, never charged.
    await h.deliverAll(h.fake.cancelAtPeriodEnd(subscriptionId));
    expect(h.service.status("tacct1").access).toMatchObject({ level: "full", reason: "trial" });
    h.clock.advance(7 * DAY);
    expect(h.service.status("tacct1").access).toMatchObject({
      level: "read_only",
      reason: "canceled",
    });
    await h.deliverAll(h.fake.endPeriod(subscriptionId));
    expect(h.store.getSubscription("tacct1")?.status).toBe("canceled");
    expect([...h.fake.charges.values()]).toHaveLength(0);
    expect(h.service.status("tacct1").trialDays).toBeNull();
    h.clock.advance(HOUR);
    await h.service.createCheckout(input("tacct1"));
    expect([...h.fake.sessions.values()].at(-1)?.params).toMatchObject({ trialPeriodDays: null });
  });

  it("a trial subscriber is charged at the trial end (day 8), not at checkout", async () => {
    const h = await harness();
    h.service.openAccount("tacct1", true);
    const { subscriptionId, events } = await h.subscribe("tacct1");
    await h.deliverAll(events);
    const rec = h.store.getSubscription("tacct1");
    expect(rec?.status).toBe("trialing");
    expect(rec?.trialEndsAt).toBe(
      new Date(Math.floor(h.clock.t / 1000) * 1000 + 7 * DAY).toISOString(),
    );
    expect(h.service.status("tacct1").access).toMatchObject({ level: "full", reason: "trial" });
    expect([...h.fake.charges.values()]).toHaveLength(0);
    expect(h.notices.find((n) => n.kind === "payment-succeeded")).toBeUndefined();
    h.clock.advance(7 * DAY);
    await h.deliverAll(h.fake.renew(subscriptionId));
    expect([...h.fake.charges.values()].map((c) => c.amount)).toEqual([900]);
    expect(h.service.status("tacct1").access).toMatchObject({ level: "full", reason: "active" });
  });

  it("refuses when the Stripe price differs from the pricing file (never charge an unexpected amount)", async () => {
    const h = await harness();
    const stripePrice = [...h.fake.prices.values()].find(
      (p) => p.lookup_key === "cloud_monthly_v1",
    );
    if (!stripePrice) throw new Error("fixture");
    stripePrice.unit_amount = 1900;
    expect(await code(h.service.createCheckout(input("tacct1")))).toBe("CONFIG_INVALID");
    expect(h.fake.callsTo("createCheckoutSession")).toHaveLength(0);
    stripePrice.unit_amount = 900;
    stripePrice.active = false;
    expect(await code(h.service.createCheckout(input("tacct1")))).toBe("CONFIG_INVALID");
  });

  it("maps Stripe outages to STRIPE_UNAVAILABLE without leaking the message", async () => {
    const h = await harness();
    h.fake.failNext("createCustomer");
    try {
      await h.service.createCheckout(input("tacct1"));
      throw new Error("expected failure");
    } catch (err) {
      expect((err as BillingError).code).toBe("STRIPE_UNAVAILABLE");
      expect((err as BillingError).details).toEqual({ code: "connection_error" });
    }
    // Retrying works and does not create a second customer.
    await h.service.createCheckout(input("tacct1"));
    expect(h.fake.customers.size).toBe(1);
  });
});

describe("Stripe Checkout parameters", () => {
  const base = {
    customerId: "cus_1",
    priceId: "price_1",
    accountId: "tacct1",
    successUrl: "https://app.test/settings/billing?checkout=success",
    cancelUrl: "https://app.test/settings/billing",
    allowPromotionCodes: false,
    collectTaxIds: true,
    expiresAt: 1_800_000_000,
    currency: "usd",
  };

  it("a trial: card always collected, 7 trial days, cancelled if the card is missing at the end", () => {
    const p = checkoutSessionParams({ ...base, trialPeriodDays: 7 });
    expect(p).toMatchObject({
      mode: "subscription",
      currency: "usd",
      adaptive_pricing: { enabled: false },
      payment_method_collection: "always",
      subscription_data: {
        metadata: { account_id: "tacct1" },
        trial_period_days: 7,
        trial_settings: { end_behavior: { missing_payment_method: "cancel" } },
      },
      automatic_tax: { enabled: true },
      expires_at: 1_800_000_000,
    });
  });

  it("no trial: charged at once, no trial settings", () => {
    const p = checkoutSessionParams({ ...base, trialPeriodDays: null });
    expect(p.payment_method_collection).toBe("always");
    expect(p.subscription_data).toEqual({ metadata: { account_id: "tacct1" } });
  });
});

describe("portal", () => {
  it("NO_CUSTOMER before the first checkout, then a session with the configured portal", async () => {
    const h = await harness();
    h.service.openAccount("tacct1", true);
    expect(await code(h.service.createPortal("tacct1"))).toBe("NO_CUSTOMER");
    await h.service.createCheckout(input("tacct1"));
    const { url } = await h.service.createPortal("tacct1");
    expect(url).toMatch(/^https:\/\/billing\.stripe\.test\//);
    expect(h.fake.callsTo("createPortalSession")[0]?.args[0]).toMatchObject({
      returnUrl: "https://app.glideworth.test/settings/billing",
      configurationId: h.portalConfigurationId,
    });
  });

  it("the portal configuration offers interval switching among offered prices and cancel at period end", async () => {
    const h = await harness();
    const config = h.fake.portalConfigurations.get(h.portalConfigurationId)?.params as {
      features: Record<string, Record<string, unknown>>;
    };
    expect(config.features.subscription_cancel).toMatchObject({
      enabled: true,
      mode: "at_period_end",
    });
    expect(config.features.payment_method_update).toEqual({ enabled: true });
    expect(config.features.invoice_history).toEqual({ enabled: true });
    expect(config.features.customer_update?.allowed_updates).toContain("tax_id");
    const products = config.features.subscription_update?.products as Array<{
      product: string;
      prices: string[];
    }>;
    expect(products).toHaveLength(1);
    expect(products[0]?.product).toBe("gw_cloud");
    expect(products[0]?.prices).toHaveLength(2);
  });
});

describe("constructor validation", () => {
  it("requires a webhook secret and an https public URL", async () => {
    const h = await harness();
    const { BillingService } = await import("../src/service.js");
    const base = {
      gateway: h.fake,
      store: h.store,
      pricing: h.cfg,
      publicUrl: "https://app.test",
      webhookSecret: "whsec_x",
      portalConfigurationId: "bpc_x",
      notify: async () => {},
      limiter: () => true,
    };
    expect(() => new BillingService({ ...base, webhookSecret: "" })).toThrow(BillingError);
    expect(() => new BillingService({ ...base, publicUrl: "http://app.test" })).toThrow(
      BillingError,
    );
    expect(() => new BillingService({ ...base, publicUrl: "http://localhost:5173" })).not.toThrow();
  });
});
