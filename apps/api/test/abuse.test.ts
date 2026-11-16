/**
 * T-ABUSE (design section 10) and the weaknesses the design review found in the self-host code, fixed for both
 * modes: bounded login-throttle and rate-limit maps, OAuth dynamic registration that one address cannot
 * exhaust for everyone, worker jobs with a time and memory limit, sensitivity and attribution off the event
 * loop, the SSRF guard in cloud mode, and the storage quota (507, database intact).
 */
import { createSampleDocument } from "@glideworth/core/samples";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db/client.js";
import { coreDeps } from "../src/deps.js";
import { inlineExecutor, type JobExecutor, workerExecutor } from "../src/jobs/executor.js";
import { ipRateLimit, rateLimit, WindowCounter } from "../src/middleware.js";
import { AuthService } from "../src/services/auth.js";
import { Services } from "../src/services.js";
import { bootCloud, Client, signUp } from "./cloud-harness.js";
import { type Harness, setup } from "./helpers.js";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let h: Harness | undefined;
afterEach(() => {
  h?.close();
  h = undefined;
});

describe("bounded in-memory maps", () => {
  it("a limiter keeps at most maxKeys windows, whatever the number of distinct callers", () => {
    const w = new WindowCounter(100);
    for (let i = 0; i < 5000; i++) w.hit(`caller-${i}`);
    expect(w.size).toBeLessThanOrEqual(100);
    // A caller that keeps hitting is still counted.
    for (let i = 0; i < 5; i++) w.hit("steady");
    expect(w.hit("steady").count).toBe(6);
  });

  it("the per-credential rate limit is keyed per workspace in cloud mode (same key id, separate buckets)", async () => {
    const app = new Hono<{ Variables: { principal: { keyId: string }; account: string } }>();
    app.use("*", async (c, next) => {
      c.set("principal", { keyId: "key_samesame" });
      c.set("account", c.req.header("x-account") ?? "");
      await next();
    });
    app.use(
      "*",
      rateLimit(3, {
        keyOf: (c) => `${c.get("account" as never)}:${c.get("principal").keyId}`,
      }) as never,
    );
    app.onError((_e, c) => c.json({}, 429));
    app.get("/", (c) => c.text("ok"));
    const hit = (account: string) => app.request("/", { headers: { "x-account": account } });
    for (let i = 0; i < 3; i++) expect((await hit("ta")).status).toBe(200);
    expect((await hit("ta")).status).toBe(429);
    expect((await hit("tb")).status).toBe(200);
  });

  it("the public per-address limiter is bounded too", async () => {
    const app = new Hono();
    let n = 0;
    app.use(
      "*",
      ipRateLimit(1, () => `ip-${n++}`, { maxKeys: 50 }),
    );
    app.get("/", (c) => c.text("ok"));
    for (let i = 0; i < 500; i++) expect((await app.request("/")).status).toBe(200);
  });

  it("the login throttle forgets the oldest clients beyond its bound, and still throttles", async () => {
    const { db, close } = openDb(":memory:");
    try {
      const auth = new AuthService(db, {
        maxThrottledClients: 20,
        maxFailedLogins: 2,
        maxFailedLoginsGlobal: 10_000,
      });
      await auth.setup("correct horse battery staple", undefined);
      for (let i = 0; i < 60; i++)
        await expect(auth.login("wrong passphrase!!", `client-${i}`)).rejects.toThrow();
      expect(auth.throttledClients).toBeLessThanOrEqual(20);
      // A client over its limit is still refused.
      await expect(auth.login("wrong passphrase!!", "client-59")).rejects.toThrow();
      await expect(auth.login("wrong passphrase!!", "client-59")).rejects.toMatchObject({
        code: "RATE_LIMITED",
      });
    } finally {
      close();
    }
  }, 60_000);
});

