/**
 * Security review finding 4, second half: CSV and document imports are parsed in a worker thread
 * (`src/jobs/import-pool.ts`), not on the request thread.
 *
 * - the worker gives exactly what the in-process run gives, on the fixtures, for every kind of import;
 * - a large crafted CSV does not hold up `/health`;
 * - the time limit stops the thread (422 IMPORT_TIMEOUT), the pool and per-workspace limits refuse a burst
 *   (503 IMPORT_BUSY, 429 RATE_LIMITED, with Retry-After), and importer errors map as before.
 *
 * Set GW_IMPORT_TIMINGS=1 to print the /health latencies.
 */
import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { migrateDocument } from "@glideworth/core";
import { createSampleDocument, createUkSampleDocument } from "@glideworth/core/samples";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { importDeps } from "../src/deps.js";
import { ImportPool } from "../src/jobs/import-pool.js";
import { type ImportTask, runImportTask } from "../src/jobs/import-task.js";
import { type Harness, setup, WRITE_KEY } from "./helpers.js";

const CAIRN_EXPORT = JSON.parse(
  readFileSync(
    new URL("../../../packages/importers/test/fixtures/cairn-export-v1.json", import.meta.url),
    "utf8",
  ),
) as unknown;

/** The importers' synthetic ProjectionLab export (outside this package's rootDir, so loaded by URL). */
const { buildSyntheticExport } = (await import(
  new URL("../../../packages/importers/test/fixtures/projectionlab-synthetic.ts", import.meta.url)
    .href
)) as { buildSyntheticExport: () => unknown };

const BALANCES_CSV =
  "Account,Balance,Date\nJoint Checking,5432.10,2026-01-31\nNew Savings,1200,2026-01-31\n";
const SNAPSHOTS_CSV = "Date,Net worth\n2024-12-31,410000\n2025-06-30,432000\n2025-12-31,455000\n";
const TRANSACTIONS_CSV =
  "Date,Description,Amount,Category\n2025-02-01,Rent,-1200,Housing\n2025-03-04,Groceries,-80.5,Food\n2025-11-02,Flight,-640,Travel\n";

/** A transactions CSV of about `size` characters, every row its own payee and one of 5,000 categories. */
function largeTransactionsCsv(size = 2_000_000): string {
  const parts = ["Date,Description,Amount,Category\n"];
  let n = parts[0]!.length;
  for (let i = 0; n < size - 60; i++) {
    const row = `2025-${String((i % 12) + 1).padStart(2, "0")}-01,Shop ${i},-1.00,Category ${i % 5_000}\n`;
    parts.push(row);
    n += row.length;
  }
  return parts.join("");
}

/** An account-balances CSV of about `size` characters, every row a different account. */
function largeBalancesCsv(size = 2_000_000): string {
  const parts = ["Account,Balance,Date\n"];
  let n = parts[0]!.length;
  for (let i = 0; n < size - 60; i++) {
    const row = `Account ${i},1.00,2026-01-31\n`;
    parts.push(row);
    n += row.length;
  }
  return parts.join("");
}

let h: Harness | undefined;
let server: Server | undefined;
const pools: ImportPool[] = [];
afterEach(async () => {
  server?.close();
  server = undefined;
  h?.close();
  h = undefined;
  await Promise.all(pools.splice(0).map((p) => p.close()));
});

function pool(o: ConstructorParameters<typeof ImportPool>[0] = {}): ImportPool {
  const p = new ImportPool(o);
  pools.push(p);
  return p;
}

/** Comparable: timestamps and fresh ids differ between two runs by design. */
function normalise(v: unknown): unknown {
  return JSON.parse(
    JSON.stringify(v)
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, "<ts>")
      .replace(/"(snap|acct|exp|evt)_[A-Za-z0-9_-]{6,}"/g, '"$1_<id>"'),
  );
}

