/** Applying a solver variable's candidate value to a simulation input (as a plan patch where possible). */
import { formatMonth, parseMonth } from "../engine/dates.js";
import type { SimulationInput } from "../engine/types.js";
import { ScenarioError } from "../errors.js";
import { applyPlanPatch } from "../insights/patch.js";
import { parsePointer } from "../insights/pointer.js";
import type { PatchOp } from "../schema/changes.js";
import type { ExpenseEvent } from "../schema/events.js";
import type { CurrentFinances, Plan } from "../schema/plan.js";
import { FREQUENCY_PER_YEAR } from "../schema/primitives.js";
import type { SolverVariable } from "./contracts.js";

/** Month index of the plan start (snapshot plans start at their own asOf). */
export function planStartMonth(input: SimulationInput): number {
  const sc = input.plan.startingConditions;
  return parseMonth(sc.kind === "snapshot" ? sc.finances.asOf : input.finances.asOf);
}

export function planFinances(input: SimulationInput): CurrentFinances {
  const sc = input.plan.startingConditions;
  return sc.kind === "snapshot" ? sc.finances : input.finances;
}

const NON_SPENDING_TYPES = new Set(["tax-payment", "tax-deduction"]);

/** Expenses scaled by a spendingScale variable. */
export function scaledExpenses(plan: Plan, expenseIds?: string[]): ExpenseEvent[] {
  if (expenseIds && expenseIds.length > 0) {
    const ids = new Set(expenseIds);
    const found = plan.expenses.filter((e) => ids.has(e.id));
    if (found.length !== ids.size)
      throw new ScenarioError("spendingScale references unknown expense ids", { expenseIds });
    return found;
  }
  return plan.expenses.filter(
    (e) => e.enabled && e.spendingType !== "not-spending" && !NON_SPENDING_TYPES.has(e.type),
  );
}

/** Sum of recurring (non one-off) amounts per year, in their entered basis (mostly today's money). */
export function annualRecurringAmount(expenses: ExpenseEvent[]): number {
  return expenses
    .filter((e) => e.frequency !== "once")
    .reduce((s, e) => s + e.amount.value * FREQUENCY_PER_YEAR[e.frequency], 0);
}

export interface Candidate {
  input: SimulationInput;
  /** Plan patch for this candidate (relative to the original plan), when expressible. */
  patch: PatchOp[] | null;
}

function birthOf(input: SimulationInput, personId: string): number {
  const p = input.household.people.find((x) => x.id === personId);
  if (!p) throw new ScenarioError(`unknown person '${personId}'`, { personId });
  return parseMonth(p.birthMonth);
}

/** Patch that sets a milestone to resolve at `month` (absolute month index). */
export function milestoneAtMonthPatch(
  input: SimulationInput,
  milestoneId: string,
  month: number,
): PatchOp[] {
  const m = input.plan.milestones.find((x) => x.id === milestoneId);
  if (!m) throw new ScenarioError(`unknown milestone '${milestoneId}'`, { milestoneId });
  const only = m.criteria.length === 1 ? m.criteria[0]! : null;
  if (only && only.kind === "age" && only.when === "at") {
    const age = (month - birthOf(input, only.personId)) / 12;
    return [{ op: "replace", path: `/milestones/[id=${milestoneId}]/criteria/0/age`, value: age }];
  }
  if (only && only.kind === "date" && only.when === "at")
    return [
      {
        op: "replace",
        path: `/milestones/[id=${milestoneId}]/criteria/0/date`,
        value: formatMonth(month),
      },
    ];
  return [
    { op: "replace", path: `/milestones/[id=${milestoneId}]/combinator`, value: "all" },
    {
      op: "replace",
      path: `/milestones/[id=${milestoneId}]/criteria`,
      value: [{ kind: "date", date: formatMonth(month), when: "at" }],
    },
  ];
}

function readNumber(plan: Plan, path: string): number {
  let cur: unknown = plan;
  for (const s of parsePointer(path)) {
    if (Array.isArray(cur))
      cur =
        s.kind === "id" ? cur.find((e) => (e as { id?: string }).id === s.id) : cur[Number(s.key)];
    else if (cur && typeof cur === "object" && s.kind === "key")
      cur = (cur as Record<string, unknown>)[s.key];
    else cur = undefined;
  }
  if (typeof cur !== "number")
    throw new ScenarioError(`path ${path} is not a numeric plan field`, { path });
  return cur;
}

/** Current value of a variable in the unmodified input (scales are 1). */
export function currentValue(input: SimulationInput, variable: SolverVariable): number | null {
  switch (variable.kind) {
    case "spendingScale":
    case "flowScale":
    case "balanceScale":
      return 1;
    case "path":
      return readNumber(input.plan, variable.path);
    case "milestoneMonth":
      return null;
  }
}

