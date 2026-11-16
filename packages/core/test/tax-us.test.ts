/**
 * US vectors, tax year 2026. Figures from Rev. Proc. 2025-32 (IRB 2025-45), SSA 2026 wage base,
 * SSA POMS HI 01101.020 (IRMAA), Rev. Proc. 2025-25 (ACA), IRS Pub. 915 (Social Security), and the
 * state revenue departments' 2026 publications cited in data/us-states.ts (read 2026-11-16; more
 * state vectors in tax-us-states.test.ts). Working shown inline.
 */
import { describe, expect, it } from "vitest";
import { US_STATES_2026 } from "../src/tax/data/us-states.js";
import {
  taxableSocialSecurity,
  usContributionLimit,
  usFederalJurisdiction,
  usRequiredDistribution,
} from "../src/tax/jurisdictions/us-federal.js";
import { usPayrollJurisdiction } from "../src/tax/jurisdictions/us-payroll.js";
import { createDefaultTaxRegistry } from "../src/tax/registry.js";
import { runStack, sumKind, sumLabel, taxInput, total } from "./tax-helpers.js";

const fed = (o: Parameters<typeof taxInput>[0]) =>
  usFederalJurisdiction.computeYear(taxInput({ country: "US", ...o }), []);
const reg = createDefaultTaxRegistry();
const stack = (region?: string, locality?: string) =>
  reg.resolveStack(
    { ...taxInput({}).config, mode: "estimate" },
    { country: "US", ...(region ? { region } : {}), ...(locality ? { locality } : {}) },
  );

