/** Everything an analysis view needs about the active plan, its projection and formatting. */
import { buildSimulationInput, type SimulationInput } from "@glideworth/core";
import { useMemo } from "react";
import { useFormat } from "../../lib/workspace";
import { useUi } from "../../stores/ui";
import { buildEntityIndex } from "./model";
import { useActiveProjection } from "./use-active-projection";

export function useAnalysis() {
  const { plan, workspace, data, isLoading, error, refetch } = useActiveProjection();
  const basis = useUi((s) => s.basis);
  const f = useFormat();
  const doc = workspace?.doc;
  const index = useMemo(() => buildEntityIndex(doc, plan), [doc, plan]);
  const input = useMemo((): SimulationInput | undefined => {
    if (!doc || !plan) return undefined;
    try {
      return buildSimulationInput(doc, plan.id, { trace: "summary" });
    } catch {
      return undefined;
    }
  }, [doc, plan]);
  return {
    plan,
    workspace,
    doc,
    input,
    result: data?.result,
    ms: data?.ms,
    isLoading,
    error,
    refetch,
    index,
    basis,
    f,
  };
}
