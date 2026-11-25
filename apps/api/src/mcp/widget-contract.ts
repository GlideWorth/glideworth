/**
 * The data contract between the MCP server and the Glideworth chat widgets (apps/widgets).
 *
 * Tools that have a widget return their usual compact JSON as text for the model, plus a widget payload in the
 * result's `_meta[WIDGET_META_KEY]`. Hosts pass `_meta` to the widget but not to the model, so chart series never
 * cost the model context. The widget imports these types only (`import type`), never the runtime.
 *
 * Money is in major units of `currency`, in today's money (basis `real`), like every MCP output.
 */
import { z } from "zod";

export const WIDGET_META_KEY = "glideworth/widget";

const Money = z.number();
const Year = z.number().int();

/** Shown on every view: what the numbers belong to, and where to open them in the app. */
export const PlanRef = z.object({
  planId: z.string(),
  planName: z.string(),
  planVersion: z.number().int(),
  currency: z.string(),
  /** Deep link into the web app for this view (null when the server has no public URL). */
  appUrl: z.string().nullable(),
  /** The connection may call write tools (apply, discard, create branch). Buttons that need it hide otherwise. */
  canWrite: z.boolean(),
});
export type PlanRef = z.infer<typeof PlanRef>;

/** Key outcome numbers for one plan or one side of a comparison. */
export const OutcomeNumbers = z.object({
  /** Monte Carlo chance of success, 0..1; null for a deterministic-only outcome. */
  successRate: z.number().min(0).max(1).nullable(),
  /** Deterministic projection meets every year's spending. */
  success: z.boolean(),
  endNetWorth: Money,
  /** First year spending cannot be met (deterministic), or null. */
  depletionYear: Year.nullable(),
  retirementYear: Year.nullable(),
  lifetimeTaxes: Money,
});
export type OutcomeNumbers = z.infer<typeof OutcomeNumbers>;

/** A labelled milestone on the time axis (retirement, a house sale, a pension start). */
export const Marker = z.object({ year: Year, label: z.string() });

/**
 * "Will my money last?" Net worth over time. Monte Carlo adds the p10/p90 band; a deterministic run has only
 * `median` (the projection itself). Every series is aligned with `years`.
 */
export const OutcomeView = z.object({
  view: z.literal("outcome"),
  plan: PlanRef,
  kind: z.enum(["monte-carlo", "deterministic"]),
  /** One sentence the widget shows as the headline; the same sentence the text result gives the model. */
  headline: z.string(),
  outcome: OutcomeNumbers,
  years: z.array(Year),
  median: z.array(Money),
  p10: z.array(Money).nullable(),
  p90: z.array(Money).nullable(),
  markers: z.array(Marker),
  /** Monte Carlo: the year the bad-markets case (p10) first runs short, or null. */
  badCaseDepletionYear: Year.nullable(),
  trials: z.number().int().nullable(),
});
export type OutcomeView = z.infer<typeof OutcomeView>;

/**
 * A Monte Carlo run or a solver still going: the widget polls `get_job` and renders the outcome (Monte Carlo) or
 * the answer (solver) from its `_meta` when it finishes.
 */
export const PendingView = z.object({
  view: z.literal("pending"),
  plan: PlanRef,
  jobId: z.string(),
  /** What the finished job will show. */
  of: z.enum(["outcome", "answer"]),
});
export type PendingView = z.infer<typeof PendingView>;

/** One readable change: "Retirement spending: $60,000 → $65,000 a year". */
export const Change = z.object({
  label: z.string(),
  before: z.string().nullable(),
  after: z.string().nullable(),
});

/** A tweakable numeric parameter of a what-if template, rendered as a stepper. */
export const TemplateParam = z.object({
  name: z.string(),
  label: z.string(),
  value: z.number(),
  min: z.number(),
  max: z.number(),
  step: z.number(),
  /** How to show the value: a plain number, a year, a share shown as a percentage, or money. */
  format: z.enum(["number", "year", "percent", "money"]),
});
export type TemplateParam = z.infer<typeof TemplateParam>;

/**
 * "What changes?" The current plan against a what-if (a template, preview ops or another plan). Both series are
 * deterministic net worth aligned with `years`.
 */
export const CompareView = z.object({
  view: z.literal("compare"),
  plan: PlanRef,
  headline: z.string(),
  beforeLabel: z.string(),
  afterLabel: z.string(),
  before: OutcomeNumbers,
  after: OutcomeNumbers,
  years: z.array(Year),
  beforeSeries: z.array(Money),
  afterSeries: z.array(Money),
  changes: z.array(Change),
  /** The RFC 6902 ops of the what-if, so the widget can propose them as a change set. Null for plan-vs-plan. */
  ops: z.array(z.record(z.string(), z.unknown())).nullable(),
  /** Set for preview_whatif: re-run the template with new parameter values. */
  template: z
    .object({
      id: z.string(),
      label: z.string(),
      params: z.record(z.string(), z.unknown()),
      tweakable: z.array(TemplateParam),
    })
    .nullable(),
});
export type CompareView = z.infer<typeof CompareView>;

