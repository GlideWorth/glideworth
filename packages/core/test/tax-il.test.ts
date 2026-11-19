/**
 * Israel 2026 vectors: brackets per the Economic Efficiency Law 2026 (Book of Laws 3511), credit
 * point 2,904, National Insurance Institute 2026 rates and thresholds. The "official" vectors are
 * the Knesset Research and Information Center's worked figures of 9 February 2026 (monthly tax
 * before credits under the enacted brackets, and the 8,000-a-month example with credit points);
 * the brackets are annual = 12 x monthly, so annual tax = 12 x the monthly figure. Other vectors are
 * hand-worked with the working inline. No official calculator could be queried (gov.il refuses
 * automated access). Checked 2026-11-19.
 */
import { describe, expect, it } from "vitest";
import { IL_YEARS } from "../src/tax/data/il.js";
import { ilJurisdiction } from "../src/tax/jurisdictions/il.js";
import { sumKind, sumLabel, taxInput, total } from "./tax-helpers.js";

const il = (o: Parameters<typeof taxInput>[0]) =>
  ilJurisdiction.computeYear(taxInput({ country: "IL", year: 2026, ...o }), []);
const wage = (amount: number) => ({ income: [{ character: "wage" as const, amount }] });
const CREDITS = 2.25 * 2_904;

describe("Israel 2026: employees (resident, 40)", () => {
  it("low, 60,000: 10% = 6,000, fully offset by 2.25 credit points (6,534); NI + health 4.27% = 2,562", () => {
    const o = il(wage(60_000));
    expect(sumLabel(o, /^Income tax/)).toBeCloseTo(6_000, 6);
    expect(sumKind(o, "credit")).toBeCloseTo(-6_000, 6);
    expect(sumLabel(o, /National Insurance/)).toBeCloseTo(2_562, 6);
  });

  it("median, 150,000: 8,412 + 14% x 36,600 + 20% x 29,280 = 19,392 less 6,534; NI reduced to 92,436 then 12.17%", () => {
    const o = il(wage(150_000));
    expect(sumLabel(o, /^Income tax/)).toBeCloseTo(19_392, 6);
    expect(sumLabel(o, /National Insurance/)).toBeCloseTo(0.0427 * 92_436 + 0.1217 * 57_564, 6);
    expect(total(o)).toBeCloseTo(19_392 - CREDITS + 10_952.556, 6);
    expect(o.facts["tax.ordinaryBracketRate"]).toBe(0.2);
  });

  it("high, 400,000: 31% band to 301,200 then 35%; tax 92,264", () => {
    const o = il(wage(400_000));
    expect(sumLabel(o, /^Income tax/)).toBeCloseTo(92_264, 6);
    expect(o.facts["tax.ordinaryBracketRate"]).toBe(0.35);
  });

  it("very high, 1,000,000: 47% band, 3% surtax above 721,560 = 8,353.20; NI capped at 622,920", () => {
    const o = il(wage(1_000_000));
    expect(sumLabel(o, /^Income tax/)).toBeCloseTo(355_030.4, 6);
    expect(sumLabel(o, /Surtax/)).toBeCloseTo(8_353.2, 6);
    expect(sumLabel(o, /National Insurance/)).toBeCloseTo(68_506.92, 6);
  });

  it("pension contributions earn a 35% credit up to 7% of salary and 658 a month (credit at most 230.30 a month)", () => {
    const o = il({ ...wage(100_000), deductions: [{ amount: 5_000, accountType: "il-pension" }] });
    expect(sumKind(o, "credit")).toBeCloseTo(-(CREDITS + 0.35 * 5_000), 6);
    // 7% of 100,000 = 7,000 limits a 9,000 contribution
    const byWage = il({
      ...wage(100_000),
      deductions: [{ amount: 9_000, accountType: "il-pension" }],
    });
    expect(sumKind(byWage, "credit")).toBeCloseTo(-(CREDITS + 0.35 * 7_000), 6);
    // 658 x 12 = 7,896 limits it at 150,000 (7% would be 10,500): credit 12 x 230.30 = 2,763.60
    const capped = il({
      ...wage(150_000),
      deductions: [{ amount: 20_000, accountType: "il-pension" }],
    });
    expect(sumKind(capped, "credit")).toBeCloseTo(-(CREDITS + 12 * 230.3), 6);
  });
});