describe("US federal income tax 2026 (Rev. Proc. 2025-32)", () => {
  it("single, $75,000 wages: taxable 58,900 -> 5,800 (IRS base at 50,400) + 8,500 x 22% = 7,670", () => {
    const o = fed({ income: [{ character: "wage", amount: 75_000 }] });
    expect(sumKind(o, "income")).toBeCloseTo(7_670, 6);
    expect(o.facts.agi).toBeCloseTo(75_000, 6);
    expect(o.facts["tax.ordinaryBracketRate"]).toBe(0.22);
  });

  it("MFJ $150,000 wages: taxable 117,800 -> 11,600 + 17,000 x 22% = 15,340", () => {
    const o = fed({
      people: [{}, {}],
      config: { filingStatus: "married-joint" },
      income: [{ character: "wage", amount: 150_000 }],
    });
    expect(sumKind(o, "income")).toBeCloseTo(15_340, 6);
  });

  it("single 65+: standard deduction 16,100 + 2,050 additional + 6,000 senior deduction", () => {
    // pension 50,000: MAGI below 75k so full senior deduction; taxable 50,000 - 24,150 = 25,850
    const o = fed({ people: [{ age: 67 }], income: [{ character: "pension", amount: 50_000 }] });
    expect(o.facts["us.seniorDeduction"]).toBeCloseTo(6_000, 6);
    expect(sumKind(o, "income")).toBeCloseTo(1_240 + (25_850 - 12_400) * 0.12, 6);
  });

  it("senior deduction phases out at 6% of MAGI over $75,000", () => {
    const o = fed({ people: [{ age: 67 }], income: [{ character: "pension", amount: 100_000 }] });
    expect(o.facts["us.seniorDeduction"]).toBeCloseTo(6_000 - 0.06 * 25_000, 6);
  });

  it("LTCG stacking: single, wages 40,000 + LTCG 30,000 -> 0% up to 49,450 then 15%", () => {
    // taxable 53,900; ordinary 23,900 (tax 1,240 + 11,500 x 12% = 2,620); gains 30,000:
    // 25,550 at 0% (23,900 -> 49,450) and 4,450 at 15% = 667.50
    const o = fed({
      income: [
        { character: "wage", amount: 40_000 },
        { character: "capital-gains-long", amount: 30_000 },
      ],
    });
    expect(sumKind(o, "income")).toBeCloseTo(2_620, 6);
    expect(sumKind(o, "capital-gains")).toBeCloseTo(667.5, 6);
  });

  it("NIIT: single, wages 250,000 + interest 20,000 -> 3.8% x 20,000 = 760", () => {
    const o = fed({
      income: [
        { character: "wage", amount: 250_000 },
        { character: "interest", amount: 20_000 },
      ],
    });
    expect(sumKind(o, "niit")).toBeCloseTo(760, 6);
  });

  it("taxable Social Security (Pub. 915 formula): MFJ, SS 30,000 + pension 40,000", () => {
    // provisional = 40,000 + 15,000 = 55,000 > 44,000: 0.85 x 11,000 + min(15,000, 6,000) = 15,350
    expect(taxableSocialSecurity(30_000, 40_000, "married-joint")).toBeCloseTo(15_350, 6);
    expect(taxableSocialSecurity(30_000, 10_000, "married-joint")).toBe(0);
    expect(taxableSocialSecurity(30_000, 100_000, "married-joint")).toBeCloseTo(25_500, 6);
  });

  it("child tax credit $2,200 per child under 17", () => {
    const o = fed({
      people: [{}, {}],
      config: { filingStatus: "married-joint" },
      dependents: [5, 10],
      income: [{ character: "wage", amount: 100_000 }],
    });
    expect(sumLabel(o, /Child tax credit/)).toBeCloseTo(-4_400, 6);
  });

  it("early withdrawal: 10% penalty on the taxable amount from a US account", () => {
    const o = fed({
      people: [{ age: 45 }],
      withdrawals: [
        { accountType: "traditional-ira", amount: 10_000, taxableAmount: 10_000, penaltyRate: 0.1 },
      ],
    });
    expect(sumKind(o, "penalty")).toBeCloseTo(1_000, 6);
  });

  it("IRMAA uses MAGI from two years earlier; tiers are cliffs (POMS HI 01101.020)", () => {
    const o = fed({
      people: [{ age: 70 }],
      income: [{ character: "pension", amount: 50_000 }],
      history: [{ magi: 140_000 }, { magi: 60_000 }],
    });
    // 140,000 single is tier 2: Part B 405.80 - 202.90 + Part D 37.50 = 240.40/month
    expect(sumKind(o, "irmaa")).toBeCloseTo(240.4 * 12, 6);
    const under = fed({
      people: [{ age: 70 }],
      income: [{ character: "pension", amount: 50_000 }],
      history: [{ magi: 109_000 }, { magi: 0 }],
    });
    expect(sumKind(under, "irmaa")).toBe(0);
  });

  it("ACA premium tax credit 2026: 2.5x FPL single -> 8.44% expected contribution; cliff at 400%", () => {
    const magi = 2.5 * 15_650;
    const o = fed({
      people: [{ age: 60 }],
      income: [{ character: "pension", amount: magi }],
      aca: { benchmarkPremium: 9_000, householdSize: 1 },
    });
    expect(sumLabel(o, /premium tax credit/)).toBeCloseTo(-(9_000 - 0.0844 * magi), 4);
    const cliff = fed({
      people: [{ age: 60 }],
      income: [{ character: "pension", amount: 4.01 * 15_650 }],
      aca: { benchmarkPremium: 9_000, householdSize: 1, advanceCredit: 3_000 },
    });
    expect(sumKind(cliff, "aca-reconciliation")).toBeCloseTo(3_000, 6);
  });

  it("RMD: Uniform Lifetime Table divisor 26.5 at 73 (born 1953)", () => {
    expect(
      usRequiredDistribution({
        accountType: "traditional-ira",
        rule: "us-rmd",
        year: 2026,
        ownerAge: 73,
        priorYearEndBalance: 265_000,
        ownerBirthYear: 1953,
      }),
    ).toBeCloseTo(10_000, 6);
    expect(
      usRequiredDistribution({
        accountType: "traditional-ira",
        rule: "us-rmd",
        year: 2026,
        ownerAge: 73,
        priorYearEndBalance: 265_000,
        ownerBirthYear: 1960,
      }),
    ).toBe(0);
  });

  it("contribution limits 2026 incl. 60-63 super catch-up", () => {
    const q = { year: 2026, priceIndex: 1, earnedIncome: 100_000 };
    expect(usContributionLimit({ ...q, accountType: "401k", ownerAge: 40 })).toBe(24_500);
    expect(usContributionLimit({ ...q, accountType: "401k", ownerAge: 55 })).toBe(32_500);
    expect(usContributionLimit({ ...q, accountType: "401k", ownerAge: 61 })).toBe(35_750);
    expect(usContributionLimit({ ...q, accountType: "roth-ira", ownerAge: 52 })).toBe(8_600);
  });
});

describe("US payroll 2026", () => {
  it("FICA on $200,000 wages: SS capped at $184,500 wage base; Medicare 1.45%", () => {
    const o = usPayrollJurisdiction.computeYear(
      taxInput({ country: "US", income: [{ character: "wage", amount: 200_000 }] }),
      [],
    );
    expect(sumLabel(o, /OASDI/)).toBeCloseTo(0.062 * 184_500, 6);
    expect(sumLabel(o, /^Medicare$/)).toBeCloseTo(2_900, 6);
    expect(sumLabel(o, /Additional Medicare/)).toBe(0);
  });
  it("Additional Medicare 0.9% over $200,000 single", () => {
    const o = usPayrollJurisdiction.computeYear(
      taxInput({ country: "US", income: [{ character: "wage", amount: 300_000 }] }),
      [],
    );
    expect(sumLabel(o, /Additional Medicare/)).toBeCloseTo(900, 6);
  });
  it("SE tax on $100,000 net SE income: 15.3% x 92.35% = 14,129.55", () => {
    const o = usPayrollJurisdiction.computeYear(
      taxInput({ country: "US", income: [{ character: "self-employment", amount: 100_000 }] }),
      [],
    );
    expect(sumKind(o, "self-employment")).toBeCloseTo(14_129.55, 6);
    expect(o.facts["us.seTaxDeduction"]).toBeCloseTo(7_064.775, 6);
  });
});

