/**
 * Canada (CRA 2026 rates, 2026 TD1 credit amounts) and Australia (ATO 2026-27 resident rates)
 * vectors, plus the generic custom jurisdiction. Hand-worked; working inline.
 */
import { describe, expect, it } from "vitest";
import { auJurisdiction } from "../src/tax/jurisdictions/au.js";
import {
  caFederalJurisdiction,
  caProvinceJurisdiction,
  caRrifMinimum,
} from "../src/tax/jurisdictions/ca.js";
import { customJurisdiction } from "../src/tax/jurisdictions/custom.js";
import { runStack, sumKind, sumLabel, taxInput, total } from "./tax-helpers.js";

const caStack = (code: string) => [
  caFederalJurisdiction,
  caProvinceJurisdiction.parameterize!(code),
];
const ca = (code: string, o: Parameters<typeof taxInput>[0]) =>
  runStack(caStack(code), taxInput({ country: "CA", region: code, ...o }));

describe("Canada 2026", () => {
  it("Ontario employee, $80,000: CPP 4,230.45 + CPP2 216; EI 1,123.07; federal 9,242.60; Ontario 4,885.26", () => {
    // CPP 5.95% x (74,600 - 3,500); enhanced 1/5.95 share (711) and CPP2 deductible -> taxable 79,073
    // federal: 8,193.22 + 20,550 x 20.5% = 12,405.97 - 14% x (16,452 + 1,501 + 3,519.45 + 1,123.07)
    // Ontario: 2,721.50 + 25,182 x 9.15% - 5.05% x (12,989 + 3,519.45 + 1,123.07) + health premium 750
    const [f, p] = ca("ON", { income: [{ character: "wage", amount: 80_000 }] });
    expect(sumLabel(f!, /CPP/)).toBeCloseTo(4_230.45 + 216, 6);
    expect(sumLabel(f!, /EI/)).toBeCloseTo(1_123.07, 6);
    expect(sumLabel(f!, /Federal income tax/)).toBeCloseTo(9_242.5972, 3);
    expect(total(p!)).toBeCloseTo(4_135.25674 + 750, 3);
  });

  it("$50,000 of eligible dividends alone attracts no federal tax (gross-up 38%, DTC 15.0198%)", () => {
    const [f] = ca("ON", {
      income: [
        { character: "qualified-dividend", amount: 50_000, dividendTreatment: "ca-eligible" },
      ],
    });
    expect(sumLabel(f!, /Federal income tax/)).toBe(0);
    expect(f!.facts["ca.taxableIncome.p1"]).toBeCloseTo(69_000, 6);
  });

  it("50% capital gains inclusion", () => {
    const [f] = ca("AB", {
      income: [
        { character: "wage", amount: 80_000 },
        { character: "capital-gains-long", amount: 20_000 },
      ],
    });
    const [g] = ca("AB", { income: [{ character: "wage", amount: 80_000 }] });
    expect(f!.facts["ca.taxableIncome.p1"]! - g!.facts["ca.taxableIncome.p1"]!).toBeCloseTo(
      10_000,
      6,
    );
  });

  it("OAS recovery tax: 15% of net income over $95,323, capped at OAS received", () => {
    const [f] = ca("BC", {
      people: [{ age: 70 }],
      income: [
        { character: "pension", amount: 91_000 },
        { character: "pension", amount: 9_000, incomeType: "ca-oas" },
      ],
    });
    expect(sumLabel(f!, /OAS recovery/)).toBeCloseTo(0.15 * (100_000 - 95_323), 6);
  });

  it("Quebec employee, $80,000: QPP 6.3% (5.3% base + 1%) 4,479.30 + QPP2 216; EI 1.30% 895.70", () => {
    // CRA T4127 (Jan 2026) tables 8.3-8.5: QPP rate 0.063 on 74,600 - 3,500 = 71,100 -> 4,479.30
    // (was 6.4% / 4,550.40); second additional 4% x (80,000 - 74,600) = 216.
    // CRA EI page: Quebec rate 1.30% x 68,900 = 895.70.
    const [f] = ca("QC", { income: [{ character: "wage", amount: 80_000 }] });
    expect(sumLabel(f!, /QPP/)).toBeCloseTo(4_479.3 + 216, 6);
    expect(sumLabel(f!, /EI/)).toBeCloseTo(895.7, 6);
  });

  it("Quebec abatement is 16.5% of basic federal tax", () => {
    const [f] = ca("QC", { income: [{ character: "wage", amount: 80_000 }] });
    const fedTax = sumLabel(f!, /Federal income tax/);
    expect(-sumLabel(f!, /Quebec abatement/)).toBeCloseTo(fedTax * 0.165, 6);
  });

  it("pension splitting lowers a couple’s combined tax", () => {
    const o = {
      people: [{ age: 70 }, { age: 70 }],
      config: { filingStatus: "married-joint" as const },
      income: [{ owner: "p1", character: "pension" as const, amount: 90_000 }],
    };
    const split = ca("ON", o);
    const none = ca("ON", {
      ...o,
      config: { ...o.config, lawToggles: { "ca.pensionSplitting": false } },
    });
    expect(split[0]!.facts["ca.pensionSplitIn.p2"]).toBeGreaterThan(0);
    expect(total(split[0]!) + total(split[1]!)).toBeLessThan(
      total(none[0]!) + total(none[1]!) - 1_000,
    );
  });

  it("RRIF minimum: 1/(90-age) under 71, 5.40% at 72", () => {
    const q = {
      accountType: "ca-rrif" as const,
      rule: "ca-rrif",
      year: 2026,
      ownerBirthYear: 1954,
      priorYearEndBalance: 100_000,
    };
    expect(caRrifMinimum({ ...q, ownerAge: 65 })).toBeCloseTo(4_000, 6);
    expect(caRrifMinimum({ ...q, ownerAge: 72 })).toBeCloseTo(5_400, 6);
  });
});

