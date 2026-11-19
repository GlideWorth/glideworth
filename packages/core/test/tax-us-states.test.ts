/**
 * US state and city vectors for the figures corrected when the state table was re-sourced from
 * official publications (2026-11-16). Each vector is worked by hand from the source cited in
 * data/us-states.ts for that state; working inline. Wages only, age 40, no pre-tax deductions, so
 * federal AGI equals wages.
 */
import { describe, expect, it } from "vitest";
import { TAX_SIMPLIFICATIONS } from "../src/tax/data/simplifications.js";
import { US_LOCALS_2026, US_STATES_2026 } from "../src/tax/data/us-states.js";
import { createDefaultTaxRegistry } from "../src/tax/registry.js";
import { runStack, sumKind, taxInput, total } from "./tax-helpers.js";

const reg = createDefaultTaxRegistry();
const stack = (region: string, locality?: string) =>
  reg.resolveStack(
    { ...taxInput({}).config, mode: "estimate" },
    { country: "US", region, ...(locality ? { locality } : {}) },
  );
const state = (region: string, o: Parameters<typeof taxInput>[0] = {}) =>
  runStack(stack(region), taxInput({ country: "US", region, ...o }))[2]!;
const wages = (amount: number) => [{ character: "wage" as const, amount }];
const joint = { people: [{}, {}], config: { filingStatus: "married-joint" as const } };

