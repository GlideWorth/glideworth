/**
 * T-AUTH / T-BILL at the app level (design section 10): what the cloud package's own tests cannot reach.
 *
 * A read-only workspace (free trial cancelled, never paid): every write route enumerated from `/openapi.json`
 * (`x-required-scope: write`) answers 402 ACCOUNT_READ_ONLY with the billing URL, except the routes declared
 * `x-allow-when-read-only`; MCP write tools are absent and job tools refuse; async jobs are refused while cached
 * results are still served; the scheduler skips the workspace; webhooks stay silent; reads and exports work;
 * nothing is deleted. A viewer cannot reach any write route either. Subscribing (fake Checkout completed through
 * a correctly signed webhook) restores writes. Suspension: 403 ACCOUNT_SUSPENDED for sessions, 401 for keys.
 */
import { controlSchema } from "@glideworth/cloud";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  bootCloud,
  Client,
  type Cloud,
  PUBLIC_URL,
  reauth,
  signUp,
  startTrial,
  uniqueEmail,
  WEBHOOK_SECRET,
  lastMail,
  tokenIn,
} from "./cloud-harness.js";
import { seedWorkspace, type Workspace } from "./cloud-workspaces.js";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

let cloud: Cloud;
let W: Workspace;
const deliveries: string[] = [];

beforeAll(async () => {
  cloud = await bootCloud({
    fetch: (async (url: string | URL | Request) => {
      deliveries.push(String(url));
      return new Response("ok");
    }) as typeof fetch,
  });
  W = await seedWorkspace(cloud, "Ostrava", 612034.18);
  await reauth(W.owner.browser);
  await W.owner.browser.patch("/api/v1/workspace/settings", { mcpWrites: true });
}, 120_000);
afterAll(() => cloud?.close(), 120_000);

type Op = { method: string; path: string; op: Record<string, unknown> };
const writeOps = async (): Promise<Op[]> => {
  const doc = (await (await fetch(`${cloud.base}/openapi.json`)).json()) as {
    paths: Record<string, Record<string, Record<string, unknown>>>;
  };
  const out: Op[] = [];
  for (const [path, item] of Object.entries(doc.paths))
    for (const [method, op] of Object.entries(item))
      if (op["x-required-scope"] === "write") out.push({ method, path, op });
  return out;
};
const fill = (path: string) =>
  path.replace(/\{(\w+)\}/g, (_, n: string) =>
    n === "id" && path.startsWith("/api/v1/plans/")
      ? "plan-main"
      : n === "id" && path.startsWith("/api/v1/households/")
        ? "hh-sample"
        : n === "version"
          ? "1"
          : "missing-id",
  );

const counts = async (accountId: string) =>
  cloud.rt.registry.with(
    accountId,
    (r) => {
      const raw = (r.db as unknown as { $client: import("better-sqlite3").Database }).$client;
      const out: Record<string, number> = {};
      for (const t of [
        "households",
        "plans",
        "plan_versions",
        "progress_snapshots",
        "webhooks",
        "share_links",
        "api_keys",
        "users",
        "change_sets",
        "notifications",
        "oauth_tokens",
      ])
        out[t] = (raw.prepare(`SELECT count(*) AS n FROM "${t}"`).get() as { n: number }).n;
      return out;
    },
    { allowSuspended: true },
  );

/** The owner cancels the free trial in Stripe before its first charge (delivered through the signed webhook). */
const cancelTrial = async () => {
  const subId = cloud.rt.db
    .select({ id: controlSchema.subscriptions.stripeSubscriptionId })
    .from(controlSchema.subscriptions)
    .where(eq(controlSchema.subscriptions.accountId, W.accountId))
    .get()?.id as string;
  const ev = cloud.gateway.setSubscription(subId, { status: "canceled" });
  const signed = cloud.gateway.sign(ev, WEBHOOK_SECRET);
  const r = await new Client(cloud).req("POST", "/stripe/webhook", {
    raw: signed.body,
    headers: { "stripe-signature": signed.header, "content-type": "application/json" },
  });
  expect(r.status, r.text).toBe(200);
};

describe("a viewer", () => {
  it("cannot reach any write route (enumerated from OpenAPI x-required-scope)", async () => {
    const viewer = W.viewer.browser;
    const ops = await writeOps();
    expect(ops.length).toBeGreaterThan(100);
    for (const o of ops) {
      const r = await viewer.req(
        o.method.toUpperCase(),
        fill(o.path),
        o.method === "get" ? {} : { body: {} },
      );
      expect(r.status, `${o.method} ${o.path}: ${r.text.slice(0, 120)}`).toBe(403);
    }
  });
});

