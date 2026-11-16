/**
 * Integration seams between the engine and the tax / stochastic modules: every optional tax input
 * the engine now supplies, jurisdiction-sourced limits and access ages, the cash-flow timing
 * convention, rate overrides, and the new schema behaviours (sparse settings, real-asset and debt
 * options, routing overflow, sinking funds, survivor benefits).
 */
import { describe, expect, it } from "vitest";
import type { ProjectionResult } from "../src/engine/types.js";
import {
  applyPlanPatch,
  createDefaultTaxRegistry,
  createRng,
  effectiveTaxRate,
  MonteCarloSettings,
  marketCrashScenario,
  SimulationInput,
  sampleMarketPath,
  simulate,
  type TaxJurisdiction,
  type TaxYearInput,
} from "../src/index.js";
import {
  account,
  acct,
  always,
  between,
  expectInvariants,
  flatTax,
  period,
  sim,
} from "./engine-helpers.js";

const salary = (amount: number, owner = "me", id = "sal") => ({
  id,
  type: "salary" as const,
  name: "Salary",
  owner,
  amount: { value: amount },
  frequency: "yearly" as const,
  range: always,
});
const expense = (id: string, amount: number, extra: Record<string, unknown> = {}) => ({
  id,
  type: "living" as const,
  name: id,
  owner: "me",
  amount: { value: amount },
  frequency: "yearly" as const,
  range: always,
  ...extra,
});

/** A registry with a 'spy' jurisdiction that records every TaxYearInput and charges nothing. */
function spyRegistry() {
  const seen: TaxYearInput[] = [];
  const spy: TaxJurisdiction = {
    id: "spy",
    label: "Spy",
    level: "synthetic",
    status: "implemented",
    owner: "test",
    computeYear(input) {
      seen.push(input);
      return { lines: [], grossIncome: 0, taxableIncome: 0, marginalRate: 0, facts: {} };
    },
  };
  return {
    reg: createDefaultTaxRegistry().register(spy),
    seen,
    last: (year: number) => seen.findLast((s) => s.year === year)!,
  };
}

const SPY_TAX = { mode: "estimate" as const, jurisdictions: ["spy"] };

