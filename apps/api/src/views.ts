/** Compact, agent- and client-friendly projections of engine/stochastic results. Pure functions. */
import {
  type DifferenceAttribution,
  financeNames,
  fmtMoney,
  formatMonth,
  type GoalSeekResult,
  monthAtAge,
  type MonteCarloResult,
  type OptimisePlanResult,
  type OutcomeSummary,
  parseMonth,
  type Plan,
  type ProjectionResult,
  type RothConversionPlan,
  type SimWarning,
  type StrategyComparison,
  type ValueBasis,
  warningText,
  type YearNarrative,
} from "@glideworth/core";
import type { z } from "zod";
import { inBasis, totalInBasis } from "./money.js";
import type { ProjectionView, Series } from "./schemas.js";

const RATE_SERIES = new Set<Series>(["savingsRate", "withdrawalRate"]);
const DEFAULT_SERIES: Series[] = [
  "netWorth",
  "liquidNetWorth",
  "income",
  "spending",
  "taxes",
  "shortfall",
];

/** Fill `{token}` amounts so an API client sees currency, not the engine's placeholder. */
export function presentedWarnings(
  result: ProjectionResult,
  basis: ValueBasis,
  locale?: string,
): SimWarning[] {
  return result.warnings.map((w) => {
    if (!w.template || !w.amounts?.length) return w;
    const period = w.periodIndex !== null ? result.periods[w.periodIndex] : undefined;
    return {
      ...w,
      message: warningText(w, {
        basis,
        period,
        format: (v) => fmtMoney(v, { currency: result.meta.currency, locale }),
      }),
    };
  });
}

export const roundMoney = (n: number): number => Math.round(n);
const round4 = (n: number): number => Math.round(n * 10_000) / 10_000;

export function compactProjection(
  result: ProjectionResult,
  viewIn: z.input<typeof ProjectionView> | undefined,
  cached: boolean,
  locale?: string,
) {
  const view = viewIn ?? {};
  const basis: ValueBasis = view.basis ?? "real";
  const series = (view.series ?? DEFAULT_SERIES) as Series[];
  const every = view.everyNYears ?? 1;
  const include = new Set(view.include ?? ["summary", "milestones", "warnings"]);
  const inRange = result.periods.filter(
    (p) =>
      (view.fromYear === undefined || p.year >= view.fromYear) &&
      (view.toYear === undefined || p.year <= view.toYear),
  );
  const picked = inRange.filter((_, i) => i % every === 0 || i === inRange.length - 1);
  const years = picked.map((p) => {
    const row: Record<string, unknown> = {
      year: p.year,
      ages: Object.fromEntries(Object.entries(p.ages).map(([k, v]) => [k, Math.floor(v)])),
    };
    for (const s of series) {
      const v = p.totals[s];
      row[s] =
        v === null
          ? null
          : RATE_SERIES.has(s)
            ? round4(v)
            : roundMoney(totalInBasis(s, v, p, basis));
    }
    if (view.accountIds?.length) {
      row.accounts = Object.fromEntries(
        view.accountIds.map((id) => [
          id,
          roundMoney(inBasis(p.accounts.find((a) => a.accountId === id)?.closing ?? 0, p, basis)),
        ]),
      );
    }
    return row;
  });
  return {
    meta: {
      planId: result.meta.planId,
      planVersion: result.meta.planVersion,
      currency: result.meta.currency,
      basis,
      startMonth: result.meta.startMonth,
      endMonth: result.meta.endMonth,
      engineVersion: result.meta.engineVersion,
      cached,
    },
    ...(include.has("summary") ? { summary: result.summary } : {}),
    ...(include.has("milestones")
      ? {
          milestones: result.milestones.map((m) => ({
            id: m.milestoneId,
            name: m.name,
            status: m.status,
            month: m.month,
            ages: Object.fromEntries(Object.entries(m.ages).map(([k, v]) => [k, Math.floor(v)])),
          })),
        }
      : {}),
    ...(include.has("warnings")
      ? { warnings: presentedWarnings(result, basis, locale).slice(0, 25) }
      : {}),
    years,
    ...(include.has("trace") ? { trace: result.trace.slice(0, 200) } : {}),
  };
}

