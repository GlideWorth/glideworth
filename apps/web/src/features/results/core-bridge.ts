/**
 * Thin bridge to @glideworth/core insights/solvers/stochastic. Solver and insight helpers are looked
 * up by name so a missing export surfaces as a NotImplementedError (rendered as a clear "not
 * available" state); the stochastic functions are typed against the real core API:
 * runMonteCarloShard -> MonteCarloShard, mergeMonteCarloShards(shards) -> MonteCarloShard,
 * summarizeMonteCarlo(shard, settings) -> MonteCarloResult.
 */
import * as core from "@glideworth/core";
import {
  type Explanation,
  type Finding,
  type GlideworthDocument,
  type GoalSeekResult,
  type MonteCarloResult,
  type MonteCarloSettings,
  NotImplementedError,
  type PatchOp,
  type Plan,
  type PlanDiff,
  type ProjectionResult,
  type RiskGuardrails,
  type SimulationInput,
} from "@glideworth/core";

// oxlint-disable-next-line typescript/no-explicit-any -- dynamic lookup of contract functions
type AnyFn = (...args: any[]) => any;

function fn<F extends AnyFn>(name: string, feature: string, workstream: string): F {
  const f = (core as unknown as Record<string, unknown>)[name];
  if (typeof f !== "function")
    throw new NotImplementedError(feature, workstream, `${name} is not exported yet`);
  return f as F;
}

/** True when `name` is exported (it may still throw NotImplementedError when called). */
export function hasExport(name: string): boolean {
  return typeof (core as unknown as Record<string, unknown>)[name] === "function";
}

/** Options accepted by core's stochastic runners (core's own `PrepareOptions`). */
export type StochasticOptions = core.PrepareOptions;

export interface SolverDepsLike {
  evaluate?: (input: SimulationInput) => Promise<MonteCarloResult>;
  signal?: AbortSignal;
  onProgress?: (p: unknown) => void;
}

