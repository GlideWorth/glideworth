import { describe, expect, it } from "vitest";
import type { HistoricalDataset } from "../src/engine/types.js";
import { HISTORICAL_SERIES, parseMonth, simulate, ukPensionAccessMonth } from "../src/index.js";
import { account, acct, always, expectInvariants, flatTax, period, sim } from "./engine-helpers.js";

const stocks10 = { stockReturn: { kind: "fixed" as const, rate: 0.1 } };

describe("growth: bonds", () => {
  it("follows a linear plan glide path", () => {
    const r = simulate(
      sim({
        accounts: [acct("t", "taxable", 100_000)],
        plan: {
          assumptions: {
            ...stocks10,
            bondAllocation: {
              kind: "glidepath",
              interpolation: "linear",
              points: [
                { at: { kind: "date", date: "2027-01" }, value: 0.2 },
                { at: { kind: "date", date: "2029-01" }, value: 0.6 },
              ],
            },
          },
        },
      }),
    );
    expect(account(r, 2027, "t").growth).toBeCloseTo(8_000, 6);
    expect(account(r, 2028, "t").bondShare).toBeCloseTo(0.4, 9);
    expect(account(r, 2028, "t").growth).toBeCloseTo(108_000 * 0.6 * 0.1, 6);
    expect(account(r, 2029, "t").growth).toBeCloseTo(114_480 * 0.4 * 0.1, 6);
    expectInvariants(r);
  });

  it("per-account schedule overrides the plan allocation (step)", () => {
    const r = simulate(
      sim({
        accounts: [
          acct("t", "taxable", 100_000, {
            behaviour: {
              bondAllocation: {
                kind: "schedule",
                interpolation: "step",
                points: [
                  { at: { kind: "date", date: "2027-01" }, value: 0 },
                  { at: { kind: "date", date: "2028-06" }, value: 1 },
                ],
              },
            },
          }),
        ],
        plan: { assumptions: { ...stocks10, bondAllocation: { kind: "fixed", share: 0.5 } } },
      }),
    );
    expect(account(r, 2027, "t").bondShare).toBe(0);
    expect(account(r, 2028, "t").bondShare).toBe(0); // step: 2028-06 not reached at period start
    expect(account(r, 2029, "t").bondShare).toBe(1);
  });

  it("fills the bond location priority accounts first", () => {
    const r = simulate(
      sim({
        accounts: [acct("ira", "traditional-ira", 50_000), acct("t", "taxable", 150_000)],
        plan: {
          assumptions: {
            ...stocks10,
            bondAllocation: { kind: "fixed", share: 0.5, locationPriority: ["ira"] },
          },
        },
        years: 1,
      }),
    );
    expect(account(r, 2027, "ira").bondShare).toBe(1);
    expect(account(r, 2027, "t").bondShare).toBeCloseTo(1 / 3, 9);
    expect(account(r, 2027, "t").growth).toBeCloseTo(10_000, 6);
  });

  it("weighted distribution balances around overrides and warns when unreachable", () => {
    const run = (overrideShare: number) =>
      simulate(
        sim({
          accounts: [
            acct("a1", "taxable", 100_000, {
              behaviour: { bondAllocation: { kind: "fixed", share: overrideShare } },
            }),
            acct("a2", "taxable", 100_000),
          ],
          plan: {
            assumptions: {
              bondAllocation: { kind: "fixed", share: 0.25, distribution: "weighted" },
            },
          },
          years: 1,
        }),
      );
    expect(account(run(0), 2027, "a2").bondShare).toBeCloseTo(0.5, 9);
    const r = run(1);
    expect(account(r, 2027, "a2").bondShare).toBe(0);
    expect(r.warnings.some((w) => w.message.includes("bond target unreachable"))).toBe(true);
  });
});