describe("US states 2026: corrected figures", () => {
  it("Georgia 4.99% flat, standard deduction 15,000 (HB 463): single 75,000", () => {
    // (75,000 - 15,000) x 4.99% = 2,994
    expect(total(state("GA", { income: wages(75_000) }))).toBeCloseTo(2_994, 6);
  });

  it("Georgia dependent deduction 5,000: single 75,000 with one child", () => {
    // (75,000 - 15,000 - 5,000) x 4.99% = 2,744.50
    expect(total(state("GA", { income: wages(75_000), dependents: [6] }))).toBeCloseTo(2_744.5, 6);
  });

  it("California 2026 joint schedule and dependent credit 491: MFJ 150,000 with one child", () => {
    // FTB 2026 Schedule Y: taxable 150,000 - 11,800 = 138,200.
    // 4,109.92 + 8% x (138,200 - 118,996 = 19,204) = 1,536.32 -> 5,646.24
    // credits 316 + 491 = 807
    const ca = state("CA", { ...joint, income: wages(150_000), dependents: [6] });
    expect(sumKind(ca, "income")).toBeCloseTo(4_109.92 + 1_536.32, 2);
    expect(sumKind(ca, "credit")).toBeCloseTo(-807, 6);
  });

  it("California Behavioral Health Services Tax: 1% more above 1,000,000 of taxable income", () => {
    // single 2,005,900: taxable 2,000,000. Schedule X: 74,675.27 + 12.3% x (2,000,000 - 768,213)
    // = 74,675.27 + 151,509.80 = 226,185.07; BHST 1% x 1,000,000 = 10,000 -> 236,185.07
    const ca = state("CA", { income: wages(2_005_900) });
    expect(sumKind(ca, "income")).toBeCloseTo(236_185.07, 1);
  });

  it("Washington 2026: 7% on gains over 290,000 and 2.9% more above 1,000,000 of WA gains", () => {
    // 1,390,000 - 290,000 = 1,100,000: 7% x 1,100,000 + 2.9% x 100,000 = 77,000 + 2,900 = 79,900
    const wa = state("WA", { income: [{ character: "capital-gains-long", amount: 1_390_000 }] });
    expect(sumKind(wa, "capital-gains")).toBeCloseTo(79_900, 6);
  });

  it("New Jersey 5.525% band (Table A): single 60,000", () => {
    // taxable 60,000 - 1,000 = 59,000; Table A: 59,000 x 0.05525 - 1,492.50 = 1,767.25
    // = 1.4% x 20,000 + 1.75% x 15,000 + 3.5% x 5,000 + 5.525% x 19,000 = 280 + 262.5 + 175 + 1,049.75
    expect(total(state("NJ", { income: wages(60_000) }))).toBeCloseTo(1_767.25, 6);
  });

  it("Arizona: standard deduction 16,100 (2025 statute indexed) and dependent credit 125", () => {
    // (75,000 - 16,100) x 2.5% = 1,472.50, less 125 = 1,347.50
    expect(total(state("AZ", { income: wages(75_000), dependents: [10] }))).toBeCloseTo(1_347.5, 6);
  });

  it("Massachusetts 4% surtax above 1,107,750 (tax year 2026)", () => {
    // taxable 2,000,000 - 4,400 = 1,995,600: 5% x 1,995,600 = 99,780
    // + 4% x (1,995,600 - 1,107,750 = 887,850) = 35,514 -> 135,294
    expect(total(state("MA", { income: wages(2_000_000) }))).toBeCloseTo(135_294, 6);
  });

  it("Indiana: 1,000 exemption plus 2,500 per dependent child (IC 6-3-1-3.5)", () => {
    // 60,000 - 1,000 - 2 x 2,500 = 54,000 x 2.95% = 1,593
    expect(total(state("IN", { income: wages(60_000), dependents: [5, 8] }))).toBeCloseTo(1_593, 6);
  });

  it("South Carolina 2026 (Act 110): 1.99% below 30,000, 5.21% above; SCIAD 15,000", () => {
    // taxable 75,000 - 15,000 = 60,000: 5.21% x 60,000 - 966 = 2,160
    // = 1.99% x 30,000 + 5.21% x 30,000 = 597 + 1,563
    expect(total(state("SC", { income: wages(75_000) }))).toBeCloseTo(2_160, 6);
  });

  it("Oregon 2026: standard deduction 2,910 and exemption credit 263 (2026 withholding formulas)", () => {
    // Changed deliberately: the Department's estimates (2,900 / 260) were replaced by the indexed
    // 2026 amounts. taxable 72,090: 4.75% x 4,550 = 216.125; 6.75% x 6,850 = 462.375;
    // 8.75% x (72,090 - 11,400 = 60,690) = 5,310.375 -> 5,988.875, less 263 = 5,725.875
    expect(total(state("OR", { income: wages(75_000) }))).toBeCloseTo(5_725.875, 6);
  });

  it("Oregon: no exemption credit above federal AGI 100,000 single", () => {
    // taxable 102,090: 216.125 + 462.375 + 8.75% x 90,690 = 7,935.375 -> 8,613.875, no credit
    expect(total(state("OR", { income: wages(105_000) }))).toBeCloseTo(8_613.875, 6);
  });

  it("Utah 4.45% from 2026 (Utah Code 59-10-104)", () => {
    // 75,000 x 4.45% = 3,337.50
    expect(total(state("UT", { income: wages(75_000) }))).toBeCloseTo(3_337.5, 6);
  });

  it("Arkansas 2026 schedule above 94,700: 2% to 4,700 and 3.7% above; credit 29", () => {
    // taxable 150,000 - 2,470 = 147,530: 2% x 4,700 = 94 + 3.7% x 142,830 = 5,284.71 -> 5,378.71
    // less personal credit 29 = 5,349.71
    expect(total(state("AR", { income: wages(150_000) }))).toBeCloseTo(5_349.71, 6);
  });

  it("Nebraska joint brackets 8,250 / 49,530 (not double the single ones)", () => {
    // MFJ taxable 100,000 - 17,700 = 82,300: 2.46% x 8,250 = 202.95;
    // 3.51% x 41,280 = 1,448.928; 4.55% x 32,770 = 1,491.035 -> 3,142.913, less 2 x 176 = 2,790.913
    expect(total(state("NE", { ...joint, income: wages(100_000) }))).toBeCloseTo(2_790.913, 6);
  });

  it("Maine 2026: standard deduction 15,700 and brackets at 27,400 / 64,850", () => {
    // taxable 75,000 - 15,700 - 5,300 = 54,000: 5.8% x 27,400 = 1,589.20; 6.75% x 26,600 = 1,795.50
    expect(total(state("ME", { income: wages(75_000) }))).toBeCloseTo(3_384.7, 6);
  });

  it("Maine 2% surcharge above 1,000,000 single", () => {
    // taxable 2,000,000 - 21,000 = 1,979,000: 1,589.20 + 6.75% x 37,450 = 2,527.875
    // + 7.15% x (1,979,000 - 64,850) = 136,861.725 + 2% x 979,000 = 19,580 -> 160,558.80
    expect(total(state("ME", { income: wages(2_000_000) }))).toBeCloseTo(160_558.8, 6);
  });

  it("West Virginia 2026 rates (SB 392): single 75,000", () => {
    // taxable 75,000 - 2,000 = 73,000: 1,950.50 + 4.58% x 13,000 = 595.40 -> 2,545.90
    expect(total(state("WV", { income: wages(75_000) }))).toBeCloseTo(2_545.9, 6);
  });

  it("Hawaii 2026 standard deduction 8,000: single 75,000", () => {
    // taxable 75,000 - 8,000 - 1,144 = 65,856: 2,539.20 to 48,000 + 7.6% x 17,856 = 1,357.056
    expect(total(state("HI", { income: wages(75_000) }))).toBeCloseTo(3_896.256, 6);
  });

  it("North Dakota 2026 brackets: single 75,000 and MFJ 150,000", () => {
    // single: (75,000 - 16,100 - 49,575 = 9,325) x 1.95% = 181.8375
    expect(total(state("ND", { income: wages(75_000) }))).toBeCloseTo(181.8375, 6);
    // MFJ: (150,000 - 32,200 - 82,800 = 35,000) x 1.95% = 682.50
    expect(total(state("ND", { ...joint, income: wages(150_000) }))).toBeCloseTo(682.5, 6);
  });

  it("Philadelphia 2026: average of 3.74% and 3.735% on resident wages", () => {
    // 80,000 x (3.74% + 3.735%) / 2 = 80,000 x 3.7375% = 2,990
    const outs = runStack(
      stack("PA", "philadelphia"),
      taxInput({ country: "US", region: "PA", locality: "philadelphia", income: wages(80_000) }),
    );
    expect(total(outs[3]!)).toBeCloseTo(2_990, 6);
  });
});