/** Headline numbers used for change-set previews and plan comparison. */
export function outcomeOf(
  result: ProjectionResult,
  successRate: number | null = null,
): OutcomeSummary {
  return {
    successRate,
    endNetWorthReal: result.summary.endNetWorthReal,
    lifetimeTaxesReal: result.summary.lifetimeTaxesReal,
    depletionYear: result.summary.firstShortfallYear,
    retirementYear: result.summary.retirementYear,
  };
}

export interface McViewOptions {
  detail?: "summary" | "full" | undefined;
  metrics?: string | undefined;
  percentiles?: string | undefined;
  everyNYears?: number | undefined;
}

/** Thin a Monte Carlo result: fewer metrics/percentiles/years, no per-trial rows unless asked. */
export function compactMonteCarlo(result: MonteCarloResult, o: McViewOptions = {}) {
  if (o.detail === "full") return result;
  const metrics = o.metrics ? o.metrics.split(",").map((s) => s.trim()) : ["netWorth"];
  const wanted = o.percentiles
    ? o.percentiles
        .split(",")
        .map(Number)
        .filter((n) => Number.isFinite(n))
    : [0.1, 0.5, 0.9];
  const every = o.everyNYears ?? 5;
  return {
    headline: mcHeadline(result),
    method: result.method,
    trials: result.trials,
    seed: result.seed,
    ...(result.dataset ? { dataset: result.dataset } : {}),
    ...(result.warnings?.length ? { warnings: result.warnings } : {}),
    successRate: result.successRate,
    outcomeCounts: result.outcomeCounts,
    ...failureAnalysis(result),
    percentiles: result.percentiles
      .filter((s) => metrics.includes(s.metric))
      .map((s) => {
        const idx = s.years
          .map((_, i) => i)
          .filter((i) => i % every === 0 || i === s.years.length - 1);
        return {
          metric: s.metric,
          years: idx.map((i) => s.years[i]),
          bands: s.bands
            .filter((b) => wanted.some((w) => Math.abs(w - b.p) < 1e-9))
            .map((b) => ({ p: b.p, values: idx.map((i) => roundMoney(b.values[i] ?? 0)) })),
        };
      }),
    milestoneTiming: result.milestoneTiming,
    ...(result.durationMs !== undefined ? { durationMs: result.durationMs } : {}),
    trialSummaries: undefined,
    note: "detail=summary: fan thinned, per-trial rows omitted. Request detail=full for everything.",
  };
}

/** One sentence an agent can quote: the chance of success and, when it can fail, when. */
export function mcHeadline(r: MonteCarloResult): string {
  const pct = `${Math.round(r.successRate * 1000) / 10}%`;
  const failed = r.trials - Math.round(r.successRate * r.trials);
  const years = r.failureYearHistogram ?? [];
  if (!failed)
    return `${pct} chance of success: none of the ${r.trials} trials ran short of money.`;
  const first = years[0];
  const peak = [...years].sort((a, b) => b.count - a.count)[0];
  return (
    `${pct} chance of success: ${failed} of ${r.trials} trials ran short` +
    (first && peak ? ` (earliest in ${first.year}, most often in ${peak.year}).` : ".")
  );
}

/**
 * Why and when it fails, for "why does it fail when it fails": the years first shortfalls land in,
 * whether early returns (sequence risk) separate success from failure, and the failures that happen
 * before versus after retirement. Absent when nothing failed and there is nothing to explain.
 */
