import { describe, expect, it } from "vitest";
import { simulate, ssClaimFactor, ssFullRetirementAge } from "../src/index.js";
import type { IncomeEventInput } from "../src/schema/events.js";
import {
  account,
  acct,
  always,
  between,
  expectInvariants,
  flatTax,
  from,
  period,
  sim,
} from "./engine-helpers.js";

const income = (over: Partial<IncomeEventInput> & { type?: string }): IncomeEventInput =>
  ({
    id: "i",
    type: "other",
    name: "Income",
    owner: "me",
    amount: { value: 1_000 },
    frequency: "yearly",
    range: always,
    ...over,
  }) as IncomeEventInput;

const cash = acct("c", "cash", 0);
const incomes = (r: ReturnType<typeof simulate>) => r.periods.map((p) => p.totals.income);

describe("income: amounts and change over time", () => {
  it("repeats a one-off with recurrence and scaling until a date", () => {
    const r = simulate(
      sim({
        accounts: [cash],
        plan: {
          income: [
            income({
              frequency: "once",
              range: { start: { kind: "date", date: "2027-03" }, end: { kind: "never" } },
              change: { kind: "none" },
              recurrence: {
                yearsBetween: 2,
                scalingRate: 0.1,
                until: { kind: "date", date: "2032-01" },
              },
            }),
          ],
        },
        years: 6,
      }),
    );
    const v = incomes(r);
    expect(v[0]).toBeCloseTo(1_000, 6);
    expect(v[1]).toBe(0);
    expect(v[2]).toBeCloseTo(1_100, 6);
    expect(v[4]).toBeCloseTo(1_210, 6);
    expect(v[5]).toBe(0);
  });

  it("hourly wages annualise hours x rate x 52", () => {
    const r = simulate(
      sim({
        accounts: [cash],
        plan: {
          income: [
            income({
              type: "hourly",
              hoursPerWeek: 40,
              amount: { value: 20 },
              frequency: "weekly",
            } as never),
          ],
        },
        years: 1,
      }),
    );
    expect(incomes(r)[0]).toBeCloseTo(20 * 40 * 52, 6);
  });

  it("change schedules: multiplier, amount and rate", () => {
    const mk = (change: object) =>
      incomes(
        simulate(
          sim({ accounts: [cash], plan: { income: [income({ change } as never)] }, years: 2 }),
        ),
      );
    const at28 = { at: { kind: "date", date: "2028-01" } };
    expect(
      mk({
        kind: "schedule",
        valueKind: "multiplier",
        interpolation: "step",
        points: [{ ...at28, value: 2 }],
      }),
    ).toEqual([2_000, 2_000]);
    const m = mk({
      kind: "schedule",
      valueKind: "multiplier",
      interpolation: "step",
      points: [
        { at: { kind: "date", date: "2027-01" }, value: 1 },
        { ...at28, value: 2 },
      ],
    });
    expect(m).toEqual([1_000, 2_000]);
    expect(
      mk({
        kind: "schedule",
        valueKind: "amount",
        interpolation: "step",
        points: [
          { at: { kind: "date", date: "2027-01" }, value: 700 },
          { ...at28, value: 500 },
        ],
      }),
    ).toEqual([700, 500]);
    const rate = mk({
      kind: "schedule",
      valueKind: "rate",
      interpolation: "step",
      points: [{ at: { kind: "date", date: "2027-01" }, value: 0.12 }],
    });
    expect(rate[1]).toBeCloseTo(1_120, 6);
  });

  it("clamps with a change limit", () => {
    const r = simulate(
      sim({
        accounts: [cash],
        plan: {
          income: [
            income({
              change: { kind: "rate", rate: 0.1 },
              changeLimit: { max: 1_100, basis: "nominal" },
            }),
          ],
        },
        years: 3,
      }),
    );
    expect(incomes(r)[1]).toBeCloseTo(1_100, 6);
    expect(incomes(r)[2]).toBeCloseTo(1_100, 6);
  });

  it("grow-from-today anchors the real premium at the plan start", () => {
    const exp = (growFromToday: boolean) =>
      period(
        simulate(
          sim({
            accounts: [acct("c", "cash", 100_000)],
            plan: {
              expenses: [
                {
                  id: "h",
                  type: "healthcare",
                  name: "H",
                  owner: "me",
                  amount: { value: 1_000 },
                  frequency: "yearly",
                  range: from("2029-01"),
                  change: { kind: "inflation", plus: 0.02 },
                  growFromToday,
                },
              ],
            },
          }),
        ),
        2029,
      ).totals.expenses;
    expect(exp(true)).toBeCloseTo(1_000 * 1.02 ** 2, 6);
    expect(exp(false)).toBeCloseTo(1_000, 6);
  });

  it("applies the government benefit COLA modifier", () => {
    const r = simulate(
      sim({
        accounts: [cash],
        inflation: 0.02,
        plan: {
          assumptions: { benefitColaModifier: -0.005 },
          income: [income({ type: "social-security", amount: { value: 10_000 } })],
        },
        years: 2,
      }),
    );
    expect(incomes(r)[1]).toBeCloseTo(10_000 * 1.02 * 0.995, 6);
  });

  it("uprates the UK State Pension with the triple lock", () => {
    const run = (inflation: number) =>
      incomes(
        simulate(
          sim({
            accounts: [cash],
            inflation,
            plan: {
              income: [
                income({
                  type: "state-pension",
                  amount: { value: 11_500 },
                  tripleLock: { earningsPremium: 0.01, floor: 0.025 },
                } as never),
              ],
            },
            years: 2,
          }),
        ),
      );
    expect(run(0.01)[1]).toBeCloseTo(11_500 * 1.025, 6); // floor wins
    expect(run(0.03)[1]).toBeCloseTo(11_500 * 1.04, 6); // earnings (inflation + 1%) wins
  });

  it("routes income to accounts and vests RSUs into a brokerage account", () => {
    const r = simulate(
      sim({
        accounts: [acct("c", "cash", 10_000), acct("t", "taxable", 0)],
        plan: {
          tax: flatTax(0.2),
          income: [
            {
              id: "rsu",
              type: "rsu",
              name: "RSU",
              owner: "me",
              amount: { value: 0 },
              frequency: "once",
              range: always,
              vesting: [
                { at: { kind: "date", date: "2027-03" }, value: 10_000 },
                { at: { kind: "date", date: "2027-09" }, value: 10_000 },
              ],
              destinationAccountId: "t",
            },
          ],
        },
        years: 1,
      }),
    );
    const t = account(r, 2027, "t");
    expect(t.contributions).toBeCloseTo(20_000, 6);
    expect(t.costBasis).toBeCloseTo(20_000, 6);
    expect(period(r, 2027).taxes.total).toBeCloseTo(4_000, 6);
    expect(account(r, 2027, "c").closing).toBeCloseTo(6_000, 6);
    expectInvariants(r);
  });
});

