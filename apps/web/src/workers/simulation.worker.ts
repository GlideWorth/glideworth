/// <reference lib="webworker" />
import { handleRequest } from "./handle.js";
import type { WorkerRequest } from "./protocol.js";

declare const self: DedicatedWorkerGlobalScope;

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  self.postMessage(handleRequest(e.data));
};
