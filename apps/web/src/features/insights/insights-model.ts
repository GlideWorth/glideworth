/** What-if scenario gallery and one-at-a-time sensitivity (tornado), on the deterministic engine. */

import type { Plan, ProjectionResult, SimulationInput } from "@glideworth/core";
import { total } from "../../lib/money";
import { runSimulation } from "../../workers/sim-client";
import {
  crash,
  crashSchedule,
  inputFor,
  jobLoss,
  marketWith,
  scaleExpenses,
  scaleFlows,
  scaleIncome,
  shiftMilestoneAge,
  shiftRate,
  type Variant,
} from "./plan-edits";

export interface ScenarioDef {
  id: string;
  title: string;
  description: string;
  icon:
    | "crash"
    | "job"
    | "retire-early"
    | "retire-late"
    | "inflation"
    | "returns"
    | "spend-up"
    | "spend-down"
    | "longevity"
    | "save-more";
  build: (plan: Plan, base: ProjectionResult, asOf: string) => Variant | null;
}

const retireIndex = (base: ProjectionResult) => {
  const i = base.periods.findIndex((p) => p.year === base.summary.retirementYear);
  return Math.max(0, i);
};
const nonEmpty = (v: Variant | null): Variant | null => (v?.changes.length ? v : null);

export const SCENARIOS: ScenarioDef[] = [
  {
    id: "crash-now",
    title: "Market crash now",
    description: "Stocks fall 35% this year and 12% next, then recover at the plan’s rates.",
    icon: "crash",
    build: (plan, base) => ({
      plan,
      market: crash(base, 0),
      changes: ["Stocks −35% in the first year, −12% in the second"],
      persist: crashSchedule(plan, base.periods[0]!.year, [-0.35, -0.12]),
    }),
  },
  {
    id: "crash-retire",
    title: "Crash at retirement",
    description: "The same crash, timed for the first years of retirement — the worst sequence.",
    icon: "crash",
    build: (plan, base) => {
      const i = retireIndex(base);
      if (!i) return null;
      return {
        plan,
        market: crash(base, i),
        changes: [`Stocks −35% in ${base.periods[i]!.year}, −12% the year after`],
        persist: crashSchedule(plan, base.periods[i]!.year, [-0.35, -0.12]),
      };
    },
  },
  {
    id: "job-loss",
    title: "Job loss for a year",
    description: "The main salary stops for 12 months, then resumes.",
    icon: "job",
    build: (plan, _b, asOf) => nonEmpty(jobLoss(plan, asOf)),
  },
  {
    id: "retire-early",
    title: "Retire 3 years earlier",
    description: "Bring every retirement milestone forward by three years.",
    icon: "retire-early",
    build: (plan) => nonEmpty(shiftMilestoneAge(plan, "retirement", -3)),
  },
  {
    id: "retire-late",
    title: "Work 2 more years",
    description: "Delay retirement by two years.",
    icon: "retire-late",
    build: (plan) => nonEmpty(shiftMilestoneAge(plan, "retirement", 2)),
  },
  {
    id: "high-inflation",
    title: "Higher inflation",
    description: "Inflation runs 1.5 points higher every year; returns do not keep up.",
    icon: "inflation",
    build: (plan, base) => ({
      plan,
      market: marketWith(base, (m) => ({ ...m, inflation: m.inflation + 0.015 })),
      changes: ["Inflation +1.5 percentage points a year"],
      persist: shiftRate(plan, "inflation", 0.015)?.plan,
    }),
  },
  {
    id: "low-returns",
    title: "Lower returns",
    description: "Stocks return 2 points less every year for the whole plan.",
    icon: "returns",
    build: (plan, base) => ({
      plan,
      market: marketWith(base, (m) => ({ ...m, stocks: m.stocks - 0.02 })),
      changes: ["Stock returns −2 percentage points a year"],
      persist: shiftRate(plan, "stockReturn", -0.02)?.plan,
    }),
  },
  {
    id: "spend-up",
    title: "Spend 10% more",
    description: "Every expense is 10% higher.",
    icon: "spend-up",
    build: (plan) => nonEmpty(scaleExpenses(plan, 1.1)),
  },
  {
    id: "save-more",
    title: "Save 20% more",
    description: "Fixed contributions rise by a fifth.",
    icon: "save-more",
    build: (plan) => nonEmpty(scaleFlows(plan, 1.2)),
  },
  {
    id: "longevity",
    title: "Live 5 years longer",
    description: "Every life expectancy moves out by five years.",
    icon: "longevity",
    build: (plan) => nonEmpty(shiftMilestoneAge(plan, "life-expectancy", 5)),
  },
];

export interface Outcome {
  endNetWorthReal: number;
  firstShortfallYear: number | null;
  totalShortfallReal: number;
  lifetimeTaxesReal: number;
  retirementYear: number | null;
  success: boolean;
  netWorthReal: number[];
}

