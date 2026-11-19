import type { StripeEventView } from "@glideworth/billing";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { billingAnalytics } from "../src/billing/glue.js";
import { subscriptions } from "../src/control/schema.js";
import {
  createPostHogProductEvents,
  type ProductEvents,
  type ServerProductEvent,
  subscriptionChange,
} from "../src/log/product-events.js";
import {
  type Cloud,
  makeCloud,
  removeTempDirs,
  signedUpBrowser,
  WEBHOOK_SECRET,
} from "./cloud-fixture.js";

const TOKEN = "phc_testprojecttoken123";
const HOST = "https://us.i.posthog.com";

/** A fake PostHog capture endpoint: records each request body. */
function fakePostHog(status = 200) {
  // oxlint-disable-next-line typescript/no-explicit-any -- captured request bodies are untyped JSON
  const sent: Array<{ url: string; body: Record<string, any> }> = [];
  const fetch = (async (url: string, init: RequestInit) => {
    sent.push({ url, body: JSON.parse(String(init.body)) });
    return new Response("{}", { status });
  }) as unknown as typeof globalThis.fetch;
  return { sent, fetch };
}

describe("subscriptionChange", () => {
  it.each([
    [null, "trialing", false, "started"],
    [null, "active", false, "started"],
    ["trialing_local", "trialing", false, "started"],
    ["trialing_local", "active", false, "started"],
    ["incomplete", "active", false, "started"],
    ["canceled", "active", false, "started"],
    ["trialing", "active", false, "converted"],
    ["trialing", "canceled", false, "canceled"],
    ["active", "canceled", false, "canceled"],
    ["incomplete", "incomplete_expired", false, "canceled"],
    ["active", "active", true, "cancel_scheduled"],
    ["trialing", "trialing", true, "cancel_scheduled"],
    ["active", "active", false, "cancel_reverted"],
    ["active", "past_due", false, "past_due"],
    ["past_due", "unpaid", false, "past_due"],
    ["past_due", "active", false, "recovered"],
    ["active", "paused", false, "other"],
    [null, "incomplete", false, "other"],
  ] as const)("%s -> %s (cancel at period end: %s) is %s", (from, to, cap, change) => {
    expect(subscriptionChange(from, to, cap)).toBe(change);
  });
});

describe("PostHog product events", () => {
  const changed: ServerProductEvent = {
    event: "subscription_status_changed",
    properties: {
      change: "converted",
      from_status: "trialing",
      to_status: "active",
      cancel_at_period_end: false,
    },
  };

  it("sends the event as the given distinct id with only its own properties", async () => {
    const ph = fakePostHog();
    const events = createPostHogProductEvents({
      token: TOKEN,
      host: `${HOST}/`,
      fetch: ph.fetch,
      now: () => Date.parse("2026-11-18T10:00:00Z"),
    });
    events.capture("user_123", changed);
    events.capture("user_123", { event: "subscription_payment_succeeded" });
    await events.flush();
    expect(ph.sent.map((s) => s.url)).toEqual([`${HOST}/i/v0/e/`, `${HOST}/i/v0/e/`]);
    expect(ph.sent[0]!.body).toEqual({
      api_key: TOKEN,
      event: "subscription_status_changed",
      distinct_id: "user_123",
      timestamp: "2026-11-18T10:00:00.000Z",
      properties: {
        change: "converted",
        from_status: "trialing",
        to_status: "active",
        cancel_at_period_end: false,
        $geoip_disable: true,
        $lib: "glideworth-server",
      },
    });
    expect(ph.sent[1]!.body.properties).toEqual({
      $geoip_disable: true,
      $lib: "glideworth-server",
    });
  });

  it("drops events past maxInFlight and never throws when PostHog fails", async () => {
    const warnings: string[] = [];
    const log = {
      debug() {},
      info() {},
      warn: (e: string) => warnings.push(e),
      error() {},
      child() {
        return log;
      },
    };
    let calls = 0;
    const failing = (async () => {
      calls++;
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const events = createPostHogProductEvents({
      token: TOKEN,
      host: HOST,
      fetch: failing,
      maxInFlight: 2,
      log,
    });
    for (let i = 0; i < 5; i++) expect(() => events.capture("user_1", changed)).not.toThrow();
    await events.flush();
    expect(calls).toBe(2);
    expect(warnings).toContain("product_event.not_sent");
  });
});

describe("billing product events (Stripe webhook)", () => {
  let cloud: Cloud;
  afterEach(async () => {
    await cloud?.accounts.settled();
    removeTempDirs();
  });

  const captured: Array<{ distinctId: string; e: ServerProductEvent }> = [];
  const recorder: ProductEvents = {
    capture: (distinctId, e) => captured.push({ distinctId, e }),
    flush: async () => {},
  };

  const deliver = async (events: StripeEventView[]) => {
    for (const ev of events) {
      const { body, header } = cloud.fake.sign(ev, WEBHOOK_SECRET);
      const r = await cloud.app.request("/stripe/webhook", {
        method: "POST",
        headers: { "stripe-signature": header, "content-type": "application/json" },
        body,
      });
      expect(r.status).toBe(200);
    }
  };

  it("sends trial start, conversion, renewal and cancellation as the workspace owner", async () => {
    captured.length = 0;
    let db: Cloud["db"] | undefined;
    cloud = await makeCloud({
      track: (accountId, e) => billingAnalytics(db!, recorder)(accountId, e),
    });
    db = cloud.db;
    const owner = await signedUpBrowser(cloud);
    const subId = db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.accountId, owner.accountId as string))
      .get()?.stripeSubscriptionId as string;

    await deliver(cloud.fake.renew(subId));
    await deliver([cloud.fake.setSubscription(subId, { cancelAtPeriodEnd: true })]);

    expect(captured.every((c) => c.distinctId === owner.userId)).toBe(true);
    expect(captured.map((c) => c.e)).toEqual([
      {
        event: "subscription_status_changed",
        properties: {
          change: "started",
          from_status: "trialing_local",
          to_status: "trialing",
          cancel_at_period_end: false,
        },
      },
      {
        event: "subscription_status_changed",
        properties: {
          change: "converted",
          from_status: "trialing",
          to_status: "active",
          cancel_at_period_end: false,
        },
      },
      { event: "subscription_payment_succeeded" },
      {
        event: "subscription_status_changed",
        properties: {
          change: "cancel_scheduled",
          from_status: "active",
          to_status: "active",
          cancel_at_period_end: true,
        },
      },
    ]);
    const all = JSON.stringify(captured);
    for (const s of [owner.email, "Robin", "amount", "price"]) expect(all).not.toContain(s);
  });
});
