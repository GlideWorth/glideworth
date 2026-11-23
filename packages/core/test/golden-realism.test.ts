/**
 * Realism goldens: end-to-end households whose year-one tax and take-home are checked by hand
 * against GOV.UK / IRS rules (2026/27 and 2026 figures), plus plausibility checks on the long-run
 * shape. Hand calculations are written out next to each assertion.
 *
 * Periods are calendar years; the engine maps calendar year Y onto UK tax year Y/Y+1, so a plan
 * starting January 2026 is taxed with 2026/27 rates and allowances.
 */
import { describe, expect, it } from "vitest";
import type { ProjectionResult, SimulationInputInput } from "../src/engine/types.js";
import { simulate } from "../src/index.js";
import { account, expectInvariants, period } from "./engine-helpers.js";

const always = { start: { kind: "planStart" as const }, end: { kind: "planEnd" as const } };
const until = (milestoneId: string) => ({
  start: { kind: "planStart" as const },
  end: { kind: "milestone" as const, milestoneId },
});
const _from = (milestoneId: string) => ({
  start: { kind: "milestone" as const, milestoneId },
  end: { kind: "planEnd" as const },
});
const line = (r: ProjectionResult, year: number, label: RegExp) =>
  period(r, year)
    .taxes.lines.filter((l) => label.test(l.label))
    .reduce((s, l) => s + l.amount, 0);
const expensesFunded = (r: ProjectionResult, year: number) =>
  period(r, year).expenses.reduce((s, e) => s + e.funded, 0);

function plausibleLongRun(r: ProjectionResult, lastYear: number) {
  for (const p of r.periods) {
    expect(Number.isFinite(p.totals.netWorth), `NaN net worth in ${p.year}`).toBe(true);
    expect(Number.isFinite(p.taxes.total), `NaN taxes in ${p.year}`).toBe(true);
    expect(p.taxes.total, `negative tax in ${p.year}`).toBeGreaterThanOrEqual(-1e-6);
  }
  const shortfall = r.periods.filter((p) => p.status === "shortfall" && p.year <= lastYear);
  expect(
    shortfall.map((p) => p.year),
    "shortfall years",
  ).toEqual([]);
  expectInvariants(r, 1e-6);
}

// -------------------------------------------------------------------------------------------------
// (i) Single employee on £55k: salary sacrifice 5% + 3% employer, ISA saving, retire at 60, SP 68
// -------------------------------------------------------------------------------------------------
function ukSingle(): SimulationInputInput {
  return {
    household: {
      id: "h1",
      name: "Single employee",
      planningMode: "individual",
      people: [{ id: "me", name: "Sam", role: "primary", birthMonth: "1978-06" }],
      location: { country: "GB", region: "ENG" },
      currency: "GBP",
      locale: "en-GB",
    },
    finances: {
      asOf: "2026-01",
      accounts: [
        { id: "cash", name: "Current account", type: "cash", owner: "me", balance: 10_000 },
        {
          id: "wp",
          name: "Workplace pension",
          type: "uk-workplace-pension",
          owner: "me",
          balance: 80_000,
        },
        { id: "isa", name: "Stocks & Shares ISA", type: "uk-isa", owner: "me", balance: 30_000 },
      ],
    },
    plan: {
      id: "p1",
      householdId: "h1",
      name: "Retire at 60",
      tax: { mode: "estimate", filingStatus: "single" },
      milestones: [
        {
          id: "ret",
          name: "Retire",
          kind: "retirement",
          personId: "me",
          criteria: [{ kind: "age", personId: "me", age: 60 }],
        },
        {
          id: "le",
          name: "Life expectancy",
          kind: "life-expectancy",
          personId: "me",
          criteria: [{ kind: "age", personId: "me", age: 95 }],
        },
      ],
      income: [
        {
          id: "sal",
          type: "salary",
          name: "Salary",
          owner: "me",
          amount: { value: 55_000 },
          frequency: "yearly",
          range: until("ret"),
        },
        {
          id: "sp",
          type: "state-pension",
          name: "State Pension",
          owner: "me",
          amount: { value: 241.3 },
          frequency: "weekly",
          range: { start: { kind: "age", personId: "me", age: 68 }, end: { kind: "planEnd" } },
        },
      ],
      expenses: [
        {
          id: "liv",
          type: "living",
          name: "Living",
          owner: "me",
          amount: { value: 25_000 },
          frequency: "yearly",
          range: always,
        },
      ],
      flows: [
        {
          kind: "contribution",
          id: "f-wp",
          name: "Workplace pension (salary sacrifice)",
          owner: "me",
          accountId: "wp",
          range: until("ret"),
          mandatory: true,
          method: { kind: "percentOfIncome", incomeId: "sal", share: 0.05 },
          pensionScheme: "salary-sacrifice",
          employer: { incomeId: "sal", tiers: [{ matchRate: 1, bandShareOfPay: 0.03 }] },
        },
        {
          kind: "contribution",
          id: "f-isa",
          name: "ISA",
          owner: "me",
          accountId: "isa",
          range: until("ret"),
          method: { kind: "max" },
          limit: { kind: "jurisdiction" },
        },
      ],
      assumptions: { cashReturn: { kind: "fixed", rate: 0.01 } },
    },
    options: { trace: "summary" },
  };
}