describe("engine -> tax inputs", () => {
  it("supplies dividend treatments, bond income, income types, people, wealth, transactions, deductions and conversions", () => {
    const { reg, last } = spyRegistry();
    simulate(
      sim({
        accounts: [
          acct("c", "cash", 50_000),
          acct("au", "taxable", 100_000, {
            behaviour: {
              dividends: {
                yield: { kind: "fixed", rate: 0.04 },
                treatment: "au-franked",
                qualifiedShare: 0.6,
              },
            },
          }),
          acct("bal", "taxable", 100_000),
          acct("sipp", "uk-sipp", 0),
          acct("wp", "uk-workplace-pension", 0),
          acct("ira", "traditional-ira", 10_000),
          acct("roth", "roth-ira", 0),
        ],
        plan: {
          tax: SPY_TAX,
          assumptions: {
            dividendYield: { kind: "fixed", rate: 0.02 },
            bondYield: { kind: "fixed", rate: 0.03 },
            bondAllocation: { kind: "fixed", share: 0.5 },
          },
          income: [
            salary(60_000),
            { ...salary(9_000, "me", "sp"), type: "state-pension", name: "State Pension" },
          ],
          expenses: [
            {
              ...expense("aca", 12_000),
              type: "healthcare",
              healthcare: {
                kind: "aca",
                benchmarkPremium: { value: 10_000 },
                householdSize: 1,
                advanceCreditShare: 0,
              },
            },
          ],
          flows: [
            {
              kind: "contribution",
              id: "f-sipp",
              name: "SIPP",
              owner: "me",
              accountId: "sipp",
              range: always,
              method: { kind: "amount", amount: { value: 4_000 } },
              pensionScheme: "relief-at-source",
            },
            {
              kind: "contribution",
              id: "f-wp",
              name: "Workplace",
              owner: "me",
              accountId: "wp",
              range: always,
              method: { kind: "percentOfIncome", incomeId: "sal", share: 0.05 },
              employer: { incomeId: "sal", matchShare: 1, upToShareOfPay: 0.03 },
            },
            {
              kind: "transfer",
              id: "conv",
              name: "Roth conversion",
              owner: "me",
              fromAccountId: "ira",
              to: { kind: "account", accountId: "roth" },
              range: always,
              amount: { kind: "amount", amount: { value: 5_000 } },
            },
          ],
        },
        years: 1,
      }),
      { taxRegistry: reg },
    );
    const t = last(2027);
    const au = t.income.filter((i) => i.sourceId === "dividends:au");
    expect(au).toHaveLength(1);
    expect(au[0]).toMatchObject({
      dividendTreatment: "au-franked",
      frankedShare: 0.6,
      amount: 4_000,
    });
    // Balanced account: half stocks (2% dividends), half bonds (3% yield = interest).
    const bal = t.income.filter((i) => i.sourceId === "dividends:bal");
    expect(bal.find((i) => i.incomeType === "dividend")!.amount).toBeCloseTo(1_000, 9);
    expect(bal.find((i) => i.incomeType === "bond-dividend")).toMatchObject({
      character: "interest",
      amount: 1_500,
    });
    expect(t.income.find((i) => i.sourceId === "sp")!.incomeType).toBe("state-pension");
    expect(t.income.find((i) => i.sourceId === "sal")!.incomeType).toBe("salary");
    expect(t.people[0]).toMatchObject({ birthYear: 1980, birthMonth: 1 });
    expect(t.wealth!.netWorth).toBeCloseTo(260_000, 6);
    expect(t.wealth!.portfolio).toBeCloseTo(210_000, 6);
    expect(t.transactions).toBeDefined();
    const sipp = t.deductions.find((d) => d.sourceId === "f-sipp")!;
    expect(sipp).toMatchObject({
      accountId: "sipp",
      accountType: "uk-sipp",
      pensionScheme: "relief-at-source",
    });
    expect(t.deductions.find((d) => d.sourceId === "employer:f-wp")).toMatchObject({
      employer: true,
      amount: 1_800,
    });
    expect(t.withdrawals.find((w) => w.accountId === "ira")).toMatchObject({
      isConversion: true,
      taxableAmount: 5_000,
    });
    expect(t.aca).toEqual({ benchmarkPremium: 10_000, householdSize: 1 });
  });

  it("records bracket fill (explainYear) with a full trace and tax-year sources for estimate plans", () => {
    const r = simulate(
      sim({
        location: { country: "GB" },
        accounts: [acct("c", "cash", 0)],
        plan: { tax: { mode: "estimate" }, income: [salary(40_000)] },
        years: 1,
        options: { trace: "full" },
      }),
    );
    const p = period(r, 2027);
    expect(
      p.taxes.brackets!.some((b) => b.jurisdictionId === "uk" && b.schedule === "non-savings"),
    ).toBe(true);
    expect(
      r.meta.taxSources!.some(
        (s) => s.jurisdictionId === "uk" && s.url.startsWith("https://www.gov.uk"),
      ),
    ).toBe(true);
    const lean = simulate(
      sim({
        location: { country: "GB" },
        plan: { tax: { mode: "estimate" }, income: [salary(40_000)] },
        years: 1,
      }),
    );
    expect(period(lean, 2027).taxes.brackets).toBeUndefined();
    expect(effectiveTaxRate(p)).toBeCloseTo(p.taxes.total / p.taxes.grossIncome, 12);
    const noPayroll = effectiveTaxRate(p, { includePayroll: false })!;
    expect(noPayroll).toBeLessThan(effectiveTaxRate(p)!);
  });
});

