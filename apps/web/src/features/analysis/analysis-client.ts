/**
 * Run an analysis in a background worker (one worker per request, terminated when done or
 * cancelled) so the UI thread never runs the extra projections; inline where Workers are absent.
 */
import { useQuery } from "@tanstack/react-query";
import {
  type AnalysisRequest,
  type AnalysisResponse,
  type AnalysisResult,
  runAnalysis,
} from "./analysis-handle";

let seq = 0;

type Req<K extends AnalysisRequest["kind"]> = Omit<Extract<AnalysisRequest, { kind: K }>, "id">;

export class AnalysisError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

export async function analyse<K extends AnalysisRequest["kind"]>(
  req: Req<K>,
  signal?: AbortSignal,
): Promise<AnalysisResult[K]> {
  const full = { ...req, id: ++seq } as AnalysisRequest;
  if (typeof Worker === "undefined") return (await runAnalysis(full)) as AnalysisResult[K];
  const w = new Worker(new URL("./analysis.worker.ts", import.meta.url), {
    type: "module",
    name: "glideworth-analysis",
  });
  try {
    return await new Promise<AnalysisResult[K]>((resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new Error("Cancelled")), { once: true });
      w.onmessage = (e: MessageEvent<AnalysisResponse>) => {
        const m = e.data;
        if (m.ok) resolve(m.value as AnalysisResult[K]);
        else reject(new AnalysisError(m.message, m.code));
      };
      w.onerror = (ev) => reject(new Error(ev.message || "The analysis worker failed"));
      w.postMessage(full);
    });
  } finally {
    w.terminate();
  }
}

/** React Query wrapper: cached per key, never retried (a failure is a modelling answer). */
export function useAnalysisQuery<K extends AnalysisRequest["kind"]>(
  key: unknown[],
  req: Req<K> | null,
  enabled = true,
) {
  return useQuery({
    queryKey: ["analysis", ...key],
    enabled: enabled && !!req,
    queryFn: ({ signal }) => analyse<K>(req!, signal),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 10 * 60_000,
    retry: false,
  });
}
