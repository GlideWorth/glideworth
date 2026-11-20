/** Summary statistics over a shard, and shard merging. Pure functions of the raw trial data. */
import { formatMonth, parseMonth, totalsMeasure } from "../engine/index.js";
import { ScenarioError, ValidationError } from "../errors.js";
import type { MonteCarloSettings } from "../schema/montecarlo.js";
import { datasetReplacedWarnings } from "./data/index.js";
import { correlation, nearestRankSorted, percentileSorted, ranks } from "./math.js";
import {
  type MilestoneTiming,
  type MonteCarloResult,
  type MonteCarloShard,
  type PercentileSeries,
  RATIO_METRICS,
  type SequenceRisk,
  type SplitStatistics,
  type TrialSummary,
} from "./types.js";

export interface SummarizeOptions {
  keepTrials?: boolean;
  partial?: boolean;
}

/**
 * Merge shards (from workers, in any order) into one shard holding all their trials in trial order.
 * Summarising the merged shard gives exactly the result of running those trials in one go.
 */
export function mergeMonteCarloShards(shards: readonly MonteCarloShard[]): MonteCarloShard {
  const first = shards[0];
  if (!first) throw new ValidationError("mergeMonteCarloShards needs at least one shard");
  for (const s of shards)
    if (s.kind !== "glideworth.monteCarloShard" || s.fingerprint !== first.fingerprint)
      throw new ValidationError("shards come from different runs (settings, seed or plan differ)", {
        expected: first.fingerprint,
        got: s.fingerprint,
      });
  const M = first.metrics.length;
  const Y = first.years.length;
  const order: { shard: MonteCarloShard; local: number; trial: number }[] = [];
  for (const shard of shards)
    shard.trialIndex.forEach((trial, local) => {
      order.push({ shard, local, trial });
    });
  order.sort((a, b) => a.trial - b.trial);
  for (let i = 1; i < order.length; i++)
    if (order[i]!.trial === order[i - 1]!.trial)
      throw new ValidationError(`trial ${order[i]!.trial} appears in more than one shard`);
  const n = order.length;
  const values = new Float64Array(n * M * Y);
  const priceIndex = new Float64Array(n * Y);
  const hasStart = shards.every((s) => s.priceIndexStart !== undefined);
  const priceIndexStart = hasStart ? new Float64Array(n * Y) : undefined;
  const failureIndex = new Int32Array(n);
  const summaries: TrialSummary[] = new Array(n);
  order.forEach(({ shard, local }, i) => {
    values.set(shard.values.subarray(local * M * Y, (local + 1) * M * Y), i * M * Y);
    priceIndex.set(shard.priceIndex.subarray(local * Y, (local + 1) * Y), i * Y);
    if (priceIndexStart && shard.priceIndexStart)
      priceIndexStart.set(shard.priceIndexStart.subarray(local * Y, (local + 1) * Y), i * Y);
    failureIndex[i] = shard.failureIndex[local]!;
    summaries[i] = shard.summaries[local]!;
  });
  return {
    ...first,
    trialIndex: order.map((o) => o.trial),
    values,
    priceIndex,
    ...(priceIndexStart ? { priceIndexStart } : {}),
    failureIndex,
    summaries,
  };
}

