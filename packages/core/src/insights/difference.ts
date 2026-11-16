/**
 * "What changed between two results, and which plan edits caused it?"
 *
 * `attributeDifference` replays each group of plan changes ONE AT A TIME on top of the base plan
 * and measures how far it moves the outcome; whatever the separate effects do not explain is
 * reported as `interaction`. `explainDifference` turns outcomes (+ an optional attribution) into an
 * Explanation with evidence.
 */
import { simulate as coreSimulate } from "../engine/simulate.js";
import { type ProjectionResult, type SimulationInput, toBasis } from "../engine/types.js";
import { ScenarioError } from "../errors.js";
import type { PatchOp, PlanChange, PlanDiff } from "../schema/changes.js";
import type { Plan } from "../schema/plan.js";
import type { SolverDeps } from "../solvers/contracts.js";
import { checkAbort, isAbortError, makeMetric } from "../solvers/search.js";
import type { Explanation, Finding } from "./contracts.js";
import { describeChange } from "./describe.js";
import { diffPlans } from "./diff.js";
import { fmtMoney, fmtPercent } from "./format.js";
import { applyPlanPatch } from "./patch.js";
import { parsePointer } from "./pointer.js";

export type AttributionMetric =
  | "endNetWorthReal"
  | "lifetimeTaxesReal"
  | "totalShortfallReal"
  | "successRate";

export interface AttributionContribution {
  /** Stable key of the change group, e.g. "/income/[id=salary]" or "/assumptions/stockReturn". */
  key: string;
  description: string;
  changes: PlanChange[];
  ops: PatchOp[];
  /** Metric with only this group applied, minus the base metric. null if not separable. */
  delta: number | null;
  /** delta / total change (null when total is ~0 or delta is null). */
  share: number | null;
  error?: string;
}

export interface DifferenceAttribution {
  metric: AttributionMetric;
  base: number;
  other: number;
  total: number;
  contributions: AttributionContribution[];
  /** Part of the total not explained by the separate effects (changes reinforcing / offsetting). */
  interaction: number;
}

function groupKey(op: PatchOp): string {
  const segs = parsePointer(op.path);
  const top = segs[0]?.kind === "key" ? segs[0].key : "";
  if (op.op === "move") return `order:/${top}`;
  const s1 = segs[1];
  if (s1?.kind === "id") return `/${top}/[id=${s1.id}]`;
  if (s1?.kind === "key" && s1.key === "-" && op.op === "add") {
    const id = (op.value as { id?: string } | undefined)?.id;
    return id ? `/${top}/[id=${id}]` : `/${top}`;
  }
  if (
    [
      "accountSettings",
      "realAssetSettings",
      "debtSettings",
      "assumptions",
      "tax",
      "monteCarlo",
    ].includes(top) &&
    s1
  )
    return `/${top}/${(s1 as { key: string }).key}`;
  return `/${top}`;
}

/** Group a diff's ops by the entity / setting they touch, preserving op order inside each group. */
export function groupPatch(
  diff: PlanDiff,
): { key: string; ops: PatchOp[]; changes: PlanChange[] }[] {
  const groups = new Map<string, { key: string; ops: PatchOp[]; changes: PlanChange[] }>();
  for (const op of diff.patch) {
    const k = groupKey(op);
    if (!groups.has(k)) groups.set(k, { key: k, ops: [], changes: [] });
    groups.get(k)!.ops.push(op);
  }
  for (const c of diff.changes) {
    const op = diff.patch.find((o) => o.path === c.path);
    const k = op ? groupKey(op) : c.path;
    groups.get(k)?.changes.push(c);
  }
  return [...groups.values()];
}

