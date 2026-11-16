/**
 * Robust monotone boundary search (bracketing + safeguarded interpolation/bisection).
 *
 * "maximize": the feasible set is assumed to be [min, v*] (e.g. more spending -> lower success);
 * we return the largest feasible value. "minimize": feasible set [v*, max]; we return the smallest.
 * With common random numbers (fixed MC seed) the success-rate objective is a deterministic step
 * function of the variable, so bisection converges without noise.
 */
import { simulate as coreSimulate } from "../engine/simulate.js";
import type { ProjectionResult, SimulationInput } from "../engine/types.js";
import { MonteCarloSettings } from "../schema/montecarlo.js";
import { runMonteCarloAsync } from "../stochastic/index.js";
import {
  DEFAULT_SOLVER_SEED,
  type GoalSeekStatus,
  type SolverDeps,
  type SolverObjective,
} from "./contracts.js";

export interface Metric {
  /** Score a candidate input. */
  score(input: SimulationInput): Promise<number>;
  /** Default target (success rate, 1 for noShortfall, end net worth). */
  target: number;
  feasible(metric: number, target: number): boolean;
  /** Metric varies smoothly with the variable (enables interpolation steps). */
  continuous: boolean;
  seed: number | null;
  label: string;
}

/** True for cancellation errors from solvers (AbortError) and from Monte Carlo (MonteCarloAbortedError). */
export function isAbortError(e: unknown): boolean {
  const err = e as { name?: string; code?: string } | null;
  return (
    !!err &&
    (err.name === "AbortError" || err.name === "MonteCarloAbortedError" || err.code === "ABORTED")
  );
}

/**
 * Trials per Monte Carlo evaluation when the caller does not pass explicit settings: a solve runs
 * 10-30 evaluations, so the plan's own trial count (often 1,000+) is capped to keep solves fast.
 */
export const DEFAULT_SOLVER_MAX_TRIALS = 500;

export function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException("Solver aborted", "AbortError");
  }
}

export function deterministicInput(input: SimulationInput): SimulationInput {
  return {
    ...input,
    options: { ...input.options, trace: "off", lean: true, market: input.options.market },
  };
}

export function runDeterministic(input: SimulationInput, deps: SolverDeps): ProjectionResult {
  return (deps.simulate ?? ((i: SimulationInput) => coreSimulate(i)))(deterministicInput(input));
}

/** Monte Carlo settings with a fixed seed (common random numbers across candidates). */
export function fixedSeedSettings(
  input: SimulationInput,
  override?: MonteCarloSettings,
): MonteCarloSettings {
  const s = MonteCarloSettings.parse(override ?? input.plan.monteCarlo);
  const trials = override ? s.trials : Math.min(s.trials, DEFAULT_SOLVER_MAX_TRIALS);
  return { ...s, trials, seed: s.seed ?? DEFAULT_SOLVER_SEED };
}

export function makeMetric(
  base: SimulationInput,
  objective: SolverObjective,
  deps: SolverDeps,
  mc?: MonteCarloSettings,
): Metric {
  switch (objective.kind) {
    case "successRate": {
      const settings = fixedSeedSettings(base, mc);
      const evaluate =
        deps.evaluate ??
        ((i: SimulationInput) =>
          runMonteCarloAsync(i, i.plan.monteCarlo, {
            keepTrials: false,
            ...(deps.signal ? { signal: deps.signal } : {}),
          }));
      return {
        async score(input) {
          const r = await evaluate({ ...input, plan: { ...input.plan, monteCarlo: settings } });
          return r.successRate;
        },
        target: objective.target,
        feasible: (m, t) => m >= t - 1e-12,
        continuous: true,
        seed: settings.seed,
        label: "chance of success",
      };
    }
    case "noShortfall":
      return {
        score: (input) => Promise.resolve(runDeterministic(input, deps).summary.success ? 1 : 0),
        target: 1,
        feasible: (m) => m >= 1,
        continuous: false,
        seed: null,
        label: "every year fully funded",
      };
    case "endNetWorth": {
      const real = objective.target.basis === "real";
      return {
        score: (input) => {
          const s = runDeterministic(input, deps).summary;
          return Promise.resolve(real ? s.endNetWorthReal : s.endNetWorth);
        },
        target: objective.target.value,
        feasible: (m, t) => m >= t - 1e-9,
        continuous: true,
        seed: null,
        label: real ? "ending net worth (today's money)" : "ending net worth",
      };
    }
  }
}