describe("OAuth dynamic client registration flood", () => {
  const register = (call: Harness["call"], ip: string) =>
    call("/oauth/register", {
      method: "POST",
      key: null,
      headers: { "x-forwarded-for": ip },
      body: { client_name: "flood", redirect_uris: ["https://client.example/cb"] },
    });

  it("self-host: one address flooding does not block another, even when the table is full", async () => {
    h = setup({ appOptions: { trustProxy: true } });
    const statuses: number[] = [];
    for (let i = 0; i < 30; i++) statuses.push((await register(h.call, "203.0.113.7")).status);
    expect(statuses.filter((s) => s === 201).length).toBeGreaterThan(0);
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
    expect((await register(h.call, "198.51.100.9")).status).toBe(201);
    // A full table: the oldest never-consented client makes room; registration keeps working.
    const raw = h.ctx.sqlite;
    const ins = raw.prepare(
      "INSERT INTO oauth_clients (id, name, redirect_uris, created_at) VALUES (?, 'old', '[]', ?)",
    );
    for (let i = 0; i < 600; i++)
      ins.run(`old-${i}`, new Date(Date.now() - 3600_000 + i).toISOString());
    const count = () =>
      (raw.prepare("SELECT count(*) AS n FROM oauth_clients").get() as { n: number }).n;
    const before = count();
    const r = await register(h.call, "192.0.2.44");
    expect(r.status).toBe(201);
    expect(count()).toBe(before);
    expect(raw.prepare("SELECT 1 FROM oauth_clients WHERE id = 'old-0'").get()).toBeUndefined();
  });

  it("self-host: a daily per-address cap, and never-consented clients go after 24 hours", async () => {
    const { db, close } = openDb(":memory:");
    let now = Date.now();
    try {
      const s = new Services(db, { oauth: { now: () => now } });
      const meta = { client_name: "x", redirect_uris: ["https://c.example/cb"] };
      let refused = 0;
      for (let i = 0; i < 60; i++) {
        try {
          s.oauth.register(meta, "203.0.113.50");
        } catch {
          refused++;
        }
      }
      expect(refused).toBe(10);
      expect(() => s.oauth.register(meta, "203.0.113.51")).not.toThrow();
      now += 25 * 3600_000;
      s.oauth.register(meta, "203.0.113.50");
      expect(s.oauth.listClients()).toHaveLength(1);
    } finally {
      close();
    }
  });

  it("cloud: the control-plane registry limits one address and not the others", async () => {
    const cloud = await bootCloud();
    try {
      const reg = (ip: string) => {
        const c = new Client(cloud);
        c.ip = ip;
        return c.post("/oauth/register", {
          client_name: "flood",
          redirect_uris: ["https://client.example/cb"],
        });
      };
      const statuses: number[] = [];
      for (let i = 0; i < 25; i++) statuses.push((await reg("203.0.113.70")).status);
      expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
      expect((await reg("198.51.100.71")).status).toBe(201);
    } finally {
      await cloud.close();
    }
  });
});

describe("worker jobs: time and memory limits", () => {
  const hanging: JobExecutor = (_spec, hooks) =>
    new Promise((_res, rej) =>
      hooks.signal.addEventListener("abort", () => rej(new Error("aborted")), { once: true }),
    );

  it("a job running past the limit is stopped and fails with JOB_TIMEOUT", async () => {
    const { db, close } = openDb(":memory:");
    try {
      const s = new Services(db, { executor: hanging, jobs: { maxJobMs: () => 150 } });
      s.households.importDocument(createSampleDocument(), { kind: "system", label: "seed" });
      const job = s.sim.startMonteCarlo("plan-main", {} as never, { kind: "system", label: "t" });
      const done = await s.jobs.waitFor(job.id, 5000);
      expect(done.status).toBe("failed");
      expect(done.error?.code).toBe("JOB_TIMEOUT");
      await new Promise((r) => setTimeout(r, 20));
      expect(s.jobs.busy()).toBe(false);
    } finally {
      close();
    }
  });

  it("a real worker thread is terminated at the limit, and runs with a heap limit", async () => {
    let threadMs = -1;
    const exec = workerExecutor({
      maxShards: 1,
      maxOldGenerationSizeMb: 256,
      onThreadMs: (ms) => (threadMs = ms),
    });
    const { db, close } = openDb(":memory:");
    try {
      const s = new Services(db, { executor: exec, jobs: { maxJobMs: () => 300 } });
      s.households.importDocument(createSampleDocument(), { kind: "system", label: "seed" });
      const job = s.sim.startMonteCarlo(
        "plan-main",
        { settings: { trials: 10_000, method: "historical-random-restart" } } as never,
        { kind: "system", label: "t" },
      );
      const started = Date.now();
      const done = await s.jobs.waitFor(job.id, 20_000);
      expect(done.status).toBe("failed");
      expect(done.error?.code).toBe("JOB_TIMEOUT");
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(threadMs).toBeGreaterThanOrEqual(0);
    } finally {
      close();
    }
  }, 30_000);

  it("sensitivity and attribution run in the job executor, not on the event loop", async () => {
    const kinds: string[] = [];
    const deps = { ...coreDeps };
    const inner = inlineExecutor(deps);
    const spy: JobExecutor = (spec, hooks) => {
      kinds.push(spec.kind);
      return inner(spec, hooks);
    };
    h = setup({ executor: spy, realEngine: true });
    const sens = await h.call("/api/v1/plans/plan-main/insights/sensitivity", {
      method: "POST",
      body: {},
    });
    expect(sens.status).toBe(200);
    const branch = await h.call("/api/v1/plans/plan-main/duplicate", {
      method: "POST",
      body: { name: "B" },
    });
    const diff = await h.call("/api/v1/plans/plan-main/insights/explain-difference", {
      method: "POST",
      body: { otherPlanId: branch.json.id, attribute: true, metric: "endNetWorthReal" },
    });
    expect(diff.status, diff.text).toBe(200);
    expect(kinds).toContain("sensitivity");
    expect(kinds).toContain("attribution");
  }, 60_000);
});

