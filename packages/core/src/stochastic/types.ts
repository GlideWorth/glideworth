/**
 * Contracts for Monte Carlo and historical runs.
 *
 * `MonteCarloResult` is the JSON-serialisable summary (API, MCP, UI). Money in `percentiles` and in
 * trial summaries is REAL (today's money, plan-start prices); `percentilesNominal` carries the same
 * bands in nominal money. `MonteCarloShard` is the raw, mergeable form a worker returns: typed
 * arrays that can be posted between threads and merged with `mergeMonteCarloShards`.
 */
import { z } from "zod";
import { SimWarning } from "../engine/types.js";
import { MonteCarloSettings, SamplingMethod } from "../schema/montecarlo.js";
import { Id, MonthDate } from "../schema/primitives.js";

export const StochasticMetric = z.enum([
  "netWorth",
  "liquidNetWorth",
  "portfolio",
  "spending",
  "income",
  "taxes",
  "withdrawalRate",
  "assets",
  "liabilities",
  "cash",
  "realAssets",
  "passiveIncome",
  "expenses",
  "contributions",
  "withdrawals",
  "shortfall",
  "savingsRate",
]);
export type StochasticMetric = z.infer<typeof StochasticMetric>;
/** Every per-period total the engine reports (all plotted series). Default for runs. */
export const ALL_STOCHASTIC_METRICS: readonly StochasticMetric[] = StochasticMetric.options;
/** Ratios: identical in real and nominal terms. */
export const RATIO_METRICS: ReadonlySet<StochasticMetric> = new Set([
  "withdrawalRate",
  "savingsRate",
]);

export const TrialSummary = z
  .object({
    trial: z.number().int(),
    /** Seed for random methods; first historical year for historical methods. */
    seed: z.number().int().nullable(),
    startYear: z.number().int().nullable(),
    success: z.boolean(),
    firstShortfallYear: z.number().int().nullable(),
    endNetWorthReal: z.number(),
    outcomeCategoryId: Id,
    /** milestoneId -> month reached (null = never). */
    milestones: z.record(z.string(), MonthDate.nullable()),
    /** First year the success definition was violated (null when successful). */
    failureYear: z.number().int().nullable().optional(),
    /** First year liquid net worth reached zero or below (null = never). */
    depletionYear: z.number().int().nullable().optional(),
    endLiquidNetWorthReal: z.number().optional(),
    minLiquidNetWorthReal: z.number().optional(),
    totalShortfallReal: z.number().optional(),
    /** Share of requested spending (real) that was funded over the plan (1 = all). */
    fundedShare: z.number().optional(),
    /** Annualised real return of the reference portfolio over the sequence-risk window. */
    earlyRealReturn: z.number().nullable().optional(),
  })
  .meta({ id: "TrialSummary" });
export type TrialSummary = z.infer<typeof TrialSummary>;

export const PercentileSeries = z
  .object({
    metric: StochasticMetric,
    years: z.array(z.number().int()),
    /** One band per requested percentile; values align with `years`. Real money unless `basis` says otherwise. */
    bands: z.array(z.object({ p: z.number(), values: z.array(z.number()) })),
    basis: z.enum(["real", "nominal"]).optional(),
    /** Mean across trials per year (NaN-free; null where no trial has a value). */
    mean: z.array(z.number().nullable()).optional(),
  })
  .meta({ id: "PercentileSeries" });
export type PercentileSeries = z.infer<typeof PercentileSeries>;

export const MilestoneTiming = z
  .object({
    milestoneId: Id,
    /** Share of trials in which it was reached. */
    reachedShare: z.number().min(0).max(1),
    /** Percentiles of the month reached, over trials that reached it. */
    percentiles: z.array(z.object({ p: z.number(), month: MonthDate.nullable() })),
    name: z.string().optional(),
    /** Share of ALL trials that reached it by the end of each year (aligned with `MonteCarloResult.years`). */
    cumulativeShare: z.array(z.number()).optional(),
  })
  .meta({ id: "MilestoneTiming" });
export type MilestoneTiming = z.infer<typeof MilestoneTiming>;

export const SequenceRiskBucket = z
  .object({
    /** Range of annualised early real returns in this bucket. */
    fromReturn: z.number(),
    toReturn: z.number(),
    trials: z.number().int(),
    successRate: z.number(),
    medianEndNetWorthReal: z.number(),
  })
  .meta({ id: "SequenceRiskBucket" });

export const SequenceRisk = z
  .object({
    /** Window start: the retirement milestone when present, else the plan start. */
    anchor: z.enum(["retirement", "planStart"]),
    years: z.number().int(),
    /** Reference portfolio bond share used to compute returns. */
    bondShare: z.number(),
    /** Trials ranked by early real return and split into equal-size buckets (worst first). */
    buckets: z.array(SequenceRiskBucket),
    /** Spearman rank correlation between early real return and success (higher = more sequence risk). */
    rankCorrelation: z.number().nullable(),
  })
  .meta({ id: "SequenceRisk" });
export type SequenceRisk = z.infer<typeof SequenceRisk>;

export const RepresentativeTrial = z
  .object({ trial: z.number().int(), endNetWorthReal: z.number(), success: z.boolean() })
  .meta({ id: "RepresentativeTrial" });

export const SplitStatistics = z
  .object({
    milestoneId: Id,
    reachedShare: z.number(),
    /** Percentiles (real) of net worth and liquid net worth at the end of the milestone's year. */
    netWorthAt: z.array(z.object({ p: z.number(), value: z.number() })),
    liquidNetWorthAt: z.array(z.object({ p: z.number(), value: z.number() })),
    /** Share of trials (among those reaching it) whose first failure came before / from the milestone. */
    failedBefore: z.number(),
    failedAfter: z.number(),
  })
  .meta({ id: "SplitStatistics" });
