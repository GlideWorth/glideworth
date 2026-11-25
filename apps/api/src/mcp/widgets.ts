/**
 * Server side of the Glideworth chat widgets (MCP Apps, rendered by ChatGPT and Claude).
 *
 * One HTML resource holds every view. Tools in `WIDGET_TOOLS` name it as their template; their results carry a
 * payload in `_meta[WIDGET_META_KEY]` (see widget-contract.ts) next to the unchanged text the model reads. Each
 * payload is built from the same result object as that text, so the widget and the model see the same numbers.
 *
 * This replicates the two server helpers of `@modelcontextprotocol/ext-apps` (it needs SDK v2): a tool names its
 * template in `_meta.ui.resourceUri` (and the legacy `_meta["ui/resourceUri"]`), and the resource is served as
 * `text/html;profile=mcp-app`. The `openai/*` keys are the ChatGPT Apps SDK equivalents.
 */
import type {
  MonteCarloResult,
  OutcomeSummary,
  ProjectionResult,
  YearNarrative,
} from "@glideworth/core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { baseConverter } from "../fx.js";
import { log } from "../log.js";
import { inBasis, totalInBasis } from "../money.js";
import { TEMPLATES } from "../services/scenarios.js";
import type { Services } from "../services.js";
import { mcHeadline, roundMoney } from "../views.js";
import {
  type AnswerView,
  type CompareView,
  type OutcomeNumbers,
  type OutcomeView,
  type PendingView,
  type PlanRef,
  type ReviewView,
  type TaxView,
  type TemplateParam,
  WIDGET_CALLABLE_TOOLS,
  WIDGET_META_KEY,
  WIDGET_TOOLS,
  type WidgetPayload,
  type YearView,
} from "./widget-contract.js";
import { getWidgetHtml, WIDGET_HASH } from "./widget-html.generated.js";

/** Hash-versioned: hosts cache templates by URI, so a new bundle needs a new URI. */
export const WIDGET_URI = `ui://glideworth/app-${WIDGET_HASH}.html`;
export const WIDGET_MIME_TYPE = "text/html;profile=mcp-app";

/** What the payload builders need besides the tool result. */
export interface WidgetEnv {
  services: Services;
  /** Write tools are registered on this connection. */
  canWrite: boolean;
  /** Public origin of the web app, for deep links; null when unknown. */
  webUrl: string | null;
}

// ------------------------------------------------------------------------------------------- registration

const INVOCATION: Record<keyof typeof WIDGET_TOOLS, [invoking: string, invoked: string]> = {
  run_monte_carlo: ["Running Monte Carlo", "Ran Monte Carlo"],
  simulate_plan: ["Projecting the plan", "Projected the plan"],
  preview_whatif: ["Previewing the what-if", "Previewed the what-if"],
  preview_changes: ["Previewing changes", "Previewed changes"],
  compare_plans: ["Comparing plans", "Compared plans"],
  solve_max_spending: ["Solving for spending", "Solved for spending"],
  solve_retirement_date: ["Solving for retirement date", "Solved for retirement date"],
  solve_required_savings: ["Solving for savings", "Solved for savings"],
  solve_required_portfolio: ["Solving for portfolio", "Solved for portfolio"],
  solve_safe_withdrawal_rate: ["Solving for withdrawal rate", "Solved for withdrawal rate"],
  propose_change_set: ["Proposing changes", "Proposed changes"],
  propose_revert: ["Proposing a revert", "Proposed a revert"],
  explain_year: ["Explaining the year", "Explained the year"],
  tax_breakdown: ["Breaking down taxes", "Broke down taxes"],
};

/** Tool `_meta` for a widget tool or a tool the widget calls; undefined for every other tool. */
export function widgetToolMeta(name: string): Record<string, unknown> | undefined {
  const callable = (WIDGET_CALLABLE_TOOLS as readonly string[]).includes(name);
  const invocation = INVOCATION[name as keyof typeof WIDGET_TOOLS];
  if (!invocation && !callable) return undefined;
  return {
    ...(invocation
      ? {
          ui: { resourceUri: WIDGET_URI },
          "ui/resourceUri": WIDGET_URI,
          "openai/outputTemplate": WIDGET_URI,
          "openai/toolInvocation/invoking": invocation[0],
          "openai/toolInvocation/invoked": invocation[1],
        }
      : {}),
    ...(callable ? { "openai/widgetAccessible": true } : {}),
  };
}

