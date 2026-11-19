/** Cross-border insights and data tables: audit checks, treaties, wrappers, analytics for foreign items. */
import { describe, expect, it } from "vitest";
import { simulate } from "../src/engine/simulate.js";
import { SimulationInput, type SimulationInputInput } from "../src/engine/types.js";
import { incomeByTaxRateForInput } from "../src/insights/analytics.js";
import { auditAssumptions } from "../src/insights/audit.js";
import { crossBorderFindings } from "../src/insights/crossborder.js";
import { explainCrossBorderTreatment } from "../src/tax/crossborder/explain.js";
import { NON_RESIDENT_RULES } from "../src/tax/crossborder/nonresident.js";
import { TREATIES, treatyRule } from "../src/tax/crossborder/treaties.js";
import { INCOME_CATEGORIES } from "../src/tax/crossborder/types.js";
import { wrapperView } from "../src/tax/crossborder/wrappers.js";

function ukHousehold(
  plan: Partial<SimulationInputInput["plan"]> = {},
  people?: unknown[],
  home: { location?: { country: string; region?: string }; currency?: string } = {},
): SimulationInput {
  return SimulationInput.parse({
    household: {
      id: "h",
      name: "H",
      planningMode: "individual",
      people: people ?? [
        { id: "me", name: "Sam", role: "primary", birthMonth: "1975-05", citizenships: ["GB"] },
      ],
      location: home.location ?? { country: "GB", region: "ENG" },
      currency: home.currency ?? "GBP",
      locale: "en-GB",
    },
    finances: {
      asOf: "2026-04",
      accounts: [
        { id: "cash", name: "Cash", type: "savings", owner: "me", balance: 50_000 },
        { id: "isa", name: "ISA", type: "uk-isa", owner: "me", balance: 80_000 },
        {
          id: "gia",
          name: "GIA",
          type: "uk-gia",
          owner: "me",
          balance: 100_000,
          costBasis: 50_000,
        },
      ],
      fxRates: [{ from: "AED", to: "GBP", rate: 0.2, annualDrift: 0 }],
    },
    plan: {
      id: "p",
      householdId: "h",
      name: "Plan",
      tax: { mode: "estimate" },
      assumptions: {
        yearAlignment: { kind: "fiscal", startMonth: 4 },
        end: { kind: "ref", ref: { kind: "date", date: "2036-04" } },
      },
      ...plan,
    },
    options: { trace: "summary" },
  });
}

