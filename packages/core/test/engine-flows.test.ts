import { describe, expect, it } from "vitest";
import { simulate } from "../src/index.js";
import type { FlowInput } from "../src/schema/flows.js";
import {
  account,
  acct,
  always,
  expectInvariants,
  flatTax,
  period,
  sim,
  ZERO_TAX,
} from "./engine-helpers.js";

const salary = (value: number, id = "sal", owner = "me") => ({
  id,
  type: "salary" as const,
  name: "Salary",
  owner,
  amount: { value },
  frequency: "yearly" as const,
  range: always,
});
const spend = (value: number, extra: object = {}) => ({
  id: "e",
  type: "living" as const,
  name: "L",
  owner: "me",
  amount: { value },
  frequency: "yearly" as const,
  range: always,
  ...extra,
});
const contribution = (accountId: string, method: object, extra: object = {}): FlowInput =>
  ({
    kind: "contribution",
    id: `f-${accountId}`,
    name: accountId,
    owner: "me",
    range: always,
    accountId,
    method,
    ...extra,
  }) as FlowInput;

describe("flows: workplace plans", () => {
  it("employer match on a percent-of-pay deferral", () => {
    const r = simulate(
      sim({
        accounts: [acct("c", "cash", 0), acct("k", "401k", 0)],
        plan: {
          income: [salary(100_000)],
          flows: [
            contribution(
              "k",
              { kind: "percentOfIncome", incomeId: "sal", share: 0.06 },
              { employer: { incomeId: "sal", matchShare: 0.5, upToShareOfPay: 0.06 } },
            ),
          ],
        },
        years: 1,
      }),
    );
    expect(account(r, 2027, "k").contributions).toBeCloseTo(6_000 + 3_000, 6);
    expect(account(r, 2027, "c").closing).toBeCloseTo(94_000, 6);
    expect(r.trace.some((t) => t.code === "EMPLOYER_MATCH")).toBe(true);
    expectInvariants(r);
  });

  it("reduce-if-underfunded scales the match with the funded deferral", () => {
    const run = (reduceIfUnderfunded: boolean) =>
      account(
        simulate(
          sim({
            accounts: [acct("c", "cash", 0), acct("k", "401k", 0)],
            plan: {
              income: [salary(100_000)],
              expenses: [spend(97_000)],
              flows: [
                contribution(
                  "k",
                  { kind: "percentOfIncome", incomeId: "sal", share: 0.06 },
                  {
                    employer: {
                      incomeId: "sal",
                      matchShare: 0.5,
                      upToShareOfPay: 0.06,
                      reduceIfUnderfunded,
                    },
                  },
                ),
              ],
            },
            years: 1,
          }),
        ),
        2027,
        "k",
      ).contributions;
    expect(run(true)).toBeCloseTo(3_000 + 1_500, 6);
    expect(run(false)).toBeCloseTo(3_000 + 3_000, 6);
  });

  it("jurisdiction limits share one allowance across accounts, with catch-up", () => {
    const run = (birth: string) =>
      simulate(
        sim({
          births: [birth],
          accounts: [acct("c", "cash", 0), acct("k1", "401k", 0), acct("k2", "roth-401k", 0)],
          plan: {
            income: [salary(200_000)],
            flows: [
              contribution("k1", { kind: "max" }, { limit: { kind: "jurisdiction" } }),
              contribution("k2", { kind: "max" }, { limit: { kind: "jurisdiction" } }),
            ],
          },
          years: 1,
        }),
      );
    const r = run("1980-01");
    // Limits come from the US tax data for the plan year, 2027 (Notice 2026-66: $25,500 deferral;
    // $11,750 super catch-up at 60-63).
    expect(account(r, 2027, "k1").contributions).toBeCloseTo(25_500, 6);
    expect(account(r, 2027, "k2").contributions).toBe(0);
    expect(account(run("1966-01"), 2027, "k1").contributions).toBeCloseTo(25_500 + 11_750, 6);
  });

  it("mega-backdoor Roth uses the remaining 415(c) space; backdoor Roth is non-deductible", () => {
    const r = simulate(
      sim({
        accounts: [
          acct("c", "cash", 0),
          acct("k", "401k", 0),
          acct("rk", "roth-401k", 0),
          acct("ira", "roth-ira", 0),
        ],
        plan: {
          tax: flatTax(0.2),
          income: [salary(300_000)],
          flows: [
            contribution(
              "k",
              { kind: "max" },
              {
                limit: { kind: "jurisdiction" },
                employer: { incomeId: "sal", matchShare: 1, upToShareOfPay: 0.01 },
              },
            ),
            contribution("rk", { kind: "max" }, { route: "mega-backdoor-roth" }),
            contribution("ira", { kind: "max" }, { route: "backdoor-roth" }),
          ],
        },
        years: 1,
      }),
    );
    // 2027 limits (Notice 2026-66): 415(c) $75,000, deferral $25,500, IRA $7,500.
    expect(account(r, 2027, "rk").contributions).toBeCloseTo(75_000 - 25_500 - 3_000, 6);
    expect(account(r, 2027, "ira").contributions).toBeCloseTo(7_500, 6);
    // Only the traditional 401(k) deferral is deductible (the employer match is not the employee's).
    expect(period(r, 2027).taxes.total).toBeCloseTo((300_000 - 25_500) * 0.2, 6);
    expect(r.trace.some((t) => t.code === "MEGA_BACKDOOR_ROTH")).toBe(true);
  });

  describe("US spousal IRA on a joint return (IRC 219(c))", () => {
    // 26 U.S.C. 219(c), https://www.law.cornell.edu/uscode/text/26/219 (read 2026-11-22): on a
    // joint return the spouse with less compensation may count the other spouse's compensation,
    // less that spouse's own IRA contributions (deductible, nondeductible and Roth), up to their
    // own limit. 2026 limits (IR-2025-111, Notice 2025-67): $7,500 plus a $1,100 catch-up at 50.
    // Synthetic couple: A (born 1974) earns $150,000 until `retire`; B (born 1975) earns nothing.
    const run = (
      filingStatus: "married-joint" | "married-separate",
      pay = 150_000,
      retire = "2028-01",
    ) =>
      simulate(
        sim({
          start: "2026-01",
          years: 3,
          births: ["1974-01", "1975-01"],
          location: { country: "US" },
          accounts: [
            acct("c", "cash", 0, { owner: "a" }),
            acct("ra", "roth-ira", 0, { owner: "a" }),
            acct("ib", "traditional-ira", 0, { owner: "b" }),
          ],
          plan: {
            tax: { ...ZERO_TAX, filingStatus },
            income: [
              {
                ...salary(pay, "sal", "a"),
                range: { start: { kind: "planStart" }, end: { kind: "date", date: retire } },
              },
            ],
            flows: [
              {
                ...contribution("ra", { kind: "max" }, { limit: { kind: "jurisdiction" } }),
                owner: "a",
              },
              {
                ...contribution("ib", { kind: "max" }, { limit: { kind: "jurisdiction" } }),
                owner: "b",
              },
            ] as FlowInput[],
          },
        }),
      );

    it("funds the non-working spouse's IRA from joint compensation, then stops with it", () => {
      const r = run("married-joint");
      expect(account(r, 2026, "ra").contributions).toBeCloseTo(8_600, 6);
      expect(account(r, 2026, "ib").contributions).toBeCloseTo(8_600, 6);
      // 2027 limits (IR-2026-136, Notice 2026-66): unchanged at $7,500 + $1,100.
      expect(account(r, 2027, "ib").contributions).toBeCloseTo(8_600, 6);
      // No compensation once A stops working: neither IRA can be funded.
      expect(account(r, 2028, "ra").contributions).toBe(0);
      expect(account(r, 2028, "ib").contributions).toBe(0);
      expectInvariants(r);
    });

    it("joint compensation is reduced by the other spouse's IRA contributions", () => {
      // A earns $10,000: A's Roth takes $8,600, leaving B $1,400 of joint compensation.
      const r = run("married-joint", 10_000);
      expect(account(r, 2026, "ra").contributions).toBeCloseTo(8_600, 6);
      expect(account(r, 2026, "ib").contributions).toBeCloseTo(1_400, 6);
    });

    it("does not pool compensation on separate returns", () => {
      const r = run("married-separate");
      expect(account(r, 2026, "ra").contributions).toBeCloseTo(8_600, 6);
      expect(account(r, 2026, "ib").contributions).toBe(0);
    });
  });

  it("ISA allowance is shared with a LISA (capped at 4,000 plus a 25% bonus)", () => {
    const r = simulate(
      sim({
        accounts: [acct("c", "cash", 0), acct("l", "uk-lisa", 0), acct("i", "uk-isa", 0)],
        plan: {
          income: [salary(60_000)],
          flows: [
            contribution("l", { kind: "max" }, { limit: { kind: "jurisdiction" } }),
            contribution("i", { kind: "max" }, { limit: { kind: "jurisdiction" } }),
          ],
        },
        years: 1,
      }),
    );
    expect(account(r, 2027, "l").closing).toBeCloseTo(5_000, 6);
    expect(account(r, 2027, "i").contributions).toBeCloseTo(16_000, 6);
    expectInvariants(r);
  });
});

