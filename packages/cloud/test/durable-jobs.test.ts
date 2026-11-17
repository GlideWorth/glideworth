import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openControlDb } from "../src/control/db.js";
import { jobRuns } from "../src/control/schema.js";
import { type DurableJob, DurableJobs } from "../src/durable-jobs.js";
import { createPinger, loadHeartbeats } from "../src/heartbeat.js";
import { durableCellJobs } from "../src/server.js";
import { logLines, testLog } from "./helpers.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const T0 = Date.parse("2026-11-17T00:00:00.000Z");

let clock = T0;
const now = () => new Date(clock);
let db: ReturnType<typeof openControlDb>;

beforeEach(() => {
  clock = T0;
  db = openControlDb(":memory:");
});
afterEach(() => db.close());

const events = (name: string) =>
  logLines.map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l.event === name);

function counter(o: Partial<DurableJob> = {}) {
  const job = {
    name: o.name ?? "restore_test",
    intervalMs: o.intervalMs ?? DAY,
    runs: 0,
    run: vi.fn(async () => {
      job.runs++;
      return o.run ? o.run() : { ok: true, count: 2 };
    }),
    ...(o.retryMs ? { retryMs: o.retryMs } : {}),
    ...(o.onDone ? { onDone: o.onDone } : {}),
  };
  return job;
}