describe("golden (i): UK single employee, £55k, salary sacrifice", () => {
  const r = simulate(ukSingle());

  it("year one matches the GOV.UK calculation by hand", () => {
    // Salary sacrifice 5% of £55,000 = £2,750 -> pay £52,250 for income tax and NI.
    // Income tax: (52,250 - 12,570) = 39,680 taxable; 37,700 @ 20% = 7,540; 1,980 @ 40% = 792 -> 8,332.
    // NI (Class 1, 8% / 2%): (50,270 - 12,570) x 8% = 3,016; (52,250 - 50,270) x 2% = 39.60 -> 3,055.60.
    // Cash interest £100 is inside the £500 higher-rate personal savings allowance.
    const p = period(r, 2026);
    expect(line(r, 2026, /^Income tax/)).toBeCloseTo(8_332, 2);
    expect(line(r, 2026, /National Insurance/)).toBeCloseTo(3_055.6, 2);
    expect(p.taxes.total).toBeCloseTo(11_387.6, 2);
    // Pension: £2,750 sacrificed + £1,650 employer (3%).
    expect(account(r, 2026, "wp").contributions).toBeCloseTo(4_400, 6);
    // Take-home: 55,000 - 2,750 - 11,387.60 = £40,862.40, spent on living costs (£25,000) and the ISA.
    const takeHome = 55_000 - 2_750 - 11_387.6;
    expect(expensesFunded(r, 2026) + account(r, 2026, "isa").contributions).toBeCloseTo(
      takeHome,
      2,
    );
    expect(account(r, 2026, "isa").contributions).toBeCloseTo(takeHome - 25_000, 2);
  });

  it("long run: retires at 60 (2038), State Pension from 68, money lasts to 95", () => {
    plausibleLongRun(r, 2073);
    expect(r.summary.retirementYear).toBe(2038);
    const sp = (y: number) => period(r, y).income.find((i) => i.sourceId === "sp")?.amount ?? 0;
    expect(sp(2045)).toBe(0);
    expect(sp(2047)).toBeGreaterThan(12_000);
    // Gap years: pension (UFPLS, 25% tax-free) and ISA fund spending; little tax inside the allowance.
    const gap = period(r, 2040);
    expect(gap.totals.withdrawals).toBeGreaterThan(20_000);
    expect(gap.taxes.total / gap.priceIndex).toBeLessThan(5_000);
    // Net worth peaks around retirement and stays positive.
    const nwReal = (y: number) => period(r, y).totals.netWorth / period(r, y).priceIndex;
    expect(nwReal(2037)).toBeGreaterThan(nwReal(2026));
    expect(nwReal(2073)).toBeGreaterThan(0);
  });
});

