/**
 * Canada: official test vectors and the 2026-11-19 corrections. Synthetic people and amounts.
 *
 * - Bracket tables are checked against CRA's T4127 Payroll Deductions Formulas, 123rd edition
 *   (1 July 2026), table 8.1: annual basic tax on taxable income A is R x A - K (federal) or
 *   V x A - KP (provincial), with K and KP rounded to the dollar by CRA, so the match is to $1.
 *   https://www.canada.ca/en/revenue-agency/services/forms-publications/payroll/t4127-payroll-deductions-formulas/t4127-jul/t4127-jul-payroll-deductions-formulas.html
 * - Full-year employee vectors follow the T4127 annual formula (T3 = R x A - K - K1 - K2 - K4;
 *   T4 = V x A - KP - K1P - K2P, plus Ontario surtax V1 and health premium V2), worked inline.
 * - Credit amounts: CRA 2026 indexation table and the 2026 TD1 forms; Ontario surtax order and
 *   Health Premium chart: CRA 2025 ON428 (5006-C) Part C; CPP 2027: CRA CPP rates table (Bill C-30).
 */
import { describe, expect, it } from "vitest";
import { bands, sliceTax } from "../src/tax/common.js";
import { CA_2026, CA_PROVINCE_BY_CODE } from "../src/tax/data/ca.js";
import { caFederalJurisdiction, caProvinceJurisdiction } from "../src/tax/jurisdictions/ca.js";
import { runStack, sumLabel, taxInput } from "./tax-helpers.js";

const ca = (code: string, o: Parameters<typeof taxInput>[0]) =>
  runStack(
    [caFederalJurisdiction, caProvinceJurisdiction.parameterize!(code)],
    taxInput({ country: "CA", region: code, ...o }),
  );
const fed = (o: ReturnType<typeof ca>) => sumLabel(o[0]!, /Federal income tax/);
const prov = (o: ReturnType<typeof ca>) => sumLabel(o[1]!, /income tax/);

/** T4127 July 2026 table 8.1: [threshold A, rate, constant K or KP]. */
const T4127: Record<string, [number, number, number][]> = {
  federal: [
    [0, 0.14, 0],
    [58_523, 0.205, 3_804],
    [117_045, 0.26, 10_241],
    [181_440, 0.29, 15_685],
    [258_482, 0.33, 26_024],
  ],
  AB: [
    [0, 0.08, 0],
    [61_200, 0.1, 1_224],
    [154_259, 0.12, 4_309],
    [185_111, 0.13, 6_160],
    [246_813, 0.14, 8_628],
    [370_220, 0.15, 12_331],
  ],
  // BC: the annual 2026 rate is 5.60%; the payroll table's 6.14% (K 786, 3,606, ...) is the
  // July-December proration, so K is recomputed here for the annual rate (same thresholds).
  BC: [
    [0, 0.056, 0],
    [50_363, 0.077, 1_058],
    [100_728, 0.105, 3_878],
    [115_648, 0.1229, 5_948],
    [140_430, 0.147, 9_332],
    [190_405, 0.168, 13_331],
    [265_545, 0.205, 23_156],
  ],
  MB: [
    [0, 0.108, 0],
    [47_000, 0.1275, 917],
    [100_000, 0.174, 5_567],
  ],
  NB: [
    [0, 0.094, 0],
    [52_333, 0.14, 2_407],
    [104_666, 0.16, 4_501],
    [193_861, 0.195, 11_286],
  ],
  NL: [
    [0, 0.087, 0],
    [44_678, 0.145, 2_591],
    [89_354, 0.158, 3_753],
    [159_528, 0.178, 6_943],
    [223_340, 0.198, 11_410],
    [285_319, 0.208, 14_263],
    [570_638, 0.213, 17_117],
    [1_141_275, 0.218, 22_823],
  ],
  NS: [
    [0, 0.0879, 0],
    [30_995, 0.1495, 1_909],
    [61_991, 0.1667, 2_976],
    [97_417, 0.175, 3_784],
    [157_124, 0.21, 9_283],
  ],
  NT: [
    [0, 0.059, 0],
    [53_003, 0.086, 1_431],
    [106_009, 0.122, 5_247],
    [172_346, 0.1405, 8_436],
  ],
  NU: [
    [0, 0.04, 0],
    [55_801, 0.07, 1_674],
    [111_602, 0.09, 3_906],
    [181_439, 0.115, 8_442],
  ],
  ON: [
    [0, 0.0505, 0],
    [53_891, 0.0915, 2_210],
    [107_785, 0.1116, 4_376],
    [150_000, 0.1216, 5_876],
    [220_000, 0.1316, 8_076],
  ],
  // PE: the annual 2026 rate over 200,000 is 20%; the payroll table's 21% (K 10,464) is the
  // proration, so the last K is recomputed for 20%.
  PE: [
    [0, 0.095, 0],
    [33_928, 0.1347, 1_347],
    [65_820, 0.166, 3_407],
    [106_890, 0.1762, 4_497],
    [142_520, 0.19, 6_464],
    [200_000, 0.2, 8_464],
  ],
  SK: [
    [0, 0.105, 0],
    [54_532, 0.125, 1_091],
    [155_805, 0.145, 4_207],
  ],
  YT: [
    [0, 0.064, 0],
    [58_523, 0.09, 1_522],
    [117_045, 0.109, 3_745],
    [181_440, 0.128, 7_193],
    [500_000, 0.15, 18_193],
  ],
};

