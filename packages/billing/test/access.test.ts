import { describe, expect, it } from "vitest";
import { accessFor, entitlementFor } from "../src/access.js";
import { newTrialRecord } from "../src/state.js";
import type { AccessReason, SubscriptionRecord, SubscriptionStatus } from "../src/types.js";
import { DAY, pricing, T0 } from "./helpers.js";

const cfg = { pastDueGraceDays: 14 };
const iso = (t: number) => new Date(t).toISOString();
const at = (t: number) => new Date(t);

function rec(patch: Partial<SubscriptionRecord>): SubscriptionRecord {
  return {
    accountId: "tacct1",
    status: "active",
    productId: "gw_cloud",
    priceLookupKey: "cloud_monthly_v1",
    trialEndsAt: null,
    stripeCustomerId: "cus_1",
    stripeSubscriptionId: "sub_1",
    currentPeriodEnd: iso(T0 + 14 * DAY),
    cancelAtPeriodEnd: false,
    canceledAt: null,
    pastDueSince: null,
    compedUntil: null,
    stripeUpdated: 1,
    updatedAt: iso(T0 - DAY),
    ...patch,
  };
}

const TRIAL_END = T0 + 10 * DAY;
const PAST_DUE_SINCE = T0;
const GRACE_END = PAST_DUE_SINCE + 14 * DAY;
const PERIOD_END = T0 + 14 * DAY;

/** [label, record, boundary, reason just before, reason at and after] */
const boundaries: Array<[string, SubscriptionRecord, number, AccessReason, AccessReason]> = [
  [
    "local trial",
    rec({ status: "trialing_local", trialEndsAt: iso(TRIAL_END), stripeSubscriptionId: null }),
    TRIAL_END,
    "trial",
    "trial_expired",
  ],
  [
    "past_due grace",
    rec({ status: "past_due", pastDueSince: iso(PAST_DUE_SINCE) }),
    GRACE_END,
    "past_due_grace",
    "past_due",
  ],
  [
    "active, cancel at period end",
    rec({ cancelAtPeriodEnd: true, currentPeriodEnd: iso(PERIOD_END) }),
    PERIOD_END,
    "active",
    "canceled",
  ],
  [
    "Stripe trialing, cancel at period end",
    rec({
      status: "trialing",
      cancelAtPeriodEnd: true,
      trialEndsAt: iso(PERIOD_END),
      currentPeriodEnd: iso(PERIOD_END),
    }),
    PERIOD_END,
    "active",
    "canceled",
  ],
  [
    "incomplete during local trial",
    rec({ status: "incomplete", trialEndsAt: iso(TRIAL_END) }),
    TRIAL_END,
    "trial",
    "incomplete",
  ],
  [
    "incomplete_expired during local trial",
    rec({ status: "incomplete_expired", trialEndsAt: iso(TRIAL_END) }),
    TRIAL_END,
    "trial",
    "incomplete",
  ],
  [
    "comp over a canceled subscription",
    rec({ status: "canceled", compedUntil: iso(TRIAL_END) }),
    TRIAL_END,
    "comped",
    "canceled",
  ],
  [
    "comp over an expired trial",
    rec({ status: "trialing_local", trialEndsAt: iso(T0 - DAY), compedUntil: iso(TRIAL_END) }),
    TRIAL_END,
    "comped",
    "trial_expired",
  ],
];

describe("accessFor at every boundary instant", () => {
  for (const [label, record, boundary, before, after] of boundaries) {
    it(`${label}: full until 1 ms before, read-only at and 1 ms after`, () => {
      const b = accessFor(record, at(boundary - 1), cfg);
      expect(b).toEqual({ level: "full", reason: before, changesAt: iso(boundary) });
      for (const t of [boundary, boundary + 1, boundary + 365 * DAY]) {
        expect(accessFor(record, at(t), cfg)).toEqual({
          level: "read_only",
          reason: after,
          changesAt: null,
        });
      }
    });
  }
});

