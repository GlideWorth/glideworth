import type { StrategyComparison } from "@glideworth/core";
import { runStrategyRequest, type StrategyRequest, type StrategyResponse } from "./strategy-handle";

let seq = 0;

/** Compare tax strategies in a background worker (inline where Workers are unavailable). */
export async function rankStrategies(
  args: Omit<StrategyRequest, "id">,
  onProgress?: (done: number) => void,
  signal?: AbortSignal,
): Promise<StrategyComparison> {
  const req: StrategyRequest = { ...args, id: ++seq };
  if (typeof Worker === "undefined") return runStrategyRequest(req, onProgress, signal);
  const w = new Worker(new URL("./strategy.worker.ts", import.meta.url), {
    type: "module",
    name: "glideworth-strategy",
  });
  try {
    return await new Promise<StrategyComparison>((resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new Error("Cancelled")), { once: true });
      w.onmessage = (e: MessageEvent<StrategyResponse>) => {
        const m = e.data;
        if (m.kind === "progress") onProgress?.(m.done);
        else if (m.kind === "done") resolve(m.comparison);
        else reject(new Error(m.message));
      };
      w.onerror = (ev) => reject(new Error(ev.message || "Worker failed"));
      w.postMessage(req);
    });
  } finally {
    w.terminate();
  }
}