describe("US states 2026: retirement income and Social Security (checked 2026-11-19)", () => {
  const retiree = (age: number, income: Parameters<typeof taxInput>[0]["income"]) => ({
    people: [{ age }],
    income,
  });
  const pension = (amount: number) => ({ character: "pension" as const, amount });
  const ss = (amount: number) => ({ character: "social-security" as const, amount });
  const facts = (region: string, o: Parameters<typeof taxInput>[0]) => state(region, o).facts;

  it("New Mexico: Social Security exempt up to federal AGI 100,000 single (PIT-ADJ line 25)", () => {
    // pension 40,000 + SS 30,000: taxable SS 22,350 (Pub. 915), AGI 62,350 <= 100,000 -> exempt.
    // NM taxable = 40,000 - federal deduction (16,100 + 2,050) = 21,850:
    // 1.5% x 5,500 + 3.2% x 11,000 + 4.3% x 5,350 = 82.50 + 352 + 230.05 = 664.55
    const nm = state("NM", retiree(70, [pension(40_000), ss(30_000)]));
    expect(nm.facts["us.stateSocialSecurityExempt"]).toBeCloseTo(22_350, 6);
    expect(total(nm)).toBeCloseTo(664.55, 6);
    // A cliff: above 100,000 of AGI nothing is exempt.
    expect(
      facts("NM", retiree(70, [pension(90_000), ss(30_000)]))["us.stateSocialSecurityExempt"],
    ).toBe(0);
  });

  it("Vermont: Social Security exemption phases out over 10,000 above 55,000 (32 V.S.A. 5830e)", () => {
    // pension 38,000 + SS 30,000: taxable SS 0.85 x 19,000 + 4,500 = 20,650; AGI 58,650;
    // 3,650 over -> 63.5% kept = 13,112.75
    expect(
      facts("VT", retiree(70, [pension(38_000), ss(30_000)]))["us.stateSocialSecurityExempt"],
    ).toBeCloseTo(13_112.75, 6);
  });

  it("Vermont 2026: standard deduction 7,850, 1,300 at 65, exemption 5,400 (IN-111)", () => {
    // 60,000 - 7,850 - 1,300 - 5,400 = 45,450 x 3.35% = 1,522.575
    expect(total(state("VT", { people: [{ age: 70 }], income: wages(60_000) }))).toBeCloseTo(
      1_522.575,
      6,
    );
  });

  it("Minnesota: Social Security subtraction loses 10% per 4,000 over 86,410 (290.0132 subd. 26)", () => {
    // pension 80,000 + SS 30,000: taxable SS 25,500; AGI 105,500; 19,090 over -> 5 steps -> 50%
    expect(
      facts("MN", retiree(70, [pension(80_000), ss(30_000)]))["us.stateSocialSecurityExempt"],
    ).toBeCloseTo(12_750, 6);
  });

  it("Utah: Social Security credit 4.45% less 2.5 cents per dollar over 54,000 (59-10-1042)", () => {
    // pension 50,000 + SS 30,000: taxable SS 25,500, AGI 75,500.
    // 4.45% x 75,500 = 3,359.75; credit 4.45% x 25,500 - 2.5% x 21,500 = 1,134.75 - 537.50 = 597.25
    expect(total(state("UT", retiree(70, [pension(50_000), ss(30_000)])))).toBeCloseTo(2_762.5, 6);
  });

  it("Michigan 2026: retirement deduction capped at 135,220 per joint return (Form 446)", () => {
    // pension 150,000 - 135,220 - exemptions 11,800 = 2,980 x 4.25% = 126.65
    const mi = state("MI", {
      ...joint,
      people: [{ age: 70 }, { age: 68 }],
      income: [pension(150_000)],
    });
    expect(total(mi)).toBeCloseTo(126.65, 6);
  });

  it("Maryland: pension exclusion 40,600 at 65, workplace plans only, less Social Security", () => {
    // 401(k) 30,000 qualifies, IRA 20,000 does not; cap 40,600 - SS 10,000 = 30,600 -> 30,000
    const o = facts("MD", {
      people: [{ age: 70 }],
      income: [ss(10_000)],
      withdrawals: [
        { accountType: "401k", treatment: "tax-deferred", amount: 30_000 },
        { accountType: "traditional-ira", treatment: "tax-deferred", amount: 20_000 },
      ],
    });
    expect(o["us.stateRetirementExclusion"]).toBeCloseTo(30_000, 6);
  });

  it("Maine 2026: pension deduction 49,824 less Social Security (1040ES-ME)", () => {
    expect(
      facts("ME", retiree(70, [pension(60_000), ss(20_000)]))["us.stateRetirementExclusion"],
    ).toBeCloseTo(29_824, 6);
  });

  it("New Jersey: pension exclusion 100,000 joint, halved between 100,000 and 125,000 of income", () => {
    const j = facts("NJ", {
      ...joint,
      people: [{ age: 65 }, { age: 65 }],
      income: [pension(110_000)],
    });
    expect(j["us.stateRetirementExclusion"]).toBeCloseTo(50_000, 6);
    expect(facts("NJ", retiree(63, [pension(60_000)]))["us.stateRetirementExclusion"]).toBeCloseTo(
      60_000,
      6,
    );
    expect(facts("NJ", retiree(61, [pension(60_000)]))["us.stateRetirementExclusion"]).toBe(0);
  });

  it("Rhode Island: at full retirement age, SS and 50,000 of pension exempt below the AGI limit", () => {
    // pension 60,000 + SS 20,000: taxable SS 17,000; AGI 77,000 < 107,000
    const o = facts("RI", retiree(68, [pension(60_000), ss(20_000)]));
    expect(o["us.stateSocialSecurityExempt"]).toBeCloseTo(17_000, 6);
    expect(o["us.stateRetirementExclusion"]).toBeCloseTo(50_000, 6);
    expect(
      facts("RI", retiree(65, [pension(60_000), ss(20_000)]))["us.stateRetirementExclusion"],
    ).toBe(0);
  });

  it("West Virginia: 8,000 senior deduction from 65, less the Social Security modification", () => {
    // pension 40,000 + SS 5,000: taxable SS 4,250 (all exempt) -> 8,000 - 4,250 = 3,750
    expect(
      facts("WV", retiree(70, [pension(40_000), ss(5_000)]))["us.stateAgeDeduction"],
    ).toBeCloseTo(3_750, 6);
    expect(facts("WV", retiree(60, [pension(40_000)]))["us.stateAgeDeduction"]).toBe(0);
  });

  it("South Carolina: 10,000 retirement deduction at 65 plus the age deduction to 15,000", () => {
    const o = facts("SC", retiree(70, [pension(40_000)]));
    expect(o["us.stateRetirementExclusion"]).toBe(10_000);
    expect(o["us.stateAgeDeduction"]).toBe(5_000);
  });

  it("Virginia: 12,000 age deduction less income over 50,000 single", () => {
    expect(facts("VA", retiree(70, [pension(60_000)]))["us.stateAgeDeduction"]).toBeCloseTo(
      2_000,
      6,
    );
  });

  it("Wisconsin: 24,000 retirement income subtraction from 67 (Schedule SB)", () => {
    expect(facts("WI", retiree(68, [pension(30_000)]))["us.stateRetirementExclusion"]).toBe(24_000);
    expect(facts("WI", retiree(66, [pension(30_000)]))["us.stateRetirementExclusion"]).toBe(0);
  });

  it("Wisconsin joint brackets 20,150 / 69,260 / 443,630 (2026 Form 1-ES Schedule B)", () => {
    // 100,000 - 25,840 - 1,400 = 72,760: 3.5% x 20,150 + 4.4% x 49,110 + 5.3% x 3,500
    // = 705.25 + 2,160.84 + 185.50 = 3,051.59
    expect(total(state("WI", { ...joint, income: wages(100_000) }))).toBeCloseTo(3_051.59, 2);
  });

  it("Louisiana: retirement exclusion 12,324 per person 65+ for 2026", () => {
    expect(facts("LA", retiree(66, [pension(20_000)]))["us.stateRetirementExclusion"]).toBe(12_324);
  });

  it("Iowa starts from federal taxable income: 65+ and senior deductions, 20 extra credit", () => {
    // 50,000 - (16,100 + 2,050 + 6,000) = 25,850 x 3.8% = 982.30, less credits 40 + 20
    expect(total(state("IA", { people: [{ age: 70 }], income: wages(50_000) }))).toBeCloseTo(
      922.3,
      6,
    );
  });
});

