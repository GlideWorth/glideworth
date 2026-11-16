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

  it("Oregon: estimated 2026 standard deduction 2,900 and exemption credit 260", () => {
    // taxable 72,100: 4.75% x 4,550 = 216.125; 6.75% x 6,850 = 462.375;
    // 8.75% x (72,100 - 11,400 = 60,700) = 5,311.25 -> 5,989.75, less 260 = 5,729.75
    expect(total(state("OR", { income: wages(75_000) }))).toBeCloseTo(5_729.75, 6);
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
