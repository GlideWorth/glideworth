import { describe, expect, it } from "vitest";
import {
  createMonteCarloSession,
  createRng,
  deriveSeed,
  getTrialMarketPath,
  HISTORICAL_SERIES,
  MARKET_DATASETS,
  MonteCarloAbortedError,
  MonteCarloResult,
  MonteCarloSettings,
  type MonteCarloSettingsInput,
  mergeMonteCarloShards,
  runHistorical,
  runMonteCarlo,
  runMonteCarloAsync,
  runMonteCarloShard,
  runTrial,
  type SimulationInputInput,
  sampleMarketPath,
  simulate,
  summarizeMonteCarlo,
  ValidationError,
} from "../src/index.js";
import { always, scenario } from "./helpers.js";

/** Retiree: 1,000,000 in a taxable account (no gains), spending 40,000 a year in today's money. */
function retiree(
  opts: {
    years?: number;
    spend?: number;
    bondShare?: number;
    account?: Record<string, unknown>;
  } = {},
): SimulationInputInput {
  const base = scenario({
    years: opts.years ?? 30,
    inflation: 0.025,
    accounts: [
      {
        id: "pf",
        name: "Portfolio",
        type: "taxable",
        owner: "me",
        balance: 1_000_000,
        costBasis: 1_000_000,
        ...opts.account,
      } as never,
    ],
    plan: {
      expenses: [
        {
          id: "liv",
          type: "living",
          name: "Living",
          owner: "me",
          amount: { value: opts.spend ?? 40_000 },
          frequency: "yearly",
          range: always,
        },
      ],
      assumptions: {
        stockReturn: { kind: "fixed", rate: 0.05 },
        dividendYield: { kind: "fixed", rate: 0.02 },
        bondReturn: { kind: "fixed", rate: 0.01 },
        bondYield: { kind: "fixed", rate: 0.02 },
        cashReturn: { kind: "fixed", rate: 0.01 },
        bondAllocation: { kind: "fixed", share: opts.bondShare ?? 0.4 },
      },
    },
  });
  return { ...base, options: { trace: "off" } };
}

const mc = (over: MonteCarloSettingsInput = {}): MonteCarloSettings =>
  MonteCarloSettings.parse({ trials: 200, seed: 12345, ...over });

function stats(xs: number[]) {
  const n = xs.length;
  const mean = xs.reduce((s, x) => s + x, 0) / n;
  const variance = xs.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1);
  return { mean, sd: Math.sqrt(variance) };
}
function corr(a: number[], b: number[]) {
  const sa = stats(a);
  const sb = stats(b);
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i]! - sa.mean) * (b[i]! - sb.mean);
  return s / (a.length - 1) / (sa.sd * sb.sd);
}

