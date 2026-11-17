import { describe, expect, it } from "vitest";
import { accessFor } from "../src/access.js";
import { applyComp, applyStripeSubscription, isLive, newAccountRecord } from "../src/state.js";
import type {
  StripeSubscriptionStatus,
  StripeSubscriptionView,
  SubscriptionRecord,
} from "../src/types.js";
import { DAY, pricing, T0 } from "./helpers.js";

const cfg = pricing();
const now = new Date(T0);
const sec = (t: number) => Math.floor(t / 1000);
const iso = (t: number) => new Date(t).toISOString();

function view(patch: Partial<StripeSubscriptionView> = {}): StripeSubscriptionView {
  return {
    id: "sub_1",
    customerId: "cus_1",
    status: "active",
    priceLookupKey: "cloud_monthly_v1",
    productId: "gw_cloud",
    currentPeriodEnd: sec(T0 + 30 * DAY),
    cancelAtPeriodEnd: false,
    canceledAt: null,
    trialEnd: null,
    metadata: { account_id: "tacct1" },
    ...patch,
  };
}

function applied(
  prev: SubscriptionRecord | null,
  v: StripeSubscriptionView,
  created = sec(T0),
  at = now,
) {
  const out = applyStripeSubscription(prev, "tacct1", v, created, at, cfg);
  if (out.kind !== "applied") throw new Error(`expected applied, got ${out.kind}`);
  return out.record;
}

describe("newAccountRecord", () => {
  it("has no access and no Stripe objects; the first Checkout may start a trial", () => {
    const r = newAccountRecord("tacct1", now, cfg, true);
    expect(r).toMatchObject({
      status: "trialing_local",
      productId: "gw_cloud",
      trialEndsAt: null,
      trialAvailable: true,
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      stripeUpdated: null,
    });
    expect(accessFor(r, now, cfg)).toMatchObject({ level: "read_only", reason: "no_subscription" });
  });

  it("without a trial (address already used one) the record says so", () => {
    expect(newAccountRecord("tacct1", now, cfg, false).trialAvailable).toBe(false);
  });

  it("trialDays 0 means no trial at all", () => {
    expect(newAccountRecord("tacct1", now, { ...cfg, trialDays: 0 }, true).trialAvailable).toBe(
      false,
    );
  });
});

describe("transition table: any stored state x fetched Stripe status", () => {
  const stored: Array<[string, SubscriptionRecord | null]> = [
    ["none", null],
    ["trialing_local (trial available)", newAccountRecord("tacct1", now, cfg, true)],
    ["trialing_local (no trial)", newAccountRecord("tacct1", now, cfg, false)],
    ["active sub_1", applied(null, view())],
    [
      "past_due sub_1",
      applied(null, view({ status: "past_due" }), sec(T0 - DAY), new Date(T0 - DAY)),
    ],
    ["canceled sub_1", applied(null, view({ status: "canceled", canceledAt: sec(T0 - DAY) }))],
  ];
  const statuses: StripeSubscriptionStatus[] = [
    "incomplete",
    "incomplete_expired",
    "trialing",
    "active",
    "past_due",
    "unpaid",
    "canceled",
    "paused",
  ];
  const expectedReason: Record<StripeSubscriptionStatus, string> = {
    incomplete: "incomplete",
    incomplete_expired: "incomplete",
    trialing: "trial",
    active: "active",
    past_due: "past_due_grace",
    unpaid: "unpaid",
    canceled: "canceled",
    paused: "paused",
  };

  for (const [label, prev] of stored) {
    for (const status of statuses) {
      it(`${label} + fetched ${status} -> stored ${status}`, () => {
        const r = applied(
          prev,
          view({ status, trialEnd: status === "trialing" ? sec(T0 + 10 * DAY) : null }),
          sec(T0) + 10,
        );
        expect(r.status).toBe(status);
        expect(r.stripeSubscriptionId).toBe("sub_1");
        expect(r.stripeCustomerId).toBe("cus_1");
        expect(r.stripeUpdated).toBe(Math.max(prev?.stripeUpdated ?? 0, sec(T0) + 10));
        expect(r.trialAvailable).toBe(false);
        const a = accessFor(r, now, cfg);
        const reason = expectedReason[status];
        expect(a.reason).toBe(reason);
        // The only states with full access: paying, in grace, or in a Stripe trial.
        expect(a.level).toBe(
          ["active", "past_due_grace", "trial"].includes(reason) ? "full" : "read_only",
        );
      });
    }
  }
});

