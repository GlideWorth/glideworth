/** Request/response schemas shared by REST routes and MCP tools (registered under stable OpenAPI ids). */
import {
  Fraction,
  GoalSeekRequest,
  Id,
  MonteCarloSettings,
  withReplacedDataset,
  OutcomeSummary,
  PatchOp,
  RiskGuardrails,
  SimulationOptions,
  ValueBasis,
} from "@glideworth/core";
import { z } from "zod";

export const SERIES = [
  "netWorth",
  "liquidNetWorth",
  "assets",
  "liabilities",
  "portfolio",
  "cash",
  "realAssets",
  "income",
  "passiveIncome",
  "expenses",
  "spending",
  "taxes",
  "contributions",
  "withdrawals",
  "savingsRate",
  "withdrawalRate",
  "shortfall",
] as const;
export type Series = (typeof SERIES)[number];

/** Shrinks a projection to what the caller needs. All money is rounded to whole units. */
export const ProjectionView = z
  .object({
    basis: ValueBasis.default("real").describe(
      "'real' = today's money (default); 'nominal' = future money.",
    ),
    fromYear: z.number().int().optional().describe("First calendar year to include."),
    toYear: z.number().int().optional().describe("Last calendar year to include."),
    everyNYears: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(1)
      .describe("Keep every Nth year (first and last year always kept)."),
    series: z
      .array(z.enum(SERIES))
      .optional()
      .describe(
        "Only these series per year. Default: netWorth, liquidNetWorth, income, spending, taxes, shortfall.",
      ),
    accountIds: z
      .array(Id)
      .optional()
      .describe("Also include these accounts' closing balances per year."),
    include: z
      .array(z.enum(["summary", "milestones", "warnings", "trace"]))
      .default(["summary", "milestones", "warnings"])
      .describe("Extra top-level sections."),
  })
  .meta({ id: "ProjectionView" });
export type ProjectionView = z.infer<typeof ProjectionView>;

export const SimulateRequest = SimulationOptions.partial()
  .extend({
    view: ProjectionView.optional().describe(
      "When present, the response is a compact projection (CompactProjection) instead of the full ProjectionResult.",
    ),
  })
  .meta({
    id: "SimulateRequest",
    examples: [
      { view: { basis: "real", fromYear: 2030, everyNYears: 5, series: ["netWorth", "taxes"] } },
      {},
    ],
  });
export type SimulateRequest = z.infer<typeof SimulateRequest>;

export const CompactProjection = z
  .object({
    meta: z.object({
      planId: z.string(),
      planVersion: z.number().int(),
      currency: z.string(),
      basis: ValueBasis,
      startMonth: z.string(),
      endMonth: z.string(),
      engineVersion: z.string(),
      cached: z.boolean(),
    }),
    summary: z.unknown().optional(),
    milestones: z.array(z.unknown()).optional(),
    warnings: z.array(z.unknown()).optional(),
    years: z.array(z.record(z.string(), z.unknown())),
    trace: z.array(z.unknown()).optional(),
  })
  .meta({ id: "CompactProjection" });

/**
 * Per-request Monte Carlo overrides. A retired dataset id (`uk-1871`, `us-1871`) is read as its replacement and
 * flagged (`replacedDataset`), so the run carries the DATASET_REPLACED notice, as a plan that names one does.
 */
const McOverrides = z.preprocess(withReplacedDataset, MonteCarloSettings.partial());

export const MonteCarloRequest = z
  .object({
    settings: McOverrides.optional().describe(
      "Overrides on top of the plan's own monteCarlo settings.",
    ),
    keepTrials: z
      .boolean()
      .default(false)
      .describe("Keep per-trial summaries in the result (large)."),
    randomSeed: z
      .boolean()
      .default(false)
      .describe(
        "Use a fresh random seed (not cached). Default: a fixed seed so results are reproducible and comparable across plans.",
      ),
  })
  .meta({
    id: "MonteCarloRequest",
    examples: [{ settings: { trials: 1000, method: "historical-random-restart" } }, {}],
  });
export type MonteCarloRequest = z.infer<typeof MonteCarloRequest>;

export const HistoricalRequest = z
  .object({
    startYears: z
      .array(z.number().int())
      .optional()
      .describe("Restrict to these historical start years."),
    keepTrials: z.boolean().default(false),
  })
  .meta({ id: "HistoricalRequest" });

const target = Fraction.describe("Target success rate, 0..1 (0.85 = 85%).");
const solverExtras = {
  maxEvaluations: z.number().int().min(1).max(200).optional(),
  tolerance: z.number().positive().optional(),
  bounds: z
    .object({ min: z.number(), max: z.number() })
    .optional()
    .describe(
      "Search range for the solved variable (spending: a scale factor; retirement: months from plan start).",
    ),
};
export const MaxSpendingRequest = z
  .object({
    targetSuccessRate: target,
    expenseIds: z.array(Id).optional(),
    monteCarlo: McOverrides.optional(),
    ...solverExtras,
  })
  .meta({
    id: "MaxSpendingRequest",
    examples: [{ targetSuccessRate: 0.9, monteCarlo: { trials: 200 } }],
  });