describe("US states 2026: other corrections (checked 2026-11-19)", () => {
  it("Ohio: 332 plus 2.75% above 26,050; exemption 1,900 above 80,000 of income", () => {
    // 100,000 - 1,900 = 98,100: 332 + 2.75% x 72,050 = 332 + 1,981.375
    expect(total(state("OH", { income: wages(100_000) }))).toBeCloseTo(2_313.375, 6);
  });

  it("Mississippi: each spouse's first 10,000 is exempt on a joint return", () => {
    // 100,000 - 4,600 - 12,000 = 83,400; 4% x (83,400 - 20,000) = 2,536
    expect(total(state("MS", { ...joint, income: wages(100_000) }))).toBeCloseTo(2_536, 6);
  });

  it("New Mexico: 4,000 for each dependent after the first, joint returns only", () => {
    const one = state("NM", { ...joint, income: wages(100_000), dependents: [5] });
    const two = state("NM", { ...joint, income: wages(100_000), dependents: [5, 8] });
    expect(one.taxableIncome - two.taxableIncome).toBeCloseTo(4_000, 6);
  });

  it("Detroit taxes residents' interest as well as wages (2.4%, 600 exemption)", () => {
    const outs = runStack(
      stack("MI", "detroit"),
      taxInput({
        country: "US",
        region: "MI",
        locality: "detroit",
        income: [
          { character: "wage", amount: 50_000 },
          { character: "interest", amount: 10_000 },
        ],
      }),
    );
    expect(total(outs[3]!)).toBeCloseTo((60_000 - 600) * 0.024, 6);
  });
});

