/**
 * Promise-based harness around the simulation Web Worker. Heavy simulation never runs on the UI
 * thread; when Workers are unavailable (tests, SSR) it falls back to running inline, loading the
 * engine lazily.
 */
import type { ProjectionResult, SimulationInput } from "@glideworth/core";
import type { WorkerErrorPayload, WorkerRequest, WorkerResponse } from "./protocol.js";

export class SimulationError extends Error {
  constructor(readonly payload: WorkerErrorPayload) {
    super(payload.message);
    this.name = payload.name;
  }
  get isNotImplemented(): boolean {
    return this.payload.code === "NOT_IMPLEMENTED";
  }
}

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, { resolve: (r: WorkerResponse) => void }>();

function getWorker(): Worker | null {
  if (typeof Worker === "undefined") return null;
  if (!worker) {
    worker = new Worker(new URL("./simulation.worker.ts", import.meta.url), {
      type: "module",
      name: "glideworth-sim",
    });
    worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      pending.get(e.data.id)?.resolve(e.data);
      pending.delete(e.data.id);
    };
  }
  return worker;
}

function send(req: WorkerRequest): Promise<WorkerResponse> {
  const w = getWorker();
  // No Workers (tests, very old browsers): run inline. The engine is then loaded on demand, so it
  // is never part of the main thread's start-up bundle.
  if (!w) return import("./handle.js").then((m) => m.handleRequest(req));
  return new Promise((resolve) => {
    pending.set(req.id, { resolve });
    w.postMessage(req);
  });
}

export async function runSimulation(
  input: SimulationInput,
): Promise<{ result: ProjectionResult; ms: number }> {
  const res = await send({ id: ++seq, kind: "simulate", input });
  if (!res.ok) throw new SimulationError(res.error);
  return { result: res.result, ms: res.ms };
}