describe("UK relief at source", () => {
  it("deposits the provider's 20% top-up into the SIPP", () => {
    const r = simulate(
      sim({
        location: { country: "GB" },
        accounts: [acct("c", "cash", 0), acct("sipp", "uk-sipp", 0)],
        plan: {
          tax: { mode: "estimate" },
          income: [salary(50_000)],
          flows: [
            {
              kind: "contribution",
              id: "f",
              name: "SIPP",
              owner: "me",
              accountId: "sipp",
              range: always,
              method: { kind: "amount", amount: { value: 8_000 } },
            },
          ],
        },
        years: 1,
      }),
    );
    expect(account(r, 2027, "sipp").contributions).toBeCloseTo(10_000, 6);
    expect(period(r, 2027).taxes.facts["uk.reliefAtSourceTopUp"]).toBeCloseTo(2_000, 6);
    expect(r.trace.some((t) => t.code === "RELIEF_AT_SOURCE")).toBe(true);
    expectInvariants(r);
  });
});

describe("statutory rules come from the jurisdiction data, whatever the tax mode", () => {
  const isaFlow = (id: string, accountId: string) => ({
    kind: "contribution" as const,
    id,
    name: id,
    owner: "me",
    accountId,
    range: always,
    method: { kind: "max" as const },
    limit: { kind: "jurisdiction" as const },
  });
  it("a flat-rate UK plan uses the ISA and LISA allowances from the UK tax data", () => {
    const r = simulate(
      sim({
        location: { country: "GB" },
        births: ["1995-01"],
        accounts: [
          acct("c", "cash", 100_000),
          acct("lisa", "uk-lisa", 0),
          acct("isa", "uk-isa", 0),
        ],
        plan: {
          tax: flatTax(0),
          income: [salary(50_000)],
          flows: [isaFlow("f-lisa", "lisa"), isaFlow("f-isa", "isa")],
        },
        years: 1,
      }),
    );
    // LISA £4,000 (+25% bonus) within the shared £20,000 ISA allowance.
    expect(account(r, 2027, "lisa").contributions).toBeCloseTo(4_000 * 1.25, 6);
    expect(account(r, 2027, "isa").contributions).toBeCloseTo(16_000, 6);
  });

  it("UK pension access follows the normal minimum pension age (55 -> 57 from April 2028)", () => {
    const run = (birth: string) =>
      simulate(
        sim({
          location: { country: "GB" },
          births: [birth],
          start: "2029-01",
          accounts: [acct("sipp", "uk-sipp", 10_000)],
          years: 4,
        }),
      );
    // Born 1974-01: 55 in 2029 (after April 2028) -> access at 57 (2031).
    const late = run("1974-01");
    expect(account(late, 2030, "sipp").withdrawable).toBe(false);
    expect(account(late, 2031, "sipp").withdrawable).toBe(true);
    // Born 1972-06: 55 in June 2027, before April 2028, but only 55-56 when the NMPA rises on
    // 6 April 2028: without a protected pension age access closes again until 57 (June 2029).
    // (Deliberate change: this used to assert access "kept from 55".)
    const mid = run("1972-06");
    expect(account(mid, 2029, "sipp").withdrawable).toBe(false);
    expect(account(mid, 2030, "sipp").withdrawable).toBe(true);
    // Born 1970-01: 57 by April 2028, so access from 55 never closes.
    expect(account(run("1970-01"), 2029, "sipp").withdrawable).toBe(true);
  });

  it("the 1971-73 cohort can draw a UK pension at 55 before April 2028, not at 56 after it", () => {
    const r = simulate(
      sim({
        location: { country: "GB" },
        births: ["1972-01"],
        start: "2027-01",
        accounts: [acct("sipp", "uk-sipp", 10_000)],
        years: 4,
      }),
    );
    // 55 in Jan 2027 (open), 56 in Jan 2028 (period starts before April 2028: open), 57 in 2029.
    expect(account(r, 2027, "sipp").withdrawable).toBe(true);
    expect(account(r, 2029, "sipp").withdrawable).toBe(true);
    const r2 = simulate(
      sim({
        location: { country: "GB" },
        births: ["1972-08"],
        start: "2028-05",
        accounts: [acct("sipp", "uk-sipp", 10_000)],
        years: 2,
      }),
    );
    // May 2028: aged 55.75, after the rise -> closed until August 2029 (57).
    expect(r2.periods[0]!.accounts[0]!.withdrawable).toBe(false);
  });
});

