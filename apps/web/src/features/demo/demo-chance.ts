/**
 * In the demo, the dashboard's chance of success runs by itself: a visitor should see the headline number
 * without first finding the chance-of-success page. Real workspaces keep running it on demand.
 */
import type { Plan, SimulationInput } from "@glideworth/core";
import { useEffect } from "react";
import { isDemo } from "../../lib/demo";
import { McCancelled, runChanceOfSuccess } from "../chance/mc-pool";
import { useMcStore } from "../chance/mc-store";

export function useDemoChanceOfSuccess(input: SimulationInput | undefined, plan: Plan | undefined) {
  const stored = useMcStore((s) => (plan ? s.byPlan[plan.id] : undefined));
  const put = useMcStore((s) => s.put);
  const fresh = !!stored && stored.planVersion === plan?.version;
  useEffect(() => {
    // Without Web Workers the run is synchronous and would freeze the page as it loads; skip it there.
    if (!isDemo() || typeof Worker === "undefined" || !input || !plan || fresh) return;
    const ac = new AbortController();
    runChanceOfSuccess(input, plan.monteCarlo, { signal: ac.signal })
      .then((result) =>
        put(plan.id, { result, planVersion: plan.version, example: false, at: Date.now() }),
      )
      .catch((e: unknown) => {
        // Leaving the page cancels the run; any other failure leaves the "Run it" link in place.
        if (!(e instanceof McCancelled)) console.warn("Demo chance of success failed", e);
      });
    return () => ac.abort();
  }, [input, plan, fresh, put]);
}
