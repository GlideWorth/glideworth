/**
 * "Why did my number change?": the output of `attributeResultChange` (insights/result-change.ts). It is
 * also the REST response schema, so the OpenAPI document describes exactly what the function returns.
 */
import { z } from "zod";

/** The causes, in the fixed order the attribution applies them (see RESULT_CHANGE_ORDER). */
export const ResultChangeCause = z
  .enum(["glideworth", "time", "balances", "household", "plan"])
  .meta({ id: "ResultChangeCause" });
export type ResultChangeCause = z.infer<typeof ResultChangeCause>;

export const ResultChangeMetric = z
  .enum(["successRate", "fiYear", "endNetWorthReal"])
  .meta({ id: "ResultChangeMetric" });
export type ResultChangeMetric = z.infer<typeof ResultChangeMetric>;

/** Fingerprints of what Glideworth contributes to a result: engine code, tax tables, market history. */
export const ResultFingerprints = z
  .object({
    engineVersion: z.string(),
    taxTables: z.string().describe("Fingerprint of the bundled tax tables."),
    marketData: z.string().describe("Fingerprint of the bundled market history."),
  })
  .meta({ id: "ResultFingerprints" });
export type ResultFingerprints = z.infer<typeof ResultFingerprints>;

export const HeadlineValues = z
  .object({
    successRate: z.number().nullable().describe("Monte Carlo chance of success, 0..1."),
    fiYear: z
      .number()
      .int()
      .nullable()
      .describe("Financial-independence year (or the retirement year); null when never reached."),
    endNetWorthReal: z
      .number()
      .nullable()
      .describe("Net worth at the end of the plan, today's money."),
  })
  .meta({ id: "HeadlineValues" });
export type HeadlineValues = z.infer<typeof HeadlineValues>;

const PlanEditEffect = z.object({
  key: z.string().describe("The plan item or setting the edit touched."),
  description: z.string(),
  delta: z
    .number()
    .nullable()
    .describe("This edit alone, applied on top of the earlier steps. Null for chance of success."),
});

export const ResultChangePart = z
  .object({
    cause: ResultChangeCause,
    label: z.string(),
    delta: z
      .number()
      .nullable()
      .describe("How far this cause moved the measure. Null when it cannot be measured."),
    edits: z
      .array(PlanEditEffect)
      .optional()
      .describe("Plan edits only: each edit alone (one at a time on the same base)."),
    interaction: z
      .number()
      .nullable()
      .optional()
      .describe(
        "Plan edits only: the part of `delta` the edits taken one at a time do not explain.",
      ),
  })
  .meta({ id: "ResultChangePart" });
export type ResultChangePart = z.infer<typeof ResultChangePart>;

export const ResultMetricChange = z
  .object({
    metric: ResultChangeMetric,
    label: z.string(),
    unit: z.enum(["fraction", "year", "money"]),
    basis: z.enum(["real"]).optional().describe("Money measures are in today's money."),
    before: z.number().nullable(),
    after: z.number().nullable(),
    total: z.number().nullable().describe("after - before; null when either is missing."),
    parts: z.array(ResultChangePart).describe("One entry per cause, in the order applied."),
    unexplained: z
      .number()
      .nullable()
      .describe(
        "total minus the parts: what the steps do not account for (for example a different answer from the same inputs). Null when a step could not be measured.",
      ),
  })
  .meta({ id: "ResultMetricChange" });
export type ResultMetricChange = z.infer<typeof ResultMetricChange>;

export const ResultChangeStep = z
  .object({
    cause: ResultChangeCause,
    label: z.string(),
    changed: z.boolean().describe("Whether anything of this kind changed between the two points."),
    details: z.array(z.string()).describe("What changed, in words (the edits are named here)."),
  })
  .meta({ id: "ResultChangeStep" });
export type ResultChangeStep = z.infer<typeof ResultChangeStep>;

export const ResultChange = z
  .object({
    available: z
      .literal(true)
      .describe("The split is available (both points stored what the split needs)."),
    noChange: z
      .boolean()
      .describe("Nothing changed: same plan, household, balances, start month, engine and tables."),
    order: z.array(ResultChangeCause).describe("The order the causes were applied in."),
    method: z.string().describe("How the movement was split, in words."),
    fingerprints: z.object({
      before: ResultFingerprints.nullable(),
      after: ResultFingerprints.nullable(),
      now: ResultFingerprints,
    }),
    steps: z.array(ResultChangeStep),
    metrics: z.array(ResultMetricChange),
    summary: z.array(z.string()).describe("One sentence per measure."),
    notes: z.array(z.string()),
  })
  .meta({ id: "ResultChange" });
export type ResultChange = z.infer<typeof ResultChange>;

/** An older check-in (or one that failed) without the inputs the split needs: the total movement only. */
export const ResultChangeUnavailable = z
  .object({
    available: z.literal(false),
    reason: z.string(),
    metrics: z.array(
      ResultMetricChange.pick({
        metric: true,
        label: true,
        unit: true,
        basis: true,
        before: true,
        after: true,
        total: true,
      }),
    ),
    summary: z.array(z.string()),
    notes: z.array(z.string()),
  })
  .meta({ id: "ResultChangeUnavailable" });
export type ResultChangeUnavailable = z.infer<typeof ResultChangeUnavailable>;
