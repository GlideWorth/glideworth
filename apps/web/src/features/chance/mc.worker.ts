/// <reference lib="webworker" />
import { errorPayload, runOneTrial, runShard } from "./mc-handle";
import type { McRequest, McResponse } from "./mc-protocol";

declare const self: DedicatedWorkerGlobalScope;

self.onmessage = (e: MessageEvent<McRequest>) => {
  const req = e.data;
  const post = (m: McResponse, transfer: Transferable[] = []) => self.postMessage(m, transfer);
  try {
    if (req.kind === "shard") {
      const t0 = performance.now();
      let last = 0;
      const shard = runShard(
        req.input,
        req.settings,
        req.shardIndex,
        req.shardCount,
        (done, total) => {
          const now = performance.now();
          if (now - last > 60 || done === total) {
            last = now;
            post({ id: req.id, kind: "progress", done, total });
          }
        },
        () => false,
        req.metrics !== undefined ? { metrics: req.metrics } : {},
      );
      const s = shard as {
        values?: Float64Array;
        priceIndex?: Float64Array;
        failureIndex?: Int32Array;
      };
      const transfer = [s.values?.buffer, s.priceIndex?.buffer, s.failureIndex?.buffer].filter(
        (b): b is ArrayBuffer => b instanceof ArrayBuffer,
      );
      post({ id: req.id, kind: "shard", shard, ms: performance.now() - t0 }, transfer);
    } else {
      const r = runOneTrial(req.input, req.settings, req.trial);
      post({ id: req.id, kind: "trial", market: r.market, result: r.result });
    }
  } catch (err) {
    post({ id: req.id, kind: "error", error: errorPayload(err) });
  }
};