describe("historical datasets", () => {
  it("has complete, aligned series with sane values", () => {
    for (const ds of Object.values(MARKET_DATASETS)) {
      const n = ds.lastYear - ds.firstYear + 1;
      for (const [k, series] of Object.entries(ds.series)) {
        expect(series, `${ds.id}.${k}`).toHaveLength(n);
        for (const v of series) if (v !== null) expect(Math.abs(v)).toBeLessThan(1.5);
      }
      for (const v of ds.series.dividendYield) expect(v).toBeGreaterThanOrEqual(0);
    }
    expect(MARKET_DATASETS["us-1928"].firstYear).toBe(1928);
    expect(MARKET_DATASETS["us-1928"].lastYear).toBe(2025);
    // Bundled: only the openly licensed sets (uk-1871 JST and us-1871 Shiller were removed).
    expect(Object.keys(MARKET_DATASETS).sort()).toEqual(["uk-1983", "us-1928"]);
    expect(MARKET_DATASETS["uk-1983"].firstYear).toBe(1983);
    expect(MARKET_DATASETS["uk-1983"].lastYear).toBeGreaterThanOrEqual(2025);
  });

  it("matches published spot values (Damodaran S&P 500 total return, BLS CPI-U)", () => {
    const ds = MARKET_DATASETS["us-1928"];
    const at = (y: number) => y - ds.firstYear;
    const total = (y: number) => ds.series.stocks[at(y)]! + ds.series.dividendYield[at(y)]!;
    expect(total(1931)).toBeCloseTo(-0.4384, 3);
    expect(total(2008)).toBeCloseTo(-0.3655, 3);
    expect(total(2025)).toBeCloseTo(0.1772, 3);
    expect(ds.series.bonds[at(2008)]! + ds.series.bondYield[at(2008)]!).toBeCloseTo(0.201, 3);
    expect(ds.series.inflation[at(1946)]).toBeCloseTo(0.181, 2); // Dec-Dec CPI-U
    expect(ds.series.cash[at(1981)]).toBeGreaterThan(0.1);
    // Every us-1928 year has a bill rate (the deterministic sequences rely on it).
    expect(ds.series.cash.every((v) => typeof v === "number")).toBe(true);
  });

  it("exposes the engine HistoricalDataset contract", () => {
    // Deterministic sequences read the bundled us-1928 (they read us-1871 before it was unbundled).
    expect(HISTORICAL_SERIES.range("us-stocks")).toEqual({ first: 1928, last: 2025 });
    expect(HISTORICAL_SERIES.range("us-cash")).toEqual({ first: 1928, last: 2025 });
    expect(HISTORICAL_SERIES.range("crypto")).toBeNull();
    expect(HISTORICAL_SERIES.value("us-inflation", 1928)).toBe(
      MARKET_DATASETS["us-1928"].series.inflation[0],
    );
    expect(HISTORICAL_SERIES.value("us-stocks", 1900)).toBeUndefined();
  });
});