describe("cash-flow timing convention", () => {
  const run = (cashFlowTiming?: "start" | "mid" | "end") =>
    simulate(
      sim({
        accounts: [acct("t", "taxable", 100_000, { costBasis: 100_000 })],
        plan: {
          expenses: [expense("e", 10_000)],
          assumptions: {
            stockReturn: { kind: "fixed", rate: 0.1 },
            ...(cashFlowTiming ? { cashFlowTiming } : {}),
          },
        },
        years: 1,
      }),
    );
  it("end: withdrawals earn a full year; start: none; mid (default): half a year", () => {
    expect(account(run("end"), 2027, "t").closing).toBeCloseTo(100_000, 6);
    expect(account(run("start"), 2027, "t").closing).toBeCloseTo(99_000, 6);
    const mid = 100_000 - 10_000 * (Math.sqrt(1.1) - 1);
    expect(account(run("mid"), 2027, "t").closing).toBeCloseTo(mid, 6);
    expect(account(run(), 2027, "t").closing).toBeCloseTo(mid, 6);
    expectInvariants(run());
  });
});

describe("rate overrides and the market-crash template", () => {
  it("overrides a fixed assumption for the range only", () => {
    const r = simulate(
      sim({
        plan: {
          assumptions: {
            stockReturn: { kind: "fixed", rate: 0.07 },
            rateOverrides: [{ series: "stocks", range: between("2028-01", "2029-01"), rate: -0.3 }],
          },
        },
      }),
    );
    expect(r.periods.map((p) => p.market.stocks)).toEqual([0.07, -0.3, 0.07]);
  });
  it("the crash template works on a historical return assumption", () => {
    const input = SimulationInput.parse(
      sim({
        accounts: [acct("t", "taxable", 100_000)],
        plan: {
          assumptions: {
            stockReturn: { kind: "historical", series: "us-stocks", startYear: 1990 },
          },
        },
        years: 5,
      }),
    );
    const base = simulate(input);
    const t = marketCrashScenario(input, { year: 2029, drop: 0.4 });
    const crashed = simulate({ ...input, plan: applyPlanPatch(input.plan, t.patch) });
    expect(period(crashed, 2029).market.stocks).toBe(-0.4);
    expect(period(crashed, 2028).market.stocks).toBe(period(base, 2028).market.stocks);
    expect(period(crashed, 2031).totals.netWorth).toBeLessThan(period(base, 2031).totals.netWorth);
  });
});

