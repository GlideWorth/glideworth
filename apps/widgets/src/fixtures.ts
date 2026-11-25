/**
 * Synthetic payloads for the dev preview and the tests: a plausible US couple, no real data. Every series is
 * computed from a simple formula so the fixtures stay deterministic.
 */
import {
  type AnswerView,
  type CompareView,
  type OutcomeView,
  type PendingView,
  type PlanRef,
  type ReviewView,
  type TaxView,
  type ToolResult,
  WIDGET_META_KEY,
  type WidgetPayload,
  type YearView,
} from "./types";

const PLAN: PlanRef = {
  planId: "plan_sample_main",
  planName: "Our retirement plan",
  planVersion: 12,
  currency: "USD",
  appUrl: "https://app.glideworth.example/plans/plan_sample_main",
  canWrite: true,
};

export const READ_ONLY_PLAN: PlanRef = { ...PLAN, canWrite: false, appUrl: null };

const START = 2026;
const END = 2070;
const YEARS = Array.from({ length: END - START + 1 }, (_, i) => START + i);

/** Net worth path: saving until `retire`, then drawing down; `drift` bends the late years. */
function path(opts: {
  start: number;
  save: number;
  growth: number;
  retire: number;
  spend: number;
}) {
  let value = opts.start;
  return YEARS.map((year) => {
    const out = Math.round(value);
    value = value * (1 + opts.growth) + (year < opts.retire ? opts.save : -opts.spend);
    return out;
  });
}

const median = path({ start: 640_000, save: 52_000, growth: 0.052, retire: 2036, spend: 96_000 });
const p10 = path({ start: 640_000, save: 52_000, growth: 0.012, retire: 2036, spend: 96_000 }).map(
  (v) => Math.max(v, -180_000),
);
const p90 = path({ start: 640_000, save: 52_000, growth: 0.071, retire: 2036, spend: 96_000 });
const firstNegative = (values: readonly number[]) => {
  const i = values.findIndex((v) => v < 0);
  return i < 0 ? null : (YEARS[i] ?? null);
};

const MARKERS = [
  { year: 2036, label: "Retirement" },
  { year: 2040, label: "Mortgage paid off" },
  { year: 2044, label: "Social Security" },
  { year: 2066, label: "Avery life expectancy" },
  { year: 2070, label: "Jordan life expectancy" },
];

export const outcomeMonteCarlo: OutcomeView = {
  view: "outcome",
  plan: PLAN,
  kind: "monte-carlo",
  headline: `Your money lasts in 84% of market paths; in bad markets it runs short around ${firstNegative(p10)}.`,
  outcome: {
    successRate: 0.84,
    success: true,
    endNetWorth: median[median.length - 1] ?? 0,
    depletionYear: null,
    retirementYear: 2036,
    lifetimeTaxes: 612_000,
  },
  years: YEARS,
  median,
  p10,
  p90,
  markers: MARKERS,
  badCaseDepletionYear: firstNegative(p10),
  trials: 2000,
};

const lean = path({ start: 640_000, save: 52_000, growth: 0.035, retire: 2034, spend: 104_000 });

export const outcomeDeterministicShort: OutcomeView = {
  view: "outcome",
  plan: PLAN,
  kind: "deterministic",
  headline: `In the projection your savings run out in ${firstNegative(lean)}, before the plan ends in ${END}.`,
  outcome: {
    successRate: null,
    success: false,
    endNetWorth: lean[lean.length - 1] ?? 0,
    depletionYear: firstNegative(lean),
    retirementYear: 2034,
    lifetimeTaxes: 540_000,
  },
  years: YEARS,
  median: lean,
  p10: null,
  p90: null,
  markers: [{ year: 2034, label: "Retire" }],
  badCaseDepletionYear: null,
  trials: null,
};

const outcomeDeterministic: OutcomeView = {
  ...outcomeDeterministicShort,
  headline: "In the projection your money lasts to 2070 with $1.9M left in today’s money.",
  outcome: { ...outcomeMonteCarlo.outcome, successRate: null },
  median,
  markers: MARKERS,
};

export const pending: PendingView = {
  view: "pending",
  plan: PLAN,
  jobId: "job_sample_mc",
  of: "outcome",
};

/** A solver job still running. */
export const pendingAnswer: PendingView = { ...pending, jobId: "job_sample_solver", of: "answer" };