/** Build the candidate input for `value`. */
export function applyVariable(
  input: SimulationInput,
  variable: SolverVariable,
  value: number,
): Candidate {
  const plan = input.plan;
  let patch: PatchOp[];
  switch (variable.kind) {
    case "spendingScale":
      patch = scaledExpenses(plan, variable.expenseIds).map((e) => ({
        op: "replace",
        path: `/expenses/[id=${e.id}]/amount/value`,
        value: e.amount.value * value,
      }));
      break;
    case "milestoneMonth":
      patch = milestoneAtMonthPatch(
        input,
        variable.milestoneId,
        planStartMonth(input) + Math.round(value),
      );
      break;
    case "flowScale": {
      const f = plan.flows.find((x) => x.id === variable.flowId);
      if (!f)
        throw new ScenarioError(`unknown flow '${variable.flowId}'`, { flowId: variable.flowId });
      const base = `/flows/[id=${f.id}]`;
      if (f.kind === "contribution" && f.method.kind === "amount")
        patch = [
          {
            op: "replace",
            path: `${base}/method/amount/value`,
            value: f.method.amount.value * value,
          },
        ];
      else if (
        f.kind === "contribution" &&
        (f.method.kind === "percentOfRemaining" || f.method.kind === "percentOfIncome")
      )
        patch = [
          {
            op: "replace",
            path: `${base}/method/share`,
            value: Math.min(1, f.method.share * value),
          },
        ];
      else if (f.kind === "debtPaydown" && f.method.kind === "amount")
        patch = [
          {
            op: "replace",
            path: `${base}/method/amount/value`,
            value: f.method.amount.value * value,
          },
        ];
      else
        throw new ScenarioError(
          `flow '${f.id}' cannot be scaled: its method is '${flowMethodKind(f)}' on a ${f.kind} flow; ` +
            `only contribution flows with method 'amount', 'percentOfRemaining' or 'percentOfIncome' ` +
            `and debt paydown flows with method 'amount' have an amount to solve for`,
          {
            flowId: f.id,
            flowKind: f.kind,
            method: flowMethodKind(f),
            scalableFlowIds: scalableFlowIds(plan),
          },
        );
      break;
    }
    case "path":
      readNumber(plan, variable.path);
      patch = [{ op: "replace", path: variable.path, value }];
      break;
    case "balanceScale": {
      const ids = variable.accountIds ? new Set(variable.accountIds) : null;
      const scale = (fin: CurrentFinances): CurrentFinances => ({
        ...fin,
        accounts: fin.accounts.map((a) => {
          const hit = ids ? ids.has(a.id) : !["cash", "savings", "certificate"].includes(a.type);
          if (!hit) return a;
          return {
            ...a,
            balance: a.balance * value,
            ...(a.costBasis !== undefined ? { costBasis: a.costBasis * value } : {}),
            ...(a.contributionBasis !== undefined
              ? { contributionBasis: a.contributionBasis * value }
              : {}),
          };
        }),
      });
      const sc = plan.startingConditions;
      if (sc.kind === "snapshot")
        return {
          input: {
            ...input,
            plan: {
              ...plan,
              startingConditions: { kind: "snapshot", finances: scale(sc.finances) },
            },
          },
          patch: null,
        };
      return { input: { ...input, finances: scale(input.finances) }, patch: null };
    }
  }
  return { input: { ...input, plan: applyPlanPatch(plan, patch) }, patch };
}

/** The amount method of a flow (transfers: their amount kind). */
export function flowMethodKind(f: Plan["flows"][number]): string {
  return f.kind === "transfer" ? f.amount.kind : f.method.kind;
}

/** Whether a flow has an amount a `flowScale` variable can scale. */
export function isScalableFlow(f: Plan["flows"][number]): boolean {
  if (f.kind === "contribution")
    return (
      f.method.kind === "amount" ||
      f.method.kind === "percentOfRemaining" ||
      f.method.kind === "percentOfIncome"
    );
  return f.kind === "debtPaydown" && f.method.kind === "amount";
}

/** Ids of the plan's enabled flows that `solveRequiredSavings` / `flowScale` can solve for. */
export function scalableFlowIds(plan: Plan): string[] {
  return plan.flows.filter((f) => f.enabled && isScalableFlow(f)).map((f) => f.id);
}

/** Starting balance of the accounts a balanceScale variable scales. */
export function scaledBalance(input: SimulationInput, accountIds?: string[]): number {
  const ids = accountIds ? new Set(accountIds) : null;
  return planFinances(input)
    .accounts.filter(
      (a) =>
        !a.archived && (ids ? ids.has(a.id) : !["cash", "savings", "certificate"].includes(a.type)),
    )
    .reduce((s, a) => s + a.balance, 0);
}
