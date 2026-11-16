import { createRequire } from "node:module";
import { availableParallelism } from "node:os";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import {
  GlideworthError,
  MonteCarloSettings,
  type MonteCarloShard,
  NotImplementedError,
  PatchConflictError,
} from "@glideworth/core";
import { type CoreDeps, coreDeps } from "../deps.js";
import { ApiError } from "../errors.js";
import { type JobHooks, type JobSpec, runJob, type SerializedError } from "./run.js";

/** Runs one job. Implementations: worker thread (production) or inline (tests with fakes). */
export type JobExecutor = (spec: JobSpec, hooks: JobHooks) => Promise<unknown>;

/** Rebuild a typed error from its serialised form so HTTP/MCP mapping stays identical. */
export function reviveError(e: SerializedError): Error {
  const d = (e.details ?? {}) as Record<string, unknown>;
  if (
    e.code === "NOT_IMPLEMENTED" &&
    typeof d.feature === "string" &&
    typeof d.workstream === "string"
  )
    return new NotImplementedError(d.feature, d.workstream);
  if (e.code === "PATCH_CONFLICT")
    return new PatchConflictError(e.message, e.details as Record<string, unknown>);
  if (e.code)
    return new GlideworthError(e.code, e.message, e.details as Record<string, unknown> | undefined);
  return new Error(e.message);
}

// ------------------------------------------------------------------------------------- sharding
export interface ShardingOptions {
  /** Most worker threads one Monte Carlo run is split across (1 = never shard). Default: min(CPUs, 4). */
  maxShards?: number;
  /** Do not create a shard with fewer trials than this (thread start-up is not free). Default 200. */
  minTrialsPerShard?: number;
  /** Observability hook: called with the planned shard ranges whenever a run is split (>1 shard). */
  onSharded?: (ranges: { trialOffset: number; trialCount: number }[]) => void;
}

export const defaultMaxShards = (): number => Math.max(1, Math.min(availableParallelism(), 4));

/** Split `trials` into at most `maxShards` contiguous [offset, count) ranges of at least `min` trials. */
export function shardRanges(
  trials: number,
  { maxShards = defaultMaxShards(), minTrialsPerShard = 200 }: ShardingOptions = {},
): { trialOffset: number; trialCount: number }[] {
  const n = Math.max(1, Math.min(maxShards, Math.floor(trials / Math.max(1, minTrialsPerShard))));
  const base = Math.floor(trials / n);
  const extra = trials % n;
  const out: { trialOffset: number; trialCount: number }[] = [];
  let offset = 0;
  for (let i = 0; i < n; i++) {
    const trialCount = base + (i < extra ? 1 : 0);
    out.push({ trialOffset: offset, trialCount });
    offset += trialCount;
  }
  return out;
}

/**
 * Run one Monte Carlo job as several shards (each its own `runShard` call, i.e. its own worker
 * thread in production) and combine them with core's merge + summarise. The merged result is
 * identical to a single-threaded run with the same seed. A failure or cancellation in one shard
 * stops the others.
 */
export async function runShardedMonteCarlo(
  spec: JobSpec,
  hooks: JobHooks,
  ranges: { trialOffset: number; trialCount: number }[],
  runShard: (spec: JobSpec, hooks: JobHooks) => Promise<unknown>,
  deps: Pick<CoreDeps, "mergeMonteCarloShards" | "summarizeMonteCarlo">,
): Promise<unknown> {
  const settings = MonteCarloSettings.parse(spec.params.settings);
  const total = ranges.reduce((s, r) => s + r.trialCount, 0) || 1;
  const done = ranges.map(() => 0);
  const inner = new AbortController();
  const onOuterAbort = () => inner.abort();
  if (hooks.signal.aborted) inner.abort();
  hooks.signal.addEventListener("abort", onOuterAbort, { once: true });
  try {
    const shards = await Promise.all(
      ranges.map(async (range, i) => {
        try {
          return (await runShard(
            { kind: "mc-shard", input: spec.input, params: { settings, ...range } },
            {
              signal: inner.signal,
              onProgress: (f) => {
                done[i] = f * range.trialCount;
                hooks.onProgress(Math.min(0.98, done.reduce((a, b) => a + b, 0) / total));
              },
            },
          )) as MonteCarloShard;
        } catch (err) {
          inner.abort(); // one shard failing makes the rest pointless
          throw err;
        }
      }),
    );
    if (hooks.signal.aborted) throw new ApiError(409, "CANCELLED", "job cancelled");
    const merged = deps.mergeMonteCarloShards(shards);
    const result = deps.summarizeMonteCarlo(merged, settings, {
      keepTrials: spec.params.keepTrials ?? false,
    });
    hooks.onProgress(1);
    return result;
  } finally {
    hooks.signal.removeEventListener("abort", onOuterAbort);
  }
}

/** Whether (and how) a job should be sharded. `historical-sequential` has a data-driven trial count: one thread. */
function shardPlan(spec: JobSpec, opts: ShardingOptions) {
  if (spec.kind !== "monte-carlo") return null;
  const settings = MonteCarloSettings.safeParse(spec.params?.settings);
  if (!settings.success || settings.data.method === "historical-sequential") return null;
  const ranges = shardRanges(settings.data.trials, opts);
  if (ranges.length > 1) opts.onSharded?.(ranges);
  return ranges.length > 1 ? ranges : null;
}

