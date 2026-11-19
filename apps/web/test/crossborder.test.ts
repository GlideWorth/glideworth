/** Web cross-border helpers: when to show cross-border UI, currencies, onboarding. */
import { createUkSampleDocument } from "@glideworth/core/samples";
import { describe, expect, it } from "vitest";
import { isCrossBorder, usPersonAbroad } from "../src/features/crossborder/model";
import { buildSetupDocument, defaultAnswers } from "../src/features/onboarding/build-document";
import { COUNTRY_OPTIONS, currencyOfCountry } from "../src/lib/countries";

describe("cross-border relevance", () => {
  it("a single-country UK household shows no cross-border UI", () => {
    const d = createUkSampleDocument();
    expect(isCrossBorder(d, d.plans[0]!)).toBe(false);
  });

  it("a foreign item, a foreign income or a US citizen abroad turns it on", () => {
    const d = createUkSampleDocument();
    const plan = {
      ...d.plans[0]!,
      income: d.plans[0]!.income.map((e, i) => (i === 0 ? { ...e, country: "AE" } : e)),
    };
    expect(isCrossBorder(d, plan)).toBe(true);
    const foreign = {
      ...d,
      finances: {
        ...d.finances,
        realAssets: [
          {
            ...(d.finances.realAssets[0] ?? {}),
            id: "x",
            name: "Flat",
            type: "house",
            owner: "p-sam",
            currentValue: 1,
            country: "ES",
          } as never,
        ],
      },
    };
    expect(isCrossBorder(foreign, d.plans[0]!)).toBe(true);
    const us = {
      ...d,
      household: { ...d.household, people: [{ ...d.household.people[0]!, citizenships: ["US"] }] },
    };
    expect(usPersonAbroad(us.household)).toBe(true);
    expect(isCrossBorder(us, d.plans[0]!)).toBe(true);
  });
});

describe("UAE in pickers and onboarding", () => {
  it("lists the UAE and its currency", () => {
    expect(COUNTRY_OPTIONS.some((c) => c.value === "AE")).toBe(true);
    expect(currencyOfCountry("AE")).toBe("AED");
  });

  it("a UAE household starts with the dirham peg in its exchange-rate table", () => {
    const a = { ...defaultAnswers("AE"), you: { name: "Sam", birthMonth: "1985-01" } };
    const doc = buildSetupDocument(a, { now: new Date("2026-11-01") });
    expect(doc.household.currency).toBe("AED");
    expect(doc.finances.fxRates?.some((r) => r.from === "AED" && r.to === "USD")).toBe(true);
    const uk = buildSetupDocument(
      { ...defaultAnswers("GB"), you: { name: "Sam", birthMonth: "1985-01" } },
      { now: new Date("2026-11-01") },
    );
    expect(uk.finances.fxRates ?? []).toEqual([]);
  });
});
