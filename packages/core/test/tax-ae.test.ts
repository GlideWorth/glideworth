/** United Arab Emirates: zero personal tax, gratuity, savings schemes, GPSSA, defaults, sample. */
import { describe, expect, it } from "vitest";
import { defaultsForCountry } from "../src/defaults/country.js";
import { simulate } from "../src/engine/simulate.js";
import { createUaeSampleDocument, UAE_SAMPLE_PLAN_ID } from "../src/samples/index.js";

import { buildSimulationInput } from "../src/scenario.js";
import { CURRENCY_PEGS } from "../src/tax/crossborder/currency.js";
import {
  AE_GRATUITY,
  AED_PER_USD,
  aeGpssaContributions,
  aeGpssaReplacementRate,
  aeGratuity,
} from "../src/tax/data/ae.js";
import { TAX_SIMPLIFICATIONS } from "../src/tax/data/simplifications.js";
import { aeJurisdiction } from "../src/tax/jurisdictions/ae.js";
import { createDefaultTaxRegistry, defaultStackIds } from "../src/tax/registry.js";

describe("UAE jurisdiction", () => {
  it("is registered as the AE preset and taxes nothing", () => {
    expect(defaultStackIds({ country: "AE" })).toEqual(["ae"]);
    expect(createDefaultTaxRegistry().get("ae").status).toBe("implemented");
    const out = aeJurisdiction.computeYear(
      {
        year: 2026,
        periodIndex: 0,
        months: 12,
        filingStatus: "single",
        location: { country: "AE" },
        people: [{ id: "me", role: "primary", age: 40, alive: true }],
        dependents: [],
        priceIndex: 1,
        income: [
          { sourceId: "w", owner: "me", character: "wage", amount: 900_000, exemptIn: [] },
          {
            sourceId: "g",
            owner: "me",
            character: "capital-gains-long",
            amount: 500_000,
            exemptIn: [],
          },
          {
            sourceId: "d",
            owner: "me",
            character: "qualified-dividend",
            amount: 50_000,
            exemptIn: [],
          },
        ],
        withdrawals: [],
        deductions: [],
        config: {} as never,
        history: [],
      },
      [],
    );
    expect(out.lines).toEqual([]);
    expect(out.grossIncome).toBe(1_450_000);
    expect(out.marginalRate).toBe(0);
  });

  it("lists what is out of scope (Corporate Tax on business turnover, VAT) and cites official sources", () => {
    const s = TAX_SIMPLIFICATIONS.ae!.join(" ");
    expect(s).toMatch(/Corporate Tax/);
    expect(s).toMatch(/VAT/);
    expect(aeJurisdiction.sources!.every((x) => /tax\.gov\.ae|mof\.gov\.ae/.test(x.url))).toBe(
      true,
    );
  });
});

describe("end-of-service gratuity (Federal Decree-Law 33 of 2021, Art. 51; u.ae)", () => {
  it("21 days a year for five years, 30 after, on the last basic wage, capped at two years of wage", () => {
    // 15,000 basic a month = 500 a day. 11 years: 5 x 21 + 6 x 30 = 285 days = 142,500.
    expect(aeGratuity(11, 15_000)).toBeCloseTo(142_500, 9);
    // Under one year: nothing; 1.5 years pro rata: 31.5 days.
    expect(aeGratuity(0.9, 15_000)).toBe(0);
    expect(aeGratuity(1.5, 15_000)).toBeCloseTo(31.5 * 500, 9);
    // 30 years: 855 days = 427,500 -> capped at 24 x 15,000 = 360,000.
    expect(aeGratuity(30, 15_000)).toBe(360_000);
    expect(AE_GRATUITY.sources[0]!.url).toMatch(/u\.ae/);
  });

  it("is paid by the engine as a lump sum when the salary ends", () => {
    const r = simulate({
      household: {
        id: "h",
        name: "Expat",
        planningMode: "individual",
        people: [{ id: "me", name: "Me", role: "primary", birthMonth: "1985-01" }],
        location: { country: "AE" },
        currency: "AED",
        locale: "en-AE",
      },
      finances: {
        asOf: "2026-01",
        accounts: [{ id: "c", name: "Cash", type: "savings", owner: "me", balance: 0 }],
      },
      plan: {
        id: "p",
        householdId: "h",
        name: "p",
        tax: { mode: "estimate" },
        income: [
          {
            id: "pay",
            name: "Pay",
            type: "salary",
            owner: "me",
            amount: { value: 30_000, basis: "nominal" },
            frequency: "monthly",
            change: { kind: "none" },
            range: { start: { kind: "planStart" }, end: { kind: "date", date: "2031-01" } },
            endOfService: { scheme: "ae-gratuity", serviceStart: "2020-01", basicShare: 0.5 },
          },
        ],
        assumptions: {
          inflation: { kind: "fixed", rate: 0 },
          end: { kind: "ref", ref: { kind: "date", date: "2032-01" } },
        },
      },
      options: { trace: "summary" },
    });
    const y2031 = r.periods.find((p) => p.year === 2031)!;
    const g = y2031.income.find((i) => i.sourceId === "pay:gratuity")!;
    expect(g.amount).toBeCloseTo(142_500, 6);
    expect(
      r.periods.find((p) => p.year === 2030)!.income.some((i) => i.sourceId === "pay:gratuity"),
    ).toBe(false);
    expect(r.periods.every((p) => p.taxes.total === 0)).toBe(true);
  });
});

