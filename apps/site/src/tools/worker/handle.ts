/**
 * Runs one request against the engine and reports progress through `post`. Shared by the worker and
 * the main-thread fallback (browsers without module workers), and used directly in tests.
 */
import { runTool } from "../engine";
import type { WorkerRequest, WorkerResponse } from "./protocol";

const running = new Map<number, AbortController>();

export async function handle(
  req: WorkerRequest,
  post: (res: WorkerResponse) => void,
): Promise<void> {
  if (req.type === "cancel") {
    running.get(req.id)?.abort();
    return;
  }
  const controller = new AbortController();
  running.set(req.id, controller);
  const t0 = performance.now();
  let last = 0;
  try {
    const vm = await runTool(req.tool, req.values, {
      signal: controller.signal,
      onProgress: (done, total) => {
        // At most about 20 progress messages a second.
        const now = performance.now();
        if (now - last > 50 || done === total) {
          last = now;
          post({ type: "progress", id: req.id, done, total });
        }
      },
    });
    post({ type: "result", id: req.id, vm, ms: performance.now() - t0 });
  } catch (e) {
    if (controller.signal.aborted) post({ type: "cancelled", id: req.id });
    else post({ type: "error", id: req.id, message: e instanceof Error ? e.message : String(e) });
  } finally {
    running.delete(req.id);
  }
}
