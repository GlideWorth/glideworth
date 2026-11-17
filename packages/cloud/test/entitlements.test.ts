/**
 * Entitlements, read-only effects, quotas, the fair thread gate and the scheduler (spec 4.4, 6.1).
 */
import { existsSync } from "node:fs";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { accounts, subscriptions, tenantSchedules } from "../src/control/schema.js";
import { capScopes } from "../src/entitlements.js";
import { CloudError } from "../src/errors.js";
import { fairThreadGate } from "../src/jobs/fair-gate.js";
import {
  type Cloud,
  type FakeRuntime,
  makeCloud,
  mintKeyIn,
  removeTempDirs,
  SENTINEL_HOUSEHOLD,
  signedUpBrowser,
  startTrial,
} from "./cloud-fixture.js";

let cloud: Cloud;
beforeEach(async () => {
  cloud = await makeCloud();
});
afterEach(async () => {
  await cloud.close();
  removeTempDirs();
});

const DAY = 86_400_000;
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof CloudError) return e.code;
    throw e;
  }
  return undefined;
};
const setSub = (id: string, patch: Partial<typeof subscriptions.$inferInsert>) =>
  cloud.db.update(subscriptions).set(patch).where(eq(subscriptions.accountId, id)).run();

describe("entitlements (one function)", () => {
  it("follows the subscription state machine and the account status", async () => {
    const { accountId, browser } = await signedUpBrowser(cloud, { trial: false });
    const id = accountId as string;
    const e = () => cloud.entitlements.get(id);
    // No access before Checkout, however long the workspace has existed.
    expect(e()).toMatchObject({ level: "read_only", reason: "no_subscription", mcpWrites: false });
    expect(e().limits.editors).toBe(2);
    cloud.advance(3 * DAY);
    expect(e()).toMatchObject({ level: "read_only", reason: "no_subscription" });
    await startTrial(cloud, browser);
    expect(e()).toMatchObject({ level: "full", reason: "trial", changesAt: null });
    expect(Date.parse(e().trialEndsAt ?? "") - cloud.now().getTime()).toBeGreaterThan(
      7 * DAY - 1000,
    );
    setSub(id, { status: "active" });
    expect(e()).toMatchObject({ level: "full", reason: "active" });
    setSub(id, { status: "past_due", pastDueSince: cloud.now().toISOString() });
    expect(e()).toMatchObject({ level: "full", reason: "past_due_grace" });
    cloud.advance(15 * DAY);
    expect(e()).toMatchObject({ level: "read_only", reason: "past_due" });
    setSub(id, { compedUntil: new Date(cloud.now().getTime() + DAY).toISOString() });
    expect(e()).toMatchObject({ level: "full", reason: "comped" });
    cloud.db.update(accounts).set({ status: "suspended" }).where(eq(accounts.id, id)).run();
    expect(e()).toMatchObject({ level: "suspended", reason: "suspended" });
    expect(cloud.entitlements.get("taaaaaaaaaaaaaaa").level).toBe("suspended");
    expect(cloud.entitlements.get("../x").level).toBe("suspended");
  });

  it("a second sign-up of the same address gets no second trial: Checkout charges at once", async () => {
    const first = await signedUpBrowser(cloud);
    // The first owner deletes the account; the address signs up again.
    await first.browser.post("/api/v1/auth/reauth", { password: first.password });
    expect((await first.browser.del("/api/v1/account")).status).toBe(204);
    const again = await signedUpBrowser(cloud, { email: first.email, trial: false });
    expect(cloud.entitlements.get(again.accountId as string)).toMatchObject({
      level: "read_only",
      reason: "no_subscription",
    });
    const billing = await again.browser.get("/api/v1/billing");
    expect(billing.body).toMatchObject({ trialDays: null, access: { reason: "no_subscription" } });
    const r = await again.browser.post("/api/v1/billing/checkout", {
      lookupKey: "cloud_monthly_v1",
    });
    expect(r.status).toBe(200);
    const sessionId = String(r.body.url).split("/").at(-1) as string;
    expect(cloud.fake.sessions.get(sessionId)?.params).toMatchObject({ trialPeriodDays: null });
  });

  it("a new owner gets no access before Checkout: plan routes 402, keys capped to nothing, billing open", async () => {
    const { accountId, browser } = await signedUpBrowser(cloud, { trial: false });
    const id = accountId as string;
    const rt = await cloud.registry.with(id, (r) => r as FakeRuntime);
    const key = mintKeyIn(rt);
    // The session keeps no scope at all (the real routes then answer 402 even for reads: apps/api tests).
    const who = await browser.get("/api/v1/whoami");
    expect(who.body.principal).toMatchObject({ scopes: [], limitedBy: "entitlement" });
    const write = await browser.post("/api/v1/households", { id: "hh_1", name: "A", netWorth: 1 });
    expect(write.status).toBe(402);
    expect(write.body).toMatchObject({
      error: { code: "ACCOUNT_READ_ONLY", details: { reason: "no_subscription" } },
    });
    const viaKey = await cloud.app.request("/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${key}` },
    });
    expect(((await viaKey.json()) as { scopes: string[] }).scopes).toEqual([]);
    expect(code(() => cloud.policy(id).admitJob("montecarlo"))).toBe("ACCOUNT_READ_ONLY");
    const billing = await browser.get("/api/v1/billing");
    expect(billing.status).toBe(200);
    expect(billing.body).toMatchObject({ trialDays: 7, status: "trialing_local" });
    // The first Checkout asks Stripe for the 7-day trial; completing it gives full access.
    await startTrial(cloud, browser);
    const session = [...cloud.fake.sessions.values()].at(-1);
    expect(session?.params).toMatchObject({ trialPeriodDays: 7 });
    const after = await browser.post("/api/v1/households", { id: "hh_1", name: "A", netWorth: 1 });
    expect(after.status).toBe(201);
    expect(cloud.entitlements.get(id)).toMatchObject({ level: "full", reason: "trial" });
  });

  it("capScopes: full keeps everything, read-only keeps read+simulate, suspended and never-subscribed keep nothing", () => {
    const base = {
      accountId: "t",
      limits: {} as never,
      mcpWrites: false,
      trialEndsAt: null,
      changesAt: null,
    };
    const all = ["read", "simulate", "write"] as const;
    expect(capScopes(all, { ...base, level: "full", reason: "active" })).toEqual({
      scopes: [...all],
      limited: false,
    });
    expect(capScopes(all, { ...base, level: "read_only", reason: "canceled" })).toEqual({
      scopes: ["read", "simulate"],
      limited: true,
    });
    expect(capScopes(all, { ...base, level: "suspended", reason: "suspended" })).toEqual({
      scopes: [],
      limited: true,
    });
    // Never subscribed (no trial started yet): nothing either.
    expect(capScopes(all, { ...base, level: "read_only", reason: "no_subscription" })).toEqual({
      scopes: [],
      limited: true,
    });
  });
});

