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

/**
 * Revenue worked examples for 2026, reproduced from the pages' own figures (read 2026-11-19):
 * revenue.ie/en/jobs-and-pensions/calculating-your-income-tax/how-income-tax-is-calculated.aspx
 * and revenue.ie/en/jobs-and-pensions/usc/calculating-usc.aspx. Revenue works weekly or monthly;
 * the annual figures here are the same calculation on a year (no rounding of weekly amounts).
 */
describe("Revenue worked examples, 2026", () => {
  it("single, €4,000 a month: 20% x 44,000 + 40% x 4,000 = 10,400 less 4,000 credits = 6,400 (Revenue: €533.32 a month)", () => {
    const o = ie(wage(48_000));
    expect(sumLabel(o, /^Income tax/)).toBeCloseTo(10_400, 6);
    expect(sumKind(o, "credit")).toBeCloseTo(-4_000, 6);
  });

  it("civil partners, €55,000 + €20,800: band 53,000 + 20,800 = 73,800; tax 15,560 less 8,000 credits = 7,560", () => {
    const o = ie({
      people: [{}, {}],
      config: { filingStatus: "married-joint" },
      income: [
        { owner: "p1", character: "wage", amount: 55_000 },
        { owner: "p2", character: "wage", amount: 20_800 },
      ],
    });
    expect(sumLabel(o, /^Income tax/)).toBeCloseTo(73_800 * 0.2 + 2_000 * 0.4, 6);
    expect(sumKind(o, "credit")).toBeCloseTo(-8_000, 6);
  });

  it("USC example 1: self-employed €25,000 -> €319.82", () => {
    const o = ie({
      people: [{ age: 32 }],
      income: [{ character: "self-employment", amount: 25_000 }],
    });
    expect(sumLabel(o, /Universal Social Charge/)).toBeCloseTo(319.82, 6);
  });

  it("USC example 4: aged 75 on €75,000, over the €60,000 reduced-rate limit -> €2,030.62", () => {
    const o = ie({ people: [{ age: 75 }], income: [{ character: "pension", amount: 75_000 }] });
    expect(sumLabel(o, /Universal Social Charge/)).toBeCloseTo(2_030.62, 6);
  });
});

/**
 * 2027: Budget 2027 as announced (Department of Finance Tax Policy Changes Summary; PBO paper on
 * Finance (No. 2) Bill 2026, Tables 4-5): bands +2,500, main credits +125, USC 2% band to 30,300,
 * CGT 31%; Class A PRSI 4.35% to 30 September 2027 and 4.5% from 1 October 2027 (Department of
 * Finance, Budget 2027 Tax Policy Changes book, Tables 2-3 note 2).
 */
describe("Ireland 2027 (Budget 2027, announced)", () => {
  const ie27 = (o: Parameters<typeof taxInput>[0]) =>
    ieJurisdiction.computeYear(taxInput({ country: "IE", year: 2027, ...o }), []);

  it("single €50,000: 9,300 + 1,400 = 10,700 less 4,250 credits; USC 1,016.82; PRSI 4.3875%", () => {
    // USC 0.5% x 12,012 = 60.06; 2% x 18,288 = 365.76; 3% x 19,700 = 591.00
    // PRSI (4.35% x 9 + 4.5% x 3) / 12 = 4.3875% x 50,000 = 2,193.75
    const o = ie27(wage(50_000));
    expect(sumLabel(o, /^Income tax/)).toBeCloseTo(10_700, 6);
    expect(sumKind(o, "credit")).toBeCloseTo(-4_250, 6);
    expect(sumLabel(o, /Universal Social Charge/)).toBeCloseTo(1_016.82, 6);
    expect(sumLabel(o, /PRSI/)).toBeCloseTo(2_193.75, 6);
    expect(total(o)).toBeCloseTo(6_450 + 1_016.82 + 2_193.75, 6);
  });

  it("2028 onward: PRSI at 4.5%, the rate from 1 October 2027", () => {
    const o = ieJurisdiction.computeYear(
      taxInput({ country: "IE", year: 2028, ...wage(50_000) }),
      [],
    );
    expect(sumLabel(o, /PRSI/)).toBeCloseTo(2_250, 6);
  });

  it("married, €80,000 + €40,000: band 55,500 + 37,500 (the second-earner maximum) = 93,000; credits 8,500", () => {
    const o = ie27({
      people: [{}, {}],
      config: { filingStatus: "married-joint" },
      income: [
        { owner: "p1", character: "wage", amount: 80_000 },
        { owner: "p2", character: "wage", amount: 40_000 },
      ],
    });
    expect(sumLabel(o, /^Income tax/)).toBeCloseTo(93_000 * 0.2 + 27_000 * 0.4, 6);
    expect(sumKind(o, "credit")).toBeCloseTo(-8_500, 6);
  });

  it("2027 thresholds stay nominal under the legislated policy (no indexing on top of the Budget)", () => {
    const o = ieJurisdiction.computeYear(
      taxInput({ country: "IE", year: 2027, priceIndex: 1.03, ...wage(50_000) }),
      [],
    );
    expect(sumLabel(o, /^Income tax/)).toBeCloseTo(10_700, 6);
  });
});

