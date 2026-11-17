import { describe, expect, it } from "vitest";
import { BillingError } from "../src/errors.js";
import { DAY, HOUR, harness } from "./helpers.js";

describe("lifecycle through the service with the fake gateway", () => {
  it("new workspace: no access -> Checkout with a card -> 7-day Stripe trial -> charged on day 8 -> active", async () => {
    const h = await harness();
    const rec = h.service.openAccount("tacct1", true);
    expect(h.service.openAccount("tacct1", true)).toEqual(rec);
    expect(h.fake.calls).toEqual([]);
    expect(h.service.status("tacct1")).toMatchObject({
      access: { level: "read_only", reason: "no_subscription", changesAt: null },
      trialDays: 7,
    });
    const { subscriptionId, events } = await h.subscribe("tacct1");
    await h.deliverAll(events);
    const trialEndsAt = h.store.getSubscription("tacct1")?.trialEndsAt ?? "";
    expect(Date.parse(trialEndsAt) - h.clock.t).toBeGreaterThan(7 * DAY - 1000);
    expect(h.service.status("tacct1")).toMatchObject({
      record: { status: "trialing", priceLookupKey: "cloud_monthly_v1", productId: "gw_cloud" },
      access: { level: "full", reason: "trial" },
      trialDays: null,
      limits: { editors: 2 },
    });
    h.clock.set(Date.parse(trialEndsAt));
    await h.deliverAll(h.fake.renew(subscriptionId));
    expect(h.service.status("tacct1")).toMatchObject({
      record: { status: "active" },
      access: { level: "full", reason: "active" },
    });
  });

  it("failed renewal: past_due with 14 days of grace, read-only at the boundary, full again when paid", async () => {
    const h = await harness();
    const { subscriptionId, events } = await h.subscribe("tacct1", "cloud_yearly_v1");
    await h.deliverAll(events);
    h.clock.advance(365 * DAY);
    const failedAt = h.clock.t;
    await h.deliverAll(h.fake.failNextInvoice(subscriptionId));
    const graceEnd = failedAt + 14 * DAY;
    expect(h.service.status("tacct1").access).toEqual({
      level: "full",
      reason: "past_due_grace",
      changesAt: new Date(graceEnd).toISOString(),
    });
    // A later retry failure does not restart the grace period.
    h.clock.advance(3 * DAY);
    await h.deliverAll(h.fake.failNextInvoice(subscriptionId));
    h.clock.set(graceEnd - 1);
    expect(h.service.status("tacct1").access.level).toBe("full");
    h.clock.set(graceEnd);
    expect(h.service.status("tacct1").access).toEqual({
      level: "read_only",
      reason: "past_due",
      changesAt: null,
    });
    expect(h.notices.filter((n) => n.kind === "payment-problem")).toHaveLength(2);
    await h.deliverAll(h.fake.payLatestInvoice(subscriptionId));
    expect(h.service.status("tacct1").access).toEqual({
      level: "full",
      reason: "active",
      changesAt: null,
    });
    expect(h.store.getSubscription("tacct1")?.pastDueSince).toBeNull();
  });

  it("retries exhausted: unpaid or canceled are read-only, never deleted", async () => {
    const h = await harness();
    const { subscriptionId, events } = await h.subscribe("tacct1");
    await h.deliverAll(events);
    await h.deliverAll(h.fake.failNextInvoice(subscriptionId));
    await h.deliverAll(h.fake.exhaustRetries(subscriptionId, "unpaid"));
    expect(h.service.status("tacct1").access).toMatchObject({
      level: "read_only",
      reason: "unpaid",
    });
    expect(h.store.getSubscription("tacct1")).not.toBeNull();
    await h.deliverAll(h.fake.exhaustRetries(subscriptionId, "canceled"));
    expect(h.service.status("tacct1").access).toMatchObject({
      level: "read_only",
      reason: "canceled",
    });
    expect(h.fake.callsTo("cancelSubscription")).toEqual([]);
  });

  it("cancel at period end: full until the period ends (even if the final event is late), then read-only", async () => {
    const h = await harness();
    const { subscriptionId, events } = await h.subscribe("tacct1");
    await h.deliverAll(events);
    await h.deliverAll(h.fake.cancelAtPeriodEnd(subscriptionId));
    const rec = h.store.getSubscription("tacct1");
    const periodEnd = Date.parse(rec?.currentPeriodEnd ?? "");
    expect(h.notices.filter((n) => n.kind === "subscription-canceled")).toEqual([
      { kind: "subscription-canceled", accountId: "tacct1", accessUntil: rec?.currentPeriodEnd },
    ]);
    h.clock.set(periodEnd - 1);
    expect(h.service.status("tacct1").access).toMatchObject({ level: "full", reason: "active" });
    h.clock.set(periodEnd);
    expect(h.service.status("tacct1").access).toMatchObject({
      level: "read_only",
      reason: "canceled",
    });
    await h.deliverAll(h.fake.endPeriod(subscriptionId));
    expect(h.store.getSubscription("tacct1")?.status).toBe("canceled");
    expect(h.notices.filter((n) => n.kind === "subscription-canceled")).toHaveLength(1);
  });

  it("cancelNow (workspace deletion): immediate, no proration, no cancel email, idempotent", async () => {
    const h = await harness();
    const { subscriptionId, events } = await h.subscribe("tacct1");
    await h.deliverAll(events);
    await h.service.cancelNow("tacct1");
    expect(h.fake.callsTo("cancelSubscription")[0]?.args).toEqual([
      subscriptionId,
      { prorate: false, invoiceNow: false },
    ]);
    expect(h.store.getSubscription("tacct1")?.status).toBe("canceled");
    await h.deliverAll(h.fake.outbox.filter((e) => e.type === "customer.subscription.deleted"));
    expect(h.notices.filter((n) => n.kind === "subscription-canceled")).toEqual([]);
    await h.service.cancelNow("tacct1");
    await h.service.cancelNow("tacct2");
    expect(h.fake.callsTo("cancelSubscription")).toHaveLength(1);
  });

  it("cancelNow surfaces Stripe outages so deletion can retry", async () => {
    const h = await harness();
    const { events } = await h.subscribe("tacct1");
    await h.deliverAll(events);
    h.fake.failNext("cancelSubscription");
    await expect(h.service.cancelNow("tacct1")).rejects.toMatchObject({
      code: "STRIPE_UNAVAILABLE",
    });
    expect(h.store.getSubscription("tacct1")?.status).toBe("active");
    await h.service.cancelNow("tacct1");
    expect(h.store.getSubscription("tacct1")?.status).toBe("canceled");
  });

  it("refund: idempotent per charge and amount, validated, access follows the subscription", async () => {
    const h = await harness();
    const { subscriptionId, events } = await h.subscribe("tacct1", "cloud_yearly_v1");
    await h.deliverAll(events);
    const chargeId = h.fake.latestChargeOf(subscriptionId);
    const i = {
      accountId: "tacct1",
      chargeId,
      reason: "Annual plan refund within 14 days",
      operatorId: "op_1",
    };
    const a = await h.service.refund(i);
    const b = await h.service.refund(i);
    expect(b.id).toBe(a.id);
    expect(h.fake.refunds.size).toBe(1);
    expect([...h.fake.refunds.values()][0]).toMatchObject({
      amount: 9000,
      reason: "requested_by_customer",
    });
    await h.deliverAll(h.fake.outbox.filter((e) => e.type === "charge.refunded"));
    // A refund alone does not cut access; the operator cancels separately if the policy says so.
    expect(h.service.status("tacct1").access.level).toBe("full");
    await h.service.cancelNow("tacct1");
    expect(h.service.status("tacct1").access).toMatchObject({
      level: "read_only",
      reason: "canceled",
    });

    await expect(h.service.refund({ ...i, reason: "  " })).rejects.toBeInstanceOf(RangeError);
    await expect(h.service.refund({ ...i, amount: 0 })).rejects.toBeInstanceOf(RangeError);
    await expect(h.service.refund({ ...i, amount: 1.5 })).rejects.toBeInstanceOf(RangeError);
    await expect(h.service.refund({ ...i, chargeId: "cus_123" })).rejects.toBeInstanceOf(
      RangeError,
    );
    await expect(h.service.refund({ ...i, accountId: "tacct2" })).rejects.toMatchObject({
      code: "NO_CUSTOMER",
    });
    // Refunding more than remains is a Stripe error, surfaced as STRIPE_UNAVAILABLE with its code.
    await expect(h.service.refund({ ...i, amount: 50 })).rejects.toMatchObject({
      code: "STRIPE_UNAVAILABLE",
    });
    expect(JSON.stringify(h.logs)).not.toMatch(/9000|Annual plan/);
  });

  it("comp: full access over any state until the date; removing it restores the Stripe state", async () => {
    const h = await harness();
    h.service.openAccount("tacct1", false);
    const until = new Date(h.clock.t + 10 * DAY).toISOString();
    h.service.comp("tacct1", until);
    expect(h.service.status("tacct1").access).toEqual({
      level: "full",
      reason: "comped",
      changesAt: until,
    });
    h.service.comp("tacct1", null);
    expect(h.service.status("tacct1").access.reason).toBe("no_subscription");
    h.service.comp("tnew", until);
    expect(h.service.status("tnew").access.reason).toBe("comped");
    expect(() => h.service.comp("tacct1", "not a date")).toThrow(RangeError);
  });

  it("sweep: one trial-ending reminder per Stripe trial, 3 days before the charge; none without a trial", async () => {
    const h = await harness({ accounts: ["tacct1", "tacct2", "tacct3"] });
    h.service.openAccount("tacct1", true);
    h.service.openAccount("tacct2", false);
    h.service.openAccount("tacct3", true);
    const one = await h.subscribe("tacct1");
    await h.deliverAll(one.events);
    const two = await h.subscribe("tacct2");
    await h.deliverAll(two.events);
    h.clock.advance(HOUR);
    const three = await h.subscribe("tacct3");
    await h.deliverAll(three.events);
    expect(await h.service.sweep()).toEqual({ retried: 0, noticesSent: 0 });

    h.clock.advance(4 * DAY - 30 * 60_000); // 3 days minus 30 min before tacct1's trial end
    expect((await h.service.sweep()).noticesSent).toBe(1);
    expect(h.notices.filter((n) => n.kind === "trial-ending")).toEqual([
      {
        kind: "trial-ending",
        accountId: "tacct1",
        trialEndsAt: h.store.getSubscription("tacct1")?.trialEndsAt,
        charge: { unitAmount: 900, currency: "usd", interval: "month" },
      },
    ]);
    h.clock.advance(HOUR);
    expect((await h.service.sweep()).noticesSent).toBe(1); // tacct3 enters its window
    expect((await h.service.sweep()).noticesSent).toBe(0);
    h.clock.advance(3 * DAY);
    expect((await h.service.sweep()).noticesSent).toBe(0);
    expect(h.notices.some((n) => n.accountId === "tacct2" && n.kind === "trial-ending")).toBe(
      false,
    );
  });

  it("sweep: a failing notifier is logged and does not stop the other notices", async () => {
    let calls = 0;
    const h = await harness({
      accounts: ["tacct1", "tacct2"],
      deps: {
        notify: async (n) => {
          if (n.kind !== "trial-ending") return;
          calls++;
          if (calls === 1) throw new Error("smtp down");
        },
      },
    });
    for (const a of ["tacct1", "tacct2"]) {
      h.service.openAccount(a, true);
      await h.deliverAll((await h.subscribe(a)).events);
    }
    h.clock.advance(5 * DAY);
    expect((await h.service.sweep()).noticesSent).toBe(1);
    expect(h.logs.some((l) => l.event === "billing.notice_failed")).toBe(true);
  });

  it("a trial cancelled in the portal gets no reminder", async () => {
    const h = await harness();
    h.service.openAccount("tacct1", true);
    const { subscriptionId, events } = await h.subscribe("tacct1");
    await h.deliverAll(events);
    await h.deliverAll(h.fake.cancelAtPeriodEnd(subscriptionId));
    h.clock.advance(5 * DAY);
    await h.service.sweep();
    await h.deliverAll(h.fake.trialWillEnd(subscriptionId));
    expect(h.notices.filter((n) => n.kind === "trial-ending")).toEqual([]);
  });

  it("createCheckout errors are BillingErrors with stable codes", async () => {
    const h = await harness();
    await expect(
      h.service.createCheckout({
        accountId: "tacct1",
        ownerEmail: "x",
        ownerName: "x",
        lookupKey: "nope_v1",
        ip: "1",
      }),
    ).rejects.toBeInstanceOf(BillingError);
  });
});