describe("growth: rates", () => {
  it("honours an account growth schedule", () => {
    const r = simulate(
      sim({
        accounts: [
          acct("t", "taxable", 100_000, {
            behaviour: {
              growth: {
                kind: "schedule",
                interpolation: "step",
                points: [
                  { at: { kind: "date", date: "2027-01" }, rate: 0.05 },
                  { at: { kind: "date", date: "2028-01" }, rate: 0.1 },
                ],
              },
            },
          }),
        ],
        years: 2,
      }),
    );
    expect(account(r, 2027, "t").closing).toBeCloseTo(105_000, 6);
    expect(account(r, 2028, "t").closing).toBeCloseTo(115_500, 6);
  });

  it("plays a deterministic historical sequence with looping; defaults to the bundled data", () => {
    const data: Record<number, number> = { 2000: 0.1, 2001: -0.2, 2002: 0.3 };
    const ds: HistoricalDataset = {
      range: () => ({ first: 2000, last: 2002 }),
      value: (_s, y) => data[y],
    };
    const input = sim({
      accounts: [acct("t", "taxable", 100_000)],
      plan: {
        assumptions: {
          stockReturn: { kind: "historical", series: "us-stocks", startYear: 2001, loopYear: 2000 },
        },
      },
    });
    const r = simulate(input, { historical: ds });
    expect(r.periods.map((p) => p.market.stocks)).toEqual([-0.2, 0.3, 0.1]);
    expect(account(r, 2029, "t").closing).toBeCloseTo(100_000 * 0.8 * 1.3 * 1.1, 6);
    // Without an injected dataset the public entry uses HISTORICAL_SERIES (us-1928).
    const real = simulate(input);
    expect(real.periods[0]!.market.stocks).toBeCloseTo(
      HISTORICAL_SERIES.value("us-stocks", 2001)!,
      12,
    );
    // A modifier shifts every historical value.
    const shifted = simulate(
      sim({
        accounts: [acct("t", "taxable", 100_000)],
        plan: {
          assumptions: {
            stockReturn: {
              kind: "historical",
              series: "us-stocks",
              startYear: 2001,
              loopYear: 2000,
              modifier: -0.01,
            },
          },
        },
      }),
      { historical: ds },
    );
    expect(shifted.periods.map((p) => p.market.stocks)).toEqual(
      [-0.21, 0.29, 0.09].map((x) => expect.closeTo(x, 12)),
    );
  });

  it("applies fees (percent of balance) and dividends split qualified/ordinary", () => {
    const r = simulate(
      sim({
        accounts: [
          acct("t", "taxable", 100_000, {
            behaviour: {
              fees: { kind: "percentOfBalance", rate: 0.01 },
              dividends: {
                yield: { kind: "fixed", rate: 0.01 },
                treatment: "qualified",
                qualifiedShare: 0.6,
                reinvest: false,
              },
            },
          }),
          acct("c", "cash", 0),
        ],
        plan: { tax: flatTax(0.3, 0, 0.15) },
        years: 1,
      }),
    );
    const t = account(r, 2027, "t");
    expect(t.fees).toBeCloseTo(1_000, 6);
    expect(t.dividends).toBeCloseTo(1_000, 6);
    expect(t.closing).toBeCloseTo(99_000, 6);
    // qualified 600 x 15% + ordinary 400 x 30%
    expect(period(r, 2027).taxes.total).toBeCloseTo(90 + 120, 6);
    expectInvariants(r);
  });

  it("reinvests dividends only inside the DRIP window", () => {
    const r = simulate(
      sim({
        accounts: [
          acct("t", "taxable", 100_000, {
            behaviour: { dividends: { yield: { kind: "fixed", rate: 0.04 } } },
          }),
          acct("c", "cash", 0),
        ],
        plan: { assumptions: { dividendReinvestment: { enabled: true, window: between27(6) } } },
        years: 2,
      }),
    );
    expect(account(r, 2027, "t").dividendsReinvested).toBeCloseTo(2_000, 6);
    expect(account(r, 2027, "c").closing).toBeCloseTo(2_000, 6);
    expect(account(r, 2028, "t").dividendsReinvested).toBe(0);
    expectInvariants(r);
  });

  it("uses assumption rates for 'fixed' Monte Carlo accounts under a market path", () => {
    const m = {
      stocks: 0.5,
      bonds: 0,
      cash: 0,
      inflation: 0,
      dividendYield: 0,
      bondYield: 0,
      crypto: 0,
    };
    const r = simulate({
      ...sim({
        accounts: [
          acct("fx", "taxable", 100, { behaviour: { monteCarlo: "fixed" } }),
          acct("au", "taxable", 100),
        ],
        plan: { assumptions: stocks10 },
        years: 1,
      }),
      options: { market: { periods: [m] } },
    });
    expect(account(r, 2027, "fx").closing).toBeCloseTo(110, 9);
    expect(account(r, 2027, "au").closing).toBeCloseTo(150, 9);
  });
});

