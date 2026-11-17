/**
 * Worker threads for the imports (security review finding 4). One pool per process, shared by every workspace
 * in cloud mode, so a burst of imports cannot take more than `maxWorkers` threads or hold more than `maxQueued`
 * waiting requests (with their file text) in memory:
 *
 * - a task runs in a long-lived worker thread (`import-worker.ts`); the request thread only posts it and waits;
 * - a task that runs longer than `timeoutMs` has its thread terminated and fails with `422 IMPORT_TIMEOUT`;
 * - a task whose thread runs out of heap (`maxOldGenerationSizeMb`) fails with `422 IMPORT_OUT_OF_MEMORY`;
 * - when every thread is busy and `maxQueued` tasks already wait, a new one is `503 IMPORT_BUSY` (Retry-After);
 * - a thread that failed or was terminated is dropped and a fresh one is started for the next task; idle
 *   threads are unreferenced (they never keep the process alive) and stop after `idleMs`.
 */
import { availableParallelism } from "node:os";
import { Worker } from "node:worker_threads";
import { z } from "zod";
import { ApiError } from "../errors.js";
import { reviveError, workerExecArgv } from "./executor.js";
import type { ImportTask, ImportTaskResult, SerializedImportError } from "./import-task.js";

export interface ImportPoolOptions {
  /** Threads running imports at once. Default: min(2, CPUs - 1), at least 1. */
  maxWorkers?: number;
  /** Imports waiting for a thread before new ones are refused with 503. Default 8. */
  maxQueued?: number;
  /** Wall-time limit of one import once it has a thread, in ms. Default 15,000. */
  timeoutMs?: number;
  /** Heap limit of one import thread, in MiB. Default 512. */
  maxOldGenerationSizeMb?: number;
  /** An idle thread is stopped after this long, in ms. Default 30,000. */
  idleMs?: number;
  /** Tests: flags for the worker (default: tsx when running from source). */
  execArgv?: string[];
}

const IMPORT_DEFAULTS = {
  maxWorkers: Math.max(1, Math.min(2, availableParallelism() - 1)),
  maxQueued: 8,
  timeoutMs: 15_000,
  maxOldGenerationSizeMb: 512,
  idleMs: 30_000,
} as const;

/** How long a new thread may take to load the importers before its task is failed. */
const STARTUP_ALLOWANCE_MS = 30_000;

interface Job {
  id: number;
  task: ImportTask;
  resolve: (r: ImportTaskResult) => void;
  reject: (e: unknown) => void;
}

interface Slot {
  worker: Worker;
  /** The thread has loaded the importers (start-up time does not count against a task's limit). */
  ready: boolean;
  job: Job | null;
  timer: NodeJS.Timeout | null;
  idle: NodeJS.Timeout | null;
}

/** Rebuild an importer error so the HTTP / MCP mapping is the same as when it was thrown in-process. */
function reviveImportError(e: SerializedImportError): Error {
  if (e.name === "ZodError" && e.issues) return new z.ZodError(e.issues as never);
  if (e.name === "SyntaxError") return new SyntaxError(e.message);
  return reviveError(e);
}

export class ImportPool {
  private readonly o: Required<Omit<ImportPoolOptions, "execArgv">> & { execArgv?: string[] };
  private readonly slots = new Set<Slot>();
  private readonly queue: Job[] = [];
  private nextId = 1;
  private closed = false;
  private readonly workerUrl: URL;

  constructor(opts: ImportPoolOptions = {}) {
    const execArgv = opts.execArgv ?? workerExecArgv();
    this.o = {
      maxWorkers: opts.maxWorkers ?? IMPORT_DEFAULTS.maxWorkers,
      maxQueued: opts.maxQueued ?? IMPORT_DEFAULTS.maxQueued,
      timeoutMs: opts.timeoutMs ?? IMPORT_DEFAULTS.timeoutMs,
      maxOldGenerationSizeMb: opts.maxOldGenerationSizeMb ?? IMPORT_DEFAULTS.maxOldGenerationSizeMb,
      idleMs: opts.idleMs ?? IMPORT_DEFAULTS.idleMs,
      ...(execArgv ? { execArgv } : {}),
    };
    const isSource = import.meta.url.endsWith(".ts");
    this.workerUrl = new URL(
      isSource ? "./import-worker.ts" : "./import-worker.js",
      import.meta.url,
    );
  }

  /** Threads alive, running a task, and tasks waiting for one. */
  stats(): { threads: number; running: number; queued: number } {
    let running = 0;
    for (const s of this.slots) if (s.job) running++;
    return { threads: this.slots.size, running, queued: this.queue.length };
  }

  run(task: ImportTask): Promise<ImportTaskResult> {
    if (this.closed)
      return Promise.reject(
        new ApiError(503, "IMPORT_BUSY", "the server is shutting down; try again shortly", {
          retryAfterSeconds: 5,
        }),
      );
    return new Promise<ImportTaskResult>((resolve, reject) => {
      const job: Job = { id: this.nextId++, task, resolve, reject };
      const slot = this.freeSlot();
      if (slot) return this.dispatch(slot, job);
      if (this.queue.length >= this.o.maxQueued)
        return reject(
          new ApiError(
            503,
            "IMPORT_BUSY",
            "too many imports are running on the server; try again in a few seconds",
            { retryAfterSeconds: 5 },
          ),
        );
      this.queue.push(job);
    });
  }