export function outcomeOf(r: ProjectionResult): Outcome {
  return {
    endNetWorthReal: r.summary.endNetWorthReal,
    firstShortfallYear: r.summary.firstShortfallYear,
    totalShortfallReal: r.periods.reduce((s, p) => s + total(p, "shortfall", "real"), 0),
    lifetimeTaxesReal: r.summary.lifetimeTaxesReal,
    retirementYear: r.summary.retirementYear,
    success: r.summary.success,
    netWorthReal: r.periods.map((p) => total(p, "netWorth", "real")),
  };
}

export async function runVariant(base: SimulationInput, v: Variant): Promise<ProjectionResult> {
  return (await runSimulation(inputFor(base, v))).result;
}

// ---------------------------------------------------------------------------------------------
// Sensitivity
// ---------------------------------------------------------------------------------------------

export interface SensitivityDriver {
  id: string;
  label: string;
  low: { label: string; v: (plan: Plan, base: ProjectionResult) => Variant | null };
  high: { label: string; v: (plan: Plan, base: ProjectionResult) => Variant | null };
}

export const DRIVERS: SensitivityDriver[] = [
  {
    id: "returns",
    label: "Stock returns",
    low: {
      label: "−1 pt",
      v: (p, b) => ({
        plan: p,
        market: marketWith(b, (m) => ({ ...m, stocks: m.stocks - 0.01 })),
        changes: [],
      }),
    },
    high: {
      label: "+1 pt",
      v: (p, b) => ({
        plan: p,
        market: marketWith(b, (m) => ({ ...m, stocks: m.stocks + 0.01 })),
        changes: [],
      }),
    },
  },
  {
    id: "inflation",
    label: "Inflation",
    low: {
      label: "+1 pt",
      v: (p, b) => ({
        plan: p,
        market: marketWith(b, (m) => ({ ...m, inflation: m.inflation + 0.01 })),
        changes: [],
      }),
    },
    high: {
      label: "−1 pt",
      v: (p, b) => ({
        plan: p,
        market: marketWith(b, (m) => ({ ...m, inflation: Math.max(0, m.inflation - 0.01) })),
        changes: [],
      }),
    },
  },
  {
    id: "spending",
    label: "Spending",
    low: { label: "+10%", v: (p) => nonEmpty(scaleExpenses(p, 1.1)) },
    high: { label: "−10%", v: (p) => nonEmpty(scaleExpenses(p, 0.9)) },
  },
  {
    id: "retirement",
    label: "Retirement age",
    low: { label: "−2 years", v: (p) => nonEmpty(shiftMilestoneAge(p, "retirement", -2)) },
    high: { label: "+2 years", v: (p) => nonEmpty(shiftMilestoneAge(p, "retirement", 2)) },
  },
  {
    id: "earnings",
    label: "Earnings",
    low: { label: "−10%", v: (p) => nonEmpty(scaleIncome(p, 0.9)) },
    high: { label: "+10%", v: (p) => nonEmpty(scaleIncome(p, 1.1)) },
  },
  {
    id: "saving",
    label: "Contributions",
    low: { label: "−25%", v: (p) => nonEmpty(scaleFlows(p, 0.75)) },
    high: { label: "+25%", v: (p) => nonEmpty(scaleFlows(p, 1.25)) },
  },
  {
    id: "longevity",
    label: "Life expectancy",
    low: { label: "+5 years", v: (p) => nonEmpty(shiftMilestoneAge(p, "life-expectancy", 5)) },
    high: { label: "−3 years", v: (p) => nonEmpty(shiftMilestoneAge(p, "life-expectancy", -3)) },
  },
];

export type SensitivityMetric = "endNetWorth" | "fundedYears";

export interface TornadoRow {
  id: string;
  label: string;
  lowLabel: string;
  highLabel: string;
  low: number | null;
  high: number | null;
}

export function metricOf(r: ProjectionResult, m: SensitivityMetric): number {
  return m === "endNetWorth"
    ? r.summary.endNetWorthReal
    : r.periods.filter((p) => p.status === "ok").length;
}

/** One-at-a-time sensitivity; each variant runs in the worker. */
export async function runSensitivity(
  input: SimulationInput,
  base: ProjectionResult,
  metric: SensitivityMetric,
  onProgress?: (done: number, total: number) => void,
): Promise<{ base: number; rows: TornadoRow[] }> {
  const rows: TornadoRow[] = [];
  const total = DRIVERS.length * 2;
  let done = 0;
  for (const d of DRIVERS) {
    const val = async (side: "low" | "high") => {
      const v = d[side].v(input.plan, base);
      done++;
      onProgress?.(done, total);
      if (!v) return null;
      try {
        return metricOf(await runVariant(input, v), metric);
      } catch {
        return null;
      }
    };
    const low = await val("low");
    const high = await val("high");
    rows.push({
      id: d.id,
      label: d.label,
      lowLabel: d.low.label,
      highLabel: d.high.label,
      low,
      high,
    });
  }
  const b = metricOf(base, metric);
  rows.sort((x, y) => spread(y, b) - spread(x, b));
  return { base: b, rows };
}

const spread = (r: TornadoRow, b: number) =>
  Math.abs((r.high ?? b) - b) + Math.abs((r.low ?? b) - b);