function between27(months: number) {
  return {
    start: { kind: "date" as const, date: "2027-01" },
    end: { kind: "date" as const, date: `2027-${String(1 + months).padStart(2, "0")}` },
  };
}

describe("liquidity, access ages and penalties", () => {
  it("computes the UK normal minimum pension age transition", () => {
    expect(ukPensionAccessMonth(parseMonth("1972-06"))).toBe(parseMonth("2027-06"));
    expect(ukPensionAccessMonth(parseMonth("1973-06"))).toBe(parseMonth("2030-06"));
  });

  it("locks a SIPP until age 57 (born after April 1973)", () => {
    const r = simulate(
      sim({
        births: ["1980-01"],
        start: "2036-01",
        accounts: [acct("sipp", "uk-sipp", 100_000)],
        plan: {
          expenses: [
            {
              id: "e",
              type: "living",
              name: "L",
              owner: "me",
              amount: { value: 10_000 },
              frequency: "yearly",
              range: always,
            },
          ],
        },
        years: 2,
      }),
    );
    expect(period(r, 2036).totals.shortfall).toBeCloseTo(10_000, 6);
    expect(account(r, 2036, "sipp").withdrawable).toBe(false);
    expect(account(r, 2037, "sipp").withdrawals).toBeCloseTo(10_000, 6);
  });

  it("grosses up an early 401(k) withdrawal for the 10% penalty and warns", () => {
    const r = simulate(
      sim({
        accounts: [
          acct("k", "401k", 100_000, {
            behaviour: { earlyWithdrawal: { enabled: true, qualifiedAge: 59.5, penaltyRate: 0.1 } },
          }),
        ],
        plan: {
          expenses: [
            {
              id: "e",
              type: "living",
              name: "L",
              owner: "me",
              amount: { value: 10_000 },
              frequency: "yearly",
              range: always,
            },
          ],
        },
        years: 1,
      }),
    );
    expect(account(r, 2027, "k").withdrawals).toBeCloseTo(10_000 / 0.9, 4);
    expect(r.warnings.some((w) => w.code === "EARLY_WITHDRAWAL_PENALTY")).toBe(true);
  });

  it("charges 25% on early LISA withdrawals", () => {
    const r = simulate(
      sim({
        accounts: [acct("l", "uk-lisa", 100_000)],
        plan: {
          expenses: [
            {
              id: "e",
              type: "living",
              name: "L",
              owner: "me",
              amount: { value: 7_500 },
              frequency: "yearly",
              range: always,
            },
          ],
        },
        years: 1,
      }),
    );
    expect(account(r, 2027, "l").withdrawals).toBeCloseTo(10_000, 4);
    expect(
      period(r, 2027).taxes.lines.some(
        (l) => l.kind === "penalty" && l.jurisdictionId === "engine",
      ),
    ).toBe(true);
  });

  it("gates withdrawals with 'from' and 'until' rules", () => {
    const r = simulate(
      sim({
        accounts: [
          acct("early", "cash", 100_000, {
            behaviour: { withdrawals: { kind: "until", ref: { kind: "date", date: "2028-01" } } },
          }),
          acct("late", "taxable", 100_000, {
            behaviour: { withdrawals: { kind: "from", ref: { kind: "date", date: "2028-01" } } },
          }),
        ],
        plan: {
          expenses: [
            {
              id: "e",
              type: "living",
              name: "L",
              owner: "me",
              amount: { value: 1_000 },
              frequency: "yearly",
              range: always,
            },
          ],
        },
        years: 2,
      }),
    );
    expect(account(r, 2027, "early").withdrawals).toBeCloseTo(1_000, 6);
    expect(account(r, 2028, "early").withdrawals).toBe(0);
    expect(account(r, 2028, "late").withdrawals).toBeCloseTo(1_000, 6);
    expect(period(r, 2027).totals.liquidNetWorth).toBeCloseTo(99_000, 6);
  });
});

