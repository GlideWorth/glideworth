import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BillingError } from "../src/errors.js";
import {
  findPrice,
  limitsFor,
  loadPricingConfig,
  type PricingConfig,
  parsePricingConfig,
} from "../src/pricing.js";
import { pricing } from "./helpers.js";

const valid = (): PricingConfig => structuredClone(pricing());

function issuesOf(value: unknown): Array<{ path: string; message: string }> {
  try {
    parsePricingConfig(value);
  } catch (err) {
    expect(err).toBeInstanceOf(BillingError);
    expect((err as BillingError).code).toBe("CONFIG_INVALID");
    return (err as BillingError).details?.issues as Array<{ path: string; message: string }>;
  }
  throw new Error("expected CONFIG_INVALID");
}

describe("pricing.example.json", () => {
  it("matches the owner decisions: $9/month, $90/year, 7-day trial, 14-day grace, offered both", () => {
    const cfg = pricing();
    expect(cfg.trialDays).toBe(7);
    expect(cfg.pastDueGraceDays).toBe(14);
    expect(cfg.trialEndingNoticeDays).toBe(3);
    expect(cfg.trialProductId).toBe("gw_cloud");
    const monthly = findPrice(cfg, "cloud_monthly_v1");
    const yearly = findPrice(cfg, "cloud_yearly_v1");
    expect(monthly?.price).toMatchObject({
      interval: "month",
      currency: "usd",
      unitAmount: 900,
      offered: true,
    });
    expect(yearly?.price).toMatchObject({
      interval: "year",
      currency: "usd",
      unitAmount: 9000,
      offered: true,
    });
    expect(monthly?.price.taxBehavior).toBe("exclusive");
    expect(monthly?.price.currencyOptions.gbp).toEqual({
      unitAmount: 900,
      taxBehavior: "inclusive",
    });
    expect(monthly?.price.currencyOptions.eur).toEqual({
      unitAmount: 900,
      taxBehavior: "inclusive",
    });
    expect(cfg.checkout).toEqual({ allowPromotionCodes: false, collectTaxIds: true });
    expect(limitsFor(cfg, "gw_cloud")).toMatchObject({
      editors: 2,
      viewers: 3,
      storageMb: 200,
      maxMonteCarloTrials: 20000,
    });
  });

  it("findPrice returns null for an unknown key and limitsFor falls back to the trial product", () => {
    const cfg = pricing();
    expect(findPrice(cfg, "cloud_monthly_v9")).toBeNull();
    expect(limitsFor(cfg, "removed_product")).toEqual(limitsFor(cfg, "gw_cloud"));
    expect(limitsFor(cfg, null)).toEqual(limitsFor(cfg, "gw_cloud"));
  });
});

describe("pricing config validation", () => {
  it("rejects a lookup key without a version suffix or with capitals", () => {
    for (const bad of [
      "cloud_monthly",
      "Cloud_monthly_v1",
      "cloud-monthly-v1",
      "cloud_monthly_v",
      "",
    ]) {
      const cfg = valid();
      (cfg.products[0]!.prices[0] as { lookupKey: string }).lookupKey = bad;
      expect(issuesOf(cfg).map((i) => i.path)).toContain("products.0.prices.0.lookupKey");
    }
  });

  it("rejects duplicate lookup keys, also across products", () => {
    const cfg = valid();
    const product = cfg.products[0];
    if (!product) throw new Error("fixture");
    cfg.products.push({ ...structuredClone(product), id: "gw_family" });
    const issues = issuesOf(cfg);
    expect(issues.some((i) => /duplicate lookupKey "cloud_monthly_v1"/.test(i.message))).toBe(true);
  });

  it("rejects a missing trial product and duplicate product ids", () => {
    const cfg = valid();
    cfg.trialProductId = "gw_nope";
    expect(issuesOf(cfg)).toContainEqual({
      path: "trialProductId",
      message: 'trialProductId "gw_nope" is not one of the configured products',
    });
    const dup = valid();
    const product = dup.products[0];
    if (!product) throw new Error("fixture");
    dup.products.push({
      ...structuredClone(product),
      prices: [{ ...structuredClone(product.prices[0]!), lookupKey: "x_v1" }],
    });
    expect(issuesOf(dup).some((i) => /duplicate product id/.test(i.message))).toBe(true);
  });

  it("rejects unknown fields (typos), wrong types and bad amounts", () => {
    const typo = valid() as unknown as Record<string, unknown>;
    typo.trialDayz = 30;
    expect(issuesOf(typo).length).toBeGreaterThan(0);

    const amount = valid();
    (amount.products[0]!.prices[0] as { unitAmount: number }).unitAmount = 9.5;
    expect(issuesOf(amount).map((i) => i.path)).toContain("products.0.prices.0.unitAmount");

    const zero = valid();
    (zero.products[0]!.prices[0] as { unitAmount: number }).unitAmount = 0;
    expect(issuesOf(zero).map((i) => i.path)).toContain("products.0.prices.0.unitAmount");

    const limits = valid();
    (limits.products[0]!.limits as { editors: number }).editors = -1;
    expect(issuesOf(limits).map((i) => i.path)).toContain("products.0.limits.editors");

    const missingLimit = valid() as unknown as {
      products: Array<{ limits: Record<string, unknown> }>;
    };
    delete missingLimit.products[0]!.limits.storageMb;
    expect(issuesOf(missingLimit).map((i) => i.path)).toContain("products.0.limits.storageMb");
  });

  it("rejects uppercase currencies, a currency option repeating the primary currency, bad tax behaviour", () => {
    const upper = valid();
    (upper.products[0]!.prices[0] as { currency: string }).currency = "USD";
    expect(issuesOf(upper).map((i) => i.path)).toContain("products.0.prices.0.currency");

    const repeat = valid();
    const price = repeat.products[0]!.prices[0];
    if (!price) throw new Error("fixture");
    price.currencyOptions.usd = { unitAmount: 900, taxBehavior: "exclusive" };
    expect(issuesOf(repeat).map((i) => i.path)).toContain(
      "products.0.prices.0.currencyOptions.usd",
    );

    const tax = valid() as unknown as {
      products: Array<{ prices: Array<{ taxBehavior: string }> }>;
    };
    const p0 = tax.products[0]!.prices[0];
    if (!p0) throw new Error("fixture");
    p0.taxBehavior = "unspecified";
    expect(issuesOf(tax).map((i) => i.path)).toContain("products.0.prices.0.taxBehavior");
  });

  it("rejects a notice period not shorter than the trial, and a version other than 1", () => {
    const notice = valid();
    notice.trialEndingNoticeDays = 30;
    expect(issuesOf(notice).map((i) => i.path)).toContain("trialEndingNoticeDays");
    const version = valid() as unknown as { version: number };
    version.version = 2;
    expect(issuesOf(version).map((i) => i.path)).toContain("version");
  });

  it("loadPricingConfig: CONFIG_INVALID for a missing file, invalid JSON and an invalid document", () => {
    const dir = mkdtempSync(join(tmpdir(), "gw-billing-"));
    const expectInvalid = (path: string) => {
      try {
        loadPricingConfig(path);
        throw new Error("expected an error");
      } catch (err) {
        expect((err as BillingError).code).toBe("CONFIG_INVALID");
      }
    };
    expectInvalid(join(dir, "nope.json"));
    writeFileSync(join(dir, "bad.json"), "{ not json");
    expectInvalid(join(dir, "bad.json"));
    writeFileSync(join(dir, "empty.json"), "{}");
    expectInvalid(join(dir, "empty.json"));
  });
});