export interface SearchParams {
  lo: number;
  hi: number;
  direction: "maximize" | "minimize";
  integer: boolean;
  tolerance: number;
  maxEvaluations: number;
  target: number;
  metric: Metric;
  /** Memoised scorer: value -> metric. Shared between the main search and sensitivity re-solves. */
  evalAt: (value: number) => Promise<number>;
  /** Evaluations already spent counting toward maxEvaluations (cache hits are free). */
  isCached: (value: number) => boolean;
  onStep?: (value: number, metric: number, feasible: boolean, bracket: Bracket) => void;
  signal?: AbortSignal;
}

export interface Bracket {
  feasible: number | null;
  infeasible: number | null;
}

export interface SearchOutcome {
  status: GoalSeekStatus;
  value: number | null;
  achieved: number | null;
  bracket: Bracket;
}

/** Find the boundary of the feasible region. */
export async function boundarySearch(p: SearchParams): Promise<SearchOutcome> {
  const tol = p.integer ? Math.max(1, p.tolerance) : p.tolerance;
  const round = (v: number) => (p.integer ? Math.round(v) : v);
  const lo0 = round(Math.min(p.lo, p.hi));
  const hi0 = round(Math.max(p.lo, p.hi));
  let spent = 0;
  const metrics = new Map<number, number>();
  const bracket: Bracket = { feasible: null, infeasible: null };
  const at = async (v: number) => {
    checkAbort(p.signal);
    if (!p.isCached(v)) spent += 1;
    const m = await p.evalAt(v);
    metrics.set(v, m);
    const ok = p.metric.feasible(m, p.target);
    if (ok) bracket.feasible = v;
    else bracket.infeasible = v;
    p.onStep?.(v, m, ok, { ...bracket });
    return ok;
  };
  const max = p.direction === "maximize";
  // "good" end is where the objective is easiest to meet.
  const good = max ? lo0 : hi0;
  const bad = max ? hi0 : lo0;
  if (!(await at(good)))
    return { status: "infeasible", value: null, achieved: metrics.get(good)!, bracket };
  if (good === bad || (await at(bad))) {
    bracket.feasible = bad;
    return { status: "at-bound", value: bad, achieved: metrics.get(bad)!, bracket };
  }
  let f = good; // feasible
  let x = bad; // infeasible
  let lastMoved: "f" | "x" | null = null;
  const widths: number[] = [Math.abs(x - f)];
  while (Math.abs(x - f) > tol) {
    if (spent >= p.maxEvaluations) break;
    const w = x - f;
    let mid = (f + x) / 2;
    // Safeguarded interpolation (regula falsi with a squeeze): aim just past the interpolated
    // boundary on the side that has not moved, so both ends close in. Fall back to bisection
    // whenever two steps failed to halve the bracket (step-shaped metrics, e.g. success rates).
    const stalled = widths.length >= 3 && Math.abs(w) > widths[widths.length - 3]! / 2;
    if (p.metric.continuous && !stalled) {
      const mf = metrics.get(f)!;
      const mx = metrics.get(x)!;
      if (mf !== mx) {
        const guess = f + ((p.target - mf) * w) / (mx - mf);
        if (Number.isFinite(guess)) {
          const nudge = 0.45 * tol * Math.sign(w);
          const aim = lastMoved === "x" ? guess - nudge : guess + nudge;
          const lo = Math.min(f + 0.001 * w, f + 0.999 * w);
          const hi = Math.max(f + 0.001 * w, f + 0.999 * w);
          mid = Math.min(hi, Math.max(lo, aim));
        }
      }
    }
    mid = round(mid);
    if (mid === f || mid === x) mid = round((f + x) / 2);
    if (mid === f || mid === x) break;
    if (await at(mid)) {
      f = mid;
      lastMoved = "f";
    } else {
      x = mid;
      lastMoved = "x";
    }
    widths.push(Math.abs(x - f));
  }
  bracket.feasible = f;
  bracket.infeasible = x;
  const converged = Math.abs(x - f) <= tol || (p.integer && Math.abs(x - f) <= 1);
  return {
    status: converged ? "solved" : "max-evaluations",
    value: f,
    achieved: metrics.get(f)!,
    bracket,
  };
}
