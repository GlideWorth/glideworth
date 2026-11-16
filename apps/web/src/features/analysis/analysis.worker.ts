/// <reference lib="webworker" />
import { type AnalysisRequest, type AnalysisResponse, runAnalysis } from "./analysis-handle";

declare const self: DedicatedWorkerGlobalScope;

self.onmessage = (e: MessageEvent<AnalysisRequest>) => {
  const req = e.data;
  const post = (m: AnalysisResponse) => self.postMessage(m);
  runAnalysis(req)
    .then((value) => post({ id: req.id, ok: true, value }))
    .catch((err) =>
      post({
        id: req.id,
        ok: false,
        message: err instanceof Error ? err.message : String(err),
        ...(err && typeof err === "object" && "code" in err
          ? { code: String((err as { code: unknown }).code) }
          : {}),
      }),
    );
};