describe("samplers", () => {
  it("normal: sampled means, std-devs and correlations converge to the configured values", () => {
    const s = mc({
      method: "normal",
      distributions: {
        stocks: { mean: 0.06, stdDev: 0.18 },
        bonds: { mean: 0.02, stdDev: 0.06 },
        inflation: { mean: 0.025, stdDev: 0.015 },
        dividends: { mean: 0.02, stdDev: 0.004 },
        crypto: { mean: 0.05, stdDev: 0.1 },
        correlation: { stocksBonds: 0.3, stocksInflation: -0.2, bondsInflation: -0.4 },
      },
    });
    const path = sampleMarketPath(s, 40_000, createRng(7), 0).periods;
    const st = path.map((p) => p.stocks);
    const bo = path.map((p) => p.bonds);
    const inf = path.map((p) => p.inflation);
    expect(stats(st).mean).toBeCloseTo(0.06, 2);
    expect(stats(st).sd).toBeCloseTo(0.18, 2);
    expect(stats(bo).sd).toBeCloseTo(0.06, 2);
    expect(stats(inf).mean).toBeCloseTo(0.025, 3);
    expect(corr(st, bo)).toBeCloseTo(0.3, 1);
    expect(corr(st, inf)).toBeCloseTo(-0.2, 1);
    expect(corr(bo, inf)).toBeCloseTo(-0.4, 1);
    expect(Math.min(...path.map((p) => p.dividendYield))).toBeGreaterThanOrEqual(0);
    expect(path.every((p) => p.bondYield === 0.03 && p.cash === 0.01)).toBe(true); // plan defaults
  });

  it("log-normal: arithmetic mean and std-dev match, returns never below -100%", () => {
    const s = mc({
      method: "normal",
      distributionShape: "lognormal",
      distributions: { stocks: { mean: 0.07, stdDev: 0.2 }, crypto: { mean: 0.1, stdDev: 0.9 } },
    });
    const path = sampleMarketPath(s, 60_000, createRng(3), 0).periods;
    expect(stats(path.map((p) => p.stocks)).mean).toBeCloseTo(0.07, 2);
    expect(stats(path.map((p) => p.stocks)).sd).toBeCloseTo(0.2, 2);
    expect(Math.min(...path.map((p) => p.crypto))).toBeGreaterThan(-1);
  });

  it("fat tails keep the std-dev and correlation but raise kurtosis", () => {
    const s = mc({
      method: "normal",
      fatTails: { degreesOfFreedom: 5 },
      distributions: { stocks: { mean: 0, stdDev: 0.1 }, correlation: { stocksBonds: 0.5 } },
    });
    const path = sampleMarketPath(s, 80_000, createRng(11), 0).periods;
    const st = path.map((p) => p.stocks);
    const { mean, sd } = stats(st);
    expect(sd).toBeCloseTo(0.1, 2);
    const kurt = st.reduce((acc, x) => acc + ((x - mean) / sd) ** 4, 0) / st.length;
    expect(kurt).toBeGreaterThan(4.5); // normal = 3, t(5) = 9
    expect(
      corr(
        st,
        path.map((p) => p.bonds),
      ),
    ).toBeCloseTo(0.5, 1);
  });

  it("rejects an impossible correlation matrix", () => {
    const s = mc({
      method: "normal",
      distributions: {
        correlation: { stocksBonds: 0.9, stocksInflation: 0.9, bondsInflation: -0.9 },
      },
    });
    expect(() => sampleMarketPath(s, 1, createRng(1), 0)).toThrow(ValidationError);
  });

  it("vary flags hold series at the base rates without reshuffling the others", () => {
    const all = sampleMarketPath(mc({ method: "normal" }), 50, createRng(5), 0).periods;
    const noInfl = sampleMarketPath(
      mc({ method: "normal", vary: { inflation: false } }),
      50,
      createRng(5),
      0,
    ).periods;
    expect(noInfl.every((p) => p.inflation === 0.03)).toBe(true);
    expect(noInfl.map((p) => p.stocks)).toEqual(all.map((p) => p.stocks));
  });

  it("historical-sequential: one trial per start year, consecutive years, no looping", () => {
    const s = mc({ method: "historical-sequential", dataset: "us-1928" });
    const ds = MARKET_DATASETS["us-1928"];
    const p = sampleMarketPath(s, 30, createRng(1), 5).periods;
    expect(p.map((x) => x.sourceYear)).toEqual(Array.from({ length: 30 }, (_, i) => 1933 + i));
    expect(p[0]!.stocks).toBe(ds.series.stocks[5]);
    expect(p[0]!.inflation).toBe(ds.series.inflation[5]);
    expect(() => sampleMarketPath(s, 30, createRng(1), 90)).toThrow(/no looping/);
  });

  it("historical-random-restart only jumps after the data runs out", () => {
    const s = mc({ method: "historical-random-restart", dataset: "uk-1983" });
    const ds = MARKET_DATASETS["uk-1983"];
    for (let t = 0; t < 50; t++) {
      const years = sampleMarketPath(s, 100, createRng(deriveSeed(9, t)), t).periods.map(
        (x) => x.sourceYear!,
      );
      for (let i = 1; i < years.length; i++)
        if (years[i] !== years[i - 1]! + 1) expect(years[i - 1]).toBe(ds.lastYear);
    }
  });

  it("block bootstrap stitches whole blocks of consecutive years", () => {
    const s = mc({ method: "block-bootstrap", blockLength: 7, dataset: "us-1928" });
    for (let t = 0; t < 30; t++) {
      const years = sampleMarketPath(s, 63, createRng(deriveSeed(2, t)), t).periods.map(
        (x) => x.sourceYear!,
      );
      for (let b = 0; b < 9; b++) {
        const block = years.slice(b * 7, b * 7 + 7);
        expect(block).toEqual(Array.from({ length: 7 }, (_, i) => block[0]! + i));
      }
    }
  });
});