describe("Canada 2026 bracket tables match T4127 July 2026 table 8.1", () => {
  for (const [code, rows] of Object.entries(T4127)) {
    it(`${code}: R x A - K at, just below and just above every threshold`, () => {
      const table =
        code === "federal" ? CA_2026.federal.brackets : CA_PROVINCE_BY_CODE[code]!.brackets;
      expect(table.map(([a, r]) => [a, r])).toEqual(rows.map(([a, r]) => [a, r]));
      const b = bands(table, 1);
      for (let i = 0; i < rows.length; i++) {
        const [a, r, k] = rows[i]!;
        for (const income of [a - 1, a, a + 1, a + 10_000].filter((v) => v > 0)) {
          // the row that applies to this income
          const [, rr, kk] = rows.findLast(([t]) => t < income)!;
          expect(sliceTax(b, 0, income).tax, `${code} at ${income}`).toBeCloseTo(
            rr * income - kk,
            -0.3, // within $1: CRA rounds K to the dollar
          );
        }
        expect(r).toBeGreaterThan(0);
        expect(k).toBeGreaterThanOrEqual(0);
      }
    });
  }

  it("T4127 table 8.2 basic amounts: federal 16,452; provinces as tabled; NL 13,094 for 2026", () => {
    expect(CA_2026.federal.bpaMax).toBe(16_452);
    expect(CA_2026.federal.canadaEmploymentAmount).toBe(1_501);
    const tabled: Record<string, number> = {
      AB: 22_769,
      BC: 13_216,
      MB: 15_780,
      NB: 13_664,
      NS: 11_932,
      NT: 18_198,
      NU: 19_659,
      ON: 12_989,
      PE: 15_000,
      SK: 20_381,
      // NL: 13,094 is the 2026 annual amount ("increase ... from $11,188 to $13,094 effective
      // January 1, 2026"); table 8.2's 15,000 is the July-December payroll proration.
      NL: 13_094,
    };
    for (const [code, bpa] of Object.entries(tabled))
      expect(CA_PROVINCE_BY_CODE[code]!.bpa, code).toBe(bpa);
  });
});

