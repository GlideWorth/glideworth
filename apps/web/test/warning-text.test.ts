/**
 * Results warnings use the same money formatter as the rest of the app: currency, compact form,
 * the page's money basis, and hide-amounts.
 */
import type { PeriodResult, SimWarning } from "@glideworth/core";
import { afterEach, describe, expect, it } from "vitest";
import { AMOUNT_MASK, formatMoney, setAmountsHidden } from "../src/lib/format";
import { formatWarning } from "../src/lib/warning-text";

const shortfall: SimWarning = {
  code: "SHORTFALL",
  severity: "error",
  message:
    "In 2085, £425,237 of expenses could not be funded: income and every account that could be drawn on were used up (£80,000 more is held in accounts that cannot be withdrawn from yet).",
  template:
    "In 2085, {shortfall} of expenses could not be funded: income and every account that could be drawn on were used up ({locked} more is held in accounts that cannot be withdrawn from yet).",
  periodIndex: 0,
  refs: [],
  amounts: [
    { token: "shortfall", nominal: 425_237.47, measure: "flow" },
    { token: "locked", nominal: 80_000, measure: "stock" },
  ],
};

const period = {
  priceIndex: 4,
  priceIndexStart: 2,
} as PeriodResult;

const money = (v: number) => formatMoney(v, { locale: "en-GB", currency: "GBP", compact: true });

afterEach(() => setAmountsHidden(false));

describe("formatWarning", () => {
  it("formats both amounts in today's money, compact, with a currency symbol", () => {
    const text = formatWarning({ periods: [period] }, shortfall, "real", money);
    // The shortfall is a flow (start-of-year index 2); the locked balance is a stock (end index 4).
    expect(text).toBe(
      "In 2085, £212.6k of expenses could not be funded: income and every account that could be drawn on were used up (£20k more is held in accounts that cannot be withdrawn from yet).",
    );
    expect(text).not.toMatch(/425237|80000|\{shortfall\}|\{locked\}/);
  });

  it("uses future money when that is the basis on screen", () => {
    const text = formatWarning({ periods: [period] }, shortfall, "nominal", money);
    expect(text).toContain("£425.2k");
    expect(text).toContain("£80k");
    expect(text).not.toContain("£212.6k");
  });

  it("masks the figures when amounts are hidden and leaves the year visible", () => {
    setAmountsHidden(true);
    const text = formatWarning({ periods: [period] }, shortfall, "nominal", money);
    expect(text).toContain(`£${AMOUNT_MASK}`);
    expect(text).toContain("2085");
    expect(text).not.toMatch(/425|80/);
  });

  it("leaves a warning with no amount unchanged", () => {
    const plain: SimWarning = {
      code: "DEPLETED",
      severity: "info",
      message: "Cash is depleted in 2085: withdrawals to cover spending.",
      periodIndex: 0,
      refs: [],
    };
    expect(formatWarning({ periods: [period] }, plain, "real", money)).toBe(plain.message);
  });
});