/** In-process executor (tests, injected fakes). Pass `sharding` to exercise the shard/merge path without threads. */
export function inlineExecutor(deps: CoreDeps, sharding?: ShardingOptions): JobExecutor {
  const runOne: JobExecutor = (spec, hooks) => runJob(spec, hooks, deps);
  return (spec, hooks) => {
    const ranges = sharding ? shardPlan(spec, sharding) : null;
    return ranges ? runShardedMonteCarlo(spec, hooks, ranges, runOne, deps) : runOne(spec, hooks);
  };
}

// ------------------------------------------------------------------------------------- workers
/** Default heap limit of one job thread (`resourceLimits.maxOldGenerationSizeMb`), in MiB. */
const DEFAULT_WORKER_MAX_MB = 2048;

function runInWorker(
  spec: JobSpec,
  hooks: JobHooks,
  execArgv: string[] | undefined,
  maxOldGenerationSizeMb: number,
): Promise<unknown> {
  const isSource = import.meta.url.endsWith(".ts");
  const workerUrl = new URL(isSource ? "./worker.ts" : "./worker.js", import.meta.url);
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerUrl, {
      workerData: spec,
      resourceLimits: { maxOldGenerationSizeMb },
      ...(execArgv ? { execArgv } : {}),
    });
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      hooks.signal.removeEventListener("abort", onAbort);
      fn();
    };
    const onAbort = () => {
      void worker.terminate();
      finish(() => reject(new ApiError(409, "CANCELLED", "job cancelled")));
    };
    if (hooks.signal.aborted) return onAbort();
    hooks.signal.addEventListener("abort", onAbort, { once: true });
    worker.on(
      "message",
      (m: { type: string; value?: number; result?: unknown; error?: SerializedError }) => {
        if (m.type === "progress") hooks.onProgress(m.value ?? 0);
        else if (m.type === "done") finish(() => resolve(m.result));
        else if (m.type === "error") finish(() => reject(reviveError(m.error!)));
      },
    );
    worker.on("error", (err) => {
      // Out of heap: the thread is killed by its resource limit. Say so instead of a generic failure.
      const oom = (err as { code?: string }).code === "ERR_WORKER_OUT_OF_MEMORY";
      finish(() =>
        reject(
          oom
            ? new ApiError(507, "JOB_OUT_OF_MEMORY", "the job needed more memory than allowed")
            : err,
        ),
      );
    });
    worker.on("exit", (code) => finish(() => reject(new Error(`worker exited with code ${code}`))));
  });
}

export interface WorkerExecutorOptions extends ShardingOptions {
  execArgv?: string[];
  /** Heap limit of each job thread in MiB. Default `DEFAULT_WORKER_MAX_MB`. */
  maxOldGenerationSizeMb?: number;
  /**
   * Cloud: the global fair thread semaphore. A thread starts only once a slot is granted; the release runs
   * when the thread has exited. Cancelling while waiting gives the slot back unused.
   */
  acquireThread?: () => Promise<() => void>;
  /** Cloud: wall time each thread ran (worker-seconds quota). */
  onThreadMs?: (ms: number) => void;
}

/** Wait for a thread slot, unless the job is cancelled first. */
async function slot(
  acquire: () => Promise<() => void>,
  signal: AbortSignal,
): Promise<(() => void) | null> {
  if (signal.aborted) return null;
  const pending = acquire();
  const aborted = new Promise<null>((r) =>
    signal.addEventListener("abort", () => r(null), { once: true }),
  );
  const got = await Promise.race([pending, aborted]);
  if (got) return got;
  void pending.then((release) => release());
  return null;
}

/**
 * Production executor: every job runs in its own worker thread, and a Monte Carlo run is split over
 * several (`maxShards`). Works both from source (tsx) and from the compiled `dist/` output.
 */
export function workerExecutor(opts: WorkerExecutorOptions = {}): JobExecutor {
  const isSource = import.meta.url.endsWith(".ts");
  let execArgv = opts.execArgv;
  if (!execArgv) {
    // Source mode needs tsx + the @glideworth/source condition inside the worker too. When we were started
    // by tsx those flags are already in process.execArgv and are inherited automatically.
    const hasTsx = process.execArgv.some((a) => a.includes("tsx"));
    if (isSource && !hasTsx) {
      const tsx = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
      execArgv = [...process.execArgv, "--conditions=@glideworth/source", "--import", tsx];
    }
  }
  const heapMb = opts.maxOldGenerationSizeMb ?? DEFAULT_WORKER_MAX_MB;
  const one: JobExecutor = async (spec, hooks) => {
    let release: (() => void) | null = null;
    if (opts.acquireThread) {
      release = await slot(opts.acquireThread, hooks.signal);
      if (!release) throw new ApiError(409, "CANCELLED", "job cancelled");
    }
    const started = Date.now();
    try {
      return await runInWorker(spec, hooks, execArgv, heapMb);
    } finally {
      opts.onThreadMs?.(Date.now() - started);
      release?.();
    }
  };
  return (spec, hooks) => {
    const ranges = shardPlan(spec, opts);
    return ranges ? runShardedMonteCarlo(spec, hooks, ranges, one, coreDeps) : one(spec, hooks);
  };
}
