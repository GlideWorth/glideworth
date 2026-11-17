/**
 * Periodic jobs whose interval is long compared with how often the server restarts (restore test, prune,
 * maintenance, backup sweep). A plain `setInterval` starts its clock again at every deploy, so a daily job
 * might never run. Here each job's last start, success and failure are kept in the control database
 * (`job_runs`); a short tick, and one at startup, runs every job that is due.
 *
 * Due: never succeeded, or the last success started at least `intervalMs` ago. After a failed or interrupted
 * attempt the job waits `retryMs` (default: the interval, at most one hour) before trying again, so a broken
 * job does not run on every tick. Logs carry the job name, durations, counts and error descriptions only.
 */
import { eq, sql } from "drizzle-orm";
import type { ControlDb } from "./control/db.js";
import { jobRuns } from "./control/schema.js";
import type { Logger } from "./log/index.js";

/** What a job may report. Returning `{ ok: false }` (or throwing) counts as a failure. */
export interface JobResult {
  ok: boolean;
  /** Items handled (workspaces backed up, backups verified, objects deleted). */
  count?: number;
  /** Items that failed. */
  failed?: number;
}

export interface DurableJob {
  name: string;
  intervalMs: number;
  retryMs?: number;
  run(): Promise<JobResult | unknown> | JobResult | unknown;
  /** Called after every attempt (heartbeat pings). Must not throw; its result is not awaited. */
  onDone?(ok: boolean): void;
}

const HOUR = 60 * 60_000;
/** A recorded time this far in the future is treated as stale (the clock went back). */
const FUTURE_SLACK_MS = 5 * 60_000;

function isResult(v: unknown): v is JobResult {
  return typeof v === "object" && v !== null && typeof (v as JobResult).ok === "boolean";
}

export class DurableJobs {
  private readonly running = new Map<string, Promise<void>>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => Date;

  constructor(
    private readonly d: {
      db: ControlDb;
      log: Logger;
      jobs: DurableJob[];
      now?: () => Date;
    },
  ) {
    this.now = d.now ?? (() => new Date());
    const names = new Set<string>();
    for (const j of d.jobs) {
      if (names.has(j.name)) throw new Error(`duplicate job name ${j.name}`);
      names.add(j.name);
      if (!(j.intervalMs > 0)) throw new Error(`job ${j.name} needs a positive interval`);
    }
  }

  /** Whether `job` is due at `at` according to its `job_runs` row. */
  isDue(job: DurableJob, at: number = this.now().getTime()): boolean {
    const row = this.d.db.select().from(jobRuns).where(eq(jobRuns.name, job.name)).get();
    if (!row) return true;
    const t = (s: string | null) => {
      if (!s) return null;
      const v = Date.parse(s);
      return Number.isNaN(v) || v > at + FUTURE_SLACK_MS ? null : v;
    };
    const success = t(row.lastSuccessAt);
    const started = t(row.lastStartedAt);
    if (success !== null && at - success < job.intervalMs) return false;
    // The last attempt failed or was cut short (started after the last success): wait before retrying.
    if (started !== null && (success === null || started > success)) {
      const retry = job.retryMs ?? Math.min(job.intervalMs, HOUR);
      if (at - started < retry) return false;
    }
    return true;
  }

  /** Start every due job that is not already running; resolves when those runs have finished. */
  tick(): Promise<void> {
    const at = this.now().getTime();
    const started: Promise<void>[] = [];
    for (const job of this.d.jobs) {
      if (this.running.has(job.name)) continue;
      let due: boolean;
      try {
        due = this.isDue(job, at);
      } catch (err) {
        this.d.log.error("job.schedule_unreadable", { kind: job.name, err });
        continue;
      }
      if (!due) continue;
      const p = this.runOne(job).finally(() => this.running.delete(job.name));
      this.running.set(job.name, p);
      started.push(p);
    }
    return Promise.all(started).then(() => undefined);
  }

  /** Tick now and then every `tickMs` (default one minute). */
  start(tickMs = 60_000): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), tickMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Resolves when no job is running. */
  async idle(): Promise<void> {
    while (this.running.size) await Promise.all([...this.running.values()]);
  }

  private async runOne(job: DurableJob): Promise<void> {
    const startedAt = this.now();
    const startedIso = startedAt.toISOString();
    if (!this.record(job.name, { lastStartedAt: startedIso })) return;
    let ok = false;
    let result: JobResult | null = null;
    let error: unknown = null;
    try {
      const v = await job.run();
      result = isResult(v) ? v : null;
      ok = result ? result.ok : true;
    } catch (err) {
      error = err;
    }
    const durationMs = Math.max(0, this.now().getTime() - startedAt.getTime());
    if (ok) {
      // Anchored to the start, so the schedule does not drift by the job's own duration.
      this.record(job.name, { lastSuccessAt: startedIso, consecutiveFailures: 0 });
      this.d.log.info("job.succeeded", {
        kind: job.name,
        durationMs,
        count: result?.count,
        remaining: result?.failed,
      });
    } else {
      this.record(job.name, {
        lastFailureAt: this.now().toISOString(),
        consecutiveFailures: sql`${jobRuns.consecutiveFailures} + 1`,
      });
      let attempts: number | undefined;
      try {
        attempts =
          this.d.db.select().from(jobRuns).where(eq(jobRuns.name, job.name)).get()
            ?.consecutiveFailures ?? undefined;
      } catch {
        attempts = undefined;
      }
      this.d.log.error("job.failed", {
        kind: job.name,
        durationMs,
        attempts,
        count: result?.count,
        remaining: result?.failed,
        ...(error !== null ? { err: error } : {}),
      });
    }
    try {
      job.onDone?.(ok);
    } catch {
      // a heartbeat must never affect the job
    }
  }

  /** Upsert the job's row; false (and an error log) when the database cannot be written. */
  private record(
    name: string,
    set: Partial<{
      lastStartedAt: string;
      lastSuccessAt: string;
      lastFailureAt: string;
      consecutiveFailures: number | ReturnType<typeof sql>;
    }>,
  ): boolean {
    try {
      this.d.db.insert(jobRuns).values({ name }).onConflictDoNothing().run();
      this.d.db.update(jobRuns).set(set).where(eq(jobRuns.name, name)).run();
      return true;
    } catch (err) {
      this.d.log.error("job.schedule_unwritable", { kind: name, err });
      return false;
    }
  }
}
