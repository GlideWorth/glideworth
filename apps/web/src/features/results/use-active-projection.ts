import { useActivePlan, useProjection, useWorkspace } from "../../lib/workspace";

/**
 * True while a results-style page is still waiting for the plan's projection.
 *
 * A disabled projection query (no workspace yet, or the plan id is not known) reports
 * `isLoading: false` in TanStack Query, which is what made /results flash "No plan to show yet"
 * before the household had loaded. There is genuinely nothing to show only once the workspace
 * has arrived and it has no plan.
 */
export function awaitingProjection(state: {
  workspacePending: boolean;
  hasPlan: boolean;
  projectionPending: boolean;
  hasResult: boolean;
}): boolean {
  if (state.hasResult) return false;
  if (state.workspacePending) return true;
  return state.hasPlan && state.projectionPending;
}

export function useActiveProjection() {
  const workspaceQuery = useWorkspace();
  const { plan, workspace } = useActivePlan();
  const q = useProjection(plan?.id);
  const isLoading = awaitingProjection({
    workspacePending: workspaceQuery.isPending,
    hasPlan: !!plan,
    projectionPending: q.isPending,
    hasResult: q.data != null,
  });
  return { plan, workspace, ...q, isLoading };
}