/** Resource `_meta`: the widget fetches nothing itself (all data arrives in tool results), so the CSP is empty. */
export function widgetResourceMeta(webUrl: string | null): Record<string, unknown> {
  let domain: string | undefined;
  try {
    domain = webUrl ? new URL(webUrl).origin : undefined;
  } catch {
    domain = undefined;
  }
  return {
    ui: { csp: { connectDomains: [], resourceDomains: [] }, prefersBorder: true },
    "openai/widgetCSP": { connect_domains: [], resource_domains: [] },
    "openai/widgetPrefersBorder": true,
    "openai/widgetDescription":
      "Glideworth's interactive views of a retirement plan: net worth over time and the chance of success, what-if comparisons, solver answers, proposed changes, one year's cash flow and tax over time.",
    ...(domain ? { "openai/widgetDomain": domain } : {}),
  };
}

export function registerWidgetResource(server: McpServer, webUrl: string | null): void {
  const meta = widgetResourceMeta(webUrl);
  server.registerResource(
    "widget",
    WIDGET_URI,
    {
      title: "Glideworth interactive views",
      description:
        "The HTML template ChatGPT and Claude render for Glideworth's charts and reviews. Data arrives in tool results.",
      mimeType: WIDGET_MIME_TYPE,
      _meta: meta,
    },
    (uri) => ({
      contents: [{ uri: uri.href, mimeType: WIDGET_MIME_TYPE, text: getWidgetHtml(), _meta: meta }],
    }),
  );
}

// ------------------------------------------------------------------------------------------- tool results

/** A tool result that also has a widget payload. `text` is what the model reads, unchanged. */
export class WithWidget {
  constructor(
    readonly text: unknown,
    readonly build: () => WidgetPayload | null,
  ) {}
}
export const withWidget = (text: unknown, build: () => WidgetPayload | null): WithWidget =>
  new WithWidget(text, build);

/**
 * The payload for `_meta`, or undefined. A widget problem never fails the tool: it is logged and the tool
 * returns its normal result.
 */
export function widgetMeta(tool: string, w: WithWidget): Record<string, unknown> | undefined {
  try {
    const payload = w.build();
    return payload ? { [WIDGET_META_KEY]: payload } : undefined;
  } catch (err) {
    log.warn("mcp.widget_failed", { component: "mcp", kind: tool, err });
    return undefined;
  }
}

// ------------------------------------------------------------------------------------------- helpers

type View = WidgetPayload["view"];
const VIEW_ROUTE: Record<View, string> = {
  outcome: "/chance",
  pending: "/chance",
  compare: "/compare",
  answer: "/results",
  review: "/plans/$planId",
  year: "/cashflow",
  tax: "/taxes",
};

/**
 * A deep link for the view. The web app's pages show the active plan (main by default), and only the plan editor
 * takes a plan id in the URL, so a plan other than the main one links to its editor, which also makes it active.
 */
function appUrl(env: WidgetEnv, plan: { id: string; isMain: boolean }, route: string) {
  if (!env.webUrl) return null;
  const base = env.webUrl.replace(/\/+$/, "");
  const path =
    route.includes("$planId") || !plan.isMain ? `/plans/${encodeURIComponent(plan.id)}` : route;
  return `${base}${path}`;
}

function planRef(env: WidgetEnv, planId: string, route: string): PlanRef {
  const plan = env.services.plans.get(planId);
  const currency = env.services.households.get(plan.householdId).household.currency;
  return {
    planId: plan.id,
    planName: plan.name,
    planVersion: plan.version,
    currency,
    appUrl: appUrl(env, plan, route),
    canWrite: env.canWrite,
  };
}

function formatMoney(n: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      maximumFractionDigits: 0,
    }).format(n);
  } catch {
    return `${Math.round(n).toLocaleString("en-US")} ${currency}`;
  }
}