export const EarliestRetirementRequest = z
  .object({
    milestoneId: Id,
    targetSuccessRate: target,
    monteCarlo: McOverrides.optional(),
    ...solverExtras,
  })
  .meta({ id: "EarliestRetirementRequest" });
export const RequiredSavingsRequest = z
  .object({
    flowId: Id,
    targetSuccessRate: target,
    monteCarlo: McOverrides.optional(),
    ...solverExtras,
  })
  .meta({ id: "RequiredSavingsRequest" });
export const GoalSeekBody = GoalSeekRequest;
export const GuardrailsRequest = z
  .object({
    guardrails: RiskGuardrails.optional().describe("Defaults to the plan's riskGuardrails."),
    monteCarlo: McOverrides.optional().describe(
      "Monte Carlo overrides (guardrails run many simulations: fewer trials = faster).",
    ),
  })
  .meta({ id: "GuardrailsRequest" });

export const WaitQuery = z.object({
  wait: z.coerce
    .number()
    .min(0)
    .max(120)
    .default(0)
    .describe(
      "Seconds to wait for the job to finish before responding (0 = return immediately with 202).",
    ),
});

export const JobStatusEnum = z.enum(["queued", "running", "succeeded", "failed", "cancelled"]);
export const JobSchema = z
  .object({
    id: z.string(),
    kind: z.string(),
    planId: z.string(),
    planVersion: z.number().int(),
    status: JobStatusEnum,
    progress: z.number().describe("0..1"),
    cached: z.boolean().describe("True when the result came from the result cache."),
    createdAt: z.string(),
    startedAt: z.string().nullable(),
    finishedAt: z.string().nullable(),
    error: z
      .object({ code: z.string(), message: z.string(), details: z.unknown().optional() })
      .nullable(),
    params: z.unknown(),
    links: z.object({
      self: z.string(),
      result: z.string(),
      events: z.string().describe("Server-Sent Events stream of progress/status."),
      cancel: z.string(),
    }),
  })
  .meta({ id: "Job" });
export type JobSchema = z.infer<typeof JobSchema>;

export const ResultView = z.object({
  detail: z
    .enum(["summary", "full"])
    .default("summary")
    .describe(
      "'summary' trims large arrays (percentile fans are thinned; per-trial rows omitted).",
    ),
  metrics: z
    .string()
    .optional()
    .describe("Comma-separated Monte Carlo metrics for the fan chart, e.g. netWorth,spending."),
  percentiles: z.string().optional().describe("Comma-separated percentiles, e.g. 0.1,0.5,0.9."),
  everyNYears: z.coerce.number().int().min(1).max(50).default(5),
});

export const ExplainRequest = z
  .object({
    question: z
      .string()
      .max(500)
      .optional()
      .describe('Optional focus, e.g. "why does the plan run out in 2051?"'),
  })
  .meta({ id: "ExplainRequest" });

export const SensitivityRequest = z
  .object({
    metric: z
      .enum(["endNetWorthReal", "lifetimeTaxesReal", "totalShortfallReal", "successRate"])
      .default("endNetWorthReal")
      .describe(
        "Outcome to measure. 'successRate' runs Monte Carlo and is an async job; the others are deterministic and answered inline.",
      ),
    returnDelta: z
      .number()
      .positive()
      .optional()
      .describe("Absolute change in stock/bond returns (default 0.02)."),
    inflationDelta: z.number().positive().optional(),
    spendingDelta: z
      .number()
      .positive()
      .optional()
      .describe("Relative change in spending (default 0.1)."),
    incomeDelta: z.number().positive().optional(),
    retirementMonths: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Shift retirement by this many months."),
    lifeExpectancyYears: z.number().int().positive().optional(),
    monteCarlo: McOverrides.optional(),
  })
  .meta({ id: "SensitivityRequest" });

export const CompareRequest = z
  .object({
    planIds: z.array(Id).min(2).max(6).describe("The first plan is the baseline."),
    explain: z
      .boolean()
      .default(false)
      .describe("Include natural-language explanations of each difference."),
  })
  .meta({ id: "CompareRequest" });

export const TaxQuery = z.object({
  fromYear: z.coerce.number().int().optional(),
  toYear: z.coerce.number().int().optional(),
  basis: ValueBasis.default("real"),
  detail: z
    .enum(["summary", "lines"])
    .default("summary")
    .describe("'lines' adds every tax line per year."),
});

export const PatchOps = z.array(PatchOp).min(1).max(200);
export const OutcomeSummarySchema = OutcomeSummary;

// ------------------------------------------------------------------------------------- insights (explain / what-if)
const DetailEnum = z.enum(["summary", "full"]).default("summary");

export const RequiredPortfolioRequest = z
  .object({
    targetSuccessRate: target,
    accountIds: z
      .array(Id)
      .optional()
      .describe("Scale only these accounts (default: all invested balances)."),
    monteCarlo: McOverrides.optional(),
    ...solverExtras,
  })
  .meta({ id: "RequiredPortfolioRequest" });
