/**
 * Monte Carlo sharding: one run split across worker threads (runMonteCarloShard ->
 * mergeMonteCarloShards -> summarizeMonteCarlo) must equal a single-threaded run, and cancellation
 * must stop it. Runs on the real engine, including real worker threads.
 */
import { MonteCarloSettings, runMonteCarloAsync } from "@glideworth/core";
import { afterEach, describe, expect, it } from "vitest";
import { coreDeps } from "../src/deps.js";
import { inlineExecutor, shardRanges, workerExecutor } from "../src/jobs/executor.js";
import type { JobSpec } from "../src/jobs/run.js";
import { type Harness, setup } from "./helpers.js";

let h: Harness;
afterEach(() => h?.close());

function specFor(trials: number, extra: Record<string, unknown> = {}): JobSpec {
  h = setup({ realEngine: true });
  const { input } = h.services.sim.inputFor("plan-main", { trace: "off" });
  const settings = MonteCarloSettings.parse({ trials, seed: 11, ...extra });
  return { kind: "monte-carlo", input, params: { settings, keepTrials: false } };
}
const hooks = (signal = new AbortController().signal) => ({ signal, onProgress: () => {} });
/** A result minus its wall-clock fields. */
const stable = (r: unknown) => {
  const { durationMs: _d, ...rest } = r as Record<string, unknown>;
  return JSON.parse(JSON.stringify(rest));
};

describe("shardRanges", () => {
  it("splits trials evenly, never below the minimum per shard, never above maxShards", () => {
    expect(shardRanges(1000, { maxShards: 4, minTrialsPerShard: 200 })).toEqual([
      { trialOffset: 0, trialCount: 250 },
      { trialOffset: 250, trialCount: 250 },
      { trialOffset: 500, trialCount: 250 },
      { trialOffset: 750, trialCount: 250 },
    ]);
    expect(shardRanges(450, { maxShards: 8, minTrialsPerShard: 200 })).toHaveLength(2);
    expect(shardRanges(100, { maxShards: 8, minTrialsPerShard: 200 })).toEqual([
      { trialOffset: 0, trialCount: 100 },
    ]);
    expect(shardRanges(1000, { maxShards: 1 })).toHaveLength(1);
    const r = shardRanges(1003, { maxShards: 4, minTrialsPerShard: 100 });
    expect(r.reduce((s, x) => s + x.trialCount, 0)).toBe(1003);
    expect(r.map((x) => x.trialOffset)).toEqual([0, 251, 502, 753]);
  });
});

describe("sharded Monte Carlo", () => {
  it("merged shards equal the single-threaded result exactly (in-process)", async () => {
    const spec = specFor(240);
    const single = await runMonteCarloAsync(spec.input, spec.params.settings, {
      keepTrials: false,
    });
    const ranges: unknown[] = [];
    const sharded = await inlineExecutor(coreDeps, {
      maxShards: 3,
      minTrialsPerShard: 40,
      onSharded: (r) => ranges.push(r),
    })(spec, hooks());
    expect(ranges).toHaveLength(1);
    expect(stable(sharded)).toEqual(stable(single));
    expect((sharded as { trials: number }).trials).toBe(240);
  }, 30_000); // CPU-bound: generous when the whole suite runs in parallel

  it("runs on real worker threads and matches the single-threaded result", async () => {
    const spec = specFor(240);
    const single = await runMonteCarloAsync(spec.input, spec.params.settings, {
      keepTrials: false,
    });
    let shards = 0;
    const progress: number[] = [];
    const exec = workerExecutor({
      maxShards: 3,
      minTrialsPerShard: 40,
      onSharded: (r) => (shards = r.length),
    });
    const sharded = await exec(spec, {
      signal: new AbortController().signal,
      onProgress: (f) => progress.push(f),
    });
    expect(shards).toBe(3);
    expect(stable(sharded)).toEqual(stable(single));
    expect(progress.length).toBeGreaterThan(1);
    expect(Math.max(...progress)).toBe(1);
  }, 60_000);

  it("does not shard small runs or historical-sequential runs", async () => {
    let planned = 0;
    const exec = inlineExecutor(coreDeps, {
      maxShards: 4,
      minTrialsPerShard: 200,
      onSharded: () => planned++,
    });
    await exec(specFor(100), hooks());
    await exec(specFor(10, { method: "historical-sequential" }), hooks());
    expect(planned).toBe(0);
  });

  it("a Monte Carlo job via the service uses the sharded path and succeeds", async () => {
    let shards = 0;
    h = setup({
      realEngine: true,
      executor: workerExecutor({
        maxShards: 2,
        minTrialsPerShard: 50,
        onSharded: (r) => (shards = r.length),
      }),
    });
    const r = await h.call<{ id: string; status: string }>(
      "/api/v1/plans/plan-main/monte-carlo?wait=60",
      {
        method: "POST",
        body: { settings: { trials: 100, seed: 5 } },
      },
    );
    expect(r.json.status).toBe("succeeded");
    expect(shards).toBe(2);
    const res = await h.call<{ trials: number; successRate: number }>(
      `/api/v1/jobs/${r.json.id}/result`,
    );
    expect(res.json.trials).toBe(100);
    expect(res.json.successRate).toBeGreaterThanOrEqual(0);
  }, 60_000);
});

describe("cancellation", () => {
  it("an in-process job stops between trial chunks (runMonteCarloAsync honours the abort signal)", async () => {
    h = setup({ realEngine: true, executor: inlineExecutor(coreDeps) });
    const started = await h.call<{ id: string }>("/api/v1/plans/plan-main/monte-carlo", {
      method: "POST",
      body: { settings: { trials: 10_000, seed: 1 } },
    });
    const t0 = Date.now();
    await new Promise((r) => setTimeout(r, 150));
    await h.call(`/api/v1/jobs/${started.json.id}/cancel`, { method: "POST" });
    const job = await h.services.jobs.waitFor(started.json.id, 20_000);
    expect(job.status).toBe("cancelled");
    expect(Date.now() - t0).toBeLessThan(10_000);
  }, 30_000);

  it("cancelling a sharded job terminates every worker thread", async () => {
    const spec = specFor(10_000);
    const abort = new AbortController();
    const exec = workerExecutor({ maxShards: 3, minTrialsPerShard: 100 });
    const t0 = Date.now();
    setTimeout(() => abort.abort(), 500);
    await expect(exec(spec, { signal: abort.signal, onProgress: () => {} })).rejects.toMatchObject({
      code: "CANCELLED",
    });
    expect(Date.now() - t0).toBeLessThan(10_000);
  }, 30_000);
});