describe("read-only mode", () => {
  it("caps REST and MCP scopes, refuses jobs, pauses scheduler and webhooks, and deletes nothing", async () => {
    const { accountId, browser } = await signedUpBrowser(cloud);
    const id = accountId as string;
    const rt = await cloud.registry.with(id, (r) => r as FakeRuntime);
    rt.addHousehold("hh_1", SENTINEL_HOUSEHOLD, 1);
    const key = mintKeyIn(rt);
    cloud.scheduler.scheduleChanged(id, cloud.now().toISOString());
    const policy = cloud.policy(id);
    // Full access first.
    expect(
      (await browser.post("/api/v1/households", { id: "hh_2", name: "B", netWorth: 2 })).status,
    ).toBe(201);
    expect(code(() => policy.admitJob("montecarlo", { trials: 1000 }))).toBeUndefined();
    expect(policy.webhooksSuppressed()).toBe(false);
    expect(policy.admitWebhookDelivery()).toBe(true);

    setSub(id, { status: "canceled" }); // the trial was cancelled and has ended
    const write = await browser.post("/api/v1/households", { id: "hh_3", name: "C", netWorth: 3 });
    expect(write.status).toBe(402);
    expect(write.body).toMatchObject({
      error: { code: "ACCOUNT_READ_ONLY", details: { reason: "canceled" } },
    });
    const viaKey = await cloud.app.request("/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${key}` },
    });
    expect(((await viaKey.json()) as { scopes: string[] }).scopes).toEqual(["read"]);
    expect((await browser.get("/api/v1/households")).status).toBe(200); // reads still work
    expect(code(() => policy.admitJob("montecarlo"))).toBe("ACCOUNT_READ_ONLY");
    expect(policy.webhooksSuppressed()).toBe(true);
    expect(policy.admitWebhookDelivery()).toBe(false);
    expect(policy.schedulerEnabled()).toBe(false);
    cloud.scheduled.length = 0;
    await cloud.scheduler.tick();
    expect(cloud.scheduled).toEqual([]);
    // Cloud routes (billing, export) are unaffected; nothing was deleted.
    expect((await browser.get("/api/v1/billing")).status).toBe(200);
    expect(existsSync(cloud.registry.pathFor(id))).toBe(true);
    expect(rt.households().map((h) => h.id)).toEqual(["hh_1", "hh_2"]);
    expect(cloud.db.select().from(accounts).where(eq(accounts.id, id)).get()?.status).toBe(
      "active",
    );
  });

  it("job admission: plan trial limit, jobs per day, worker time per day", async () => {
    const { accountId } = await signedUpBrowser(cloud);
    const id = accountId as string;
    const p = cloud.policy(id);
    const l = cloud.entitlements.get(id).limits;
    expect(code(() => p.admitJob("mc", { trials: l.maxMonteCarloTrials + 1 }))).toBe("VALIDATION");
    for (let i = 0; i < l.jobsPerDay; i++) p.admitJob("mc");
    expect(code(() => p.admitJob("mc"))).toBe("QUOTA_EXCEEDED");
    cloud.advance(DAY);
    expect(code(() => p.admitJob("mc"))).toBeUndefined();
    p.recordWorkerMs(l.workerSecondsPerDay * 1000);
    expect(code(() => p.admitJob("mc"))).toBe("QUOTA_EXCEEDED");
    expect(p.jobLimits()).toEqual({ concurrent: 1, queued: 10 });
    expect(p.maxJobMs()).toBe(300_000);
  });
});

