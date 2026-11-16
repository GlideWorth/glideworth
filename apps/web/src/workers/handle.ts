import { GlideworthError, NotImplementedError, simulate } from "@glideworth/core";
import type { WorkerRequest, WorkerResponse } from "./protocol.js";

/** Pure request handler shared by the worker and the main-thread fallback (and tests). */
export function handleRequest(req: WorkerRequest): WorkerResponse {
  const t0 = performance.now();
  try {
    const result = simulate(req.input);
    return { id: req.id, ok: true, kind: "simulate", result, ms: performance.now() - t0 };
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    return {
      id: req.id,
      ok: false,
      error: {
        name: err.name,
        message: err.message,
        ...(e instanceof GlideworthError ? { code: e.code } : {}),
        ...(e instanceof NotImplementedError
          ? { feature: e.feature, workstream: e.workstream }
          : {}),
      },
    };
  }
}