describe("US states 2026: Alabama to Illinois and Missouri (checked 2026-11-19)", () => {
  const pension = (amount: number) => ({ character: "pension" as const, amount });
  const ss = (amount: number) => ({ character: "social-security" as const, amount });
  const facts = (region: string, o: Parameters<typeof taxInput>[0]) => state(region, o).facts;
  const old = (age: number, income: Parameters<typeof taxInput>[0]["income"]) => ({
    people: [{ age }],
    income,
  });

  it("Alabama: federal income tax deducted, standard deduction 2,500 from AL AGI 35,500", () => {
    // Federal: 60,000 - 16,100 = 43,900; 1,240 + 12% x 31,500 = 5,020 (Form 40 line 12).
    // AL: 60,000 - 5,020 - 2,500 - 1,500 = 50,980: 10 + 100 + 5% x 47,980 = 2,509
    const al = state("AL", { income: wages(60_000) });
    expect(al.facts["us.stateFederalTaxDeduction"]).toBeCloseTo(5_020, 6);
    expect(total(al)).toBeCloseTo(2_509, 6);
  });

  it("Alabama: pensions exempt at any age; 6,000 of IRA withdrawals excluded from 65 (Schedule RS)", () => {
    const o = {
      ...old(70, [pension(30_000)]),
      withdrawals: [{ accountType: "traditional-ira" as const, amount: 10_000 }],
    };
    expect(facts("AL", o)["us.stateRetirementExclusion"]).toBeCloseTo(36_000, 6);
  });

  it("Arizona: 2,100 exemption at 65 (A.R.S. 43-1023(E))", () => {
    // (50,000 - 16,100 - 2,100) x 2.5% = 795
    expect(total(state("AZ", old(70, wages(50_000))))).toBeCloseTo(795, 6);
  });

  it("Arkansas: net income up to 94,700 uses the low-income table (Act 1 of 2026)", () => {
    // 40,000 - 2,470 = 37,530: 2% x 5,600 + 3% x 4,800 + 3.4% x 10,400 + 3.7% x 11,130
    // = 112 + 144 + 353.60 + 411.81 = 1,021.41, less the 29 personal credit = 992.41
    expect(total(state("AR", { income: wages(40_000) }))).toBeCloseTo(992.41, 6);
    // and the 29 credit for a filer over 65
    expect(total(state("AR", old(70, wages(40_000))))).toBeCloseTo(963.41, 6);
  });

  it("California: senior exemption credit 158 at 65 (Form 540 line 9); SDI 1.4% in 2027", () => {
    expect(sumKind(state("CA", old(70, wages(60_000))), "credit")).toBeCloseTo(-316, 6);
    const y2027 = state("CA", { year: 2027, income: wages(100_000) });
    expect(sumKind(y2027, "payroll")).toBeCloseTo(1_400, 6);
  });

  it("Colorado: all taxable Social Security from 65, and it reduces the 24,000 pension limit", () => {
    // pension 30,000 + SS 20,000: taxable SS 9,600 (Pub. 915), all subtracted; 24,000 - 9,600
    const o = facts("CO", old(70, [pension(30_000), ss(20_000)]));
    expect(o["us.stateSocialSecurityExempt"]).toBeCloseTo(9_600, 6);
    expect(o["us.stateRetirementExclusion"]).toBeCloseTo(14_400, 6);
  });

  it("Colorado: from 55 to 64, Social Security subtracted only up to AGI 75,000 single", () => {
    const below = facts("CO", old(60, [pension(30_000), ss(20_000)]));
    expect(below["us.stateSocialSecurityExempt"]).toBeCloseTo(9_600, 6);
    expect(below["us.stateRetirementExclusion"]).toBeCloseTo(10_400, 6);
    // pension 90,000 + SS 20,000: AGI 107,000 -> no Social Security subtraction
    const above = facts("CO", old(60, [pension(90_000), ss(20_000)]));
    expect(above["us.stateSocialSecurityExempt"]).toBe(0);
    expect(above["us.stateRetirementExclusion"]).toBe(20_000);
  });

  it("Colorado: above AGI 300,000 the federal deduction is limited to 1,000 single (2026)", () => {
    // (400,000 - 1,000) x 4.4% = 17,556
    expect(total(state("CO", { income: wages(400_000) }))).toBeCloseTo(17_556, 6);
  });

  it("Connecticut: exemption reduced 1,000 per 1,000 over 30,000; 10% personal tax credit", () => {
    // exemption 15,000 - 10,000 = 5,000; taxable 35,000: 2% x 10,000 + 4.5% x 25,000 = 1,325;
    // CT AGI 40,000 is in the 10% credit band (33,300 to 60,000): 1,325 x 0.9 = 1,192.50
    expect(total(state("CT", { income: wages(40_000) }))).toBeCloseTo(1_192.5, 6);
  });

  it("Connecticut: Social Security and pension subtractions just above federal AGI 75,000", () => {
    // pension 50,000 + SS 30,000: taxable SS 25,500, AGI 75,500. SS: 25,500 - 25% x 30,000;
    // pension: 85% at AGI 75,000 to 77,499 (12-701(a)(20)(B)(xxi)).
    const o = facts("CT", old(70, [pension(50_000), ss(30_000)]));
    expect(o["us.stateSocialSecurityExempt"]).toBeCloseTo(18_000, 6);
    expect(o["us.stateRetirementExclusion"]).toBeCloseTo(42_500, 6);
  });

  it("Delaware: 12,500 exclusion covers interest from 60; 2,500 more deduction at 65; 110 credit at 60", () => {
    // pension 40,000 + interest 10,000; exclusion 12,500; deduction 3,250 + 2,500; taxable 31,750:
    // 2.2% x 3,000 + 3.9% x 5,000 + 4.8% x 10,000 + 5.2% x 5,000 + 5.55% x 6,750 = 1,375.625;
    // credits 110 + 110 -> 1,155.625
    const o = old(66, [pension(40_000), { character: "interest" as const, amount: 10_000 }]);
    expect(total(state("DE", o))).toBeCloseTo(1_155.625, 6);
  });

  it("Georgia: the 65,000 retirement exclusion covers interest as well as pensions (IT-511)", () => {
    const o = old(66, [pension(50_000), { character: "interest" as const, amount: 30_000 }]);
    expect(facts("GA", o)["us.stateRetirementExclusion"]).toBe(65_000);
  });

  it("Hawaii: additional 1,144 exemption at 65", () => {
    // 50,000 - 8,000 - 2 x 1,144 = 39,712: 134.40 + 153.60 + 264 + 307.20 + 816
    // + 7.2% x 3,712 = 267.264 -> 1,942.464
    expect(total(state("HI", old(70, wages(50_000))))).toBeCloseTo(1_942.464, 6);
  });

  it("Illinois: 1,000 more exemption at 65; no exemption above federal AGI 250,000", () => {
    // (50,000 - 2,925 - 1,000) x 4.95% = 2,280.7125
    expect(total(state("IL", old(70, wages(50_000))))).toBeCloseTo(2_280.7125, 6);
    expect(total(state("IL", old(70, wages(300_000))))).toBeCloseTo(14_850, 6);
  });

  it("Missouri: 15% of federal income tax deducted at income 50,001 to 100,000 (RSMo 143.171)", () => {
    // federal tax 5,020 x 15% = 753; 60,000 - 753 - 16,100 = 43,147:
    // 6 bands of 1,348 at 2% to 4.5% = 262.86, + 4.7% x (43,147 - 9,436) = 1,584.417
    const mo = state("MO", { income: wages(60_000) });
    expect(mo.facts["us.stateFederalTaxDeduction"]).toBeCloseTo(753, 6);
    expect(total(mo)).toBeCloseTo(1_847.277, 6);
  });
});