describe("quotas", () => {
  it("per metric, per workspace, per UTC day; resetsAt is the next midnight", async () => {
    const a = (await signedUpBrowser(cloud)).accountId as string;
    const b = (await signedUpBrowser(cloud)).accountId as string;
    const limit = cloud.entitlements.get(a).limits.shareReadsPerDay;
    cloud.quotas.admit(a, "share_read", limit);
    let err: CloudError | null = null;
    try {
      cloud.quotas.admit(a, "share_read");
    } catch (e) {
      err = e as CloudError;
    }
    expect(err?.code).toBe("QUOTA_EXCEEDED");
    expect(err?.details).toMatchObject({ metric: "share_read" });
    expect(String(err?.details?.resetsAt)).toMatch(/T00:00:00.000Z$/);
    expect(code(() => cloud.quotas.admit(b, "share_read"))).toBeUndefined();
    expect(cloud.quotas.usage(a).share_read).toBe(limit);
    expect(cloud.quotas.usage(b).share_read).toBe(1);
    cloud.advance(DAY);
    expect(code(() => cloud.quotas.admit(a, "share_read"))).toBeUndefined();
    cloud.quotas.record(a, "worker_ms", 1234.6);
    expect(cloud.quotas.usage(a).worker_ms).toBe(1235);
  });

  it("a share-link read quota is enforced through the policy hook", async () => {
    const id = (await signedUpBrowser(cloud)).accountId as string;
    const p = cloud.policy(id);
    const l = cloud.entitlements.get(id).limits.shareReadsPerDay;
    cloud.quotas.admit(id, "share_read", l);
    expect(code(() => p.admitShareRead())).toBe("QUOTA_EXCEEDED");
  });
});

describe("storage limit", () => {
  it("a write past the plan’s storage is refused (507) and the database stays intact", async () => {
    const { accountId, browser } = await signedUpBrowser(cloud);
    const id = accountId as string;
    await cloud.registry.close(id);
    // A 1 MiB plan for this test: the handle's max_page_count is set from limits.storageMb on open.
    const limitsOf = cloud.registry.options.limitsOf;
    (cloud.registry.options as { limitsOf: typeof limitsOf }).limitsOf = (a) => ({
      ...limitsOf(a),
      storageMb: 1,
    });
    const big = "x".repeat(200_000);
    let status = 0;
    for (let i = 0; i < 20 && status !== 507; i++)
      status = (await browser.post("/api/v1/households", { id: `h${i}`, name: big, netWorth: 1 }))
        .status;
    expect(status).toBe(507);
    const r = await browser.post("/api/v1/households", { id: "hx", name: big, netWorth: 1 });
    expect(r.body).toMatchObject({ error: { code: "STORAGE_QUOTA_EXCEEDED" } });
    const { checkIntegrity } = await import("../src/tenancy/sqlite-tools.js");
    await cloud.registry.close(id);
    expect(checkIntegrity(cloud.registry.pathFor(id))).toBe(true);
    (cloud.registry.options as { limitsOf: typeof limitsOf }).limitsOf = limitsOf;
  });
});

