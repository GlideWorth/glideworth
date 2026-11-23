/** Input-to-SimulationInput builders, Monte Carlo settings and determinism, and the worker protocol. */
import { describe, expect, it } from "vitest";
import { buildInput, HISTORY_DATASET, monteCarloSettings, START_YEAR } from "./engine/model";
import { simulatePlan } from "./engine/monte-carlo";
import { compareRules, constantRealSurvival } from "./engine/withdrawal";
import { runTool } from "./engine";
import { SPECS } from "./specs";
import { defaults } from "./state";
import type { Values } from "./types";
import { handle } from "./worker/handle";
import type { WorkerResponse } from "./worker/protocol";

describe("buildInput", () => {
  const input = buildInput({
    currency: "GBP",
    age: 40,
    years: 25,
    balance: 123_456,
    timing: "start",
    taxRate: 0.2,
    realReturn: 0.05,
    spending: [{ id: "spending", name: "Spending", amount: 30_000, from: 2, to: null }],
    income: [
      { id: "pay", name: "Pay", amount: 12_000, from: 0, to: 10 },
      { id: "nothing", name: "Zero", amount: 0, from: 0, to: null },
    ],
  });

  it("describes one person of the given age in a country with no tax preset", () => {
    expect(input.household.people).toHaveLength(1);
    expect(input.household.people[0]!.birthMonth).toBe(`${START_YEAR - 40}-01`);
    expect(input.household.location.country).toBe("XX");
    expect(input.household.currency).toBe("GBP");
    expect(input.finances.asOf).toBe(`${START_YEAR}-01`);
  });
  it("holds the balance in one generic tax-deferred account and saves surpluses into it", () => {
    expect(input.finances.accounts).toHaveLength(1);
    expect(input.finances.accounts[0]!.type).toBe("generic-tax-deferred");
    expect(input.finances.accounts[0]!.balance).toBe(123_456);
    expect(input.plan.leftover).toEqual({
      kind: "save",
      accountId: input.finances.accounts[0]!.id,
    });
  });
  it("uses the flat tax mode with the rate on ordinary income (withdrawals) only", () => {
    expect(input.plan.tax.mode).toBe("flat");
    expect(input.plan.tax.flat).toMatchObject({
      ordinary: 0.2,
      capitalGains: 0,
      dividends: 0,
      local: 0,
    });
  });
  it("works in today’s money: inflation 0, the real return as the portfolio return, no dividends", () => {
    const a = input.plan.assumptions;
    expect(a.inflation).toEqual({ kind: "fixed", rate: 0 });
    expect(a.stockReturn).toEqual({ kind: "fixed", rate: 0.05 });
    expect(a.dividendYield).toEqual({ kind: "fixed", rate: 0 });
    expect(a.bondAllocation.kind).toBe("none");
    expect(a.cashFlowTiming).toBe("start");
    expect(a.end).toEqual({
      kind: "ref",
      ref: { kind: "date", date: `${START_YEAR + 25}-01`, offsetMonths: 0 },
    });
  });
  it("turns windows into real, yearly, after-tax events; zero amounts are dropped", () => {
    expect(input.plan.income).toHaveLength(1);
    const pay = input.plan.income[0]!;
    expect(pay.amount).toEqual({ value: 12_000, basis: "real" });
    expect(pay.frequency).toBe("yearly");
    expect(pay.tax.character).toBe("tax-free");
    expect(pay.range.end).toEqual({ kind: "planStart", offsetMonths: 120 });
    const sp = input.plan.expenses[0]!;
    expect(sp.range.start).toEqual({ kind: "planStart", offsetMonths: 24 });
    expect(sp.range.end).toEqual({ kind: "planEnd", offsetMonths: 0 });
  });
  it("a stock share sets a fixed bond allocation for history runs", () => {
    const h = buildInput({
      currency: "USD",
      age: 60,
      years: 30,
      balance: 1,
      timing: "mid",
      taxRate: 0,
      realReturn: 0,
      stockShare: 0.6,
    });
    expect(h.plan.assumptions.bondAllocation).toMatchObject({ kind: "fixed", share: 0.4 });
  });
  it("a withdrawal rule becomes the plan’s withdrawal strategy from the start", () => {
    const w = buildInput({
      currency: "USD",
      age: 60,
      years: 30,
      balance: 1_000_000,
      timing: "mid",
      taxRate: 0,
      realReturn: 0.03,
      withdrawalStrategy: { rule: { kind: "fixed-percent", rate: 0.04 } },
    });
    expect(w.plan.withdrawalStrategy).toMatchObject({
      enabled: true,
      start: { kind: "planStart" },
      rule: { kind: "fixed-percent", rate: 0.04 },
    });
  });
});