/** OutcomeSummary (previews, comparisons) -> OutcomeNumbers. A plan succeeds when no year runs short. */
export function outcomeNumbers(
  o: OutcomeSummary,
  success = o.depletionYear === null,
): OutcomeNumbers {
  return {
    successRate: o.successRate,
    success,
    endNetWorth: o.endNetWorthReal,
    depletionYear: o.depletionYear,
    retirementYear: o.retirementYear,
    lifetimeTaxes: o.lifetimeTaxesReal,
  };
}

function numbersOfProjection(r: ProjectionResult, successRate: number | null): OutcomeNumbers {
  const s = r.summary;
  return {
    successRate,
    success: s.success,
    endNetWorth: s.endNetWorthReal,
    depletionYear: s.firstShortfallYear,
    retirementYear: s.retirementYear,
    lifetimeTaxes: s.lifetimeTaxesReal,
  };
}

/** Net worth per year in today's money, rounded as the text outputs round it. */
function netWorthSeries(r: ProjectionResult): { years: number[]; values: number[] } {
  return {
    years: r.periods.map((p) => p.year),
    values: r.periods.map((p) =>
      roundMoney(totalInBasis("netWorth", p.totals.netWorth, p, "real")),
    ),
  };
}

function markersOf(r: ProjectionResult): { year: number; label: string }[] {
  const seen = new Set<string>();
  const out: { year: number; label: string }[] = [];
  for (const m of r.milestones) {
    if (m.status !== "reached" || !m.month) continue;
    const year = Number(m.month.slice(0, 4));
    const key = `${year}:${m.name}`;
    if (!Number.isInteger(year) || seen.has(key)) continue;
    seen.add(key);
    out.push({ year, label: m.name });
  }
  return out.sort((a, b) => a.year - b.year);
}

const changesOf = (descriptions: readonly string[]) =>
  descriptions.map((label) => ({ label, before: null, after: null }));

function compareHeadline(
  before: OutcomeNumbers,
  after: OutcomeNumbers,
  currency: string,
  prefix: string,
): string {
  const delta = after.endNetWorth - before.endNetWorth;
  const sign = delta >= 0 ? "+" : "−";
  let s = `${prefix}: end net worth ${formatMoney(before.endNetWorth, currency)} → ${formatMoney(after.endNetWorth, currency)} (${sign}${formatMoney(Math.abs(delta), currency)}) in today's money`;
  if (before.success && !after.success) s += `, and it runs short from ${after.depletionYear}`;
  else if (!before.success && after.success) s += ", and every year is now funded";
  return `${s}.`;
}

// ------------------------------------------------------------------------------------------- template params

type Bound = number | ((c: { firstYear: number; lastYear: number; value: number }) => number);
interface ParamSpec {
  label: string;
  min: Bound;
  max: Bound;
  step: Bound;
  format: TemplateParam["format"];
  /** Value when the caller left an optional parameter out (the template's own default). */
  default?: number;
}

const moneyStep = ({ value }: { value: number }) =>
  value <= 20_000 ? 1_000 : value <= 200_000 ? 5_000 : value <= 1_000_000 ? 25_000 : 100_000;
const moneyMax = (c: { value: number }) => Math.max(c.value * 3, moneyStep(c) * 20);
const money = (label: string, extra: Partial<ParamSpec> = {}): ParamSpec => ({
  label,
  min: 0,
  max: moneyMax,
  step: moneyStep,
  format: "money",
  ...extra,
});