describe("fair thread gate", () => {
  it("never runs more than maxThreads, and hands free slots round-robin across workspaces", async () => {
    const gate = fairThreadGate({ maxThreads: 2 });
    const order: string[] = [];
    const releases: Array<() => void> = [];
    const take = (acct: string, tag: string) =>
      gate.acquire(acct).then((r) => {
        order.push(tag);
        releases.push(r);
      });
    const all = [
      take("ta", "a1"),
      take("ta", "a2"),
      take("ta", "a3"),
      take("ta", "a4"),
      take("tb", "b1"),
      take("tc", "c1"),
      take("tb", "b2"),
    ];
    await new Promise((r) => setImmediate(r));
    expect(order).toEqual(["a1", "a2"]);
    expect(gate.stats()).toEqual({ running: 2, waiting: { ta: 2, tb: 2, tc: 1 } });
    while (releases.length) {
      (releases.shift() as () => void)();
      await new Promise((r) => setImmediate(r));
    }
    await Promise.all(all);
    // After A's first two, the queue rotates: A, B, C, A, B (A had waited longest).
    expect(order).toEqual(["a1", "a2", "a3", "b1", "c1", "a4", "b2"]);
    expect(gate.stats().running).toBe(0);
  });

  it("bounds each workspace’s wait queue", async () => {
    const gate = fairThreadGate({ maxThreads: 1, maxWaitingPerAccount: 2 });
    const r = await gate.acquire("ta");
    void gate.acquire("ta");
    void gate.acquire("ta");
    await expect(gate.acquire("ta")).rejects.toMatchObject({ code: "RATE_LIMITED" });
    r();
  });
});

describe("scheduler", () => {
  it("runs due, active, full-access workspaces only, records the next run, backs off on failure", async () => {
    const a = (await signedUpBrowser(cloud)).accountId as string;
    const b = (await signedUpBrowser(cloud)).accountId as string;
    const c = (await signedUpBrowser(cloud)).accountId as string;
    const past = new Date(cloud.now().getTime() - 1000).toISOString();
    cloud.scheduler.scheduleChanged(a, past);
    cloud.scheduler.scheduleChanged(b, new Date(cloud.now().getTime() + 3600_000).toISOString());
    cloud.scheduler.scheduleChanged(c, past);
    cloud.db.update(accounts).set({ status: "suspended" }).where(eq(accounts.id, c)).run();
    await cloud.scheduler.tick();
    expect(cloud.scheduled).toEqual([a]);
    const row = cloud.db
      .select()
      .from(tenantSchedules)
      .where(eq(tenantSchedules.accountId, a))
      .get();
    expect(row?.lastCheckinAt).toBeTruthy();
    expect(Date.parse(row?.nextCheckinAt as string)).toBeGreaterThan(cloud.now().getTime());
    // A failing run backs off and counts failures.
    cloud.scheduler.scheduleChanged(b, past);
    await cloud.registry.close(b);
    cloud.opener.failNext = { migration: "NOT SQL" };
    await cloud.scheduler.tick();
    const rb = cloud.db
      .select()
      .from(tenantSchedules)
      .where(eq(tenantSchedules.accountId, b))
      .get();
    expect(rb?.consecutiveFailures).toBe(1);
    expect(Date.parse(rb?.nextCheckinAt as string)).toBeGreaterThan(cloud.now().getTime());
    // The tenant is now migration_failed and is not scheduled again until it is fixed.
    expect(cloud.db.select().from(accounts).where(eq(accounts.id, b)).get()?.status).toBe(
      "migration_failed",
    );
    cloud.advance(2 * 3600_000);
    cloud.scheduled.length = 0;
    await cloud.scheduler.tick();
    expect(cloud.scheduled).not.toContain(b);
  });
});
