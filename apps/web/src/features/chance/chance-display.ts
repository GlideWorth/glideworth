import type { DemoChancePhase } from "./mc-store";

export type ChanceRunStatus = "idle" | "running" | "done" | "error" | "cancelled";

export interface ChanceEmptyState {
  hasResult: boolean;
  status: ChanceRunStatus;
  projectionLoading: boolean;
  demo: boolean;
  demoPhase: DemoChancePhase | undefined;
}

/**
 * The demo starts the same run the dashboard shows. Until that run finishes, fails, or cannot
 * start, the chance page is loading — "No run yet" would contradict the number already on screen.
 */
export function showDemoRunLoading(state: ChanceEmptyState): boolean {
  if (!state.demo || state.hasResult || state.projectionLoading) return false;
  if (state.status === "running" || state.status === "error" || state.status === "cancelled")
    return false;
  return state.demoPhase !== "failed" && state.demoPhase !== "unavailable";
}

/** The "No run yet / Run now" card. Hidden while a result, a load, or the demo's own run is in flight. */
export function showNoRunYet(state: ChanceEmptyState): boolean {
  if (
    state.hasResult ||
    state.projectionLoading ||
    state.status === "running" ||
    state.status === "error"
  )
    return false;
  if (showDemoRunLoading(state)) return false;
  return true;
}