/** A solver's answer: "You can spend $71,400 a year." The ops apply it; the widget previews or proposes them. */
export const AnswerView = z.object({
  view: z.literal("answer"),
  plan: PlanRef,
  solver: z.string(),
  /** The answer sentence, as in the text result. */
  answer: z.string(),
  /**
   * The key figure, formatted by the widget: money per year, a year, a rate (0..1) or a date (YYYY-MM). `value`
   * is null when the solver found no answer (the `answer` sentence says why).
   */
  figure: z.object({
    label: z.string(),
    value: z.union([z.number(), z.string()]).nullable(),
    format: z.enum(["money", "year", "percent", "month", "number"]),
  }),
  /** The current value of the same figure, when it has one ("you plan to spend $60,000"). */
  current: z
    .object({
      label: z.string(),
      value: z.union([z.number(), z.string()]),
    })
    .nullable(),
  targetSuccessRate: z.number().min(0).max(1).nullable(),
  ops: z.array(z.record(z.string(), z.unknown())).nullable(),
});
export type AnswerView = z.infer<typeof AnswerView>;

/** "Review this change." A proposed change set, with Apply and Discard when the connection can write. */
export const ReviewView = z.object({
  view: z.literal("review"),
  plan: PlanRef,
  changeSetId: z.string(),
  summary: z.string(),
  rationale: z.string().nullable(),
  status: z.enum(["proposed", "applied", "discarded", "conflict"]),
  changes: z.array(Change),
  before: OutcomeNumbers.nullable(),
  after: OutcomeNumbers.nullable(),
  /** Plan version after apply (status `applied`). */
  appliedVersion: z.number().int().nullable(),
});
export type ReviewView = z.infer<typeof ReviewView>;

/** One step of the year waterfall: positive adds to net worth, negative takes away. */
export const FlowStep = z.object({
  label: z.string(),
  amount: Money,
  kind: z.enum(["income", "return", "spending", "tax", "saving", "withdrawal", "other"]),
});

/** "Where the money goes in year X." */
export const YearView = z.object({
  view: z.literal("year"),
  plan: PlanRef,
  year: Year,
  /** Ages of the household's people that year, e.g. ["Alex 62", "Sam 60"]. */
  ages: z.array(z.string()),
  narrative: z.string(),
  startNetWorth: Money,
  endNetWorth: Money,
  /**
   * Income, investment returns and fees, spending, taxes, property value, loan principal repaid and (today's
   * money) inflation, in that order; zero steps other than income are left out. They sum to end minus start.
   */
  steps: z.array(FlowStep),
  /** Where withdrawals came from, by account, largest first. */
  withdrawals: z.array(z.object({ account: z.string(), amount: Money })),
  shortfall: Money,
});
export type YearView = z.infer<typeof YearView>;

/** "Tax over time." Per-year tax by kind, stacked. Every series is aligned with `years`. */
export const TaxView = z.object({
  view: z.literal("tax"),
  plan: PlanRef,
  headline: z.string(),
  years: z.array(Year),
  kinds: z.array(z.object({ key: z.string(), label: z.string(), values: z.array(Money) })),
  lifetimeTotal: Money,
  retirementYear: Year.nullable(),
});
export type TaxView = z.infer<typeof TaxView>;

export const WidgetPayload = z.discriminatedUnion("view", [
  OutcomeView,
  PendingView,
  CompareView,
  AnswerView,
  ReviewView,
  YearView,
  TaxView,
]);
export type WidgetPayload = z.infer<typeof WidgetPayload>;
export type WidgetViewName = WidgetPayload["view"];

/**
 * Which tools render which view. A tool listed here gets the widget template (`_meta.ui.resourceUri`) and returns
 * a payload. `get_job` is not here: it renders nothing itself, but returns an `outcome` payload for a finished
 * Monte Carlo job and an `answer` payload for a finished solver job, so a pending widget can finish.
 */
export const WIDGET_TOOLS = {
  run_monte_carlo: ["outcome", "pending"],
  simulate_plan: ["outcome"],
  preview_whatif: ["compare"],
  preview_changes: ["compare"],
  compare_plans: ["compare"],
  solve_max_spending: ["answer", "pending"],
  solve_retirement_date: ["answer", "pending"],
  solve_required_savings: ["answer", "pending"],
  solve_required_portfolio: ["answer", "pending"],
  solve_safe_withdrawal_rate: ["answer", "pending"],
  propose_change_set: ["review"],
  propose_revert: ["review"],
  explain_year: ["year"],
  tax_breakdown: ["tax"],
} as const satisfies Record<string, readonly WidgetViewName[]>;

/**
 * Tools the widget calls itself (ChatGPT: `openai/widgetAccessible`). Write tools among them exist only for a
 * connection with writes; the widget checks `plan.canWrite` before offering them.
 */
export const WIDGET_CALLABLE_TOOLS = [
  "get_job",
  "explain_year",
  "preview_whatif",
  "preview_changes",
  "propose_change_set",
  "apply_change_set",
  "discard_change_set",
  "create_branch_from_template",
  "get_change_set",
] as const;
