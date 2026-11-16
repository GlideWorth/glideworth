/** Test helpers for workstream (d): synthetic inputs and a fake (but real-engine) Monte Carlo. */
import {
  createRng,
  type MarketPath,
  type MonteCarloResult,
  SimulationInput,
  type SimulationInputInput,
  simulate,
} from "../src/index.js";
import type { AccountInput } from "../src/schema/accounts.js";
import type { PlanInput } from "../src/schema/plan.js";

export const always = { start: { kind: "planStart" as const }, end: { kind: "planEnd" as const } };

/** Single person born 1980-01, plan from 2027-01 for `years`, zero tax/inflation/returns by default. */
export function makeInput(over: {
  accounts?: AccountInput[];
  plan?: Partial<PlanInput>;
  years?: number;
  country?: string;
  currency?: string;
  people?: SimulationInputInput["household"]["people"];
}): SimulationInput {
  const years = over.years ?? 20;
  const people = over.people ?? [{ id: "me", name: "Sam", role: "primary", birthMonth: "1980-01" }];
  return SimulationInput.parse({
    household: {
      id: "h",
      name: "Test",
      planningMode: people.length === 2 ? "couple" : "individual",
      people,
      location: { country: over.country ?? "XX" },
      currency: over.currency ?? "GBP",
      locale: "en-GB",
    },
    finances: { asOf: "2027-01", accounts: over.accounts ?? [] },
    plan: {
      id: "p",
      householdId: "h",
      name: "Test plan",
      tax: { mode: "flat", flat: { ordinary: 0, capitalGains: 0, dividends: 0, local: 0 } },
      ...over.plan,
      assumptions: {
        inflation: { kind: "fixed", rate: 0 },
        stockReturn: { kind: "fixed", rate: 0 },
        dividendYield: { kind: "fixed", rate: 0 },
        bondReturn: { kind: "fixed", rate: 0 },
        bondYield: { kind: "fixed", rate: 0 },
        cashReturn: { kind: "fixed", rate: 0 },
        end: { kind: "ref", ref: { kind: "date", date: `${2027 + years}-01` } },
        ...over.plan?.assumptions,
      },
    },
    options: { trace: "summary" },
  } satisfies SimulationInputInput);
}

export function expense(id: string, value: number, extra: Record<string, unknown> = {}) {
  return {
    id,
    type: "living" as const,
    name: id,
    owner: "me",
    amount: { value },
    frequency: "yearly" as const,
    range: always,
    ...extra,
  };
}

/**
 * A small Monte Carlo over the REAL engine: `trials` normal stock paths (seeded from the settings'
 * seed), success = no shortfall. Using the same seed for every candidate gives common random numbers.
 */
export function fakeMonteCarlo(
  opts: { trials?: number; mean?: number; sd?: number; calls?: { seed: number | null }[] } = {},
) {
  const trials = opts.trials ?? 100;
  return async (input: SimulationInput): Promise<MonteCarloResult> => {
    const seed = input.plan.monteCarlo.seed;
    opts.calls?.push({ seed });
    const rng = createRng(seed ?? 1);
    let ok = 0;
    const summaries: MonteCarloResult["trialSummaries"] = [];
    for (let t = 0; t < trials; t++) {
      const periods: MarketPath["periods"] = [];
      for (let y = 0; y < 80; y++)
        periods.push({
          stocks: (opts.mean ?? 0.04) + (opts.sd ?? 0.15) * rng.normal(),
          bonds: 0,
          cash: 0,
          inflation: 0,
          dividendYield: 0,
          bondYield: 0,
          crypto: 0,
        });
      const r = simulate({
        ...input,
        options: { ...input.options, market: { periods }, lean: true, trace: "off" },
      });
      if (r.summary.success) ok += 1;
      summaries.push({
        trial: t,
        seed,
        startYear: null,
        success: r.summary.success,
        firstShortfallYear: r.summary.firstShortfallYear,
        endNetWorthReal: r.summary.endNetWorthReal,
        outcomeCategoryId: r.summary.success ? "barely" : "failed-mid",
        milestones: {},
      });
    }
    return {
      method: "normal",
      trials,
      seed,
      successRate: ok / trials,
      outcomeCounts: {},
      percentiles: [],
      milestoneTiming: [],
      trialSummaries: summaries,
    };
  };
}