describe("flows: funding, targets, transfers, leftover", () => {
  it("funds a contribution from a specific account instead of the surplus", () => {
    const r = simulate(
      sim({
        accounts: [acct("s", "savings", 50_000), acct("i", "uk-isa", 0)],
        plan: {
          flows: [
            contribution(
              "i",
              { kind: "amount", amount: { value: 20_000 } },
              { fundFromAccountIds: ["s"] },
            ),
          ],
        },
        years: 1,
      }),
    );
    expect(account(r, 2027, "i").closing).toBeCloseTo(20_000, 6);
    expect(account(r, 2027, "s").closing).toBeCloseTo(30_000, 6);
    expect(account(r, 2027, "s").transfersOut).toBeCloseTo(20_000, 6);
    expectInvariants(r);
  });

  it("routes cash above a target onward to later flows", () => {
    const r = simulate(
      sim({
        accounts: [acct("c", "cash", 50_000), acct("t", "taxable", 0)],
        plan: {
          flows: [
            contribution(
              "c",
              { kind: "max" },
              { strategy: { kind: "target", target: { value: 20_000 } }, routeExcessOnward: true },
            ),
            contribution("t", { kind: "percentOfRemaining", share: 1 }),
          ],
        },
        years: 1,
      }),
    );
    expect(account(r, 2027, "c").closing).toBeCloseTo(20_000, 6);
    expect(account(r, 2027, "t").closing).toBeCloseTo(30_000, 6);
    expectInvariants(r);
  });

  it("detects Roth conversions (taxable, penalty-free) and tax-free rollovers", () => {
    const r = simulate(
      sim({
        accounts: [
          acct("c", "cash", 10_000),
          acct("ira", "traditional-ira", 100_000),
          acct("roth", "roth-ira", 0, { contributionBasis: 0 }),
          acct("k", "401k", 50_000),
        ],
        plan: {
          tax: flatTax(0.2),
          flows: [
            {
              kind: "transfer",
              id: "conv",
              name: "Conversion",
              owner: "me",
              range: always,
              fromAccountId: "ira",
              to: { kind: "account", accountId: "roth" },
              amount: { kind: "amount", amount: { value: 10_000 } },
            },
            {
              kind: "transfer",
              id: "roll",
              name: "Rollover",
              owner: "me",
              range: always,
              fromAccountId: "k",
              to: { kind: "account", accountId: "ira" },
              amount: { kind: "all" },
            },
          ],
        },
        years: 1,
      }),
    );
    expect(account(r, 2027, "roth").closing).toBeCloseTo(10_000, 6);
    expect(account(r, 2027, "roth").contributionBasis).toBeCloseTo(10_000, 6);
    expect(account(r, 2027, "ira").closing).toBeCloseTo(140_000, 6);
    expect(period(r, 2027).taxes.total).toBeCloseTo(2_000, 6);
    expect(account(r, 2027, "c").closing).toBeCloseTo(8_000, 6);
    expect(r.trace.some((t) => t.code === "ROTH_CONVERSION")).toBe(true);
    expectInvariants(r);
  });

  it("transfers to an external destination realise gains", () => {
    const r = simulate(
      sim({
        accounts: [acct("c", "cash", 10_000), acct("t", "taxable", 100_000, { costBasis: 50_000 })],
        plan: {
          tax: flatTax(0, 0.2),
          flows: [
            {
              kind: "transfer",
              id: "gift",
              name: "Gift",
              owner: "me",
              range: always,
              fromAccountId: "t",
              to: { kind: "external", label: "Kids" },
              amount: { kind: "amount", amount: { value: 20_000 } },
            },
          ],
        },
        years: 1,
      }),
    );
    expect(account(r, 2027, "t").transfersOut).toBeCloseTo(20_000, 6);
    expect(period(r, 2027).taxes.total).toBeCloseTo(2_000, 6);
    expectInvariants(r);
  });

  it("'spend' leftover becomes discretionary spending; mandatory flows draw down", () => {
    const spendIt = simulate(
      sim({
        accounts: [acct("c", "cash", 0)],
        plan: { income: [salary(10_000)], leftover: { kind: "spend" } },
        years: 1,
      }),
    );
    expect(period(spendIt, 2027).totals.spending).toBeCloseTo(10_000, 6);
    const r = simulate(
      sim({
        accounts: [acct("c", "cash", 50_000), acct("i", "uk-isa", 0)],
        plan: {
          flows: [
            contribution("i", { kind: "amount", amount: { value: 20_000 } }, { mandatory: true }),
          ],
        },
        years: 1,
      }),
    );
    expect(account(r, 2027, "i").closing).toBeCloseTo(20_000, 6);
    expect(account(r, 2027, "c").withdrawals).toBeCloseTo(20_000, 6);
    expectInvariants(r);
  });
});

