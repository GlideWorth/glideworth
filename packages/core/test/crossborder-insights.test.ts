/** Cross-border insights and data tables: audit checks, relocation template, stay-or-move, IHT scope, treaties. */
import { describe, expect, it } from "vitest";
import { simulate } from "../src/engine/simulate.js";
import { SimulationInput, type SimulationInputInput } from "../src/engine/types.js";
import { incomeByTaxRateForInput, netLegacyAtEnd } from "../src/insights/analytics.js";
import { auditAssumptions } from "../src/insights/audit.js";
import {
  CROSS_BORDER_TEMPLATES,
  compareStayingVersusMoving,
  crossBorderFindings,
  relocationScenario,
  residencyTimelineOf,
  ukInheritanceTaxScope,
} from "../src/insights/crossborder.js";
import { applyPlanPatch } from "../src/insights/patch.js";
import { explainCrossBorderTreatment } from "../src/tax/crossborder/explain.js";
import { NON_RESIDENT_RULES } from "../src/tax/crossborder/nonresident.js";
import { TREATIES, treatyRule } from "../src/tax/crossborder/treaties.js";
import { INCOME_CATEGORIES } from "../src/tax/crossborder/types.js";
import {
  ukIhtTailYears,
  ukIhtWorldwideScope,
  ukStatePensionUprated,
} from "../src/tax/crossborder/uk.js";
import { wrapperView } from "../src/tax/crossborder/wrappers.js";