describe("data tables", () => {
  it("every supported country has a non-resident table covering every income category, with a depth label", () => {
    for (const c of ["GB", "US", "CA", "AU", "DE", "NL", "FR", "ES", "IL", "IE", "NZ", "AE"]) {
      const t = NON_RESIDENT_RULES[c]!;
      expect(t, c).toBeDefined();
      for (const cat of INCOME_CATEGORIES) expect(t.rules[cat], `${c}.${cat}`).toBeDefined();
      expect(t.simplifications.length).toBeGreaterThan(0);
    }
    expect(NON_RESIDENT_RULES.GB!.depth).toBe("high");
    expect(
      NON_RESIDENT_RULES.GB!.sources.every((s) => s.url.startsWith("https://www.gov.uk/")),
    ).toBe(true);
  });

  it("UK-UAE treaty (2016): pensions and the State Pension to the residence country, rent and property gains shared, government pensions to the UK", () => {
    expect(treatyRule("AE", "GB", "private-pension")).toMatchObject({
      sourceMayTax: false,
      residenceTaxes: true,
    });
    expect(treatyRule("AE", "GB", "state-pension").sourceMayTax).toBe(false);
    expect(treatyRule("AE", "GB", "rental")).toMatchObject({
      sourceMayTax: true,
      residenceTaxes: true,
    });
    expect(treatyRule("AE", "GB", "gains-property").sourceMayTax).toBe(true);
    expect(treatyRule("AE", "GB", "gains-securities").sourceMayTax).toBe(false);
    expect(treatyRule("AE", "GB", "government-pension")).toMatchObject({
      sourceMayTax: true,
      residenceTaxes: false,
    });
    expect(
      treatyRule("AE", "GB", "government-pension", { nationalOfResidence: true }),
    ).toMatchObject({
      sourceMayTax: false,
      residenceTaxes: true,
    });
    expect(TREATIES.find((t) => t.pair.join() === "AE,GB")!.depth).toBe("high");
    // UK-US Art. 17(3): social security paid to a resident of the other State is taxable only
    // there (corrected 2026-11-19; it was the paying State before).
    expect(treatyRule("GB", "US", "state-pension")).toMatchObject({
      sourceMayTax: false,
      residenceTaxes: true,
    });
    expect(treatyRule("SG", "GB", "rental").known).toBe(false);
  });

  it("wrappers: foreign tax-free accounts are not recognised by default; the UAE shelters everything", () => {
    expect(wrapperView("ES", "GB", "uk-isa", "tax-free").recognised).toBe(false);
    expect(wrapperView("ES", "GB", "uk-sipp", "tax-deferred")).toMatchObject({
      recognised: true,
      lumpSumTaxFree: false,
    });
    expect(wrapperView("AE", "GB", "uk-isa", "tax-free").recognised).toBe(true);
    expect(wrapperView("ES", "GB", "uk-isa", "tax-free", { "ES:GB:uk-isa": true }).recognised).toBe(
      true,
    );
  });

  it("explains how an item is taxed and why", () => {
    const e = explainCrossBorderTreatment({ residence: "AE", source: "GB", category: "rental" });
    expect(e).toMatchObject({
      sourceTaxes: true,
      residenceTaxes: true,
      relief: "credit",
      unknownTreaty: false,
    });
    expect(e.steps.join(" ")).toMatch(/Art\. 6/);
    const p = explainCrossBorderTreatment({
      residence: "AE",
      source: "GB",
      category: "private-pension",
    });
    expect(p.sourceTaxes).toBe(false);
  });
});

