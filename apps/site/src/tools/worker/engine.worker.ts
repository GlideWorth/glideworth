/// <reference lib="webworker" />
/**
 * The calculators' engine worker. It loads @glideworth/core once and runs every calculation off the
 * page's main thread, so Monte Carlo runs can report progress and be cancelled. It only ever talks to
 * the page that started it: no network access, no storage.
 */
import { handle } from "./handle";
import type { WorkerRequest } from "./protocol";

declare const self: DedicatedWorkerGlobalScope;

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  void handle(e.data, (res) => self.postMessage(res));
};
self.postMessage({ type: "ready" });