function failureAnalysis(r: MonteCarloResult) {
  const failed = r.trials - Math.round(r.successRate * r.trials);
  if (!failed) return {};
  const hist = r.failureYearHistogram ?? [];
  let cum = 0;
  const median = hist.find((h) => {
    cum += h.count;
    return cum >= failed / 2;
  })?.year;
  const sr = r.sequenceRisk;
  const split = r.split;
  return {
    failureAnalysis: {
      failedTrials: failed,
      ...(hist.length
        ? {
            firstFailureYears: hist.slice(0, 12).map((h) => [h.year, h.count]),
            earliestFailureYear: hist[0]?.year,
            medianFirstFailureYear: median,
          }
        : {}),
      ...(sr
        ? {
            sequenceRisk: {
              window: `first ${sr.years} years from ${sr.anchor === "retirement" ? "retirement" : "plan start"}`,
              rankCorrelation: sr.rankCorrelation === null ? null : round4(sr.rankCorrelation),
              byEarlyReturnQuintile: sr.buckets.map((b) => ({
                earlyRealReturn: `${round4(b.fromReturn)}..${round4(b.toReturn)}`,
                successRate: round4(b.successRate),
              })),
            },
          }
        : {}),
      ...(split
        ? {
            failedBeforeMilestone: round4(split.failedBefore),
            failedAfterMilestone: round4(split.failedAfter),
          }
        : {}),
      ...(r.representativeTrials
        ? {
            worstTrial: {
              trial: r.representativeTrials.worst.trial,
              endNetWorthReal: roundMoney(r.representativeTrials.worst.endNetWorthReal),
            },
          }
        : {}),
      next: "Use explain_year on the earliest failure year (or explain_projection) for the mechanics, sensitivity for what moves it, and solve_max_spending / run_monte_carlo on a branch for fixes.",
    },
  };
}

type DateLike = { kind: string; [k: string]: unknown };

/** What a summary needs to name things and resolve dates: people's birth months, finance names by id. */
export interface PlanViewContext {
  currency?: string;
  people?: readonly { id: string; birthMonth: string }[];
  /** Account / real asset / debt names by id (core `financeNames`). */
  names?: Readonly<Record<string, string>>;
}

/** The summary context of a household record: its currency, people and finance names. */
export function planViewContext(rec: {
  household: { currency: string; people: readonly { id: string; birthMonth: string }[] };
  finances: Parameters<typeof financeNames>[0];
}): PlanViewContext {
  return {
    currency: rec.household.currency,
    people: rec.household.people,
    names: financeNames(rec.finances),
  };
}

/**
 * The calendar month a DateRef resolves to without running the plan (fixed dates and ages, with their
 * offsets), or null when it depends on the projection (plan start/end, milestones).
 */
function fixedMonth(d: DateLike | undefined, ctx: PlanViewContext = {}): number | null {
  if (!d) return null;
  const off = typeof d.offsetMonths === "number" ? d.offsetMonths : 0;
  if (d.kind === "date" && typeof d.date === "string") return parseMonth(d.date) + off;
  if (d.kind === "age" && typeof d.age === "number") {
    const p = ctx.people?.find((x) => x.id === d.personId);
    return p ? monthAtAge(parseMonth(p.birthMonth), d.age) + off : null;
  }
  return null;
}

/**
 * Plain-text description of a DateRef for compact plan summaries. Fixed dates are resolved with their offset
 * ("2027-12" +1 month reads "2028-01"); an age also gives its month when the person is known.
 */
export function describeDate(d: DateLike | undefined, ctx: PlanViewContext = {}): string {
  if (!d) return "?";
  const off =
    typeof d.offsetMonths === "number" && d.offsetMonths
      ? ` ${d.offsetMonths > 0 ? "+" : ""}${d.offsetMonths}mo`
      : "";
  const at = fixedMonth(d, ctx);
  switch (d.kind) {
    case "planStart":
      return `plan start${off}`;
    case "planEnd":
      return `plan end${off}`;
    case "never":
      return "never";
    case "date":
      return at === null ? `${d.date}${off}` : formatMonth(at);
    case "age":
      return `${d.personId} age ${d.age}${off}${at === null ? "" : ` (${formatMonth(at)})`}`;
    case "dependentAge":
      return `dependent ${d.dependentId} age ${d.age}${off}`;
    case "milestone":
      return `milestone ${d.milestoneId}${off}`;
    default:
      return d.kind;
  }
}

type Range = { start: DateLike; end: DateLike; endInclusive?: boolean };

/** `from` / `to` of a range, and how many months it runs when both ends are fixed months. */
function describeRange(r: Range | undefined, ctx: PlanViewContext) {
  const to = describeDate(r?.end, ctx);
  const a = fixedMonth(r?.start, ctx);
  const b = fixedMonth(r?.end, ctx);
  const months = a !== null && b !== null ? b - a + (r?.endInclusive ? 1 : 0) : null;
  return {
    from: describeDate(r?.start, ctx),
    to: r?.endInclusive ? `${to} (inclusive)` : to,
    ...(months !== null ? { months: Math.max(0, months) } : {}),
  };
}