describe("US state table sourcing", () => {
  it("every state and city cites at least one official source and none cites the Tax Foundation", () => {
    for (const s of US_STATES_2026) {
      expect(s.sources.length, s.code).toBeGreaterThan(0);
      for (const src of s.sources) expect(src.url, s.code).not.toMatch(/taxfoundation/i);
    }
    for (const l of US_LOCALS_2026) expect(l.source, l.code).not.toMatch(/taxfoundation/i);
  });

  it("a state with unconfirmed figures says so in its simplifications; confirmed states do not", () => {
    for (const s of US_STATES_2026) {
      const lines = reg.get(`us-state:${s.code}`).simplifications ?? [];
      const flagged = lines.some((l) => l.includes("not confirmed from an official source"));
      expect(flagged, s.code).toBe(s.unconfirmed !== undefined);
      expect(lines.slice(0, TAX_SIMPLIFICATIONS["us-state"]!.length)).toEqual(
        TAX_SIMPLIFICATIONS["us-state"],
      );
    }
  });

  it("each state's sources are the state's own (parameterised jurisdiction)", () => {
    const ca = reg.get("us-state:CA").sources ?? [];
    expect(ca.length).toBeGreaterThan(0);
    expect(ca.every((s) => s.note?.startsWith("CA:"))).toBe(true);
  });
});