describe("real assets and debts", () => {
  it("an unfunded purchase is postponed, not recorded as bought", () => {
    const run = (cash: number) =>
      simulate(
        sim({
          accounts: [acct("c", "cash", cash)],
          plan: {
            plannedRealAssets: [
              {
                id: "house",
                name: "House",
                type: "house",
                owner: "me",
                purchase: { at: { kind: "date", date: "2028-01" }, price: { value: 100_000 } },
              },
            ],
          },
        }),
      );
    const poor = run(10_000);
    expect(poor.periods.every((p) => !p.realAssets[0]!.owned)).toBe(true);
    expect(poor.warnings.some((w) => /postponed/.test(w.message))).toBe(true);
    expect(account(poor, 2028, "c").closing).toBeCloseTo(10_000, 6);
    expect(period(poor, 2028).totals.shortfall).toBeCloseTo(0, 6);
    expectInvariants(poor);
    const rich = run(200_000);
    expect(period(rich, 2028).realAssets[0]!.owned).toBe(true);
    expect(account(rich, 2028, "c").closing).toBeCloseTo(100_000, 6);
  });

  it("an existing asset with recurrence is replaced after its sale", () => {
    const r = simulate(
      sim({
        accounts: [acct("c", "cash", 100_000)],
        finances: {
          realAssets: [
            {
              id: "car",
              name: "Car",
              type: "car",
              owner: "me",
              currentValue: 20_000,
              behaviour: {
                appreciation: { kind: "none" },
                sale: { at: { kind: "date", date: "2028-01" }, brokerFeeRate: 0 },
                recurrence: { yearsBetween: 0, until: { kind: "date", date: "2040-01" } },
              },
            },
          ],
        },
        years: 3,
      }),
    );
    expect(r.warnings.some((w) => /Recurrence/.test(w.message))).toBe(false);
    const car = (y: number) => period(r, y).realAssets[0]!;
    expect(car(2028).saleProceeds).toBeCloseTo(20_000, 6);
    expect(car(2028).purchasePrice).toBeCloseTo(20_000, 6);
    expect(car(2029).owned).toBe(true);
    expectInvariants(r);
  });

  it("caps appreciation with appreciationLimit and keeps rent to period end when the tenancy is not cancelled", () => {
    const asset = (cancelOnSale?: boolean) => ({
      id: "flat",
      name: "Flat",
      type: "rental-property" as const,
      owner: "me",
      currentValue: 100_000,
      behaviour: {
        appreciation: { kind: "rate" as const, rate: 0.1 },
        appreciationLimit: { max: 105_000, basis: "nominal" as const },
        rental: {
          enabled: true,
          income: { kind: "amountPerYear" as const, amount: { value: 12_000 } },
          ...(cancelOnSale === undefined ? {} : { cancelOnSale }),
        },
        sale: { at: { kind: "date" as const, date: "2028-07" }, brokerFeeRate: 0 },
      },
    });
    const run = (c?: boolean) =>
      simulate(
        sim({ accounts: [acct("c", "cash", 0)], finances: { realAssets: [asset(c)] }, years: 2 }),
      );
    const r = run();
    expect(period(r, 2027).realAssets[0]!.value).toBeCloseTo(105_000, 6);
    expect(period(r, 2028).realAssets[0]!.rentalIncome).toBeCloseTo(6_000, 6);
    expect(period(run(false), 2028).realAssets[0]!.rentalIncome).toBeCloseTo(12_000, 6);
  });

  it("debts: payments stop at paymentsEnd; balanceChange drifts the balance", () => {
    const debt = (behaviour: Record<string, unknown>) => ({
      id: "d",
      name: "Loan",
      type: "personal-loan" as const,
      owner: "me",
      balance: 10_000,
      interest: { apr: 0 },
      monthlyPayment: { value: 100, basis: "nominal" as const },
      behaviour,
    });
    const r = simulate(
      sim({
        accounts: [acct("c", "cash", 50_000)],
        finances: { debts: [debt({ paymentsEnd: { kind: "date", date: "2027-07" } })] },
        years: 1,
      }),
    );
    expect(period(r, 2027).debts[0]!.payments).toBeCloseTo(600, 6);
    const drift = simulate(
      sim({
        accounts: [acct("c", "cash", 50_000)],
        finances: { debts: [debt({ balanceChange: { rate: -0.1 } })] },
        years: 1,
      }),
    );
    const d = period(drift, 2027).debts[0]!;
    expect(d.closing).toBeCloseTo(9_000 - 1_200, 6);
    expect(d.opening + d.interest - d.payments).toBeCloseTo(d.closing, 6);
  });

  it("plan debt/asset settings are sparse overrides", () => {
    const r = simulate(
      sim({
        accounts: [acct("c", "cash", 50_000)],
        finances: {
          debts: [
            {
              id: "d",
              name: "Loan",
              type: "personal-loan",
              owner: "me",
              balance: 10_000,
              interest: { apr: 0 },
              monthlyPayment: { value: 100 },
              behaviour: { paymentsStart: { kind: "date", date: "2027-07" } },
            },
          ],
        },
        // A one-key override must not reset paymentsStart to the plan start.
        plan: { debtSettings: { d: { interestTaxDeductible: true } } },
        years: 1,
      }),
    );
    expect(period(r, 2027).debts[0]!.payments).toBeCloseTo(600, 6);
  });
});

