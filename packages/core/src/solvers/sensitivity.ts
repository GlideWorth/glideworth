/**
 * One-at-a-time sensitivity (tornado chart data): move each key assumption down and up, re-run, and
 * record the outcome. Every bar carries the plan patches it used, so the UI can "apply" a bar.
 */
import { parseMonth } from "../engine/dates.js";
import { type ProjectionResult, type SimulationInput, toBasis } from "../engine/types.js";
import { fmtPercent, pluralDuration } from "../insights/format.js";
import { applyPlanPatch } from "../insights/patch.js";
import type { PatchOp } from "../schema/changes.js";
import type { MonteCarloSettings } from "../schema/montecarlo.js";
import type { SolverDeps } from "./contracts.js";
import { checkAbort, isAbortError, makeMetric, runDeterministic } from "./search.js";
import { applyVariable, milestoneAtMonthPatch } from "./variables.js";

export type SensitivityMetric =
  | "endNetWorthReal"
  | "lifetimeTaxesReal"
  | "totalShortfallReal"
  | "successRate";

export interface SensitivityVariable {
  id: string;
  label: string;
  low: { label: string; patch: PatchOp[] };
  high: { label: string; patch: PatchOp[] };
}

export interface TornadoBar {
  id: string;
  label: string;
  lowLabel: string;
  highLabel: string;
  low: number;
  high: number;
  /** |high - low| */
  swing: number;
  lowPatch: PatchOp[];
  highPatch: PatchOp[];
}

export interface SensitivityResult {
  metric: SensitivityMetric;
  base: number;
  /** Sorted by swing, largest first. */
  bars: TornadoBar[];
  /** Variables that could not be evaluated (e.g. a feature not implemented yet), with the reason. */
  skipped: { id: string; reason: string }[];
}

export interface SensitivityOptions {
  metric?: SensitivityMetric;
  /** Default variable set uses these step sizes. */
  returnDelta?: number;
  inflationDelta?: number;
  spendingDelta?: number;
  incomeDelta?: number;
  retirementMonths?: number;
  lifeExpectancyYears?: number;
  /** Replace the default variable set. */
  variables?: SensitivityVariable[];
  monteCarlo?: MonteCarloSettings;
}

function rateVariable(
  input: SimulationInput,
  key: "stockReturn" | "bondReturn" | "inflation" | "cashReturn",
  label: string,
  delta: number,
): SensitivityVariable | null {
  const spec = input.plan.assumptions[key];
  if (spec.kind !== "fixed") return null;
  const mk = (r: number): PatchOp[] => [
    { op: "replace", path: `/assumptions/${key}`, value: { kind: "fixed", rate: r } },
  ];
  return {
    id: key,
    label,
    low: { label: fmtPercent(spec.rate - delta), patch: mk(spec.rate - delta) },
    high: { label: fmtPercent(spec.rate + delta), patch: mk(spec.rate + delta) },
  };
}

