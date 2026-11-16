/**
 * What a background job does, independent of where it runs (worker thread in production, inline in
 * tests). Everything here is pure compute over a SimulationInput.
 */
import type { SimulationInput } from "@glideworth/core";
import type { CoreDeps } from "../deps.js";

export const JOB_KINDS = [
  "monte-carlo",
  "historical",
  "goal-seek",
  "max-spending",
  "earliest-retirement",
  "required-savings",
  "required-portfolio",
  "safe-withdrawal-rate",
  "guardrails",
  "sensitivity",
  "attribution",
  "tax-strategy",
  "strategy-matrix",
  /** Internal: one slice of a sharded Monte Carlo run (never submitted through the API). */
  "mc-shard",
  /** Internal: deterministic projection (used to exercise the worker pipeline). */
  "projection",
] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export interface JobHooks {
  /** 0..1 */
  onProgress: (fraction: number) => void;
  signal: AbortSignal;
}

export interface JobSpec {
  kind: JobKind;
  input: SimulationInput;
  // oxlint-disable-next-line typescript/no-explicit-any -- params are validated by the route/service schema per kind
  params: any;
}

export async function runJob(spec: JobSpec, hooks: JobHooks, deps: CoreDeps): Promise<unknown> {
  const { input, params } = spec;
  const solverDeps = {
    signal: hooks.signal,
    onProgress: (n: number) => hooks.onProgress(Math.min(0.99, n / (params?.maxEvaluations ?? 30))),
  };
  switch (spec.kind) {
    case "monte-carlo":
      // The async runner yields between trial chunks, so `signal` cancels it even in-process.
      return deps.runMonteCarloAsync(input, params.settings, {
        signal: hooks.signal,
        keepTrials: params.keepTrials ?? false,
        onProgress: (done, total) => hooks.onProgress(total ? done / total : 0),
      });
    case "mc-shard":
      return deps.runMonteCarloShard(input, params.settings, {
        signal: hooks.signal,
        trialOffset: params.trialOffset,
        trialCount: params.trialCount,
        onProgress: (done, total) => hooks.onProgress(total ? done / total : 0),
      });
    case "historical":
      return deps.runHistorical(input, {
        signal: hooks.signal,
        keepTrials: params.keepTrials ?? false,
        ...(params.startYears ? { startYears: params.startYears } : {}),
        onProgress: (done, total) => hooks.onProgress(total ? done / total : 0),
      });
    case "goal-seek":
      return deps.goalSeek(input, params.request, solverDeps);
    case "max-spending":
      return deps.solveMaxSpending(input, params, solverDeps);
    case "earliest-retirement":
      return deps.solveEarliestRetirement(input, params, solverDeps);
    case "required-savings":
      return deps.solveRequiredSavings(input, params, solverDeps);
    case "required-portfolio":
      return deps.solveRequiredPortfolio(input, params, solverDeps);
    case "safe-withdrawal-rate":
      return deps.solveSafeWithdrawalRate(input, params, solverDeps);
    case "guardrails":
      return deps.evaluateGuardrails(
        params.monteCarlo
          ? { ...input, plan: { ...input.plan, monteCarlo: params.monteCarlo } }
          : input,
        params.guardrails,
        solverDeps,
      );
    case "sensitivity":
      return deps.sensitivityAnalysis(input, params, solverDeps);
    case "attribution":
      return deps.attributeDifference(
        input,
        params.otherPlan,
        { metric: params.metric, ...(params.diff ? { diff: params.diff } : {}) },
        solverDeps,
      );
    case "tax-strategy":
      return params.candidates
        ? deps.compareStrategies(
            input,
            params.candidates,
            { objective: params.objective },
            solverDeps,
          )
        : deps.optimiseTaxStrategy(input, { objective: params.objective }, solverDeps);
    case "strategy-matrix":
      return deps.strategyMetricsMatrix(
        params.successRate === false
          ? input
          : {
              ...input,
              plan: { ...input.plan, monteCarlo: params.monteCarlo ?? input.plan.monteCarlo },
            },
        params.candidates ?? deps.defaultStrategyCandidates(input),
        { successRate: params.successRate !== false },
        solverDeps,
      );
    case "projection":
      return deps.simulate(input);
  }
}

/** Errors cross the thread boundary as plain data and are rebuilt on the other side. */
export interface SerializedError {
  name: string;
  message: string;
  code?: string;
  details?: unknown;
}

export function serializeError(err: unknown): SerializedError {
  if (err instanceof Error) {
    const e = err as Error & { code?: string; details?: unknown };
    return {
      name: e.name,
      message: e.message,
      ...(typeof e.code === "string" ? { code: e.code } : {}),
      ...(e.details !== undefined ? { details: e.details } : {}),
    };
  }
  return { name: "Error", message: "unknown error" };
}
