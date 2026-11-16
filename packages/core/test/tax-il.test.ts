/**
 * Israel 2026 vectors (brackets per the Economic Efficiency Law 2026, credit point 2,904, National
 * Insurance Institute 2026 thresholds). Hand-worked; working inline. No official calculator could
 * be queried (gov.il refuses automated access).
 */
import { describe, expect, it } from "vitest";
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

  it("pension contributions earn a 35% credit up to 7% of salary", () => {
    const o = il({ ...wage(150_000), deductions: [{ amount: 9_000, accountType: "il-pension" }] });
    expect(sumKind(o, "credit")).toBeCloseTo(-(CREDITS + 0.35 * 9_000), 6);
    const capped = il({
      ...wage(150_000),
      deductions: [{ amount: 20_000, accountType: "il-pension" }],
    });
    expect(sumKind(capped, "credit")).toBeCloseTo(-(CREDITS + 0.35 * 10_500), 6);
  });
});

describe("Israel 2026: capital income and retirees", () => {
  it("25% on (nominal) gains and dividends; +3% +2% surtax on capital above 721,560", () => {
    const o = il({
      income: [
        { character: "wage", amount: 800_000 },
        { character: "capital-gains-long", amount: 100_000 },
      ],
    });
    expect(sumKind(o, "capital-gains")).toBeCloseTo(25_000, 6);
    // total 900,000 - 721,560 = 178,440 over: 3% x 178,440 + 2% x 100,000
    expect(sumLabel(o, /Surtax/)).toBeCloseTo(5_353.2 + 2_000, 6);
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
