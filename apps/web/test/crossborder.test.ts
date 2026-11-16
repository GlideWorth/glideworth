/** Web cross-border helpers: when to show cross-border UI, residence segments, currencies, onboarding. */
import { simulate } from "@glideworth/core";
import {
  createUaeSampleDocument,
  createUkSampleDocument,
  UAE_RETURN_PLAN_ID,
} from "@glideworth/core/samples";
import { describe, expect, it } from "vitest";
import {
  hasMoves,
  isCrossBorder,
  residenceSegments,
  usPersonAbroad,
} from "../src/features/crossborder/model";
import { buildSetupDocument, defaultAnswers } from "../src/features/onboarding/build-document";
import { timeContext } from "../src/features/plan-editor/state/resolve";
import { COUNTRY_OPTIONS, currencyOfCountry, locationLabel } from "../src/lib/countries";

describe("cross-border relevance", () => {
  it("a never-moved UK household shows no cross-border UI", () => {
    const d = createUkSampleDocument();
    expect(isCrossBorder(d, d.plans[0]!)).toBe(false);
    expect(hasMoves(d.plans[0]!)).toBe(false);
  });

  it("a move, a foreign item or a US citizen abroad turns it on", () => {
    const d = createUkSampleDocument();
    const plan = {
      ...d.plans[0]!,
      residency: [
        {
          id: "m",
          from: { kind: "date" as const, date: "2030-01", offsetMonths: 0 },
          location: { country: "AE" },
        },
      ],
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

  it("residence segments follow dated moves and relocation milestones per person", () => {
    const d = createUaeSampleDocument();
    const plan = d.plans.find((p) => p.id === UAE_RETURN_PLAN_ID)!;
    const result = simulate({
      household: d.household,
      finances: d.finances,
      plan,
      options: { trace: "off" },
    } as never);
    const segs = residenceSegments(plan, d.household, timeContext(d, plan, result));
    const noor = segs.filter((s) => s.personId === "p-noor").map((s) => s.location.country);
    expect(noor).toEqual(["AE", "GB"]);
  });
});

describe("UAE in pickers and onboarding", () => {
  it("lists the UAE, its currency and emirates", () => {
    expect(COUNTRY_OPTIONS.some((c) => c.value === "AE")).toBe(true);
    expect(currencyOfCountry("AE")).toBe("AED");
    expect(locationLabel({ country: "AE", region: "DU" })).toBe("Dubai, United Arab Emirates");
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