export type SplitStatistics = z.infer<typeof SplitStatistics>;

export const MonteCarloResult = z
  .object({
    method: SamplingMethod,
    trials: z.number().int(),
    /** Seed actually used (record it to reproduce the run). */
    seed: z.number().int().nullable(),
    successRate: z.number().min(0).max(1),
    outcomeCounts: z.record(z.string(), z.number().int()),
    percentiles: z.array(PercentileSeries),
    milestoneTiming: z.array(MilestoneTiming),
    trialSummaries: z.array(TrialSummary),
    durationMs: z.number().optional(),
    /** Total trials planned; `trials < totalTrials` for partial (streaming) or sharded results. */
    totalTrials: z.number().int().optional(),
    partial: z.boolean().optional(),
    dataset: z.string().nullable().optional(),
    successDefinition: MonteCarloSettings.shape.success.unwrap().optional(),
    /** Period years shared by all series. */
    years: z.array(z.number().int()).optional(),
    /** personId -> age at the end of each period (aligned with `years`). */
    ages: z.record(z.string(), z.array(z.number())).optional(),
    percentilesNominal: z.array(PercentileSeries).optional(),
    /** Trials whose first failure fell in each year (only years with failures). */
    failureYearHistogram: z
      .array(z.object({ year: z.number().int(), count: z.number().int() }))
      .optional(),
    sequenceRisk: SequenceRisk.nullable().optional(),
    /** Trials worth inspecting in full (re-run them with `runTrial`). Ranked by real ending net worth. */
    representativeTrials: z
      .object({
        best: RepresentativeTrial,
        worst: RepresentativeTrial,
        median: RepresentativeTrial,
        p10: RepresentativeTrial,
        p90: RepresentativeTrial,
      })
      .nullable()
      .optional(),
    split: SplitStatistics.nullable().optional(),
    /** The deterministic projection of the same plan (plan assumptions), for reference. */
    deterministic: z.object({ success: z.boolean(), endNetWorthReal: z.number() }).optional(),
    /** Notices about the run itself, e.g. DATASET_REPLACED when the settings named a retired dataset. */
    warnings: z.array(SimWarning).optional(),
  })
  .meta({ id: "MonteCarloResult" });
export type MonteCarloResult = z.infer<typeof MonteCarloResult>;

/** Per-account override for stochastic runs (in addition to `AccountBehaviour.monteCarlo`). */
export type AccountStochasticOverride =
  /** Use the plan's deterministic rates in every trial (PL "Fixed"). */
  | { treatment: "fixed" }
  /** Custom fixed rates in every trial. */
  | { growth: number; dividendYield?: number };

export interface StochasticRunOptions {
  /** Called after each completed trial. */
  onProgress?: (done: number, total: number) => void;
  /** Called every `partialEvery` trials with the summary so far (streaming UI). */
  onPartial?: (partial: MonteCarloResult) => void;
  partialEvery?: number;
  /** Cancellation, checked between trials. Aborting throws a GlideworthError with code 'ABORTED'. */
  signal?: AbortSignal;
  /** Sharding for Web Workers / threads: run trials [trialOffset, trialOffset + trialCount). */
  trialOffset?: number;
  trialCount?: number;
  /** Keep per-trial summaries in the result (default true). */
  keepTrials?: boolean;
  /** Series to keep percentile bands for (default: all). Fewer metrics = less memory. */
  metrics?: readonly StochasticMetric[];
  /** Seed to use when `settings.seed` is null. Otherwise a seed is derived from the plan id + version. */
  seed?: number;
  /** Historical-sequential only: restrict to these start years. */
  startYears?: readonly number[];
  /** accountId -> override. */
  accountOverrides?: Readonly<Record<string, AccountStochasticOverride>>;
}

/**
 * Raw, mergeable output of a run over a set of trials. Structured-cloneable (post it from a worker).
 * Matrices are row-major by local trial: `values[(t * metrics.length + m) * years.length + y]` is the
 * NOMINAL value of metric m in year y for the t-th trial of `trialIndex`; `priceIndex[t * years.length + y]`.
 */
export interface MonteCarloShard {
  kind: "glideworth.monteCarloShard";
  version: 1;
  method: SamplingMethod;
  dataset: string | null;
  seed: number;
  totalTrials: number;
  /** Fingerprint of settings + plan so incompatible shards are not merged. */
  fingerprint: string;
  years: number[];
  /** Month index (year * 12 + month - 1) of each period start; one extra entry = end (exclusive). */
  periodStarts: number[];
  ages: Record<string, number[]>;
  metrics: StochasticMetric[];
  milestones: { id: string; name: string }[];
  /** Global trial indices, ascending. */
  trialIndex: number[];
  values: Float64Array;
  /** End-of-period price index (deflator for stocks), `[t * years.length + y]`. */
  priceIndex: Float64Array;
  /**
   * Start-of-period price index (deflator for flows), same layout. Optional so shards from older
   * builds still merge; absent means flows are deflated with `priceIndex` (the old convention).
   */
  priceIndexStart?: Float64Array;
  summaries: TrialSummary[];
  /** Index into `years` of each trial's first failure, -1 when successful. */
  failureIndex: Int32Array;
  deterministic: { success: boolean; endNetWorthReal: number };
  sequenceRisk: { anchor: "retirement" | "planStart"; years: number; bondShare: number };
}
