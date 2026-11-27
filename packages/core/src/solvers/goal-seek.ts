/** Goal-seek solvers over the deterministic engine or Monte Carlo. Owner: workstream (d). */
import { formatMonth, parseMonth } from "../engine/dates.js";
import type { SimulationInput } from "../engine/types.js";
import { ScenarioError } from "../errors.js";
import { fmtMoney, fmtMonth, fmtPercent, pluralDuration } from "../insights/format.js";
import type { MonteCarloSettings } from "../schema/montecarlo.js";
import { FREQUENCY_PER_YEAR } from "../schema/primitives.js";
import {
  GoalSeekRequest,
  type GoalSeekRequestInput,
  type GoalSeekResult,
  type SolverDeps,
  type SolverObjective,
  type SolverVariable,
} from "./contracts.js";
import {
  boundarySearch,
  type Bracket,
  type Metric,
  makeMetric,
  runDeterministic,
} from "./search.js";
import {
  applyVariable,
  currentYearSpending,
  flowMethodKind,
  isScalableFlow,
  planStartMonth,
  scalableFlowIds,
  scaledBalance,
} from "./variables.js";

function fmtTarget(objective: SolverObjective, target: number, currency?: string): string {
  if (objective.kind === "successRate") return `${fmtPercent(target)} chance of success`;
  if (objective.kind === "noShortfall") return "every year fully funded";
  return `ending net worth of at least ${fmtMoney(target, currency ? { currency } : {})}`;
}

/**
 * Generic single-variable goal seek. Evaluations are memoised, so sensitivity re-solves at
 * neighbouring targets cost only the new points they need.
 */
export async function goalSeek(
  input: SimulationInput,
  request: GoalSeekRequestInput,
  deps: SolverDeps = {},
): Promise<GoalSeekResult> {
  const req = GoalSeekRequest.parse(request);
  if (!(req.bounds.min <= req.bounds.max))
    throw new ScenarioError("bounds.min must be <= bounds.max", req.bounds);
  const metric: Metric = makeMetric(input, req.objective, deps, req.monteCarlo);
  const integer = req.variable.kind === "milestoneMonth";
  const cache = new Map<number, number>();
  const evaluations: { value: number; metric: number }[] = [];
  const evalAt = async (v: number) => {
    const hit = cache.get(v);
    if (hit !== undefined) return hit;
    const cand = applyVariable(input, req.variable, v);
    const m = await metric.score(cand.input);
    cache.set(v, m);
    evaluations.push({ value: v, metric: m });
    return m;
  };
  const common = {
    lo: req.bounds.min,
    hi: req.bounds.max,
    direction: req.direction,
    integer,
    tolerance: req.tolerance,
    metric,
    evalAt,
    isCached: (v: number) => cache.has(v),
    ...(deps.signal ? { signal: deps.signal } : {}),
  };
  // Sensitivity re-solves share this cache. Report those steps too, or the count freezes
  // while the neighbouring targets are still being searched.
  const report = (value: number, m: number, feasible: boolean, bracket: Bracket) =>
    deps.onProgress?.(evaluations.length, { value, metric: m, feasible, bracket });
  const main = await boundarySearch({
    ...common,
    maxEvaluations: req.maxEvaluations,
    target: metric.target,
    onStep: report,
  });

  const deltas =
    req.sensitivityDeltas ?? (req.objective.kind === "successRate" ? [-0.05, 0.05] : []);
  const sensitivity: GoalSeekResult["sensitivity"] = [];
  for (const d of deltas) {
    let t = metric.target + d;
    if (req.objective.kind === "successRate") t = Math.min(1, Math.max(0, t));
    if (req.objective.kind === "noShortfall") continue;
    const r = await boundarySearch({
      ...common,
      maxEvaluations: Math.max(4, Math.ceil(req.maxEvaluations / 2)),
      target: t,
      onStep: report,
    });
    sensitivity.push({ label: fmtTarget(req.objective, t), value: r.value });
  }

  const patch = main.value === null ? null : applyVariable(input, req.variable, main.value).patch;
  const verb = req.direction === "maximize" ? "Largest" : "Smallest";
  const what = describeVariable(req.variable);
  const goal = fmtTarget(req.objective, metric.target, input.household.currency);
  let explanation: string;
  switch (main.status) {
    case "infeasible":
      explanation = `No ${what} between ${req.bounds.min} and ${req.bounds.max} achieves ${goal}.`;
      break;
    case "at-bound":
      explanation = `${goal} holds across the whole range; the ${req.direction === "maximize" ? "upper" : "lower"} bound ${main.value} is the answer (the true limit may lie beyond it).`;
      break;
    default:
      explanation = `${verb} ${what} that achieves ${goal}: ${round(main.value!)} (${evaluations.length} evaluations${main.status === "max-evaluations" ? ", stopped at the evaluation limit" : ""}).`;
  }
  return {
    converged:
      main.status === "solved" || main.status === "at-bound" || main.status === "infeasible",
    value: main.value,
    achieved: main.status === "infeasible" ? null : main.achieved,
    evaluations,
    sensitivity,
    explanation,
    status: main.status,
    bracket: main.bracket,
    ...(patch ? { patch } : {}),
    seed: metric.seed,
  };
}

