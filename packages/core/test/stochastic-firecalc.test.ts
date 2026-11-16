/**
 * Validation against FIRECalc's published 4% rule result: 60/40 stocks/bonds, $1,000,000, $40,000 a
 * year inflation-adjusted, 30 years, FIRECalc default 0.18% expense ratio. FIRECalc, on US data from
 * 1871, reports 96.8% success (4 failing cycles of 126; reference value from the workplan).
 *
 * This test used to run on Shiller's 1871 data and land within 2 points of 96.8% (start-of-year
 * timing: 95.2%, 120 of 126). That data is no longer bundled (no explicit licence), so it now runs on
 * the bundled `us-1928`: 69 cycles starting 1928-1996. The pre-1928 cycles, which all survive in
 * both FIRECalc and the old run, are missing, so the same handful of failing mid-1960s starts is a
 * larger share: start-of-year timing gives 94.2% (65 of 69). The comparison is therefore made on
 * what is comparable: the number of failing cycles, and the rate with FIRECalc's 57 pre-1928 cycles
 * added back as successes. FIRECalc withdraws at the start of each year; the engine's cash-flow
 * timing convention reproduces that ('start') and defaults to a mid-year approximation.
 */
import { describe, expect, it } from "vitest";
import { runHistorical, type SimulationInputInput } from "../src/index.js";

function fourPercent(cashFlowTiming: "start" | "mid" | "end"): SimulationInputInput {
  return {
    household: {
      id: "h",
      name: "FIRECalc",
      planningMode: "individual",
      people: [{ id: "me", name: "Me", role: "primary", birthMonth: "1960-01" }],
      location: { country: "US" },
      currency: "USD",
      locale: "en-US",
    },
    finances: {
      asOf: "2026-01",
      accounts: [
        {
          id: "pf",
          name: "Portfolio",
          type: "taxable",
          owner: "me",
          balance: 1_000_000,
          costBasis: 1_000_000,
          behaviour: { fees: { kind: "percentOfBalance", rate: 0.0018 } },
        },
      ],
    },
    plan: {
      id: "p",
      householdId: "h",
      name: "4% rule",
      tax: { mode: "flat", flat: { ordinary: 0, capitalGains: 0, dividends: 0, local: 0 } },
      leftover: { kind: "spend" },
      expenses: [
        {
          id: "spend",
          type: "living",
          name: "Spending",
          owner: "me",
          amount: { value: 40_000, basis: "real" },
          frequency: "yearly",
          range: { start: { kind: "planStart" }, end: { kind: "planEnd" } },
        },
      ],
      assumptions: {
        bondAllocation: { kind: "fixed", share: 0.4 },
        cashFlowTiming,
        end: { kind: "ref", ref: { kind: "date", date: "2056-01" } },
      },
      monteCarlo: { success: { kind: "never-depleted" } },
    },
    options: { trace: "off" },
  };
}

const run = (t: "start" | "mid" | "end") =>
  runHistorical(fourPercent(t), {
    dataset: "us-1928",
    settings: { success: { kind: "never-depleted" } },
  });

/** FIRECalc's cycles that start before 1928 (1871-1927): all succeed, and are absent from us-1928. */
const PRE_1928_CYCLES = 57;

describe("FIRECalc 4% rule comparison (US 1928-, 60/40, 30 years)", () => {
  it("start-of-year withdrawals fail in as many cycles as FIRECalc; later timing is more forgiving", () => {
    const start = run("start");
    const mid = run("mid").successRate;
    const end = run("end").successRate;
    const failed = start.trialSummaries.filter((t) => !t.success).map((t) => t.startYear!);
    const withPre1928 = (start.trials - failed.length + PRE_1928_CYCLES) / 126;
    console.info(
      `FIRECalc 96.8% (4 of 126 fail) | us-1928 start ${(start.successRate * 100).toFixed(1)}% ` +
        `(${failed.length} of ${start.trials} fail: ${failed.join(",")}; ${(withPre1928 * 100).toFixed(1)}% ` +
        `with the pre-1928 cycles) mid ${(mid * 100).toFixed(1)}% end ${(end * 100).toFixed(1)}%`,
    );
    expect(start.trials).toBe(98 - 30 + 1);
    expect(Math.abs(failed.length - 4)).toBeLessThanOrEqual(1);
    for (const y of failed) expect(y >= 1960 && y <= 1970, String(y)).toBe(true);
    expect(Math.abs(withPre1928 - 0.968)).toBeLessThanOrEqual(0.02);
    expect(start.successRate).toBeLessThanOrEqual(mid);
    expect(mid).toBeLessThanOrEqual(end);
  });
});
