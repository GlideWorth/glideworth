/** Chance-of-success (Monte Carlo / historical) configuration and outcome categories. */
import { z } from "zod";
import { CurrencyCode, Fraction, Id, Rate } from "./primitives.js";

export const Distribution = z
  .object({
    mean: Rate,
    stdDev: z.number().min(0).max(2),
  })
  .meta({ id: "Distribution" });

export const SamplingMethod = z
  .enum([
    /** Independent draws from (correlated) normal distributions. */
    "normal",
    /** Historical: each trial starts in a random year and restarts at a random year when data runs out. */
    "historical-random-restart",
    /** Historical: one trial per start year, no looping (trial count fixed by data). */
    "historical-sequential",
    /** Stitch random blocks of consecutive historical years. */
    "block-bootstrap",
  ])
  .meta({ id: "SamplingMethod" });
export type SamplingMethod = z.infer<typeof SamplingMethod>;

/** How each sampling method is named to people (reports, the chance-of-success page). Never show the raw id. */
export const SAMPLING_METHOD_LABEL: Readonly<Record<SamplingMethod, string>> = {
  "historical-random-restart": "Historical, random start years",
  "historical-sequential": "Historical, every start year once",
  "block-bootstrap": "Block bootstrap of history",
  normal: "Random returns (normal)",
};

export const OutcomeCategory = z
  .object({
    id: Id,
    name: z.string().min(1).max(60),
    kind: z.enum(["success", "failure"]),
    /**
     * Success categories: minimum ending liquid net worth as a multiple of final-year spending.
     * Failure categories: latest depletion point as a share of plan length (0..1).
     */
    threshold: z.number(),
    color: z.string().max(40).optional(),
  })
  .meta({ id: "OutcomeCategory" });
export type OutcomeCategory = z.infer<typeof OutcomeCategory>;

export const DEFAULT_OUTCOME_CATEGORIES: OutcomeCategory[] = [
  { id: "large-surplus", name: "Large surplus", kind: "success", threshold: 25, color: "moss" },
  { id: "comfortable", name: "Comfortable", kind: "success", threshold: 5, color: "sage" },
  { id: "barely", name: "Barely made it", kind: "success", threshold: 0, color: "ochre" },
  { id: "almost", name: "Almost made it", kind: "failure", threshold: 0.9, color: "clay" },
  {
    id: "failed-mid",
    name: "Failed in the middle",
    kind: "failure",
    threshold: 0.5,
    color: "rust",
  },
  { id: "failed-early", name: "Failed early", kind: "failure", threshold: 0, color: "ember" },
];

/**
 * Historical dataset ids a plan can name. `us-1928` and `uk-1983` are bundled; `us-1871-local` is an
 * optional download for self-hosters (stochastic/data/index.ts).
 */
export const DATASET_IDS = ["us-1928", "uk-1983", "us-1871-local"] as const;

/**
 * Dataset ids that were removed from the bundle, and the dataset each is now read as.
 *  - `uk-1871` (Jordà-Schularick-Taylor Macrohistory, CC BY-NC-SA: non-commercial) -> `uk-1983`.
 *  - `us-1871` (Shiller, no explicit licence) -> `us-1928`.
 * Old plans, exports and API requests keep working and report DATASET_REPLACED once read.
 */
export const RETIRED_DATASETS = { "uk-1871": "uk-1983", "us-1871": "us-1928" } as const;
export const RETIRED_DATASET_IDS = ["uk-1871", "us-1871"] as const;
export type RetiredDatasetId = (typeof RETIRED_DATASET_IDS)[number];

function isRetiredDatasetId(v: unknown): v is RetiredDatasetId {
  return typeof v === "string" && Object.hasOwn(RETIRED_DATASETS, v);
}

/**
 * Pre-parse step for raw Monte Carlo settings: when they name a retired dataset, record it in
 * `replacedDataset` (the `dataset` field itself parses the old id to its replacement), so the engine
 * can tell the user. A stale marker (the dataset has since been changed) is dropped. Applied to
 * `Plan.monteCarlo` and to settings passed to the stochastic runners; other values pass through.
 */
export function withReplacedDataset(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const r = raw as Record<string, unknown>;
  if (isRetiredDatasetId(r.dataset)) return { ...r, replacedDataset: r.dataset };
  if (r.replacedDataset === undefined) return raw;
  const current = r.dataset ?? "us-1928";
  if (isRetiredDatasetId(r.replacedDataset) && RETIRED_DATASETS[r.replacedDataset] === current)
    return raw;
  const { replacedDataset: _stale, ...rest } = r;
  return rest;
}

