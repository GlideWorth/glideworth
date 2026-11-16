/**
 * Monte Carlo / historical runners. Every trial is one call of the deterministic engine:
 * `simulate({ ...input, options: { market: path, lean: true, trace: 'off' } })`, with the path from
 * `sampleMarketPath` and the RNG seeded by `deriveSeed(seed, trial)`. Trials are independent, so any
 * subset can run anywhere (workers, threads) and be merged into exactly the single-threaded result.
 */
import { simulate } from "../engine/index.js";
import type {
  MarketPath,
  PeriodTotals,
  ProjectionResult,
  SimulationInput,
  SimulationInputInput,
} from "../engine/types.js";
import { deflator } from "../engine/types.js";
import { GlideworthError, ScenarioError } from "../errors.js";
import type {
  MonteCarloSettings,
  MonteCarloSettingsInput,
  OutcomeCategory,
} from "../schema/montecarlo.js";
import { type PreparedRun, type PrepareOptions, parseSettings, prepareRun } from "./prepare.js";
import { createRng, deriveSeed } from "./rng.js";
import { sampleMarketPath, sequentialStartYear } from "./samplers.js";
import { summarizeMonteCarlo } from "./summary.js";
import type { MonteCarloResult, MonteCarloShard, TrialSummary } from "./types.js";

export type { PrepareOptions } from "./prepare.js";

/** Market path of one trial (inspect a trial's sequence of returns, dividends and inflation). */
export function trialMarketPath(prep: PreparedRun, trial: number): MarketPath {
  const rng = createRng(deriveSeed(prep.seed, trial));
  return sampleMarketPath(prep.settings, prep.periods, rng, trial, prep.sampler);
}

/** Abort error thrown when `signal` is aborted between trials. */
export class MonteCarloAbortedError extends GlideworthError {
  constructor() {
    super("ABORTED", "Monte Carlo run was cancelled");
    this.name = "MonteCarloAbortedError";
  }
}

/** An incremental run over trials [from, to): drive it with `step`, read partial results any time. */
export interface MonteCarloSession {
  readonly total: number;
  readonly from: number;
  readonly to: number;
  readonly done: number;
  readonly finished: boolean;
  readonly prepared: PreparedRun;
  /** Run up to `maxTrials` more trials. Returns true when the range is complete. */
  step(maxTrials?: number): boolean;
  /** Raw mergeable data for the trials completed so far. */
  shard(): MonteCarloShard;
  /** Summary of the trials completed so far (`partial` until finished). */
  result(): MonteCarloResult;
}