describe("insights", () => {
  it("audit: wrapper funded from abroad, unknown treaty, foreign asset without a currency, missing tax FX", () => {
    const input = ukHousehold(
      {
        flows: [
          {
            kind: "contribution",
            id: "f-isa",
            name: "ISA saving",
            owner: "me",
            accountId: "isa",
            range: { start: { kind: "planStart" }, end: { kind: "planEnd" } },
            method: { kind: "amount", amount: { value: 5_000 }, frequency: "yearly" },
          },
        ],
      } as never,
      undefined,
      { location: { country: "NZ" }, currency: "NZD" },
    );
    const findings = auditAssumptions(input);
    const codes = findings.map((f) => f.code);
    expect(codes).toContain("XB_WRAPPER_NON_RESIDENT_CONTRIBUTIONS");
    expect(codes).toContain("XB_UNKNOWN_TREATY"); // no NZ-GB treaty in the tables
    expect(codes).toContain("XB_FOREIGN_ASSET_BASE_CURRENCY"); // the ISA and GIA have no currency
    expect(codes).toContain("XB_TAX_FX_MISSING"); // no GBP/NZD rate
    expect(findings.find((f) => f.code === "XB_WRAPPER_NON_RESIDENT_CONTRIBUTIONS")!.refs).toEqual([
      "f-isa",
      "isa",
    ]);
  });

  it("the unknown-treaty finding names countries in words, never the 'XX' placeholder", () => {
    // A ProjectionLab import with location 'OTHER' lands as XX ("somewhere else") with UK accounts.
    const base = ukHousehold();
    const elsewhere = SimulationInput.parse({
      ...base,
      household: { ...base.household, location: { country: "XX" } },
    });
    const f = crossBorderFindings(elsewhere).filter((x) => x.code === "XB_UNKNOWN_TREATY");
    expect(f.length).toBeGreaterThan(0);
    for (const x of f) {
      expect(x.title).not.toMatch(/\bXX\b/);
      expect(x.message).not.toMatch(/\bXX\b/);
      expect(x.title).toContain("United Kingdom");
    }
    const nzHome = ukHousehold({}, undefined, { location: { country: "NZ" } });
    const nz = crossBorderFindings(nzHome).find((x) => x.code === "XB_UNKNOWN_TREATY")!;
    expect(nz.title).toBe("No New Zealand-United Kingdom treaty in Glideworth's tables");
  });

  it("audit adds nothing for a single-country plan", () => {
    expect(crossBorderFindings(ukHousehold())).toEqual([]);
  });

  it("Monte Carlo trials of a cross-border plan run in lean mode", () => {
    const input = ukHousehold({}, undefined, { location: { country: "AE" } });
    const r = simulate({ ...input, options: { ...input.options, lean: true, trace: "off" } });
    expect(r.periods.length).toBe(10);
  });

  it("analytics keep working with several jurisdictions in a year: brackets, effective and marginal rates", () => {
    // UK resident with UK pay and a rented flat in Spain (synthetic). Spain: IRNR 24% of gross rent;
    // the UK taxes the rent too and credits the Spanish tax up to the UK tax on it (UK-ES treaty Art. 6).
    const base = ukHousehold({
      income: [
        {
          id: "pay",
          name: "Pay",
          type: "salary",
          owner: "me",
          amount: { value: 30_000, basis: "nominal" },
          frequency: "yearly",
          change: { kind: "none" },
          range: { start: { kind: "planStart" }, end: { kind: "planEnd" } },
        },
      ],
    } as never);
    const input = SimulationInput.parse({
      ...base,
      finances: {
        ...base.finances,
        // Cash only (its interest is inside the £1,000 Personal Savings Allowance), no dividends.
        accounts: base.finances.accounts.filter((a) => a.id === "cash"),
        fxRates: [{ from: "EUR", to: "GBP", rate: 0.85, annualDrift: 0 }],
        realAssets: [
          {
            id: "es-flat",
            name: "Flat in Spain",
            type: "rental-property",
            owner: "me",
            currentValue: 200_000,
            country: "ES",
            behaviour: {
              usage: "investment",
              appreciation: { kind: "none" },
              rental: {
                enabled: true,
                income: { kind: "amountPerYear", amount: { value: 10_000, basis: "nominal" } },
                taxSettings: { estimateDeductions: false },
              },
            },
          },
        ],
      },
    });
    const m = incomeByTaxRateForInput(input, { jurisdictionId: "uk" });
    const y = m.years.indexOf(2026);
    expect(m.cells[y]!.reduce((s, x) => s + x, 0)).toBeGreaterThan(0);
    const r = simulate({ ...input, options: { ...input.options, trace: "full" } });
    const p = r.periods.find((x) => x.year === 2026)!;
    expect(p.taxes.byCountry!.map((b) => `${b.country}|${b.basis}`).sort()).toEqual([
      "ES|source",
      "GB|relief",
      "GB|residence",
    ]);
    // UK income tax on pay and rent (40,000 - 12,570) x 20% = 5,486, NI 8% x (30,000 - 12,570) = 1,394.40; Spain
    // 10,000 x 24% = 2,400; credit = the UK tax on the rent, 10,000 x 20% = 2,000 (less than 2,400).
    expect(p.taxes.total).toBeCloseTo(5_486 + 1_394.4 + 2_400 - 2_000, 4);
    expect(p.taxes.brackets!.some((b) => b.jurisdictionId === "uk")).toBe(true);
    expect(p.taxes.effectiveRate).toBeCloseTo(p.taxes.total / p.taxes.grossIncome, 12);
    // One more pound of UK income is taxed at 20%; the credit is unchanged.
    expect(p.taxes.marginalRate).toBeCloseTo(0.2, 6);
  });
});
