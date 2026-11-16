/**
 * Latest chance-of-success result per plan (in memory for the session), so the dashboard,
 * insights and the report can show it without re-running.
 */
import type { MonteCarloResult } from "@glideworth/core";
import { create } from "zustand";

interface Entry {
  result: MonteCarloResult;
  planVersion: number;
  example: boolean;
  at: number;
}
interface McStore {
  byPlan: Record<string, Entry>;
  put: (planId: string, e: Entry) => void;
}

export const useMcStore = create<McStore>()((set) => ({
  byPlan: {},
  put: (planId, e) => set((s) => ({ byPlan: { ...s.byPlan, [planId]: e } })),
}));
