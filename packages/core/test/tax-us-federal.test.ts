/**
 * US federal and payroll vectors from official sources (checked 2026-11-19):
 * - Rev. Proc. 2025-32 (2026) https://www.irs.gov/pub/irs-drop/rp-25-32.pdf
 * - Rev. Proc. 2026-35 (2027) https://www.irs.gov/pub/irs-drop/rp-26-35.pdf
 * - IRS Pub. 915 (2026) worked examples https://www.irs.gov/pub/irs-pdf/p915.pdf
 * - Notice 2026-66 and Rev. Proc. 2026-24 (2027 plan and HSA limits)
 * - SSA notice 91 FR 67380 (2027 wage base) https://www.govinfo.gov/content/pkg/FR-2026-10-26/html/2026-21796.htm
 * - CMS 2027 Part B/D fact sheet https://www.cms.gov/newsroom/fact-sheets/2027-medicare-parts-b-premiums-deductibles
 * - Rev. Proc. 2026-26 (2027 ACA table) https://www.irs.gov/pub/irs-drop/rp-26-26.pdf and the 2026
 *   Form 8962 instructions https://www.irs.gov/pub/irs-dft/i8962--dft.pdf
 * Synthetic households; working shown inline.
 */
import { describe, expect, it } from "vitest";
import {
  acaApplicablePercentage,
  taxableSocialSecurity,
  usContributionLimit,
  usFederalJurisdiction,
} from "../src/tax/jurisdictions/us-federal.js";
import { usPayrollJurisdiction } from "../src/tax/jurisdictions/us-payroll.js";
import { sumKind, sumLabel, taxInput } from "./tax-helpers.js";

const fed = (o: Parameters<typeof taxInput>[0]) =>
  usFederalJurisdiction.computeYear(taxInput({ country: "US", ...o }), []);
const mfj = { filingStatus: "married-joint" as const };

describe("Pub. 915 (2026) Worksheet 1 examples: taxable Social Security", () => {
  it("Example 1: single, benefits 5,980, other income 28,990 -> 2,990 taxable", () => {
    expect(taxableSocialSecurity(5_980, 28_990, "single")).toBeCloseTo(2_990, 6);
  });
  it("Example 2: joint, benefits 5,600, income 29,750 less 1,000 IRA deduction -> none", () => {
    expect(taxableSocialSecurity(5_600, 29_750 - 1_000, "married-joint")).toBe(0);
  });
  it("Example 3: joint, benefits 10,000, other income 40,500 -> 6,275 taxable", () => {
    expect(taxableSocialSecurity(10_000, 40_500, "married-joint")).toBeCloseTo(6_275, 6);
  });
  it("the same Example 1 through the federal plug-in (pension + wages + interest)", () => {
    const o = fed({
      people: [{ age: 70 }],
      income: [
        { character: "pension", amount: 18_600 },
        { character: "wage", amount: 9_400 },
        { character: "interest", amount: 990 },
        { character: "social-security", amount: 5_980 },
      ],
    });
    expect(o.facts["us.taxableSocialSecurity"]).toBeCloseTo(2_990, 6);
  });
});