describe("income: defined-benefit pension", () => {
  const salary = (payout: object, change: object = { kind: "none" }) => ({
    id: "s",
    type: "salary" as const,
    name: "Salary",
    owner: "me",
    amount: { value: 50_000 },
    frequency: "yearly" as const,
    range: between("2027-01", "2030-01"),
    change,
    pension: {
      employeeContribution: { kind: "percentOfPay", rate: 0.05 },
      payouts: { start: { kind: "date", date: "2030-01" }, end: { kind: "planEnd" } },
      payout,
      payoutChange: { kind: "none" },
    },
  });

  it("pays a share of final pay and deducts employee contributions pre-tax", () => {
    const r = simulate(
      sim({
        accounts: [cash],
        plan: {
          tax: flatTax(0.2),
          income: [salary({ kind: "percentOfFinalPay", rate: 0.5 }) as never],
        },
        years: 4,
      }),
    );
    expect(period(r, 2027).taxes.total).toBeCloseTo((50_000 - 2_500) * 0.2, 6);
    expect(account(r, 2027, "c").closing).toBeCloseTo(50_000 - 2_500 - 9_500, 6);
    expect(period(r, 2030).income.find((l) => l.sourceId === "s:pension")!.amount).toBeCloseTo(
      25_000,
      6,
    );
    expectInvariants(r);
  });

  it("pays a share of career-average pay", () => {
    const r = simulate(
      sim({
        accounts: [cash],
        plan: {
          income: [
            salary(
              { kind: "percentOfCareerAverage", rate: 0.5 },
              { kind: "rate", rate: 0.1 },
            ) as never,
          ],
        },
        years: 4,
      }),
    );
    const avg = (50_000 + 55_000 + 60_500) / 3;
    expect(period(r, 2030).income.find((l) => l.sourceId === "s:pension")!.amount).toBeCloseTo(
      0.5 * avg,
      6,
    );
  });
});