describe("routing and funds", () => {
  it("preventOverflow fills accounts up to their limits, then the next account", () => {
    const r = simulate(
      sim({
        location: { country: "GB" },
        accounts: [acct("isa", "uk-isa", 0), acct("c", "cash", 0)],
        plan: {
          income: [
            {
              ...salary(30_000),
              tax: { character: "tax-free" },
              sendTo: { kind: "accounts", accountIds: ["isa", "c"], preventOverflow: true },
            },
          ],
        },
        years: 1,
      }),
    );
    expect(account(r, 2027, "isa").contributions).toBeCloseTo(20_000, 6);
    expect(account(r, 2027, "c").contributions).toBeCloseTo(10_000, 6);
    expectInvariants(r);
  });

  it("tapFund spends a sinking fund down after its saving window", () => {
    const r = simulate(
      sim({
        accounts: [acct("c", "cash", 0), acct("fund", "savings", 0)],
        plan: {
          leftover: { kind: "spend" },
          income: [salary(10_000)],
          flows: [
            {
              kind: "contribution",
              id: "f",
              name: "Fund",
              owner: "me",
              accountId: "fund",
              range: between("2027-01", "2028-01"),
              method: { kind: "amount", amount: { value: 10_000 } },
              tapFund: { rate: 0.5 },
            },
          ],
        },
        years: 2,
      }),
    );
    expect(account(r, 2028, "fund").withdrawals).toBeCloseTo(5_000, 6);
    expect(r.trace.some((t) => t.code === "FUND_TAPPED")).toBe(true);
    expectInvariants(r);
  });
});

describe("withdrawal tax rules", () => {
  const pay = (accountId: string, type = "living", amount = 5_000) => ({
    ...expense("e", amount),
    type,
    payFrom: { kind: "accounts", accountIds: [accountId] },
  });
  const taxes = (r: ProjectionResult) => period(r, 2027).taxes.total;

  it("HSA: non-medical use before 65 is taxable plus 20%; medical use is free", () => {
    const run = (type: string) =>
      simulate(
        sim({
          accounts: [acct("c", "cash", 100_000), acct("hsa", "hsa", 10_000)],
          plan: { tax: flatTax(0.2), expenses: [pay("hsa", type) as never] },
          years: 1,
        }),
      );
    expect(taxes(run("living"))).toBeCloseTo(5_000 * 0.2 + 5_000 * 0.2, 6);
    expect(taxes(run("healthcare"))).toBeCloseTo(0, 6);
  });

  it("529: non-qualified earnings are taxable plus 10%; education use is free", () => {
    const run = (type: string) =>
      simulate(
        sim({
          accounts: [acct("c", "cash", 100_000), acct("edu", "529", 20_000, { costBasis: 10_000 })],
          plan: { tax: flatTax(0.2), expenses: [pay("edu", type, 4_000) as never] },
          years: 1,
        }),
      );
    expect(taxes(run("living"))).toBeCloseTo(2_000 * 0.2 + 2_000 * 0.1, 6);
    expect(taxes(run("education"))).toBeCloseTo(0, 6);
  });

  it("Roth five-year rule: earnings are taxable until the account is five years old", () => {
    const run = (openedOn: string) =>
      simulate(
        sim({
          births: ["1960-01"],
          accounts: [
            acct("c", "cash", 100_000),
            acct("roth", "roth-ira", 50_000, { contributionBasis: 10_000, openedOn }),
          ],
          plan: { tax: flatTax(0.2), expenses: [pay("roth", "living", 20_000) as never] },
          years: 1,
        }),
      );
    expect(taxes(run("2025-01"))).toBeCloseTo(10_000 * 0.2, 6);
    expect(taxes(run("2015-01"))).toBeCloseTo(0, 6);
  });

  it("main-home sale: US $250k exclusion, UK private residence relief", () => {
    const run = (country: string) =>
      simulate(
        sim({
          location: { country },
          accounts: [acct("c", "cash", 0)],
          finances: {
            realAssets: [
              {
                id: "home",
                name: "Home",
                type: "house",
                owner: "me",
                currentValue: 600_000,
                purchasePrice: 200_000,
                behaviour: {
                  usage: "primary-residence",
                  appreciation: { kind: "none" },
                  sale: { at: { kind: "date", date: "2027-01" }, brokerFeeRate: 0 },
                },
              },
            ],
          },
          plan: { tax: flatTax(0, 0.15) },
          years: 1,
        }),
      );
    expect(taxes(run("US"))).toBeCloseTo((400_000 - 250_000) * 0.15, 6);
    expect(taxes(run("GB"))).toBeCloseTo(0, 6);
    expect(taxes(run("XX"))).toBeCloseTo(400_000 * 0.15, 6);
  });
});