describe("US federal 2027 (Rev. Proc. 2026-35)", () => {
  it("single, $100,000 wages: taxable 83,400 -> 5,987 + 22% x 31,375 = 12,889.50 (Table 3)", () => {
    const o = fed({ year: 2027, income: [{ character: "wage", amount: 100_000 }] });
    expect(o.facts["us.deduction"]).toBe(16_600);
    expect(sumKind(o, "income")).toBeCloseTo(12_889.5, 6);
  });

  it("joint, $200,000 wages: taxable 166,800 -> 11,974 + 22% x 62,750 = 25,779 (Table 1)", () => {
    const o = fed({
      year: 2027,
      people: [{}, {}],
      config: mfj,
      income: [{ character: "wage", amount: 200_000 }],
    });
    expect(sumKind(o, "income")).toBeCloseTo(25_779, 6);
  });

  it("head of household: 37% from 661,350 (Table 2): taxable 700,000 -> 211,660.50", () => {
    const o = fed({
      year: 2027,
      config: { filingStatus: "head-of-household" },
      income: [{ character: "wage", amount: 700_000 + 24_925 }],
    });
    expect(sumKind(o, "income")).toBeCloseTo(197_360 + 0.37 * 38_650, 6);
  });

  it("married filing separately: 37% from 396,825 (Table 4)", () => {
    const o = fed({
      year: 2027,
      people: [{}, {}],
      config: { filingStatus: "married-separate" },
      income: [{ character: "wage", amount: 400_000 + 16_600 }],
    });
    expect(sumKind(o, "income")).toBeCloseTo(106_645.25 + 0.37 * 3_175, 6);
  });

  it("joint, both 65+: 33,200 + 2 x 1,700 aged + 2 x 6,000 senior deduction", () => {
    const o = fed({
      year: 2027,
      people: [{ age: 67 }, { age: 66 }],
      config: mfj,
      income: [{ character: "pension", amount: 80_000 }],
    });
    expect(o.facts["us.deduction"]).toBe(36_600);
    expect(o.facts["us.seniorDeduction"]).toBe(12_000);
    expect(o.facts["us.taxableIncome"]).toBeCloseTo(80_000 - 36_600 - 12_000, 6);
  });

  it("LTCG 0% band to 51,050 single (section 3.03)", () => {
    // Wages 16,600 are absorbed by the standard deduction, so taxable income is the gains alone:
    // 51,050 is all at 0%; 52,050 puts 1,000 at 15% = 150.
    const zero = fed({
      year: 2027,
      income: [
        { character: "wage", amount: 16_600 },
        { character: "capital-gains-long", amount: 51_050 },
      ],
    });
    expect(sumKind(zero, "capital-gains")).toBe(0);
    const over = fed({
      year: 2027,
      income: [
        { character: "wage", amount: 16_600 },
        { character: "capital-gains-long", amount: 52_050 },
      ],
    });
    expect(sumKind(over, "capital-gains")).toBeCloseTo(150, 6);
  });

  it("child tax credit $2,300 per child (section 3.05)", () => {
    const o = fed({
      year: 2027,
      people: [{}, {}],
      config: mfj,
      dependents: [4],
      income: [{ character: "wage", amount: 100_000 }],
    });
    expect(sumLabel(o, /Child tax credit/)).toBeCloseTo(-2_300, 6);
  });

  it("2026 figures still apply to 2026", () => {
    const o = fed({ year: 2026, income: [{ character: "wage", amount: 100_000 }] });
    expect(o.facts["us.deduction"]).toBe(16_100);
  });
});

describe("US federal rule corrections", () => {
  it("AMT exemption phases out at 50 cents per dollar (Rev. Proc. 2025-32 section 4.10)", () => {
    // Single 2026: phase-out from 500,000, complete at 680,200 (= 500,000 + 90,100 / 0.5).
    // Wages only: AMTI = taxable income + standard deduction = wages.
    const half = fed({ income: [{ character: "wage", amount: 590_100 }] });
    expect(half.facts["us.amtExemption"]).toBeCloseTo(45_050, 6);
    const none = fed({ income: [{ character: "wage", amount: 680_200 }] });
    expect(none.facts["us.amtExemption"]).toBe(0);
    // 2027 joint: from 1,031,900, complete at 1,321,300 (section 3.11).
    const j = fed({
      year: 2027,
      people: [{}, {}],
      config: mfj,
      income: [{ character: "wage", amount: 1_321_300 }],
    });
    expect(j.facts["us.amtExemption"]).toBe(0);
  });

  it("the senior deduction needs a joint return when married (IRS OBBBA guidance)", () => {
    const o = fed({
      people: [{ age: 70 }, { age: 70 }],
      config: { filingStatus: "married-separate" },
      income: [{ character: "pension", amount: 40_000 }],
    });
    expect(o.facts["us.seniorDeduction"]).toBe(0);
    const single = fed({
      people: [{ age: 70 }],
      income: [{ character: "pension", amount: 40_000 }],
    });
    expect(single.facts["us.seniorDeduction"]).toBe(6_000);
  });

  it("ACA: no credit below 100% FPL or above 400%; exactly 400.x% still qualifies (Form 8962)", () => {
    expect(acaApplicablePercentage(0.99, false)).toBeNull();
    expect(acaApplicablePercentage(1.0, false)).toBeCloseTo(0.021, 6);
    expect(acaApplicablePercentage(4.009, false)).toBeCloseTo(0.0996, 6);
    expect(acaApplicablePercentage(4.01, false)).toBeNull();
  });

  it("ACA 2027: Rev. Proc. 2026-26 table and 2026 poverty line ($15,960)", () => {
    const magi = 2.5 * 15_960;
    const o = fed({
      year: 2027,
      people: [{ age: 60 }],
      income: [{ character: "pension", amount: magi }],
      aca: { benchmarkPremium: 9_000, householdSize: 1 },
    });
    expect(o.facts["us.fplMultiple"]).toBeCloseTo(2.5, 9);
    expect(sumLabel(o, /premium tax credit/)).toBeCloseTo(-(9_000 - 0.0866 * magi), 4);
  });

  it("IRMAA 2027 tiers (CMS): single MAGI 150,000 -> Part B 418.80 - 209.40 + Part D 39.70", () => {
    const o = fed({
      year: 2027,
      people: [{ age: 70 }],
      income: [{ character: "pension", amount: 50_000 }],
      history: [{ magi: 150_000 }, { magi: 60_000 }],
    });
    expect(sumKind(o, "irmaa")).toBeCloseTo((418.8 - 209.4 + 39.7) * 12, 6);
    const under = fed({
      year: 2027,
      people: [{ age: 70 }],
      income: [{ character: "pension", amount: 50_000 }],
      history: [{ magi: 112_000 }, { magi: 0 }],
    });
    expect(sumKind(under, "irmaa")).toBe(0);
  });
});

