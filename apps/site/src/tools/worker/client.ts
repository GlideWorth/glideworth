/**
 * Page-side client of the engine worker. The worker (and with it the ~0.5 MB engine) is created on
 * first use: the page calls `warm()` on the first interaction or when the browser is idle. Without
 * module-worker support the engine is imported on the main thread instead.
 */
import type { ToolId, Values, ViewModel } from "../types";
import type { WorkerRequest, WorkerResponse } from "./protocol";

export interface RunHandle {
  id: number;
  result: Promise<{ vm: ViewModel; ms: number } | null>;
  cancel(): void;
}

type Listener = (res: WorkerResponse) => void;

let worker: Worker | null = null;
let failed = false;
let seq = 0;
const listeners = new Map<number, Listener>();

function dispatch(res: WorkerResponse) {
  if (res.type === "ready") return;
  listeners.get(res.id)?.(res);
}

function getWorker(): Worker | null {
  if (failed || typeof Worker === "undefined") return null;
  if (!worker) {
    try {
      worker = new Worker(new URL("./engine.worker.ts", import.meta.url), {
        type: "module",
        name: "glideworth-engine",
      });
      worker.onmessage = (e: MessageEvent<WorkerResponse>) => dispatch(e.data);
      worker.onerror = () => {
        // A worker that cannot start (old browser, blocked) falls back to the main thread.
        failed = true;
        worker = null;
        for (const id of [...listeners.keys()])
          listeners.get(id)?.({ type: "error", id, message: "worker failed" });
      };
    } catch {
      failed = true;
      worker = null;
    }
  }
  return worker;
}

/** Start loading the engine without running anything. */
export function warm(): void {
  if (!getWorker()) void import("./handle");
}

function send(req: WorkerRequest) {
  const w = getWorker();
  if (w) {
    w.postMessage(req);
    return;
  }
  void import("./handle").then((m) => m.handle(req, dispatch));
}

export function runInEngine(
  tool: ToolId,
  values: Values,
  onProgress?: (done: number, total: number) => void,
): RunHandle {
  const id = ++seq;
  let settle: (v: { vm: ViewModel; ms: number } | null) => void = () => {};
  let fail: (e: Error) => void = () => {};
  const result = new Promise<{ vm: ViewModel; ms: number } | null>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  let retried = false;
  const listener: Listener = (res) => {
    if (res.type === "progress") onProgress?.(res.done, res.total);
    else if (res.type === "result") {
      listeners.delete(id);
      settle({ vm: res.vm, ms: res.ms });
    } else if (res.type === "cancelled") {
      listeners.delete(id);
      settle(null);
    } else if (res.type === "error") {
      if (res.message === "worker failed" && !retried) {
        retried = true;
        send({ type: "run", id, tool, values });
        return;
      }
      listeners.delete(id);
      fail(new Error(res.message));
    }
  };
  listeners.set(id, listener);
  send({ type: "run", id, tool, values });
  return {
    id,
    result,
    cancel() {
      if (!listeners.has(id)) return;
      send({ type: "cancel", id });
    },
  };
}