describe("drawdown", () => {
  it("proportional within a category", () => {
    const r = simulate(
      sim({
        accounts: [acct("t1", "taxable", 30_000), acct("t2", "taxable", 10_000)],
        plan: { expenses: [spend(20_000)], drawdown: { withinCategory: "proportional" } },
        years: 1,
      }),
    );
    expect(account(r, 2027, "t1").withdrawals).toBeCloseTo(15_000, 6);
    expect(account(r, 2027, "t2").withdrawals).toBeCloseTo(5_000, 6);
  });

  it("splits by owner for couples", () => {
    const r = simulate(
      sim({
        births: ["1980-01", "1980-01"],
        accounts: [
          acct("ca", "cash", 30_000, { owner: "a" }),
          acct("cb", "cash", 10_000, { owner: "b" }),
        ],
        plan: { expenses: [spend(8_000, { owner: "joint" })], drawdown: { splitByOwner: true } },
        years: 1,
      }),
    );
    expect(account(r, 2027, "ca").withdrawals).toBeCloseTo(6_000, 6);
    expect(account(r, 2027, "cb").withdrawals).toBeCloseTo(2_000, 6);
  });

  it("keeps a cash buffer until everything else is exhausted", () => {
    const run = (taxable: number) =>
      simulate(
        sim({
          accounts: [acct("c", "cash", 15_000), acct("t", "taxable", taxable)],
          plan: { expenses: [spend(20_000)], drawdown: { cashBuffer: { value: 10_000 } } },
          years: 1,
        }),
      );
    const r = run(100_000);
    expect(account(r, 2027, "c").withdrawals).toBeCloseTo(5_000, 6);
    expect(account(r, 2027, "t").withdrawals).toBeCloseTo(15_000, 6);
    const dry = run(0);
    expect(account(dry, 2027, "c").withdrawals).toBeCloseTo(15_000, 6);
    expect(period(dry, 2027).totals.shortfall).toBeCloseTo(5_000, 6);
  });

  it("follows an explicit order with an account entry first", () => {
    const r = simulate(
      sim({
        accounts: [
          acct("c", "cash", 50_000),
          acct("roth", "roth-ira", 50_000, { contributionBasis: 50_000 }),
        ],
        plan: {
          expenses: [spend(10_000)],
          drawdown: {
            order: [
              { kind: "account", accountId: "roth" },
              { kind: "category", category: "cash" },
            ],
          },
        },
        years: 1,
      }),
    );
    expect(account(r, 2027, "roth").withdrawals).toBeCloseTo(10_000, 6);
    expect(r.trace.some((t) => t.code === "WITHDRAWAL" && t.refs.includes("roth"))).toBe(true);
  });
});

