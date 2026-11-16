import type { ValueBasis } from "@glideworth/core";
import { create } from "zustand";
import { persist } from "zustand/middleware";

export type ThemePref = "system" | "light" | "dark";
export type Density = "comfortable" | "compact";

interface UiState {
  theme: ThemePref;
  basis: ValueBasis;
  /** Show a partial first/last plan year scaled to a full year (single-year views only). */
  annualisePartial: boolean;
  activePlanId: string | null;
  sidebarCollapsed: boolean;
  /** Phone/tablet navigation drawer (not persisted in practice: reset on load). */
  navOpen: boolean;
  density: Density;
  /** Solid surfaces instead of translucent/blurred chrome (accessibility). */
  reduceTransparency: boolean;
  /** App-level reduced motion, on top of the OS setting. */
  reduceMotion: boolean;
  /** Dismissed contextual hints, by id. */
  dismissedHints: Record<string, true>;
  shortcutsOpen: boolean;
  /** The signed-in person may only look (viewer role): edits are refused before they happen. */
  readOnly: boolean;
  /** Why: the person's role, or (cloud) the workspace's plan being read-only. */
  readOnlyWhy: "role" | "plan";
  setReadOnly: (v: boolean, why?: "role" | "plan") => void;
  setTheme: (t: ThemePref) => void;
  setBasis: (b: ValueBasis) => void;
  setAnnualisePartial: (v: boolean) => void;
  setActivePlan: (id: string) => void;
  toggleSidebar: () => void;
  setNavOpen: (open: boolean) => void;
  setDensity: (d: Density) => void;
  setReduceTransparency: (v: boolean) => void;
  setReduceMotion: (v: boolean) => void;
  dismissHint: (id: string) => void;
  resetHints: () => void;
  setShortcutsOpen: (open: boolean) => void;
}

/** Local UI preferences (per browser). Durable user settings live in the API (UserSettings). */
export const useUi = create<UiState>()(
  persist(
    (set) => ({
      theme: "system",
      basis: "real",
      annualisePartial: false,
      activePlanId: null,
      sidebarCollapsed: false,
      navOpen: false,
      density: "comfortable",
      reduceTransparency: false,
      reduceMotion: false,
      dismissedHints: {},
      shortcutsOpen: false,
      readOnly: false,
      readOnlyWhy: "role",
      setReadOnly: (readOnly, why = "role") => set({ readOnly, readOnlyWhy: why }),
      setTheme: (theme) => set({ theme }),
      setBasis: (basis) => set({ basis }),
      setAnnualisePartial: (annualisePartial) => set({ annualisePartial }),
      setActivePlan: (activePlanId) => set({ activePlanId }),
      toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
      setNavOpen: (navOpen) => set({ navOpen }),
      setDensity: (density) => set({ density }),
      setReduceTransparency: (reduceTransparency) => set({ reduceTransparency }),
      setReduceMotion: (reduceMotion) => set({ reduceMotion }),
      dismissHint: (id) => set((s) => ({ dismissedHints: { ...s.dismissedHints, [id]: true } })),
      resetHints: () => set({ dismissedHints: {} }),
      setShortcutsOpen: (shortcutsOpen) => set({ shortcutsOpen }),
    }),
    {
      name: "glideworth-ui",
      // Transient UI state never survives a reload.
      partialize: ({ navOpen: _n, shortcutsOpen: _s, readOnly: _r, readOnlyWhy: _w, ...rest }) =>
        rest,
    },
  ),
);

export function resolvedTheme(pref: ThemePref): "light" | "dark" {
  if (pref !== "system") return pref;
  return typeof matchMedia !== "undefined" && matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}
