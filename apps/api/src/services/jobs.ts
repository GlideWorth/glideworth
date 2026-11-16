import { EventEmitter } from "node:events";
import type { Actor, SimulationInput } from "@glideworth/core";
import { and, desc, eq, inArray } from "drizzle-orm";
import { jobs } from "../db/schema.js";
import { ApiError, describeError, notFound } from "../errors.js";
import type { JobExecutor } from "../jobs/executor.js";
import type { JobKind } from "../jobs/run.js";
import { newId, nowIso } from "../util.js";
import type { CacheKind, ResultCache } from "./cache.js";
import type { ServiceCtx } from "./context.js";

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";
export const TERMINAL: JobStatus[] = ["succeeded", "failed", "cancelled"];

export interface JobView {
  id: string;
  kind: string;
  planId: string;
  planVersion: number;
  status: JobStatus;
  progress: number;
  cached: boolean;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  error: { code: string; message: string; details?: unknown } | null;
  params: unknown;
}

export interface SubmitArgs {
  kind: JobKind;
  planId: string;
  planVersion: number;
  input: SimulationInput;
  params: unknown;
  cache: { kind: CacheKind; hash: string } | null;
  actor: Actor;
}

type Row = typeof jobs.$inferSelect;

/** Default per-job wall-time limit when none is configured (30 minutes). */
export const DEFAULT_MAX_JOB_MS = 30 * 60_000;

/** Per-runtime job policy. Self-host sets only `maxJobMs`; cloud wires the workspace's policy into all of it. */
export interface JobsOptions {
  /**
   * Admission, after a cache miss and before anything is queued (cloud: read-only workspaces, plan trial
   * limit, jobs per day, worker time). Throws to refuse; a cached result is still served.
   */
  admit?: (kind: JobKind, params: unknown, input: SimulationInput) => void;
  /** Concurrency and queue length (cloud: from the plan). Default: `maxConcurrent` running, no queue limit. */
  limits?: () => { concurrent: number; queued: number };
  /** Wall-time limit of one job; the job is stopped (worker terminated) and fails with `JOB_TIMEOUT`. */
  maxJobMs?: () => number;
}

/** Job views echo the request, minus bulky defaults (full MC settings are in the stored row). */
function summarizeParams(p: unknown): unknown {
  const o = p as {
    settings?: Record<string, unknown>;
    monteCarlo?: Record<string, unknown>;
    request?: { monteCarlo?: unknown };
  } | null;
  if (!o || typeof o !== "object") return p;
  const brief = (s: Record<string, unknown> | undefined) =>
    s ? { method: s.method, trials: s.trials, seed: s.seed } : undefined;
  const out: Record<string, unknown> = { ...o };
  if (o.settings) out.settings = brief(o.settings);
  if (o.monteCarlo) out.monteCarlo = brief(o.monteCarlo);
  if (o.request?.monteCarlo)
    out.request = {
      ...o.request,
      monteCarlo: brief(o.request.monteCarlo as Record<string, unknown>),
    };
  return out;
}

export class JobsService {
  private controllers = new Map<string, AbortController>();
  private queue: { id: string; args: SubmitArgs }[] = [];
  private running = 0;
  private accepting = true;
  private readonly settled = new Set<Promise<void>>();
  readonly emitter = new EventEmitter();

  constructor(
    private readonly ctx: ServiceCtx,
    private readonly cache: ResultCache,
    private readonly execute: JobExecutor,
    private readonly maxConcurrent = 2,
    private readonly opts: JobsOptions = {},
  ) {
    this.emitter.setMaxListeners(0);
  }

  /** Queued or running jobs (a tenant runtime with work is never evicted). */
  busy(): boolean {
    return this.running > 0 || this.queue.length > 0;
  }

  /**
   * Shutdown of a runtime: refuse new jobs, cancel the queued ones, wait up to `ms` for running jobs, then
   * cancel whatever is still running. Resolves once nothing runs.
   */
  async close(ms = 30_000): Promise<void> {
    this.accepting = false;
    for (const q of [...this.queue]) this.cancel(q.id);
    const deadline = Date.now() + ms;
    while (this.running > 0 && Date.now() < deadline)
      await Promise.race([
        Promise.allSettled([...this.settled]),
        new Promise((r) => setTimeout(r, 50)),
      ]);
    for (const c of this.controllers.values()) c.abort();
    await Promise.allSettled([...this.settled]);
  }

  private timeLimitMs(): number {
    return this.opts.maxJobMs?.() ?? DEFAULT_MAX_JOB_MS;
  }