describe("US indexation after the latest published year", () => {
  const history = [
    { "tax.year": 2026, "tax.priceIndex": 1 },
    { "tax.year": 2027, "tax.priceIndex": 1.03 },
  ];
  it("legislated: 2027 figures index from the price index at the start of 2027", () => {
    const o = fed({
      year: 2028,
      priceIndex: 1.06,
      history,
      income: [{ character: "wage", amount: 1 }],
    });
    expect(o.facts["us.deduction"]).toBeCloseTo((16_600 * 1.06) / 1.03, 6);
  });
  it("legislated, plan starting after 2027: indexed from the plan start", () => {
    const o = fed({ year: 2029, priceIndex: 1, income: [{ character: "wage", amount: 1 }] });
    expect(o.facts["us.deduction"]).toBe(16_600);
  });
  it("indexed policy keeps the plan-start year's thresholds in real terms", () => {
    const o = fed({
      year: 2028,
      priceIndex: 1.06,
      history,
      config: { thresholdIndexation: "indexed" },
      income: [{ character: "wage", amount: 1 }],
    });
    expect(o.facts["us.deduction"]).toBeCloseTo(16_100 * 1.06, 6);
  });
  it("frozen policy keeps the latest published figures", () => {
    const o = fed({
      year: 2030,
      priceIndex: 1.1,
      history,
      config: { thresholdIndexation: "frozen" },
      income: [{ character: "wage", amount: 1 }],
    });
    expect(o.facts["us.deduction"]).toBe(16_600);
  });
});

describe("US payroll and limits 2027", () => {
  it("Social Security wage base $192,300 (SSA, 91 FR 67380)", () => {
    const o = usPayrollJurisdiction.computeYear(
      taxInput({ country: "US", year: 2027, income: [{ character: "wage", amount: 250_000 }] }),
      [],
    );
    expect(sumLabel(o, /OASDI/)).toBeCloseTo(0.062 * 192_300, 6);
    expect(sumLabel(o, /Additional Medicare/)).toBeCloseTo(0.009 * 50_000, 6);
  });

  it("contribution limits 2027 (Notice 2026-66, Rev. Proc. 2026-24)", () => {
    const q = { year: 2027, priceIndex: 1, earnedIncome: 100_000 };
    expect(usContributionLimit({ ...q, accountType: "401k", ownerAge: 40 })).toBe(25_500);
    expect(usContributionLimit({ ...q, accountType: "401k", ownerAge: 55 })).toBe(34_000);
    expect(usContributionLimit({ ...q, accountType: "403b", ownerAge: 62 })).toBe(37_250);
    expect(usContributionLimit({ ...q, accountType: "traditional-ira", ownerAge: 52 })).toBe(8_600);
    expect(usContributionLimit({ ...q, accountType: "simple-ira", ownerAge: 40 })).toBe(17_500);
    expect(
      usContributionLimit({ ...q, accountType: "hsa", ownerAge: 56, coverage: "family" }),
    ).toBe(10_000);
    expect(
      usContributionLimit({ ...q, accountType: "sep-ira", ownerAge: 40, earnedIncome: 1e6 }),
    ).toBe(75_000);
  });
});
