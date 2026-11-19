/**
 * New Zealand vectors (IRD individual rates from 1 April 2025; ACC earners' levy 2026-27 and
 * 2027-28). Hand-worked; working inline. Bracket tax matches IRD's published rate table method; the
 * maximum ACC levies (2,741.22 for 2026-27, 2,932.47 for 2027-28) are IRD's published figures:
 * https://www.ird.govt.nz/income-tax/income-tax-for-individuals/acc-clients-and-carers/acc-earners-levy-rates
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

describe("New Zealand ACC earners' levy and indexation (IRD, read 2026-11-19)", () => {
  it("2026-27 maximum levy is IRD's 2,741.22 (1.75% of 156,641)", () => {
    expect(sumLabel(nz({ ...wage(156_641) }), /ACC/)).toBeCloseTo(2_741.22, 2);
    expect(sumLabel(nz({ ...wage(400_000) }), /ACC/)).toBeCloseTo(2_741.22, 2);
  });

  it("2027-28: 1.83% up to 160,244, maximum IRD's 2,932.47", () => {
    const y = (amount: number) => nz({ year: 2027, ...wage(amount) });
    expect(sumLabel(y(50_000), /ACC/)).toBeCloseTo(915, 6);
    expect(sumLabel(y(160_244), /ACC/)).toBeCloseTo(2_932.47, 2);
    expect(sumLabel(y(400_000), /ACC/)).toBeCloseTo(2_932.47, 2);
  });

  it("rates are set in law, not indexed: nominal through 2027-28 whatever the inflation", () => {
    const at = (year: number) => nz({ year, priceIndex: 1.05, ...wage(65_000) });
    expect(sumLabel(at(2027), /^Income tax/)).toBeCloseTo(11_720.5, 6);
    expect(sumLabel(at(2028), /^Income tax/)).toBeLessThan(11_720.5);
  });
});