// -------------------------------------------------------------------------------------------------
// (ii) Couple: £95k + £32k, mortgage, two children, SIPP + ISAs, retire at 57/58, bridge to SP
// -------------------------------------------------------------------------------------------------
function ukCouple(): SimulationInputInput {
  return {
    household: {
      id: "h2",
      name: "Couple",
      planningMode: "couple",
      people: [
        { id: "alex", name: "Alex", role: "primary", birthMonth: "1975-03" },
        { id: "blair", name: "Blair", role: "partner", birthMonth: "1977-09" },
      ],
      dependents: [
        { id: "k1", name: "Child 1", birthMonth: "2016-05" },
        { id: "k2", name: "Child 2", birthMonth: "2019-02" },
      ],
      location: { country: "GB", region: "ENG" },
      currency: "GBP",
      locale: "en-GB",
    },
    finances: {
      asOf: "2026-01",
      accounts: [
        { id: "cash", name: "Joint account", type: "cash", owner: "joint", balance: 20_000 },
        { id: "sipp-a", name: "Alex SIPP", type: "uk-sipp", owner: "alex", balance: 250_000 },
        {
          id: "wp-b",
          name: "Blair workplace pension",
          type: "uk-workplace-pension",
          owner: "blair",
          balance: 60_000,
        },
        { id: "isa-a", name: "Alex ISA", type: "uk-isa", owner: "alex", balance: 60_000 },
        { id: "isa-b", name: "Blair ISA", type: "uk-isa", owner: "blair", balance: 25_000 },
      ],
      realAssets: [
        {
          id: "home",
          name: "Home",
          type: "house",
          owner: "joint",
          currentValue: 450_000,
          purchasePrice: 300_000,
          loan: {
            id: "mortgage",
            balance: 250_000,
            interest: { apr: 0.045 },
            monthlyPayment: { value: 1_400, basis: "nominal" },
          },
          behaviour: { usage: "primary-residence" },
        },
      ],
    },
    plan: {
      id: "p2",
      householdId: "h2",
      name: "Retire at 57/58",
      tax: { mode: "estimate", filingStatus: "married-joint", uk: { childBenefitClaimed: true } },
      milestones: [
        {
          id: "ret-a",
          name: "Alex retires",
          kind: "retirement",
          personId: "alex",
          criteria: [{ kind: "age", personId: "alex", age: 57 }],
        },
        {
          id: "ret-b",
          name: "Blair retires",
          kind: "retirement",
          personId: "blair",
          criteria: [{ kind: "age", personId: "blair", age: 58 }],
        },
        {
          id: "le-a",
          name: "Alex LE",
          kind: "life-expectancy",
          personId: "alex",
          criteria: [{ kind: "age", personId: "alex", age: 92 }],
        },
        {
          id: "le-b",
          name: "Blair LE",
          kind: "life-expectancy",
          personId: "blair",
          criteria: [{ kind: "age", personId: "blair", age: 94 }],
        },
      ],
      income: [
        {
          id: "sal-a",
          type: "salary",
          name: "Alex salary",
          owner: "alex",
          amount: { value: 95_000 },
          frequency: "yearly",
          range: until("ret-a"),
        },
        {
          id: "sal-b",
          type: "salary",
          name: "Blair salary",
          owner: "blair",
          amount: { value: 32_000 },
          frequency: "yearly",
          range: until("ret-b"),
        },
        {
          id: "cb",
          type: "other",
          name: "Child Benefit",
          owner: "alex",
          amount: { value: (27.05 + 17.9) * 52 },
          frequency: "yearly",
          range: { start: { kind: "planStart" }, end: { kind: "date", date: "2034-05" } },
          tax: { character: "tax-free" },
        },
        {
          id: "sp-a",
          type: "state-pension",
          name: "Alex State Pension",
          owner: "alex",
          amount: { value: 241.3 },
          frequency: "weekly",
          range: { start: { kind: "age", personId: "alex", age: 67 }, end: { kind: "planEnd" } },
        },
        {
          id: "sp-b",
          type: "state-pension",
          name: "Blair State Pension",
          owner: "blair",
          amount: { value: 241.3 },
          frequency: "weekly",
          range: {
            start: { kind: "age", personId: "blair", age: 67.25 },
            end: { kind: "planEnd" },
          },
        },
      ],
      expenses: [
        {
          id: "liv",
          type: "living",
          name: "Living",
          owner: "joint",
          amount: { value: 38_000 },
          frequency: "yearly",
          range: always,
        },
        {
          id: "kids",
          type: "dependent-support",
          name: "Children",
          owner: "joint",
          amount: { value: 8_000 },
          frequency: "yearly",
          range: { start: { kind: "planStart" }, end: { kind: "date", date: "2037-02" } },
        },
      ],
      flows: [
        {
          kind: "contribution",
          id: "f-sipp-a",
          name: "Alex SIPP (relief at source)",
          owner: "alex",
          accountId: "sipp-a",
          range: until("ret-a"),
          mandatory: true,
          method: { kind: "amount", amount: { value: 8_000 } },
        },
        {
          kind: "contribution",
          id: "f-wp-b",
          name: "Blair workplace pension (net pay)",
          owner: "blair",
          accountId: "wp-b",
          range: until("ret-b"),
          mandatory: true,
          method: { kind: "percentOfIncome", incomeId: "sal-b", share: 0.05 },
          employer: { incomeId: "sal-b", tiers: [{ matchRate: 1, bandShareOfPay: 0.03 }] },
        },
        {
          kind: "contribution",
          id: "f-isa-a",
          name: "Alex ISA",
          owner: "alex",
          accountId: "isa-a",
          range: until("ret-a"),
          method: { kind: "max" },
          limit: { kind: "jurisdiction" },
        },
        {
          kind: "contribution",
          id: "f-isa-b",
          name: "Blair ISA",
          owner: "blair",
          accountId: "isa-b",
          range: until("ret-b"),
          method: { kind: "max" },
          limit: { kind: "jurisdiction" },
        },
      ],
      assumptions: { cashReturn: { kind: "fixed", rate: 0.01 } },
    },
    options: { trace: "summary" },
  };
}