describe("Canada 2026 full-year employees (T4127 annual formula)", () => {
  it("Manitoba, $60,000: brackets 47,000 / 100,000 (indexation paused), BPA 15,780", () => {
    // CPP 4.95% base 2,796.75 (credit) and 1% enhanced 565 (deduction); EI 978. A = 59,435.
    // T4 = 12.75% x 59,435 - 917 - 10.8% x (15,780 + 2,796.75 + 978)
    const o = ca("MB", { income: [{ character: "wage", amount: 60_000 }] });
    const t4 = 0.1275 * 59_435 - 47_000 * (0.1275 - 0.108) - 0.108 * (15_780 + 2_796.75 + 978);
    expect(prov(o)).toBeCloseTo(t4, 6);
    expect(prov(o)).toBeCloseTo(4_549.55, 2);
  });

  it("Ontario, $150,000 wage + $20,000 eligible dividends: the surtax is worked before the dividend credit (ON428)", () => {
    // CPP base 3,519.45, enhanced 711, CPP2 4% x (85,000 - 74,600) = 416; EI 1,123.07. Dividends
    // grossed up 38% = 27,600. Taxable A = 150,000 - 711 - 416 + 27,600 = 176,473.
    // Ontario basic: 12.16% x A - 5,876 (KP exact 5,876.01) = 15,583.11
    // credits 5.05% x (12,989 + 3,519.45 + 1,123.07) = 890.39 -> line 62: 14,692.72
    // surtax 20% x (14,692.72 - 5,818) + 36% x (14,692.72 - 7,446) = 1,774.94 + 2,608.82 = 4,383.76
    // dividend tax credit 10% x 27,600 = 2,760 is taken after the surtax: Ontario total 16,316.48.
    // (Before the fix the surtax was worked after the credit, on 11,932.72: 2,838.16.)
    const o = ca("ON", {
      income: [
        { character: "wage", amount: 150_000 },
        { character: "qualified-dividend", amount: 20_000, dividendTreatment: "ca-eligible" },
      ],
    });
    const a = 150_000 - 711 - 416 + 27_600;
    const kp =
      53_891 * (0.0915 - 0.0505) + 107_785 * (0.1116 - 0.0915) + 150_000 * (0.1216 - 0.1116);
    const line62 = 0.1216 * a - kp - 0.0505 * (12_989 + 3_519.45 + 1_123.07);
    const surtax = 0.2 * (line62 - 5_818) + 0.36 * (line62 - 7_446);
    expect(sumLabel(o[1]!, /Ontario surtax/) + prov(o)).toBeCloseTo(line62 + surtax - 2_760, 6);
    expect(sumLabel(o[1]!, /Ontario surtax/)).toBeCloseTo(surtax, 6);
    expect(surtax).toBeCloseTo(4_383.76, 2);
  });

  it("Manitoba basic personal amount: full to $200,000, nil from $400,000 (TD1MB 2026)", () => {
    // Interest income only, so net income = taxable income = the amount.
    const mb = (amount: number) => prov(ca("MB", { income: [{ character: "interest", amount }] }));
    const basic = (a: number) => 0.174 * a - 5_566.5; // KP exact (CRA rounds to 5,567)
    expect(mb(200_000)).toBeCloseTo(basic(200_000) - 0.108 * 15_780, 6);
    // halfway: 15,780 x (1 - 100,000 / 200,000)
    expect(mb(300_000)).toBeCloseTo(basic(300_000) - 0.108 * 7_890, 6);
    expect(mb(400_000)).toBeCloseTo(basic(400_000), 6);
  });

  it("Yukon basic personal amount follows the federal one, reduced between 181,440 and 258,482", () => {
    // Net income 219,961 is halfway: 16,452 - 1,623 / 2 = 15,640.50 (CRA: enhanced part 1,623).
    const o = ca("YT", { income: [{ character: "interest", amount: 219_961 }] });
    const ytBasic = 0.128 * 219_961 - 7_193; // KP exact 7,192.81
    expect(prov(o)).toBeCloseTo(ytBasic - 0.064 * 15_640.5, -0.3);
    const fedBasic = 0.29 * 219_961 - 15_685;
    expect(fed(o)).toBeCloseTo(fedBasic - 0.14 * 15_640.5, -0.3);
  });

  it("Saskatchewan senior supplementary amount 2,569 at 65+ (TD1SK 2026)", () => {
    // Age 70, $30,000 of RRIF income: net income under the 43,927 age threshold.
    const sk = (age: number) =>
      prov(
        ca("SK", {
          people: [{ age }],
          withdrawals: [{ accountType: "ca-rrif", amount: 30_000, taxableAmount: 30_000 }],
        }),
      );
    // 10.5% x (30,000 - 20,381 BPA - 5,901 age - 2,569 supplement - 1,000 pension) = 15.645
    expect(sk(70)).toBeCloseTo(0.105 * (30_000 - 20_381 - 5_901 - 2_569 - 1_000), 6);
    expect(sk(60)).toBeCloseTo(0.105 * (30_000 - 20_381), 6);
  });

  it("age amount is reduced on net income after the OAS repayment (line 23600)", () => {
    // Age 70: pension 100,000 + OAS 9,000. Recovery tax 15% x (109,000 - 95,323) = 2,051.55;
    // line 23600 = 106,948.45; age amount 9,208 - 15% x (106,948.45 - 46,432) = 130.5325.
    const o = ca("ON", {
      people: [{ age: 70 }],
      income: [
        { character: "pension", amount: 100_000 },
        { character: "pension", amount: 9_000, incomeType: "ca-oas" },
      ],
    });
    expect(sumLabel(o[0]!, /OAS recovery/)).toBeCloseTo(2_051.55, 6);
    const a = 106_948.45;
    const basic = 0.205 * a - 3_803.995;
    expect(fed(o)).toBeCloseTo(basic - 0.14 * (16_452 + 130.5325 + 2_000), 4);
  });
});