export function compareFor(retireYear: number, spending: number): CompareView {
  const after = path({
    start: 640_000,
    save: 52_000,
    growth: 0.045,
    retire: retireYear,
    spend: spending,
  });
  const afterDepletion = firstNegative(after);
  return {
    view: "compare",
    plan: PLAN,
    headline:
      afterDepletion === null
        ? `Retiring in ${retireYear} still lasts, with less left at the end.`
        : `Retiring in ${retireYear} runs short in ${afterDepletion}.`,
    beforeLabel: "Current plan",
    afterLabel: `Retire in ${retireYear}`,
    before: outcomeDeterministic.outcome,
    after: {
      successRate: null,
      success: afterDepletion === null,
      endNetWorth: after[after.length - 1] ?? 0,
      depletionYear: afterDepletion,
      retirementYear: retireYear,
      lifetimeTaxes: 590_000,
    },
    years: YEARS,
    beforeSeries: median,
    afterSeries: after,
    changes: [
      { label: "Retirement date", before: "Jan 2036", after: `Jan ${retireYear}` },
      {
        label: "Retirement spending",
        before: "$96,000 a year",
        after: `$${spending.toLocaleString("en-US")} a year`,
      },
    ],
    ops: [
      { op: "replace", path: "/people/[id=alex]/retirementDate", value: `${retireYear}-01` },
      { op: "replace", path: "/expenses/[id=retirement-living]/amount/value", value: spending },
    ],
    template: {
      id: "early-retirement",
      label: "Retire earlier",
      params: { retirementYear: retireYear, spending },
      tweakable: [
        {
          name: "retirementYear",
          label: "Retire in",
          value: retireYear,
          min: 2028,
          max: 2040,
          step: 1,
          format: "year",
        },
        {
          name: "spending",
          label: "Spending a year",
          value: spending,
          min: 60_000,
          max: 140_000,
          step: 2_000,
          format: "money",
        },
      ],
    },
  };
}

export const compareTemplate: CompareView = compareFor(2033, 96_000);

export const compareOps: CompareView = {
  ...compareTemplate,
  headline: "Downsizing in 2040 adds about $310k by the end of the plan.",
  afterLabel: "Downsize in 2040",
  before: { ...outcomeMonteCarlo.outcome, successRate: 0.84 },
  after: {
    ...outcomeMonteCarlo.outcome,
    successRate: 0.91,
    endNetWorth: (median[median.length - 1] ?? 0) + 310_000,
  },
  afterSeries: median.map((v, i) => ((YEARS[i] ?? 0) >= 2040 ? v + 180_000 + (i - 14) * 4_000 : v)),
  changes: [
    { label: "Home value", before: "$720,000", after: "$450,000 from 2040" },
    { label: "Property tax", before: "$9,800 a year", after: "$6,100 a year" },
    { label: "Home insurance", before: "$2,600 a year", after: "$1,700 a year" },
    { label: "Maintenance", before: "$7,200 a year", after: "$4,500 a year" },
    { label: "Moving costs", before: null, after: "$24,000 in 2040" },
  ],
  template: null,
  ops: [{ op: "replace", path: "/assets/[id=home]/saleYear", value: 2040 }],
};

export const answerSpending: AnswerView = {
  view: "answer",
  plan: PLAN,
  solver: "solve_max_spending",
  answer: "You can spend about $104,600 a year in retirement and keep a 85% chance of success.",
  figure: { label: "Safe spending", value: 104_600, format: "money" },
  current: { label: "You plan to spend", value: 96_000 },
  targetSuccessRate: 0.85,
  ops: [{ op: "replace", path: "/expenses/[id=retirement-living]/amount/value", value: 104_600 }],
};

export const answerRetireDate: AnswerView = {
  view: "answer",
  plan: PLAN,
  solver: "solve_retirement_date",
  answer: "The earliest you can retire with an 85% chance of success is June 2034.",
  figure: { label: "Earliest retirement", value: "2034-06", format: "month" },
  current: { label: "You plan to retire", value: "2036-01" },
  targetSuccessRate: 0.85,
  ops: [{ op: "replace", path: "/people/[id=alex]/retirementDate", value: "2034-06" }],
};

export const reviewProposed: ReviewView = {
  view: "review",
  plan: PLAN,
  changeSetId: "cs_sample_01",
  summary: "Raise retirement spending to $104,600 a year",
  rationale:
    "The max-spending solver found $104,600 a year keeps an 85% chance of success. This raises the retirement living expense from $96,000; nothing else changes.",
  status: "proposed",
  changes: [{ label: "Retirement spending", before: "$96,000 a year", after: "$104,600 a year" }],
  before: outcomeMonteCarlo.outcome,
  after: {
    ...outcomeMonteCarlo.outcome,
    successRate: 0.85,
    endNetWorth: (median[median.length - 1] ?? 0) - 640_000,
  },
  appliedVersion: null,
};

export const reviewReadOnly: ReviewView = { ...reviewProposed, plan: READ_ONLY_PLAN };

const reviewConflict: ReviewView = { ...reviewProposed, status: "conflict" };

const reviewApplied: ReviewView = {
  ...reviewProposed,
  status: "applied",
  appliedVersion: 13,
};