function round(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toPrecision(6);
}

function describeVariable(v: SolverVariable): string {
  switch (v.kind) {
    case "spendingScale":
      return "spending multiplier";
    case "milestoneMonth":
      return `month offset for milestone ${v.milestoneId}`;
    case "flowScale":
      return `contribution multiplier for flow ${v.flowId}`;
    case "balanceScale":
      return "starting portfolio multiplier";
    case "path":
      return `value at ${v.path}`;
  }
}

function objectiveFor(opts: {
  targetSuccessRate?: number;
  objective?: SolverObjective;
}): SolverObjective {
  if (opts.objective) return opts.objective;
  if (opts.targetSuccessRate !== undefined)
    return { kind: "successRate", target: opts.targetSuccessRate };
  return { kind: "noShortfall" };
}

interface CommonOpts {
  /** Success-rate target (uses Monte Carlo). Ignored when `objective` is given. */
  targetSuccessRate?: number;
  /** Override the objective, e.g. `{ kind: 'noShortfall' }` to solve on the deterministic plan. */
  objective?: SolverObjective;
  monteCarlo?: MonteCarloSettings;
  maxEvaluations?: number;
  tolerance?: number;
  sensitivityDeltas?: number[];
}

function passthrough(o: CommonOpts) {
  return {
    ...(o.monteCarlo ? { monteCarlo: o.monteCarlo } : {}),
    ...(o.maxEvaluations ? { maxEvaluations: o.maxEvaluations } : {}),
    ...(o.sensitivityDeltas ? { sensitivityDeltas: o.sensitivityDeltas } : {}),
  };
}

/** Max sustainable spending (scale on discretionary+essential) at a target success rate. */
export async function solveMaxSpending(
  input: SimulationInput,
  opts: CommonOpts & { expenseIds?: string[]; bounds?: { min: number; max: number } },
  deps: SolverDeps = {},
): Promise<GoalSeekResult> {
  const objective = objectiveFor(opts);
  const variable: SolverVariable = {
    kind: "spendingScale",
    ...(opts.expenseIds ? { expenseIds: opts.expenseIds } : {}),
  };
  const r = await goalSeek(
    input,
    {
      variable,
      objective,
      direction: "maximize",
      bounds: opts.bounds ?? { min: 0, max: 4 },
      tolerance: opts.tolerance ?? 0.0025,
      ...passthrough(opts),
    },
    deps,
  );
  const base = currentYearSpending(input, opts.expenseIds);
  const cur = input.household.currency;
  const goal = fmtTarget(
    objective,
    objective.kind === "successRate"
      ? objective.target
      : objective.kind === "endNetWorth"
        ? objective.target.value
        : 1,
    cur,
  );
  if (r.value !== null) {
    const annual = base * r.value;
    r.details = {
      scale: r.value,
      annualSpending: annual,
      currentAnnualSpending: base,
      changePct: r.value - 1,
    };
    const change =
      r.value >= 1 ? `${fmtPercent(r.value - 1)} more` : `${fmtPercent(1 - r.value)} less`;
    r.explanation =
      r.status === "at-bound"
        ? `Even ${r.value}x your planned spending keeps ${goal}.`
        : `You can spend about ${fmtMoney(annual, { currency: cur })} a year (${change} than planned ${fmtMoney(base, { currency: cur })}) and keep ${goal}.`;
  } else {
    r.explanation = `Even cutting the selected spending to zero does not reach ${goal}; the shortfall comes from elsewhere (debts, taxes or fixed costs).`;
  }
  return r;
}

