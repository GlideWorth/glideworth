import type { Stripe } from "stripe";
import { describe, expect, it } from "vitest";
import {
  priceView,
  type RawSubscription,
  refundReason,
  subscriptionView,
} from "../src/gateway/mapping.js";

/** Shaped like a 2026-10-28.endive Subscription (period on the item, expanded customer allowed). */
function sdkSubscription(patch: Partial<RawSubscription> = {}): RawSubscription {
  return {
    id: "sub_1",
    customer: { id: "cus_1" },
    status: "active",
    cancel_at_period_end: false,
    cancel_at: null,
    canceled_at: null,
    trial_end: null,
    metadata: { account_id: "tacct1" },
    items: {
      data: [
        {
          current_period_end: 1_800_000_000,
          price: { id: "price_1", lookup_key: "cloud_monthly_v1", product: "gw_cloud" },
        },
      ],
    },
    ...patch,
  };
}

describe("subscriptionView", () => {
  it("reads the period end from the subscription item and accepts expanded references", () => {
    expect(subscriptionView(sdkSubscription())).toEqual({
      id: "sub_1",
      customerId: "cus_1",
      status: "active",
      priceLookupKey: "cloud_monthly_v1",
      productId: "gw_cloud",
      currentPeriodEnd: 1_800_000_000,
      cancelAtPeriodEnd: false,
      canceledAt: null,
      trialEnd: null,
      metadata: { account_id: "tacct1" },
    });
  });

  it("treats a scheduled cancel_at like cancel at period end, ending at the earlier time", () => {
    const v = subscriptionView(sdkSubscription({ cancel_at: 1_790_000_000 }));
    expect(v.cancelAtPeriodEnd).toBe(true);
    expect(v.currentPeriodEnd).toBe(1_790_000_000);
  });

  it("throws on a status it does not know rather than guessing access", () => {
    expect(() => subscriptionView(sdkSubscription({ status: "something_new" }))).toThrow(
      /Unknown subscription status/,
    );
  });

  it("the SDK type is assignable to the raw shape (compile-time check)", () => {
    const accept = (s: Stripe.Subscription): RawSubscription => s;
    const acceptPrice = (p: Stripe.Price) => priceView(p);
    expect(typeof accept).toBe("function");
    expect(typeof acceptPrice).toBe("function");
  });
});

describe("priceView", () => {
  it("drops the primary currency from currency_options and ignores prices without a lookup key", () => {
    const raw = {
      id: "price_1",
      lookup_key: "cloud_monthly_v1",
      product: "gw_cloud",
      active: true,
      unit_amount: 900,
      currency: "usd",
      recurring: { interval: "month" },
      tax_behavior: "exclusive",
      currency_options: {
        usd: { unit_amount: 900, tax_behavior: "exclusive" },
        eur: { unit_amount: 900, tax_behavior: "inclusive" },
      },
    };
    expect(priceView(raw)?.currencyOptions).toEqual({
      eur: { unitAmount: 900, taxBehavior: "inclusive" },
    });
    expect(priceView({ ...raw, lookup_key: null })).toBeNull();
    expect(priceView({ ...raw, recurring: null })).toBeNull();
  });
});

describe("refundReason", () => {
  it("passes Stripe enum values and maps free text to requested_by_customer", () => {
    expect(refundReason("fraudulent")).toBe("fraudulent");
    expect(refundReason("duplicate")).toBe("duplicate");
    expect(refundReason("Customer asked within 14 days")).toBe("requested_by_customer");
  });
});