describe("field rules", () => {
  it("takes the trial end from Stripe and uses up the workspace's trial", () => {
    const fresh = newAccountRecord("tacct1", now, cfg, true);
    const trialing = applied(fresh, view({ status: "trialing", trialEnd: sec(T0 + 7 * DAY) }));
    expect(trialing.trialEndsAt).toBe(iso(sec(T0 + 7 * DAY) * 1000));
    expect(trialing.trialAvailable).toBe(false);
    // Even a subscription that never started (abandoned first payment) uses it up.
    expect(applied(fresh, view({ status: "incomplete" })).trialAvailable).toBe(false);
  });

  it("past_due: pastDueSince is set on entry, kept while past_due, cleared when paid", () => {
    const active = applied(null, view());
    const pd = applied(active, view({ status: "past_due" }), sec(T0) + 1);
    expect(pd.pastDueSince).toBe(iso(T0));
    const later = applied(pd, view({ status: "past_due" }), sec(T0 + DAY), new Date(T0 + DAY));
    expect(later.pastDueSince).toBe(iso(T0));
    expect(applied(later, view({ status: "active" }), sec(T0 + 2 * DAY)).pastDueSince).toBeNull();
  });

  it("the stamp never decreases, even for an older event", () => {
    const r = applied(null, view(), 1000);
    expect(applied(r, view({ status: "past_due" }), 500).stripeUpdated).toBe(1000);
  });

  it("the stamp floor read before the fetch is used when given", () => {
    const r = applied(null, view(), 1000);
    const out = applyStripeSubscription(r, "tacct1", view(), 900, now, cfg, 800);
    expect(out.record.stripeUpdated).toBe(900);
  });

  it("keeps an operator comp across Stripe updates", () => {
    const comped = applyComp(applied(null, view()), "tacct1", iso(T0 + 90 * DAY), now, cfg);
    expect(applied(comped, view({ status: "canceled" })).compedUntil).toBe(iso(T0 + 90 * DAY));
  });

  it("cancel at period end is recorded and lapses access at the period end", () => {
    const r = applied(null, view({ cancelAtPeriodEnd: true, currentPeriodEnd: sec(T0 + 5 * DAY) }));
    expect(r.cancelAtPeriodEnd).toBe(true);
    expect(accessFor(r, new Date(sec(T0 + 5 * DAY) * 1000 - 1), cfg).level).toBe("full");
    expect(accessFor(r, new Date(sec(T0 + 5 * DAY) * 1000), cfg).level).toBe("read_only");
  });
});

describe("several subscriptions for one account", () => {
  it("an ended old subscription does not overwrite a live new one (superseded)", () => {
    const live = applied(null, view({ id: "sub_new" }));
    const out = applyStripeSubscription(
      live,
      "tacct1",
      view({ id: "sub_old", status: "canceled" }),
      sec(T0) + 5,
      now,
      cfg,
    );
    expect(out.kind).toBe("superseded");
    expect(out.record).toBe(live);
  });

  it("a new live subscription replaces an ended old one", () => {
    const old = applied(null, view({ id: "sub_old", status: "canceled" }));
    expect(isLive(old)).toBe(false);
    const r = applied(old, view({ id: "sub_new", status: "active" }));
    expect(r.stripeSubscriptionId).toBe("sub_new");
    expect(r.status).toBe("active");
  });

  it("two live subscriptions are a conflict: the stored one is kept", () => {
    const live = applied(null, view({ id: "sub_a" }));
    const out = applyStripeSubscription(live, "tacct1", view({ id: "sub_b" }), sec(T0), now, cfg);
    expect(out.kind).toBe("conflict");
    expect(out.record.stripeSubscriptionId).toBe("sub_a");
  });
});
