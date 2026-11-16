/**
 * New Zealand vectors (IRD individual rates; ACC earners' levy 2026/27). Hand-worked; working
 * inline. Bracket tax matches IRD's published rate table method.
 */
import { describe, expect, it } from "vitest";
import { nzJurisdiction } from "../src/tax/jurisdictions/nz.js";
import { sumKind, sumLabel, taxInput, total } from "./tax-helpers.js";

const nz = (o: Parameters<typeof taxInput>[0]) =>
  nzJurisdiction.computeYear(taxInput({ country: "NZ", year: 2026, ...o }), []);
const wage = (amount: number) => ({ income: [{ character: "wage" as const, amount }] });

describe("New Zealand 2026-27", () => {
  it("low, 30,000: 1,638 + 17.5% x 14,400 = 4,158; ACC 1.75% = 525", () => {
    const o = nz(wage(30_000));
    expect(sumLabel(o, /^Income tax/)).toBeCloseTo(4_158, 6);
    expect(sumLabel(o, /ACC/)).toBeCloseTo(525, 6);
  });

  it("median, 65,000: 11,720.50; 30% bracket", () => {
    const o = nz(wage(65_000));
    expect(sumLabel(o, /^Income tax/)).toBeCloseTo(11_720.5, 6);
    expect(o.facts["tax.ordinaryBracketRate"]).toBe(0.3);
  });

  it("high, 120,000: 29,477.50; 33% bracket", () => {
    const o = nz(wage(120_000));
    expect(sumLabel(o, /^Income tax/)).toBeCloseTo(29_477.5, 6);
    expect(o.facts["tax.ordinaryBracketRate"]).toBe(0.33);
  });

  it("very high, 250,000: 39% bracket; ACC capped at 156,641 -> 2,741.22", () => {
    const o = nz(wage(250_000));
    expect(sumLabel(o, /^Income tax/)).toBeCloseTo(76_577.5, 6);
    expect(sumLabel(o, /ACC/)).toBeCloseTo(2_741.2175, 6);
  });

  it("no capital gains tax; dividends fully imputed (7,200 cash -> 10,000 gross, 2,800 credit)", () => {
    const g = nz({
      income: [
        { character: "wage", amount: 65_000 },
        { character: "capital-gains-long", amount: 50_000 },
      ],
    });
    expect(sumKind(g, "capital-gains")).toBe(0);
    expect(total(g)).toBeCloseTo(11_720.5 + 1_137.5, 6);
    const d = nz({
      income: [
        { character: "wage", amount: 65_000 },
        { character: "qualified-dividend", amount: 7_200 },
      ],
    });
    // extra tax 3,000 on 10,000 gross, less the 2,800 imputation credit
    expect(total(d)).toBeCloseTo(11_720.5 + 1_137.5 + 200, 6);
  });

  it("retiree, 70, NZ Super 30,000: 4,158; no ACC; KiwiSaver from 65 is tax-free", () => {
    const o = nz({
      people: [{ age: 70 }],
      income: [{ character: "pension", incomeType: "state-pension", amount: 30_000 }],
      withdrawals: [
        { accountType: "nz-kiwisaver", treatment: "tax-free", amount: 20_000, taxableAmount: 0 },
      ],
    });
    expect(total(o)).toBeCloseTo(4_158, 6);
    expect(
      nzJurisdiction.pensionAccessAge!({
        accountType: "nz-kiwisaver",
        birthYear: 1990,
        birthMonth: 1,
      }),
    ).toBe(65);
  });
});