describe("Canada CPP: 2027 base rate and the age limit", () => {
  it("2027: base CPP 4.75% (Bill C-30; CRA: 2027 employee rate 5.75%)", () => {
    // 2026 amounts (YMPE 74,600) indexed with the plan; priceIndex 1 keeps them for the vector.
    const o = ca("ON", { year: 2027, income: [{ character: "wage", amount: 60_000 }] });
    expect(sumLabel(o[0]!, /CPP/)).toBeCloseTo(0.0575 * (60_000 - 3_500), 6);
    expect(CA_2026.cpp.baseRateFrom2027 + CA_2026.cpp.enhancedRate).toBeCloseTo(0.0575, 10);
  });

  it("no CPP from age 70; QPP still applies in Quebec", () => {
    const at = (age: number, code = "ON") =>
      sumLabel(
        ca(code, { people: [{ age }], income: [{ character: "wage", amount: 60_000 }] })[0]!,
        /CPP|QPP/,
      );
    expect(at(69)).toBeCloseTo(0.0595 * 56_500, 6);
    expect(at(70)).toBe(0);
    expect(at(70, "QC")).toBeCloseTo(0.063 * 56_500, 6);
  });
});

describe("Canada: legislated provincial indexation pauses", () => {
  it("British Columbia keeps its 2026 brackets for 2027-2030, then indexes", () => {
    const bcTax = (year: number, priceIndex: number) =>
      prov(ca("BC", { year, priceIndex, income: [{ character: "interest", amount: 100_000 }] }));
    // 2028 with 10% inflation: BC unchanged from 2026 (the federal side still indexes)
    expect(bcTax(2028, 1.1)).toBeCloseTo(bcTax(2026, 1), 6);
    // 2031: indexation resumes (from the index at the end of the pause; none recorded here)
    expect(bcTax(2031, 1.1)).toBeLessThan(bcTax(2026, 1));
  });

  it("Manitoba keeps 47,000 / 100,000 and 15,780 in later years (pause has no end date)", () => {
    const mbTax = (year: number, priceIndex: number) =>
      prov(ca("MB", { year, priceIndex, income: [{ character: "interest", amount: 80_000 }] }));
    expect(mbTax(2035, 1.25)).toBeCloseTo(mbTax(2026, 1), 6);
  });

  it("Newfoundland and Labrador: basic amount 13,094 in 2026 and 15,000 from 2027", () => {
    const nl = (year: number) =>
      prov(ca("NL", { year, income: [{ character: "interest", amount: 30_000 }] }));
    expect(nl(2026)).toBeCloseTo(0.087 * (30_000 - 13_094), 6);
    expect(nl(2027)).toBeCloseTo(0.087 * (30_000 - 15_000), 6);
  });
});