describe("UK pension tax-free cash", () => {
  const sipp = (balance: number, behaviour = {}) => acct("sipp", "uk-sipp", balance, { behaviour });
  const spend = (value: number) => ({
    expenses: [
      {
        id: "e",
        type: "living" as const,
        name: "L",
        owner: "me",
        amount: { value },
        frequency: "yearly" as const,
        range: always,
      },
    ],
  });

  it("UFPLS by default: 25% of each withdrawal is tax-free", () => {
    const r = simulate(
      sim({
        births: ["1967-01"],
        accounts: [sipp(1_000_000)],
        plan: { ...spend(40_000), tax: flatTax(0.2) },
        years: 1,
      }),
    );
    const w = 40_000 / 0.85;
    expect(account(r, 2027, "sipp").withdrawals).toBeCloseTo(w, 4);
    expect(period(r, 2027).taxes.total).toBeCloseTo(0.2 * 0.75 * w, 4);
    expect(period(r, 2027).totals.taxFreePensionCash).toBeCloseTo(0.25 * w, 4);
  });

  it("caps tax-free cash at the lump-sum allowance", () => {
    const r = simulate(
      sim({ births: ["1967-01"], accounts: [sipp(3_000_000)], plan: spend(1_200_000), years: 2 }),
    );
    expect(period(r, 2027).totals.taxFreePensionCash).toBeCloseTo(268_275, 4);
    expect(period(r, 2028).totals.taxFreePensionCash).toBeCloseTo(0, 6);
  });

  it("PCLS: a 25% lump sum on first access, the excess is saved, later withdrawals fully taxed", () => {
    const r = simulate(
      sim({
        births: ["1967-01"],
        accounts: [acct("c", "cash", 0), sipp(400_000, { ukDrawdownMethod: "pcls" })],
        plan: { ...spend(20_000), tax: flatTax(0.2) },
        years: 6,
      }),
    );
    expect(account(r, 2027, "sipp").withdrawals).toBeCloseTo(100_000, 6);
    expect(account(r, 2027, "c").closing).toBeCloseTo(80_000, 6);
    expect(period(r, 2027).taxes.total).toBeCloseTo(0, 6);
    expect(account(r, 2028, "c").withdrawals).toBeCloseTo(20_000, 6);
    // 2032: the 80k of cash lasts four years; then pension withdrawals are fully taxable.
    expect(account(r, 2032, "sipp").withdrawals).toBeCloseTo(20_000 / 0.8, 4);
    expect(r.trace.some((t) => t.code === "PCLS_TAKEN")).toBe(true);
    expectInvariants(r);
  });
});

describe("offset accounts", () => {
  it("reduces interest on the linked debt and earns nothing itself", () => {
    const r = simulate(
      sim({
        accounts: [acct("off", "savings", 50_000, { behaviour: { offsetForLoanId: "d" } })],
        finances: {
          debts: [
            {
              id: "d",
              name: "Loan",
              type: "debt",
              owner: "me",
              balance: 100_000,
              interest: { apr: 0.12, method: "compound", compounding: "monthly" },
              monthlyPayment: { value: 0, basis: "nominal" },
            },
          ],
        },
        plan: { assumptions: { cashReturn: { kind: "fixed", rate: 0.05 } } },
        years: 1,
      }),
    );
    expect(period(r, 2027).debts[0]!.closing).toBeCloseTo(50_000 + 50_000 * 1.01 ** 12, 4);
    expect(account(r, 2027, "off").growth).toBe(0);
  });
});
