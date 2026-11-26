/// <reference lib="webworker" />
import {
  type RothPlanRequest,
  type RothPlanResponse,
  runRothPlanRequest,
} from "./roth-plan-handle";

declare const self: DedicatedWorkerGlobalScope;

self.onmessage = (e: MessageEvent<RothPlanRequest>) => {
  const req = e.data;
  const post = (m: RothPlanResponse) => self.postMessage(m);
  runRothPlanRequest(req, (done) => post({ id: req.id, kind: "progress", done }))
    .then((plan) => post({ id: req.id, kind: "done", plan }))
    .catch((err) =>
      post({
        id: req.id,
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      }),
    );
};
