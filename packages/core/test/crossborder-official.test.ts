/**
 * Assets abroad: the rules checked against official sources on 2026-11-19 (treaty texts, IRS,
 * HMRC, Revenue, Agencia Tributaria, BOFiP, §50 EStG). Each test names the article or page its
 * expectation comes from. All households and figures are invented.
 */
import { describe, expect, it } from "vitest";
import { simulate } from "../src/engine/simulate.js";
import type { PeriodResult, SimulationInputInput, TaxLine } from "../src/engine/types.js";
import { NON_RESIDENT_RULES } from "../src/tax/crossborder/nonresident.js";
import { citizenshipMayTax, treatyRule } from "../src/tax/crossborder/treaties.js";
import { wrapperView } from "../src/tax/crossborder/wrappers.js";
import { deJurisdiction, deTariff } from "../src/tax/jurisdictions/de.js";
import { usFederalJurisdiction } from "../src/tax/jurisdictions/us-federal.js";
import { DE_YEARS } from "../src/tax/data/de.js";
import { taxInput, total } from "./tax-helpers.js";

const ZERO = {
  inflation: { kind: "fixed" as const, rate: 0 },
  stockReturn: { kind: "fixed" as const, rate: 0 },
  dividendYield: { kind: "fixed" as const, rate: 0 },
  bondReturn: { kind: "fixed" as const, rate: 0 },
  bondYield: { kind: "fixed" as const, rate: 0 },
  cashReturn: { kind: "fixed" as const, rate: 0 },
};
const always = { start: { kind: "planStart" as const }, end: { kind: "planEnd" as const } };
const sum = (ls: TaxLine[]) => ls.reduce((s, l) => s + l.amount, 0);
const linesOf = (p: PeriodResult, f: (l: TaxLine) => boolean) => sum(p.taxes.lines.filter(f));

/** One person, calendar years from 2026, zero growth; `income` in the household currency. */
function household(o: {
  country: string;
  currency: string;
  citizenships: string[];
  birthMonth?: string;
  income: { type: string; amount: number; country?: string }[];
  fx?: { from: string; to: string; rate: number }[];
}): SimulationInputInput {
  return {
    household: {
      id: "h",
      name: "Household",
      planningMode: "individual",
      people: [
        {
          id: "me",
          name: "Me",
          role: "primary",
          birthMonth: o.birthMonth ?? "1980-06",
          citizenships: o.citizenships,
        },
      ],
      location: { country: o.country },
      currency: o.currency,
      locale: "en-GB",
    },
    finances: {
      asOf: "2025-12",
      accounts: [{ id: "cash", name: "Cash", type: "savings", owner: "me", balance: 1_000_000 }],
      realAssets: [],
      fxRates: (o.fx ?? []).map((r) => ({ annualDrift: 0, ...r })),
    },
    plan: {
      id: "p",
      householdId: "h",
      name: "Plan",
      tax: { mode: "estimate" },
      income: o.income.map((i, n) => ({
        id: `inc${n}`,
        name: i.type,
        type: i.type,
        owner: "me",
        amount: { value: i.amount, basis: "nominal" },
        frequency: "yearly",
        change: { kind: "none" },
        range: always,
        ...(i.country ? { country: i.country } : {}),
      })) as never,
      assumptions: {
        ...ZERO,
        yearAlignment: { kind: "calendar" },
        end: { kind: "ref", ref: { kind: "date", date: "2027-12" } },
      },
    },
    options: { trace: "summary" },
  };
}