/** Stepper ranges for the numeric parameters of each template (TEMPLATES in services/scenarios.ts). */
const TWEAKS: Record<string, Record<string, ParamSpec>> = {
  "early-retirement": {
    years: { label: "Years earlier", min: 1, max: 15, step: 1, format: "number" },
  },
  "market-crash": {
    year: {
      label: "Crash year",
      min: (c) => c.firstYear,
      max: (c) => c.lastYear,
      step: 1,
      format: "year",
    },
    drop: {
      label: "Fall in stocks",
      min: 0.1,
      max: 0.6,
      step: 0.05,
      format: "percent",
      default: 0.3,
    },
  },
  "job-loss": {
    months: { label: "Months out of work", min: 1, max: 36, step: 1, format: "number" },
  },
  "career-break": {
    months: { label: "Months off", min: 1, max: 60, step: 1, format: "number" },
    share: { label: "Income kept", min: 0, max: 1, step: 0.05, format: "percent", default: 0 },
  },
  downsizing: {
    equityReleased: money("Cash released"),
    housingCut: money("Housing cost saved a year", {
      step: 1_000,
      max: (c) => Math.max(c.value * 3, 30_000),
    }),
  },
  child: {
    annualCost: money("Cost a year", { step: 1_000, max: (c) => Math.max(c.value * 3, 40_000) }),
    childcareAnnual: money("Childcare a year", {
      step: 1_000,
      max: (c) => Math.max(c.value * 3, 40_000),
    }),
  },
  inheritance: { amount: money("Inheritance") },
  "long-term-care": {
    fromAge: { label: "From age", min: 60, max: 100, step: 1, format: "number" },
    annualCost: money("Cost a year", { step: 5_000, max: (c) => Math.max(c.value * 3, 200_000) }),
    years: { label: "Years of care", min: 1, max: 20, step: 1, format: "number" },
  },
  survivor: { age: { label: "Age at death", min: 50, max: 100, step: 1, format: "number" } },
};

/** The innermost number schema of a parameter, or null when it is not numeric. */
function numberSchema(s: z.ZodType): z.ZodNumber | null {
  let cur: z.ZodType = s;
  while (cur instanceof z.ZodOptional || cur instanceof z.ZodDefault)
    cur = cur.unwrap() as z.ZodType;
  return cur instanceof z.ZodNumber ? cur : null;
}

const humanize = (key: string) =>
  key
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^./, (c) => c.toUpperCase())
    .toLowerCase()
    .replace(/^./, (c) => c.toUpperCase());

/** The numeric parameters of a template, as steppers. Non-numeric parameters are left out. */
export function tweakableParams(
  templateId: string,
  params: Record<string, unknown>,
  years: { firstYear: number; lastYear: number },
): TemplateParam[] {
  const t = TEMPLATES[templateId];
  if (!t) return [];
  const out: TemplateParam[] = [];
  for (const [name, schema] of Object.entries(t.params.shape as Record<string, z.ZodType>)) {
    const num = numberSchema(schema);
    if (!num) continue;
    const spec = TWEAKS[templateId]?.[name];
    const given = params[name];
    const value = typeof given === "number" ? given : spec?.default;
    if (value === undefined || !Number.isFinite(value)) continue;
    const c = { ...years, value };
    const at = (b: Bound) => (typeof b === "function" ? b(c) : b);
    const lo = num.minValue !== null && Number.isFinite(num.minValue) ? num.minValue : -Infinity;
    const hi = num.maxValue !== null && Number.isFinite(num.maxValue) ? num.maxValue : Infinity;
    const min = spec ? at(spec.min) : Number.isFinite(lo) ? lo : 0;
    const max = spec ? at(spec.max) : Number.isFinite(hi) ? hi : Math.max(value * 2, 100);
    out.push({
      name,
      label: spec?.label ?? humanize(name),
      value,
      // Within the schema's limits, and always around the current value.
      min: Math.min(Math.max(min, lo), value),
      max: Math.max(Math.min(max, hi), value),
      step: spec ? at(spec.step) : num.isInt ? 1 : 0.01,
      format: spec?.format ?? "number",
    });
  }
  return out;
}

// ------------------------------------------------------------------------------------------- builders

/**
 * One builder per view. Exported as an object (not loose functions) so a test can make one throw and check the
 * tool still answers.
 */