/** One-at-a-time replay attribution of the outcome difference between `base` and `otherPlan`. */
export async function attributeDifference(
  baseInput: SimulationInput,
  otherPlan: Plan,
  opts: { metric?: AttributionMetric; diff?: PlanDiff } = {},
  deps: SolverDeps = {},
): Promise<DifferenceAttribution> {
  const metric = opts.metric ?? "endNetWorthReal";
  if (otherPlan.householdId !== baseInput.plan.householdId)
    throw new ScenarioError("the two plans belong to different households and cannot be compared", {
      baseHouseholdId: baseInput.plan.householdId,
      otherHouseholdId: otherPlan.householdId,
    });
  const diff =
    opts.diff ?? diffPlans(baseInput.plan, otherPlan, { currency: baseInput.household.currency });
  const sim = deps.simulate ?? ((i: SimulationInput) => coreSimulate(i));
  const mc =
    metric === "successRate"
      ? makeMetric(baseInput, { kind: "successRate", target: 0 }, deps)
      : null;
  let n = 0;
  const score = async (plan: Plan): Promise<number> => {
    checkAbort(deps.signal);
    const input = { ...baseInput, plan };
    let v: number;
    if (mc) v = await mc.score(input);
    else {
      const r = sim({ ...input, options: { ...input.options, trace: "off", lean: true } });
      v =
        metric === "endNetWorthReal"
          ? r.summary.endNetWorthReal
          : metric === "lifetimeTaxesReal"
            ? r.summary.lifetimeTaxesReal
            : r.periods.reduce((s, p) => s + toBasis(p.totals.shortfall, p, "real", "flow"), 0);
    }
    n += 1;
    deps.onProgress?.(n);
    return v;
  };
  const base = await score(baseInput.plan);
  const other = await score(applyPlanPatch(baseInput.plan, diff.patch));
  const total = other - base;
  const contributions: AttributionContribution[] = [];
  for (const g of groupPatch(diff)) {
    const description =
      g.changes.map((c) => c.description).join("; ") ||
      g.ops
        .map(
          (o) =>
            describeChange(o, { base: baseInput.plan, other: otherPlan, format: {} })
              ?.description ?? o.path,
        )
        .join("; ");
    try {
      const v = await score(applyPlanPatch(baseInput.plan, g.ops));
      const delta = v - base;
      contributions.push({
        key: g.key,
        description,
        changes: g.changes,
        ops: g.ops,
        delta,
        share: Math.abs(total) > 1e-9 ? delta / total : null,
      });
    } catch (e) {
      if (isAbortError(e)) throw e;
      contributions.push({
        key: g.key,
        description,
        changes: g.changes,
        ops: g.ops,
        delta: null,
        share: null,
        error: (e as Error).message,
      });
    }
  }
  contributions.sort((a, b) => Math.abs(b.delta ?? 0) - Math.abs(a.delta ?? 0));
  const explained = contributions.reduce((s, c) => s + (c.delta ?? 0), 0);
  return { metric, base, other, total, contributions, interaction: total - explained };
}

function metricLabel(m: AttributionMetric): string {
  return m === "endNetWorthReal"
    ? "ending net worth (today's money)"
    : m === "lifetimeTaxesReal"
      ? "lifetime taxes (today's money)"
      : m === "totalShortfallReal"
        ? "unfunded spending (today's money)"
        : "chance of success";
}