describe("income: US Social Security estimate", () => {
  const ss = (owner: string, pia: number, claimAge: number) =>
    ({
      id: `ss-${owner}`,
      type: "social-security",
      name: `SS ${owner}`,
      owner,
      amount: { value: 0 },
      frequency: "monthly",
      range: always,
      mode: "estimate",
      estimate: { pia, claimAge },
    }) as IncomeEventInput;

  it("reduces early claims and credits delayed ones", () => {
    expect(ssFullRetirementAge(1960)).toBe(67);
    expect(ssFullRetirementAge(1957)).toBeCloseTo(66.5, 9);
    expect(ssClaimFactor(60)).toBeCloseTo(0.7, 12);
    expect(ssClaimFactor(-36)).toBeCloseTo(1.24, 12);
    const run = (claim: number) =>
      incomes(
        simulate(
          sim({
            births: ["1960-01"],
            accounts: [cash],
            plan: { income: [ss("me", 2_000, claim)] },
            years: 1,
            start: "2031-01",
          }),
        ),
      )[0];
    expect(run(62)).toBeCloseTo(1_400 * 12, 6);
    expect(run(70)).toBeCloseTo(2_480 * 12, 6);
  });

  it("applies the earnings test before full retirement age", () => {
    const r = simulate(
      sim({
        births: ["1965-01"],
        accounts: [cash],
        plan: {
          income: [
            ss("me", 2_000, 62),
            { ...income({ type: "salary", amount: { value: 50_000 } }), id: "sal" },
          ],
        },
        years: 1,
      }),
    );
    // 16,800 benefit - (50,000 - 23,400) / 2
    expect(period(r, 2027).income.find((l) => l.sourceId === "ss-me")!.amount).toBeCloseTo(
      16_800 - 13_300,
      6,
    );
  });

  it("adds spousal benefits and switches to the survivor benefit after a death", () => {
    const r = simulate(
      sim({
        births: ["1960-01", "1960-01"],
        accounts: [{ ...cash, owner: "joint" }],
        plan: {
          milestones: [
            {
              id: "le-a",
              name: "A LE",
              kind: "life-expectancy",
              personId: "a",
              criteria: [{ kind: "age", personId: "a", age: 70 }],
            },
            {
              id: "le-b",
              name: "B LE",
              kind: "life-expectancy",
              personId: "b",
              criteria: [{ kind: "age", personId: "b", age: 90 }],
            },
          ],
          income: [ss("a", 3_000, 67), ss("b", 1_000, 67)],
        },
        years: 5,
      }),
    );
    const line = (y: number, id: string) =>
      period(r, y).income.find((l) => l.sourceId === id)?.amount ?? 0;
    expect(line(2027, "ss-b")).toBeCloseTo(1_500 * 12, 6);
    expect(line(2027, "ss-a")).toBeCloseTo(3_000 * 12, 6);
    // A dies in 2030-01 (alive that month): B gets 1,500 in January then 3,000 a month.
    expect(line(2030, "ss-a")).toBeCloseTo(3_000, 6);
    expect(line(2030, "ss-b")).toBeCloseTo(1_500 + 3_000 * 11, 6);
    expect(line(2031, "ss-b")).toBeCloseTo(36_000, 6);
  });
});

