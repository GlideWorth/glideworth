/**
 * Costs that follow a dependant's age ("Add a cost" in About you). A cost is an ordinary expense
 * event carrying `dependentId` and `dependentAge` start and end dates, so it moves when the birth
 * month changes and the engine and MCP read it like any other expense. Amounts are always the
 * user's own: presets set the type, frequency and an editable age range, never a figure.
 */
import {
  type DateRef,
  type Dependent,
  type ExpenseEvent,
  type ExpenseType,
  type Frequency,
  formatMonth,
  type GlideworthDocument,
  monthAtAge,
  parseMonth,
  type Plan,
} from "@glideworth/core";
import { newExpense } from "../plan-editor/state/defaults";

export type DependentCostPreset = "childcare" | "school" | "college" | "support";

export interface PresetInfo {
  label: string;
  hint: string;
  type: ExpenseType;
  frequency: Extract<Frequency, "monthly" | "yearly">;
  startAge: number;
  /** End age (exclusive: the cost stops on that birthday). */
  endAge: (d: Dependent) => number;
}

/** Starting ages only; the user edits them. Support runs until the dependant's own independence. */
export const DEPENDENT_COST_PRESETS: Record<DependentCostPreset, PresetInfo> = {
  childcare: {
    label: "Childcare",
    hint: "Nursery, daycare or a nanny before school",
    type: "childcare",
    frequency: "monthly",
    startAge: 0,
    endAge: () => 5,
  },
  school: {
    label: "School",
    hint: "Fees, uniforms, trips and activities",
    type: "education",
    frequency: "yearly",
    startAge: 5,
    endAge: () => 18,
  },
  college: {
    label: "College",
    hint: "Tuition, housing and books",
    type: "education",
    frequency: "yearly",
    startAge: 18,
    endAge: () => 22,
  },
  support: {
    label: "Support",
    hint: "Food, clothes and everyday costs until they are independent",
    type: "dependent-support",
    frequency: "monthly",
    startAge: 0,
    endAge: (d) => Math.max(1, d.independentAtAge),
  },
};

export const PRESET_ORDER: DependentCostPreset[] = ["childcare", "school", "college", "support"];

export interface DependentCostDraft {
  preset: DependentCostPreset;
  name: string;
  /** Per `frequency`, in today's money. Null until the user enters it. */
  amount: number | null;
  frequency: "monthly" | "yearly";
  startAge: number;
  endAge: number;
  scope: "plan" | "all";
}

export function defaultDraft(d: Dependent, preset: DependentCostPreset): DependentCostDraft {
  const p = DEPENDENT_COST_PRESETS[preset];
  return {
    preset,
    name: `${d.name}’s ${p.label.toLowerCase()}`,
    amount: null,
    frequency: p.frequency,
    startAge: p.startAge,
    endAge: p.endAge(d),
    scope: "plan",
  };
}

export type DraftIssue = "amount" | "ages" | "name";

export function draftIssues(draft: DependentCostDraft): DraftIssue[] {
  const out: DraftIssue[] = [];
  if (!draft.name.trim()) out.push("name");
  if (draft.amount === null || !(draft.amount > 0)) out.push("amount");
  if (!(draft.startAge >= 0) || !(draft.endAge > draft.startAge) || draft.endAge > 130)
    out.push("ages");
  return out;
}

const ageRef = (dependentId: string, age: number): DateRef => ({
  kind: "dependentAge",
  dependentId,
  age,
  offsetMonths: 0,
});

/** The expense event for a draft. Throws if the draft has issues (check `draftIssues` first). */
export function buildDependentCost(
  d: Dependent,
  draft: DependentCostDraft,
  doc: Pick<GlideworthDocument, "household" | "finances">,
): ExpenseEvent {
  if (draftIssues(draft).length) throw new Error("incomplete dependant cost");
  const base = newExpense(DEPENDENT_COST_PRESETS[draft.preset].type, doc);
  return {
    ...base,
    name: draft.name.trim(),
    amount: { value: draft.amount!, basis: "real" },
    frequency: draft.frequency,
    range: {
      start: ageRef(d.id, draft.startAge),
      end: ageRef(d.id, draft.endAge),
      endInclusive: false,
    },
    dependentId: d.id,
  };
}

/** The plans a new cost goes into. */
export function targetPlans(plans: Plan[], refPlan: Plan | undefined, scope: "plan" | "all") {
  return scope === "all" ? plans : refPlan ? [refPlan] : [];
}

export interface LinkedCost {
  /** The expense as it is in the first plan that has it (the reference plan when it does). */
  expense: ExpenseEvent;
  plans: { id: string; name: string }[];
}

/** Expenses linked to a dependant, grouped by id across plans (one row per cost). */
export function linkedCosts(plans: Plan[], dependentId: string, refPlanId?: string): LinkedCost[] {
  const ordered = [
    ...plans.filter((p) => p.id === refPlanId),
    ...plans.filter((p) => p.id !== refPlanId),
  ];
  const byId = new Map<string, LinkedCost>();
  for (const plan of ordered)
    for (const e of plan.expenses) {
      if (e.dependentId !== dependentId) continue;
      const row = byId.get(e.id);
      if (row) row.plans.push({ id: plan.id, name: plan.name });
      else byId.set(e.id, { expense: e, plans: [{ id: plan.id, name: plan.name }] });
    }
  return [...byId.values()];
}

/** "Ages 0–5" when the cost follows this dependant's age at both ends, else null. */
export function ageSpan(e: ExpenseEvent, dependentId: string): { from: number; to: number } | null {
  const { start, end } = e.range;
  if (start.kind !== "dependentAge" || start.dependentId !== dependentId) return null;
  if (end.kind !== "dependentAge" || end.dependentId !== dependentId) return null;
  return { from: start.age, to: end.age };
}

/**
 * Whether a cost with these ages is already over for a dependant at `asOf` (it would never apply).
 */
export function alreadyPast(d: Dependent, endAge: number, asOf: string): boolean {
  return monthAtAge(parseMonth(d.birthMonth), endAge) <= parseMonth(asOf);
}

/**
 * A plan without one dependant: their linked costs go, and any other date that followed their age
 * is pinned to the month it resolved to, so nothing else moves or points at a missing dependant.
 */
export function planWithoutDependent(plan: Plan, d: Dependent): Plan {
  const birth = parseMonth(d.birthMonth);
  const pin = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(pin);
    if (!v || typeof v !== "object") return v;
    const o = v as Record<string, unknown>;
    if (o.kind === "dependentAge" && o.dependentId === d.id) {
      const date = formatMonth(monthAtAge(birth, Number(o.age)));
      return { kind: "date", date, offsetMonths: o.offsetMonths ?? 0 };
    }
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(o)) {
      if (k === "dependentId" && x === d.id) continue;
      out[k] = pin(x);
    }
    return out;
  };
  const kept = { ...plan, expenses: plan.expenses.filter((e) => e.dependentId !== d.id) };
  return pin(kept) as Plan;
}

/** True when a plan mentions the dependant anywhere (a linked cost or an age-based date). */
export function planMentions(plan: Plan, dependentId: string): boolean {
  return JSON.stringify(plan).includes(`"dependentId":${JSON.stringify(dependentId)}`);
}