export const widgetBuilders = {
  /** run_monte_carlo / get_job, finished. `text` is the compact result the model reads; `raw` the full result. */
  monteCarloOutcome(
    env: WidgetEnv,
    planId: string,
    text: Record<string, unknown>,
    raw: MonteCarloResult,
  ): OutcomeView {
    const det = env.services.sim.projection(planId, { trace: "off" }).result;
    const fan = raw.percentiles.find((s) => s.metric === "netWorth");
    if (!fan) throw new Error("Monte Carlo result has no net worth percentiles");
    const band = (p: number) =>
      fan.bands.find((b) => Math.abs(b.p - p) < 1e-9)?.values.map((v) => roundMoney(v)) ?? null;
    const median = band(0.5);
    if (!median) throw new Error("Monte Carlo result has no median band");
    return {
      view: "outcome",
      plan: planRef(env, planId, VIEW_ROUTE.outcome),
      kind: "monte-carlo",
      // detail=full returns the raw result, which has no headline: make the same sentence.
      headline: typeof text.headline === "string" ? text.headline : mcHeadline(raw),
      outcome: numbersOfProjection(
        det,
        typeof text.successRate === "number" ? text.successRate : raw.successRate,
      ),
      years: fan.years,
      median,
      p10: band(0.1),
      p90: band(0.9),
      markers: markersOf(det),
      badCaseDepletionYear: badCaseDepletionYear(raw),
      trials: raw.trials,
    };
  },

  pending(env: WidgetEnv, planId: string, jobId: string, of: PendingView["of"]): PendingView {
    return {
      view: "pending",
      plan: planRef(env, planId, of === "answer" ? VIEW_ROUTE.answer : VIEW_ROUTE.pending),
      jobId,
      of,
    };
  },

  /** simulate_plan: the deterministic projection the text was cut from. */
  deterministicOutcome(env: WidgetEnv, planId: string, run: ProjectionResult): OutcomeView {
    const plan = planRef(env, planId, "/results");
    const s = run.summary;
    const series = netWorthSeries(run);
    const last = series.years[series.years.length - 1];
    const headline = s.success
      ? `The plan works: every year is fully funded, ending with ${formatMoney(s.endNetWorthReal, plan.currency)} in today's money${last ? ` in ${last}` : ""}.`
      : `The plan runs short from ${s.firstShortfallYear}: some years' spending cannot be fully funded.`;
    return {
      view: "outcome",
      plan,
      kind: "deterministic",
      headline,
      outcome: numbersOfProjection(run, null),
      years: series.years,
      median: series.values,
      p10: null,
      p90: null,
      markers: markersOf(run),
      badCaseDepletionYear: null,
      trials: null,
    };
  },

  /** preview_changes / preview_whatif / compare_plans. */
  compare(
    env: WidgetEnv,
    o: {
      planId: string;
      headlinePrefix: string;
      beforeLabel: string;
      afterLabel: string;
      before: OutcomeNumbers;
      after: OutcomeNumbers;
      beforeRun: ProjectionResult;
      afterRun: ProjectionResult;
      changes: readonly string[];
      ops: Record<string, unknown>[] | null;
      template: CompareView["template"];
    },
  ): CompareView {
    const plan = planRef(env, o.planId, VIEW_ROUTE.compare);
    const before = netWorthSeries(o.beforeRun);
    const after = netWorthSeries(o.afterRun);
    const afterByYear = new Map(after.years.map((y, i) => [y, after.values[i]!]));
    return {
      view: "compare",
      plan,
      headline: compareHeadline(o.before, o.after, plan.currency, o.headlinePrefix),
      beforeLabel: o.beforeLabel,
      afterLabel: o.afterLabel,
      before: o.before,
      after: o.after,
      years: before.years,
      beforeSeries: before.values,
      // A year the other side no longer reaches has nothing left in it.
      afterSeries: before.years.map((y) => afterByYear.get(y) ?? 0),
      changes: changesOf(o.changes),
      ops: o.ops,
      template: o.template,
    };
  },

  /** solve_*: `text` is the compact solver result the model reads. */
  answer(
    env: WidgetEnv,
    planId: string,
    solver: string,
    text: Record<string, unknown>,
    targetSuccessRate: number | null,
  ): AnswerView {
    const details = (text.details ?? {}) as Record<string, number | string | null>;
    const { figure, current } = solverFigure(solver, details, text.value);
    const ops = (text.ops ?? text.patch ?? null) as Record<string, unknown>[] | null;
    return {
      view: "answer",
      plan: planRef(env, planId, VIEW_ROUTE.answer),
      solver,
      answer: String(text.answer ?? text.explanation ?? ""),
      figure,
      current,
      targetSuccessRate,
      ops: ops?.length ? ops : null,
    };
  },

  /** propose_change_set / propose_revert: the stored change set, as the text describes it. */
  review(
    env: WidgetEnv,
    cs: {
      id: string;
      planId: string;
      status: ReviewView["status"];
      summary: string;
      rationale?: string | undefined;
      preview?: { before: OutcomeSummary; after: OutcomeSummary } | undefined;
    },
    changes: readonly string[],
  ): ReviewView {
    return {
      view: "review",
      plan: planRef(env, cs.planId, VIEW_ROUTE.review),
      changeSetId: cs.id,
      summary: cs.summary,
      rationale: cs.rationale ?? null,
      status: cs.status,
      changes: changesOf(changes),
      before: cs.preview ? outcomeNumbers(cs.preview.before) : null,
      after: cs.preview ? outcomeNumbers(cs.preview.after) : null,
      appliedVersion: null,
    };
  },

  /** explain_year: the same narrative the text was compacted from. */
  year(env: WidgetEnv, planId: string, n: YearNarrative): YearView {
    const plan = planRef(env, planId, VIEW_ROUTE.year);
    const services = env.services;
    const stored = services.plans.get(planId);
    const hh = services.households.get(stored.householdId);
    const run = services.sim.projection(planId, { trace: "full" }).result;
    const period = run.periods[n.periodIndex];
    const names = new Map(hh.household.people.map((p) => [p.id, p.name]));
    const ages = Object.entries(period?.ages ?? {})
      .filter(([id]) => period?.alive?.[id] !== false && names.has(id))
      .map(([id, age]) => `${names.get(id)} ${Math.floor(age)}`);

    const end = roundMoney(n.netWorth.end);
    const opening = openingNetWorth(hh.finances, hh.household.currency);
    const start = roundMoney(n.netWorth.start ?? opening);
    const steps = period
      ? yearSteps(n, period, run.periods[n.periodIndex - 1], {
          start,
          end,
          opening,
          finances: hh.finances,
          currency: hh.household.currency,
        })
      : [];
    const byAccount = new Map<string, number>();
    for (const w of n.withdrawals) byAccount.set(w.label, (byAccount.get(w.label) ?? 0) + w.amount);
    const withdrawals = [...byAccount]
      .map(([account, amount]) => ({ account, amount: roundMoney(amount) }))
      .filter((w) => w.amount > 0)
      .sort((a, b) => b.amount - a.amount);
    return {
      view: "year",
      plan,
      year: n.year,
      ages,
      narrative: n.sentences.join(" "),
      startNetWorth: start,
      endNetWorth: end,
      steps,
      withdrawals,
      shortfall: roundMoney(n.shortfall),
    };
  },

  /** tax_breakdown: `text` is the result the model reads; `lines` the same years with tax lines. */
  tax(env: WidgetEnv, planId: string, text: TaxBreakdownLike, lines: TaxBreakdownLike): TaxView {
    const plan = planRef(env, planId, VIEW_ROUTE.tax);
    const years = text.years.map((y) => y.year);
    const keys = new Set<string>();
    const perYear = text.years.map((y) => {
      const ls = lines.years.find((l) => l.year === y.year)?.lines ?? [];
      const byKind: Record<string, number> = {};
      for (const l of ls) {
        byKind[l.kind] = (byKind[l.kind] ?? 0) + l.amount;
        keys.add(l.kind);
      }
      // The stack adds up to the year's total in the text (credits, rounding).
      const rest = y.total - Object.values(byKind).reduce((t, v) => t + v, 0);
      if (rest !== 0) {
        byKind.other = (byKind.other ?? 0) + rest;
        keys.add("other");
      }
      return byKind;
    });
    const kinds = [...keys]
      .map((key) => ({
        key,
        label: TAX_KIND_LABELS[key] ?? humanize(key),
        values: perYear.map((b) => b[key] ?? 0),
      }))
      .filter((k) => k.values.some((v) => v !== 0))
      .sort((a, b) => sumOf(b.values) - sumOf(a.values));
    const run = env.services.sim.projection(planId, { trace: "off" }).result;
    const total = text.totals.total;
    const peak = text.years.reduce<{ year: number; total: number } | null>(
      (best, y) => (!best || y.total > best.total ? y : best),
      null,
    );
    const range = years.length ? ` from ${years[0]} to ${years[years.length - 1]}` : "";
    const unit = text.basis === "real" ? " in today's money" : "";
    return {
      view: "tax",
      plan,
      headline:
        `Lifetime tax ${formatMoney(total, plan.currency)}${unit}${range}` +
        (peak && peak.total > 0
          ? `; the most in ${peak.year} (${formatMoney(peak.total, plan.currency)}).`
          : "."),
      years,
      kinds,
      lifetimeTotal: total,
      retirementYear: run.summary.retirementYear,
    };
  },
};

