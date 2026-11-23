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
  StochasticMetric,
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

export interface ChanceRunOptions {
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
  /**
   * Percentile series to record. Omit for every series (the chance page). An empty list records
   * none: the success rate still comes back, which is all a goal-seek evaluation reads.
   */
  metrics?: readonly StochasticMetric[];
  /** Keep per-trial rows on the result. Default true, so the chance page can open one trial. */
  keepTrials?: boolean;
}

/** A worker set kept alive across evaluations. `close` terminates it. Runs are one at a time. */
export interface ChancePool {
  run(
    input: SimulationInput,
    settings: MonteCarloSettings,
    opts?: ChanceRunOptions,
  ): Promise<MonteCarloResult>;
  close(): void;
}

function inlineRun(
  input: SimulationInput,
  settings: MonteCarloSettings,
  opts: ChanceRunOptions,
): MonteCarloResult {
  const t0 = performance.now();
  if (opts.signal?.aborted) throw new McCancelled();
  try {
    const shard = runShard(
      input,
      settings,
      0,
      1,
      (d, t) => opts.onProgress?.(d, t),
      () => !!opts.signal?.aborted,
      opts.metrics !== undefined ? { metrics: opts.metrics } : {},
    );
    return {
      ...mergeShards([shard], settings, { keepTrials: opts.keepTrials ?? true }),
      durationMs: performance.now() - t0,
    };
  } catch (e) {
    if (e instanceof McCancelled || opts.signal?.aborted) throw new McCancelled();
    throw new SimulationError(errorPayload(e));
  }
}

/**
 * Workers for several Monte Carlo evaluations. A goal-seek search scores dozens of candidates;
 * spawning a pool for each one spends the search on startup. Pass `0` to run inline (tests).
 * Cancelling terminates the workers, so the pool cannot be reused afterwards.
 */
export function createChancePool(workerCount?: number): ChancePool {
  const want = workerCount ?? poolSize();
  const useWorkers = typeof Worker !== "undefined" && want > 0;
  const workers: Worker[] = useWorkers ? Array.from({ length: want }, spawn) : [];
  let closed = false;
  let busy = false;
  let rejectCurrent: ((e: Error) => void) | null = null;

  const kill = () => {
    for (const w of workers) w.terminate();
    workers.length = 0;
  };
  const close = () => {
    if (closed) return;
    closed = true;
    kill();
    const reject = rejectCurrent;
    rejectCurrent = null;
    reject?.(new McCancelled());
  };

  const run: ChancePool["run"] = (input, settings, opts = {}) => {
    if (closed) return Promise.reject(new McCancelled());
    if (busy) return Promise.reject(new Error("Chance pool is already running"));
    if (!useWorkers) {
      busy = true;
      return Promise.resolve()
        .then(() => inlineRun(input, settings, opts))
        .finally(() => {
          busy = false;
        });
    }
    const n = workers.length;
    return new Promise<MonteCarloResult>((resolve, reject) => {
      busy = true;
      const t0 = performance.now();
      const done = new Array<number>(n).fill(0);
      const out = new Array<MonteCarloShard>(n);
      let remaining = n;
      let settled = false;
      const finish = (err: Error | null, value?: MonteCarloResult) => {
        if (settled) return;
        settled = true;
        busy = false;
        rejectCurrent = null;
        opts.signal?.removeEventListener("abort", onAbort);
        if (err) reject(err);
        else resolve(value!);
      };
      const fail = (err: Error) => {
        kill();
        closed = true;
        finish(err);
      };
      const onAbort = () => fail(new McCancelled());
      rejectCurrent = fail;
      if (opts.signal?.aborted) {
        onAbort();
        return;
      }
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      workers.forEach((w, i) => {
        const id = ++seq;
        w.onmessage = (e: MessageEvent<McResponse>) => {
          const m = e.data;
          if (m.id !== id || settled) return;
          if (m.kind === "progress") {
            done[i] = m.done;
            // Shard totals arrive one worker at a time. Summing them under-counts until every
            // worker has reported, so the bar uses the trial count the search actually runs.
            opts.onProgress?.(
              done.reduce((s, x) => s + x, 0),
              settings.trials,
            );
          } else if (m.kind === "shard") {
            out[i] = m.shard;
            if (--remaining !== 0) return;
            try {
              finish(null, {
                ...mergeShards(
                  out.filter((s) => s.trialIndex.length !== 0),
                  settings,
                  { keepTrials: opts.keepTrials ?? true },
                ),
                durationMs: performance.now() - t0,
              });
            } catch (err) {
              fail(err instanceof Error ? err : new Error(String(err)));
            }
          } else if (m.kind === "error") {
            fail(new SimulationError(m.error));
          }
        };
        w.onerror = (ev) => {
          fail(new Error(ev.message || "Worker failed"));
        };
        const req: McRequest = {
          id,
          kind: "shard",
          input,
          settings,
          shardIndex: i,
          shardCount: n,
          ...(opts.metrics !== undefined ? { metrics: opts.metrics } : {}),
        };
        w.postMessage(req);
      });
    });
  };

  return { run, close };
}

export async function runChanceOfSuccess(
  input: SimulationInput,
  settings: MonteCarloSettings,
  opts: ChanceRunOptions & { workers?: number } = {},
): Promise<MonteCarloResult> {
  const { workers, ...runOpts } = opts;
  const pool = createChancePool(workers);
  try {
    return await pool.run(input, settings, runOpts);
  } finally {
    pool.close();
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
