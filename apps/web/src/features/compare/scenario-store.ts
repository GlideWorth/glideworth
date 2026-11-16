/**
 * Session what-if variants (unsaved). Insights creates them; Compare can overlay them next to
 * saved plans without writing anything to the server.
 */
import type { MarketPath, Plan } from "@glideworth/core";
import { create } from "zustand";

export interface SessionScenario {
  id: string;
  name: string;
  basePlanId: string;
  plan: Plan;
  market?: MarketPath;
  changes: string[];
}

interface ScenarioStore {
  items: SessionScenario[];
  add: (s: SessionScenario) => void;
  remove: (id: string) => void;
  /** Ids preselected for the Compare page. */
  compareIds: string[];
  setCompare: (ids: string[]) => void;
}

export const useScenarioStore = create<ScenarioStore>()((set) => ({
  items: [],
  add: (s) => set((st) => ({ items: [...st.items.filter((x) => x.id !== s.id), s] })),
  remove: (id) => set((st) => ({ items: st.items.filter((x) => x.id !== id) })),
  compareIds: [],
  setCompare: (compareIds) => set({ compareIds }),
}));