describe("cloud: SSRF guard and storage quota", () => {
  it("refuses private and malformed webhook URLs exactly as self-host does", async () => {
    const cloud = await bootCloud();
    try {
      const owner = await signUp(cloud);
      for (const url of [
        "http://127.0.0.1/x",
        "http://localhost:3000/x",
        "http://169.254.169.254/latest/meta-data/",
        "http://[::1]/x",
        "http://[::ffff:127.0.0.1]/x",
        "http://2130706433/x",
        "http://0x7f.1/x",
        "http://10.1.2.3/x",
        "http://metadata.google.internal/x",
        "http://printer.local/x",
        "ftp://example.com/x",
        "file:///etc/passwd",
        "https://user:pw@example.com/x",
      ]) {
        const r = await owner.browser.post("/api/v1/webhooks", { url, events: ["plan.updated"] });
        expect(r.status, url).toBe(400);
        expect(r.json.error.code).toBe("VALIDATION");
      }
      const ok = await owner.browser.post("/api/v1/webhooks", {
        url: "https://hooks.example.com/glideworth",
        events: ["plan.updated"],
      });
      expect(ok.status).toBe(201);
    } finally {
      await cloud.close();
    }
  });

  it("a workspace over its storage quota gets 507 and its database stays intact", async () => {
    const cloud = await bootCloud({ limits: { storageMb: 1 } });
    try {
      const owner = await signUp(cloud);
      const b = owner.browser;
      expect((await b.post("/api/v1/import", { data: createSampleDocument() })).status).toBe(200);
      let status = 0;
      for (let i = 0; i < 40 && status !== 507; i++) {
        const items = Array.from({ length: 400 }, (_, j) => ({
          date: new Date(Date.UTC(1900, 0, 1) + (i * 400 + j) * 86_400_000)
            .toISOString()
            .slice(0, 10),
          netWorth: 1,
          assets: 1,
          liabilities: 0,
          note: `n${i}-${j}-${"x".repeat(400)}`,
        }));
        const r = await b.post("/api/v1/households/hh-sample/snapshots/bulk", {
          items,
          onConflict: "replace",
        });
        status = r.status;
        if (status === 507) expect(r.json.error.code).toBe("STORAGE_QUOTA_EXCEEDED");
      }
      expect(status).toBe(507);
      const ok = await cloud.rt.registry.with(owner.accountId as string, (r) => {
        const raw = (r.db as unknown as { $client: import("better-sqlite3").Database }).$client;
        return raw.pragma("integrity_check", { simple: true });
      });
      expect(ok).toBe("ok");
      expect((await b.get("/api/v1/households/hh-sample")).status).toBe(200);
    } finally {
      await cloud.close();
    }
  }, 120_000);
});
