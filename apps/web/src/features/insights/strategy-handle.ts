/**
 * Tax-strategy optimisation, shared by the worker and the inline fallback (tests). Wraps core's
 * `optimiseTaxStrategy` / `compareStrategies` and serialises failures.
 */
import {
  compareStrategies,
  optimiseTaxStrategy,
  type SimulationInput,
  type StrategyCandidate,
  type StrategyComparison,
  type StrategyObjective,
} from "@glideworth/core";

export interface StrategyRequest {
  id: number;
  input: SimulationInput;
  objective: StrategyObjective;
  /** Omit to use core's candidates for the household (UK drawdown, US bracket filling...). */
  candidates?: StrategyCandidate[];
}

export type StrategyResponse =
  | { id: number; kind: "progress"; done: number }
  | { id: number; kind: "done"; comparison: StrategyComparison }
  | { id: number; kind: "error"; message: string };

export async function runStrategyRequest(
  req: StrategyRequest,
  onProgress: (done: number) => void = () => {},
  signal?: AbortSignal,
): Promise<StrategyComparison> {
  const deps = { onProgress: (n: number) => onProgress(n), ...(signal ? { signal } : {}) };
  return req.candidates
    ? compareStrategies(req.input, req.candidates, { objective: req.objective }, deps)
    : optimiseTaxStrategy(req.input, { objective: req.objective }, deps);
}