export const bridge = {
  explainProjection: (
    input: SimulationInput,
    result: ProjectionResult,
    question?: string,
  ): Explanation =>
    fn<(i: SimulationInput, r: ProjectionResult, q?: string) => Explanation>(
      "explainProjection",
      "insights.explainProjection",
      "d",
    )(input, result, question),
  explainDifference: (
    base: ProjectionResult,
    other: ProjectionResult,
    diff: PlanDiff,
  ): Explanation =>
    fn<(a: ProjectionResult, b: ProjectionResult, d: PlanDiff) => Explanation>(
      "explainDifference",
      "insights.explainDifference",
      "d",
    )(base, other, diff),
  /** With `result`, checks that need the projection (milestone-dated moves, penalties...) run too. */
  auditAssumptions: (input: SimulationInput, result?: ProjectionResult): Finding[] =>
    fn<(i: SimulationInput, o?: { result?: ProjectionResult }) => Finding[]>(
      "auditAssumptions",
      "insights.auditAssumptions",
      "d",
    )(input, result ? { result } : undefined),
  /** Pass `diffFormat(doc, locale, currency)` so changes read "£2,300 a month", not "2,300". */
  diffPlans: (base: Plan, other: Plan, format?: core.FormatContext): PlanDiff =>
    fn<(a: Plan, b: Plan, o?: core.FormatContext) => PlanDiff>(
      "diffPlans",
      "insights.diffPlans",
      "d",
    )(base, other, format),
  applyPlanPatch: (plan: Plan, ops: PatchOp[]): Plan =>
    fn<(p: Plan, o: PatchOp[]) => Plan>(
      "applyPlanPatch",
      "insights.applyPlanPatch",
      "d",
    )(plan, ops),
  materializePlan: (plan: Plan, lookup: (id: string) => Plan | undefined): Plan =>
    fn<(p: Plan, l: (id: string) => Plan | undefined) => Plan>(
      "materializePlan",
      "insights.materializePlan",
      "d",
    )(plan, lookup),
  solveMaxSpending: (
    input: SimulationInput,
    opts: { targetSuccessRate: number; expenseIds?: string[]; monteCarlo?: MonteCarloSettings },
    deps: SolverDepsLike = {},
  ): Promise<GoalSeekResult> => call("solveMaxSpending", "solvers.maxSpending", input, opts, deps),
  solveEarliestRetirement: (
    input: SimulationInput,
    opts: { milestoneId: string; targetSuccessRate: number; monteCarlo?: MonteCarloSettings },
    deps: SolverDepsLike = {},
  ): Promise<GoalSeekResult> =>
    call("solveEarliestRetirement", "solvers.earliestRetirement", input, opts, deps),
  solveRequiredSavings: (
    input: SimulationInput,
    opts: { flowId: string; targetSuccessRate: number; monteCarlo?: MonteCarloSettings },
    deps: SolverDepsLike = {},
  ): Promise<GoalSeekResult> =>
    call("solveRequiredSavings", "solvers.requiredSavings", input, opts, deps),
  evaluateGuardrails: (
    input: SimulationInput,
    guardrails: RiskGuardrails,
    deps: SolverDepsLike = {},
  ) =>
    call<core.GuardrailsResult>(
      "evaluateGuardrails",
      "solvers.guardrails",
      input,
      guardrails,
      deps,
    ),
  /** Single-threaded run (tests, small jobs). Heavy runs go through the worker pool (mc-pool.ts). */
  runMonteCarlo: (
    input: SimulationInput,
    settings: MonteCarloSettings,
    opts: StochasticOptions = {},
  ): MonteCarloResult => core.runMonteCarlo(input, settings, opts),
  runHistorical: (
    input: SimulationInput,
    opts: Parameters<typeof core.runHistorical>[1] = {},
  ): MonteCarloResult => core.runHistorical(input, opts),
  /** One worker's slice of trials: a raw, mergeable MonteCarloShard (NOT a result). */
  runMonteCarloShard: (
    input: SimulationInput,
    settings: MonteCarloSettings,
    opts: StochasticOptions = {},
  ): core.MonteCarloShard => core.runMonteCarloShard(input, settings, opts),
  /** Merge shards (from runMonteCarloShard) into one shard; summarise it with `summarizeMonteCarlo`. */
  mergeMonteCarloShards: (shards: readonly core.MonteCarloShard[]): core.MonteCarloShard =>
    core.mergeMonteCarloShards(shards),
  /** MonteCarloShard + settings -> MonteCarloResult. */
  summarizeMonteCarlo: (
    shard: core.MonteCarloShard,
    settings: MonteCarloSettings,
    opts?: core.SummarizeOptions,
  ): MonteCarloResult => core.summarizeMonteCarlo(shard, settings, opts),
};

async function call<R>(name: string, feature: string, ...args: unknown[]): Promise<R> {
  const f = fn<AnyFn>(name, feature, "d");
  return (await f(...args)) as R;
}

/** Names, currency and locale for human-readable plan diffs. */
export function diffFormat(
  doc: Pick<GlideworthDocument, "household" | "finances"> | undefined,
  locale: string,
  currency: string,
): core.FormatContext {
  if (!doc) return { locale, currency };
  const fin = doc.finances;
  return {
    locale,
    currency,
    people: Object.fromEntries(
      [...doc.household.people, ...doc.household.dependents].map((p) => [p.id, p.name]),
    ),
    entities: Object.fromEntries(
      [...fin.accounts, ...fin.realAssets, ...fin.debts].map((x) => [x.id, x.name]),
    ),
  };
}

/** Run a synchronous bridge call, returning `{ error }` instead of throwing. */
export function attempt<T>(
  f: () => T,
): { value: T; error?: undefined } | { value?: undefined; error: unknown } {
  try {
    return { value: f() };
  } catch (error) {
    return { error };
  }
}