export interface TaxBreakdownLike {
  basis: string;
  totals: { total: number };
  years: { year: number; total: number; lines?: { kind: string; amount: number }[] }[];
}

const sumOf = (xs: number[]) => xs.reduce((t, v) => t + v, 0);

const TAX_KIND_LABELS: Record<string, string> = {
  income: "Income tax",
  "capital-gains": "Capital gains tax",
  dividends: "Dividend tax",
  payroll: "Payroll tax",
  "self-employment": "Self-employment tax",
  niit: "Net investment income tax",
  amt: "Alternative minimum tax",
  irmaa: "Medicare IRMAA",
  "aca-reconciliation": "ACA reconciliation",
  penalty: "Penalties",
  wealth: "Wealth tax",
  property: "Property tax",
  local: "Local tax",
  credit: "Credits",
  other: "Other",
};

/**
 * The year the bad-markets case (the 10th percentile trial) first runs short: the first year by which at least a
 * tenth of the trials have failed. Null when fewer than a tenth ever fail.
 */
function badCaseDepletionYear(r: MonteCarloResult): number | null {
  const threshold = r.trials * 0.1;
  let cum = 0;
  for (const h of [...(r.failureYearHistogram ?? [])].sort((a, b) => a.year - b.year)) {
    cum += h.count;
    if (cum >= threshold && cum > 0) return h.year;
  }
  return null;
}