/**
 * Retirement lump sums (revenue.ie/en/jobs-and-pensions/pension/private/retirement-lump-sums.aspx,
 * read 2026-11-19): €200,000 lifetime tax-free; €200,001-€500,000 at 20%; the excess at 40%.
 */
describe("Ireland retirement lump sums", () => {
  const lump = (amount: number, prior?: number) =>
    ie({
      people: [{ age: 62 }],
      withdrawals: [{ accountType: "ie-pension", amount, taxableAmount: 0 }],
      ...(prior !== undefined ? { history: [{ "ie.lumpSumUsed.p1": prior }] } : {}),
    });

  it("first €200,000 is tax-free", () => {
    const o = lump(200_000);
    expect(sumLabel(o, /lump sum/)).toBe(0);
    expect(o.facts["ie.lumpSumUsed.p1"]).toBe(200_000);
  });

  it("€100,000 after €150,000 already taken: 50,000 free, 50,000 at 20% = 10,000", () => {
    expect(sumLabel(lump(100_000, 150_000), /lump sum/)).toBeCloseTo(10_000, 6);
  });

  it("€100,000 after €450,000: 50,000 at 20% + 50,000 at 40% = 30,000", () => {
    const o = lump(100_000, 450_000);
    expect(sumLabel(o, /lump sum/)).toBeCloseTo(30_000, 6);
    expect(o.facts["ie.lumpSumUsed.p1"]).toBe(550_000);
  });
});

/**
 * Department of Finance, Budget 2027 Tax Policy Changes (12 October 2026), chapter 10, Table 2
 * "Single person, no children, private sector employee taxed under PAYE, full rate PRSI
 * contributor": income tax, PRSI and USC in whole euro, "existing" (2026 rules) and "proposed"
 * (2027). https://assets.gov.ie/static/documents/c6792805/20261012_Budget_2027_Tax_Policy_Changes_Book.pdf
 */
describe("Department of Finance Budget 2027 tables (official, rounded to the euro)", () => {
  const at = (year: number, amount: number) =>
    ieJurisdiction.computeYear(taxInput({ country: "IE", year, ...wage(amount) }), []);
  const rows: [number, number, number, number, number][] = [
    // [year, gross, income tax, PRSI, USC]
    [2026, 50_000, 7_200, 2_119, 1_033],
    [2026, 100_000, 27_200, 4_238, 4_031],
    [2026, 175_000, 57_200, 7_416, 10_031],
    [2027, 50_000, 6_450, 2_194, 1_017],
    [2027, 100_000, 26_450, 4_388, 4_015],
    [2027, 175_000, 56_450, 7_678, 10_015],
  ];
  for (const [year, gross, tax, prsi, usc] of rows)
    it(`${year}, €${gross}: income tax ${tax}, PRSI ${prsi}, USC ${usc}`, () => {
      const o = at(year, gross);
      // The table rounds to the euro (half up).
      const euro = (x: number) => Math.round(x + 1e-9);
      expect(euro(sumLabel(o, /^Income tax/) + sumKind(o, "credit"))).toBe(tax);
      expect(euro(sumLabel(o, /PRSI/))).toBe(prsi);
      expect(euro(sumLabel(o, /Universal Social Charge/))).toBe(usc);
    });

  it("Table 3, married one income €65,000 (2027): 6,475 with the €2,050 home carer credit, so 8,525 without it (married credit €4,250)", () => {
    // 20% x 55,500 + 40% x 9,500 = 14,900 less 4,250 (married) + 2,125 (employee) = 8,525.
    // Glideworth does not model the home carer credit (IE_SIMPLIFICATIONS).
    const o = ieJurisdiction.computeYear(
      taxInput({
        country: "IE",
        year: 2027,
        people: [{}, {}],
        config: { filingStatus: "married-joint" },
        income: [{ owner: "p1", character: "wage", amount: 65_000 }],
      }),
      [],
    );
    expect(sumLabel(o, /^Income tax/) + sumKind(o, "credit")).toBeCloseTo(6_475 + 2_050, 6);
  });
});

/** USC on retirement lump sums above €500,000 (Revenue Tax and Duty Manual Part 18D-00-01, 11.4). */
describe("Ireland: USC on the part of retirement lump sums above €500,000", () => {
  const lump = (amount: number, prior: number) =>
    ie({
      people: [{ age: 62 }],
      withdrawals: [{ accountType: "ie-pension", amount, taxableAmount: 0 }],
      history: [{ "ie.lumpSumUsed.p1": prior }],
    });

  it("no USC on a lump sum within €500,000", () => {
    expect(sumLabel(lump(100_000, 300_000), /Universal Social Charge/)).toBe(0);
  });

  it("€100,000 after €450,000: USC on the €50,000 above €500,000 = 60.06 + 333.76 + 639.00 = 1,032.82", () => {
    // 2026 USC on 50,000: 0.5% x 12,012 + 2% x 16,688 + 3% x 21,300
    expect(sumLabel(lump(100_000, 450_000), /Universal Social Charge/)).toBeCloseTo(1_032.82, 6);
  });
});