describe("Monte Carlo settings", () => {
  it("history models use the us-1928 dataset", () => {
    expect(HISTORY_DATASET).toBe("us-1928");
    for (const kind of ["history", "block", "history-sequential"] as const)
      expect(monteCarloSettings({ kind }, 1000, 7).dataset).toBe("us-1928");
  });
  it("the random-returns model varies only the real return, log-normally", () => {
    const s = monteCarloSettings({ kind: "parametric", mean: 0.05, vol: 0.12 }, 500, 2026);
    expect(s).toMatchObject({
      method: "normal",
      distributionShape: "lognormal",
      trials: 500,
      seed: 2026,
      success: { kind: "all-funded" },
      vary: { stocks: true, bonds: false, inflation: false, dividends: false, crypto: false },
      distributions: { stocks: { mean: 0.05, stdDev: 0.12 } },
    });
  });
  it("no calculator source names the UK dataset", async () => {
    const { readFileSync, readdirSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");
    const walk = (d: string): string[] =>
      readdirSync(d).flatMap((n) =>
        statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)],
      );
    for (const dir of ["src/tools", "src/pages/tools", "src/components/tools"])
      for (const f of walk(join(import.meta.dirname, "../..", dir)).filter(
        (x) => /\.(ts|astro)$/.test(x) && !x.endsWith(".test.ts"),
      ))
        expect(readFileSync(f, "utf8"), f).not.toMatch(/uk-19\d\d|us-1871/);
  });
});

const mc: Values = { ...defaults(SPECS["monte-carlo"]), trials: "500" };

describe("determinism", () => {
  it("the same seed gives the same Monte Carlo result; another seed a different one", async () => {
    for (const method of ["history", "block", "parametric"]) {
      const a = await simulatePlan({ ...mc, method });
      const b = await simulatePlan({ ...mc, method });
      expect(a.seed).toBe(2026);
      expect(b.successRate).toBe(a.successRate);
      expect(b.percentiles).toEqual(a.percentiles);
      const c = await simulatePlan({ ...mc, method, seed: 7, spend: 55_000 });
      const d = await simulatePlan({ ...mc, method, seed: 8, spend: 55_000 });
      expect(c.trialSummaries.map((t) => t.endNetWorthReal)).not.toEqual(
        d.trialSummaries.map((t) => t.endNetWorthReal),
      );
    }
  });
  it("the withdrawal comparison is reproducible", async () => {
    const v = { ...defaults(SPECS.withdrawal), trials: "500" };
    expect(await compareRules(v)).toEqual(await compareRules(v));
  });
  it("the constant-real survival grid matches that comparison and does not rise with the rate or the horizon", async () => {
    const v = {
      ...defaults(SPECS.withdrawal),
      trials: "400",
      method: "parametric",
      mean: 5,
      vol: 12,
      timing: "start",
      tax: 0,
      seed: 2026,
      balance: 1_000_000,
      rate: 4,
      years: 30,
    };
    const [stats, same, grid, again] = await Promise.all([
      compareRules(v),
      constantRealSurvival(v, [4], [30]),
      constantRealSurvival(v, [3, 5], [30, 50]),
      constantRealSurvival(v, [3, 5], [30, 50]),
    ]);
    const constant = stats.find((s) => s.id === "constant")!;
    expect(same[0]!.lasted).toBeCloseTo(1 - constant.shortAny, 10);
    expect(same[0]!.medianEnd).toBeCloseTo(constant.medianEnd, 6);
    expect(same[0]!.preserved).toBeCloseTo(constant.preserved, 10);
    expect(again).toEqual(grid);
    const at = (rate: number, years: number) =>
      grid.find((c) => c.rate === rate && c.years === years)!.lasted;
    expect(at(5, 30)).toBeLessThanOrEqual(at(3, 30));
    expect(at(5, 50)).toBeLessThanOrEqual(at(3, 50));
    expect(at(3, 50)).toBeLessThanOrEqual(at(3, 30));
    expect(at(5, 50)).toBeLessThanOrEqual(at(5, 30));
    for (const c of grid) {
      expect(c.lasted).toBeGreaterThanOrEqual(0);
      expect(c.lasted).toBeLessThanOrEqual(1);
      expect(c.preserved).toBeGreaterThanOrEqual(0);
      expect(c.preserved).toBeLessThanOrEqual(1);
    }
  }, 60_000);
  it("the full view model is identical on a second run (what the static page shows is what the browser computes)", async () => {
    for (const spec of Object.values(SPECS)) {
      const v = { ...defaults(spec), ...(spec.mode === "simulation" ? { trials: "500" } : {}) };
      expect(await runTool(spec.id, v)).toEqual(await runTool(spec.id, v));
    }
  });
});