describe("before the trial starts (no card yet)", () => {
  it("a new owner has no access to plans, only to billing, account and invitations, until Checkout", async () => {
    const me = await signUp(cloud, { name: "Not Started", trial: false });
    const b = me.browser;
    const st = await b.get("/api/v1/auth/status");
    expect(st.json.workspace.access).toMatchObject({
      level: "read_only",
      reason: "no_subscription",
    });
    for (const path of ["/api/v1/households", "/api/v1/plans"]) {
      const r = await b.get(path);
      expect(r.status, path).toBe(402);
      expect(r.json.error).toMatchObject({
        code: "ACCOUNT_READ_ONLY",
        details: { reason: "no_subscription", billingUrl: `${PUBLIC_URL}/settings/billing` },
      });
    }
    const billing = await b.get("/api/v1/billing");
    expect(billing.status).toBe(200);
    expect(billing.json).toMatchObject({ trialDays: 7, status: "trialing_local" });

    // Invited elsewhere meanwhile: accepting needs no card, and the inviting workspace is fully usable.
    const inv = await W.owner.browser.post("/api/v1/workspace/invitations", {
      email: me.email,
      role: "editor",
    });
    expect([200, 201]).toContain(inv.status);
    await cloud.rt.outbox.drain();
    const mail = lastMail(cloud, me.email, "invitation");
    const acc = await b.post("/api/v1/workspace/invitations/accept", {
      token: tokenIn(mail?.text ?? ""),
    });
    expect(acc.status, acc.text).toBe(200);
    expect((await b.post(`/api/v1/workspaces/${W.accountId}/activate`, {})).status).toBeLessThan(
      300,
    );
    expect((await b.get("/api/v1/households")).status).toBe(200);
    // Back in their own workspace: still nothing until they start its own trial.
    expect((await b.post(`/api/v1/workspaces/${me.accountId}/activate`, {})).status).toBeLessThan(
      300,
    );
    expect((await b.get("/api/v1/households")).status).toBe(402);
    await startTrial(cloud, b);
    expect((await b.get("/api/v1/households")).status).toBe(200);
    const trial = await b.get("/api/v1/billing");
    expect(trial.json).toMatchObject({
      status: "trialing",
      trialDays: null,
      access: { level: "full", reason: "trial" },
    });
  });

  it("an invitee who signs up from the invitation joins the workspace and never sees a trial", async () => {
    // seedWorkspace's editor and viewer signed up from invitations: no workspace of their own, full access here.
    const st = await W.editor.browser.get("/api/v1/auth/status");
    expect(st.json.workspace).toMatchObject({ id: W.accountId, access: { level: "full" } });
    expect(st.json.workspaces).toHaveLength(1);
    expect((await W.editor.browser.get("/api/v1/households")).status).toBe(200);
    const fresh = uniqueEmail("invitee");
    await W.owner.browser.post("/api/v1/workspace/invitations", { email: fresh, role: "viewer" });
    const joined = await signUp(cloud, { email: fresh });
    expect(joined.accountId).toBeNull(); // no workspace, no Checkout
  });
});

