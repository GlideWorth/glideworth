/**
 * Plan variants for what-if scenarios, sensitivity and goal-seek previews. Each edit returns a
 * NEW plan plus plain-language descriptions of what changed (so the UI can always explain a
 * variant, even before insights.diffPlans is available).
 */
import type { MarketPath, Plan, ProjectionResult, SimulationInput } from "@glideworth/core";

export interface Variant {
  plan: Plan;
  market?: MarketPath;
  changes: string[];
  /** Plan to save as a branch when the preview uses a market override (e.g. a crash schedule). */
  persist?: Plan;
}

/** Express a market shock as a stepped stock-return schedule (only when returns are a fixed rate). */
export function crashSchedule(plan: Plan, startYear: number, shocks: number[]): Plan | undefined {
  const spec = plan.assumptions.stockReturn;
  if (spec.kind !== "fixed") return undefined;
  const p = structuredClone(plan);
  p.assumptions = {
    ...p.assumptions,
    stockReturn: {
      kind: "schedule",
      interpolation: "step",
      points: [
        ...shocks.map((rate, i) => ({
          at: { kind: "date" as const, date: `${startYear + i}-01`, offsetMonths: 0 },
          rate,
        })),
        {
          at: { kind: "date" as const, date: `${startYear + shocks.length}-01`, offsetMonths: 0 },
          rate: spec.rate,
        },
      ],
    },
  };
  return p;
}

const clone = (p: Plan): Plan => structuredClone(p);
const pct = (k: number) => `${k > 1 ? "+" : "−"}${Math.round(Math.abs(k - 1) * 100)}%`;

export function scaleExpenses(plan: Plan, k: number, ids?: string[]): Variant {
  const p = clone(plan);
  let n = 0;
  p.expenses = p.expenses.map((e) => {
    if (ids && !ids.includes(e.id)) return e;
    const a = (e as { amount?: { value: number; basis: string } }).amount;
    if (!a) return e;
    n++;
    return { ...e, amount: { ...a, value: a.value * k } } as typeof e;
  });
  return {
    plan: p,
    changes: n ? [`Spending ${pct(k)} across ${n} expense${n > 1 ? "s" : ""}`] : [],
  };
}

export function scaleIncome(
  plan: Plan,
  k: number,
  types: string[] = ["salary", "hourly", "self-employment", "bonus"],
): Variant {
  const p = clone(plan);
  const names: string[] = [];
  p.income = p.income.map((e) => {
    const a = (e as { amount?: { value: number; basis: string } }).amount;
    if (!types.includes(e.type) || !a) return e;
    names.push(e.name);
    return { ...e, amount: { ...a, value: a.value * k } } as typeof e;
  });
  return { plan: p, changes: names.length ? [`Earnings ${pct(k)} (${names.join(", ")})`] : [] };
}

export function scaleFlows(plan: Plan, k: number, ids?: string[]): Variant {
  const p = clone(plan);
  const names: string[] = [];
  p.flows = p.flows.map((f) => {
    if (ids && !ids.includes(f.id)) return f;
    const m = (f as { method?: { kind: string; amount?: { value: number } } }).method;
    if (f.kind !== "contribution" || m?.kind !== "amount" || !m.amount) return f;
    names.push(f.name);
    return {
      ...f,
      method: { ...m, amount: { ...m.amount, value: m.amount.value * k } },
    } as typeof f;
  });
  return {
    plan: p,
    changes: names.length ? [`Contributions ${pct(k)} (${names.join(", ")})`] : [],
  };
}

/** Shift age-based criteria of milestones of a kind (retirement, life expectancy) by `years`. */
export function shiftMilestoneAge(
  plan: Plan,
  kind: string,
  years: number,
  personId?: string,
): Variant {
  const p = clone(plan);
  const changes: string[] = [];
  p.milestones = p.milestones.map((m) => {
    if (m.kind !== kind || (personId && m.personId !== personId)) return m;
    let touched = false;
    const criteria = m.criteria.map((c) => {
      if (c.kind !== "age") return c;
      touched = true;
      changes.push(`${m.name} moved from age ${c.age} to ${c.age + years}`);
      return { ...c, age: c.age + years };
    });
    return touched ? { ...m, criteria } : m;
  });
  return { plan: p, changes };
}

export function shiftRate(
  plan: Plan,
  key: "stockReturn" | "inflation" | "bondReturn",
  delta: number,
): Variant | null {
  const p = clone(plan);
  const spec = p.assumptions[key];
  if (spec.kind !== "fixed") return null;
  p.assumptions = { ...p.assumptions, [key]: { kind: "fixed", rate: spec.rate + delta } };
  const label =
    key === "stockReturn" ? "Stock return" : key === "inflation" ? "Inflation" : "Bond return";
  return {
    plan: p,
    changes: [
      `${label} ${(spec.rate * 100).toFixed(1)}% → ${((spec.rate + delta) * 100).toFixed(1)}% a year`,
    ],
  };
}

/** Market path equal to the base projection's realised rates, with optional per-period shocks. */
export function marketWith(
  base: ProjectionResult,
  edit: (m: MarketPath["periods"][number], i: number) => MarketPath["periods"][number],
): MarketPath {
  return { periods: base.periods.map((p, i) => edit({ ...p.market }, i)) };
}

export function crash(base: ProjectionResult, at: number, shocks = [-0.35, -0.12]): MarketPath {
  return marketWith(base, (m, i) =>
    i >= at && i < at + shocks.length ? { ...m, stocks: shocks[i - at]! } : m,
  );
}

/** Start the first earned income of `personId` 12 months late (a year without work). */
export function jobLoss(plan: Plan, asOf: string, personId?: string): Variant {
  const p = clone(plan);
  const [y, m] = asOf.split("-").map(Number);
  const back = `${y! + 1}-${String(m).padStart(2, "0")}`;
  const changes: string[] = [];
  let done = false;
  p.income = p.income.map((e) => {
    if (
      done ||
      !["salary", "hourly", "self-employment"].includes(e.type) ||
      (personId && e.owner !== personId)
    )
      return e;
    done = true;
    changes.push(`${e.name} pauses for 12 months (resumes ${back})`);
    return {
      ...e,
      range: { ...e.range, start: { kind: "date", date: back, offsetMonths: 0 } },
    } as typeof e;
  });
  return { plan: p, changes };
}

export function inputFor(base: SimulationInput, v: Variant): SimulationInput {
  const { lineage: _l, ...plan } = v.plan;
  return {
    ...base,
    plan: plan as Plan,
    options: { ...base.options, ...(v.market ? { market: v.market } : {}), trace: "summary" },
  };
}

/** Plan body ready to save (keeps identity fields of the base). */
export function asNewPlanBody(base: Plan, v: Variant, name: string, description: string): Plan {
  return { ...v.plan, id: base.id, name, description, isMain: false };
}