describe("Monte Carlo known answers", () => {
  it("4% from 1,000,000 for 30 years, log-normal 5% / 12%, start of year: close to the article’s 86.7%", async () => {
    const r = await simulatePlan({
      ...mc,
      method: "parametric",
      mean: 5,
      vol: 12,
      trials: "5000",
      timing: "start",
    });
    // The article's figure came from an independent script with other random numbers: allow 3 margins.
    expect(Math.abs(r.successRate - 0.867)).toBeLessThan(
      3 * 1.96 * Math.sqrt((0.867 * 0.133) / 5000),
    );
  });
  it("zero volatility reproduces the deterministic answer", async () => {
    const ok = await simulatePlan({
      ...mc,
      method: "parametric",
      mean: 4,
      vol: 0,
      spend: 30_000,
      balance: 500_000,
      years: 28,
      timing: "end",
    });
    const fail = await simulatePlan({
      ...mc,
      method: "parametric",
      mean: 4,
      vol: 0,
      spend: 30_000,
      balance: 500_000,
      years: 29,
      timing: "end",
    });
    expect(ok.successRate).toBe(1);
    expect(fail.successRate).toBe(0);
  });
});

describe("worker protocol", () => {
  it("reports progress, then a result", async () => {
    const out: WorkerResponse[] = [];
    await handle({ type: "run", id: 1, tool: "monte-carlo", values: mc }, (r) => out.push(r));
    const progress = out.filter((r) => r.type === "progress");
    expect(progress.length).toBeGreaterThan(0);
    const dones = progress.map((p) => (p.type === "progress" ? p.done : 0));
    expect([...dones].sort((a, b) => a - b)).toEqual(dones);
    expect(out.at(-1)?.type).toBe("result");
  });
  it("a cancel message stops a run midway", async () => {
    const out: WorkerResponse[] = [];
    let cancelled = false;
    const run = handle(
      { type: "run", id: 2, tool: "monte-carlo", values: { ...mc, trials: "10000" } },
      (r) => {
        out.push(r);
        if (r.type === "progress" && !cancelled) {
          cancelled = true;
          void handle({ type: "cancel", id: 2 }, () => {});
        }
      },
    );
    await run;
    expect(out.at(-1)?.type).toBe("cancelled");
    const last = out.findLast((r) => r.type === "progress");
    expect(last && last.type === "progress" && last.done < last.total).toBe(true);
  });
  it("reports an error instead of throwing", async () => {
    const out: WorkerResponse[] = [];
    await handle({ type: "run", id: 3, tool: "how-long", values: { balance: "x" } }, (r) =>
      out.push(r),
    );
    expect(out.at(-1)?.type).toBe("error");
  });
});
