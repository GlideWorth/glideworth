/**
 * Roth conversion planning, shared by the worker and the inline fallback (tests). Wraps core's
 * `planRothConversions` and serialises failures.
 */
import {
  planRothConversions,
  type RothConversionPlan,
  type RothConversionPlanRequest,
  type SimulationInput,
} from "@glideworth/core";

export interface RothPlanRequest {
  id: number;
  input: SimulationInput;
  request: RothConversionPlanRequest;
}

export type RothPlanResponse =
  | { id: number; kind: "progress"; done: number }
  | { id: number; kind: "done"; plan: RothConversionPlan }
  | { id: number; kind: "error"; message: string };

export function runRothPlanRequest(
  req: RothPlanRequest,
  onProgress: (done: number) => void = () => {},
  signal?: AbortSignal,
): Promise<RothConversionPlan> {
  return planRothConversions(req.input, req.request, {
    onProgress: (n: number) => onProgress(n),
    ...(signal ? { signal } : {}),
  });
}