const au = (o: Parameters<typeof taxInput>[0]) =>
  auJurisdiction.computeYear(taxInput({ country: "AU", year: 2026, ...o }), []);

describe("Australia 2026-27 (resident)", () => {
  it("$100,000 salary: 26,800 x 15% + 55,000 x 30% = 20,520 + Medicare 2,000", () => {
    const o = au({ income: [{ character: "wage", amount: 100_000 }] });
    expect(sumLabel(o, /^Income tax/)).toBeCloseTo(20_520, 6);
    expect(sumLabel(o, /Medicare/)).toBeCloseTo(2_000, 6);
    expect(sumKind(o, "credit")).toBe(0);
  });

  it("$40,000 salary: 3,270 less LITO 575; Medicare 2% = 800 (above shade-in)", () => {
    const o = au({ income: [{ character: "wage", amount: 40_000 }] });
    expect(sumLabel(o, /^Income tax/) + sumLabel(o, /offsets/)).toBeCloseTo(2_695, 6);
    expect(sumLabel(o, /Medicare/)).toBeCloseTo(800, 6);
  });

  it("2025-26 lowest rate was 16%; 2027-28 legislated 14%", () => {
    const y25 = au({ year: 2025, income: [{ character: "wage", amount: 100_000 }] });
    expect(sumLabel(y25, /^Income tax/)).toBeCloseTo(26_800 * 0.16 + 16_500, 6);
    const y27 = au({ year: 2027, income: [{ character: "wage", amount: 100_000 }] });
    expect(sumLabel(y27, /^Income tax/)).toBeCloseTo(26_800 * 0.14 + 16_500, 6);
  });

  it("fully franked $7,000 dividend: grossed-up 10,000, refundable franking credit 3,000", () => {
    const o = au({
      income: [{ character: "qualified-dividend", amount: 7_000, dividendTreatment: "au-franked" }],
    });
    expect(total(o)).toBeCloseTo(-3_000, 6);
  });

  it("CGT 50% discount: $20,000 long-term gain on top of $100,000 adds 10,000 x 30%", () => {
    const o = au({
      income: [
        { character: "wage", amount: 100_000 },
        { character: "capital-gains-long", amount: 20_000 },
      ],
    });
    expect(sumKind(o, "capital-gains")).toBeCloseTo(3_000, 6);
  });

  it("concessional super contribution: 15% contributions tax instead of marginal rate; Div 293", () => {
    const o = au({
      income: [{ character: "wage", amount: 100_000 }],
      deductions: [{ amount: 10_000, accountType: "au-super-accumulation" }],
    });
    expect(sumLabel(o, /^Income tax/)).toBeCloseTo(4_020 + 45_000 * 0.3, 6);
    expect(sumLabel(o, /contributions tax/)).toBeCloseTo(1_500, 6);
    const hi = au({
      income: [{ character: "wage", amount: 300_000 }],
      deductions: [{ amount: 20_000, accountType: "au-super-accumulation" }],
    });
    expect(sumLabel(hi, /Division 293/)).toBeCloseTo(3_000, 6);
  });

  it("super benefits are tax-free from 60", () => {
    const o = au({
      people: [{ age: 65 }],
      withdrawals: [{ accountType: "au-super-pension", amount: 60_000, taxableAmount: 60_000 }],
    });
    expect(total(o)).toBe(0);
  });
});