describe("ACA premium tax credit", () => {
  it("passes the benchmark premium to us-federal, which credits the premium", () => {
    const r = simulate(
      sim({
        location: { country: "US", region: "TX" },
        births: ["1967-01"],
        accounts: [acct("c", "cash", 200_000)],
        plan: {
          tax: { mode: "estimate" },
          income: [{ ...salary(30_000), type: "other", name: "Consulting" }],
          expenses: [
            {
              ...expense("aca", 12_000),
              type: "healthcare",
              healthcare: {
                kind: "aca",
                benchmarkPremium: { value: 10_000 },
                householdSize: 1,
                advanceCreditShare: 0,
              },
            },
          ],
        },
        years: 1,
      }),
    );
    const line = period(r, 2027).taxes.lines.find((l) => l.label === "ACA premium tax credit")!;
    expect(line.amount).toBeLessThan(-5_000);
    expect(period(r, 2027).taxes.facts["us.ptc"]).toBeCloseTo(-line.amount, 6);
  });
});

describe("survivor benefits", () => {
  it("Social Security entered as amounts: the survivor gets the larger benefit", () => {
    const ss = (owner: string, amount: number) => ({
      id: `ss-${owner}`,
      type: "social-security" as const,
      name: `SS ${owner}`,
      owner,
      amount: { value: amount },
      frequency: "yearly" as const,
      range: always,
    });
    const r = simulate(
      sim({
        births: ["1955-01", "1957-01"],
        accounts: [acct("c", "cash", 0, { owner: "joint" })],
        plan: {
          tax: flatTax(0),
          income: [ss("a", 30_000), ss("b", 12_000)],
          milestones: [
            {
              id: "death-a",
              name: "A dies",
              kind: "custom",
              criteria: [{ kind: "date", date: "2027-12" }],
              effects: [{ kind: "death", personId: "a" }],
            },
          ],
        },
        years: 2,
      }),
    );
    const inc = (y: number) => period(r, y).income.reduce((s, l) => s + l.amount, 0);
    expect(inc(2027)).toBeCloseTo(42_000, 6);
    expect(inc(2028)).toBeCloseTo(30_000, 6);
    expect(r.trace.some((t) => t.code === "SURVIVOR_BENEFIT")).toBe(true);
  });
});