describe("import tasks: the worker gives what the in-process run gives", () => {
  const shared = new ImportPool();
  afterAll(() => shared.close());
  const us = createSampleDocument();
  const uk = createUkSampleDocument();
  const plan = us.plans[0]!.id;
  const tasks: Array<[string, ImportTask]> = [];
  for (const dryRun of [true, false]) {
    for (const [name, data] of [
      ["glideworth sample", us],
      ["uk sample", uk],
      ["cairn v1 export", CAIRN_EXPORT],
      ["projectionlab synthetic", buildSyntheticExport()],
    ] as const)
      tasks.push([
        `document ${name} dryRun=${dryRun}`,
        { op: "document", format: "auto", data, dryRun },
      ]);
    for (const [kind, text] of [
      ["account-balances", BALANCES_CSV],
      ["progress-snapshots", SNAPSHOTS_CSV],
      ["transactions", TRANSACTIONS_CSV],
    ] as const)
      tasks.push([
        `csv ${kind} dryRun=${dryRun}`,
        {
          op: "csv",
          doc: us,
          text,
          dryRun,
          replaceProgress: kind === "progress-snapshots",
          request:
            kind === "transactions"
              ? { kind, planId: plan, options: {} }
              : ({ kind, options: { createMissing: true } } as never),
        },
      ]);
  }
  tasks.push(["csv-analyze", { op: "csv-analyze", text: TRANSACTIONS_CSV, kind: "transactions" }]);

  it.each(tasks)("%s", async (_name, task) => {
    const inline = normalise(runImportTask(task, importDeps));
    expect(normalise(await shared.run(task))).toEqual(inline);
  });

  it("a validated document is stored as is: migrateDocument gives the same document again", () => {
    for (const raw of [us, uk, CAIRN_EXPORT]) {
      const once = migrateDocument(raw);
      expect(migrateDocument(once)).toEqual(once);
    }
    const pl = importDeps.importProjectionLab(buildSyntheticExport()).document;
    const once = migrateDocument(pl);
    expect(migrateDocument(once)).toEqual(once);
  });
});

describe("imports over the API: worker and in-process give the same responses and the same household", () => {
  const steps: Array<[string, unknown]> = [
    [
      "/api/v1/households/hh-sample/import/csv/analyze",
      { text: BALANCES_CSV, kind: "account-balances" },
    ],
    [
      "/api/v1/households/hh-sample/import/csv",
      { text: BALANCES_CSV, kind: "account-balances", options: { createMissing: true } },
    ],
    [
      "/api/v1/households/hh-sample/import/csv",
      { text: TRANSACTIONS_CSV, kind: "transactions", planId: "plan-main", dryRun: true },
    ],
    [
      "/api/v1/households/hh-sample/import/csv",
      {
        text: BALANCES_CSV,
        kind: "account-balances",
        dryRun: false,
        options: { createMissing: true },
      },
    ],
    [
      "/api/v1/households/hh-sample/import/csv",
      {
        text: SNAPSHOTS_CSV,
        kind: "progress-snapshots",
        dryRun: false,
        options: { mode: "replace" },
      },
    ],
    [
      "/api/v1/households/hh-sample/import/csv",
      { text: TRANSACTIONS_CSV, kind: "transactions", planId: "plan-main", dryRun: false },
    ],
    [
      "/api/v1/households/hh-sample/import/csv",
      { text: "nonsense", kind: "transactions", planId: "plan-main", dryRun: false },
    ],
    ["/api/v1/import", { data: CAIRN_EXPORT, dryRun: true }],
    ["/api/v1/import", { data: buildSyntheticExport(), dryRun: false, householdId: "hh-pl" }],
    ["/api/v1/import", { data: { ...createUkSampleDocument() }, mode: "replace" }],
    ["/api/v1/import", { data: { schemaVersion: 1, household: 42 }, dryRun: true }],
    ["/api/v1/import", { format: "projectionlab", data: { nope: true }, dryRun: true }],
  ];

  async function runAll(importRunner: "inline" | ImportPool) {
    const harness = setup({ importRunner });
    const out: unknown[] = [];
    try {
      for (const [path, body] of steps) {
        const r = await harness.call(path, { method: "POST", body });
        out.push({ status: r.status, body: r.json });
      }
      out.push(await harness.call("/api/v1/households/hh-sample/export").then((r) => r.json));
      out.push(await harness.call("/api/v1/households").then((r) => r.json));
    } finally {
      harness.close();
    }
    return normalise(out);
  }

  it("same statuses, bodies and stored data", async () => {
    const inline = await runAll("inline");
    const worker = await runAll(pool());
    expect(worker).toEqual(inline);
    // The script covers success, 400 (invalid document, not a ProjectionLab export) and 422.
    const statuses = (inline as Array<{ status?: number }>).map((r) => r.status);
    expect(statuses).toContain(400);
    expect(statuses.filter((s) => s === 200).length).toBeGreaterThan(8);
  }, 120_000);
});

