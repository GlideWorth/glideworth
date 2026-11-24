import { createUkSampleDocument } from "@glideworth/core/samples";
import { describe, expect, it } from "vitest";
import { describeCountryChange } from "../src/features/finances/country-change";

describe("changing household country", () => {
  const uk = createUkSampleDocument().household;

  it("asks before flipping GBP to USD and requires a state", () => {
    const change = describeCountryChange(uk, "US");
    expect(change.needsConfirm).toBe(true);
    expect(change.currencyFrom).toBe("GBP");
    expect(change.currencyTo).toBe("USD");
    expect(change.localeFrom).toBe("en-GB");
    expect(change.localeTo).toBe("en-US");
    expect(change.regionLabel).toBe("State");
    expect(change.regions.length).toBeGreaterThan(50);
    expect(change.region).toBeUndefined();
    expect(change.regions.some((r) => r.value === "CA")).toBe(true);
  });

  it("asks about currency for a country with no region, and does not invent one", () => {
    const change = describeCountryChange(uk, "DE");
    expect(change.needsConfirm).toBe(true);
    expect(change.currencyTo).toBe("EUR");
    expect(change.regions).toEqual([]);
    expect(change.regionLabel).toBeNull();
  });

  it("does not flip a currency the household already chose, but still asks for a state", () => {
    const custom = { ...uk, currency: "EUR", locale: "en-GB" };
    const change = describeCountryChange(custom, "US");
    expect(change.currencyFrom).toBeNull();
    expect(change.currencyTo).toBeNull();
    expect(change.needsConfirm).toBe(true);
    expect(change.regionLabel).toBe("State");
  });

  it("applies a country's default region without asking when nothing else would change", () => {
    const us = {
      ...uk,
      location: { country: "US", region: "CA" },
      currency: "GBP",
      locale: "en-GB",
    };
    const change = describeCountryChange(us, "GB");
    expect(change.currencyFrom).toBeNull();
    expect(change.localeFrom).toBeNull();
    expect(change.needsConfirm).toBe(false);
    expect(change.region).toBe("ENG");
  });
});