describe("DurableJobs", () => {
  it("runs a job that never ran at once, then not again until its interval has passed", async () => {
    const job = counter();
    const jobs = new DurableJobs({ db: db.db, log: testLog, jobs: [job], now });
    await jobs.tick();
    expect(job.runs).toBe(1);
    clock += DAY - MIN;
    await jobs.tick();
    expect(job.runs).toBe(1);
    clock += MIN;
    await jobs.tick();
    expect(job.runs).toBe(2);
  });

  it("keeps the schedule across restarts: a daily job runs on time even with a deploy every hour", async () => {
    const job = counter();
    let runsBefore = 0;
    // 3 days of hourly restarts; each "process" ticks at start and then every minute until the next deploy.
    for (let h = 0; h < 72; h++) {
      const jobs = new DurableJobs({ db: db.db, log: testLog, jobs: [job], now });
      for (let m = 0; m < 60; m++) {
        await jobs.tick();
        clock += MIN;
      }
      jobs.stop();
      if (h === 23) runsBefore = job.runs;
    }
    expect(runsBefore).toBe(1);
    expect(job.runs).toBe(3);
    const row = db.db.select().from(jobRuns).get();
    expect(row).toMatchObject({ name: "restore_test", consecutiveFailures: 0 });
    expect(row?.lastSuccessAt).toBe(new Date(T0 + 2 * DAY).toISOString());
  });

  it("records a failure, logs counts only, and retries after the retry delay rather than every tick", async () => {
    const pings: boolean[] = [];
    let fail = true;
    const job = counter({
      run: () => (fail ? { ok: false, count: 3, failed: 2 } : { ok: true, count: 5 }),
      onDone: (ok) => pings.push(ok),
    });
    const jobs = new DurableJobs({ db: db.db, log: testLog, jobs: [job], now });
    await jobs.tick();
    expect(job.runs).toBe(1);
    const failed = events("job.failed").at(-1);
    expect(failed).toMatchObject({ kind: "restore_test", count: 3, remaining: 2, attempts: 1 });
    expect(failed).not.toHaveProperty("errName");

    clock += 59 * MIN;
    await jobs.tick();
    expect(job.runs).toBe(1); // default retry for a daily job: one hour
    clock += MIN;
    await jobs.tick();
    expect(job.runs).toBe(2);
    expect(events("job.failed").at(-1)).toMatchObject({ attempts: 2 });

    fail = false;
    clock += HOUR;
    await jobs.tick();
    expect(job.runs).toBe(3);
    expect(events("job.succeeded").at(-1)).toMatchObject({ kind: "restore_test", count: 5 });
    expect(db.db.select().from(jobRuns).get()?.consecutiveFailures).toBe(0);
    expect(pings).toEqual([false, false, true]);
  });

  it("treats a thrown error as a failure and logs its description, not its message", async () => {
    const job = counter({
      run: () => {
        throw new Error("secret-ish message text");
      },
    });
    const jobs = new DurableJobs({ db: db.db, log: testLog, jobs: [job], now });
    await jobs.tick();
    const line = logLines.find((l) => l.includes('"job.failed"') && l.includes("errName"));
    expect(line).toBeDefined();
    expect(line).not.toContain("secret-ish");
  });

  it("an attempt cut short by a restart waits for the retry delay", async () => {
    // The previous process started the job and died before recording a result.
    db.db
      .insert(jobRuns)
      .values({
        name: "restore_test",
        lastStartedAt: new Date(T0 - 10 * MIN).toISOString(),
        lastSuccessAt: new Date(T0 - 2 * DAY).toISOString(),
      })
      .run();
    const job = counter();
    const jobs = new DurableJobs({ db: db.db, log: testLog, jobs: [job], now });
    await jobs.tick();
    expect(job.runs).toBe(0);
    clock += 50 * MIN;
    await jobs.tick();
    expect(job.runs).toBe(1);
  });

  it("does not start a job twice while it is still running", async () => {
    let release: () => void = () => {};
    const job = counter({
      intervalMs: MIN,
      run: () => new Promise<{ ok: boolean }>((r) => (release = () => r({ ok: true }))),
    });
    const jobs = new DurableJobs({ db: db.db, log: testLog, jobs: [job], now });
    const first = jobs.tick();
    clock += 5 * MIN;
    await jobs.tick();
    expect(job.runs).toBe(1);
    release();
    await first;
    await jobs.idle();
  });

  it("start() ticks at once and then on its interval (fake timers)", async () => {
    vi.useFakeTimers({ now: T0 });
    try {
      const job = counter({ intervalMs: 15 * MIN });
      const jobs = new DurableJobs({ db: db.db, log: testLog, jobs: [job] });
      jobs.start(MIN);
      await vi.advanceTimersByTimeAsync(0);
      expect(job.runs).toBe(1);
      await vi.advanceTimersByTimeAsync(14 * MIN);
      expect(job.runs).toBe(1);
      await vi.advanceTimersByTimeAsync(MIN);
      expect(job.runs).toBe(2);
      jobs.stop();
      await vi.advanceTimersByTimeAsync(HOUR);
      expect(job.runs).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses duplicate names", () => {
    expect(
      () => new DurableJobs({ db: db.db, log: testLog, jobs: [counter(), counter()], now }),
    ).toThrow(/duplicate/);
  });
});

describe("durableCellJobs", () => {
  function fakeRuntime(o: { sweepFailed?: string[]; verifyFailed?: string[] } = {}) {
    const calls: string[] = [];
    const r = {
      backups: {
        sweep: async () => {
          calls.push("sweep");
          return { backedUp: 4, failed: o.sweepFailed ?? [] };
        },
        prune: async () => {
          calls.push("prune");
          return 7;
        },
        verifySample: async (n: number) => {
          calls.push(`verify:${n}`);
          return { verified: 5, failed: o.verifyFailed ?? [] };
        },
      },
      accounts: { maintenance: () => calls.push("accounts") },
      audit: { scrub: () => calls.push("audit") },
      quotas: { prune: () => calls.push("quotas") },
      db: db.db,
      pricing: { trialDays: 30 },
    };
    return { r: r as unknown as Parameters<typeof durableCellJobs>[0], calls };
  }

  it("runs the backup sweep, prune, restore test, maintenance and the host's long timers, pinging the right checks", async () => {
    const { r, calls } = fakeRuntime();
    const pings: string[] = [];
    const hostRun = vi.fn();
    const list = durableCellJobs(r, {
      ping: (k, ok) => pings.push(`${k}:${ok}`),
      controlOk: () => true,
      hostTimers: [
        { name: "retention", ms: HOUR, run: hostRun },
        { name: "short", ms: MIN, run: vi.fn() },
      ],
    });
    expect(list.map((j) => j.name)).toEqual([
      "backup_tenants",
      "backup_prune",
      "restore_test",
      "maintenance",
      "retention",
    ]);
    expect(list.find((j) => j.name === "restore_test")?.intervalMs).toBe(DAY);
    const jobs = new DurableJobs({ db: db.db, log: testLog, jobs: list, now });
    await jobs.tick();
    expect(calls.sort()).toEqual(
      ["accounts", "audit", "prune", "quotas", "sweep", "verify:5"].sort(),
    );
    expect(hostRun).toHaveBeenCalledOnce();
    expect(pings.sort()).toEqual(["backup:true", "restoreTest:true"]);
  });

  it("reports a failed sweep, a failed control backup or a failed sample restore as failures", async () => {
    const { r } = fakeRuntime({ verifyFailed: ["acc_x"] });
    const pings: string[] = [];
    const jobs = new DurableJobs({
      db: db.db,
      log: testLog,
      jobs: durableCellJobs(r, {
        ping: (k, ok) => pings.push(`${k}:${ok}`),
        controlOk: () => false,
      }),
      now,
    });
    await jobs.tick();
    expect(pings.sort()).toEqual(["backup:false", "restoreTest:false"]);
    expect(events("job.failed").findLast((e) => e.kind === "restore_test")).toMatchObject({
      count: 5,
      remaining: 1,
    });
  });
});

describe("heartbeat config and pings", () => {
  it("accepts https URLs and rejects anything else by variable name, without echoing the value", () => {
    const problems: string[] = [];
    const c = loadHeartbeats(
      {
        GLIDEWORTH_HEARTBEAT_BACKUP_URL: "https://hc-ping.com/abc-123/",
        GLIDEWORTH_HEARTBEAT_RESTORE_TEST_URL: "http://hc-ping.com/plain-http-value",
        GLIDEWORTH_HEARTBEAT_LIVENESS_URL: "https://hc-ping.com/x?token=query-value",
      },
      problems,
    );
    expect(c.backup).toBe("https://hc-ping.com/abc-123");
    expect(c.restoreTest).toBeNull();
    expect(c.liveness).toBeNull();
    expect(problems).toEqual([
      "GLIDEWORTH_HEARTBEAT_RESTORE_TEST_URL must be an https URL",
      "GLIDEWORTH_HEARTBEAT_LIVENESS_URL must not contain credentials, a query or a fragment",
    ]);
    expect(problems.join(" ")).not.toContain("value");
    const none: string[] = [];
    expect(loadHeartbeats({ GLIDEWORTH_HEARTBEAT_BACKUP_URL: "not a url" }, none)).toEqual({
      backup: null,
      restoreTest: null,
      liveness: null,
    });
    expect(none).toEqual(["GLIDEWORTH_HEARTBEAT_BACKUP_URL must be an absolute URL"]);
  });

  it("pings the URL on success and URL/fail on failure with a bare GET, and never logs the URL", async () => {
    const seen: Array<{ url: string; init: RequestInit | undefined }> = [];
    let answer: Response | Error = new Response("OK");
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      seen.push({ url, init });
      if (answer instanceof Error) throw answer;
      return answer;
    }) as unknown as typeof fetch;
    const url = "https://hc-ping.com/0f4e-unique-check-id";
    const ping = createPinger(
      { backup: url, restoreTest: null, liveness: null },
      testLog,
      fakeFetch,
    );
    ping("backup", true);
    ping("backup", false);
    ping("restoreTest", true); // not configured: nothing sent
    await new Promise((r) => setTimeout(r, 0));
    expect(seen.map((s) => s.url)).toEqual([url, `${url}/fail`]);
    for (const s of seen) {
      expect(s.init?.method).toBe("GET");
      expect(s.init?.body).toBeUndefined();
      expect(s.init?.headers).toBeUndefined();
      expect(s.init?.signal).toBeInstanceOf(AbortSignal);
    }
    answer = new Response("nope", { status: 404 });
    ping("backup", true);
    answer = new TypeError("fetch failed");
    ping("backup", true);
    await new Promise((r) => setTimeout(r, 0));
    const warns = events("heartbeat.ping_failed");
    expect(warns.some((w) => w.statusCode === 404)).toBe(true);
    expect(warns.some((w) => w.errName === "TypeError")).toBe(true);
    expect(logLines.join("\n")).not.toContain("0f4e-unique-check-id");
  });
});