/** Earliest month for a milestone (retirement by default) at a target success rate. */
export async function solveEarliestRetirement(
  input: SimulationInput,
  opts: CommonOpts & { milestoneId: string; bounds?: { min: number; max: number } },
  deps: SolverDeps = {},
): Promise<GoalSeekResult> {
  const m = input.plan.milestones.find((x) => x.id === opts.milestoneId);
  if (!m)
    throw new ScenarioError(`unknown milestone '${opts.milestoneId}'`, {
      milestoneId: opts.milestoneId,
    });
  const start = planStartMonth(input);
  const baseRun = runDeterministic(input, deps);
  const horizon = parseMonth(baseRun.meta.endMonth) - start;
  const current = baseRun.milestones.find((x) => x.milestoneId === m.id);
  const objective = objectiveFor(opts);
  const r = await goalSeek(
    input,
    {
      variable: { kind: "milestoneMonth", milestoneId: m.id },
      objective,
      direction: "minimize",
      bounds: opts.bounds ?? { min: 0, max: horizon },
      tolerance: 1,
      ...passthrough(opts),
    },
    deps,
  );
  const goal = fmtTarget(
    objective,
    objective.kind === "successRate"
      ? objective.target
      : objective.kind === "endNetWorth"
        ? objective.target.value
        : 1,
  );
  if (r.value !== null) {
    const month = start + r.value;
    const personId = m.personId ?? input.household.people.find((p) => p.role === "primary")!.id;
    const person = input.household.people.find((p) => p.id === personId)!;
    const age = (month - parseMonth(person.birthMonth)) / 12;
    const currentMonth = current?.month ? parseMonth(current.month) : null;
    r.details = {
      month: formatMonth(month),
      monthsFromStart: r.value,
      age,
      currentMonth: current?.month ?? null,
      monthsEarlier: currentMonth === null ? null : currentMonth - month,
    };
    const gap = currentMonth === null ? null : month - currentMonth;
    const delta =
      gap === null
        ? ""
        : gap === 0
          ? " (as planned)"
          : ` (${pluralDuration(Math.abs(gap), "month")} ${gap > 0 ? "later" : "earlier"} than planned)`;
    r.explanation = `${m.name} can happen as early as ${fmtMonth(formatMonth(month))}, at ${person.name}'s age ${age.toFixed(1)}${delta}, while keeping ${goal}.`;
  } else {
    r.explanation = `${m.name} cannot be placed anywhere in the plan and still reach ${goal}.`;
  }
  return r;
}

/** Required savings (scale on a contribution flow) to reach a target success rate. */
export async function solveRequiredSavings(
  input: SimulationInput,
  opts: CommonOpts & { flowId: string; bounds?: { min: number; max: number } },
  deps: SolverDeps = {},
): Promise<GoalSeekResult> {
  const f = input.plan.flows.find((x) => x.id === opts.flowId);
  if (!f) throw new ScenarioError(`unknown flow '${opts.flowId}'`, { flowId: opts.flowId });
  if (!isScalableFlow(f)) {
    const ok = scalableFlowIds(input.plan);
    throw new ScenarioError(
      `flow '${f.id}' uses method '${flowMethodKind(f)}', which has no amount to solve for; ` +
        (ok.length
          ? `flows that can be solved for: ${ok.join(", ")}`
          : `no flow in this plan can be solved for (use method 'amount', 'percentOfRemaining' or 'percentOfIncome')`),
      { flowId: f.id, method: flowMethodKind(f), scalableFlowIds: ok },
    );
  }
  const objective = objectiveFor(opts);
  const r = await goalSeek(
    input,
    {
      variable: { kind: "flowScale", flowId: f.id },
      objective,
      direction: "minimize",
      bounds: opts.bounds ?? { min: 0, max: 10 },
      tolerance: opts.tolerance ?? 0.0025,
      ...passthrough(opts),
    },
    deps,
  );
  const cur = input.household.currency;
  if (r.value !== null && f.kind === "contribution" && f.method.kind === "amount") {
    const annual = f.method.amount.value * FREQUENCY_PER_YEAR[f.method.frequency] * r.value;
    const now = f.method.amount.value * FREQUENCY_PER_YEAR[f.method.frequency];
    r.details = { scale: r.value, annualContribution: annual, currentAnnualContribution: now };
    r.explanation = `Contributing about ${fmtMoney(annual, { currency: cur })} a year to ${f.name} (now ${fmtMoney(now, { currency: cur })}) is enough.`;
  } else if (r.value !== null && f.kind === "contribution" && "share" in f.method) {
    const share = Math.min(1, f.method.share * r.value);
    r.details = { scale: r.value, share };
    r.explanation = `Saving ${fmtPercent(share)} (now ${fmtPercent(f.method.share)}) through ${f.name} is enough.`;
  }
  return r;
}

/** Required starting portfolio (scale on non-cash balances, or listed accounts). */
export async function solveRequiredPortfolio(
  input: SimulationInput,
  opts: CommonOpts & { accountIds?: string[]; bounds?: { min: number; max: number } },
  deps: SolverDeps = {},
): Promise<GoalSeekResult> {
  const objective = objectiveFor(opts);
  const r = await goalSeek(
    input,
    {
      variable: {
        kind: "balanceScale",
        ...(opts.accountIds ? { accountIds: opts.accountIds } : {}),
      },
      objective,
      direction: "minimize",
      bounds: opts.bounds ?? { min: 0, max: 20 },
      tolerance: opts.tolerance ?? 0.0025,
      ...passthrough(opts),
    },
    deps,
  );
  const base = scaledBalance(input, opts.accountIds);
  const cur = input.household.currency;
  if (r.value !== null) {
    const need = base * r.value;
    r.details = {
      scale: r.value,
      requiredPortfolio: need,
      currentPortfolio: base,
      gap: need - base,
    };
    r.explanation =
      need <= base
        ? `You need about ${fmtMoney(need, { currency: cur })} invested; you have ${fmtMoney(base, { currency: cur })}, a cushion of ${fmtMoney(base - need, { currency: cur })}.`
        : `You need about ${fmtMoney(need, { currency: cur })} invested; you have ${fmtMoney(base, { currency: cur })}, a gap of ${fmtMoney(need - base, { currency: cur })}.`;
  }
  return r;
}