/** Compute the full `MonteCarloResult` from raw trial data. */
export function summarizeMonteCarlo(
  shard: MonteCarloShard,
  settings: MonteCarloSettings,
  options: SummarizeOptions = {},
): MonteCarloResult {
  const n = shard.trialIndex.length;
  const M = shard.metrics.length;
  const Y = shard.years.length;
  const ps = settings.percentiles;
  const summaries = shard.summaries;

  let successes = 0;
  const outcomeCounts: Record<string, number> = Object.create(null);
  for (const c of settings.outcomeCategories) outcomeCounts[c.id] = 0;
  for (const s of summaries) {
    if (s.success) successes++;
    outcomeCounts[s.outcomeCategoryId] = (outcomeCounts[s.outcomeCategoryId] ?? 0) + 1;
  }

  // Percentile bands per metric and year, real and nominal.
  const percentiles: PercentileSeries[] = [];
  const percentilesNominal: PercentileSeries[] = [];
  const col = new Float64Array(n);
  const band = (basis: "real" | "nominal", m: number) => {
    const bands = ps.map((p) => ({ p, values: new Array<number>(Y) }));
    const mean = new Array<number | null>(Y);
    const ratio = RATIO_METRICS.has(shard.metrics[m]!);
    // Today's money: flows (income, spending, taxes...) by the start-of-period index, stocks by the
    // end-of-period index (engine/types.ts `toBasis`).
    const pis =
      totalsMeasure(shard.metrics[m]!) === "flow" && shard.priceIndexStart
        ? shard.priceIndexStart
        : shard.priceIndex;
    for (let y = 0; y < Y; y++) {
      let k = 0;
      let sum = 0;
      for (let t = 0; t < n; t++) {
        let v = shard.values[(t * M + m) * Y + y]!;
        if (Number.isNaN(v)) continue;
        if (basis === "real" && !ratio) v /= pis[t * Y + y]!;
        col[k++] = v;
        sum += v;
      }
      const sorted = col.subarray(0, k).sort();
      for (const b of bands) b.values[y] = k ? percentileSorted(sorted, b.p) : 0;
      mean[y] = k ? sum / k : null;
    }
    return { metric: shard.metrics[m]!, years: shard.years, bands, basis, mean };
  };
  for (let m = 0; m < M; m++) {
    const real = band("real", m);
    percentiles.push(real);
    percentilesNominal.push(
      RATIO_METRICS.has(shard.metrics[m]!) ? { ...real, basis: "nominal" } : band("nominal", m),
    );
  }

  // Failure-year histogram.
  const failCounts = new Map<number, number>();
  for (let t = 0; t < n; t++) {
    const f = shard.failureIndex[t]!;
    if (f >= 0) failCounts.set(f, (failCounts.get(f) ?? 0) + 1);
  }
  const replaced = datasetReplacedWarnings(settings);
  const failureYearHistogram = [...failCounts.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([y, count]) => ({ year: shard.years[y]!, count }));

  return {
    method: shard.method,
    trials: n,
    seed: shard.seed,
    successRate: n ? successes / n : 0,
    outcomeCounts,
    percentiles,
    milestoneTiming: milestoneTiming(shard, ps),
    trialSummaries: options.keepTrials === false ? [] : summaries,
    totalTrials: shard.totalTrials,
    partial: options.partial ?? n < shard.totalTrials,
    dataset: shard.dataset,
    successDefinition: settings.success,
    years: shard.years,
    ages: shard.ages,
    percentilesNominal,
    failureYearHistogram,
    sequenceRisk: sequenceRisk(shard),
    representativeTrials: representative(summaries, shard.failureIndex),
    split: settings.splitAtMilestoneId ? splitStats(shard, settings.splitAtMilestoneId, ps) : null,
    deterministic: shard.deterministic,
    ...(replaced.length ? { warnings: replaced } : {}),
  };
}

function milestoneTiming(shard: MonteCarloShard, ps: readonly number[]): MilestoneTiming[] {
  const n = shard.summaries.length;
  const Y = shard.years.length;
  return shard.milestones.map(({ id, name }) => {
    const months: number[] = [];
    for (const s of shard.summaries) {
      const m = s.milestones[id];
      if (m) months.push(parseMonth(m));
    }
    months.sort((a, b) => a - b);
    const cumulativeShare = new Array<number>(Y);
    let k = 0;
    for (let y = 0; y < Y; y++) {
      const end = shard.periodStarts[y + 1]!;
      while (k < months.length && months[k]! < end) k++;
      cumulativeShare[y] = n ? k / n : 0;
    }
    return {
      milestoneId: id,
      name,
      reachedShare: n ? months.length / n : 0,
      percentiles: ps.map((p) => {
        const m = nearestRankSorted(months, p);
        return { p, month: m === undefined ? null : formatMonth(m) };
      }),
      cumulativeShare,
    };
  });
}