describe("savings schemes and GPSSA", () => {
  it("federal savings scheme: voluntary top-ups capped at 25% of the wage", () => {
    expect(
      aeJurisdiction.contributionLimit!({
        accountType: "ae-savings-scheme",
        year: 2026,
        ownerAge: 40,
        priceIndex: 1,
        earnedIncome: 240_000,
      }),
    ).toBe(60_000);
    expect(
      aeJurisdiction.contributionLimit!({
        accountType: "ae-dews",
        year: 2026,
        ownerAge: 40,
        priceIndex: 1,
        earnedIncome: 240_000,
      }),
    ).toBeNull();
  });

  it("GPSSA (Law 57 of 2023): 2.67% a year to 30 years, +4% after, at most 100%; 11% / 15% contributions under the AED 70,000 ceiling", () => {
    expect(aeGpssaReplacementRate(20)).toBeCloseTo(0.534, 9);
    expect(aeGpssaReplacementRate(30)).toBeCloseTo(0.801, 9);
    expect(aeGpssaReplacementRate(35)).toBeCloseTo(1, 9);
    expect(aeGpssaContributions(30_000)).toEqual({
      employee: 3_300,
      employer: 4_500,
      government: 0,
    });
    const low = aeGpssaContributions(15_000);
    expect(low.employer).toBeCloseTo(15_000 * 0.125, 9);
    expect(low.government).toBeCloseTo(15_000 * 0.025, 9);
    expect(aeGpssaContributions(90_000).employee).toBeCloseTo(70_000 * 0.11, 9);
  });
});

describe("UAE defaults and sample", () => {
  it("defaultsForCountry(AE): AED, calendar tax year, estimate preset, peg pre-filled, no expatriate state pension", () => {
    const d = defaultsForCountry("AE");
    expect(d.currency).toBe("AED");
    expect(d.tax).toMatchObject({ mode: "estimate", jurisdictions: ["ae"] });
    expect(d.taxYear.yearAlignment).toEqual({ kind: "calendar" });
    expect(d.statePension).toBeNull();
    expect(d.accountTypes.workplacePension).toBe("ae-dews");
    expect(d.fxRates).toEqual([{ from: "AED", to: "USD", rate: 1 / AED_PER_USD, annualDrift: 0 }]);
    expect(CURRENCY_PEGS[0]!.annualDrift).toBe(0);
  });

  it("the synthetic sample simulates; UK tax is only ever charged as a non-resident (source)", () => {
    const doc = createUaeSampleDocument();
    expect(doc.plans.map((p) => p.id)).toEqual([UAE_SAMPLE_PLAN_ID]);
    const stay = simulate(buildSimulationInput(doc, UAE_SAMPLE_PLAN_ID));
    expect(
      stay.periods.every((p) =>
        p.taxes.lines.every((l) => l.country !== "GB" || l.basis === "source"),
      ),
    ).toBe(true);
    expect(stay.periods.some((p) => p.income.some((i) => i.sourceId.endsWith(":gratuity")))).toBe(
      true,
    );
  });
});
