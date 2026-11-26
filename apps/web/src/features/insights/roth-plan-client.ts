import type { RothConversionPlan } from "@glideworth/core";
import {
  type RothPlanRequest,
  type RothPlanResponse,
  runRothPlanRequest,
} from "./roth-plan-handle";

let seq = 0;

/** Plan Roth conversions in a background worker (inline where Workers are unavailable). */
export async function planConversions(
  args: Omit<RothPlanRequest, "id">,
  onProgress?: (done: number) => void,
  signal?: AbortSignal,
): Promise<RothConversionPlan> {
  const req: RothPlanRequest = { ...args, id: ++seq };
  if (typeof Worker === "undefined") return runRothPlanRequest(req, onProgress, signal);
  const w = new Worker(new URL("./roth-plan.worker.ts", import.meta.url), {
    type: "module",
    name: "glideworth-roth-plan",
  });
  try {
    return await new Promise<RothConversionPlan>((resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new Error("Cancelled")), { once: true });
      w.onmessage = (e: MessageEvent<RothPlanResponse>) => {
        const m = e.data;
        if (m.kind === "progress") onProgress?.(m.done);
        else if (m.kind === "done") resolve(m.plan);
        else reject(new Error(m.message));
      };
      w.onerror = (ev) => reject(new Error(ev.message || "Worker failed"));
      w.postMessage(req);
    });
  } finally {
    w.terminate();
  }
}