describe("US citizens abroad", () => {
  it("FEIE amounts: $130,000 (2025), $132,900 (2026, Rev. Proc. 2025-32 §4.39), $137,300 (2027, Rev. Proc. 2026-35 §3.41)", () => {
    expect(NON_RESIDENT_RULES.US!.citizenshipTaxation!.foreignEarnedIncomeExclusion).toEqual([
      { year: 2025, amount: 130_000 },
      { year: 2026, amount: 132_900 },
      { year: 2027, amount: 137_300 },
    ]);
  });

  it("stacking rule: the pay above the exclusion is taxed at the rates that would apply without it (Publication 54; Form 2555 worksheet)", () => {
    // Single, 2026, $200,000 of UAE pay, no other income; the UAE taxes nothing.
    // Rev. Proc. 2025-32: standard deduction $16,100 (§4.14); single rates (§4.01 Table 3):
    // $17,966 plus 24% over $105,700.
    //   tax on 200,000 - 16,100 = 183,900:  17,966 + 24% x 78,200 = 36,734
    //   tax on the excluded 132,900:        17,966 + 24% x 27,200 = 24,494
    //   US tax = 36,734 - 24,494 = 12,240 (without stacking it would be 5,932).
    const r = simulate(
      household({
        country: "AE",
        currency: "USD",
        citizenships: ["US"],
        income: [{ type: "salary", amount: 200_000 }],
        fx: [{ from: "AED", to: "USD", rate: 0.2723 }],
      }),
    );
    const p = r.periods.find((x) => x.year === 2026)!;
    expect(linesOf(p, (l) => l.country === "US")).toBeCloseTo(12_240, 2);
    expect(p.taxes.facts["us.feie.me"]).toBeCloseTo(132_900, 6);
    expect(linesOf(p, (l) => l.country === "AE")).toBeCloseTo(0, 6);
  });

  it("pay under the exclusion: no US tax (stacking never makes it negative)", () => {
    const r = simulate(
      household({
        country: "AE",
        currency: "USD",
        citizenships: ["US"],
        income: [{ type: "salary", amount: 100_000 }],
        fx: [{ from: "AED", to: "USD", rate: 0.2723 }],
      }),
    );
    const p = r.periods.find((x) => x.year === 2026)!;
    expect(linesOf(p, (l) => l.country === "US")).toBeCloseTo(0, 6);
  });

  it("no credit for foreign tax on excluded pay (Publication 514, Taxes on Excluded Income): UK tax on the excluded share is not credited", () => {
    // US citizen in the UK, £150,000 of UK pay = $187,500 at 1.25. Without the disallowance the UK
    // tax would wipe out the US tax on the pay above the exclusion; with it only
    // (187,500 - 132,900) / 187,500 = 29.1% of the UK income tax is creditable.
    const input = household({
      country: "GB",
      currency: "GBP",
      citizenships: ["GB", "US"],
      income: [{ type: "salary", amount: 150_000 }],
      fx: [{ from: "GBP", to: "USD", rate: 1.25 }],
    });
    const p = simulate(input).periods.find((x) => x.year === 2026)!;
    const ukIncomeTax = linesOf(p, (l) => l.country === "GB" && l.kind === "income");
    const credit = -linesOf(p, (l) => l.country === "US" && l.basis === "relief");
    expect(ukIncomeTax).toBeGreaterThan(0);
    expect(credit).toBeLessThanOrEqual(ukIncomeTax * ((187_500 - 132_900) / 187_500) + 1e-6);
  });

  it("US Social Security of a US citizen living in the UK is taxed only in the UK (UK-US Art. 17(3), kept for citizens by Art. 1(5)(a))", () => {
    expect(citizenshipMayTax("US", "GB", "US", "state-pension")).toBe(false);
    // Canada-US Art. XVIII(5), kept for citizens by Art. XXIX(3)(a).
    expect(citizenshipMayTax("US", "CA", "US", "state-pension")).toBe(false);
    // No treaty with the UAE: the US taxes its citizens there on everything.
    expect(citizenshipMayTax("US", "AE", "US", "state-pension")).toBe(true);
    // The saving clause keeps US tax on other US income of a citizen in the UK.
    expect(citizenshipMayTax("US", "GB", "US", "dividends")).toBe(true);
    // Art. 17(3) is about the other State's payments: a UK State Pension of a UK resident is not covered.
    expect(citizenshipMayTax("US", "GB", "GB", "state-pension")).toBe(true);

    const r = simulate(
      household({
        country: "GB",
        currency: "GBP",
        citizenships: ["GB", "US"],
        birthMonth: "1955-06",
        income: [{ type: "social-security", amount: 24_000, country: "US" }],
        fx: [{ from: "GBP", to: "USD", rate: 1.25 }],
      }),
    );
    const p = r.periods.find((x) => x.year === 2026)!;
    expect(linesOf(p, (l) => l.country === "US")).toBeCloseTo(0, 6);
    expect(linesOf(p, (l) => l.country === "GB")).toBeGreaterThan(0);
  });
});