type Evt = {
  id: string;
  name: string;
  type?: string;
  owner?: string;
  amount?: { value: number; basis: string };
  frequency?: string;
  range?: Range;
  enabled?: boolean;
};

const evt = (ctx: PlanViewContext) => (e: Evt) => ({
  id: e.id,
  name: e.name,
  ...(e.type ? { type: e.type } : {}),
  owner: e.owner,
  amount: e.amount ? `${e.amount.value} ${e.amount.basis}/${e.frequency}` : undefined,
  ...describeRange(e.range, ctx),
  ...(e.enabled === false ? { disabled: true } : {}),
});

const pct = (share: number) => `${Math.round(share * 10_000) / 100}%`;

/** A flow's amount in words: "40000 real/yearly", "50% of remaining surplus", "max"... */
function flowAmount(f: Plan["flows"][number]): string {
  const m = f.kind === "transfer" ? f.amount : f.method;
  switch (m.kind) {
    case "amount":
      return `${m.amount.value} ${m.amount.basis}/${m.frequency}`;
    case "percentOfRemaining":
      return `${pct(m.share)} of remaining surplus`;
    case "percentOfIncome":
      return `${pct(m.share)} of income ${m.incomeId}`;
    case "percentOfBalance":
      return `${pct(m.share)} of ${f.kind === "transfer" ? "the account" : "the debt"} balance per year`;
    case "max":
      return f.kind === "debtPaydown" ? "max (all remaining surplus)" : "max (up to the limit)";
    case "all":
      return "the whole balance";
    default:
      return (m as { kind: string }).kind;
  }
}

/** One flow of the savings waterfall, compact but complete enough to spot a wrong amount or date. */
function flowView(f: Plan["flows"][number], priority: number, ctx: PlanViewContext) {
  const name = (id: string) => ctx.names?.[id] ?? id;
  const target =
    f.kind === "contribution"
      ? { target: name(f.accountId), targetId: f.accountId }
      : f.kind === "debtPaydown"
        ? {
            target: name(f.targetId),
            targetId: f.targetId,
            ...(f.allocation ? { allocation: f.allocation.strategy } : {}),
          }
        : {
            source: name(f.fromAccountId),
            sourceId: f.fromAccountId,
            ...(f.to.kind === "account"
              ? { target: name(f.to.accountId), targetId: f.to.accountId }
              : { target: `external: ${f.to.label}` }),
          };
  return {
    id: f.id,
    name: f.name,
    kind: f.kind,
    priority,
    amount: flowAmount(f),
    ...target,
    ...describeRange(f.range as Range, ctx),
    mandatory: f.mandatory,
    ...(f.kind === "contribution" && f.strategy.kind === "target"
      ? { fillTo: `${f.strategy.target.value} ${f.strategy.target.basis}` }
      : {}),
    ...(f.kind === "contribution" && f.limit.kind !== "none"
      ? {
          limit:
            f.limit.kind === "custom"
              ? `${f.limit.amount.value} ${f.limit.amount.basis}`
              : "jurisdiction",
        }
      : {}),
    ...(f.enabled ? {} : { disabled: true }),
  };
}