/** The default tornado: returns, inflation, spending, income, retirement date, life expectancy. */
export function defaultSensitivityVariables(
  input: SimulationInput,
  base: ProjectionResult,
  o: SensitivityOptions = {},
): SensitivityVariable[] {
  const out: SensitivityVariable[] = [];
  const rd = o.returnDelta ?? 0.01;
  const id = o.inflationDelta ?? 0.01;
  const sd = o.spendingDelta ?? 0.1;
  const incd = o.incomeDelta ?? 0.1;
  for (const v of [
    rateVariable(input, "stockReturn", "Stock returns", rd),
    rateVariable(input, "bondReturn", "Bond returns", rd),
    rateVariable(input, "inflation", "Inflation", id),
  ])
    if (v) out.push(v);
  const spendLow = applyVariable(input, { kind: "spendingScale" }, 1 - sd).patch ?? [];
  if (spendLow.length > 0)
    out.push({
      id: "spending",
      label: "Spending",
      low: { label: `-${fmtPercent(sd)}`, patch: spendLow },
      high: {
        label: `+${fmtPercent(sd)}`,
        patch: applyVariable(input, { kind: "spendingScale" }, 1 + sd).patch ?? [],
      },
    });
  const incomes = input.plan.income.filter((i) => i.enabled);
  if (incomes.length > 0) {
    const mk = (f: number): PatchOp[] =>
      incomes.map((i) => ({
        op: "replace",
        path: `/income/[id=${i.id}]/amount/value`,
        value: i.amount.value * f,
      }));
    out.push({
      id: "income",
      label: "Income",
      low: { label: `-${fmtPercent(incd)}`, patch: mk(1 - incd) },
      high: { label: `+${fmtPercent(incd)}`, patch: mk(1 + incd) },
    });
  }
  const months = o.retirementMonths ?? 24;
  const shift = pluralDuration(months / 12, "year");
  const primary = input.household.people.find((p) => p.role === "primary")?.id;
  const ret =
    input.plan.milestones.find(
      (m) => m.kind === "retirement" && m.enabled && (!m.personId || m.personId === primary),
    ) ?? input.plan.milestones.find((m) => m.kind === "retirement" && m.enabled);
  const resolved = ret ? base.milestones.find((m) => m.milestoneId === ret.id) : undefined;
  if (ret && resolved?.month) {
    const m = parseMonth(resolved.month);
    out.push({
      id: "retirement",
      label: ret.name,
      low: {
        label: `${shift} earlier`,
        patch: milestoneAtMonthPatch(input, ret.id, m - months),
      },
      high: {
        label: `${shift} later`,
        patch: milestoneAtMonthPatch(input, ret.id, m + months),
      },
    });
  }
  const le = o.lifeExpectancyYears ?? 5;
  for (const m of input.plan.milestones) {
    const c = m.criteria[0];
    if (m.kind !== "life-expectancy" || !m.enabled || m.criteria.length !== 1 || c?.kind !== "age")
      continue;
    const mk = (age: number): PatchOp[] => [
      { op: "replace", path: `/milestones/[id=${m.id}]/criteria/0/age`, value: age },
    ];
    out.push({
      id: `lifeExpectancy:${m.id}`,
      label: m.name,
      low: { label: `age ${c.age - le}`, patch: mk(c.age - le) },
      high: { label: `age ${c.age + le}`, patch: mk(c.age + le) },
    });
  }
  return out;
}

/** Tornado data for the chosen metric. Deterministic unless metric = 'successRate'. */
export async function sensitivityAnalysis(
  input: SimulationInput,
  opts: SensitivityOptions = {},
  deps: SolverDeps = {},
): Promise<SensitivityResult> {
  const metricName = opts.metric ?? "endNetWorthReal";
  const baseRun = runDeterministic(input, deps);
  const variables = opts.variables ?? defaultSensitivityVariables(input, baseRun, opts);
  const mc =
    metricName === "successRate"
      ? makeMetric(input, { kind: "successRate", target: 0 }, deps, opts.monteCarlo)
      : null;
  let done = 0;
  const score = async (i: SimulationInput): Promise<number> => {
    checkAbort(deps.signal);
    let v: number;
    if (mc) v = await mc.score(i);
    else {
      const s = runDeterministic(i, deps);
      if (metricName === "endNetWorthReal") v = s.summary.endNetWorthReal;
      else if (metricName === "lifetimeTaxesReal") v = s.summary.lifetimeTaxesReal;
      else
        v = s.periods.reduce((acc, p) => acc + toBasis(p.totals.shortfall, p, "real", "flow"), 0);
    }
    done += 1;
    deps.onProgress?.(done);
    return v;
  };
  const base = await score(input);
  const bars: TornadoBar[] = [];
  const skipped: { id: string; reason: string }[] = [];
  for (const v of variables) {
    try {
      const low = await score({ ...input, plan: applyPlanPatch(input.plan, v.low.patch) });
      const high = await score({ ...input, plan: applyPlanPatch(input.plan, v.high.patch) });
      bars.push({
        id: v.id,
        label: v.label,
        lowLabel: v.low.label,
        highLabel: v.high.label,
        low,
        high,
        swing: Math.abs(high - low),
        lowPatch: v.low.patch,
        highPatch: v.high.patch,
      });
    } catch (e) {
      if (isAbortError(e)) throw e;
      skipped.push({ id: v.id, reason: (e as Error).message });
    }
  }
  bars.sort((a, b) => b.swing - a.swing);
  return { metric: metricName, base, bars, skipped };
}