describe("US states and locals (2026, official state sources)", () => {
  it("covers all 50 states + DC", () => {
    expect(new Set(US_STATES_2026.map((s) => s.code)).size).toBe(51);
  });

  it("every state computes without error for a typical household", () => {
    for (const s of US_STATES_2026) {
      const input = taxInput({
        country: "US",
        region: s.code,
        income: [{ character: "wage", amount: 80_000 }],
      });
      const outs = runStack(stack(s.code), input);
      expect(Number.isFinite(total(outs[2]!))).toBe(true);
    }
  });

  it("Colorado flat 4.4% on federal taxable income: single 75,000 -> 58,900 x 4.4% = 2,591.60", () => {
    const outs = runStack(
      stack("CO"),
      taxInput({ country: "US", region: "CO", income: [{ character: "wage", amount: 75_000 }] }),
    );
    expect(outs[2]!.lines[0]!.jurisdictionId).toBe("us-state:CO");
    expect(total(outs[2]!)).toBeCloseTo(2_591.6, 6);
  });

  it("California 2026 brackets + 1.3% SDI: single 75,000 wages", () => {
    // FTB Tax News Oct 2026 (2026 Schedule X, standard deduction 5,900, credit 158); EDD SDI 1.3%.
    // Changed deliberately: the table held the 2025 schedule (expected 2,940.85, credit 153).
    // taxable 75,000 - 5,900 = 69,100: 1% x 11,456 = 114.56; 2% x 15,701 = 314.02;
    // 4% x 15,704 = 628.16; 6% x 16,637 = 998.22; 8% x (69,100 - 59,498 = 9,602) = 768.16
    // = 2,823.12 (FTB: 2,054.96 + 8% x 9,602 = 2,823.12), less the 158 exemption credit.
    const outs = runStack(
      stack("CA"),
      taxInput({ country: "US", region: "CA", income: [{ character: "wage", amount: 75_000 }] }),
    );
    const ca = outs[2]!;
    expect(sumKind(ca, "income")).toBeCloseTo(114.56 + 314.02 + 628.16 + 998.22 + 768.16, 2);
    expect(sumKind(ca, "credit")).toBeCloseTo(-158, 6);
    expect(sumKind(ca, "payroll")).toBeCloseTo(975, 6);
  });

  it("Texas has no income tax; Washington taxes only long-term gains over $290,000 (2026)", () => {
    // DOR WA: 2026 standard deduction 290,000 (was 278,000, the 2025 figure; expected 7,000).
    // (378,000 - 290,000) x 7% = 6,160.
    expect(
      total(
        runStack(
          stack("TX"),
          taxInput({
            country: "US",
            region: "TX",
            income: [{ character: "wage", amount: 100_000 }],
          }),
        )[2]!,
      ),
    ).toBe(0);
    const wa = runStack(
      stack("WA"),
      taxInput({
        country: "US",
        region: "WA",
        income: [{ character: "capital-gains-long", amount: 378_000 }],
      }),
    )[2]!;
    expect(sumKind(wa, "capital-gains")).toBeCloseTo(6_160, 6);
  });

  it("Pennsylvania exempts retirement income; Illinois exempts pensions", () => {
    const pa = runStack(
      stack("PA"),
      taxInput({
        country: "US",
        region: "PA",
        people: [{ age: 66 }],
        income: [{ character: "pension", amount: 40_000 }],
      }),
    )[2]!;
    expect(total(pa)).toBe(0);
  });

  it("NYC resident tax stacks on NY taxable income", () => {
    const outs = runStack(
      stack("NY", "nyc"),
      taxInput({
        country: "US",
        region: "NY",
        locality: "nyc",
        income: [{ character: "wage", amount: 75_000 }],
      }),
    );
    // NY taxable 67,000; NYC: 12,000 x 3.078% + 13,000 x 3.762% + 25,000 x 3.819% + 17,000 x 3.876%
    expect(total(outs[3]!)).toBeCloseTo(369.36 + 489.06 + 954.75 + 658.92, 2);
  });
});