describe("Israel 2026: capital income and retirees", () => {
  it("25% on (nominal) gains and dividends; 3% surtax on total income above 721,560; the extra 2% only on capital income above 721,560 (s. 121B(a1))", () => {
    const o = il({
      income: [
        { character: "wage", amount: 800_000 },
        { character: "capital-gains-long", amount: 100_000 },
      ],
    });
    expect(sumKind(o, "capital-gains")).toBeCloseTo(25_000, 6);
    // total 900,000 - 721,560 = 178,440 over: 3% x 178,440; capital 100,000 is under 721,560, no 2%
    expect(sumLabel(o, /Surtax/)).toBeCloseTo(5_353.2, 6);
    // capital only, 1,000,000 of gains: (3% + 2%) x 278,440 = 13,922
    const cap = il({ income: [{ character: "capital-gains-long", amount: 1_000_000 }] });
    expect(sumLabel(cap, /Surtax/)).toBeCloseTo(13_922, 6);
    expect(total(cap)).toBeCloseTo(250_000 + 13_922, 6);
    const div = il({ income: [{ character: "qualified-dividend", amount: 40_000 }] });
    expect(total(div)).toBeCloseTo(10_000, 6);
  });

  it("retiree, 70, pension 120,000: 13,435.20 less credit points; no National Insurance after 67", () => {
    const o = il({ people: [{ age: 70 }], income: [{ character: "pension", amount: 120_000 }] });
    expect(sumLabel(o, /^Income tax/)).toBeCloseTo(13_435.2, 6);
    expect(sumKind(o, "payroll")).toBe(0);
    expect(total(o)).toBeCloseTo(13_435.2 - CREDITS, 6);
    expect(
      ilJurisdiction.pensionAccessAge!({
        accountType: "il-pension",
        birthYear: 1980,
        birthMonth: 1,
      }),
    ).toBe(67);
  });
});

describe("Israel 2026: official figures (Knesset Research and Information Center, 9 Feb 2026)", () => {
  // Table 5: monthly tax before credits under the enacted brackets (rounded to 0.1 a month)
  const rows: [number, number][] = [
    [6_248, 624.8],
    [12_496, 1_615.2],
    [14_349, 1_985.8],
    [16_150, 2_346.0],
    [20_625, 3_419.8],
    [25_100, 4_807.0],
    [28_698, 6_066.3],
  ];
  it.each(rows)("monthly wage %d: tax before credits %d a month", (monthly, tax) => {
    const o = il(wage(12 * monthly));
    expect(Math.abs(sumLabel(o, /^Income tax/) - 12 * tax)).toBeLessThan(12 * 0.05 + 1e-6);
  });

  it("8,000 a month: 839.60 before credits, 295.10 after 2.25 credit points (544.50 a month)", () => {
    const o = il(wage(96_000));
    expect(sumLabel(o, /^Income tax/)).toBeCloseTo(12 * 839.6, 6);
    expect(sumLabel(o, /^Income tax/) + sumKind(o, "credit")).toBeCloseTo(12 * 295.1, 6);
  });

  it("brackets, credit point and NI thresholds as tabled", () => {
    const d = IL_YEARS[0]!;
    expect(d.brackets.map((b) => b[0])).toEqual([0, 84_120, 120_720, 228_000, 301_200, 560_280]);
    expect(d.creditPoint).toBe(12 * 242);
    expect(d.surtax.threshold).toBe(12 * 60_130);
    expect(d.nationalInsurance.reducedUpTo).toBe(12 * 7_703);
    expect(d.nationalInsurance.max).toBe(12 * 51_910);
    expect(d.nationalInsurance.reducedRate).toBeCloseTo(0.0427, 12);
    expect(d.nationalInsurance.fullRate).toBeCloseTo(0.1217, 12);
  });
});

describe("Israel: amounts frozen through 2027 (s. 120B(e)), National Insurance indexed", () => {
  it("2027 with 5% inflation: same income tax as 2026; NI thresholds rise with prices", () => {
    const o = il({ ...wage(150_000), year: 2027, priceIndex: 1.05 });
    expect(sumLabel(o, /^Income tax/)).toBeCloseTo(19_392, 6);
    expect(sumKind(o, "credit")).toBeCloseTo(-CREDITS, 6);
    const reduced = 92_436 * 1.05;
    expect(sumLabel(o, /National Insurance/)).toBeCloseTo(
      0.0427 * reduced + 0.1217 * (150_000 - reduced),
      6,
    );
  });

  it("2028 indexes from the 2027 anchor", () => {
    const o = il({
      ...wage(150_000),
      year: 2028,
      priceIndex: 1.1,
      history: [{ "il.indexAnchor": 1.05 }],
    });
    const f = 1.1 / 1.05;
    expect(sumKind(o, "credit")).toBeCloseTo(-CREDITS * f, 6);
  });
});
