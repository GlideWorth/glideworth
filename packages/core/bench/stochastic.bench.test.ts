/**
 * Throughput benchmark: 1,000 trials of a 60-year plan on one core. Logs trials/second.
 *
 * Opt-in: run with `pnpm bench` (see vitest.bench.config.ts). It is not part of `pnpm test`
 * because wall-clock assertions depend on the machine; a loaded CI runner timed out the same
 * test at the default 5 s. Correctness and determinism of Monte Carlo runs are asserted in
 * test/stochastic.test.ts and test/stochastic-scale.test.ts.
 */
import { describe, expect, it } from "vitest";
import { buildSimulationInput, MonteCarloSettings, runMonteCarlo, simulate } from "../src/index.js";
import { createSampleDocument } from "../src/samples/index.js";
import { always, scenario } from "../test/helpers.js";

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

describe("single deterministic simulation", () => {
  it("full projection of the synthetic sample household (ms per run)", () => {
    const input = buildSimulationInput(createSampleDocument(), "plan-main", { trace: "summary" });
    simulate(input);
    const n = 50;
    const t0 = performance.now();
    for (let i = 0; i < n; i++) simulate(input);
    const ms = (performance.now() - t0) / n;
    console.log(`[bench] single simulation (sample household, full detail): ${ms.toFixed(2)} ms`);
    expect(ms).toBeLessThan(500);
  });
});

describe("Monte Carlo throughput", () => {
  for (const method of ["normal", "historical-random-restart"] as const) {
    it(`1,000 trials of a 60-year plan (${method})`, () => {
      const settings = MonteCarloSettings.parse({
        method,
        trials: 1000,
        seed: 1,
        dataset: "us-1928",
      });
      const t0 = performance.now();
      const r = runMonteCarlo(sixtyYearPlan(), settings, { keepTrials: false });
      const ms = performance.now() - t0;
      expect(r.trials).toBe(1000);
      expect(r.years).toHaveLength(60);
      console.log(
        `[bench] ${method}: 1000 trials x 60 years in ${ms.toFixed(0)} ms = ${Math.round(1000 / (ms / 1000))} trials/s`,
      );
      expect(ms).toBeLessThan(20_000);
    });
  }

  it("1,000 trials of the synthetic sample household (two people, real assets, debts)", () => {
    const doc = createSampleDocument();
    const input = buildSimulationInput(doc, "plan-main", { trace: "off" });
    const settings = MonteCarloSettings.parse({ method: "block-bootstrap", trials: 1000, seed: 1 });
    const t0 = performance.now();
    const r = runMonteCarlo(input, settings, { keepTrials: false });
    const ms = performance.now() - t0;
    console.log(
      `[bench] sample household (${r.years!.length} years): 1000 trials in ${ms.toFixed(0)} ms = ${Math.round(1000 / (ms / 1000))} trials/s, success ${(r.successRate * 100).toFixed(1)}%`,
    );
    expect(ms).toBeLessThan(30_000);
  });
});
