/// <reference lib="webworker" />
import { runStrategyRequest, type StrategyRequest, type StrategyResponse } from "./strategy-handle";

declare const self: DedicatedWorkerGlobalScope;

self.onmessage = (e: MessageEvent<StrategyRequest>) => {
  const req = e.data;
  const post = (m: StrategyResponse) => self.postMessage(m);
  runStrategyRequest(req, (done) => post({ id: req.id, kind: "progress", done }))
    .then((comparison) => post({ id: req.id, kind: "done", comparison }))
    .catch((err) =>
      post({
        id: req.id,
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      }),
    );
};