function representative(
  summaries: readonly TrialSummary[],
  failureIndex: Int32Array,
): MonteCarloResult["representativeTrials"] {
  if (summaries.length === 0) return null;
  const idx = summaries.map((_, i) => i);
  // Ascending by ending real net worth; ties: earlier failure is worse, then trial number.
  idx.sort((a, b) => {
    const d = summaries[a]!.endNetWorthReal - summaries[b]!.endNetWorthReal;
    if (d !== 0) return d;
    const fa = failureIndex[a]! < 0 ? Number.POSITIVE_INFINITY : failureIndex[a]!;
    const fb = failureIndex[b]! < 0 ? Number.POSITIVE_INFINITY : failureIndex[b]!;
    return fa - fb || summaries[a]!.trial - summaries[b]!.trial;
  });
  const pick = (p: number) => {
    const s = summaries[idx[Math.round(p * (idx.length - 1))]!]!;
    return { trial: s.trial, endNetWorthReal: s.endNetWorthReal, success: s.success };
  };
  return { worst: pick(0), p10: pick(0.1), median: pick(0.5), p90: pick(0.9), best: pick(1) };
}

function sequenceRisk(shard: MonteCarloShard): SequenceRisk | null {
  const rows = shard.summaries
    .filter((s) => typeof s.earlyRealReturn === "number")
    .map((s) => ({
      r: s.earlyRealReturn as number,
      ok: s.success,
      end: s.endNetWorthReal,
      trial: s.trial,
    }));
  if (rows.length === 0) return null;
  rows.sort((a, b) => a.r - b.r || a.trial - b.trial);
  const B = Math.min(5, rows.length);
  const buckets = [];
  for (let b = 0; b < B; b++) {
    const slice = rows.slice(
      Math.floor((b * rows.length) / B),
      Math.floor(((b + 1) * rows.length) / B),
    );
    const ends = slice.map((x) => x.end).sort((a, c) => a - c);
    buckets.push({
      fromReturn: slice[0]!.r,
      toReturn: slice[slice.length - 1]!.r,
      trials: slice.length,
      successRate: slice.filter((x) => x.ok).length / slice.length,
      medianEndNetWorthReal: percentileSorted(ends, 0.5),
    });
  }
  return {
    ...shard.sequenceRisk,
    buckets,
    rankCorrelation: correlation(
      ranks(rows.map((x) => x.r)),
      ranks(rows.map((x) => (x.ok ? 1 : 0))),
    ),
  };
}

function splitStats(
  shard: MonteCarloShard,
  milestoneId: string,
  ps: readonly number[],
): SplitStatistics | null {
  const ms = shard.milestones.find((m) => m.id === milestoneId);
  if (!ms)
    throw new ScenarioError(`splitAtMilestoneId '${milestoneId}' is not an enabled milestone`);
  const M = shard.metrics.length;
  const Y = shard.years.length;
  const nwIdx = shard.metrics.indexOf("netWorth");
  const lnwIdx = shard.metrics.indexOf("liquidNetWorth");
  const nw: number[] = [];
  const lnw: number[] = [];
  let reached = 0;
  let before = 0;
  let after = 0;
  shard.summaries.forEach((s, t) => {
    const month = s.milestones[milestoneId];
    if (!month) return;
    const mi = parseMonth(month);
    let k = shard.periodStarts.findIndex(
      (start, i) => i < Y && mi >= start && mi < shard.periodStarts[i + 1]!,
    );
    if (k < 0) k = mi < shard.periodStarts[0]! ? 0 : Y - 1;
    reached++;
    const pi = shard.priceIndex[t * Y + k]!;
    if (nwIdx >= 0) nw.push(shard.values[(t * M + nwIdx) * Y + k]! / pi);
    if (lnwIdx >= 0) lnw.push(shard.values[(t * M + lnwIdx) * Y + k]! / pi);
    const f = shard.failureIndex[t]!;
    if (f >= 0 && f < k) before++;
    else if (f >= k) after++;
  });
  nw.sort((a, b) => a - b);
  lnw.sort((a, b) => a - b);
  const n = shard.summaries.length;
  return {
    milestoneId,
    reachedShare: n ? reached / n : 0,
    netWorthAt: nw.length ? ps.map((p) => ({ p, value: percentileSorted(nw, p) })) : [],
    liquidNetWorthAt: lnw.length ? ps.map((p) => ({ p, value: percentileSorted(lnw, p) })) : [],
    failedBefore: reached ? before / reached : 0,
    failedAfter: reached ? after / reached : 0,
  };
}
