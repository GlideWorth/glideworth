import { NotImplementedError } from "@glideworth/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { inlineExecutor, workerExecutor } from "../src/jobs/executor.js";
import type { JobSpec } from "../src/jobs/run.js";
import { fakeSimulate, type Harness, READ_KEY, SIM_KEY, setup } from "./helpers.js";

let h: Harness;
afterEach(() => h?.close());
const P = "/api/v1/plans/plan-main";

const fakeMc = (extra: Record<string, unknown> = {}) => ({
  method: "normal",
  trials: 100,
  seed: 1,
  successRate: 0.9,
  outcomeCounts: { comfortable: 90, "failed-mid": 10 },
  percentiles: [
    {
      metric: "netWorth",
      years: [2026, 2031, 2036],
      bands: [
        { p: 0.1, values: [1, 2, 3] },
        { p: 0.5, values: [2, 4, 6] },
        { p: 0.9, values: [3, 6, 9] },
        { p: 0.25, values: [1, 1, 1] },
      ],
    },
  ],
  milestoneTiming: [],
  trialSummaries: [{ trial: 0 }],
  ...extra,
});

describe("deterministic simulation", () => {
  it("returns the full result, or a compact view of selected years and series", async () => {
    h = setup();
    const full = await h.call<{ periods: unknown[] }>(`${P}/simulate`, {
      method: "POST",
      body: {},
    });
    expect(full.json.periods.length).toBe(4);
    const view = await h.call<{
      meta: { basis: string; cached: boolean };
      years: Record<string, unknown>[];
      summary: unknown;
      milestones: unknown[];
    }>(`${P}/simulate`, {
      method: "POST",
      body: {
        view: {
          basis: "nominal",
          fromYear: 2036,
          toYear: 2046,
          series: ["netWorth", "taxes"],
          accountIds: ["acc-cash"],
        },
      },
    });
    expect(view.status).toBe(200);
    expect(view.json.years.map((y) => y.year)).toEqual([2036, 2046]);
    expect(Object.keys(view.json.years[0]!).sort()).toEqual([
      "accounts",
      "ages",
      "netWorth",
      "taxes",
      "year",
    ]);
    expect(view.json.meta.basis).toBe("nominal");
    expect(view.json.summary).toBeDefined();
    const real = await h.call<{ years: { netWorth: number }[] }>(`${P}/simulate`, {
      method: "POST",
      body: { view: { basis: "real", series: ["netWorth"] } },
    });
    const nominal = await h.call<{ years: { netWorth: number }[] }>(`${P}/simulate`, {
      method: "POST",
      body: { view: { basis: "nominal", series: ["netWorth"] } },
    });
    expect(real.json.years[3]!.netWorth).toBeLessThan(nominal.json.years[3]!.netWorth); // priceIndex > 1
  });

  it("caches results per plan version + options and invalidates on edit", async () => {
    const simulate = vi.fn(fakeSimulate);
    h = setup({ deps: { simulate: simulate as never } });
    await h.call(`${P}/simulate`, { method: "POST", body: { view: {} } });
    const second = await h.call<{ meta: { cached: boolean } }>(`${P}/simulate`, {
      method: "POST",
      body: { view: {} },
    });
    expect(second.json.meta.cached).toBe(true);
    expect(simulate).toHaveBeenCalledTimes(1);
    await h.call(`${P}/simulate`, { method: "POST", body: { trace: "off", view: {} } }); // different options
    expect(simulate).toHaveBeenCalledTimes(2);
    await h.call(`${P}/expenses/exp-living`, { method: "PATCH", body: { name: "changed" } });
    const third = await h.call<{ meta: { cached: boolean } }>(`${P}/simulate`, {
      method: "POST",
      body: { view: {} },
    });
    expect(third.json.meta.cached).toBe(false);
    // Editing household finances also invalidates live-plan results.
    await h.call("/api/v1/households/hh-sample/accounts/acc-cash", {
      method: "PATCH",
      body: { balance: 1 },
    });
    expect(
      (
        await h.call<{ meta: { cached: boolean } }>(`${P}/simulate`, {
          method: "POST",
          body: { view: {} },
        })
      ).json.meta.cached,
    ).toBe(false);
  });

  it("stateless simulate and unimplemented engine features map to 501", async () => {
    h = setup({
      deps: {
        simulate: () => {
          throw new NotImplementedError("engine.flexSpending", "d");
        },
      },
    });
    const r = await h.call(`${P}/simulate`, { method: "POST", key: READ_KEY, body: {} });
    expect(r.status).toBe(501);
    expect(r.json).toMatchObject({
      error: {
        code: "NOT_IMPLEMENTED",
        details: { feature: "engine.flexSpending", workstream: "d" },
      },
    });
    const sample = h.services.households.getDocument("hh-sample");
    const stateless = await h.call("/api/v1/simulate", {
      method: "POST",
      key: READ_KEY,
      body: { household: sample.household, finances: sample.finances, plan: sample.plans[0] },
    });
    expect(stateless.status).toBe(501);
  });
});

