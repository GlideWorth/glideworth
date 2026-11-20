/**
 * Preferences that have no home in the `UserSettings` schema yet, kept per browser. Durable,
 * cross-device settings (currency, locale, theme, basis, spending definition...) go through the
 * API; see lib/settings.ts. Everything here is safe to lose: it only changes presentation or the
 * defaults used when something new is created.
 */
import type { ImportIssue } from "@glideworth/importers";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { demoAwareStorage } from "../lib/demo";

export type DateStyle = "short" | "medium" | "iso";
export type TaxYearConvention = "auto" | "calendar" | "uk-april" | "au-july" | "nz-april";

export interface SuccessBands {
  /** At or above: "on track" (positive tone). */
  good: number;
  /** At or above (and below `good`): "watch" (warning tone). Below: "at risk". */
  fair: number;
}

export interface PlanDefaults {
  retirementAge: number;
  lifeExpectancy: number;
  inflation: number;
  stockReturn: number;
  bondReturn: number;
}

export interface MonteCarloDefaults {
  /** Worker threads; 0 = automatic (cores − 1, at most 6). */
  workers: number;
  trials: number;
  /** null = a new seed each run. */
  seed: number | null;
}

interface PrefsState {
  dateStyle: DateStyle;
  taxYear: TaxYearConvention;
  chartAnimation: boolean;
  smoothCurves: boolean;
  successBands: SuccessBands;
  planDefaults: PlanDefaults;
  monteCarlo: MonteCarloDefaults;
  /** Last seen tour step; null = not started, 'done' = finished or dismissed. */
  tour: string | null;
  /** Post-import "review your imported plans" checklist. */
  importChecklist: ImportChecklist | null;
  /** The issues of the last ProjectionLab import, so the report stays readable afterwards. */
  lastImport: LastImport | null;
  set: (patch: Partial<Omit<PrefsState, "set">>) => void;
}

export interface ImportChecklistItem {
  id: string;
  label: string;
  detail?: string;
  /** Route to open for this item. */
  to: string;
  search?: Record<string, string>;
  /** Plan to activate before navigating. */
  planId?: string;
  done: boolean;
}

export interface LastImport {
  source: string;
  fileName: string;
  at: string;
  issues: ImportIssue[];
  issueCounts: Record<string, number>;
}

export interface ImportChecklist {
  source: string;
  at: string;
  items: ImportChecklistItem[];
}

export const DEFAULT_SUCCESS_BANDS: SuccessBands = { good: 0.8, fair: 0.6 };
export const DEFAULT_PLAN_DEFAULTS: PlanDefaults = {
  retirementAge: 0,
  lifeExpectancy: 92,
  inflation: 0.025,
  stockReturn: 0.07,
  bondReturn: 0.035,
};
export const DEFAULT_MC: MonteCarloDefaults = { workers: 0, trials: 1000, seed: null };

export const usePrefs = create<PrefsState>()(
  persist(
    (set) => ({
      dateStyle: "medium",
      taxYear: "auto",
      chartAnimation: true,
      smoothCurves: false,
      successBands: DEFAULT_SUCCESS_BANDS,
      planDefaults: DEFAULT_PLAN_DEFAULTS,
      monteCarlo: DEFAULT_MC,
      tour: null,
      importChecklist: null,
      lastImport: null,
      set: (patch) => set(patch),
    }),
    { name: "glideworth-prefs", version: 1, storage: createJSONStorage(() => demoAwareStorage) },
  ),
);

export type SuccessTone = "positive" | "warning" | "negative";

/** The tone for a chance-of-success rate under the user's bands. */
export function successTone(
  rate: number,
  bands: SuccessBands = usePrefs.getState().successBands,
): SuccessTone {
  if (rate >= bands.good) return "positive";
  if (rate >= bands.fair) return "warning";
  return "negative";
}

/** Worker count for Monte Carlo under the user's preference (0 = automatic). */
export function preferredWorkers(auto: number): number {
  const w = usePrefs.getState().monteCarlo.workers;
  return w > 0 ? w : auto;
}