describe("treaty table (texts read 2026-11-19)", () => {
  it("UK-US: social security to the residence State (Art. 17(3)); lump sums to the scheme's State (Art. 17(2)) but the US taxes its own residents under the saving clause (Art. 1(4))", () => {
    expect(treatyRule("GB", "US", "state-pension")).toMatchObject({
      sourceMayTax: false,
      residenceTaxes: true,
    });
    expect(treatyRule("US", "GB", "state-pension")).toMatchObject({
      sourceMayTax: false,
      residenceTaxes: true,
    });
    expect(treatyRule("US", "GB", "pension-lump-sum")).toMatchObject({
      sourceMayTax: true,
      residenceTaxes: true,
    });
    // UK residents keep the Art. 17(2) exemption in Glideworth (UK side not applied).
    expect(treatyRule("GB", "US", "pension-lump-sum").residenceTaxes).toBe(false);
    // Art. 19 government pensions: kept for US residents who are not citizens (Art. 1(5)(b)).
    expect(treatyRule("US", "GB", "government-pension").residenceTaxes).toBe(false);
    expect(
      treatyRule("US", "GB", "government-pension", { nationalOfResidence: true }).residenceTaxes,
    ).toBe(true);
    expect(treatyRule("GB", "US", "dividends").rule.maxSourceRate).toBe(0.15);
  });

  it("UK-Australia Art. 17(1): every pension, government pensions included, only in the residence State", () => {
    for (const c of ["private-pension", "state-pension", "government-pension"] as const)
      expect(treatyRule("AU", "GB", c)).toMatchObject({
        sourceMayTax: false,
        residenceTaxes: true,
      });
    expect(treatyRule("GB", "AU", "interest").rule.maxSourceRate).toBe(0.1);
  });

  it("UK-Canada Art. 17(1) (HMRC DT4604, DT4610): pensions of every kind, social security and government pensions only in the residence State", () => {
    for (const c of [
      "private-pension",
      "pension-lump-sum",
      "state-pension",
      "government-pension",
    ] as const) {
      const d = treatyRule("GB", "CA", c);
      expect(d).toMatchObject({ sourceMayTax: false, residenceTaxes: true });
      expect(d.rule.maxSourceRate).toBeUndefined();
    }
  });

  it("UK-Spain Art. 10(2)(a)(i): portfolio dividends at most 10% at source", () => {
    expect(treatyRule("GB", "ES", "dividends").rule.maxSourceRate).toBe(0.1);
  });

  it("Canada-US: government pensions fall under Art. XVIII (15% cap); social security only where you live (Art. XVIII(5))", () => {
    expect(treatyRule("CA", "US", "government-pension").rule.maxSourceRate).toBe(0.15);
    expect(treatyRule("US", "CA", "state-pension")).toMatchObject({
      sourceMayTax: false,
      residenceTaxes: true,
    });
  });

  it("Canada-US Art. XVIII(1), (3)(b): a Roth IRA is recognised in Canada", () => {
    expect(wrapperView("CA", "US", "roth-ira", "tax-free").recognised).toBe(true);
    // An ISA is still not recognised by the US.
    expect(wrapperView("US", "GB", "uk-isa", "tax-free").recognised).toBe(false);
  });
});

describe("non-resident rules (official pages read 2026-11-19)", () => {
  it("Ireland: no dividend withholding tax for residents of EU/EEA or treaty countries (Revenue, form V2A)", () => {
    expect(NON_RESIDENT_RULES.IE!.rules.dividends.taxed).toBe(false);
  });

  it("Spain: 19% IRNR on dividends (Agencia Tributaria), capped at 10% for UK residents by the treaty", () => {
    expect(NON_RESIDENT_RULES.ES!.rules.dividends).toMatchObject({
      taxed: true,
      method: "flat",
      rate: 0.19,
    });
  });

  it("France: 19% plus 7.5% for people covered by EU/EEA or UK social security, 19% plus 17.2% otherwise (BOFiP BOI-RFPI-PVINR-20-20)", () => {
    const r = NON_RESIDENT_RULES.FR!.rules["gains-property"];
    expect(r.rate).toBeCloseTo(0.362, 10);
    const reduced = r.rateByResidence!.find((x) => x.residences.includes("GB"))!;
    expect(reduced.rate).toBeCloseTo(0.265, 10);
    expect(reduced.residences).toContain("DE");
    expect(reduced.residences).not.toContain("US");
    expect(reduced.residences).not.toContain("AE");
  });

  it("US: non-resident aliens cannot claim the standard deduction (Publication 519)", () => {
    // $20,000 of US rent on the net-income election, 2026 single rates (Rev. Proc. 2025-32):
    // 10% x 12,400 + 12% x 7,600 = 2,152. A resident would deduct $16,100 first: 10% x 3,900 = 390.
    const base = {
      country: "US",
      year: 2026,
      income: [{ character: "rental" as const, amount: 20_000 }],
    };
    const nra = usFederalJurisdiction.computeYear(
      { ...taxInput(base), nonResident: { personalAllowance: { p1: false } } },
      [],
    );
    expect(total(nra)).toBeCloseTo(2_152, 6);
    expect(total(usFederalJurisdiction.computeYear(taxInput(base), []))).toBeCloseTo(390, 6);
  });

  it("Germany: a non-resident's taxable income is increased by the Grundfreibetrag before the tariff (§50(1) EStG)", () => {
    const base = {
      country: "DE",
      year: 2026,
      income: [{ character: "rental" as const, amount: 30_000 }],
    };
    const res = deJurisdiction.computeYear(taxInput(base), []);
    const nr = deJurisdiction.computeYear(
      { ...taxInput(base), nonResident: { personalAllowance: { p1: false } } },
      [],
    );
    const zvE = res.taxableIncome;
    const g = DE_YEARS.find((y) => y.startYear === 2026)!.tariff.grundfreibetrag;
    expect(g).toBe(12_348);
    const est = (o: typeof res) =>
      o.lines
        .filter((l) => l.label.startsWith("Einkommensteuer"))
        .reduce((s, l) => s + l.amount, 0);
    expect(est(nr)).toBeCloseTo(
      deTariff(
        zvE + g,
        DE_YEARS.find((y) => y.startYear === 2026)!,
      ),
      6,
    );
    expect(est(nr)).toBeGreaterThan(est(res));
    expect(NON_RESIDENT_RULES.DE!.propertyGainsExemptAfterYears).toBe(10);
  });
});