  /**
   * Run one compute job to completion in the job executor (a worker thread in production) without storing a
   * job row: synchronous endpoints whose engine call can take long (sensitivity, attribution) use it so the
   * event loop stays free. Same time limit as stored jobs.
   */
  async compute(kind: JobKind, input: SimulationInput, params: unknown): Promise<unknown> {
    return this.runLimited({ kind, input, params }, new AbortController(), () => {});
  }

  /** The executor under the job time limit: on expiry the job is aborted (the worker terminated). */
  private async runLimited(
    spec: { kind: JobKind; input: SimulationInput; params: unknown },
    outer: AbortController,
    onProgress: (p: number) => void,
  ): Promise<unknown> {
    const inner = new AbortController();
    const forward = () => inner.abort();
    if (outer.signal.aborted) inner.abort();
    outer.signal.addEventListener("abort", forward, { once: true });
    const limitMs = this.timeLimitMs();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      inner.abort();
    }, limitMs);
    timer.unref?.();
    try {
      return await this.execute(spec, { signal: inner.signal, onProgress });
    } catch (err) {
      if (timedOut && !outer.signal.aborted)
        throw new ApiError(
          408,
          "JOB_TIMEOUT",
          `the job ran longer than the ${Math.round(limitMs / 1000)} s limit and was stopped`,
          { limitSeconds: Math.round(limitMs / 1000) },
        );
      throw err;
    } finally {
      clearTimeout(timer);
      outer.signal.removeEventListener("abort", forward);
    }
  }

  /** Boot-time: jobs that were running when the process died can never finish; say so instead of hanging. */
  recoverInterrupted(): number {
    return this.ctx.db
      .update(jobs)
      .set({
        status: "failed",
        error: { code: "INTERRUPTED", message: "server restarted while the job was running" },
        finishedAt: nowIso(),
      })
      .where(inArray(jobs.status, ["queued", "running"]))
      .run().changes;
  }

  private view(r: Row): JobView {
    return {
      id: r.id,
      kind: r.kind,
      planId: r.planId,
      planVersion: r.planVersion,
      status: r.status,
      progress: r.progress,
      cached: r.cached,
      createdAt: r.createdAt,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      error: (r.error as JobView["error"]) ?? null,
      params: summarizeParams(r.params),
    };
  }

  private row(id: string): Row {
    const r = this.ctx.db.select().from(jobs).where(eq(jobs.id, id)).get();
    if (!r) throw notFound("job", id);
    return r;
  }

  get(id: string): JobView {
    return this.view(this.row(id));
  }

  list(f: { status?: JobStatus | undefined; planId?: string | undefined } = {}): JobView[] {
    const conds = [];
    if (f.status) conds.push(eq(jobs.status, f.status));
    if (f.planId) conds.push(eq(jobs.planId, f.planId));
    return this.ctx.db
      .select()
      .from(jobs)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(jobs.createdAt))
      .all()
      .map((r) => this.view(r));
  }

  result(id: string): unknown {
    const r = this.row(id);
    if (r.status === "failed")
      throw new ApiError(409, "JOB_FAILED", "job failed; see the job error", r.error);
    if (r.status === "cancelled") throw new ApiError(409, "JOB_CANCELLED", "job was cancelled");
    if (r.status !== "succeeded")
      throw new ApiError(409, "JOB_NOT_FINISHED", `job is ${r.status}`, { progress: r.progress });
    return r.result;
  }

  submit(args: SubmitArgs): JobView {
    const id = newId("job");
    const ts = nowIso();
    const base = {
      id,
      kind: args.kind,
      planId: args.planId,
      planVersion: args.planVersion,
      params: args.params as never,
      createdBy: args.actor as never,
      createdAt: ts,
    };
    const hit = args.cache
      ? this.cache.get(args.planId, args.planVersion, args.cache.kind, args.cache.hash)
      : undefined;
    if (hit !== undefined) {
      this.ctx.db
        .insert(jobs)
        .values({
          ...base,
          status: "succeeded",
          progress: 1,
          result: hit as never,
          cached: true,
          startedAt: ts,
          finishedAt: ts,
        })
        .run();
      return this.get(id);
    }
    if (!this.accepting)
      throw new ApiError(
        503,
        "TENANT_UNAVAILABLE",
        "the server is shutting down; try again shortly",
      );
    const limits = this.opts.limits?.();
    if (
      limits &&
      this.queue.length >= limits.queued + Math.max(0, limits.concurrent - this.running)
    )
      throw new ApiError(
        429,
        "QUOTA_EXCEEDED",
        "too many jobs are waiting; try again when some finish",
        {
          metric: "queued_jobs",
          limit: limits.queued,
        },
      );
    this.opts.admit?.(args.kind, args.params, args.input);
    this.ctx.db
      .insert(jobs)
      .values({ ...base, status: "queued" })
      .run();
    this.queue.push({ id, args });
    this.pump();
    return this.get(id);
  }

  private pump(): void {
    const max = this.opts.limits?.().concurrent ?? this.maxConcurrent;
    while (this.running < max && this.queue.length) {
      const next = this.queue.shift()!;
      this.running++;
      const p: Promise<void> = this.run(next.id, next.args).finally(() => {
        this.running--;
        this.settled.delete(p);
        this.pump();
      });
      this.settled.add(p);
    }
  }

  private emit(id: string): void {
    this.emitter.emit(`job:${id}`, this.get(id));
  }

  private async run(id: string, args: SubmitArgs): Promise<void> {
    const controller = new AbortController();
    this.controllers.set(id, controller);
    this.ctx.db
      .update(jobs)
      .set({ status: "running", startedAt: nowIso() })
      .where(eq(jobs.id, id))
      .run();
    this.emit(id);
    let lastWrite = 0;
    try {
      const result = await this.runLimited(
        { kind: args.kind, input: args.input, params: args.params },
        controller,
        (p) => {
          const now = Date.now();
          if (now - lastWrite < 100 && p < 1) return;
          lastWrite = now;
          this.ctx.db
            .update(jobs)
            .set({ progress: Math.max(0, Math.min(1, p)) })
            .where(eq(jobs.id, id))
            .run();
          this.emit(id);
        },
      );
      if (controller.signal.aborted) throw new ApiError(409, "CANCELLED", "job cancelled");
      this.ctx.db
        .update(jobs)
        .set({ status: "succeeded", progress: 1, result: result as never, finishedAt: nowIso() })
        .where(eq(jobs.id, id))
        .run();
      if (args.cache)
        this.cache.put(args.planId, args.planVersion, args.cache.kind, args.cache.hash, result);
      const r = result as { successRate?: number } | null;
      this.ctx.events.publish("simulation.completed", {
        jobId: id,
        kind: args.kind,
        planId: args.planId,
        planVersion: args.planVersion,
        ...(typeof r?.successRate === "number" ? { successRate: r.successRate } : {}),
      });
    } catch (err) {
      if (controller.signal.aborted)
        this.ctx.db
          .update(jobs)
          .set({ status: "cancelled", finishedAt: nowIso() })
          .where(eq(jobs.id, id))
          .run();
      else
        this.ctx.db
          .update(jobs)
          .set({ status: "failed", error: describeError(err) as never, finishedAt: nowIso() })
          .where(eq(jobs.id, id))
          .run();
    } finally {
      this.controllers.delete(id);
      this.emit(id);
    }
  }

  /** Who started the job (`{ kind, id, label }`). */
  createdBy(id: string): { id?: string } {
    return (this.row(id).createdBy ?? {}) as { id?: string };
  }

  cancel(id: string): JobView {
    const r = this.row(id);
    if (TERMINAL.includes(r.status)) return this.view(r);
    const c = this.controllers.get(id);
    if (c) c.abort();
    else {
      this.queue = this.queue.filter((q) => q.id !== id);
      this.ctx.db
        .update(jobs)
        .set({ status: "cancelled", finishedAt: nowIso() })
        .where(eq(jobs.id, id))
        .run();
      this.emit(id);
    }
    return this.get(id);
  }

  /** Cancel and wait (briefly) until the job has actually stopped, so the reply says `cancelled`, not `running`. */
  async cancelAndWait(id: string, ms = 3000): Promise<JobView> {
    const v = this.cancel(id);
    return TERMINAL.includes(v.status) ? v : this.waitFor(id, ms);
  }

  /** Resolves with the job once it reaches a terminal state, or with its current state after `ms`. */
  waitFor(id: string, ms: number): Promise<JobView> {
    const now = this.get(id);
    if (TERMINAL.includes(now.status) || ms <= 0) return Promise.resolve(now);
    return new Promise((resolve) => {
      const done = (v: JobView) => {
        clearTimeout(timer);
        this.emitter.off(`job:${id}`, listener);
        resolve(v);
      };
      const listener = (v: JobView) => {
        if (TERMINAL.includes(v.status)) done(v);
      };
      const timer = setTimeout(() => done(this.get(id)), ms);
      this.emitter.on(`job:${id}`, listener);
    });
  }

  subscribe(id: string, fn: (v: JobView) => void): () => void {
    this.row(id);
    this.emitter.on(`job:${id}`, fn);
    return () => this.emitter.off(`job:${id}`, fn);
  }
}
