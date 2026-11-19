/**
 * Australia: test vectors from the legislation (synthetic people and amounts).
 *
 * - Resident rates: Income Tax Rates Act 1986 Schedule 7, as amended by the Treasury Laws Amendment
 *   (More Cost of Living Relief) Act 2025 (No. 28, 2025): 2026-27 15% / 30% / 37% / 45%; 2027-28 and
 *   later 14% first rate. https://www.legislation.gov.au/C2025A00028/asmade/text
 *   The tax at each threshold is the "plus" figure of the rate table: 2026-27 4,020 at 45,000,
 *   31,020 at 135,000, 51,370 at 190,000.
 * - Medicare levy low-income thresholds from 2025-26: Treasury Laws Amendment (Delivering an
 *   Efficient and Trusted Tax System) Act 2026 (No. 58), Schedule 5: singles 28,011 (phase-in limit
 *   35,013), seniors and pensioners 44,268 (phase-in limit 55,335); shade-in 10% of the excess
 *   (Medicare Levy Act 1986 s 7). https://www.legislation.gov.au/C2026A00058/asmade/text
 * - LITO: 700, less 5% of taxable income over 37,500 and 1.5% over 45,000 (ITAA 1997 s 61-115).
 */
import { describe, expect, it } from "vitest";
import { AU_YEARS } from "../src/tax/data/au.js";
import { auJurisdiction } from "../src/tax/jurisdictions/au.js";
import { sumLabel, taxInput } from "./tax-helpers.js";

const au = (o: Parameters<typeof taxInput>[0]) =>
  auJurisdiction.computeYear(taxInput({ country: "AU", ...o }), []);
const wage = (amount: number, year = 2026, priceIndex = 1, age = 40) =>
  au({ year, priceIndex, people: [{ age }], income: [{ character: "wage", amount }] });
const incomeTax = (o: ReturnType<typeof au>) => sumLabel(o, /^Income tax/);
const lito = (o: ReturnType<typeof au>) => -sumLabel(o, /Tax offsets/);
const medicare = (o: ReturnType<typeof au>) => sumLabel(o, /Medicare levy/);

describe("Australia resident rates (Income Tax Rates Act 1986 Schedule 7)", () => {
  it("2026-27: nil to 18,200; 4,020 at 45,000; 31,020 at 135,000; 51,370 at 190,000", () => {
    expect(incomeTax(wage(18_200))).toBe(0);
    expect(incomeTax(wage(18_201))).toBeCloseTo(0.15, 6);
    expect(incomeTax(wage(45_000))).toBeCloseTo(4_020, 6);
    expect(incomeTax(wage(45_001))).toBeCloseTo(4_020.3, 6);
    expect(incomeTax(wage(135_000))).toBeCloseTo(31_020, 6);
    expect(incomeTax(wage(190_000))).toBeCloseTo(51_370, 6);
    expect(incomeTax(wage(200_000))).toBeCloseTo(51_370 + 4_500, 6);
  });

  it("2025-26 first rate 16% (4,288 at 45,000); 2027-28 first rate 14% (3,752 at 45,000)", () => {
    expect(incomeTax(wage(45_000, 2025))).toBeCloseTo(4_288, 6);
    expect(incomeTax(wage(45_000, 2027))).toBeCloseTo(3_752, 6);
    expect(incomeTax(wage(190_000, 2027))).toBeCloseTo(3_752 + 27_000 + 20_350, 6);
  });

  it("legislated amounts are nominal through 2027-28: inflation does not move the thresholds", () => {
    expect(incomeTax(wage(45_000, 2027, 1.05))).toBeCloseTo(3_752, 6);
    expect(medicare(wage(30_000, 2027, 1.05))).toBeCloseTo(0.1 * (30_000 - 28_011), 6);
    // 2028-29 onward carries the 2027-28 table forward, indexed with the plan policy.
    expect(incomeTax(wage(45_000, 2028, 1.05))).toBeLessThan(3_752);
  });
});

describe("Low income tax offset (ITAA 1997 s 61-115)", () => {
  it("700 to 37,500; 325 at 45,000; nil from 66,667", () => {
    expect(lito(wage(30_000))).toBeCloseTo(700, 6);
    expect(lito(wage(37_500))).toBeCloseTo(700, 6);
    expect(lito(wage(45_000))).toBeCloseTo(325, 6);
    expect(lito(wage(66_667))).toBeCloseTo(0, 2);
    expect(lito(wage(80_000))).toBeCloseTo(0, 6);
  });
});

describe("Medicare levy low-income thresholds (Act No. 58 of 2026, from 2025-26)", () => {
  it("data: singles 28,011, families 47,238 + 4,338 per child, single seniors 44,268, both years", () => {
    for (const y of AU_YEARS) {
      expect(y.medicare.singleThreshold, y.label).toBe(28_011);
      expect(y.medicare.familyThreshold, y.label).toBe(47_238);
      expect(y.medicare.perChild, y.label).toBe(4_338);
      expect(y.medicare.seniorSingleThreshold, y.label).toBe(44_268);
    }
  });

  it("singles: nil at 28,011; 10% shade-in above; full 2% from the 35,013 phase-in limit", () => {
    expect(medicare(wage(28_011))).toBe(0);
    expect(medicare(wage(28_012))).toBeCloseTo(0.1, 6);
    expect(medicare(wage(30_000))).toBeCloseTo(198.9, 6);
    expect(medicare(wage(35_013))).toBeCloseTo(700.2, 6);
    expect(medicare(wage(35_014))).toBeCloseTo(700.28, 6);
    expect(medicare(wage(80_000))).toBeCloseTo(1_600, 6);
    // 2025-26 uses the same thresholds
    expect(medicare(wage(30_000, 2025))).toBeCloseTo(198.9, 6);
  });

  it("seniors and pensioners (67+ in the model): nil at 44,268; full 2% from 55,335", () => {
    expect(medicare(wage(44_268, 2026, 1, 70))).toBe(0);
    expect(medicare(wage(50_000, 2026, 1, 70))).toBeCloseTo(573.2, 6);
    expect(medicare(wage(55_335, 2026, 1, 70))).toBeCloseTo(1_106.7, 6);
    expect(medicare(wage(60_000, 2026, 1, 70))).toBeCloseTo(1_200, 6);
  });
});