  /** Stop every thread; running and waiting tasks fail with 503. */
  async close(): Promise<void> {
    this.closed = true;
    const err = new ApiError(503, "IMPORT_BUSY", "the server is shutting down; try again shortly", {
      retryAfterSeconds: 5,
    });
    for (const job of this.queue.splice(0)) job.reject(err);
    await Promise.all([...this.slots].map((s) => this.drop(s, err)));
  }

  private freeSlot(): Slot | null {
    for (const s of this.slots) if (!s.job) return s;
    if (this.slots.size < this.o.maxWorkers) return this.spawn();
    return null;
  }

  private spawn(): Slot {
    const worker = new Worker(this.workerUrl, {
      resourceLimits: { maxOldGenerationSizeMb: this.o.maxOldGenerationSizeMb },
      ...(this.o.execArgv ? { execArgv: this.o.execArgv } : {}),
    });
    const slot: Slot = { worker, ready: false, job: null, timer: null, idle: null };
    this.slots.add(slot);
    worker.on(
      "message",
      (m: { ready?: true; id: number; ok: boolean; result?: unknown; error?: unknown }) => {
        if (m.ready) {
          slot.ready = true;
          if (slot.job) this.startTimer(slot);
          return;
        }
        const job = slot.job;
        if (!job || job.id !== m.id) return;
        this.release(slot);
        if (m.ok) job.resolve(m.result as ImportTaskResult);
        else job.reject(reviveImportError(m.error as SerializedImportError));
        this.pump();
      },
    );
    worker.on("error", (err) => {
      const oom = (err as { code?: string }).code === "ERR_WORKER_OUT_OF_MEMORY";
      void this.drop(
        slot,
        oom
          ? new ApiError(
              422,
              "IMPORT_OUT_OF_MEMORY",
              `the import needed more than the ${this.o.maxOldGenerationSizeMb} MiB of memory one import may use; import a smaller file`,
            )
          : err,
      );
    });
    worker.on("exit", (code) => {
      void this.drop(slot, new Error(`import worker exited with code ${code}`));
    });
    return slot;
  }

  private dispatch(slot: Slot, job: Job) {
    slot.job = job;
    if (slot.idle) clearTimeout(slot.idle);
    slot.idle = null;
    slot.worker.ref();
    // A thread still starting gets a generous start-up allowance; its task's own limit starts once it is ready.
    if (slot.ready) this.startTimer(slot);
    else this.startTimer(slot, Math.max(STARTUP_ALLOWANCE_MS, this.o.timeoutMs));
    try {
      // Posted at once: a thread still starting up receives it when its listener is attached.
      slot.worker.postMessage({ id: job.id, task: job.task });
    } catch (err) {
      // Not cloneable (cannot happen for JSON request bodies): fail this task, keep the thread.
      this.release(slot);
      job.reject(err);
      this.pump();
    }
  }

  private startTimer(slot: Slot, ms = this.o.timeoutMs) {
    if (slot.timer) clearTimeout(slot.timer);
    slot.timer = setTimeout(() => {
      const seconds = Math.round(this.o.timeoutMs / 100) / 10;
      void this.drop(
        slot,
        new ApiError(
          422,
          "IMPORT_TIMEOUT",
          `the import took longer than the ${seconds} s limit and was stopped; nothing was written. Import a smaller file`,
          { limitSeconds: seconds },
        ),
      );
    }, ms);
  }

  /** The slot's task is over: back to idle (unreferenced, stopped after `idleMs`). */
  private release(slot: Slot) {
    if (slot.timer) clearTimeout(slot.timer);
    slot.timer = null;
    slot.job = null;
    slot.worker.unref();
    slot.idle = setTimeout(() => void this.drop(slot, null), this.o.idleMs);
    slot.idle.unref();
  }

  /** Remove a thread for good: fail its task with `err` (if it has one), terminate it, start queued work. */
  private async drop(slot: Slot, err: unknown): Promise<void> {
    if (!this.slots.delete(slot)) return;
    if (slot.timer) clearTimeout(slot.timer);
    if (slot.idle) clearTimeout(slot.idle);
    const job = slot.job;
    slot.job = null;
    if (job) job.reject(err);
    this.pump();
    await slot.worker.terminate().catch(() => {});
  }

  private pump() {
    while (this.queue.length && !this.closed) {
      const slot = this.freeSlot();
      if (!slot) return;
      this.dispatch(slot, this.queue.shift()!);
    }
  }
}

const envInt = (name: string): number | undefined => {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : undefined;
};

let shared: ImportPool | null = null;

/**
 * The process's import pool. Tuning (all optional): GLIDEWORTH_IMPORT_WORKERS, GLIDEWORTH_IMPORT_QUEUE,
 * GLIDEWORTH_IMPORT_TIMEOUT_SECONDS, GLIDEWORTH_IMPORT_WORKER_MAX_MB.
 */
export function sharedImportPool(): ImportPool {
  if (!shared) {
    const seconds = envInt("GLIDEWORTH_IMPORT_TIMEOUT_SECONDS");
    const workers = envInt("GLIDEWORTH_IMPORT_WORKERS");
    const queued = envInt("GLIDEWORTH_IMPORT_QUEUE");
    const heap = envInt("GLIDEWORTH_IMPORT_WORKER_MAX_MB");
    shared = new ImportPool({
      ...(workers ? { maxWorkers: workers } : {}),
      ...(queued ? { maxQueued: queued } : {}),
      ...(seconds ? { timeoutMs: seconds * 1000 } : {}),
      ...(heap ? { maxOldGenerationSizeMb: heap } : {}),
    });
  }
  return shared;
}