describe("accessFor: every status, long before and long after", () => {
  const table: Array<
    [SubscriptionStatus, Partial<SubscriptionRecord>, "full" | "read_only", AccessReason]
  > = [
    ["trialing_local", { trialEndsAt: iso(TRIAL_END) }, "full", "trial"],
    ["trialing_local", { trialEndsAt: null }, "read_only", "trial_expired"],
    ["trialing", {}, "full", "active"],
    ["active", {}, "full", "active"],
    ["past_due", { pastDueSince: iso(PAST_DUE_SINCE) }, "full", "past_due_grace"],
    ["unpaid", {}, "read_only", "unpaid"],
    ["canceled", {}, "read_only", "canceled"],
    ["paused", {}, "read_only", "paused"],
    ["incomplete", { trialEndsAt: null }, "read_only", "incomplete"],
    ["incomplete_expired", { trialEndsAt: null }, "read_only", "incomplete"],
  ];
  for (const [status, patch, level, reason] of table) {
    it(`${status} ${JSON.stringify(patch)} -> ${level} (${reason}) at T0`, () => {
      const a = accessFor(rec({ status, ...patch }), at(T0), cfg);
      expect(a.level).toBe(level);
      expect(a.reason).toBe(reason);
    });
  }

  it("no record -> read-only no_subscription", () => {
    expect(accessFor(null, at(T0), cfg)).toEqual({
      level: "read_only",
      reason: "no_subscription",
      changesAt: null,
    });
  });

  it("active without cancel never lapses by time alone (Stripe moves it to past_due if a renewal fails)", () => {
    const r = rec({ currentPeriodEnd: iso(T0) });
    expect(accessFor(r, at(T0 + 100 * DAY), cfg)).toEqual({
      level: "full",
      reason: "active",
      changesAt: null,
    });
  });

  it("past_due without a recorded start uses updatedAt for the grace period", () => {
    const r = rec({ status: "past_due", pastDueSince: null, updatedAt: iso(T0) });
    expect(accessFor(r, at(T0 + 14 * DAY - 1), cfg).level).toBe("full");
    expect(accessFor(r, at(T0 + 14 * DAY), cfg).level).toBe("read_only");
  });

  it("a zero-day grace makes past_due read-only immediately", () => {
    const r = rec({ status: "past_due", pastDueSince: iso(T0) });
    expect(accessFor(r, at(T0), { pastDueGraceDays: 0 })).toEqual({
      level: "read_only",
      reason: "past_due",
      changesAt: null,
    });
  });

  it("a comp in the past has no effect; a comp overrides paid access while it runs", () => {
    expect(accessFor(rec({ status: "unpaid", compedUntil: iso(T0 - 1) }), at(T0), cfg).reason).toBe(
      "unpaid",
    );
    expect(accessFor(rec({ compedUntil: iso(T0 + DAY) }), at(T0), cfg)).toEqual({
      level: "full",
      reason: "comped",
      changesAt: iso(T0 + DAY),
    });
  });

  it("is pure: the same inputs give the same output and the record is not modified", () => {
    const r = rec({ status: "past_due", pastDueSince: iso(T0) });
    const copy = structuredClone(r);
    expect(accessFor(r, at(T0 + DAY), cfg)).toEqual(accessFor(r, at(T0 + DAY), cfg));
    expect(r).toEqual(copy);
  });
});

describe("entitlementFor (design 6.1)", () => {
  const p = pricing();
  it("active account: the access decision plus plan limits", () => {
    const sub = newTrialRecord("tacct1", at(T0), p, true);
    const e = entitlementFor({
      accountStatus: "active",
      subscription: sub,
      now: at(T0),
      pricing: p,
    });
    expect(e).toMatchObject({
      level: "full",
      reason: "trial",
      trialEndsAt: iso(T0 + 14 * DAY),
      changesAt: iso(T0 + 14 * DAY),
    });
    expect(e.limits.editors).toBe(2);
  });

  it("suspended (and any non-active account status) overrides even full paid access", () => {
    for (const accountStatus of ["suspended", "deleting", "deleted", "migration_failed"] as const) {
      const e = entitlementFor({ accountStatus, subscription: rec({}), now: at(T0), pricing: p });
      expect(e.level).toBe("suspended");
      expect(e.reason).toBe("suspended");
      expect(e.access.level).toBe("full");
    }
  });

  it("expired trial: read-only, limits still known, nothing deleted", () => {
    const sub = newTrialRecord("tacct1", at(T0), p, true);
    const e = entitlementFor({
      accountStatus: "active",
      subscription: sub,
      now: at(T0 + 14 * DAY),
      pricing: p,
    });
    expect(e).toMatchObject({ level: "read_only", reason: "trial_expired", changesAt: null });
    expect(e.limits.storageMb).toBe(200);
  });
});