/** Agent-friendly one-screen plan description (ids included so follow-up edits can address them). */
export function compactPlan(plan: Plan, ctx: PlanViewContext = {}) {
  // Accounts and assets the plan opens later are named too.
  const extra: PlanViewContext = {
    ...ctx,
    names: {
      ...Object.fromEntries(
        [...plan.plannedAccounts, ...plan.plannedRealAssets].map((x) => [x.id, x.name]),
      ),
      ...ctx.names,
    },
  };
  return {
    id: plan.id,
    name: plan.name,
    version: plan.version,
    householdId: plan.householdId,
    isMain: plan.isMain,
    status: plan.status,
    ...(plan.lineage
      ? { branchOf: plan.lineage.parentPlanId, parentVersion: plan.lineage.parentVersion }
      : {}),
    ...(extra.currency ? { currency: extra.currency } : {}),
    startingConditions: plan.startingConditions.kind,
    milestones: plan.milestones.map((m) => ({
      id: m.id,
      name: m.name,
      kind: m.kind,
      ...(m.personId ? { personId: m.personId } : {}),
      criteria: m.criteria.length,
    })),
    income: (plan.income as unknown as Evt[]).map(evt(extra)),
    expenses: (plan.expenses as unknown as Evt[]).map(evt(extra)),
    // In waterfall order: priority 1 is funded first.
    flows: plan.flows.map((f, i) => flowView(f, i + 1, extra)),
    leftover:
      plan.leftover.kind === "spend"
        ? "spend"
        : `save to ${plan.leftover.accountId ? (extra.names?.[plan.leftover.accountId] ?? plan.leftover.accountId) : "the first cash account"}`,
    assumptions: {
      inflation: plan.assumptions.inflation,
      end: plan.assumptions.end,
    },
    monteCarlo: {
      method: plan.monteCarlo.method,
      trials: plan.monteCarlo.trials,
      seed: plan.monteCarlo.seed,
    },
    notes: plan.notes
      ? `${plan.notes.slice(0, 300)}${plan.notes.length > 300 ? "..." : ""}`
      : undefined,
  };
}

// ------------------------------------------------------------------------------------- insights

type Detail = "summary" | "full";
const line = (l: { label: string; amount: number; kind: string }) => ({
  label: l.label,
  amount: roundMoney(l.amount),
  kind: l.kind,
});
const top = (ls: { label: string; amount: number; kind: string }[], n = 5) =>
  [...ls]
    .sort((a, b) => b.amount - a.amount)
    .slice(0, n)
    .map(line);

/** One year of "where did the money go". `summary` drops the ledger/trace evidence and trims line items. */
export function compactYearNarrative(n: YearNarrative, detail: Detail = "summary") {
  if (detail === "full") return n;
  return {
    year: n.year,
    periodIndex: n.periodIndex,
    basis: n.basis,
    sentences: n.sentences,
    inflows: top(n.inflows),
    outflows: top(n.outflows),
    withdrawals: top(n.withdrawals),
    contributions: top(n.contributions),
    investmentReturn: roundMoney(n.investmentReturn),
    netWorth: {
      start: n.netWorth.start === null ? null : roundMoney(n.netWorth.start),
      end: roundMoney(n.netWorth.end),
    },
    shortfall: roundMoney(n.shortfall),
  };
}

/** Which plan edits explain an outcome difference. `summary` leaves out the raw changes and ops. */
export function compactAttribution(a: DifferenceAttribution, detail: Detail = "summary") {
  if (detail === "full") return a;
  const r = a.metric === "successRate" ? round4 : roundMoney;
  return {
    metric: a.metric,
    base: r(a.base),
    other: r(a.other),
    total: r(a.total),
    interaction: r(a.interaction),
    contributions: a.contributions.map((c) => ({
      key: c.key,
      description: c.description,
      delta: c.delta === null ? null : r(c.delta),
      share: c.share === null ? null : round4(c.share),
      ...(c.error ? { error: c.error } : {}),
    })),
  };
}

/** Ranked tax-strategy candidates. `summary` keeps the headline numbers and only the best candidate's patch. */
export function compactStrategies(c: StrategyComparison, detail: Detail = "summary") {
  if (detail === "full") return c;
  const row = (e: StrategyComparison["baseline"]) => ({
    id: e.id,
    label: e.label,
    status: e.status,
    endNetWorthReal: e.endNetWorthReal === null ? null : roundMoney(e.endNetWorthReal),
    lifetimeTaxesReal: e.lifetimeTaxesReal === null ? null : roundMoney(e.lifetimeTaxesReal),
    success: e.success,
    successRate: e.successRate,
    score: e.score === null ? null : round4(e.score),
    ...(e.unsupported ? { unsupported: e.unsupported } : {}),
    ...(e.error ? { error: e.error } : {}),
  });
  return {
    objective: c.objective,
    explanation: c.explanation,
    baseline: row(c.baseline),
    ranked: c.ranked.slice(0, 6).map(row),
    ...(c.ranked.length > 6 ? { rankedTruncated: c.ranked.length } : {}),
    best: c.best ? { ...row(c.best), description: c.best.description, patch: c.best.patch } : null,
  };
}