describe("async jobs", () => {
  it("runs Monte Carlo as a job: 202, polling, result views, cache hit on repeat", async () => {
    const runMonteCarloAsync = vi.fn(
      (
        _i: unknown,
        settings: { trials: number; seed: number },
        o: { onProgress?: (d: number, t: number) => void },
      ) => {
        o.onProgress?.(50, 100);
        o.onProgress?.(100, 100);
        return fakeMc({ trials: settings.trials, seed: settings.seed });
      },
    );
    h = setup({ deps: { runMonteCarloAsync: runMonteCarloAsync as never } });
    const start = await h.call<{ id: string; status: string; links: { result: string } }>(
      `${P}/monte-carlo`,
      { method: "POST", key: SIM_KEY, body: { settings: { trials: 200 } } },
    );
    expect(start.status).toBe(202);
    const done = await h.services.jobs.waitFor(start.json.id, 2000);
    expect(done.status).toBe("succeeded");
    const poll = await h.call<{ status: string; progress: number }>(
      `/api/v1/jobs/${start.json.id}`,
      {
        key: SIM_KEY,
      },
    );
    expect(poll.json).toMatchObject({ status: "succeeded", progress: 1 });
    const summary = await h.call<{
      percentiles: { bands: { p: number }[]; years: number[] }[];
      trialSummaries?: unknown;
      successRate: number;
    }>(`/api/v1/jobs/${start.json.id}/result`, { key: SIM_KEY });
    expect(summary.json.successRate).toBe(0.9);
    expect(summary.json.percentiles[0]!.bands.map((b) => b.p)).toEqual([0.1, 0.5, 0.9]); // thinned
    expect(summary.json.trialSummaries).toBeUndefined();
    const full = await h.call<{ trialSummaries: unknown[] }>(
      `/api/v1/jobs/${start.json.id}/result?detail=full`,
      { key: SIM_KEY },
    );
    expect(full.json.trialSummaries).toHaveLength(1);
    expect(runMonteCarloAsync).toHaveBeenCalledTimes(1);
    // The default seed is fixed, so an identical request is a cache hit (no second engine call).
    const again = await h.call<{ status: string; cached: boolean }>(`${P}/monte-carlo?wait=5`, {
      method: "POST",
      key: SIM_KEY,
      body: { settings: { trials: 200 } },
    });
    expect(again.status).toBe(200);
    expect(again.json).toMatchObject({ status: "succeeded", cached: true });
    expect(runMonteCarloAsync).toHaveBeenCalledTimes(1);
    // randomSeed bypasses the cache.
    await h.call(`${P}/monte-carlo?wait=5`, { method: "POST", body: { randomSeed: true } });
    expect(runMonteCarloAsync).toHaveBeenCalledTimes(2);
  });

  it("wait=N blocks until finished; failures carry the typed error; results of failed jobs are 409", async () => {
    h = setup({
      deps: {
        runHistorical: (() => {
          throw new NotImplementedError("stochastic.runHistorical", "c");
        }) as never,
      },
    });
    const r = await h.call<{
      id: string;
      status: string;
      error: { code: string; details: { workstream: string } };
    }>(`${P}/historical?wait=5`, { method: "POST", body: {} });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({
      status: "failed",
      error: { code: "NOT_IMPLEMENTED", details: { workstream: "c" } },
    });
    const res = await h.call(`/api/v1/jobs/${r.json.id}/result`);
    expect(res.status).toBe(409);
    expect(res.json).toMatchObject({ error: { code: "JOB_FAILED" } });
  });

  it("cancels a running job and reports cancelled", async () => {
    let started: () => void;
    const running = new Promise<void>((r) => {
      started = r;
    });
    h = setup({
      executor: (spec: JobSpec, hooks) =>
        new Promise((_res, rej) => {
          started();
          hooks.onProgress(0.3);
          hooks.signal.addEventListener("abort", () => rej(new Error("aborted")));
          void spec;
        }),
    });
    const j = await h.call<{ id: string }>(`${P}/monte-carlo`, { method: "POST", body: {} });
    await running;
    expect((await h.call<{ status: string }>(`/api/v1/jobs/${j.json.id}`)).json.status).toBe(
      "running",
    );
    const cancelled = await h.call<{ status: string }>(`/api/v1/jobs/${j.json.id}/cancel`, {
      method: "POST",
    });
    expect(["running", "cancelled"]).toContain(cancelled.json.status);
    const final = await h.services.jobs.waitFor(j.json.id, 2000);
    expect(final.status).toBe("cancelled");
    expect((await h.call(`/api/v1/jobs/${j.json.id}/result`)).status).toBe(409);
  });

  it("queues beyond the concurrency limit and cancels queued jobs", async () => {
    const release: (() => void)[] = [];
    h = setup({
      executor: () => new Promise((res) => release.push(() => res({ successRate: 1 }))),
    });
    const a = await h.call<{ id: string }>(`${P}/monte-carlo`, {
      method: "POST",
      body: { settings: { trials: 100 } },
    });
    const b = await h.call<{ id: string }>(`${P}/monte-carlo`, {
      method: "POST",
      body: { settings: { trials: 101 } },
    });
    const c = await h.call<{ id: string }>(`${P}/monte-carlo`, {
      method: "POST",
      body: { settings: { trials: 102 } },
    });
    expect((await h.call<{ status: string }>(`/api/v1/jobs/${c.json.id}`)).json.status).toBe(
      "queued",
    );
    expect(
      (await h.call<{ status: string }>(`/api/v1/jobs/${c.json.id}/cancel`, { method: "POST" }))
        .json.status,
    ).toBe("cancelled");
    for (const r of release) r();
    expect((await h.services.jobs.waitFor(a.json.id, 1000)).status).toBe("succeeded");
    expect((await h.services.jobs.waitFor(b.json.id, 1000)).status).toBe("succeeded");
    const list = await h.call<{ items: { id: string }[]; total: number }>(
      "/api/v1/jobs?status=succeeded",
    );
    expect(list.json.total).toBe(2);
  });

  it("streams progress over Server-Sent Events until done", async () => {
    let finish!: () => void;
    h = setup({
      executor: (_s, hooks) =>
        new Promise((res) => {
          hooks.onProgress(0.5);
          finish = () => res(fakeMc());
        }),
    });
    const j = await h.call<{ id: string; links: { events: string } }>(`${P}/monte-carlo`, {
      method: "POST",
      body: {},
    });
    const res = await h.app.request(j.json.links.events, {
      headers: { authorization: "Bearer glideworth_testsimu_0123456789abcdef0123456789abcdef" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    setTimeout(finish, 50);
    const text = await res.text();
    expect(text).toContain("event: ");
    expect(text).toContain("event: done");
    expect(text).toContain('"status":"succeeded"');
    expect((await h.app.request(`/api/v1/jobs/${j.json.id}/events`)).status).toBe(401);
  });

  it("marks jobs interrupted by a restart as failed", async () => {
    h = setup({ executor: () => new Promise(() => {}) });
    const j = await h.call<{ id: string }>(`${P}/monte-carlo`, { method: "POST", body: {} });
    expect(h.services.jobs.recoverInterrupted()).toBe(1);
    expect(h.services.jobs.get(j.json.id)).toMatchObject({
      status: "failed",
      error: { code: "INTERRUPTED" },
    });
  });

  it("runs jobs in a real worker thread: progress, result and cancellation (real engine)", async () => {
    const exec = workerExecutor();
    const doc = setup({ realEngine: true });
    const { input } = doc.services.sim.inputFor("plan-main", {});
    doc.close();
    const proj = (await exec(
      { kind: "projection", input, params: {} },
      { signal: new AbortController().signal, onProgress: () => {} },
    )) as { periods: unknown[] };
    expect(proj.periods.length).toBeGreaterThan(10);
    const progress: number[] = [];
    const mc = (await exec(
      {
        kind: "monte-carlo",
        input,
        params: {
          settings: { trials: 100, method: "normal", seed: 1, outcomeCategories: undefined },
        },
      },
      { signal: new AbortController().signal, onProgress: (p) => progress.push(p) },
    )) as { successRate: number; trials: number };
    expect(mc.trials).toBe(100);
    expect(mc.successRate).toBeGreaterThanOrEqual(0);
    expect(progress.length).toBeGreaterThan(0);
    // Cancellation terminates the thread quickly.
    const ac = new AbortController();
    const started = Date.now();
    const p = exec(
      {
        kind: "monte-carlo",
        input,
        params: { settings: { trials: 10_000, method: "normal", seed: 1 } },
      },
      { signal: ac.signal, onProgress: () => {} },
    );
    setTimeout(() => ac.abort(), 30);
    await expect(p).rejects.toMatchObject({ code: "CANCELLED" });
    expect(Date.now() - started).toBeLessThan(5000);
    void inlineExecutor;
  }, 60_000);
});

describe("solvers and guardrails (async jobs)", () => {
  it("routes each solver to its core function with the plan MC settings and a fixed seed", async () => {
    const calls: Record<string, unknown> = {};
    const result = {
      converged: true,
      value: 1.1,
      achieved: 0.85,
      evaluations: [],
      sensitivity: [],
      explanation: "ok",
    };
    h = setup({
      deps: {
        solveMaxSpending: (async (_i: unknown, o: unknown) => {
          calls.max = o;
          return result;
        }) as never,
        solveEarliestRetirement: (async (_i: unknown, o: unknown) => {
          calls.ret = o;
          return result;
        }) as never,
        solveRequiredSavings: (async (_i: unknown, o: unknown) => {
          calls.sav = o;
          return result;
        }) as never,
        goalSeek: (async (_i: unknown, o: unknown) => {
          calls.gs = o;
          return result;
        }) as never,
        evaluateGuardrails: (async (_i: unknown, o: unknown) => {
          calls.gr = o;
          return { current: {}, path: [], explanation: "x" };
        }) as never,
      },
    });
    const max = await h.call<{ status: string }>(`${P}/solve/max-spending?wait=5`, {
      method: "POST",
      body: { targetSuccessRate: 0.85 },
    });
    expect(max.json.status).toBe("succeeded");
    expect(calls.max).toMatchObject({ targetSuccessRate: 0.85, monteCarlo: { seed: 20260101 } });
    await h.call(`${P}/solve/earliest-retirement?wait=5`, {
      method: "POST",
      body: { milestoneId: "ms-retire", targetSuccessRate: 0.8 },
    });
    expect(calls.ret).toMatchObject({ milestoneId: "ms-retire", targetSuccessRate: 0.8 });
    await h.call(`${P}/solve/required-savings?wait=5`, {
      method: "POST",
      body: { flowId: "fl-401k", targetSuccessRate: 0.9 },
    });
    expect(calls.sav).toMatchObject({ flowId: "fl-401k" });
    const gs = await h.call<{ status: string }>(`${P}/solve/goal-seek?wait=5`, {
      method: "POST",
      body: {
        variable: { kind: "spendingScale" },
        objective: { kind: "noShortfall" },
        direction: "maximize",
        bounds: { min: 0, max: 3 },
      },
    });
    expect(gs.json.status).toBe("succeeded");
    expect(calls.gs).toMatchObject({ direction: "maximize" });
    // Guardrails need guardrails on the plan or in the body.
    expect((await h.call(`${P}/insights/guardrails`, { method: "POST", body: {} })).status).toBe(
      400,
    );
    const gr = await h.call<{ status: string }>(`${P}/insights/guardrails?wait=5`, {
      method: "POST",
      body: {
        guardrails: {
          enabled: true,
          start: { kind: "planStart" },
          targetSuccess: 0.85,
          lowerGuardrail: 0.75,
          upperGuardrail: 0.95,
        },
      },
    });
    expect(gr.json.status).toBeDefined();
    expect(
      (await h.call(`${P}/solve/max-spending`, { method: "POST", body: { targetSuccessRate: 5 } }))
        .status,
    ).toBe(400);
  });

  it("a solver that is not implemented yet is a failed job with the owning workstream", async () => {
    h = setup({
      deps: {
        solveMaxSpending: (() =>
          Promise.reject(new NotImplementedError("solvers.maxSpending", "d"))) as never,
      },
    });
    const r = await h.call<{ status: string; error: { details: { feature: string } } }>(
      `${P}/solve/max-spending?wait=5`,
      { method: "POST", body: { targetSuccessRate: 0.85 } },
    );
    expect(r.json).toMatchObject({
      status: "failed",
      error: { details: { feature: "solvers.maxSpending" } },
    });
  });
});

describe("insights", () => {
  const finding = {
    code: "X",
    severity: "warning",
    title: "t",
    message: "m",
    periodIndex: null,
    refs: [],
    evidence: [],
  };
  it("explain, audit (with counts), tax breakdown, compare and sensitivity", async () => {
    h = setup({
      deps: {
        explainProjection: ((_i: unknown, _r: unknown, q?: string) => ({
          headline: `why ${q ?? ""}`,
          findings: [finding],
        })) as never,
        explainDifference: (() => ({ headline: "diff", findings: [] })) as never,
        auditAssumptions: (() => [finding, { ...finding, severity: "critical" }]) as never,
        sensitivityAnalysis: (async (_i: unknown, o: unknown) => ({
          metric: (o as { metric: string }).metric,
          base: 1,
          bars: [],
          skipped: [],
        })) as never,
      },
    });
    const ex = await h.call<{ headline: string }>(`${P}/insights/explain`, {
      method: "POST",
      body: { question: "shortfall?" },
    });
    expect(ex.json.headline).toBe("why shortfall?");
    const au = await h.call<{ counts: Record<string, number>; findings: unknown[] }>(
      `${P}/insights/audit`,
      {
        method: "POST",
      },
    );
    expect(au.json.counts).toMatchObject({ warning: 1, critical: 1 });
    const tax = await h.call<{
      totals: { byJurisdiction: Record<string, number> };
      years: { lines?: unknown[]; effectiveRate: number }[];
    }>(`${P}/tax-breakdown?detail=lines&fromYear=2036`, {});
    expect(tax.json.totals.byJurisdiction["us-federal"]).toBeGreaterThan(0);
    expect(tax.json.years[0]!.lines).toBeDefined();
    expect(tax.json.years.length).toBe(3);
    const cmp = await h.call<{
      plans: { planId: string }[];
      differences: { changes: string[]; explanation?: { headline: string } }[];
    }>("/api/v1/insights/compare", {
      method: "POST",
      body: { planIds: ["plan-main", "plan-early"], explain: true },
    });
    expect(cmp.json.plans.map((p) => p.planId)).toEqual(["plan-main", "plan-early"]);
    expect(cmp.json.differences[0]!.explanation?.headline).toBe("diff");
    expect(
      (
        await h.call("/api/v1/insights/compare", {
          method: "POST",
          body: { planIds: ["plan-main"] },
        })
      ).status,
    ).toBe(400);
    const sens = await h.call<{ metric: string; planVersion: number }>(
      `${P}/insights/sensitivity`,
      {
        method: "POST",
        body: { metric: "lifetimeTaxesReal" },
      },
    );
    expect(sens.json).toMatchObject({ metric: "lifetimeTaxesReal", planVersion: 1 });
    const sensMc = await h.call<{ id: string; kind: string }>(`${P}/insights/sensitivity`, {
      method: "POST",
      body: { metric: "successRate" },
    });
    expect(sensMc.status).toBe(202);
    expect(sensMc.json.kind).toBe("sensitivity");
  });

  it("insights not yet implemented in core are 501 (explain/audit)", async () => {
    h = setup({
      deps: {
        auditAssumptions: (() => {
          throw new NotImplementedError("insights.auditAssumptions", "d");
        }) as never,
      },
    });
    const r = await h.call(`${P}/insights/audit`, { method: "POST" });
    expect(r.status).toBe(501);
  });
});
