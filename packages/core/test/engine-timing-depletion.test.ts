/**
 * Cash-flow timing at depletion (engine 0.5.0). Growth is credited on the opening balance and flows
 * are booked at the period end; the timing convention then charges each withdrawal the return it
 * forgoes. Before 0.5.0 a withdrawal could take the account's fully grown balance and the timing
 * charge was clamped at zero, so whenever an account was emptied in a year the household received
 * growth the account had not earned by the time of the withdrawal (the full year's growth under
 * 'start', half a year's under 'mid'). Now `withdrawable` caps each withdrawal at what the account
 * holds when the convention says the money leaves. All expected values below are hand-computed.
 */
import { describe, expect, it } from "vitest";
import { simulate } from "../src/engine/simulate.js";
import type { ExpenseEventInput as ExpenseInput } from "../src/schema/events.js";
import { SimulationInput, solveRequiredPortfolio } from "../src/index.js";
import { account, acct, always, expectInvariants, from, period, sim } from "./engine-helpers.js";

type Timing = "start" | "mid" | "end";
type Range = ExpenseInput["range"];

const spend = (id: string, value: number, range: Range = always) => ({
  id,
  type: "living" as const,
  name: id,
  owner: "me",
  amount: { value },
  frequency: "yearly" as const,
  range,
});

/** One taxable account (no gain, 0% tax), all-equity at a fixed return, spending `need` a year. */
function oneAccount(timing: Timing, balance: number, r: number, need: number, years = 1) {
  return sim({
    years,
    accounts: [acct("t", "taxable", balance, { costBasis: balance })],
    plan: {
      expenses: [spend("e", need)],
      assumptions: {
        cashFlowTiming: timing,
        stockReturn: { kind: "fixed", rate: r },
        bondAllocation: { kind: "fixed", share: 0 },
      },
    },
    options: { trace: "full" },
  });
}

describe("cash-flow timing when a withdrawal empties the account", () => {
  // 10,000 at 10%, 12,000 needed. What the account holds when the money leaves:
  //   start: 10,000 (nothing earned yet)      -> pays 10,000, shortfall 2,000
  //   mid:   10,000 x 1.1^0.5 = 10,488.0885   -> shortfall 1,511.9115
  //   end:   11,000                           -> shortfall 1,000
  // Before 0.5.0 every timing paid 11,000 (shortfall 1,000).
  const cases: [Timing, number][] = [
    ["start", 10_000],
    ["mid", 10_000 * Math.sqrt(1.1)],
    ["end", 11_000],
  ];
  it.each(cases)("%s: pays only what the account holds at that time", (timing, paid) => {
    const r = simulate(oneAccount(timing, 10_000, 0.1, 12_000));
    const a = account(r, 2027, "t");
    expect(a.withdrawals).toBeCloseTo(paid, 6);
    expect(period(r, 2027).totals.shortfall).toBeCloseTo(12_000 - paid, 6);
    expect(a.closing).toBe(0); // exactly zero, so depletion is detected
    // Growth reported for the year = 1,000 on the opening balance less the return forgone by the
    // withdrawal: (1.1^k - 1) x paid, with k = 1 / 0.5 / 0.
    const k = timing === "start" ? 1 : timing === "mid" ? 0.5 : 0;
    expect(a.growth).toBeCloseTo(1_000 - (1.1 ** k - 1) * paid, 6);
    expectInvariants(r);
  });

  it("a withdrawal that does not empty the account is unchanged: (10,000 - 5,000) x 1.1", () => {
    const r = simulate(oneAccount("start", 10_000, 0.1, 5_000));
    expect(account(r, 2027, "t").closing).toBeCloseTo(5_500, 6);
    expect(period(r, 2027).totals.shortfall).toBe(0);
  });

  it("an emptied cash account hands over to the next account at the right amount (mid timing)", () => {
    // Cash 1,000 at 4%, portfolio 100,000 at 10%, 20,000 needed, mid-year timing.
    // Cash can pay 1,000 x 1.04^0.5 = 1,019.8039; the portfolio pays the remaining 18,980.1961 and
    // ends at 100,000 x 1.1 - 18,980.1961 x 1.1^0.5 = 90,093.1908. Before 0.5.0 cash paid 1,040.
    const input = sim({
      accounts: [acct("c", "cash", 1_000), acct("t", "taxable", 100_000, { costBasis: 100_000 })],
      plan: {
        expenses: [spend("e", 20_000)],
        drawdown: {
          order: [
            { kind: "category", category: "cash" },
            { kind: "category", category: "taxable" },
          ],
        },
        assumptions: {
          cashFlowTiming: "mid",
          stockReturn: { kind: "fixed", rate: 0.1 },
          cashReturn: { kind: "fixed", rate: 0.04 },
          bondAllocation: { kind: "fixed", share: 0 },
        },
      },
      options: { trace: "full" },
    });
    const r = simulate(input);
    const fromCash = 1_000 * Math.sqrt(1.04);
    expect(account(r, 2027, "c").withdrawals).toBeCloseTo(fromCash, 6);
    expect(account(r, 2027, "c").closing).toBe(0);
    expect(account(r, 2027, "t").withdrawals).toBeCloseTo(20_000 - fromCash, 6);
    expect(account(r, 2027, "t").closing).toBeCloseTo(
      110_000 - (20_000 - fromCash) * Math.sqrt(1.1),
      6,
    );
    expect(period(r, 2027).totals.shortfall).toBe(0);
    expectInvariants(r);
  });

  it("required portfolio equals the closed-form present value for every timing (the reported case)", async () => {
    // 45 years: 25,000 a year for 15 years (40,000 spending less 15,000 part-time pay), then
    // 40,000 a year for 30 years, 3% real, no inflation. With withdrawal t (t = 0..44) made k of
    // the way into year t+1 (k = 0 start, 0.5 mid, 1 end), PV = sum of w_t / 1.03^(t + k):
    // start of year 825,729.86 (the engine gave 825,412.53 before 0.5.0), mid-year
    // 813,615.81 (813,458.32), end of year 801,679.48 (unchanged).
    const flows = Array.from({ length: 45 }, (_, t) => (t < 15 ? 25_000 : 40_000));
    const pv = (k: number) => flows.reduce((s, w, t) => s + w / 1.03 ** (t + k), 0);
    const expected: [Timing, number, number][] = [
      ["start", 0, 825_729.86],
      ["mid", 0.5, 813_615.81],
      ["end", 1, 801_679.48],
    ];
    for (const [timing, k, rounded] of expected) {
      expect(pv(k)).toBeCloseTo(rounded, 2);
      const input = sim({
        years: 45,
        accounts: [acct("t", "taxable", pv(k), { costBasis: pv(k) })],
        plan: {
          expenses: [
            spend("e1", 25_000, { start: { kind: "planStart" }, end: from("2042-01").start }),
            spend("e2", 40_000, from("2042-01")),
          ],
          assumptions: {
            cashFlowTiming: timing,
            stockReturn: { kind: "fixed", rate: 0.03 },
            bondAllocation: { kind: "fixed", share: 0 },
          },
        },
        options: { trace: "off" },
      });
      const res = await solveRequiredPortfolio(SimulationInput.parse(input), {
        objective: { kind: "noShortfall" },
        bounds: { min: 0.5, max: 1.5 },
        tolerance: 1e-10,
        maxEvaluations: 200,
      });
      expect(Math.abs(res.value! - 1), timing).toBeLessThan(1e-8);
    }
  });
});