export function createMonteCarloSession(
  input: SimulationInput | SimulationInputInput,
  settings: MonteCarloSettings | MonteCarloSettingsInput,
  options: PrepareOptions = {},
): MonteCarloSession {
  const prep = prepareRun(input, settings, options);
  const count = prep.to - prep.from;
  const M = prep.metrics.length;
  const Y = prep.periods;
  // Allocated on the first step, so a session created only to read `total` costs nothing.
  let values = new Float64Array(0);
  let priceIndex = new Float64Array(0);
  let priceIndexStart = new Float64Array(0);
  let failureIndex = new Int32Array(0);
  const allocate = () => {
    if (failureIndex.length === count) return;
    values = new Float64Array(count * M * Y);
    priceIndex = new Float64Array(count * Y);
    priceIndexStart = new Float64Array(count * Y);
    failureIndex = new Int32Array(count);
  };
  const summaries: TrialSummary[] = [];
  let next = prep.from;
  const metricKeys = prep.metrics as (keyof PeriodTotals)[];

  const runTrial = (trial: number, local: number) => {
    const path = trialMarketPath(prep, trial);
    const res = simulate(
      { ...prep.input, options: { ...prep.input.options, market: path } },
      prep.deps,
    );
    if (res.periods.length !== Y)
      throw new ScenarioError("trial produced a different number of periods than the baseline", {
        trial,
        expected: Y,
        got: res.periods.length,
      });
    for (let y = 0; y < Y; y++) {
      const p = res.periods[y]!;
      priceIndex[local * Y + y] = p.priceIndex;
      priceIndexStart[local * Y + y] = deflator(p, "flow");
      const t = p.totals;
      for (let m = 0; m < M; m++) {
        const v = t[metricKeys[m]!];
        values[(local * M + m) * Y + y] = typeof v === "number" ? v : Number.NaN;
      }
    }
    const s = summarizeTrial(prep, trial, res, path);
    failureIndex[local] = s.failureIndex;
    summaries.push(s.summary);
  };

  const buildShard = (): MonteCarloShard => {
    const n = next - prep.from;
    return {
      kind: "glideworth.monteCarloShard",
      version: 1,
      method: prep.settings.method,
      dataset: prep.settings.method === "normal" ? null : prep.settings.dataset,
      seed: prep.seed,
      totalTrials: prep.totalTrials,
      fingerprint: prep.fingerprint,
      years: prep.years,
      periodStarts: prep.periodStarts,
      ages: prep.ages,
      metrics: prep.metrics,
      milestones: prep.milestones,
      trialIndex: Array.from({ length: n }, (_, i) => prep.from + i),
      values: values.slice(0, n * M * Y),
      priceIndex: priceIndex.slice(0, n * Y),
      priceIndexStart: priceIndexStart.slice(0, n * Y),
      summaries: summaries.slice(0, n),
      failureIndex: failureIndex.slice(0, n),
      deterministic: {
        success: prep.baseline.summary.success,
        endNetWorthReal: prep.baseline.summary.endNetWorthReal,
      },
      sequenceRisk: {
        anchor: prep.retirementId ? "retirement" : "planStart",
        years: prep.sequenceYears,
        bondShare: prep.bondShare,
      },
    };
  };

  const session: MonteCarloSession = {
    total: prep.totalTrials,
    from: prep.from,
    to: prep.to,
    prepared: prep,
    get done() {
      return next - prep.from;
    },
    get finished() {
      return next >= prep.to;
    },
    step(maxTrials = Number.POSITIVE_INFINITY) {
      const stop = Math.min(prep.to, next + maxTrials);
      if (stop > next) allocate();
      while (next < stop) {
        if (options.signal?.aborted) throw new MonteCarloAbortedError();
        runTrial(next, next - prep.from);
        next++;
        options.onProgress?.(next - prep.from, count);
        const every = options.partialEvery ?? 0;
        if (options.onPartial && every > 0 && (next - prep.from) % every === 0 && next < prep.to)
          options.onPartial(session.result());
      }
      return next >= prep.to;
    },
    shard: buildShard,
    result() {
      return summarizeMonteCarlo(buildShard(), prep.settings, {
        keepTrials: options.keepTrials ?? true,
        partial: next < prep.to,
      });
    },
  };
  return session;
}

/** Run trials [trialOffset, trialOffset + trialCount) and return the raw shard (for workers). */
export function runMonteCarloShard(
  input: SimulationInput | SimulationInputInput,
  settings: MonteCarloSettings | MonteCarloSettingsInput,
  options: PrepareOptions = {},
): MonteCarloShard {
  const session = createMonteCarloSession(input, settings, options);
  session.step();
  return session.shard();
}

/** Run a chance-of-success simulation (any method in `settings.method`). Synchronous. */
export function runMonteCarlo(
  input: SimulationInput | SimulationInputInput,
  settings: MonteCarloSettings | MonteCarloSettingsInput,
  options: PrepareOptions = {},
): MonteCarloResult {
  const session = createMonteCarloSession(input, settings, options);
  session.step();
  return session.result();
}

/**
 * Same as `runMonteCarlo`, but yields to the event loop every `chunkSize` trials so a UI thread or
 * worker stays responsive, `onPartial` can stream results and `signal` can cancel.
 */
export async function runMonteCarloAsync(
  input: SimulationInput | SimulationInputInput,
  settings: MonteCarloSettings | MonteCarloSettingsInput,
  options: PrepareOptions & { chunkSize?: number; yield?: () => Promise<void> } = {},
): Promise<MonteCarloResult> {
  const { onPartial, partialEvery: _p, ...rest } = options;
  const session = createMonteCarloSession(input, settings, rest);
  const chunk = Math.max(1, options.chunkSize ?? 50);
  const pause = options.yield ?? defaultYield;
  while (!session.step(chunk)) {
    onPartial?.(session.result());
    await pause();
    if (options.signal?.aborted) throw new MonteCarloAbortedError();
  }
  return session.result();
}

