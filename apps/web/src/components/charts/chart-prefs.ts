/**
 * Chart display preferences (per browser). Kept in the charts module so analysis views share one
 * source; durable user settings stay in UserSettings via the API.
 */
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { demoAwareStorage } from "../../lib/demo";

export type ProjectionMode =
  | "netWorth"
  | "byAccount"
  | "byTreatment"
  | "assetsDebts"
  | "incomeExpenses"
  | "cashFlow";
export type ChartKind = "bar" | "area" | "line";

interface ChartPrefs {
  /** Add hatch/dot decals to filled series (colour-vision deficiency, print, forced colours). */
  patterns: boolean;
  projectionMode: ProjectionMode;
  chartKind: ChartKind;
  /** 'year' or a person id: what the x axis is labelled with. */
  axis: string;
  tableColumns: string[] | null;
  dashboardWidgets: Record<string, boolean>;
  setPatterns: (v: boolean) => void;
  setProjectionMode: (m: ProjectionMode) => void;
  setChartKind: (k: ChartKind) => void;
  setAxis: (a: string) => void;
  setTableColumns: (c: string[] | null) => void;
  setDashboardWidget: (id: string, on: boolean) => void;
}

export const useChartPrefs = create<ChartPrefs>()(
  persist(
    (set) => ({
      patterns: false,
      projectionMode: "netWorth",
      chartKind: "bar",
      axis: "year",
      tableColumns: null,
      dashboardWidgets: {},
      setPatterns: (patterns) => set({ patterns }),
      setProjectionMode: (projectionMode) => set({ projectionMode }),
      setChartKind: (chartKind) => set({ chartKind }),
      setAxis: (axis) => set({ axis }),
      setTableColumns: (tableColumns) => set({ tableColumns }),
      setDashboardWidget: (id, on) =>
        set((s) => ({ dashboardWidgets: { ...s.dashboardWidgets, [id]: on } })),
    }),
    { name: "glideworth-chart-prefs", storage: createJSONStorage(() => demoAwareStorage) },
  ),
);

/**
 * True when the OS or the app asks for reduced motion, or chart animation is switched off in
 * Settings → Appearance (checked at chart build time).
 */
export function prefersReducedMotion(): boolean {
  if (typeof document !== "undefined") {
    const d = document.documentElement.dataset;
    if (d.motion === "reduced" || d.chartAnimation === "off") return true;
  }
  return (
    typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}
