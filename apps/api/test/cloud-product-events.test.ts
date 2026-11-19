/**
 * Server-side product events in cloud mode: a Stripe webhook that starts a trial sends one
 * `subscription_status_changed` event to PostHog as the workspace owner, with statuses only. Without a PostHog
 * token (a self-host copy) nothing is sent.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootCloud, type Cloud, signUp, WEBHOOK_SECRET } from "./cloud-harness.js";

function capture() {
  // oxlint-disable-next-line typescript/no-explicit-any -- captured request bodies are untyped JSON
  const sent: Array<{ url: string; body: Record<string, any> }> = [];
  const fetch = (async (url: string, init: RequestInit) => {
    sent.push({ url, body: JSON.parse(String(init.body)) });
    return new Response("{}", { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  return { sent, fetch };
}

describe("cloud product events", () => {
  const ph = capture();
  let cloud: Cloud;
  beforeAll(async () => {
    cloud = await bootCloud({
      env: {
        GLIDEWORTH_POSTHOG_PROJECT_TOKEN: "phc_cloudapitests123",
        GLIDEWORTH_POSTHOG_HOST: "https://posthog.example.test",
      },
      productEventFetch: ph.fetch,
    });
  });
  afterAll(async () => {
    await cloud?.close();
  });

  it("sends the trial start as the owner, with statuses only", async () => {
    const { browser, userId, email } = await signUp(cloud);
    const checkout = await browser.post("/api/v1/billing/checkout", {
      lookupKey: "cloud_monthly_v1",
    });
    expect(checkout.status, checkout.text).toBe(200);
    const sessionId = String(checkout.json.url).split("/").at(-1) as string;
    for (const ev of cloud.gateway.completeCheckout(sessionId)) {
      const signed = cloud.gateway.sign(ev, WEBHOOK_SECRET);
      const delivered = await browser.req("POST", "/stripe/webhook", {
        raw: signed.body,
        headers: { "stripe-signature": signed.header, "content-type": "application/json" },
      });
      expect(delivered.status, delivered.text).toBe(200);
    }
    await cloud.rt.productEvents?.flush();
    const mine = ph.sent.filter((s) => s.body.distinct_id === userId);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.url).toBe("https://posthog.example.test/i/v0/e/");
    expect(mine[0]!.body).toMatchObject({
      api_key: "phc_cloudapitests123",
      event: "subscription_status_changed",
      properties: {
        change: "started",
        from_status: "trialing_local",
        to_status: "trialing",
        cancel_at_period_end: false,
        $geoip_disable: true,
      },
    });
    const all = JSON.stringify(ph.sent);
    for (const s of [email, "Robin", "amount"]) expect(all).not.toContain(s);
  });
});

describe("cloud product events without a PostHog token", () => {
  const ph = capture();
  let cloud: Cloud;
  beforeAll(async () => {
    cloud = await bootCloud({ productEventFetch: ph.fetch });
  });
  afterAll(async () => {
    await cloud?.close();
  });

  it("sends nothing", async () => {
    await signUp(cloud);
    expect(cloud.rt.productEvents).toBeNull();
    expect(ph.sent).toHaveLength(0);
  });
});