describe("a large crafted CSV does not hold up /health", () => {
  async function start(importRunner: "inline" | ImportPool): Promise<string> {
    h = setup({ importRunner });
    await new Promise<void>((resolve) => {
      server = serve({ fetch: h!.app.fetch, port: 0, hostname: "127.0.0.1" }, () =>
        resolve(),
      ) as Server;
    });
    return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  }

  /**
   * Poll /health every 5 ms while `work` runs. The client shares this process, so a blocked event loop also
   * delays the next poll being sent: the measure is the longest stretch without an answer (the wait of a
   * request that arrives just as the server stops answering), not only one request's round trip.
   */
  async function healthDuring(base: string, work: () => Promise<unknown>) {
    const state = { done: false };
    let worst = 0;
    let count = 0;
    let last = performance.now();
    const poll = (async () => {
      while (!state.done) {
        await fetch(`${base}/health`).then((r) => r.text());
        const now = performance.now();
        worst = Math.max(worst, now - last);
        last = now;
        count++;
        await new Promise((r) => setTimeout(r, 5));
      }
    })();
    await new Promise((r) => setTimeout(r, 20));
    const t0 = performance.now();
    const result = await work();
    const took = performance.now() - t0;
    state.done = true;
    await poll;
    return { worst, count, took, result };
  }

  /**
   * The response (several MB for these files) is read as text, not parsed: this client shares the server's
   * event loop, and parsing it here would be counted as the server being slow.
   */
  const post = (base: string, body: unknown) =>
    fetch(`${base}/api/v1/households/hh-sample/import/csv`, {
      method: "POST",
      headers: { authorization: `Bearer ${WRITE_KEY}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then(async (r) => ({ status: r.status, text: await r.text() }));

  /** 2 MB crafted files, and whether /health must keep answering during them. */
  const shapes = (): Array<[string, unknown, boolean, number?]> => {
    const transactions = largeTransactionsCsv();
    return [
      [
        "transactions dry run",
        { text: transactions, kind: "transactions", planId: "plan-main", dryRun: true },
        true,
      ],
      [
        "balances dry run, every row a new account",
        {
          text: largeBalancesCsv(),
          kind: "account-balances",
          options: { createMissing: true },
          dryRun: true,
        },
        true,
      ],
      [
        "transactions apply, spending to a plan",
        { text: transactions, kind: "transactions", planId: "plan-main", dryRun: false },
        true,
      ],
    ];
  };

  it("served from the worker: /health stays fast during 2 MB imports", async () => {
    expect(largeTransactionsCsv().length).toBeLessThanOrEqual(2_000_000);
    const p = pool();
    // Warm the thread, so the measurement is of the import and not of loading the importers.
    await p.run({ op: "csv-analyze", text: "a,b\n1,2\n", kind: "account-balances" });
    const base = await start(p);
    const timings: Record<string, unknown> = {};
    for (const [name, body, checked, status = 200] of shapes()) {
      const r = await healthDuring(base, () => post(base, body));
      const res = r.result as { status: number; text: string };
      expect(res.status, res.text.slice(0, 300)).toBe(status);
      timings[name] = {
        importMs: Math.round(r.took),
        healthWorstMs: Math.round(r.worst),
        healthAnswers: r.count,
      };
      if (!checked) continue;
      // In-process, /health waits for the whole import (worst gap ~ the import's time). From the worker it
      // waits only for reading the request and writing the (several MB) response. Relative, so a loaded
      // machine slowing both does not fail it.
      expect(r.worst, `${name}: ${JSON.stringify(timings[name])}`).toBeLessThan(
        Math.max(40, 0.6 * r.took),
      );
    }
    if (process.env.GW_IMPORT_TIMINGS) console.info("worker", timings);
  }, 120_000);

  it.runIf(process.env.GW_IMPORT_TIMINGS)(
    "for comparison: in-process (before)",
    async () => {
      const base = await start("inline");
      const timings: Record<string, unknown> = {};
      for (const [name, body] of shapes()) {
        const r = await healthDuring(base, () => post(base, body));
        timings[name] = {
          importMs: Math.round(r.took),
          healthWorstMs: Math.round(r.worst),
          healthAnswers: r.count,
        };
      }
      console.info("inline", timings);
    },
    120_000,
  );
});

describe("limits and failures", () => {
  it("a task over the time limit has its thread terminated: 422 IMPORT_TIMEOUT, and the next one works", async () => {
    const p = pool({ timeoutMs: 30, maxWorkers: 1 });
    await p.run({ op: "csv-analyze", text: "a,b\n1,2\n", kind: "account-balances" }); // warm, < 30 ms
    h = setup({ importRunner: p });
    const expenses = h.services.plans.get("plan-main").expenses.length;
    const r = await h.call("/api/v1/households/hh-sample/import/csv", {
      method: "POST",
      body: {
        text: largeTransactionsCsv(),
        kind: "transactions",
        planId: "plan-main",
        dryRun: false,
      },
    });
    expect(r.status, r.text.slice(0, 300)).toBe(422);
    expect(r.json.error.code).toBe("IMPORT_TIMEOUT");
    expect(r.json.error.details).toEqual({ limitSeconds: 0 });
    expect(p.stats()).toEqual({ threads: 0, running: 0, queued: 0 }); // terminated, not leaked
    // Nothing was written.
    expect(h.services.plans.get("plan-main").expenses).toHaveLength(expenses);
    // A fresh thread serves the next import. On a busy machine a cold thread can miss the 30 ms limit even for
    // this small file (a timeout terminates it and the pool starts another), so allow a few tries.
    let ok = { status: 0, text: "" };
    for (let i = 0; i < 5 && ok.status !== 200; i++)
      ok = await h.call("/api/v1/households/hh-sample/import/csv", {
        method: "POST",
        body: { text: TRANSACTIONS_CSV, kind: "transactions", planId: "plan-main" },
      });
    expect(ok.status, ok.text.slice(0, 300)).toBe(200);
  }, 60_000);

  it("the pool runs at most maxWorkers and queues at most maxQueued: the rest is 503 IMPORT_BUSY with Retry-After", async () => {
    const p = pool({ maxWorkers: 1, maxQueued: 1 });
    const task: ImportTask = {
      op: "csv-analyze",
      text: largeTransactionsCsv(400_000),
      kind: "transactions",
    };
    const runs = [p.run(task), p.run(task), p.run(task)].map((x) =>
      x.then(
        () => "ok",
        (e: { status?: number; code?: string }) => `${e.status} ${e.code}`,
      ),
    );
    expect(p.stats()).toMatchObject({ threads: 1, running: 1, queued: 1 });
    expect(await Promise.all(runs)).toEqual(["ok", "ok", "503 IMPORT_BUSY"]);

    // Over HTTP: the header and body.
    const busy = pool({ maxWorkers: 1, maxQueued: 0 });
    h = setup({ importRunner: busy });
    const first = h.call("/api/v1/households/hh-sample/import/csv/analyze", {
      method: "POST",
      body: { text: largeTransactionsCsv(400_000), kind: "transactions" },
    });
    const second = await h.call("/api/v1/households/hh-sample/import/csv/analyze", {
      method: "POST",
      body: { text: "a,b\n1,2\n", kind: "transactions" },
    });
    expect(second.status).toBe(503);
    expect(second.json.error.code).toBe("IMPORT_BUSY");
    expect(second.headers.get("retry-after")).toBe("5");
    expect((await first).status).toBe(200);
  }, 60_000);

  it("one workspace runs at most 2 imports at once: the third is 429 RATE_LIMITED", async () => {
    h = setup({ importRunner: pool({ maxWorkers: 4 }) });
    const body = { text: largeTransactionsCsv(400_000), kind: "transactions", planId: "plan-main" };
    const rs = await Promise.all(
      [1, 2, 3].map(() =>
        h!.call("/api/v1/households/hh-sample/import/csv", { method: "POST", body }),
      ),
    );
    expect(rs.map((r) => r.status).sort()).toEqual([200, 200, 429]);
    const limited = rs.find((r) => r.status === 429)!;
    expect(limited.json.error.code).toBe("RATE_LIMITED");
    expect(limited.headers.get("retry-after")).toBe("5");
    expect(h.services.imports.busy()).toBe(false);
  }, 60_000);

  it("a thread out of heap is 422 IMPORT_OUT_OF_MEMORY and is replaced", async () => {
    const p = pool({ maxOldGenerationSizeMb: 24, timeoutMs: 60_000 });
    const big = `Date,Description,Amount\n${"2025-01-01,Something bought,-1.00\n".repeat(280_000)}`;
    const e = await p.run({ op: "csv-analyze", text: big, kind: "transactions" }).then(
      () => null,
      (err: { status?: number; code?: string }) => err,
    );
    expect(e).toMatchObject({ status: 422, code: "IMPORT_OUT_OF_MEMORY" });
    expect(p.stats().threads).toBe(0);
  }, 60_000);

  it("importer errors keep their mapping across the thread: ValidationError is 400 VALIDATION", async () => {
    const p = pool();
    const bad = await p
      .run({ op: "document", format: "glideworth", data: { household: 1 }, dryRun: true })
      .then(
        () => null,
        (e: Error & { code?: string }) => e,
      );
    expect(bad).toMatchObject({ code: "VALIDATION" });
    h = setup({ importRunner: p });
    const r = await h.call("/api/v1/import", {
      method: "POST",
      body: { format: "projectionlab", data: { nope: true }, dryRun: true },
    });
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe("VALIDATION");
  }, 60_000);

  it("a blocked apply writes nothing; the household changing meanwhile is a 409 and writes nothing", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const real = pool();
    // A runner that waits until the test has changed the household.
    const slow = Object.assign(Object.create(ImportPool.prototype), {
      run: async (task: ImportTask) => {
        const out = await real.run(task);
        await gate;
        return out;
      },
    }) as ImportPool;
    h = setup({ importRunner: slow });
    const pending = h.call("/api/v1/households/hh-sample/import/csv", {
      method: "POST",
      body: {
        text: BALANCES_CSV,
        kind: "account-balances",
        dryRun: false,
        options: { createMissing: true },
      },
    });
    await new Promise((r) => setTimeout(r, 300));
    const before = h.services.households.get("hh-sample").finances;
    h.services.households.replaceCurrent(
      "hh-sample",
      { finances: { ...before, accounts: before.accounts.slice(1) } },
      undefined,
      { kind: "system" } as never,
    );
    const changed = JSON.stringify(h.services.households.get("hh-sample").finances);
    release();
    const r = await pending;
    expect(r.status, r.text.slice(0, 300)).toBe(409);
    expect(r.json.error.code).toBe("VERSION_CONFLICT");
    expect(JSON.stringify(h.services.households.get("hh-sample").finances)).toBe(changed);
  }, 60_000);
});