function ukHousehold(
  plan: Partial<SimulationInputInput["plan"]> = {},
  people?: unknown[],
): SimulationInput {
  return SimulationInput.parse({
    household: {
      id: "h",
      name: "H",
      planningMode: "individual",
      people: people ?? [
        { id: "me", name: "Sam", role: "primary", birthMonth: "1975-05", citizenships: ["GB"] },
      ],
      location: { country: "GB", region: "ENG" },
      currency: "GBP",
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

const move = (country: string, date: string) => ({
  id: `m-${country}-${date}`,
  from: { kind: "date", date },
  location: { country },
});

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
    expect(treatyRule("GB", "US", "state-pension")).toMatchObject({
      sourceMayTax: true,
      residenceTaxes: false,
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

  it("UK State Pension uprating abroad and the IHT long-term residence tail (gov.uk; IHTM47020)", () => {
    expect(ukStatePensionUprated("ES")).toBe(true);
    expect(ukStatePensionUprated("US")).toBe(true);
    expect(ukStatePensionUprated("AE")).toBe(false);
    expect(ukStatePensionUprated("CA")).toBe(false);
    expect(ukIhtTailYears(9)).toBe(0);
    expect(ukIhtTailYears(12)).toBe(3);
    expect(ukIhtTailYears(15)).toBe(5);
    expect(ukIhtTailYears(20)).toBe(10);
    const years = new Set(Array.from({ length: 15 }, (_, i) => 2012 + i)); // resident 2012-2026
    expect(ukIhtWorldwideScope(years, 2026).inScope).toBe(true);
    expect(ukIhtWorldwideScope(years, 2031).inScope).toBe(true); // 5-year tail: 2027-2031
    expect(ukIhtWorldwideScope(years, 2032).inScope).toBe(false);
  });
});

describe("insights", () => {
  it("residency timeline as data", () => {
    const input = ukHousehold({ residency: [move("AE", "2028-04")] } as never);
    expect(residencyTimelineOf(input)).toEqual([
      {
        personId: "me",
        from: null,
        location: { country: "GB", region: "ENG" },
        source: "household",
      },
      {
        personId: "me",
        from: "2028-04",
        location: { country: "AE" },
        source: "residency",
        refId: "m-AE-2028-04",
      },
    ]);
  });

  it("audit: wrapper funded while abroad, return within five years, State Pension gap, unknown treaty, missing FX", () => {
    const input = ukHousehold(
      {
        residency: [move("AE", "2027-04"), move("GB", "2030-04"), move("NZ", "2032-04")],
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
      [
        {
          id: "me",
          name: "Sam",
          role: "primary",
          birthMonth: "1975-05",
          citizenships: ["GB"],
          statePensionRecords: [{ country: "GB", qualifyingYears: 18 }],
        },
      ],
    );
    const codes = auditAssumptions(input).map((f) => f.code);
    expect(codes).toContain("XB_WRAPPER_NON_RESIDENT_CONTRIBUTIONS");
    expect(codes).toContain("XB_UK_TEMPORARY_NON_RESIDENCE");
    expect(codes).toContain("XB_STATE_PENSION_GAP");
    expect(codes).toContain("XB_UNKNOWN_TREATY");
    expect(codes).toContain("XB_TAX_FX_MISSING"); // no NZD rate
    const gap = crossBorderFindings(input).find((f) => f.code === "XB_STATE_PENSION_GAP")!;
    expect(gap.message).toMatch(/Class 3/);
    // Planned voluntary years count towards the projected record (and can close the gap).
    const withVoluntary = SimulationInput.parse({
      ...input,
      household: {
        ...input.household,
        people: [
          {
            ...input.household.people[0]!,
            statePensionRecords: [{ country: "GB", qualifyingYears: 18, voluntaryYears: 3 }],
          },
        ],
      },
    });
    const gap2 = crossBorderFindings(withVoluntary).find((f) => f.code === "XB_STATE_PENSION_GAP");
    expect(gap2?.message ?? "").toMatch(/3 voluntary years/);
    const full = SimulationInput.parse({
      ...withVoluntary,
      household: {
        ...withVoluntary.household,
        people: [
          {
            ...withVoluntary.household.people[0]!,
            statePensionRecords: [{ country: "GB", qualifyingYears: 18, voluntaryYears: 17 }],
          },
        ],
      },
    });
    expect(crossBorderFindings(full).some((f) => f.code === "XB_STATE_PENSION_GAP")).toBe(false);
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
    const moved = ukHousehold({ residency: [move("NZ", "2032-04")] } as never);
    const nz = crossBorderFindings(moved).find((x) => x.code === "XB_UNKNOWN_TREATY");
    if (nz) expect(nz.title).not.toMatch(/\b[A-Z]{2}-[A-Z]{2}\b/);
  });

  it("audit adds nothing for a single-country plan", () => {
    expect(crossBorderFindings(ukHousehold())).toEqual([]);
  });

  it("relocation what-if template and the stay-or-move comparison", () => {
    expect(CROSS_BORDER_TEMPLATES.some((t) => t.id === "relocation")).toBe(true);
    const input = ukHousehold({
      income: [
        {
          id: "pay",
          name: "Pay",
          type: "salary",
          owner: "me",
          amount: { value: 80_000 },
          frequency: "yearly",
          range: { start: { kind: "planStart" }, end: { kind: "planEnd" } },
        },
      ],
    } as never);
    const t = relocationScenario(input, {
      to: { country: "AE" },
      month: "2028-04",
      returnMonth: "2033-04",
    });
    const plan = applyPlanPatch(input.plan, t.patch);
    expect(plan.residency).toHaveLength(2);
    expect(t.notes.join(" ")).toMatch(/5 years or less/);
    const c = compareStayingVersusMoving(input, { to: { country: "AE" }, month: "2028-04" });
    expect(c.diff.patch.length).toBeGreaterThan(0);
    // UK pay keeps being taxed in the UK (sourced where earned is the residence: default) - here the
    // salary has no country, so after the move it is UAE pay and the UK residence tax disappears.
    expect(c.deltas.lifetimeTaxesReal).toBeLessThan(0);
    const ukResidence = c.taxesByCountry.find(
      (r) => r.country === "GB" && r.basis === "residence",
    )!;
    expect(ukResidence.delta).toBeLessThan(0);
    expect(c.attribution.reduce((s, a) => s + a.delta, 0)).toBeCloseTo(c.deltas.endNetWorthReal, 6);
  });

  it("UK inheritance tax after leaving: worldwide estate within the tail, UK assets only after it", () => {
    const input = ukHousehold({ residency: [move("AE", "2027-04")] } as never);
    // Resident since birth (1975) to 2026: 20 of the last 20 years -> 10-year tail (to 2036-37).
    expect(ukInheritanceTaxScope(input, "me", 2030).inScope).toBe(true);
    expect(ukInheritanceTaxScope(input, "me", 2037).inScope).toBe(false);
    const r = simulate(input);
    const legacy = netLegacyAtEnd(input, r);
    expect(legacy.estateTax).toBeGreaterThanOrEqual(0);
  });

  it("Monte Carlo trials of a cross-border plan run in lean mode", () => {
    const input = ukHousehold({ residency: [move("AE", "2027-04")] } as never);
    const r = simulate({ ...input, options: { ...input.options, lean: true, trace: "off" } });
    expect(r.periods.length).toBe(10);
  });

  it("analytics keep working with several jurisdictions in a year: brackets per country, effective and marginal rates", () => {
    const input = ukHousehold({
      residency: [move("AE", "2027-10")],
      income: [
        {
          id: "pay",
          name: "Pay",
          type: "salary",
          owner: "me",
          country: "GB",
          amount: { value: 60_000 },
          frequency: "yearly",
          range: { start: { kind: "planStart" }, end: { kind: "planEnd" } },
        },
      ],
    } as never);
    const m = incomeByTaxRateForInput(input, { jurisdictionId: "uk" });
    const y = m.years.indexOf(2027);
    expect(m.cells[y]!.reduce((s, x) => s + x, 0)).toBeGreaterThan(0);
    const r = simulate({ ...input, options: { ...input.options, trace: "full" } });
    const p = r.periods.find((x) => x.year === 2027)!;
    // UK pay is UK-sourced: taxed as resident for 6 months and as non-resident for 6 (both 'uk').
    expect(p.taxes.byCountry!.map((b) => b.basis).sort()).toEqual(["residence", "source"]);
    expect(p.taxes.brackets!.filter((b) => b.jurisdictionId === "uk").length).toBeGreaterThan(1);
    expect(p.taxes.effectiveRate).toBeCloseTo(p.taxes.total / p.taxes.grossIncome, 12);
    // One more unit of income spread over the year: half while UK-resident (40% band), half in the UAE.
    expect(p.taxes.marginalRate).toBeCloseTo(0.2, 6);
  });
});
