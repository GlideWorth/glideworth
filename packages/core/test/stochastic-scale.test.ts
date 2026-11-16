/**
 * Correctness of a long-horizon Monte Carlo run. The wall-clock throughput measurements live in
 * bench/ (`pnpm bench`); nothing here depends on machine speed.
 */
import { describe, expect, it } from "vitest";
import { MonteCarloSettings, runMonteCarlo } from "../src/index.js";
import { always, scenario } from "./helpers.js";

function sixtyYearPlan() {
  const s = scenario({
    years: 60,
    inflation: 0.025,
    accounts: [
      { id: "cash", name: "Cash", type: "cash", owner: "me", balance: 30_000 },
      {
        id: "brk",
        name: "Brokerage",
        type: "taxable",
        owner: "me",
        balance: 400_000,
        costBasis: 250_000,
      },
      { id: "ira", name: "IRA", type: "traditional-ira", owner: "me", balance: 600_000 },
      { id: "roth", name: "Roth", type: "roth-ira", owner: "me", balance: 150_000 },
    ] as never,
    plan: {
      tax: { mode: "flat", flat: { ordinary: 0.2, capitalGains: 0.15, dividends: 0.15, local: 0 } },
      income: [
        {
          id: "sal",
          type: "salary",
          name: "Salary",
          owner: "me",
          amount: { value: 90_000 },
          frequency: "yearly",
          range: { start: { kind: "planStart" }, end: { kind: "date", date: "2040-01" } },
        },
      ],
      expenses: [
        {
          id: "liv",
          type: "living",
          name: "Living",
          owner: "me",
          amount: { value: 55_000 },
          frequency: "yearly",
          range: always,
        },
      ],
      assumptions: { bondAllocation: { kind: "fixed", share: 0.3 } },
    },
  });
  return { ...s, options: { trace: "off" as const } };
}

describe("long-horizon Monte Carlo (correctness, no timing)", () => {
  for (const method of ["normal", "historical-random-restart"] as const) {
    it(`runs every requested trial over 60 years and is deterministic (${method})`, () => {
      const settings = MonteCarloSettings.parse({
        method,
        trials: 100,
        seed: 1,
        dataset: "us-1928",
      });
      const a = runMonteCarlo(sixtyYearPlan(), settings, { keepTrials: false });
      const b = runMonteCarlo(sixtyYearPlan(), settings, { keepTrials: false });
      expect(a.trials).toBe(100);
      expect(a.years).toHaveLength(60);
      expect(a.successRate).toBeGreaterThanOrEqual(0);
      expect(a.successRate).toBeLessThanOrEqual(1);
      expect(b).toEqual(a);
    });
  }
});