export const MonteCarloSettings = z
  .object({
    method: SamplingMethod.default("historical-random-restart"),
    trials: z.number().int().min(1).max(10_000).default(1000),
    /** Years per block for block-bootstrap. */
    blockLength: z.number().int().min(1).max(30).default(5),
    /** null = new random seed per run (recorded in the result for reproducibility). */
    seed: z
      .number()
      .int()
      .min(0)
      .max(2 ** 32 - 1)
      .nullable()
      .default(null),
    /**
     * Historical dataset (see stochastic/data/README.md for provenance and licences). Retired ids
     * are read as their replacement (`RETIRED_DATASETS`); `us-1871-local` exists only on
     * self-hosted installations that downloaded it (stochastic/data/index.ts).
     */
    dataset: z
      .union([
        z.enum(DATASET_IDS),
        z.enum(RETIRED_DATASET_IDS).transform((id) => RETIRED_DATASETS[id]),
      ])
      .default("us-1928"),
    /**
     * Set when this plan was read with a retired dataset id and moved to its replacement; the engine
     * then reports a DATASET_REPLACED warning. Dropped as soon as `dataset` is changed to anything
     * other than the replacement. Written by `withReplacedDataset`, not by users.
     */
    replacedDataset: z.enum(RETIRED_DATASET_IDS).optional(),
    /**
     * Shape of the random draws for method 'normal'. 'lognormal' draws 1 + r from a log-normal with
     * the configured arithmetic mean and standard deviation (returns can never fall below -100%).
     */
    distributionShape: z.enum(["normal", "lognormal"]).optional(),
    /**
     * Fat tails for method 'normal': draws become multivariate Student-t with this many degrees of
     * freedom, rescaled to keep the configured standard deviation and correlations.
     */
    fatTails: z.object({ degreesOfFreedom: z.number().min(2.5).max(1000) }).optional(),
    /** Years after the sequence-risk anchor (retirement, else plan start) used for the sequence-risk view. */
    sequenceRiskYears: z.number().int().min(1).max(40).optional(),
    /** Which variables vary per trial; others stay at plan assumptions. */
    vary: z
      .object({
        stocks: z.boolean().default(true),
        bonds: z.boolean().default(true),
        inflation: z.boolean().default(true),
        dividends: z.boolean().default(true),
        crypto: z.boolean().default(true),
      })
      .default({ stocks: true, bonds: true, inflation: true, dividends: true, crypto: true }),
    /** For method 'normal'. */
    distributions: z
      .object({
        stocks: Distribution.default({ mean: 0.07, stdDev: 0.17 }),
        bonds: Distribution.default({ mean: 0.02, stdDev: 0.07 }),
        inflation: Distribution.default({ mean: 0.03, stdDev: 0.02 }),
        dividends: Distribution.default({ mean: 0.015, stdDev: 0.005 }),
        crypto: Distribution.default({ mean: 0.07, stdDev: 0.6 }),
        /** Cash return; when absent cash stays at the plan assumption in every trial. */
        cash: Distribution.optional(),
        /** Correlation stocks-bonds, stocks-inflation, bonds-inflation. */
        correlation: z
          .object({
            stocksBonds: z.number().min(-1).max(1).default(0),
            stocksInflation: z.number().min(-1).max(1).default(0),
            bondsInflation: z.number().min(-1).max(1).default(0),
          })
          .default({ stocksBonds: 0, stocksInflation: 0, bondsInflation: 0 }),
      })
      .default({
        stocks: { mean: 0.07, stdDev: 0.17 },
        bonds: { mean: 0.02, stdDev: 0.07 },
        inflation: { mean: 0.03, stdDev: 0.02 },
        dividends: { mean: 0.015, stdDev: 0.005 },
        crypto: { mean: 0.07, stdDev: 0.6 },
        correlation: { stocksBonds: 0, stocksInflation: 0, bondsInflation: 0 },
      }),
    /**
     * Success definition. 'all-funded': every period's expenses were fully funded (no unfunded
     * shortfall). 'liquid-floor': liquid net worth never drops below `floor` (real money).
     * 'never-depleted': liquid net worth stays above zero. 'end-floor': the final value of `metric`
     * is at least `floor` (real money).
     */
    success: z
      .discriminatedUnion("kind", [
        z.object({ kind: z.literal("all-funded") }),
        z.object({ kind: z.literal("liquid-floor"), floor: z.number() }),
        /** Liquid net worth never reaches zero (spending may still have been cut). */
        z.object({ kind: z.literal("never-depleted") }),
        /** Ends with at least `floor` (real money) of the chosen metric; shortfalls along the way allowed. */
        z.object({
          kind: z.literal("end-floor"),
          floor: z.number(),
          metric: z.enum(["liquidNetWorth", "netWorth"]).default("liquidNetWorth"),
        }),
      ])
      .default({ kind: "all-funded" }),
    outcomeCategories: z.array(OutcomeCategory).default(DEFAULT_OUTCOME_CATEGORIES),
    percentiles: z.array(Fraction).default([0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95]),
    /** Split statistics at this milestone (e.g. pre/post retirement). */
    splitAtMilestoneId: Id.optional(),
    /**
     * Optional per-series sampling source for historical methods (PL per-variable source): a series
     * set to 'distribution' is drawn from `distributions` (normal) instead of the historical year,
     * 'fixed' stays at the plan assumption. Absent series follow `method`.
     */
    sources: z
      .object({
        stocks: z.enum(["method", "distribution", "fixed"]).optional(),
        bonds: z.enum(["method", "distribution", "fixed"]).optional(),
        inflation: z.enum(["method", "distribution", "fixed"]).optional(),
        dividends: z.enum(["method", "distribution", "fixed"]).optional(),
        crypto: z.enum(["method", "distribution", "fixed"]).optional(),
      })
      .optional(),
    /**
     * Optional FX risk (default off: exchange rates follow their deterministic rate and drift).
     * Each pair gets a yearly log-normal shock with the given volatility (annual standard deviation
     * of the log change, e.g. 0.08), mean-preserving around the pair's drift. Pairs must involve the
     * household's base currency. `correlation` is the common correlation between the pairs' shocks
     * (e.g. EUR and CHF against GBP moving together).
     */
    fx: z
      .object({
        pairs: z
          .array(
            z.object({
              from: CurrencyCode,
              to: CurrencyCode,
              volatility: z.number().min(0).max(2),
            }),
          )
          .default([]),
        correlation: z.number().min(-1).max(1).default(0),
      })
      .meta({ id: "MonteCarloFxSettings" })
      .optional(),
  })
  .meta({ id: "MonteCarloSettings" });
export type MonteCarloSettings = z.infer<typeof MonteCarloSettings>;
export type MonteCarloSettingsInput = z.input<typeof MonteCarloSettings>;