function defaultYield(): Promise<void> {
  const g = globalThis as unknown as { setTimeout?: (fn: () => void, ms: number) => unknown };
  return new Promise((resolve) => (g.setTimeout ? g.setTimeout(resolve, 0) : resolve()));
}

/**
 * Historical backtest: one trial per available start year, no looping (`historical-sequential`).
 * Uses the plan's Monte Carlo settings for vary flags, success definition and categories.
 */
export function runHistorical(
  input: SimulationInput | SimulationInputInput,
  options: PrepareOptions & {
    startYears?: readonly number[];
    dataset?: MonteCarloSettings["dataset"];
    settings?: MonteCarloSettingsInput;
  } = {},
): MonteCarloResult {
  const parsed = "plan" in input ? (input.plan as { monteCarlo?: MonteCarloSettingsInput }) : {};
  const settings = parseSettings({
    ...(options.settings ?? parsed.monteCarlo ?? {}),
    method: "historical-sequential",
    ...(options.dataset ? { dataset: options.dataset } : {}),
  });
  return runMonteCarlo(input, settings, options);
}

/**
 * Re-run one trial in full (all line items, ledger and a summary trace) to inspect it, e.g. the
 * best / worst / median representative trials. Pass the same input, settings and options as the run.
 */
export function runTrial(
  input: SimulationInput | SimulationInputInput,
  settings: MonteCarloSettings | MonteCarloSettingsInput,
  trial: number,
  options: PrepareOptions & { trace?: "off" | "summary" | "full" } = {},
): { trial: number; market: MarketPath; result: ProjectionResult } {
  const prep = prepareRun(input, settings, options);
  if (trial < 0 || trial >= prep.totalTrials)
    throw new ScenarioError(`trial ${trial} is outside 0..${prep.totalTrials - 1}`, { trial });
  const market = trialMarketPath(prep, trial);
  const result = simulate(
    {
      ...prep.input,
      options: { ...prep.input.options, lean: false, trace: options.trace ?? "summary", market },
    },
    prep.deps,
  );
  return { trial, market, result };
}

/** The market path a trial used (sequence of returns, dividends and inflation). */
export function getTrialMarketPath(
  input: SimulationInput | SimulationInputInput,
  settings: MonteCarloSettings | MonteCarloSettingsInput,
  trial: number,
  options: PrepareOptions = {},
): MarketPath {
  return trialMarketPath(prepareRun(input, settings, options), trial);
}

// ------------------------------------------------------------------------------ per-trial summary