describe("runMonteCarlo", () => {
  it("zero-variance Monte Carlo equals the deterministic projection (known answer)", () => {
    const input = retiree({ spend: 70_000 });
    const det = simulate(input);
    const s = mc({
      method: "normal",
      trials: 5,
      distributions: {
        stocks: { mean: 0.05, stdDev: 0 },
        bonds: { mean: 0.01, stdDev: 0 },
        inflation: { mean: 0.025, stdDev: 0 },
        dividends: { mean: 0.02, stdDev: 0 },
        crypto: { mean: 0.07, stdDev: 0 },
      },
    });
    const r = runMonteCarlo(input, s);
    expect(r.trials).toBe(5);
    expect(r.successRate).toBe(det.summary.success ? 1 : 0);
    expect(det.summary.success).toBe(false); // 7% withdrawal fails within 30 years
    const nw = r.percentiles.find((x) => x.metric === "netWorth")!;
    const nwNom = r.percentilesNominal!.find((x) => x.metric === "netWorth")!;
    det.periods.forEach((p, i) => {
      for (const b of nw.bands)
        expect(b.values[i]).toBeCloseTo(p.totals.netWorth / p.priceIndex, 6);
      for (const b of nwNom.bands) expect(b.values[i]).toBeCloseTo(p.totals.netWorth, 6);
    });
    expect(r.trialSummaries[0]!.firstShortfallYear).toBe(det.summary.firstShortfallYear);
    expect(r.trialSummaries[0]!.endNetWorthReal).toBeCloseTo(det.summary.endNetWorthReal, 6);
    expect(r.failureYearHistogram).toEqual([{ year: det.summary.firstShortfallYear, count: 5 }]);
    expect(r.deterministic?.success).toBe(false);
  });

  it("same seed gives identical results; a different seed differs", () => {
    const input = retiree();
    const a = runMonteCarlo(input, mc({ method: "normal", trials: 60 }));
    const b = runMonteCarlo(input, mc({ method: "normal", trials: 60 }));
    const c = runMonteCarlo(input, mc({ method: "normal", trials: 60, seed: 999 }));
    expect(b).toEqual(a);
    expect(c.percentiles).not.toEqual(a.percentiles);
  });

  it("chunked shards merged in any order equal a single run, for every method", () => {
    const input = retiree();
    const methods: MonteCarloSettingsInput[] = [
      { method: "normal", trials: 50, fatTails: { degreesOfFreedom: 6 } },
      { method: "historical-random-restart", trials: 50 },
      { method: "block-bootstrap", trials: 50, blockLength: 4 },
      { method: "historical-sequential", dataset: "us-1928" },
    ];
    for (const m of methods) {
      const s = mc(m);
      const single = runMonteCarlo(input, s);
      const total = single.trials;
      const cuts = [0, 7, Math.floor(total / 2), total - 3, total];
      const shards = cuts
        .slice(1)
        .map((to, i) =>
          runMonteCarloShard(input, s, { trialOffset: cuts[i]!, trialCount: to - cuts[i]! }),
        );
      const merged = summarizeMonteCarlo(mergeMonteCarloShards(shards.reverse()), s);
      expect(merged).toEqual(single);
    }
  });

  it("refuses to merge shards from different runs or overlapping trials", () => {
    const input = retiree();
    const a = runMonteCarloShard(input, mc({ method: "normal", trials: 10 }), { trialCount: 5 });
    const b = runMonteCarloShard(input, mc({ method: "normal", trials: 10, seed: 1 }), {
      trialOffset: 5,
    });
    expect(() => mergeMonteCarloShards([a, b])).toThrow(/different runs/);
    expect(() => mergeMonteCarloShards([a, a])).toThrow(/more than one shard/);
  });

  it("streams partial results, reports progress and cancels", async () => {
    const input = retiree();
    const s = mc({ method: "normal", trials: 40 });
    const partials: number[] = [];
    let progress = 0;
    const full = runMonteCarlo(input, s, {
      partialEvery: 10,
      onPartial: (r) => partials.push(r.trials),
      onProgress: (done) => {
        progress = done;
      },
    });
    expect(partials).toEqual([10, 20, 30]);
    expect(progress).toBe(40);
    expect(full.partial).toBe(false);

    const session = createMonteCarloSession(input, s);
    session.step(15);
    const part = session.result();
    expect(part.partial).toBe(true);
    expect(part.trials).toBe(15);
    expect(part.totalTrials).toBe(40);
    session.step();
    expect(session.result()).toEqual(full);

    const ctl = new AbortController();
    expect(() =>
      runMonteCarlo(input, s, {
        signal: ctl.signal,
        onProgress: (d) => (d === 5 ? ctl.abort() : undefined),
      }),
    ).toThrow(MonteCarloAbortedError);

    const asyncParts: number[] = [];
    const viaAsync = await runMonteCarloAsync(input, s, {
      chunkSize: 16,
      onPartial: (r) => asyncParts.push(r.trials),
    });
    expect(asyncParts).toEqual([16, 32]);
    expect(viaAsync).toEqual(full);
    const ctl2 = new AbortController();
    await expect(
      runMonteCarloAsync(input, s, {
        chunkSize: 5,
        signal: ctl2.signal,
        onPartial: () => ctl2.abort(),
      }),
    ).rejects.toBeInstanceOf(MonteCarloAbortedError);
  });

  it("applies every success definition and the outcome categories", () => {
    const input = retiree({ spend: 55_000 });
    const run = (success: MonteCarloSettingsInput["success"]) =>
      runMonteCarlo(input, mc({ method: "historical-sequential", dataset: "us-1928", success }));
    const funded = run({ kind: "all-funded" });
    const depleted = run({ kind: "never-depleted" });
    const floor = run({ kind: "liquid-floor", floor: 200_000 });
    const end = run({ kind: "end-floor", floor: 500_000 });
    expect(funded.successRate).toBeGreaterThan(0);
    expect(funded.successRate).toBeLessThan(1);
    expect(floor.successRate).toBeLessThanOrEqual(depleted.successRate);
    expect(end.successRate).toBeLessThanOrEqual(funded.successRate);
    for (const r of [funded, depleted, floor, end]) {
      const counts = Object.values(r.outcomeCounts).reduce((a, b) => a + b, 0);
      expect(counts).toBe(r.trials);
      const okCats = ["large-surplus", "comfortable", "barely"];
      const okCount = okCats.reduce((a, k) => a + (r.outcomeCounts[k] ?? 0), 0);
      expect(okCount).toBe(Math.round(r.successRate * r.trials));
      expect(r.failureYearHistogram!.reduce((a, b) => a + b.count, 0)).toBe(r.trials - okCount);
    }
    for (const t of funded.trialSummaries) {
      expect(t.success).toBe(t.failureYear === null);
      if (!t.success)
        expect(["almost", "failed-mid", "failed-early"]).toContain(t.outcomeCategoryId);
      expect(t.fundedShare).toBeGreaterThan(0);
      expect(t.fundedShare).toBeLessThanOrEqual(1);
    }
  });

  it("results satisfy the published MonteCarloResult schema (API/OpenAPI contract)", () => {
    const r = runMonteCarlo(
      retiree(),
      mc({ method: "historical-random-restart", trials: 30, splitAtMilestoneId: undefined }),
    );
    expect(() => MonteCarloResult.parse(r)).not.toThrow();
    expect(JSON.parse(JSON.stringify(r))).toEqual(r);
    // A session created only to read the trial count does no work.
    const session = createMonteCarloSession(retiree(), mc({ method: "historical-sequential" }), {
      trialCount: 0,
    });
    expect(session.total).toBe(69);
    expect(session.shard().trialIndex).toEqual([]);
  });

  it("percentile bands are ordered and cover every engine total", () => {
    const r = runMonteCarlo(retiree(), mc({ method: "block-bootstrap", trials: 100 }));
    expect(r.percentiles).toHaveLength(17);
    for (const series of [...r.percentiles, ...r.percentilesNominal!])
      for (let y = 0; y < series.years.length; y++)
        for (let b = 1; b < series.bands.length; b++)
          expect(series.bands[b]!.values[y]!).toBeGreaterThanOrEqual(
            series.bands[b - 1]!.values[y]! - 1e-9,
          );
    const rep = r.representativeTrials!;
    expect(rep.worst.endNetWorthReal).toBeLessThanOrEqual(rep.median.endNetWorthReal);
    expect(rep.median.endNetWorthReal).toBeLessThanOrEqual(rep.best.endNetWorthReal);
  });

  it("representative trials can be re-run in full and reproduce their summary", () => {
    const input = retiree();
    const s = mc({ method: "historical-random-restart", trials: 40 });
    const r = runMonteCarlo(input, s);
    const worst = r.representativeTrials!.worst;
    const full = runTrial(input, s, worst.trial);
    const last = full.result.periods.at(-1)!;
    expect(last.totals.netWorth / last.priceIndex).toBeCloseTo(worst.endNetWorthReal, 6);
    expect(full.result.periods[0]!.accounts.length).toBeGreaterThan(0); // not lean
    expect(getTrialMarketPath(input, s, worst.trial)).toEqual(full.market);
  });

  it("milestone timing: reach probability, percentiles and cumulative share", () => {
    const input = retiree({ spend: 30_000 });
    (input.plan as { milestones?: unknown[] }).milestones = [
      {
        id: "ms-2m",
        name: "Two million",
        kind: "custom",
        criteria: [
          {
            kind: "metric",
            metric: { kind: "netWorth" },
            comparator: ">=",
            threshold: { kind: "amount", amount: { value: 2_000_000 } },
          },
        ],
      },
    ];
    const s = mc({
      method: "historical-sequential",
      dataset: "us-1928",
      splitAtMilestoneId: "ms-2m",
    });
    const r = runMonteCarlo(input, s);
    const t = r.milestoneTiming.find((m) => m.milestoneId === "ms-2m")!;
    expect(t.reachedShare).toBeGreaterThan(0);
    expect(t.reachedShare).toBeLessThan(1);
    const cum = t.cumulativeShare!;
    for (let i = 1; i < cum.length; i++) expect(cum[i]!).toBeGreaterThanOrEqual(cum[i - 1]!);
    expect(cum.at(-1)).toBeCloseTo(t.reachedShare, 9);
    const months = t.percentiles.map((p) => p.month!).filter(Boolean);
    expect([...months].sort()).toEqual(months);
    expect(r.split?.reachedShare).toBeCloseTo(t.reachedShare, 9);
    expect(r.split!.netWorthAt[3]!.value).toBeGreaterThan(1_500_000);
  });

  it("sequence-of-returns view: poor early returns fail more often", () => {
    const r = runMonteCarlo(
      retiree({ spend: 50_000 }),
      mc({ method: "historical-sequential", dataset: "us-1928" }),
    );
    const sr = r.sequenceRisk!;
    expect(sr.anchor).toBe("planStart");
    expect(sr.buckets).toHaveLength(5);
    expect(sr.buckets[0]!.successRate).toBeLessThan(sr.buckets[4]!.successRate);
    expect(sr.rankCorrelation!).toBeGreaterThan(0.2);
  });

  it("accounts with Fixed treatment keep the plan's rates in every trial", () => {
    const input = retiree({ bondShare: 0, account: { behaviour: { monteCarlo: "fixed" } } });
    // Year-end flows so growth is exactly opening x rate (no timing adjustment).
    input.plan.assumptions!.cashFlowTiming = "end";
    const s = mc({ method: "historical-random-restart", trials: 3 });
    for (let t = 0; t < 3; t++) {
      const { result } = runTrial(input, s, t);
      const a = result.periods[0]!.accounts[0]!;
      expect(a.growth).toBeCloseTo(a.opening * 0.05, 6);
      expect(a.dividends).toBeCloseTo(a.opening * 0.02, 6);
    }
    // A custom override pins explicit rates.
    const pinned = retiree({ bondShare: 0 });
    pinned.plan.assumptions!.cashFlowTiming = "end";
    const { result } = runTrial(pinned, s, 0, {
      accountOverrides: { pf: { growth: 0.03, dividendYield: 0.01 } },
    });
    const a = result.periods[0]!.accounts[0]!;
    expect(a.growth).toBeCloseTo(a.opening * 0.03, 6);
    expect(a.dividends).toBeCloseTo(a.opening * 0.01, 6);
  });

  it("historical-sequential: trial count fixed by the data; startYears restricts it", () => {
    const input = retiree({ years: 30 });
    const r = runHistorical(input, { dataset: "us-1928" });
    expect(r.method).toBe("historical-sequential");
    expect(r.trials).toBe(98 - 30 + 1);
    expect(r.trialSummaries.map((t) => t.startYear)).toEqual(
      Array.from({ length: 69 }, (_, i) => 1928 + i),
    );
    const some = runHistorical(input, { dataset: "us-1928", startYears: [1929, 1966, 1990] });
    expect(some.trialSummaries.map((t) => t.startYear)).toEqual([1929, 1966, 1990]);
    expect(() => runHistorical(input, { dataset: "us-1928", startYears: [2000] })).toThrow(
      /no looping/,
    );
    expect(() => runHistorical(retiree({ years: 120 }), { dataset: "us-1928" })).toThrow(
      /needs 100 years/,
    );
  });

  it("4% rule, 30 years, 60/40 on us-1928, compared with FIRECalc (96.8% on 1871 data)", () => {
    // FIRECalc (firecalc.com, 1871 start, CPI, long-interest bonds, 0% fees, 60% equity,
    // $1M, $40k/yr, 30 years) reports 4 of 126 cycles failing: 96.8% (queried 2026-11-15). The engine
    // used to be checked on Shiller's 1871 data (126 cycles, the same as FIRECalc). That data is no
    // longer bundled (no licence), so this runs on us-1928: 69 cycles, starting 1928-1996. FIRECalc's
    // 57 cycles that start before 1928 all succeed, so dropping them raises the failure SHARE while
    // the failures themselves (the mid-1960s starts) stay. Compare like with like: the failure count,
    // and the rate with the 57 pre-1928 successes added back.
    // FIRECalc withdraws at the start of each year; the engine pays expenses at period end. Emulate
    // start-of-year withdrawals by paying the first year up front (960k) and running 29 years.
    const startOfYear = runHistorical(
      retiree({
        years: 29,
        spend: 40_000,
        bondShare: 0.4,
        account: { balance: 960_000, costBasis: 960_000 },
      }),
      { dataset: "us-1928" },
    );
    const failed = startOfYear.trialSummaries.filter((t) => !t.success).map((t) => t.startYear!);
    console.info(
      `us-1928 start-of-year 4%: ${(startOfYear.successRate * 100).toFixed(1)}% of ${startOfYear.trials}, failing ${failed.join(",")}`,
    );
    expect(startOfYear.trials).toBe(98 - 29 + 1);
    expect(failed.length).toBeGreaterThanOrEqual(3);
    expect(failed.length).toBeLessThanOrEqual(6);
    for (const y of failed) expect(y >= 1960 && y <= 1970, String(y)).toBe(true);
    const withPre1928 = (startOfYear.trials - failed.length + 57) / 126;
    expect(Math.abs(withPre1928 - 0.968)).toBeLessThanOrEqual(0.02);
    const asIs = runHistorical(retiree({ years: 30, spend: 40_000, bondShare: 0.4 }), {
      dataset: "us-1928",
      keepTrials: false,
    });
    expect(asIs.trials).toBe(98 - 30 + 1);
    expect(asIs.successRate).toBeGreaterThanOrEqual(startOfYear.successRate);
    // UK 1983-2025 has only 14 thirty-year windows, all starting 1983-1996, the best start years
    // in modern history: every one survives. (The withdrawn 1871 UK history failed 1900s and 1930s
    // starts.) This is why GB plans do not default to it (defaults/country.ts).
    const uk = runHistorical(retiree({ years: 30, spend: 40_000, bondShare: 0.4 }), {
      dataset: "uk-1983",
    });
    console.info(`uk-1983 4%: ${(uk.successRate * 100).toFixed(1)}% of ${uk.trials}`);
    expect(uk.trials).toBe(MARKET_DATASETS["uk-1983"].lastYear - 1983 - 30 + 2);
    expect(uk.successRate).toBe(1);
  });
});
