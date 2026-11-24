/**
 * Runs the engine's solvers (`solveMaxSpending`, `evaluateGuardrails`) the way the calculators run a
 * Monte Carlo: every candidate the solver scores is a `createMonteCarloSession` stepped in chunks, so a
 * worker can receive a cancel message between chunks and the page can show progress. The solver itself
 * is unchanged; only its `evaluate` dependency is supplied (the hook core provides for this).
 */
import {
  createMonteCarloSession,
  type MonteCarloResult,
  type SimulationInput,
  type SolverDeps,
} from "@glideworth/core";
import { type RunOptions, stepSession } from "./common";

export interface SolverRun {
  deps: SolverDeps;
  /** Simulations run so far, across every candidate. */
  readonly trialsRun: number;
  /** Candidates scored so far. */
  readonly evaluations: number;
}

/**
 * Solver dependencies that score each candidate with a chunked, cancellable session and report
 * progress as simulations done out of an estimate (`expectedEvaluations` × trials). The estimate grows
 * if the solver needs more candidates, so progress never goes backwards and never passes its total.
 */
export function solverRun(
  opts: RunOptions,
  expectedEvaluations: number,
  /** Simulations already reported before the solver (offset) and still to come after it (tail). */
  share: { offset?: number; tail?: number } = {},
): SolverRun {
  const offset = share.offset ?? 0;
  const tail = share.tail ?? 0;
  let trialsRun = 0;
  let evaluations = 0;
  const evaluate = async (input: SimulationInput): Promise<MonteCarloResult> => {
    const session = createMonteCarloSession(input, input.plan.monteCarlo, {
      metrics: ["portfolio"],
      keepTrials: false,
    });
    const per = session.total;
    const expected = Math.max(expectedEvaluations, evaluations + 2) * per;
    await stepSession(session, {
      ...opts,
      offset: offset + trialsRun,
      total: offset + expected + tail,
    });
    trialsRun += per;
    evaluations += 1;
    return session.result();
  };
  return {
    deps: {
      evaluate,
      ...(opts.signal ? { signal: opts.signal } : {}),
    },
    get trialsRun() {
      return trialsRun;
    },
    get evaluations() {
      return evaluations;
    },
  };
}