describe("expenses", () => {
  it("repeats an expense window with a gap", () => {
    const r = simulate(
      sim({
        accounts: [acct("c", "cash", 1_000_000)],
        plan: {
          expenses: [
            {
              id: "e",
              type: "travel",
              name: "T",
              owner: "me",
              amount: { value: 5_000 },
              frequency: "yearly",
              range: between("2027-01", "2029-01"),
              recurrence: { yearsBetween: 1, until: { kind: "date", date: "2033-01" } },
            },
          ],
        },
        years: 6,
      }),
    );
    expect(r.periods.map((p) => p.totals.expenses)).toEqual([5_000, 5_000, 0, 5_000, 5_000, 0]);
  });

  it("pays from specific accounts using the global drawdown hierarchy", () => {
    const r = simulate(
      sim({
        accounts: [acct("isa", "uk-isa", 100_000), acct("c", "cash", 4_000)],
        plan: {
          income: [income({ type: "salary", amount: { value: 50_000 } })],
          expenses: [
            {
              id: "e",
              type: "other",
              name: "E",
              owner: "me",
              amount: { value: 10_000 },
              frequency: "yearly",
              range: always,
              payFrom: { kind: "accounts", accountIds: ["isa", "c"] },
            },
          ],
        },
        years: 1,
      }),
    );
    expect(account(r, 2027, "isa").withdrawals).toBeCloseTo(6_000, 6);
    expect(account(r, 2027, "c").withdrawals).toBeCloseTo(4_000, 6);
    expect(account(r, 2027, "c").closing).toBeCloseTo(50_000, 6);
    expectInvariants(r);
  });

  it("adds Medicare premiums from 65 for US households (autoMedicare)", () => {
    const r = simulate(
      sim({
        births: ["1962-07"],
        location: { country: "US" },
        accounts: [acct("c", "cash", 100_000)],
        plan: { assumptions: { autoMedicare: true, healthcareInflationPremium: 0 } },
        years: 2,
      }),
    );
    expect(period(r, 2027).totals.expenses).toBeCloseTo(6 * (202.9 + 39), 6);
    expect(period(r, 2028).totals.expenses).toBeCloseTo(12 * (202.9 + 39), 6);
  });

  it("cuts the discretionary share of hybrid spending before essentials", () => {
    const r = simulate(
      sim({
        accounts: [acct("c", "cash", 1_500)],
        plan: {
          expenses: [
            {
              id: "h",
              type: "other",
              name: "H",
              owner: "me",
              amount: { value: 1_000 },
              frequency: "yearly",
              range: always,
              spendingType: "hybrid",
              discretionaryShare: 0.4,
            },
            {
              id: "e",
              type: "living",
              name: "E",
              owner: "me",
              amount: { value: 1_000 },
              frequency: "yearly",
              range: always,
            },
          ],
        },
        years: 1,
      }),
    );
    const p = period(r, 2027);
    expect(p.expenses.find((e) => e.sourceId === "h")!.funded).toBeCloseTo(500, 6);
    expect(p.expenses.find((e) => e.sourceId === "e")!.funded).toBeCloseTo(1_000, 6);
  });

  it("treats payroll deductions as pre-tax", () => {
    const r = simulate(
      sim({
        accounts: [cash],
        plan: {
          tax: flatTax(0.2),
          income: [income({ id: "sal", type: "salary", amount: { value: 50_000 } })],
          expenses: [
            {
              id: "p",
              type: "healthcare",
              name: "P",
              owner: "me",
              amount: { value: 5_000 },
              frequency: "yearly",
              range: always,
              tax: { payrollDeductionFromIncomeId: "sal" },
            },
          ],
        },
        years: 1,
      }),
    );
    expect(period(r, 2027).taxes.total).toBeCloseTo(9_000, 6);
  });
});