/**
 * The year's net-worth change as steps that add up to end minus start. The engine's period data allows: income,
 * gross investment returns, fees, spending (all funded expenses, loan payments included), taxes, the change in
 * value of property held all year, and the principal part of loan payments (spending that is not lost: it becomes
 * equity). In today's money the money held loses value to inflation; that is a step of its own. "Other" is what
 * the period data cannot attribute (property bought or sold, debt forgiven, currency moves).
 */
function yearSteps(
  n: YearNarrative,
  p: ProjectionResult["periods"][number],
  prev: ProjectionResult["periods"][number] | undefined,
  o: {
    start: number;
    end: number;
    opening: number;
    finances: ReturnType<Services["households"]["get"]>["finances"];
    currency: string;
  },
): YearView["steps"] {
  const sumOf = <T>(xs: readonly T[], f: (x: T) => number) => xs.reduce((t, x) => t + f(x), 0);
  // Nominal amounts, as the engine reports them (the narrative's lines, before conversion).
  const income = sumOf(
    p.income.filter((l) => l.amount > 0),
    (l) => l.amount,
  );
  const spending = sumOf(
    p.expenses.filter((e) => e.funded > 0),
    (e) => e.funded,
  );
  const taxes = Math.max(0, p.taxes.total);
  const returns = sumOf(p.accounts, (a) => a.growth + a.dividends);
  const fees = sumOf(p.accounts, (a) => a.fees);
  const { convert } = baseConverter(o.finances, o.currency);
  const prevValue = (id: string): number | null => {
    if (prev) {
      const a = prev.realAssets.find((x) => x.assetId === id);
      return a?.owned ? a.value : null;
    }
    const r = o.finances.realAssets.find((x) => x.id === id && !x.archived);
    return r ? convert(r.currentValue, r.currency) : null;
  };
  const property = sumOf(p.realAssets, (a) => {
    const before = prevValue(a.assetId);
    // Held all year: not bought or sold this year (the engine reports 0 for neither).
    const held = a.owned && before !== null && !a.purchasePrice && !a.saleProceeds;
    return held ? a.value - before : 0;
  });
  const principal =
    sumOf(p.realAssets, (a) => a.loanPayments - a.loanInterest) +
    sumOf(p.debts, (d) => d.payments - d.interest);
  const nominalChange = p.totals.netWorth - (prev ? prev.totals.netWorth : o.opening);
  const unexplained =
    nominalChange - (income + returns - fees - spending - taxes + property + principal);

  const conv = (v: number) => roundMoney(inBasis(v, p, n.basis, "flow"));
  const steps: YearView["steps"] = [
    { label: "Income", amount: conv(income), kind: "income" },
    { label: "Investment returns", amount: conv(returns), kind: "return" },
    { label: "Investment fees", amount: -conv(fees), kind: "spending" },
    { label: "Spending", amount: -conv(spending), kind: "spending" },
    { label: "Taxes", amount: -conv(taxes), kind: "tax" },
    { label: "Home and property value", amount: conv(property), kind: "return" },
    { label: "Loan principal repaid (kept as equity)", amount: conv(principal), kind: "saving" },
    { label: "Other", amount: conv(unexplained), kind: "other" },
  ];
  // The rest is inflation (today's money: the year's start and end are in different years' money) and rounding,
  // which goes to the largest step rather than showing as a $1 "Other".
  const rest = o.end - o.start - steps.reduce((t, s) => t + s.amount, 0);
  if (n.basis === "real" && Math.abs(rest) > 2)
    steps.push({ label: "Inflation (today's money)", amount: rest, kind: "other" });
  else
    steps.reduce((big, s) => (Math.abs(s.amount) > Math.abs(big.amount) ? s : big)).amount += rest;
  return steps.filter((s) => s.amount !== 0 || s.kind === "income");
}

