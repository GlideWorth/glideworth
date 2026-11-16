/**
 * Pure handler for chance-of-success work, shared by the worker and the inline fallback.
 * Uses core's session/shard API (workstream c) looked up by name so the app keeps compiling
 * while that API lands; a missing export surfaces as NotImplementedError.
 */
import * as core from "@glideworth/core";
import {
  GlideworthError,
  type MarketPath,
  type MonteCarloSettings,
  NotImplementedError,
  type ProjectionResult,
  type SimulationInput,
} from "@glideworth/core";
import type { WorkerErrorPayload } from "../../workers/protocol";

interface Session {
  total: number;
  step(maxTrials?: number): boolean;
  shard(): core.MonteCarloShard;
  done: number;
}

const lookup = <F>(name: string, feature: string): F => {
  const f = (core as unknown as Record<string, unknown>)[name];
  if (typeof f !== "function")
    throw new NotImplementedError(feature, "c", `${name} is not exported yet`);
  return f as F;
};

/** Run shard `shardIndex` of `shardCount` and return core's raw MonteCarloShard. */
export function runShard(
  input: SimulationInput,
  settings: MonteCarloSettings,
  shardIndex: number,
  shardCount: number,
  onProgress: (done: number, total: number) => void,
  shouldStop: () => boolean = () => false,
): core.MonteCarloShard {
  const create = lookup<
    (i: SimulationInput, s: MonteCarloSettings, o?: Record<string, unknown>) => Session
  >("createMonteCarloSession", "stochastic.session");
  const total = create(input, settings).total;
  const from = Math.floor((shardIndex * total) / shardCount);
  const to = Math.floor(((shardIndex + 1) * total) / shardCount);
  const session = create(input, settings, {
    trialOffset: from,
    trialCount: Math.max(0, to - from),
  });
  const chunk = Math.max(5, Math.min(50, Math.ceil((to - from) / 20)));
  while (!session.step(chunk)) {
    onProgress(session.done, to - from);
    if (shouldStop()) throw new GlideworthError("ABORTED", "Cancelled");
  }
  onProgress(to - from, to - from);
  return session.shard();
}

export function runOneTrial(
  input: SimulationInput,
  settings: MonteCarloSettings,
  trial: number,
): { market: MarketPath; result: ProjectionResult } {
  const run = lookup<
    (
      i: SimulationInput,
      s: MonteCarloSettings,
      t: number,
      o?: Record<string, unknown>,
    ) => {
      market: MarketPath;
      result: ProjectionResult;
    }
  >("runTrial", "stochastic.runTrial");
  const r = run(input, settings, trial, { trace: "summary" });
  return { market: r.market, result: r.result };
}

/** Merge raw shards (from runMonteCarloShard) and summarise them into a MonteCarloResult (cheap; main thread). */
export function mergeShards(
  shards: core.MonteCarloShard[],
  settings: MonteCarloSettings,
): core.MonteCarloResult {
  return core.summarizeMonteCarlo(core.mergeMonteCarloShards(shards), settings, {
    keepTrials: true,
  });
}

export function errorPayload(e: unknown): WorkerErrorPayload {
  const err = e instanceof Error ? e : new Error(String(e));
  return {
    name: err.name,
    message: err.message,
    ...(e instanceof GlideworthError ? { code: e.code } : {}),
    ...(e instanceof NotImplementedError ? { feature: e.feature, workstream: e.workstream } : {}),
  };
}