/**
 * A plan-optimiser result an agent can relay: the best candidate with its ops, the baseline, and the
 * alternatives as a compact table (columns + rows). `full` adds every candidate's ops.
 */
export function compactOptimise(r: OptimisePlanResult, detail: Detail = "summary") {
  if (detail === "full") return r;
  const date = r.goal !== "max-end-net-worth";
  const row = (c: OptimisePlanResult["best"]) => [
    c.changes.length ? c.changes.join("; ") : "(plan as it is)",
    ...(date ? [c.month] : []),
    c.endNetWorthReal,
    c.feasible,
  ];
  const one = (c: OptimisePlanResult["best"]) => ({
    changes: c.changes,
    noShortfall: c.feasible,
    ...(date ? { month: c.month } : {}),
    endNetWorthReal: c.endNetWorthReal,
    lifetimeTaxesReal: c.lifetimeTaxesReal,
    firstShortfallYear: c.firstShortfallYear,
    ...(c.error ? { error: c.error } : {}),
  });
  return {
    goal: r.goal,
    ...(r.milestoneId ? { milestoneId: r.milestoneId, plannedMonth: r.plannedMonth } : {}),
    explanation: r.explanation,
    best: { ...one(r.best), ops: r.best.ops },
    baseline: one(r.baseline),
    alternatives: {
      columns: ["changes", ...(date ? ["month"] : []), "endNetWorthReal", "noShortfall"],
      rows: r.alternatives.map(row),
    },
    ...(r.milestoneOps.length ? { milestoneOps: r.milestoneOps } : {}),
    search: {
      method: r.method,
      status: r.status,
      evaluations: r.evaluations,
      candidates: r.candidatesEvaluated,
      spaceSize: r.spaceSize,
    },
  };
}

/**
 * A Roth conversion plan an agent can relay: the verdict and sentence, the comparison, and the years
 * with a conversion (each with its reason). Zero years are counted, not listed, unless detail is 'full'.
 */
export function compactRothPlan(r: RothConversionPlan, detail: Detail = "summary") {
  if (detail === "full") return r;
  const converting = r.schedule.filter((s) => s.amount > 0);
  return {
    status: r.status,
    verdict: r.verdict,
    summary: r.summary,
    outcomes: r.outcomes.map((o) => ({
      ...o,
      lifetimeTaxReal: roundMoney(o.lifetimeTaxReal),
      afterTaxEndWealthReal: roundMoney(o.afterTaxEndWealthReal),
      endNetWorthReal: roundMoney(o.endNetWorthReal),
      totalConvertedReal: roundMoney(o.totalConvertedReal),
    })),
    targets: r.targets,
    years: converting.map((s) => ({
      year: s.year,
      personId: s.personId,
      amount: roundMoney(s.amount),
      binding: s.binding,
      roomLeft: s.roomLeft === null ? null : roundMoney(s.roomLeft),
      taxOnConversion: roundMoney(s.taxOnConversion),
      reason: s.reason,
    })),
    yearsWithoutConversion: r.schedule.length - converting.length,
    ...(r.patch.length ? { patch: r.patch } : {}),
    assumptions: r.assumptions,
    converged: r.converged,
  };
}

/**
 * A goal-seek / solver result an agent can use directly: the sentence, the answer in money or dates
 * (`details`), the ops that apply it, and the neighbouring targets. The raw search trace (dozens of
 * evaluations) is reduced to a count unless detail is 'full'.
 */
export function compactSolver(r: GoalSeekResult, detail: Detail = "summary") {
  if (detail === "full") return r;
  return {
    answer: r.explanation,
    solverStatus: r.status ?? (r.converged ? "solved" : "not-converged"),
    converged: r.converged,
    value: r.value,
    achieved: r.achieved,
    ...(r.details ? { details: r.details } : {}),
    ...(r.sensitivity?.length ? { neighbours: r.sensitivity } : {}),
    ...(r.patch?.length
      ? {
          ops: r.patch.slice(0, 20),
          ...(r.patch.length > 20 ? { opsTruncated: r.patch.length } : {}),
          next: "To apply: preview_changes with ops, then propose_change_set; or create_branch with ops to explore it safely.",
        }
      : {}),
    evaluations: r.evaluations.length,
    seed: r.seed ?? null,
  };
}