export const SWR_EXPENSE_ID = "swr-withdrawal";

/**
 * Safe withdrawal rate for this household's own portfolio, allocation, fees and taxes: the largest
 * inflation-adjusted annual withdrawal (as a share of the starting non-cash portfolio) that lasts
 * `years`. Builds a synthetic plan without income, other expenses, flows, real assets or debts.
 */
export async function solveSafeWithdrawalRate(
  input: SimulationInput,
  opts: CommonOpts & { years?: number; accountIds?: string[] },
  deps: SolverDeps = {},
): Promise<GoalSeekResult> {
  const years = opts.years ?? 30;
  const portfolio = scaledBalance(input, opts.accountIds);
  if (portfolio <= 0) throw new ScenarioError("no invested balance to withdraw from", {});
  const start = planStartMonth(input);
  const finances =
    input.plan.startingConditions.kind === "snapshot"
      ? input.plan.startingConditions.finances
      : input.finances;
  const ids = opts.accountIds ? new Set(opts.accountIds) : null;
  const excluded = [
    ...finances.realAssets.map((r) => r.id),
    ...finances.debts.map((d) => d.id),
    ...finances.accounts
      .filter((a) => (ids ? !ids.has(a.id) : ["cash", "savings", "certificate"].includes(a.type)))
      .map((a) => a.id),
  ];
  const synthetic: SimulationInput = {
    ...input,
    plan: {
      ...input.plan,
      milestones: [],
      income: [],
      flows: [],
      plannedAccounts: [],
      plannedRealAssets: [],
      excludedIds: excluded,
      leftover: { kind: "save" },
      withdrawalStrategy: undefined,
      riskGuardrails: undefined,
      expenses: [
        {
          id: SWR_EXPENSE_ID,
          type: "living",
          name: "Withdrawal",
          owner: "joint",
          amount: { value: portfolio * 0.04, basis: "real" },
          frequency: "yearly",
          range: {
            start: { kind: "planStart", offsetMonths: 0 },
            end: { kind: "planEnd", offsetMonths: 0 },
            endInclusive: false,
          },
          change: { kind: "inflation", plus: 0 },
          growFromToday: true,
          enabled: true,
          spendingType: "essential",
          payFrom: { kind: "auto" },
          tax: {
            treatment: "auto",
            deductible: false,
            itemized: false,
            deductibleIn: ["federal", "state", "local"],
          },
        },
      ],
      assumptions: {
        ...input.plan.assumptions,
        end: {
          kind: "ref",
          ref: { kind: "date", date: formatMonth(start + years * 12), offsetMonths: 0 },
        },
      },
    },
  };
  const objective = objectiveFor(opts);
  const r = await goalSeek(
    synthetic,
    {
      variable: { kind: "path", path: `/expenses/[id=${SWR_EXPENSE_ID}]/amount/value` },
      objective,
      direction: "maximize",
      bounds: { min: 0, max: portfolio * 0.25 },
      tolerance: Math.max(1e-6, portfolio * 0.00005),
      ...passthrough(opts),
    },
    deps,
  );
  const cur = input.household.currency;
  const rate = r.value === null ? null : r.value / portfolio;
  r.sensitivity = r.sensitivity.map((s) => ({
    ...s,
    value: s.value === null ? null : s.value / portfolio,
  }));
  r.evaluations = r.evaluations.map((e) => ({ value: e.value / portfolio, metric: e.metric }));
  r.bracket = r.bracket
    ? {
        feasible: r.bracket.feasible === null ? null : r.bracket.feasible / portfolio,
        infeasible: r.bracket.infeasible === null ? null : r.bracket.infeasible / portfolio,
      }
    : r.bracket;
  delete r.patch;
  r.details = { rate, annualWithdrawal: r.value, portfolio, years };
  r.value = rate;
  const span = pluralDuration(years, "year");
  r.explanation =
    rate === null
      ? `No withdrawal rate lasts ${span} under these assumptions.`
      : `A ${fmtPercent(rate)} initial withdrawal (${fmtMoney(rate * portfolio, { currency: cur })} a year in today's money from ${fmtMoney(portfolio, { currency: cur })}) lasts ${span} under this plan's assumptions.`;
  return r;
}
