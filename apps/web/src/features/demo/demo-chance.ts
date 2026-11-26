/**
 * In the demo, chance of success runs by itself: a visitor should see the headline number
 * without first finding the chance-of-success page, and that page should show the same run.
 * Real workspaces keep running it on demand.
 *
 * The run lives with the app shell, not the dashboard, so leaving the dashboard does not cancel
 * it. The result is also kept in session storage so a full page load of /demo/chance (a new
 * JavaScript context) still shows the run the dashboard just finished.
 */
import type { Plan, SimulationInput } from "@glideworth/core";
import { useEffect, useLayoutEffect } from "react";
import { DEMO_KEYS, isDemo } from "../../lib/demo";
import { type SavedChance, parseSavedChance, readSavedChance } from "../chance/chance-memory";
import { McCancelled, runChanceOfSuccess } from "../chance/mc-pool";
import { type ChanceRun, useMcStore } from "../chance/mc-store";
import { useEditorStore } from "../plan-editor/state/doc-store";

export type { SavedChance };

export function readDemoChance(): SavedChance | null {
  if (!isDemo()) return null;
  try {
    return parseSavedChance(sessionStorage.getItem(DEMO_KEYS.chance));
  } catch {
    return null;
  }
}

export function writeDemoChance(saved: SavedChance): void {
  try {
    sessionStorage.setItem(DEMO_KEYS.chance, JSON.stringify(saved));
  } catch {
    // Full or blocked: this page still has the result in memory.
  }
}

let autoAbort: AbortController | null = null;
/** Identifies the automatic run whose "running" phase is on screen, so a finished older run cannot clear a newer one. */
let phaseToken: object | null = null;

/** Stop the demo's automatic run so a manual "Run" on the chance page is the one that lands. */
export function cancelDemoChanceRun(): void {
  autoAbort?.abort();
  autoAbort = null;
}

/**
 * The run already in memory for this plan version, or the one saved in this tab. Reading session
 * storage before paint is what lets /chance (and the dashboard) open onto the last run instead of
 * "No run yet" after a reload. A different plan version is a different plan, so it is not restored.
 */
export function useRememberedChance(
  plan: { id: string; version: number } | undefined,
): ChanceRun | undefined {
  const put = useMcStore((s) => s.put);
  const stored = useMcStore((s) => (plan ? s.byPlan[plan.id] : undefined));
  const planId = plan?.id;
  const planVersion = plan?.version;
  // The saved run is checked against the household in the editor, which loads just after the plan
  // on a reload: look again once it is there.
  const household = useEditorStore((s) => (s.ready ? s.householdId : null));
  useLayoutEffect(() => {
    if (planId === undefined || planVersion === undefined) return;
    if (stored && stored.planVersion === planVersion) return;
    const saved = isDemo() ? readDemoChance() : readSavedChance(planId);
    if (!saved || saved.planId !== planId || saved.planVersion !== planVersion) return;
    put(planId, {
      result: saved.result,
      planVersion: saved.planVersion,
      example: false,
      at: saved.at,
    });
  }, [planId, planVersion, stored, put, household]);
  return stored && planVersion !== undefined && stored.planVersion === planVersion
    ? stored
    : undefined;
}

export function useDemoChanceOfSuccess(input: SimulationInput | undefined, plan: Plan | undefined) {
  const put = useMcStore((s) => s.put);
  const setDemoPhase = useMcStore((s) => s.setDemoPhase);
  useEffect(() => {
    // Without Web Workers the run is synchronous and would freeze the page as it loads; skip it there.
    if (!isDemo() || !plan) return;
    // Read the store now, not a value closed over from render: a layout effect may have just
    // restored the dashboard's run, and starting another one would throw that result away.
    const live = useMcStore.getState().byPlan[plan.id];
    if (live && live.planVersion === plan.version) return;
    const saved = readDemoChance();
    if (saved && saved.planId === plan.id && saved.planVersion === plan.version) {
      put(plan.id, {
        result: saved.result,
        planVersion: saved.planVersion,
        example: false,
        at: saved.at,
      });
      return;
    }
    if (typeof Worker === "undefined" || !input) {
      setDemoPhase(plan.id, "unavailable");
      return;
    }
    const ac = new AbortController();
    const token = {};
    autoAbort = ac;
    phaseToken = token;
    const planId = plan.id;
    const planVersion = plan.version;
    setDemoPhase(planId, "running");
    runChanceOfSuccess(input, plan.monteCarlo, { signal: ac.signal })
      .then((result) => {
        if (ac.signal.aborted) return;
        const at = Date.now();
        put(planId, { result, planVersion, example: false, at });
        writeDemoChance({ planId, planVersion, result, at });
      })
      .catch((e: unknown) => {
        // A manual Run on the chance page aborts this one; any other failure leaves "Run now".
        if (e instanceof McCancelled || ac.signal.aborted) return;
        console.warn("Demo chance of success failed", e);
        if (phaseToken === token) setDemoPhase(planId, "failed");
      })
      .finally(() => {
        if (autoAbort === ac) autoAbort = null;
        if (phaseToken === token && useMcStore.getState().demoPhase[planId] === "running") {
          setDemoPhase(planId, null);
        }
      });
    return () => {
      ac.abort();
      if (autoAbort === ac) autoAbort = null;
    };
  }, [input, plan, put, setDemoPhase]);
}
