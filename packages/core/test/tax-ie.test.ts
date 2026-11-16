/**
 * Ireland 2026 vectors (Revenue tax rates, bands and credits; USC 2026; Class A PRSI). Hand-worked;
 * working inline. Revenue's band/credit method: tax at 20% / 40% on the band, less tax credits.
 */
import { describe, expect, it } from "vitest";
import { ieJurisdiction } from "../src/tax/jurisdictions/ie.js";
import { sumKind, sumLabel, taxInput, total } from "./tax-helpers.js";

const ie = (o: Parameters<typeof taxInput>[0]) =>
  ieJurisdiction.computeYear(taxInput({ country: "IE", year: 2026, ...o }), []);
const wage = (amount: number) => ({ income: [{ character: "wage" as const, amount }] });
const PRSI = (0.042 * 9 + 0.0435 * 3) / 12;

describe("Ireland 2026: single PAYE employees", () => {
  it("low, 25,000: 5,000 less credits 4,000 (personal + PAYE); USC 319.82; PRSI 4.2375%", () => {
    // USC 0.5% x 12,012 + 2% x 12,988 = 319.82
    const o = ie(wage(25_000));
    expect(sumLabel(o, /^Income tax/)).toBeCloseTo(5_000, 6);
    expect(sumKind(o, "credit")).toBeCloseTo(-4_000, 6);
    expect(sumLabel(o, /Universal Social Charge/)).toBeCloseTo(319.82, 6);
    expect(sumLabel(o, /PRSI/)).toBeCloseTo(PRSI * 25_000, 6);
  });

  it("median, 50,000: 8,800 + 40% x 6,000 = 11,200; USC 1,032.82", () => {
    const o = ie(wage(50_000));
    expect(sumLabel(o, /^Income tax/)).toBeCloseTo(11_200, 6);
    expect(sumLabel(o, /Universal Social Charge/)).toBeCloseTo(1_032.82, 6);
    expect(total(o)).toBeCloseTo(10_351.57, 6);
    expect(o.facts["tax.ordinaryBracketRate"]).toBe(0.4);
  });

  it("high, 100,000: USC 8% above 70,044 -> 4,030.62", () => {
    const o = ie(wage(100_000));
    expect(sumLabel(o, /Universal Social Charge/)).toBeCloseTo(4_030.62, 6);
    expect(total(o)).toBeCloseTo(35_468.12, 6);
  });

  it("very high, 250,000: total 113,824.37", () => {
    expect(total(ie(wage(250_000)))).toBeCloseTo(113_824.37, 6);
  });

  it("low earners: no USC at 13,000 or less; no PRSI at 352 a week or less", () => {
    const o = ie(wage(13_000));
    expect(sumLabel(o, /Universal Social Charge/)).toBe(0);
    expect(sumLabel(o, /PRSI/)).toBe(0);
  });

  it("married, jointly assessed, 70,000 + 30,000: band 53,000 + 30,000 = 83,000; credits 8,000 -> 15,400", () => {
    const o = ie({
      people: [{}, {}],
      config: { filingStatus: "married-joint" },
      income: [
        { owner: "p1", character: "wage", amount: 70_000 },
        { owner: "p2", character: "wage", amount: 30_000 },
      ],
    });
    expect(sumLabel(o, /^Income tax/)).toBeCloseTo(23_400, 6);
    expect(sumKind(o, "credit")).toBeCloseTo(-8_000, 6);
  });

  it("pension relief at 45 is limited to 25% of earnings", () => {
    const o = ie({
      people: [{ age: 45 }],
      ...wage(50_000),
      deductions: [{ amount: 20_000, accountType: "ie-pension" }],
    });
    expect(sumLabel(o, /^Income tax/)).toBeCloseTo(7_500, 6);
    // USC and PRSI are not relieved
    expect(sumLabel(o, /Universal Social Charge/)).toBeCloseTo(1_032.82, 6);
    expect(
      ieJurisdiction.contributionLimit!({
        accountType: "ie-pension",
        year: 2026,
        ownerAge: 62,
        priceIndex: 1,
        earnedIncome: 200_000,
      }),
    ).toBe(46_000);
  });
});

describe("Ireland 2026: investments and retirees", () => {
  it("DIRT 33% on deposit interest; 2026 CGT at the day-weighted 33% / 31% rate above the 1,270 exemption", () => {
    // Revenue "How to calculate CGT" (read 2026-11-16): 33% to 6 October 2026, 31% from 7 October.
    // Days: 1 Jan-6 Oct = 279, 7 Oct-31 Dec = 86. Rate (0.33 x 279 + 0.31 x 86) / 365
    //   = (92.07 + 26.66) / 365 = 118.73 / 365 = 0.325287671...
    // Gain 11,270 - 1,270 = 10,000 x 0.325287671 = 3,252.88. (Was 3,300 at 33% all year.)
    const o = ie({
      income: [
        { character: "interest", amount: 1_000 },
        { character: "capital-gains-long", amount: 11_270 },
      ],
    });
    expect(sumLabel(o, /DIRT/)).toBeCloseTo(330, 6);
    expect(sumKind(o, "capital-gains")).toBeCloseTo((10_000 * 118.73) / 365, 6);
    expect(sumKind(o, "capital-gains")).toBeCloseTo(3_252.88, 2);
  });

  it("2027 onward: CGT 31% on most gains for the whole year", () => {
    // 11,270 - 1,270 = 10,000 x 31% = 3,100.
    const o = ieJurisdiction.computeYear(
      taxInput({
        country: "IE",
        year: 2027,
        income: [{ character: "capital-gains-long", amount: 11_270 }],
      }),
      [],
    );
    expect(sumKind(o, "capital-gains")).toBeCloseTo(3_100, 6);
  });

  it("retiree, 66, State Pension 15,000 + occupational pension 25,000: tax 8,000 less 2,245 (personal + age); USC only on the occupational pension; no PRSI", () => {
    const o = ie({
      people: [{ age: 66 }],
      income: [
        { character: "pension", incomeType: "state-pension", amount: 15_000 },
        { character: "pension", amount: 25_000 },
      ],
    });
    expect(sumLabel(o, /^Income tax/)).toBeCloseTo(8_000, 6);
    expect(sumKind(o, "credit")).toBeCloseTo(-2_245, 6);
    expect(sumLabel(o, /Universal Social Charge/)).toBeCloseTo(319.82, 6);
    expect(total(o)).toBeCloseTo(6_074.82, 6);
  });
});
