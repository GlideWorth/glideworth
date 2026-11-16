import { useActivePlan, useProjection } from "../../lib/workspace";

export function useActiveProjection() {
  const { plan, workspace } = useActivePlan();
  const q = useProjection(plan?.id);
  return { plan, workspace, ...q };
}