/** "What changed between these two results, and which plan edits caused it?" */
export function explainDifference(
  base: ProjectionResult,
  other: ProjectionResult,
  diff: PlanDiff,
  attribution?: DifferenceAttribution,
  opts: { currency?: string; locale?: string } = {},
): Explanation {
  const fmt = {
    ...((opts.currency ?? base.meta.currency)
      ? { currency: opts.currency ?? base.meta.currency }
      : {}),
    ...(opts.locale ? { locale: opts.locale } : {}),
  };
  const m = (v: number) => fmtMoney(v, fmt);
  const signed = (v: number) => `${v >= 0 ? "+" : "-"}${m(Math.abs(v))}`;
  const a = base.summary;
  const b = other.summary;
  const dNw = b.endNetWorthReal - a.endNetWorthReal;
  const dTax = b.lifetimeTaxesReal - a.lifetimeTaxesReal;
  const findings: Finding[] = [];
  findings.push({
    code: "OUTCOME_DELTA",
    severity: "info",
    title: "Outcome change",
    message: `Ending net worth ${m(a.endNetWorthReal)} → ${m(b.endNetWorthReal)} (${signed(dNw)}); lifetime taxes ${m(a.lifetimeTaxesReal)} → ${m(b.lifetimeTaxesReal)} (${signed(dTax)}), all in today's money.`,
    periodIndex: null,
    refs: [],
    evidence: [
      { source: "summary", plan: "base", ...a },
      { source: "summary", plan: "other", ...b },
    ],
  });
  if (a.success !== b.success || a.firstShortfallYear !== b.firstShortfallYear)
    findings.push({
      code: "SUCCESS_CHANGED",
      severity: b.success ? "info" : "warning",
      title: b.success ? "The plan now works" : "The plan now runs short",
      message: b.success
        ? `The base plan ran short from ${a.firstShortfallYear}; the new one funds every year.`
        : a.success
          ? `The new plan runs short from ${b.firstShortfallYear}; the base plan funded every year.`
          : `The first shortfall moves from ${a.firstShortfallYear} to ${b.firstShortfallYear}.`,
      periodIndex: null,
      refs: [],
      evidence: [
        {
          source: "summary",
          baseFirstShortfallYear: a.firstShortfallYear,
          otherFirstShortfallYear: b.firstShortfallYear,
        },
      ],
    });
  if (a.retirementYear !== b.retirementYear)
    findings.push({
      code: "RETIREMENT_MOVED",
      severity: "info",
      title: "Retirement year changed",
      message: `Retirement moves from ${a.retirementYear ?? "never"} to ${b.retirementYear ?? "never"}.`,
      periodIndex: null,
      refs: [],
      evidence: [{ source: "summary", base: a.retirementYear, other: b.retirementYear }],
    });
  // First year where net worth paths diverge by more than 1%.
  const n = Math.min(base.periods.length, other.periods.length);
  for (let i = 0; i < n; i++) {
    const x = base.periods[i]!.totals.netWorth;
    const y = other.periods[i]!.totals.netWorth;
    if (Math.abs(y - x) > Math.max(1, 0.01 * Math.abs(x))) {
      findings.push({
        code: "PATHS_DIVERGE",
        severity: "info",
        title: `Paths diverge in ${base.periods[i]!.year}`,
        message: `Net worth first differs by more than 1% in ${base.periods[i]!.year}: ${m(x / base.periods[i]!.priceIndex)} vs ${m(y / other.periods[i]!.priceIndex)} (today's money).`,
        periodIndex: i,
        refs: [],
        evidence: [
          { source: "period", periodIndex: i, field: "totals.netWorth", base: x, other: y },
        ],
      });
      break;
    }
  }
  if (attribution) {
    for (const c of attribution.contributions) {
      const isMoney = attribution.metric !== "successRate";
      const amount =
        c.delta === null
          ? "could not be measured on its own"
          : isMoney
            ? signed(c.delta)
            : `${c.delta >= 0 ? "+" : ""}${(c.delta * 100).toFixed(1)} points`;
      findings.push({
        code: "CHANGE_IMPACT",
        severity: "info",
        title: c.description.slice(0, 120),
        message: `${c.description}: ${amount} to ${metricLabel(attribution.metric)}${c.share !== null ? ` (${fmtPercent(c.share)} of the total change)` : ""}.`,
        periodIndex: null,
        refs: c.changes.map((x) => x.entity.id).filter((x): x is string => !!x),
        evidence: [
          { source: "replay", key: c.key, metric: attribution.metric, delta: c.delta, ops: c.ops },
        ],
      });
    }
    if (Math.abs(attribution.interaction) > 1e-6 * Math.max(1, Math.abs(attribution.total)))
      findings.push({
        code: "CHANGE_INTERACTION",
        severity: "info",
        title: "Changes interact",
        message: `${attribution.metric === "successRate" ? `${(attribution.interaction * 100).toFixed(1)} points` : signed(attribution.interaction)} of the change comes from the edits working together rather than from any one alone.`,
        periodIndex: null,
        refs: [],
        evidence: [
          { source: "replay", interaction: attribution.interaction, total: attribution.total },
        ],
      });
  } else {
    for (const c of diff.changes)
      findings.push({
        code: "PLAN_CHANGE",
        severity: "info",
        title: c.description.slice(0, 120),
        message: c.description,
        periodIndex: null,
        refs: c.entity.id ? [c.entity.id] : [],
        evidence: [{ source: "diff", path: c.path, kind: c.kind }],
      });
  }
  const top = attribution?.contributions.find((c) => c.delta !== null);
  const headline =
    `Ending net worth ${dNw >= 0 ? "rises" : "falls"} by ${m(Math.abs(dNw))} (today's money)` +
    (a.success !== b.success
      ? b.success
        ? " and the plan now works"
        : " and the plan now runs short"
      : "") +
    (top && attribution?.metric === "endNetWorthReal"
      ? `; the biggest driver is: ${top.description}`
      : "") +
    ".";
  return { headline, findings };
}