const custom = (rules: object, o: Parameters<typeof taxInput>[0] = {}) =>
  customJurisdiction.computeYear(
    taxInput({
      country: "NL",
      ...o,
      config: { mode: "custom", custom: rules as never, ...(o.config ?? {}) },
    }),
    [],
  );
const table = {
  brackets: [
    { from: 0, rate: 0.1 },
    { from: 20_000, rate: 0.3 },
  ],
  basis: "real" as const,
};

describe("custom jurisdiction", () => {
  it("brackets with standard deduction: 45,000 taxable -> 2,000 + 7,500", () => {
    const o = custom(
      { ordinary: table, standardDeduction: 5_000 },
      { income: [{ character: "wage", amount: 50_000 }] },
    );
    expect(sumKind(o, "income")).toBeCloseTo(9_500, 6);
    expect(o.marginalRate).toBe(0.3);
  });
  it("capital gains inclusion rate as ordinary income", () => {
    const o = custom(
      { ordinary: table, standardDeduction: 5_000, capitalGainsInclusion: 0.5 },
      {
        income: [
          { character: "wage", amount: 50_000 },
          { character: "capital-gains-long", amount: 10_000 },
        ],
      },
    );
    expect(sumKind(o, "income")).toBeCloseTo(11_000, 6);
  });
  it("separate dividend and gains tables", () => {
    const o = custom(
      {
        ordinary: table,
        capitalGains: { brackets: [{ from: 0, rate: 0.15 }], basis: "real" },
        dividends: { brackets: [{ from: 0, rate: 0.25 }], basis: "real" },
      },
      {
        income: [
          { character: "capital-gains-long", amount: 10_000 },
          { character: "qualified-dividend", amount: 4_000 },
        ],
      },
    );
    expect(sumKind(o, "capital-gains")).toBeCloseTo(1_500, 6);
    expect(sumKind(o, "dividends")).toBeCloseTo(1_000, 6);
  });
  it("flat effective-rate mode", () => {
    const o = custom(
      { ordinary: table, standardDeduction: 5_000, flatEffectiveRate: 0.25 },
      { income: [{ character: "wage", amount: 50_000 }] },
    );
    expect(sumKind(o, "income")).toBeCloseTo(11_250, 6);
  });
  it("wealth tax on net worth and financial transaction tax", () => {
    const o = custom(
      {
        ordinary: table,
        wealthTax: {
          metric: "netWorth",
          table: {
            brackets: [
              { from: 0, rate: 0 },
              { from: 1_000_000, rate: 0.01 },
            ],
            basis: "nominal",
          },
        },
        financialTransactionTax: { rate: 0.001, base: "purchases" },
      },
      {
        wealth: { netWorth: 3_000_000, liquidNetWorth: 2_000_000, portfolio: 1_500_000 },
        transactions: { purchases: 100_000, sales: 50_000 },
      },
    );
    expect(sumKind(o, "wealth")).toBeCloseTo(20_000, 6);
    expect(sumLabel(o, /transaction/)).toBeCloseTo(100, 6);
  });
  it("per-person taxation applies allowance and brackets to each person", () => {
    const o = custom(
      { ordinary: table, personalAllowancePerPerson: 5_000, perPerson: true },
      { people: [{}, {}], income: [{ owner: "joint", character: "wage", amount: 60_000 }] },
    );
    // each: 30,000 - 5,000 = 25,000 -> 2,000 + 1,500
    expect(sumKind(o, "income")).toBeCloseTo(7_000, 6);
  });
  it("real tables index with the price index", () => {
    const o = custom(
      { ordinary: table },
      { priceIndex: 2, income: [{ character: "wage", amount: 40_000 }] },
    );
    expect(sumKind(o, "income")).toBeCloseTo(4_000, 6);
  });
});
