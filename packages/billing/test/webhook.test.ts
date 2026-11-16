import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { FakeStripeError } from "../src/gateway/fake.js";
import type { MemoryBillingStore } from "../src/memory-store.js";
import { WEBHOOK_MAX_BODY_BYTES } from "../src/service.js";
import { signPayload } from "../src/signature.js";
import { HOUR, harness, OWNER, SECRET } from "./helpers.js";

function snapshot(store: MemoryBillingStore) {
  return JSON.stringify({
    subs: [...store.subscriptions.entries()],
    customers: [...store.customers.entries()],
    events: [...store.events.entries()],
    notices: [...store.notices],
  });
}

async function subscribed() {
  const h = await harness();
  h.service.startTrial("tacct1", false);
  const { subscriptionId, events } = await h.subscribe("tacct1");
  await h.deliverAll(events);
  h.notices.length = 0;
  h.logs.length = 0;
  h.fake.calls = [];
  return { ...h, subscriptionId };
}

describe("T-BILL: forged or broken webhook requests change nothing and return 400", () => {
  it("missing, empty, malformed, wrong-secret, stale, future, tampered and replayed-late requests", async () => {
    const h = await subscribed();
    const event = h.fake.setSubscription(h.subscriptionId, { status: "canceled" });
    const { body, header } = h.fake.sign(event, SECRET);
    const now = Math.floor(h.clock.now().getTime() / 1000);
    const forged = (secret: string, t = now) =>
      `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;
    const before = snapshot(h.store);

    const attempts: Array<[string, string, string | undefined]> = [
      ["missing header", body, undefined],
      ["empty header", body, ""],
      ["malformed header", body, "not-a-signature"],
      ["timestamp only", body, `t=${now}`],
      ["wrong secret", body, forged("whsec_attacker_guess")],
      ["empty secret", body, forged("")],
      ["stale timestamp", body, forged(SECRET, now - 301)],
      ["future timestamp", body, forged(SECRET, now + 301)],
      ["tampered body", body.replace('"canceled"', '"active"'), header],
      ["body too large", `${body}${" ".repeat(WEBHOOK_MAX_BODY_BYTES)}`, header],
    ];
    for (const [label, b, hdr] of attempts) {
      const out = await h.service.handleWebhook(b, hdr);
      expect(out, label).toEqual({ status: 400, eventId: null, result: "bad-signature" });
    }
    // A valid request captured and replayed after the tolerance window.
    h.clock.advance(301_000);
    expect(await h.service.handleWebhook(body, header)).toEqual({
      status: 400,
      eventId: null,
      result: "bad-signature",
    });

    expect(snapshot(h.store)).toBe(before);
    expect(h.notices).toEqual([]);
    expect(h.fake.calls.filter((c) => c.method !== "constructEvent")).toEqual([]);
    expect(h.logs.filter((l) => l.event === "stripe.signature_invalid")).toHaveLength(
      attempts.length + 1,
    );
    // Logs carry a reason code only: never the body, header or secret.
    const logText = JSON.stringify(h.logs);
    expect(logText).not.toContain(SECRET);
    expect(logText).not.toContain(h.subscriptionId);
    expect(logText).not.toContain(OWNER("tacct1").email);
  });

  it("a replay within the window is a duplicate: 200, processed once", async () => {
    const h = await subscribed();
    const event = h.fake.setSubscription(h.subscriptionId, { cancelAtPeriodEnd: true });
    const { body, header } = h.fake.sign(event, SECRET);
    expect((await h.service.handleWebhook(body, header)).result).toBe("processed");
    const after = snapshot(h.store);
    const retrieves = h.fake.callsTo("retrieveSubscription").length;
    for (let i = 0; i < 3; i++) {
      expect(await h.service.handleWebhook(body, header)).toEqual({
        status: 200,
        eventId: event.id,
        result: "duplicate",
      });
    }
    expect(snapshot(h.store)).toBe(after);
    expect(h.fake.callsTo("retrieveSubscription")).toHaveLength(retrieves);
    expect(h.notices.filter((n) => n.kind === "subscription-canceled")).toHaveLength(1);
  });

  it("accepts a request signed with both the old and the new secret while a secret is rolled", async () => {
    const h = await subscribed();
    const event = h.fake.setSubscription(h.subscriptionId, { cancelAtPeriodEnd: true });
    const { body, header } = h.fake.sign(event, ["whsec_old_secret_being_rolled", SECRET]);
    expect((await h.service.handleWebhook(body, header)).status).toBe(200);
  });
});

describe("T-BILL: state comes from the fetched subscription, never from the event body", () => {
  it("an event claiming active while Stripe says canceled stores canceled", async () => {
    const h = await subscribed();
    h.fake.setSubscription(h.subscriptionId, { status: "canceled" });
    const lie = h.fake.event("customer.subscription.updated", {
      id: h.subscriptionId,
      object: "subscription",
      customer: h.store.getSubscription("tacct1")?.stripeCustomerId,
      status: "active",
      cancel_at_period_end: false,
    });
    expect((await h.deliver(lie)).result).toBe("processed");
    expect(h.store.getSubscription("tacct1")?.status).toBe("canceled");
    expect(h.service.status("tacct1").access).toMatchObject({
      level: "read_only",
      reason: "canceled",
    });
  });

  it("an event naming another customer than the fetched subscription is orphaned and changes nothing", async () => {
    const h = await subscribed();
    const before = snapshot(h.store);
    const lie = h.fake.event("customer.subscription.updated", {
      id: h.subscriptionId,
      object: "subscription",
      customer: "cus_someone_else",
      status: "active",
    });
    expect((await h.deliver(lie)).result).toBe("orphaned");
    const after = JSON.parse(snapshot(h.store));
    expect(after.subs).toEqual(JSON.parse(before).subs);
  });

  it("subscription metadata naming another account than the customer mapping is orphaned", async () => {
    const h = await subscribed();
    h.service.startTrial("tacct2", true);
    const event = h.fake.setSubscription(h.subscriptionId, { metadata: { account_id: "tacct2" } });
    expect((await h.deliver(event)).result).toBe("orphaned");
    expect(h.store.getSubscription("tacct2")?.stripeSubscriptionId).toBeNull();
    expect(h.notices).toContainEqual({
      kind: "orphaned-event",
      accountId: null,
      stripeObjectId: h.subscriptionId,
    });
  });
});

describe("T-BILL: unknown customers are orphaned", () => {
  it("valid signature, unknown customer -> orphaned, 200, operator notice, no state change", async () => {
    const h = await harness();
    // A subscription that exists in Stripe but belongs to no account here.
    const { id: customerId } = await h.fake.createCustomer(
      { email: "x@example.test", name: "X", accountId: "tnobody" },
      "k1",
    );
    const priceId = [...h.fake.prices.values()][0]?.id ?? "";
    const session = await h.fake.createCheckoutSession(
      {
        customerId,
        priceId,
        accountId: "tnobody",
        trialEnd: null,
        successUrl: "https://x/s",
        cancelUrl: "https://x/c",
        allowPromotionCodes: false,
        collectTaxIds: true,
      },
      "k2",
    );
    const events = h.fake.completeCheckout(session.id);
    const before = snapshot(h.store);
    const outcomes = await h.deliverAll(events);
    expect(outcomes.map((o) => [o.status, o.result])).toEqual([
      [200, "orphaned"],
      [200, "orphaned"],
      [200, "orphaned"],
    ]);
    const after = JSON.parse(snapshot(h.store));
    expect(after.subs).toEqual(JSON.parse(before).subs);
    expect(after.customers).toEqual(JSON.parse(before).customers);
    expect(h.notices.every((n) => n.kind === "orphaned-event" && n.accountId === null)).toBe(true);
    expect(h.notices).toHaveLength(3);
    expect([...h.store.events.values()].map((e) => e.status)).toEqual([
      "orphaned",
      "orphaned",
      "orphaned",
    ]);
    // Redelivery of an orphaned event is a duplicate.
    expect((await h.deliver(events[0]!)).result).toBe("duplicate");
  });

  it("customer.deleted and charge.refunded for an unknown customer are orphaned", async () => {
    const h = await harness();
    expect(
      (await h.deliver(h.fake.event("customer.deleted", { id: "cus_ghost", object: "customer" })))
        .result,
    ).toBe("orphaned");
    expect(
      (
        await h.deliver(
          h.fake.event("charge.refunded", {
            id: "ch_ghost",
            object: "charge",
            customer: "cus_ghost",
          }),
        )
      ).result,
    ).toBe("orphaned");
  });
});

describe("T-BILL: idempotency and failure handling", () => {
  it("duplicate deliveries are processed once", async () => {
    const h = await harness();
    h.service.startTrial("tacct1", true);
    const { events } = await h.subscribe("tacct1");
    for (let round = 0; round < 3; round++) await h.deliverAll(events);
    const rows = [...h.store.events.values()];
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.status === "processed" && r.attempts === 1)).toBe(true);
    expect(h.fake.callsTo("retrieveSubscription")).toHaveLength(3);
    expect(h.notices.filter((n) => n.kind === "subscription-activated")).toHaveLength(1);
  });

  it("a handler exception returns 500 and marks the event failed; Stripe redelivery processes it", async () => {
    const h = await subscribed();
    const event = h.fake.setSubscription(h.subscriptionId, { cancelAtPeriodEnd: true });
    h.fake.failNext("retrieveSubscription");
    const first = await h.deliver(event);
    expect(first).toEqual({ status: 500, eventId: event.id, result: "failed" });
    expect(h.store.events.get(event.id)).toMatchObject({
      status: "failed",
      attempts: 1,
      errorCode: "connection_error",
    });
    expect(h.store.getSubscription("tacct1")?.cancelAtPeriodEnd).toBe(false);
    const second = await h.deliver(event);
    expect(second).toEqual({ status: 200, eventId: event.id, result: "processed" });
    expect(h.store.events.get(event.id)).toMatchObject({ status: "processed", attempts: 2 });
    expect(h.store.getSubscription("tacct1")?.cancelAtPeriodEnd).toBe(true);
    expect(JSON.stringify(h.logs)).not.toContain("network down");
  });

  it("the sweep re-runs failed events through the API and skips ones over the attempt limit", async () => {
    const h = await subscribed();
    const event = h.fake.setSubscription(h.subscriptionId, { status: "unpaid" });
    h.fake.failNext("retrieveSubscription");
    expect((await h.deliver(event)).status).toBe(500);
    const result = await h.service.sweep();
    expect(result.retried).toBe(1);
    expect(h.store.events.get(event.id)?.status).toBe("processed");
    expect(h.store.getSubscription("tacct1")?.status).toBe("unpaid");
    expect((await h.service.sweep()).retried).toBe(0);

    const stuck = h.fake.setSubscription(h.subscriptionId, { status: "canceled" });
    h.fake.failNext("retrieveSubscription");
    await h.deliver(stuck);
    const row = h.store.events.get(stuck.id);
    if (!row) throw new Error("row");
    row.attempts = 25;
    expect((await h.service.sweep()).retried).toBe(0);
  });

  it("event types we do not handle are recorded as ignored", async () => {
    const h = await harness();
    const out = await h.deliver(
      h.fake.event("payment_intent.created", { id: "pi_1", object: "payment_intent" }),
    );
    expect(out.result).toBe("ignored");
    expect(h.store.events.get(out.eventId ?? "")?.status).toBe("ignored");
  });

  it("a Stripe error message never reaches the logs, only its code", async () => {
    const h = await subscribed();
    const event = h.fake.setSubscription(h.subscriptionId, { cancelAtPeriodEnd: true });
    h.fake.failNext(
      "retrieveSubscription",
      new FakeStripeError("api_error", "api_error", 500, "secret detail cus_x"),
    );
    await h.deliver(event);
    expect(JSON.stringify(h.logs)).not.toContain("secret detail");
  });
});

describe("every handled event type", () => {
  it("checkout.session.completed / customer.subscription.created / invoice.paid", async () => {
    const h = await harness();
    h.service.startTrial("tacct1", false);
    const { events } = await h.subscribe("tacct1");
    const outcomes = await h.deliverAll(events);
    expect(events.map((e) => e.type)).toEqual([
      "customer.subscription.created",
      "invoice.paid",
      "checkout.session.completed",
    ]);
    expect(outcomes.every((o) => o.result === "processed")).toBe(true);
    expect(h.service.status("tacct1").access).toEqual({
      level: "full",
      reason: "active",
      changesAt: null,
    });
    expect(h.notices).toEqual([
      {
        kind: "payment-succeeded",
        accountId: "tacct1",
        invoiceUrl: expect.stringContaining("https://invoice.stripe.test/"),
      },
      { kind: "subscription-activated", accountId: "tacct1" },
    ]);
  });

  it("customer.subscription.updated / paused / resumed / deleted / trial_will_end", async () => {
    const h = await harness();
    h.service.startTrial("tacct1", true);
    const { subscriptionId, events } = await h.subscribe("tacct1");
    await h.deliverAll(events);
    expect(h.store.getSubscription("tacct1")?.status).toBe("trialing");

    await h.deliverAll(h.fake.trialWillEnd(subscriptionId));
    expect(h.notices.filter((n) => n.kind === "trial-ending")).toHaveLength(1);

    await h.deliverAll(h.fake.pause(subscriptionId));
    expect(h.service.status("tacct1").access.reason).toBe("paused");
    await h.deliverAll(h.fake.resume(subscriptionId));
    expect(h.service.status("tacct1").access.reason).toBe("active");
    await h.deliver(h.fake.setSubscription(subscriptionId, { status: "canceled" }));
    expect(h.service.status("tacct1").access).toMatchObject({
      level: "read_only",
      reason: "canceled",
    });
    expect(h.notices.filter((n) => n.kind === "subscription-canceled")).toHaveLength(1);
  });

  it("invoice.payment_failed and invoice.payment_action_required notify once per invoice", async () => {
    const h = await subscribed();
    const failed = h.fake.failNextInvoice(h.subscriptionId);
    await h.deliverAll(failed);
    await h.deliverAll(failed);
    const problems = h.notices.filter((n) => n.kind === "payment-problem");
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({
      readOnlyFrom: new Date(h.clock.t + 14 * 24 * HOUR).toISOString(),
    });
    await h.deliverAll(h.fake.payLatestInvoice(h.subscriptionId));
    await h.deliverAll(h.fake.requireAction(h.subscriptionId));
    expect(h.notices.filter((n) => n.kind === "payment-problem")).toHaveLength(2);
    expect(h.store.getSubscription("tacct1")?.status).toBe("past_due");
  });

  it("charge.refunded, charge.dispute.created, radar.early_fraud_warning.created, customer.deleted", async () => {
    const h = await subscribed();
    const charge = h.fake.latestChargeOf(h.subscriptionId);
    const refund = await h.service.refund({
      accountId: "tacct1",
      chargeId: charge,
      reason: "requested_by_customer",
      operatorId: "op_1",
    });
    expect(refund.id).toMatch(/^re_/);
    expect((await h.deliver(h.fake.outbox.at(-1)!)).result).toBe("processed");
    expect(h.service.status("tacct1").access.level).toBe("full");

    await h.deliverAll(h.fake.dispute(charge));
    await h.deliverAll(h.fake.earlyFraudWarning(charge));
    expect(
      h.notices.filter((n) => n.kind === "dispute" || n.kind === "early-fraud-warning"),
    ).toEqual([
      { kind: "dispute", accountId: null, stripeObjectId: expect.stringMatching(/^dp_/) },
      {
        kind: "early-fraud-warning",
        accountId: null,
        stripeObjectId: expect.stringMatching(/^issfr_/),
      },
    ]);

    const customerId = h.store.getSubscription("tacct1")?.stripeCustomerId ?? "";
    const outcomes = await h.deliverAll(h.fake.deleteCustomer(customerId));
    expect(outcomes.map((o) => o.result)).toEqual(["processed", "processed"]);
    expect(h.service.status("tacct1").access).toMatchObject({
      level: "read_only",
      reason: "canceled",
    });
  });

  it("records a checkout.session.async_payment_failed without failing (counts toward the breaker)", async () => {
    const h = await harness();
    const out = await h.deliver(
      h.fake.event("checkout.session.async_payment_failed", {
        id: "cs_x",
        object: "checkout.session",
        customer: "cus_x",
      }),
    );
    expect(out).toMatchObject({ status: 200, result: "ignored" });
  });

  it("signed with a different body: our own signature helper is what the fake uses", async () => {
    const h = await subscribed();
    const event = h.fake.setSubscription(h.subscriptionId, { cancelAtPeriodEnd: true });
    const { body } = h.fake.sign(event, SECRET);
    const header = signPayload(body, SECRET, Math.floor(h.clock.t / 1000));
    expect((await h.service.handleWebhook(body, header)).result).toBe("processed");
  });
});
