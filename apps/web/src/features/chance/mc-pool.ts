/**
 * Chance-of-success worker pool: shards trials across N module workers, streams progress,
 * cancels by terminating workers, and merges the shards on the main thread (exactly equal to a
 * single-threaded run, by core's deriveSeed(seed, trial) design). Falls back to inline execution
 * where Workers are unavailable (tests).
 */
import type {
  MarketPath,
  MonteCarloResult,
  MonteCarloSettings,
  MonteCarloShard,
  ProjectionResult,
  SimulationInput,
} from "@glideworth/core";
import { SimulationError } from "../../workers/sim-client";
import { errorPayload, mergeShards, runOneTrial, runShard } from "./mc-handle";
import type { McRequest, McResponse } from "./mc-protocol";

export class McCancelled extends Error {
  constructor() {
    super("Cancelled");
    this.name = "McCancelled";
  }
}

function spawn(): Worker {
  return new Worker(new URL("./mc.worker.ts", import.meta.url), {
    type: "module",
    name: "glideworth-mc",
  });
}

export function poolSize(): number {
  const hc = typeof navigator !== "undefined" ? navigator.hardwareConcurrency || 4 : 4;
  return Math.max(1, Math.min(6, hc - 1));
}

let seq = 0;

export async function runChanceOfSuccess(
  input: SimulationInput,
  settings: MonteCarloSettings,
  opts: {
    onProgress?: (done: number, total: number) => void;
    signal?: AbortSignal;
    workers?: number;
  } = {},
): Promise<MonteCarloResult> {
  const t0 = performance.now();
  if (typeof Worker === "undefined") {
    try {
      const shard = runShard(
        input,
        settings,
        0,
        1,
        (d, t) => opts.onProgress?.(d, t),
        () => !!opts.signal?.aborted,
      );
      return { ...mergeShards([shard], settings), durationMs: performance.now() - t0 };
    } catch (e) {
      throw new SimulationError(errorPayload(e));
    }
  }
  const n = opts.workers ?? poolSize();
  const workers = Array.from({ length: n }, spawn);
  const done = new Array<number>(n).fill(0);
  const totals = new Array<number>(n).fill(0);
  const kill = () => {
    for (const w of workers) w.terminate();
  };
  try {
    const shards = await new Promise<MonteCarloShard[]>((resolve, reject) => {
      const out = new Array<MonteCarloShard>(n);
      let remaining = n;
      const onAbort = () => {
        kill();
        reject(new McCancelled());
      };
      if (opts.signal?.aborted) return onAbort();
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      workers.forEach((w, i) => {
        const id = ++seq;
        w.onmessage = (e: MessageEvent<McResponse>) => {
          const m = e.data;
          if (m.kind === "progress") {
            done[i] = m.done;
            totals[i] = m.total;
            opts.onProgress?.(
              done.reduce((s, x) => s + x, 0),
              totals.reduce((s, x) => s + x, 0),
            );
          } else if (m.kind === "shard") {
            out[i] = m.shard;
            if (--remaining === 0) resolve(out);
          } else if (m.kind === "error") {
            kill();
            reject(new SimulationError(m.error));
          }
        };
        w.onerror = (ev) => {
          kill();
          reject(new Error(ev.message || "Worker failed"));
        };
        const req: McRequest = { id, kind: "shard", input, settings, shardIndex: i, shardCount: n };
        w.postMessage(req);
      });
    });
    return {
      ...mergeShards(
        shards.filter((s) => s.trialIndex.length !== 0),
        settings,
      ),
      durationMs: performance.now() - t0,
    };
  } catch (e) {
    if (e instanceof McCancelled || e instanceof SimulationError) throw e;
    throw new SimulationError(errorPayload(e));
  } finally {
    kill();
  }
}

/** Re-run one trial in full (ledger, line items) in a worker. */
export async function runTrialDetail(
  input: SimulationInput,
  settings: MonteCarloSettings,
  trial: number,
): Promise<{ market: MarketPath; result: ProjectionResult }> {
  if (typeof Worker === "undefined") {
    try {
      return runOneTrial(input, settings, trial);
    } catch (e) {
      throw new SimulationError(errorPayload(e));
    }
  }
  const w = spawn();
  try {
    return await new Promise((resolve, reject) => {
      w.onmessage = (e: MessageEvent<McResponse>) => {
        const m = e.data;
        if (m.kind === "trial") resolve({ market: m.market, result: m.result });
        else if (m.kind === "error") reject(new SimulationError(m.error));
      };
      w.onerror = (ev) => reject(new Error(ev.message || "Worker failed"));
      const req: McRequest = { id: ++seq, kind: "trial", input, settings, trial };
      w.postMessage(req);
    });
  } finally {
    w.terminate();
  }
}
