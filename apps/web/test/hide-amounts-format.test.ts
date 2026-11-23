import { afterEach, describe, expect, it } from "vitest";
import {
  AMOUNT_MASK,
  formatMoney,
  formatPercent,
  formatSigned,
  maskAmountsInText,
  maskedMoney,
  setAmountsHidden,
  speakAmounts,
} from "../src/lib/format";
import { makeFormatter } from "../src/lib/workspace";

const usd = { locale: "en-US", currency: "USD" };
const gbp = { locale: "en-GB", currency: "GBP" };

afterEach(() => setAmountsHidden(false));

describe("hide amounts: the money formatter", () => {
  it("shows amounts normally until hiding is turned on", () => {
    expect(formatMoney(1234, usd)).toBe("$1,234");
    expect(maskAmountsInText("You could spend $1,200 more")).toBe("You could spend $1,200 more");
  });

  it("keeps the currency symbol where the locale puts it and masks the digits", () => {
    setAmountsHidden(true);
    expect(formatMoney(1234, usd)).toBe(`$${AMOUNT_MASK}`);
    expect(formatMoney(1234, gbp)).toBe(`£${AMOUNT_MASK}`);
    expect(formatMoney(1234, { locale: "de-DE", currency: "EUR" })).toBe(`${AMOUNT_MASK} €`);
    expect(formatMoney(1234, { locale: "en-US", currency: "CAD" })).toBe(`CA$${AMOUNT_MASK}`);
  });

  it("never reveals magnitude or sign: every amount masks to the same width", () => {
    setAmountsHidden(true);
    const outs = [0, 7, 1234.56, -98_765, 12_345_678, 4.2e9].flatMap((v) => [
      formatMoney(v, usd),
      formatMoney(v, { ...usd, compact: true }),
      formatMoney(v, { ...usd, decimals: 2 }),
    ]);
    expect(new Set(outs)).toEqual(new Set([`$${AMOUNT_MASK}`]));
  });

  it("hides the direction and zero-ness of signed differences", () => {
    setAmountsHidden(true);
    const m = (v: number) => formatMoney(v, gbp);
    expect(formatSigned(1200, m)).toBe(`£${AMOUNT_MASK}`);
    expect(formatSigned(-300, m)).toBe(`£${AMOUNT_MASK}`);
    expect(formatSigned(0.1, m)).toBe(`£${AMOUNT_MASK}`);
  });

  it("keeps percentages and non-money numbers visible", () => {
    setAmountsHidden(true);
    expect(formatPercent(0.0725, "en-US", 2)).toBe("7.25%");
    const f = makeFormatter(usd);
    expect(f.percent(0.85, 0)).toBe("85%");
    expect(f.number(2026)).toBe("2,026");
    expect(f.money(500)).toBe(`$${AMOUNT_MASK}`);
    expect(f.moneyIn(500, "EUR")).toBe(`€${AMOUNT_MASK}`);
    expect(f.signed(-500, true)).toBe(`$${AMOUNT_MASK}`);
  });

  it("reveals a figure that must always show (format previews)", () => {
    setAmountsHidden(true);
    expect(formatMoney(1234, { ...usd, reveal: true })).toBe("$1,234");
  });

  it("formats with the mask only, not a leftover non-finite dash", () => {
    setAmountsHidden(true);
    expect(formatMoney(Number.NaN, usd)).toBe("–");
    expect(maskedMoney({ locale: "en-US", currency: "CHF" })).toBe(`CHF ${AMOUNT_MASK}`);
  });
});

describe("hide amounts: money inside prose", () => {
  it("masks figures next to a symbol or currency code, in either order", () => {
    setAmountsHidden(true);
    expect(maskAmountsInText("You could spend $1,200 more a year")).toBe(
      `You could spend $${AMOUNT_MASK} more a year`,
    );
    expect(maskAmountsInText("Net worth falls by −£3.4m by 2050")).toBe(
      `Net worth falls by £${AMOUNT_MASK} by 2050`,
    );
    expect(maskAmountsInText("Spending: 1.234 € a month")).toBe(
      `Spending: ${AMOUNT_MASK} € a month`,
    );
    expect(maskAmountsInText("Fees of CHF 950 and A$2,000")).toBe(
      `Fees of CHF ${AMOUNT_MASK} and A$${AMOUNT_MASK}`,
    );
    expect(maskAmountsInText("from $12k to $1.5M")).toBe(`from $${AMOUNT_MASK} to $${AMOUNT_MASK}`);
  });

  it("leaves years, ages, counts, percentages and acronyms alone", () => {
    setAmountsHidden(true);
    const s = "Retire in 2041 at age 62; 85% chance over 1,000 trials; ISA 2026 and RMD 73";
    expect(maskAmountsInText(s)).toBe(s);
  });
});

describe("hide amounts: screen readers", () => {
  it("reads a hidden amount as 'amount hidden', never as dots", () => {
    setAmountsHidden(true);
    const spoken = speakAmounts(`Net worth ${formatMoney(1, usd)} in 2050`);
    expect(spoken).toBe("Net worth amount hidden in 2050");
    expect(speakAmounts(formatMoney(1, { locale: "de-DE", currency: "EUR" }))).toBe(
      "amount hidden",
    );
    expect(speakAmounts("(+£•••••)")).toBe("amount hidden");
    expect(speakAmounts("85% chance")).toBe("85% chance");
  });
});