/** Net worth today (the first year's start): accounts and property less loans and debts, in the base currency. */
function openingNetWorth(
  f: ReturnType<Services["households"]["get"]>["finances"],
  currency: string,
): number {
  const { convert } = baseConverter(f, currency);
  const live = <T extends { archived?: boolean | undefined }>(xs: readonly T[]) =>
    xs.filter((x) => !x.archived);
  return (
    live(f.accounts).reduce((t, a) => t + convert(a.balance, a.currency), 0) +
    live(f.realAssets).reduce(
      (t, r) => t + convert(r.currentValue - (r.loan?.balance ?? 0), r.currency),
      0,
    ) -
    live(f.debts).reduce((t, d) => t + convert(d.balance, d.currency), 0)
  );
}

function solverFigure(
  solver: string,
  d: Record<string, number | string | null>,
  value: unknown,
): Pick<AnswerView, "figure" | "current"> {
  const num = (k: string) => (typeof d[k] === "number" ? (d[k] as number) : null);
  const str = (k: string) => (typeof d[k] === "string" ? (d[k] as string) : null);
  const current = (label: string, v: number | string | null) =>
    v === null ? null : { label, value: v };
  switch (solver) {
    case "max-spending":
      return {
        figure: {
          label: "Sustainable spending a year",
          value: num("annualSpending"),
          format: "money",
        },
        current: current("Planned spending a year", num("currentAnnualSpending")),
      };
    case "earliest-retirement":
      return {
        figure: { label: "Earliest retirement", value: str("month"), format: "month" },
        current: current("Planned retirement", str("currentMonth")),
      };
    case "required-savings":
      // A percentage flow answers with a share; an amount flow (or no answer) with money.
      return num("share") !== null
        ? {
            figure: { label: "Share to save", value: num("share"), format: "percent" },
            current: null,
          }
        : {
            figure: {
              label: "Contribution needed a year",
              value: num("annualContribution"),
              format: "money",
            },
            current: current("Contributing now a year", num("currentAnnualContribution")),
          };
    case "required-portfolio":
      return {
        figure: { label: "Portfolio needed", value: num("requiredPortfolio"), format: "money" },
        current: current("Invested now", num("currentPortfolio")),
      };
    case "safe-withdrawal-rate":
      return {
        figure: { label: "Safe withdrawal rate", value: num("rate"), format: "percent" },
        current: null,
      };
    default:
      return {
        figure: {
          label: "Answer",
          value: typeof value === "number" ? value : null,
          format: "number",
        },
        current: null,
      };
  }
}