describe("golden (ii): UK couple, £95k + £32k, mortgage, two children", () => {
  const r = simulate(ukCouple());

  it("year one matches the GOV.UK calculation by hand", () => {
    // Alex: SIPP £8,000 net (relief at source) -> £10,000 gross; basic-rate band extended to 47,700.
    //   Adjusted net income 95,000 + 100 interest - 10,000 = 85,100 (< £100k: full allowance).
    //   Taxable 95,000 - 12,570 = 82,430: 47,700 @ 20% = 9,540; 34,730 @ 40% = 13,892 -> 23,432.
    //   NI: 37,700 x 8% = 3,016 + (95,000 - 50,270) x 2% = 894.60 -> 3,910.60.
    //   HICBC: ANI £85,100 is above £80,000, so the full Child Benefit (2 children) is charged:
    //   (27.05 + 17.90) x 52 = 2,337.40.
    // Blair: net-pay pension 5% = 1,600 -> taxable pay 30,400; (30,400 - 12,570) x 20% = 3,566.
    //   NI on full pay: (32,000 - 12,570) x 8% = 1,554.40.
    // Interest £100 each is within the personal savings allowances.
    const p = period(r, 2026);
    expect(line(r, 2026, /^Income tax \(Scottish|^Income tax \(alex\)$/)).toBeCloseTo(23_432, 2);
    expect(line(r, 2026, /^Income tax \(blair\)$/)).toBeCloseTo(3_566, 2);
    expect(line(r, 2026, /National Insurance.*alex/)).toBeCloseTo(3_910.6, 2);
    expect(line(r, 2026, /National Insurance.*blair/)).toBeCloseTo(1_554.4, 2);
    expect(line(r, 2026, /High Income Child Benefit/)).toBeCloseTo(2_337.4, 2);
    expect(p.taxes.total).toBeCloseTo(23_432 + 3_910.6 + 2_337.4 + 3_566 + 1_554.4, 2);
    // Relief at source: HMRC's £2,000 top-up lands in the SIPP.
    expect(account(r, 2026, "sipp-a").contributions).toBeCloseTo(10_000, 6);
    // Blair's pension: £1,600 + £960 employer.
    expect(account(r, 2026, "wp-b").contributions).toBeCloseTo(2_560, 6);
    // Take-home after pensions and tax funds the mortgage (16,800), living, children, then ISAs.
    const net = 95_000 + 32_000 + (27.05 + 17.9) * 52 - 8_000 - 1_600 - p.taxes.total;
    const isas = account(r, 2026, "isa-a").contributions + account(r, 2026, "isa-b").contributions;
    expect(expensesFunded(r, 2026) + isas).toBeCloseTo(net, 2);
    expect(expensesFunded(r, 2026)).toBeCloseTo(38_000 + 8_000 + 16_800, 2);
  });

  it("long run: pensions bridge to State Pension; no shortfall; mortgage repaid", () => {
    plausibleLongRun(r, 2071);
    // Alex retires March 2032 (57); pensions are accessible from 57 under the 2028 NMPA rise.
    const sippDraw = (y: number) => account(r, y, "sipp-a").withdrawals;
    expect(sippDraw(2031)).toBe(0);
    expect(sippDraw(2034)).toBeGreaterThan(0);
    // Mortgage repaid before the end; State Pensions arrive (Alex 2042, Blair 2045).
    const loan = (y: number) =>
      period(r, y).realAssets.find((a) => a.assetId === "home")!.loanBalance;
    expect(loan(2026)).toBeGreaterThan(200_000);
    expect(loan(2050)).toBeCloseTo(0, 6);
    expect(period(r, 2046).income.filter((i) => i.sourceId.startsWith("sp-")).length).toBe(2);
    // Tax in the bridging years stays moderate in real terms (two personal allowances, UFPLS).
    const bridge = period(r, 2038);
    expect(bridge.taxes.total / bridge.priceIndex).toBeLessThan(12_000);
  });
});

// -------------------------------------------------------------------------------------------------
// (iii) Retiree drawing from SIPP + ISA + GIA in a tax-efficient order
// -------------------------------------------------------------------------------------------------
function ukRetiree(): SimulationInputInput {
  return {
    household: {
      id: "h3",
      name: "Retiree",
      planningMode: "individual",
      people: [{ id: "me", name: "Robin", role: "primary", birthMonth: "1958-04" }],
      location: { country: "GB", region: "ENG" },
      currency: "GBP",
      locale: "en-GB",
    },
    finances: {
      asOf: "2026-01",
      accounts: [
        { id: "cash", name: "Cash", type: "cash", owner: "me", balance: 15_000 },
        { id: "sipp", name: "SIPP", type: "uk-sipp", owner: "me", balance: 400_000 },
        { id: "isa", name: "ISA", type: "uk-isa", owner: "me", balance: 150_000 },
        {
          id: "gia",
          name: "GIA",
          type: "uk-gia",
          owner: "me",
          balance: 100_000,
          costBasis: 70_000,
        },
      ],
    },
    plan: {
      id: "p3",
      householdId: "h3",
      name: "Drawdown",
      tax: { mode: "estimate", filingStatus: "single" },
      milestones: [
        {
          id: "le",
          name: "Life expectancy",
          kind: "life-expectancy",
          personId: "me",
          criteria: [{ kind: "age", personId: "me", age: 95 }],
        },
      ],
      income: [
        {
          id: "sp",
          type: "state-pension",
          name: "State Pension",
          owner: "me",
          amount: { value: 241.3 },
          frequency: "weekly",
          range: always,
        },
      ],
      expenses: [
        {
          id: "liv",
          type: "living",
          name: "Living",
          owner: "me",
          amount: { value: 35_000 },
          frequency: "yearly",
          range: always,
        },
      ],
      // Tax-efficient order: cash, GIA (gains inside the CGT allowance), pension, ISA last.
      drawdown: {
        order: [
          { kind: "category", category: "cash" },
          { kind: "category", category: "taxable" },
          { kind: "category", category: "tax-deferred" },
          { kind: "category", category: "tax-free" },
        ],
        cashBuffer: { value: 10_000 },
      },
      // Use the basic-rate band from the pension first; harvest gains within the annual exempt amount.
      taxStrategy: {
        enabled: true,
        target: { kind: "bracket", rate: 0.2 },
        modules: { rothConversions: false },
      },
      assumptions: { cashReturn: { kind: "fixed", rate: 0.01 } },
    },
    options: { trace: "summary" },
  };
}

describe("golden (iii): UK retiree, SIPP + ISA + GIA", () => {
  const r = simulate(ukRetiree());

  it("year one: pension income inside the basic-rate band, gains inside the CGT allowance", () => {
    const p = period(r, 2026);
    const sipp = p.accounts.find((a) => a.accountId === "sipp")!;
    const taxableSipp = p.accounts && sipp.withdrawals * 0.75; // UFPLS: 25% of each withdrawal tax-free
    const spAnnual = 241.3 * 52;
    // Non-savings income = State Pension + taxable pension; all within the basic-rate band.
    const nonSavings = spAnnual + taxableSipp;
    expect(nonSavings).toBeLessThan(50_270);
    expect(line(r, 2026, /^Income tax$/)).toBeCloseTo((nonSavings - 12_570) * 0.2, 2);
    // GIA dividends: 100,000 x 1.5% = 1,500; £500 allowance; 1,000 at 10.75% (2026/27 basic rate).
    expect(line(r, 2026, /^Dividend tax$/)).toBeCloseTo(1_000 * 0.1075, 2);
    // Gains realised (harvest + any GIA withdrawals) stay inside the £3,000 annual exempt amount.
    expect(line(r, 2026, /Capital gains/)).toBeCloseTo(0, 6);
    expect(r.trace.some((t) => t.code === "GAIN_HARVESTED" && t.periodIndex === 0)).toBe(true);
    // Spending is fully funded; the ISA is untouched in year one.
    expect(account(r, 2026, "isa").withdrawals).toBe(0);
    expect(expensesFunded(r, 2026)).toBeCloseTo(35_000, 2);
  });

  it("long run: the ISA is drawn last and the plan lasts to 95", () => {
    plausibleLongRun(r, 2053);
    const firstIsa = r.periods.find(
      (p) => p.accounts.find((a) => a.accountId === "isa")!.withdrawals > 0,
    );
    const firstSipp = r.periods.find(
      (p) => p.accounts.find((a) => a.accountId === "sipp")!.withdrawals > 0,
    );
    expect(firstSipp!.year).toBe(2026);
    if (firstIsa) expect(firstIsa.year).toBeGreaterThan(2035);
    // Average effective rate on gross income in the first decade stays at basic-rate levels.
    for (const y of [2026, 2030, 2035]) expect(period(r, y).taxes.effectiveRate).toBeLessThan(0.2);
  });
});

// -------------------------------------------------------------------------------------------------
// US: 401(k) + Roth + taxable, retire at 55, Social Security at 67
// -------------------------------------------------------------------------------------------------
function usEarlyRetiree(): SimulationInputInput {
  return {
    household: {
      id: "h4",
      name: "US early retiree",
      planningMode: "individual",
      people: [{ id: "me", name: "Jamie", role: "primary", birthMonth: "1977-01" }],
      location: { country: "US", region: "TX" },
      currency: "USD",
      locale: "en-US",
    },
    finances: {
      asOf: "2026-01",
      accounts: [
        { id: "cash", name: "Checking", type: "cash", owner: "me", balance: 20_000 },
        { id: "k", name: "401(k)", type: "401k", owner: "me", balance: 400_000 },
        {
          id: "roth",
          name: "Roth IRA",
          type: "roth-ira",
          owner: "me",
          balance: 100_000,
          contributionBasis: 60_000,
        },
        {
          id: "brk",
          name: "Brokerage",
          type: "taxable",
          owner: "me",
          balance: 200_000,
          costBasis: 150_000,
        },
      ],
    },
    plan: {
      id: "p4",
      householdId: "h4",
      name: "Retire at 55",
      tax: { mode: "estimate", filingStatus: "single" },
      milestones: [
        {
          id: "ret",
          name: "Retire",
          kind: "retirement",
          personId: "me",
          criteria: [{ kind: "age", personId: "me", age: 55 }],
        },
        {
          id: "le",
          name: "Life expectancy",
          kind: "life-expectancy",
          personId: "me",
          criteria: [{ kind: "age", personId: "me", age: 92 }],
        },
      ],
      income: [
        {
          id: "sal",
          type: "salary",
          name: "Salary",
          owner: "me",
          amount: { value: 150_000 },
          frequency: "yearly",
          range: until("ret"),
        },
        {
          id: "ss",
          type: "social-security",
          name: "Social Security",
          owner: "me",
          amount: { value: 2_800 },
          frequency: "monthly",
          range: { start: { kind: "age", personId: "me", age: 67 }, end: { kind: "planEnd" } },
        },
      ],
      expenses: [
        {
          id: "liv",
          type: "living",
          name: "Living",
          owner: "me",
          amount: { value: 70_000 },
          frequency: "yearly",
          range: always,
        },
      ],
      flows: [
        {
          kind: "contribution",
          id: "f-401k",
          name: "401(k) deferral",
          owner: "me",
          accountId: "k",
          range: until("ret"),
          mandatory: true,
          method: { kind: "max" },
          limit: { kind: "jurisdiction" },
        },
        {
          kind: "contribution",
          id: "f-brk",
          name: "Brokerage",
          owner: "me",
          accountId: "brk",
          range: until("ret"),
          method: { kind: "percentOfRemaining", share: 1 },
        },
      ],
      assumptions: { cashReturn: { kind: "fixed", rate: 0.01 } },
    },
    options: { trace: "summary" },
  };
}

describe("golden (US): 401(k) + Roth + taxable, retire at 55, Social Security at 67", () => {
  const r = simulate(usEarlyRetiree());

  it("year one matches the IRS calculation by hand (2026, single, Texas)", () => {
    // Wages 150,000 - 401(k) deferral 24,500 (age 49: no catch-up) = 125,500; interest +200 -> 125,700.
    // Qualified dividends 200,000 x 1.5% = 3,000 (preferential). AGI 128,700.
    // Taxable = 128,700 - 16,100 standard deduction = 112,600; ordinary part 109,600.
    // Ordinary tax: 1,240 + 4,560 + 12,166 + (109,600 - 105,700) x 24% = 936 -> 18,902.
    // Dividends at 15% (above the 0% band): 450. Federal = 19,352.
    // FICA: 150,000 x 6.2% = 9,300 + 1.45% = 2,175 -> 11,475 (the deferral does not reduce FICA).
    expect(account(r, 2026, "k").contributions).toBeCloseTo(24_500, 6);
    expect(line(r, 2026, /^Federal income tax$/)).toBeCloseTo(18_902, 0);
    expect(line(r, 2026, /Qualified dividends tax/)).toBeCloseTo(450, 0);
    expect(period(r, 2026).taxes.facts.agi).toBeCloseTo(128_700, 0);
    expect(line(r, 2026, /Social Security|OASDI/i)).toBeCloseTo(9_300, 0);
    expect(line(r, 2026, /^Medicare/)).toBeCloseTo(2_175, 0);
    expect(period(r, 2026).taxes.total).toBeCloseTo(19_352 + 11_475, 0);
  });

  it("long run: bridge to 59.5 from taxable money, Social Security at 67, no shortfall", () => {
    plausibleLongRun(r, 2068);
    expect(r.summary.retirementYear).toBe(2032);
    // Before 59.5 (July 2036) the 401(k) is not drawn (default order: taxable before tax-deferred).
    expect(account(r, 2033, "k").withdrawals).toBe(0);
    expect(account(r, 2033, "brk").withdrawals).toBeGreaterThan(0);
    expect(period(r, 2044).income.find((i) => i.sourceId === "ss")!.amount).toBeGreaterThan(30_000);
    // RMDs from 75 (born 1977, SECURE 2.0).
    expect(
      period(r, 2052).accounts.find((a) => a.accountId === "k")!.requiredDistribution,
    ).toBeGreaterThan(0);
    expect(r.warnings.filter((w) => w.code === "EARLY_WITHDRAWAL_PENALTY")).toHaveLength(0);
  });
});