export const yearView: YearView = {
  view: "year",
  plan: PLAN,
  year: 2041,
  ages: ["Alex 66", "Sam 63"],
  narrative:
    "Alex and Sam are five years into retirement. Spending of $96,000 is covered by Sam’s pension and withdrawals from the taxable account; investment returns more than replace what was drawn.",
  startNetWorth: 1_412_000,
  endNetWorth: 1_436_500,
  steps: [
    { label: "Income", amount: 24_000, kind: "income" },
    { label: "Investment returns", amount: 128_000, kind: "return" },
    { label: "Investment fees", amount: -3_500, kind: "spending" },
    { label: "Spending", amount: -96_000, kind: "spending" },
    { label: "Taxes", amount: -5_000, kind: "tax" },
    { label: "Home and property value", amount: 9_000, kind: "return" },
    { label: "Loan principal repaid (kept as equity)", amount: 14_000, kind: "saving" },
    { label: "Inflation (today's money)", amount: -46_000, kind: "other" },
  ],
  withdrawals: [
    { account: "Joint brokerage", amount: 61_000 },
    { account: "Alex 401(k)", amount: 16_000 },
  ],
  shortfall: 0,
};

export const yearShortfall: YearView = {
  ...yearView,
  year: 2062,
  ages: ["Alex 87", "Sam 84"],
  narrative:
    "The portfolio is nearly spent. Social Security covers most spending, but $18,400 of planned spending can’t be met this year.",
  startNetWorth: 42_000,
  endNetWorth: 0,
  steps: [
    { label: "Social Security", amount: 58_000, kind: "income" },
    { label: "Investment return", amount: 1_600, kind: "return" },
    { label: "Living costs", amount: -84_000, kind: "spending" },
    { label: "Healthcare", amount: -17_600, kind: "spending" },
  ],
  withdrawals: [{ account: "Sam IRA", amount: 42_000 }],
  shortfall: 18_400,
};

const taxYears = YEARS.slice(0, 40);
export const taxView: TaxView = {
  view: "tax",
  plan: PLAN,
  headline: "Tax drops when you retire in 2036, then rises again when RMDs start in 2051.",
  years: taxYears,
  kinds: [
    {
      key: "federal",
      label: "Federal income",
      values: taxYears.map((y) =>
        y < 2036 ? 31_000 + (y - 2026) * 600 : y < 2051 ? 7_500 : 16_000,
      ),
    },
    {
      key: "state",
      label: "State",
      values: taxYears.map((y) => (y < 2036 ? 9_400 : y < 2051 ? 2_100 : 4_300)),
    },
    {
      key: "payroll",
      label: "Payroll",
      values: taxYears.map((y) => (y < 2036 ? 14_200 : 0)),
    },
    {
      key: "capital-gains",
      label: "Capital gains",
      values: taxYears.map((y) => (y < 2036 ? 800 : y < 2051 ? 4_600 : 2_200)),
    },
  ],
  lifetimeTotal: 1_132_000,
  retirementYear: 2036,
};

export function resultOf(payload: WidgetPayload, body: Record<string, unknown> = {}): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(body) }],
    structuredContent: body,
    _meta: { [WIDGET_META_KEY]: payload },
  };
}

export function errorResult(code: string, message: string, hint?: string): ToolResult {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify({ error: { code, message, ...(hint ? { hint } : {}) } }),
      },
    ],
  };
}

export interface Fixture {
  label: string;
  result: ToolResult | null;
  cancelled?: boolean;
}

export const FIXTURES: Record<string, Fixture> = {
  "outcome-mc": { label: "Outcome · Monte Carlo", result: resultOf(outcomeMonteCarlo) },
  "outcome-det": { label: "Outcome · projection lasts", result: resultOf(outcomeDeterministic) },
  "outcome-short": { label: "Outcome · runs short", result: resultOf(outcomeDeterministicShort) },
  pending: { label: "Pending Monte Carlo", result: resultOf(pending) },
  "pending-answer": { label: "Pending solver", result: resultOf(pendingAnswer) },
  "compare-template": { label: "Compare · what-if template", result: resultOf(compareTemplate) },
  "compare-worse": {
    label: "Compare · worse outcome",
    result: resultOf(compareFor(2029, 120_000)),
  },
  "compare-ops": { label: "Compare · previewed changes", result: resultOf(compareOps) },
  "answer-spending": { label: "Answer · max spending", result: resultOf(answerSpending) },
  "answer-date": { label: "Answer · retirement date", result: resultOf(answerRetireDate) },
  review: { label: "Review · proposed", result: resultOf(reviewProposed) },
  "review-readonly": { label: "Review · no write access", result: resultOf(reviewReadOnly) },
  "review-applied": { label: "Review · applied", result: resultOf(reviewApplied) },
  "review-conflict": { label: "Review · conflict", result: resultOf(reviewConflict) },
  year: { label: "Year", result: resultOf(yearView) },
  "year-shortfall": { label: "Year · shortfall", result: resultOf(yearShortfall) },
  tax: { label: "Tax over time", result: resultOf(taxView) },
  empty: { label: "Empty · waiting", result: null },
  cancelled: { label: "Empty · cancelled", result: null, cancelled: true },
  error: {
    label: "Error",
    result: errorResult("NOT_FOUND", "plan plan_x not found", "Call list_plans and retry."),
  },
};