describe("metric milestones: averageYears", () => {
  it("averages spending over the next N years only", () => {
    const run = (averageYears?: number) =>
      simulate(
        sim({
          accounts: [acct("c", "cash", 2_000_000)],
          plan: {
            expenses: [
              { ...expense("hi", 50_000), range: between("2027-01", "2030-01") },
              {
                ...expense("lo", 10_000),
                range: { start: { kind: "date", date: "2030-01" }, end: { kind: "planEnd" } },
              },
            ],
            milestones: [
              {
                id: "fi",
                name: "FI",
                kind: "financial-independence",
                criteria: [
                  {
                    kind: "metric",
                    metric: { kind: "netWorth" },
                    comparator: ">=",
                    threshold: {
                      kind: "multipleOf",
                      multiple: 40,
                      of: "spending",
                      measurement: "average",
                      ...(averageYears ? { averageYears } : {}),
                    },
                  },
                ],
              },
            ],
          },
          years: 10,
        }),
      ).milestones.find((m) => m.milestoneId === "fi")!.month;
    // Whole remaining plan from 2027: (3x50k + 7x10k)/10 = 22k -> 880k: reached at once.
    expect(run()).toBe("2027-12");
    // Next 2 years: 50k -> 2.0m needed; NW falls below that, so only from 2029 ((50+10)/2 = 30k -> 1.2m).
    expect(run(2)).toBe("2029-12");
  });
});

describe("Monte Carlo per-series sources", () => {
  it("'fixed' keeps the plan assumption and 'distribution' draws from the distribution", () => {
    const base = Array.from({ length: 5 }, () => ({
      stocks: 0.05,
      bonds: 0.02,
      cash: 0.01,
      inflation: 0.025,
      dividendYield: 0.02,
      bondYield: 0.03,
      crypto: 0.07,
    }));
    const settings = MonteCarloSettings.parse({
      method: "historical-random-restart",
      dataset: "us-1928",
      sources: { inflation: "fixed", stocks: "distribution" },
      distributions: { stocks: { mean: 0.5, stdDev: 0 } },
    });
    const path = sampleMarketPath(settings, 5, createRng(3), 0, { base });
    for (const p of path.periods) {
      expect(p.inflation).toBe(0.025);
      expect(p.stocks).toBeCloseTo(0.5, 12);
    }
    // Without sources the series come from the data years.
    const plain = sampleMarketPath(
      MonteCarloSettings.parse({ method: "historical-random-restart" }),
      5,
      createRng(3),
      0,
      { base },
    );
    expect(plain.periods.some((p) => p.inflation !== 0.025)).toBe(true);
  });
});

describe("risk guardrails applied by the engine", () => {
  const run = (band?: { cutAbove: number; raiseBelow: number }) =>
    simulate(
      sim({
        accounts: [acct("c", "cash", 0), acct("inv", "taxable", 500_000)],
        plan: {
          expenses: [
            expense("ess", 10_000),
            { ...expense("fun", 40_000), spendingType: "discretionary" },
          ],
          riskGuardrails: {
            enabled: true,
            start: { kind: "planStart" },
            adjustmentStep: 0.1,
            ...(band ? { withdrawalRateBand: band } : {}),
          },
        },
        years: 3,
        options: { strict: false },
      }),
    );
  it("cuts discretionary spending when the withdrawal rate breaches the band; the cut carries forward", () => {
    const r = run({ cutAbove: 0.08, raiseBelow: 0.02 });
    const fun = (y: number) => period(r, y).expenses.find((e) => e.sourceId === "fun")!.requested;
    expect(fun(2027)).toBeCloseTo(40_000, 6);
    expect(fun(2028)).toBeCloseTo(36_000, 6);
    expect(fun(2029)).toBeCloseTo(32_400, 6);
    expect(period(r, 2028).expenses.find((e) => e.sourceId === "ess")!.requested).toBeCloseTo(
      10_000,
      6,
    );
    expect(r.trace.filter((t) => t.code === "GUARDRAIL_CUT")).toHaveLength(2);
    expect(period(r, 2029).totals.netWorth).toBeGreaterThan(period(run(), 2029).totals.netWorth);
    expectInvariants(r);
  });
  it("without a band the engine reports the feature as not modelled (non-strict)", () => {
    expect(run().warnings.some((w) => w.code === "FEATURE_NOT_MODELLED")).toBe(true);
  });
});