describe("withdrawal strategy mode and flex spending in the engine", () => {
  it("replaces expense events with the strategy budget; taxes come out of it", () => {
    const r = simulate(
      sim({
        accounts: [acct("t", "taxable", 1_000_000, { costBasis: 0 })],
        plan: {
          tax: flatTax(0, 0.2),
          expenses: [spend(10_000)],
          withdrawalStrategy: {
            enabled: true,
            start: { kind: "planStart" },
            rule: { kind: "initial-percent", rate: 0.04 },
          },
        },
        years: 2,
      }),
    );
    const p = period(r, 2027);
    expect(account(r, 2027, "t").withdrawals).toBeCloseTo(40_000, 4);
    expect(p.taxes.total).toBeCloseTo(8_000, 4);
    expect(p.totals.spending).toBeCloseTo(32_000, 4);
    expect(p.expenses.some((e) => e.sourceId === "e")).toBe(false);
    expectInvariants(r);
  });

  it("recalculates fixed-percent withdrawals from the portfolio each year (rules from solvers)", () => {
    const r = simulate(
      sim({
        accounts: [acct("t", "taxable", 1_000_000)],
        plan: {
          withdrawalStrategy: {
            enabled: true,
            start: { kind: "planStart" },
            rule: { kind: "fixed-percent", rate: 0.05 },
          },
        },
        years: 2,
      }),
    );
    expect(account(r, 2027, "t").withdrawals).toBeCloseTo(50_000, 4);
    expect(account(r, 2028, "t").withdrawals).toBeCloseTo(47_500, 4);
    expect(
      r.trace.some((t) => t.code === "STRATEGY_AMOUNT" && t.data?.action === "recalculate"),
    ).toBe(true);
  });

  it("treat-as-spending pays taxes on top", () => {
    const r = simulate(
      sim({
        accounts: [acct("t", "taxable", 1_000_000, { costBasis: 0 })],
        plan: {
          tax: flatTax(0, 0.2),
          withdrawalStrategy: {
            enabled: true,
            start: { kind: "planStart" },
            rule: { kind: "initial-percent", rate: 0.04 },
            treatAsSpending: true,
          },
        },
        years: 1,
      }),
    );
    expect(account(r, 2027, "t").withdrawals).toBeCloseTo(50_000, 4);
    expect(period(r, 2027).totals.spending).toBeCloseTo(40_000, 4);
  });

  it("flexible spending cuts discretionary spending after a market drawdown", () => {
    const r = simulate(
      sim({
        accounts: [acct("c", "cash", 100_000), acct("t", "taxable", 100_000)],
        plan: {
          assumptions: { stockReturn: { kind: "fixed", rate: -0.25 } },
          expenses: [spend(10_000, { spendingType: "discretionary", type: "travel" })],
          flexSpending: {
            enabled: true,
            scope: "discretionary",
            rules: [{ drawdown: 0.2, cut: 0.3 }],
          },
        },
        years: 2,
      }),
    );
    expect(period(r, 2027).totals.expenses).toBeCloseTo(10_000, 6);
    expect(period(r, 2028).totals.expenses).toBeCloseTo(7_000, 6);
    expect(period(r, 2028).expenses[0]!.flexCut).toBeCloseTo(0.3, 9);
    expect(r.trace.some((t) => t.code === "FLEX_CUT")).toBe(true);
  });
});

describe("UK pension allowance", () => {
  it("drops to the money-purchase annual allowance after flexible access", () => {
    const r = simulate(
      sim({
        births: ["1967-01"],
        accounts: [
          acct("c", "cash", 0),
          acct("sipp", "uk-sipp", 200_000),
          acct("wp", "uk-workplace-pension", 0),
        ],
        plan: {
          income: [salary(100_000)],
          expenses: [spend(1_000, { payFrom: { kind: "accounts", accountIds: ["sipp"] } })],
          flows: [contribution("wp", { kind: "max" }, { limit: { kind: "jurisdiction" } })],
        },
        years: 1,
      }),
    );
    expect(account(r, 2027, "sipp").withdrawals).toBeCloseTo(1_000, 6);
    expect(account(r, 2027, "wp").contributions).toBeCloseTo(10_000, 6);
  });
});