describe("a read-only workspace (trial cancelled, never paid)", () => {
  let cachedBody = "";
  beforeAll(async () => {
    // A cached Monte Carlo result from while the workspace was at full access.
    const k = new Client(cloud).withBearer(W.ownerKey);
    cachedBody = JSON.stringify({ settings: { trials: 100 } });
    const first = await k.post(
      "/api/v1/plans/plan-main/monte-carlo?wait=60",
      JSON.parse(cachedBody),
    );
    expect(first.json.status).toBe("succeeded");
    await cancelTrial();
    const st = await W.owner.browser.get("/api/v1/auth/status");
    expect(st.json.workspace.access.level).toBe("read_only");
  });

  it("answers 402 ACCOUNT_READ_ONLY on every write route except the exposure-reducing ones", async () => {
    const before = await counts(W.accountId);
    const ops = await writeOps();
    const k = new Client(cloud).withBearer(W.ownerKey);
    let allowed = 0;
    for (const o of ops)
      for (const client of [W.owner.browser, k]) {
        const r = await client.req(
          o.method.toUpperCase(),
          fill(o.path),
          o.method === "get" ? {} : { body: {} },
        );
        if (o.op["x-allow-when-read-only"]) {
          allowed++;
          expect(r.status, `${o.method} ${o.path}`).not.toBe(402);
          continue;
        }
        expect(r.status, `${o.method} ${o.path}: ${r.text.slice(0, 160)}`).toBe(402);
        expect(r.json.error.code).toBe("ACCOUNT_READ_ONLY");
        expect(r.json.error.details.billingUrl).toBe(`${PUBLIC_URL}/settings/billing`);
        expect(r.json.error.details.reason).toBe("canceled");
      }
    expect(allowed).toBe(8); // 4 routes x 2 credentials
    // Nothing deleted, nothing written.
    expect(await counts(W.accountId)).toEqual(before);
  });

  it("refuses new async jobs but still serves cached results; synchronous projections work", async () => {
    const k = new Client(cloud).withBearer(W.ownerKey);
    const cached = await k.post("/api/v1/plans/plan-main/monte-carlo", JSON.parse(cachedBody));
    expect(cached.status).toBe(200);
    expect(cached.json.cached).toBe(true);
    const fresh = await k.post("/api/v1/plans/plan-main/monte-carlo", {
      settings: { trials: 321 },
    });
    expect(fresh.status).toBe(402);
    expect(fresh.json.error.code).toBe("ACCOUNT_READ_ONLY");
    expect((await k.post("/api/v1/plans/plan-main/simulate", {})).status).toBe(200);
  });

  it("MCP: no write tools; job tools explain the read-only state", async () => {
    const mcp = (method: string, params: Record<string, unknown> = {}) =>
      new Client(cloud)
        .withBearer(W.oauth.access)
        .post(
          "/mcp",
          { jsonrpc: "2.0", id: 1, method, params },
          { headers: { accept: "application/json, text/event-stream" } },
        );
    const tools = (await mcp("tools/list")).json.result.tools as Array<{
      name: string;
      annotations?: { readOnlyHint?: boolean };
    }>;
    expect(tools.length).toBeGreaterThan(40);
    expect(tools.filter((t) => !t.annotations?.readOnlyHint)).toEqual([]);
    const mc = await mcp("tools/call", {
      name: "run_monte_carlo",
      arguments: { planId: "plan-main", trials: 333, wait: 0 },
    });
    expect(mc.text).toContain("ACCOUNT_READ_ONLY");
  });

  it("the scheduler skips the workspace and webhooks stay silent", async () => {
    let ran = 0;
    const runDue = cloud.host.runDue.bind(cloud.host);
    cloud.host.runDue = async (r) => {
      ran++;
      return runDue(r);
    };
    cloud.rt.scheduler.scheduleChanged(W.accountId, "2000-01-01T00:00:00.000Z");
    cloud.rt.scheduler.start();
    await new Promise((r) => setTimeout(r, 200));
    cloud.rt.scheduler.stop();
    await cloud.rt.scheduler.idle();
    cloud.host.runDue = runDue;
    expect(ran).toBe(0);
    deliveries.length = 0;
    await cloud.rt.registry.with(W.accountId, async (r) => {
      r.services.events.publish("plan.updated", { planId: "plan-main" } as never);
      await r.services.webhooks.flush();
    });
    expect(deliveries).toEqual([]);
  });

  it("reads and exports still work", async () => {
    const b = W.owner.browser;
    expect((await b.get("/api/v1/households")).status).toBe(200);
    expect((await b.get("/api/v1/households/hh-sample/export")).status).toBe(200);
    await reauth(b);
    const exp = await b.post("/api/v1/workspace/export", {});
    expect(exp.status, exp.text).toBe(202);
    await cloud.rt.outbox.drain();
    const dl = await b.get(`/api/v1/workspace/exports/${exp.json.exportId}`);
    expect(dl.status).toBe(200);
    expect(dl.headers.get("content-type")).not.toContain("json");
  });

  it("subscribing (fake Checkout, signed webhook) restores writes", async () => {
    const b = W.owner.browser;
    const co = await b.post("/api/v1/billing/checkout", { lookupKey: "cloud_monthly_v1" });
    expect(co.status, co.text).toBe(200);
    const sessionId = String(co.json.url).split("/").at(-1) as string;
    // The trial is used up: this Checkout charges at once.
    expect(cloud.gateway.sessions.get(sessionId)?.params).toMatchObject({ trialPeriodDays: null });
    for (const ev of cloud.gateway.completeCheckout(sessionId)) {
      const signed = cloud.gateway.sign(ev, WEBHOOK_SECRET);
      const r = await new Client(cloud).req("POST", "/stripe/webhook", {
        raw: signed.body,
        headers: { "stripe-signature": signed.header, "content-type": "application/json" },
      });
      expect(r.status, r.text).toBe(200);
    }
    const st = await b.get("/api/v1/auth/status");
    expect(st.json.workspace.access.level).toBe("full");
    const k = new Client(cloud).withBearer(W.ownerKey);
    expect(
      (await k.post("/api/v1/plans/plan-main/monte-carlo", { settings: { trials: 322 } })).status,
    ).toBeLessThan(300);
  });
});

describe("a suspended workspace", () => {
  it("answers 403 ACCOUNT_SUSPENDED to sessions and 401 to bearer credentials", async () => {
    cloud.rt.db
      .update(controlSchema.accounts)
      .set({ status: "suspended" })
      .where(eq(controlSchema.accounts.id, W.accountId))
      .run();
    try {
      const r = await W.owner.browser.get("/api/v1/households");
      expect(r.status).toBe(403);
      expect(r.json.error.code).toBe("ACCOUNT_SUSPENDED");
      expect(
        (await new Client(cloud).withBearer(W.ownerKey).get("/api/v1/households")).status,
      ).toBe(401);
      expect(await counts(W.accountId)).toMatchObject({ households: 2 });
    } finally {
      cloud.rt.db
        .update(controlSchema.accounts)
        .set({ status: "active" })
        .where(eq(controlSchema.accounts.id, W.accountId))
        .run();
    }
  });
});