function summarizeTrial(
  prep: PreparedRun,
  trial: number,
  res: ProjectionResult,
  path: MarketPath,
): { summary: TrialSummary; failureIndex: number } {
  const ps = res.periods;
  const Y = ps.length;
  const success = prep.settings.success;
  let failure = -1;
  let depletion = -1;
  let minLiquid = Number.POSITIVE_INFINITY;
  let shortfallReal = 0;
  let expensesReal = 0;
  for (let y = 0; y < Y; y++) {
    const p = ps[y]!;
    const t = p.totals;
    const liquidReal = t.liquidNetWorth / p.priceIndex;
    if (liquidReal < minLiquid) minLiquid = liquidReal;
    const flowPi = deflator(p, "flow");
    shortfallReal += t.shortfall / flowPi;
    expensesReal += t.expenses / flowPi;
    if (depletion < 0 && t.liquidNetWorth <= 0) depletion = y;
    if (failure < 0) {
      if (success.kind === "all-funded" && p.status === "shortfall") failure = y;
      else if (success.kind === "liquid-floor" && liquidReal < success.floor) failure = y;
      else if (success.kind === "never-depleted" && t.liquidNetWorth <= 0) failure = y;
    }
  }
  const last = ps[Y - 1];
  const endReal = last ? last.totals.netWorth / last.priceIndex : 0;
  const endLiquidReal = last ? last.totals.liquidNetWorth / last.priceIndex : 0;
  if (success.kind === "end-floor" && last) {
    const v =
      (success.metric === "netWorth" ? last.totals.netWorth : last.totals.liquidNetWorth) /
      last.priceIndex;
    if (v < success.floor) failure = depletion >= 0 ? depletion : Y - 1;
  }
  const finalSpendingReal = last ? last.totals.spending / deflator(last, "flow") : 0;
  const category = classify(
    prep.settings.outcomeCategories,
    failure,
    Y,
    endLiquidReal,
    finalSpendingReal,
  );

  const milestones: Record<string, string | null> = {};
  let retirementPeriod: number | null = null;
  for (const m of res.milestones) {
    if (m.status === "disabled") continue;
    milestones[m.milestoneId] = m.status === "reached" ? m.month : null;
    if (m.milestoneId === prep.retirementId) retirementPeriod = m.periodIndex;
  }

  const historical = prep.settings.method !== "normal";
  const startYear =
    prep.settings.method === "historical-sequential"
      ? sequentialStartYear(prep.settings, trial, prep.sampler)
      : historical
        ? (path.periods[0]?.sourceYear ?? null)
        : null;

  return {
    failureIndex: failure,
    summary: {
      trial,
      seed: prep.settings.method === "historical-sequential" ? null : deriveSeed(prep.seed, trial),
      startYear,
      success: failure < 0,
      firstShortfallYear: res.summary.firstShortfallYear,
      endNetWorthReal: endReal,
      outcomeCategoryId: category,
      milestones,
      failureYear: failure >= 0 ? (ps[failure]?.year ?? null) : null,
      depletionYear: depletion >= 0 ? (ps[depletion]?.year ?? null) : null,
      endLiquidNetWorthReal: endLiquidReal,
      minLiquidNetWorthReal: Number.isFinite(minLiquid) ? minLiquid : 0,
      totalShortfallReal: shortfallReal,
      fundedShare: expensesReal > 0 ? Math.max(0, 1 - shortfallReal / expensesReal) : 1,
      earlyRealReturn: earlyRealReturn(
        path,
        prep.retirementId ? (retirementPeriod ?? null) : 0,
        prep.sequenceYears,
        prep.bondShare,
        res,
      ),
    },
  };
}

/** Annualised real return of the reference portfolio over `years` periods from `anchor`. */
function earlyRealReturn(
  path: MarketPath,
  anchor: number | null,
  years: number,
  bondShare: number,
  res: ProjectionResult,
): number | null {
  if (anchor === null || anchor >= path.periods.length) return null;
  let growth = 1;
  let span = 0;
  const end = Math.min(path.periods.length, res.periods.length, anchor + years);
  for (let i = anchor; i < end; i++) {
    const m = path.periods[i]!;
    const frac = res.periods[i]!.months / 12;
    const nominal =
      (1 - bondShare) * (m.stocks + m.dividendYield) + bondShare * (m.bonds + m.bondYield);
    growth *= ((1 + nominal) / (1 + m.inflation)) ** frac;
    span += frac;
  }
  if (span <= 0) return null;
  return growth ** (1 / span) - 1;
}

/** Outcome category per the schema semantics (thresholds; see OutcomeCategory). */
export function classify(
  categories: readonly OutcomeCategory[],
  failureIndex: number,
  periods: number,
  endLiquidReal: number,
  finalSpendingReal: number,
): string {
  if (failureIndex < 0) {
    const ok = categories
      .filter((c) => c.kind === "success")
      .sort((a, b) => b.threshold - a.threshold);
    const ratio =
      finalSpendingReal > 0
        ? endLiquidReal / finalSpendingReal
        : endLiquidReal >= 0
          ? Number.POSITIVE_INFINITY
          : -1;
    return (ok.find((c) => ratio >= c.threshold) ?? ok[ok.length - 1])?.id ?? "success";
  }
  const bad = categories
    .filter((c) => c.kind === "failure")
    .sort((a, b) => b.threshold - a.threshold);
  const point = periods > 0 ? failureIndex / periods : 0;
  return (bad.find((c) => point >= c.threshold) ?? bad[bad.length - 1])?.id ?? "failure";
}
