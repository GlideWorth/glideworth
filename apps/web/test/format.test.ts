import { describe, expect, it } from "vitest";
import {
  currencySymbol,
  formatDay,
  formatMoney,
  formatPercent,
  formatSigned,
  parseLocaleNumber,
  plural,
} from "../src/lib/format";

describe("format", () => {
  it("formats money per locale and currency without hard-coded symbols", () => {
    expect(formatMoney(1234.5, { locale: "en-US", currency: "USD" })).toBe("$1,235");
    expect(formatMoney(1234.5, { locale: "en-GB", currency: "GBP", decimals: 2 })).toBe(
      "£1,234.50",
    );
    expect(formatMoney(1234.5, { locale: "de-DE", currency: "EUR" })).toMatch(/1\.235\s€/);
    expect(formatMoney(2_500_000, { locale: "en-US", currency: "USD", compact: true })).toBe(
      "$2.5M",
    );
    expect(currencySymbol({ locale: "en-CA", currency: "CAD" })).toBe("$");
    expect(currencySymbol({ locale: "en-US", currency: "CAD" })).toBe("CA$");
  });
  it("formats percents", () => {
    expect(formatPercent(0.0725, "en-US", 2)).toBe("7.25%");
  });
  it("parses locale numbers", () => {
    expect(parseLocaleNumber("1,234.56", "en-US")).toBe(1234.56);
    expect(parseLocaleNumber("1.234,56", "de-DE")).toBe(1234.56);
    expect(parseLocaleNumber("£2,000", "en-GB")).toBe(2000);
    expect(parseLocaleNumber("", "en-US")).toBeNull();
  });
  it("uses a true minus sign for negative money and percentages", () => {
    const o = { locale: "en-GB", currency: "GBP" };
    expect(formatMoney(-1500, o)).toBe("−£1,500");
    expect(formatMoney(-1_500_000, { ...o, compact: true })).toBe("−£1.5m");
    expect(formatPercent(-0.025, "en-GB")).toBe("−2.5%");
    expect(formatMoney(1500, o)).toBe("£1,500");
  });
  it("never prints +£0 or −£0 for a signed difference", () => {
    const m = (v: number) => formatMoney(v, { locale: "en-GB", currency: "GBP" });
    expect(formatSigned(0.2, m)).toBe("no change");
    expect(formatSigned(-0.2, m, "—")).toBe("—");
    expect(formatSigned(1200, m)).toBe("+£1,200");
    expect(formatSigned(-300, m)).toBe("−£300");
  });
  it("formats calendar dates in the locale and pluralises counts", () => {
    expect(formatDay("2026-11-15", "en-GB")).toBe("15 Nov 2026");
    expect(plural(1, "plan")).toBe("1 plan");
    expect(plural(3, "plan")).toBe("3 plans");
  });
});
