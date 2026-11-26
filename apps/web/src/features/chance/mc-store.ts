/**
 * Latest chance-of-success result per plan, so the dashboard, insights and the report can show
 * it without re-running. A real run is also written to session storage (see chance-memory) so a
 * reload of this tab keeps it; example previews are memory only.
 */
import type { MonteCarloResult } from "@glideworth/core";
import { create } from "zustand";
import { rememberChanceRun } from "./chance-memory";

export interface ChanceRun {
  result: MonteCarloResult;
  planVersion: number;
  example: boolean;
  at: number;
}

/** Where the demo's automatic run is. Absent means it has not reported yet. */
export type DemoChancePhase = "running" | "failed" | "unavailable";

interface McStore {
  byPlan: Record<string, ChanceRun>;
  demoPhase: Record<string, DemoChancePhase>;
  put: (planId: string, e: ChanceRun) => void;
  setDemoPhase: (planId: string, phase: DemoChancePhase | null) => void;
}

export const useMcStore = create<McStore>()((set) => ({
  byPlan: {},
  demoPhase: {},
  put: (planId, e) => {
    set((s) => ({ byPlan: { ...s.byPlan, [planId]: e } }));
    rememberChanceRun(planId, e);
  },
  setDemoPhase: (planId, phase) =>
    set((s) => {
      const demoPhase = { ...s.demoPhase };
      if (phase === null) delete demoPhase[planId];
      else demoPhase[planId] = phase;
      return { demoPhase };
    }),
}));