export const SafeWithdrawalRateRequest = z
  .object({
    targetSuccessRate: target,
    years: z
      .number()
      .int()
      .min(1)
      .max(80)
      .optional()
      .describe("Retirement length to test (default 30)."),
    accountIds: z.array(Id).optional(),
    monteCarlo: McOverrides.optional(),
    maxEvaluations: solverExtras.maxEvaluations,
    tolerance: solverExtras.tolerance,
  })
  .meta({ id: "SafeWithdrawalRateRequest" });

export const StrategyCandidateBody = z
  .object({
    id: z.string().min(1).max(100),
    label: z.string().min(1).max(200),
    description: z.string().max(1000).default(""),
    patch: PatchOps,
  })
  .meta({ id: "StrategyCandidate" });
export const TaxStrategyRequest = z
  .object({
    objective: z
      .enum(["endNetWorthReal", "lifetimeTaxesReal", "successRate"])
      .default("endNetWorthReal")
      .describe("What to optimise. successRate runs Monte Carlo per candidate (slow)."),
    candidates: z
      .array(StrategyCandidateBody)
      .max(60)
      .optional()
      .describe("Compare your own candidates (plan patches) instead of the built-in UK / US set."),
  })
  .meta({ id: "TaxStrategyRequest" });

export const StrategyMatrixRequest = z
  .object({
    candidates: z
      .array(StrategyCandidateBody)
      .max(60)
      .optional()
      .describe(
        "Your own candidates (plan patches); omit for the built-in set for this household.",
      ),
    successRate: z
      .boolean()
      .default(true)
      .describe(
        "Include the chance-of-success column (Monte Carlo per row, slower). False leaves it null.",
      ),
  })
  .meta({ id: "StrategyMatrixRequest" });

export const ExplainYearRequest = z
  .object({
    year: z.number().int().optional().describe("Calendar year, e.g. 2041."),
    periodIndex: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Alternative to `year`: 0 = first projected year."),
    basis: ValueBasis.default("real"),
    detail: DetailEnum.describe("'summary' omits the ledger/trace evidence."),
  })
  .refine((b) => b.year !== undefined || b.periodIndex !== undefined, {
    message: "give `year` or `periodIndex`",
  })
  .meta({ id: "ExplainYearRequest" });
export const ExplainYearsRequest = z
  .object({
    fromYear: z.number().int().optional(),
    toYear: z.number().int().optional(),
    everyNYears: z.number().int().min(1).max(50).default(5),
    basis: ValueBasis.default("real"),
    detail: DetailEnum,
  })
  .meta({ id: "ExplainYearsRequest" });
export const ExplainDifferenceRequest = z
  .object({
    otherPlanId: Id.describe(
      "Compared against this plan (the baseline), e.g. a branch or an alternative.",
    ),
    attribute: z
      .boolean()
      .default(true)
      .describe(
        "Also attribute the difference to individual edits (re-runs the plan once per edit group).",
      ),
    metric: z
      .enum(["endNetWorthReal", "lifetimeTaxesReal", "totalShortfallReal", "successRate"])
      .default("endNetWorthReal")
      .describe("'successRate' uses Monte Carlo and is an async job."),
    monteCarlo: McOverrides.optional(),
    detail: DetailEnum,
  })
  .meta({ id: "ExplainDifferenceRequest" });
export const GuytonKlingerRequest = z
  .object({
    portfolio: z
      .number()
      .positive()
      .optional()
      .describe("Investable portfolio today (default: from the plan's first year)."),
    spending: z
      .number()
      .positive()
      .optional()
      .describe("Annual spending, today's money (default: first projected year)."),
    initialRate: z
      .number()
      .positive()
      .optional()
      .describe("Initial withdrawal rate (default: spending / portfolio)."),
    guardrail: z
      .number()
      .positive()
      .max(1)
      .optional()
      .describe("Width of the guardrail band (default 0.2 = +/-20%)."),
    adjustment: z
      .number()
      .positive()
      .max(1)
      .optional()
      .describe("Size of a cut or raise (default 0.1 = 10%)."),
    yearsRemaining: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("The capital-preservation rule applies above 15."),
  })
  .meta({ id: "GuytonKlingerRequest" });

export const ScenarioRequest = z
  .object({
    params: z
      .record(z.string(), z.unknown())
      .default({})
      .describe("Template parameters (see GET /scenarios/templates)."),
  })
  .meta({ id: "ScenarioPreviewRequest" });
export const ScenarioBranchRequest = z
  .object({
    params: z.record(z.string(), z.unknown()).default({}),
    name: z.string().min(1).max(120).optional().describe("Default: the template's title."),
    pinParentVersion: z.boolean().default(false),
  })
  .meta({ id: "ScenarioBranchRequest" });
export const SurvivorQuery = z.object({
  ages: z
    .string()
    .regex(/^\d{2,3}(,\d{2,3})*$/)
    .optional()
    .describe("Comma-separated ages, default 70,80,90."),
  evaluate: z.coerce
    .boolean()
    .default(false)
    .describe("Also run each scenario and return before/after outcomes."),
});
