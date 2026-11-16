/**
 * T-ISO (design section 10): one customer can never reach another customer's data.
 *
 * The real cloud app (`start()` + this package's `cloudHost`) runs two fully populated workspaces, A and B. The
 * sweep reads `/openapi.json` and calls EVERY operation with B's browser session, B's API key and B's OAuth
 * access token, using A's resource ids in the path, the query and the body. No response may contain anything
 * of A's, A's database must be byte-for-byte unchanged afterwards, and every route under /api of the running
 * app must be in the document (so a new route cannot escape the sweep). Then the targeted cases of the design.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { controlSchema } from "@glideworth/cloud";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  bootCloud,
  Client,
  type Cloud,
  oauthTokens,
  PASSWORD,
  PUBLIC_URL,
  reauth,
  type Res,
  signUp,
} from "./cloud-harness.js";
import { dumpTenant, seedWorkspace, type Workspace } from "./cloud-workspaces.js";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

let cloud: Cloud;
let A: Workspace;
let B: Workspace;
const deliveries: Array<{ url: string; workspace: string | null; body: string }> = [];

/**
 * "Sign in with Google" is switched on so its routes are part of the sweep. The OpenID client talks to this
 * stand-in provider only (discovery; nothing else is reached by the sweep, which never completes a flow).
 */
const FAKE_ISSUER = "https://oidc.fake-google.test";
const fakeOidc = (async (url: string | URL | Request) => {
  if (String(url) === `${FAKE_ISSUER}/.well-known/openid-configuration`)
    return Response.json({
      issuer: FAKE_ISSUER,
      authorization_endpoint: `${FAKE_ISSUER}/o/oauth2/v2/auth`,
      token_endpoint: `${FAKE_ISSUER}/token`,
      jwks_uri: `${FAKE_ISSUER}/certs`,
      id_token_signing_alg_values_supported: ["RS256"],
      code_challenge_methods_supported: ["S256"],
    });
  return new Response("{}", { status: 404 });
}) as typeof fetch;

beforeAll(async () => {
  cloud = await bootCloud({
    env: {
      GLIDEWORTH_GOOGLE_CLIENT_ID: "isolation-test.apps.googleusercontent.com",
      GLIDEWORTH_GOOGLE_CLIENT_SECRET: "GOCSPX-isolation-test-secret",
      GLIDEWORTH_GOOGLE_ISSUER: FAKE_ISSUER,
    },
    oidcFetch: fakeOidc,
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      const h = new Headers(init?.headers);
      deliveries.push({
        url: String(url),
        workspace: h.get("x-glideworth-workspace"),
        body: String(init?.body ?? ""),
      });
      return new Response("ok", { status: 200 });
    }) as typeof fetch,
  });
  A = await seedWorkspace(cloud, "Zephyrine", 918273.64);
  B = await seedWorkspace(cloud, "Quillon", 503112.27);
}, 120_000);
afterAll(async () => {
  await cloud?.close();
}, 120_000);

// ------------------------------------------------------------------------------------------------ helpers
type Op = { method: string; path: string; op: Record<string, unknown> };

function operations(doc: Record<string, unknown>): Op[] {
  const out: Op[] = [];
  for (const [path, item] of Object.entries(doc.paths as Record<string, Record<string, unknown>>))
    for (const method of ["get", "post", "put", "patch", "delete"])
      if (item[method]) out.push({ method, path, op: item[method] as Record<string, unknown> });
  return out;
}

/** A's id for each path parameter, by the segment before it. Unknown contexts fail the sweep. */
function paramFor(path: string, name: string): string {
  const segs = path.split("/");
  const i = segs.indexOf(`{${name}}`);
  const before = segs[i - 1] ?? "";
  const key = `${before}/{${name}}`;
  const table: Record<string, string> = {
    "households/{id}": A.ids.household,
    "plans/{id}": A.ids.plan,
    "change-sets/{id}": A.ids.changeSet,
    "jobs/{id}": A.ids.job,
    "keys/{id}": A.ids.ownerKeyId,
    "webhooks/{id}": A.ids.webhook,
    "share-links/{id}": A.ids.shareLink,
    "snapshots/{snapId}": A.ids.snapshot,
    "oauth-grants/{grantId}": A.ids.grant,
    "clients/{id}": A.ids.oauthClient,
    "workspaces/{id}": A.accountId,
    "members/{userId}": A.ids.editorUserId,
    "invitations/{id}": A.ids.invitation,
    "exports/{id}": A.ids.exportId,
    "support-grants/{id}": A.ids.supportGrant,
    "sessions/{id}": A.ids.session,
    "users/{id}": A.ids.editorTenantUserId || "usr_aaaaaaaaaaaaaaaa",
    // Item ids inside a plan or household: the containing id is A's, so these never resolve in B.
    "people/{personId}": "p-avery",
    "dependents/{dependentId}": "d-1",
    "accounts/{itemId}": "acct-1",
    "real-assets/{itemId}": "ra-1",
    "debts/{itemId}": "debt-1",
    "income/{itemId}": "salary",
    "expenses/{itemId}": "living",
    "milestones/{itemId}": "fi",
    "flows/{itemId}": "flow-1",
    "planned-accounts/{itemId}": "pa-1",
    "planned-real-assets/{itemId}": "pra-1",
    "residency/{itemId}": "res-1",
    // Not workspace data: reference tables and enumerations.
    "versions/{version}": "1",
    "reorder/{collection}": "accounts",
    "scenarios/{templateId}": "retire-early",
    "tables/{table}": "years",
    "fx-rates/{pair}": "EUR-USD",
    "non-resident-rules/{country}": "GB",
    "treaties/{a}": "GB",
    "{a}/{b}": "US",
    // Public share link: A's token with B's account id swapped in (the real token is A's own credential).
    "shared/{token}": A.ids.shareToken.replace(A.accountId, B.accountId),
  };
  const v = table[key];
  if (v === undefined) throw new Error(`no A id for path parameter ${key} of ${path}`);
  return v;
}

/** A minimal body for a JSON schema, with A's ids wherever an id field is named. */
function bodyFor(schema: unknown, doc: Record<string, unknown>, depth = 0): unknown {
  const s = schema as Record<string, unknown> | undefined;
  if (!s || depth > 6) return undefined;
  if (typeof s.$ref === "string") {
    const name = s.$ref.split("/").pop() as string;
    return bodyFor(
      (doc.components as { schemas: Record<string, unknown> }).schemas[name],
      doc,
      depth + 1,
    );
  }
  if (Array.isArray(s.anyOf ?? s.oneOf ?? s.allOf))
    return bodyFor(((s.anyOf ?? s.oneOf ?? s.allOf) as unknown[])[0], doc, depth + 1);
  if (s.default !== undefined) return s.default;
  if (Array.isArray(s.enum)) return s.enum[0];
  if (s.const !== undefined) return s.const;
  switch (s.type) {
    case "object": {
      const out: Record<string, unknown> = {};
      const props = (s.properties ?? {}) as Record<string, unknown>;
      for (const name of (s.required as string[] | undefined) ?? Object.keys(props).slice(0, 4)) {
        if (/^(planId|basePlanId|otherPlanId)$/.test(name)) out[name] = A.ids.plan;
        else if (name === "planIds") out[name] = [A.ids.plan, "plan-main"];
        else if (name === "householdId") out[name] = A.ids.household;
        else if (name === "userId") out[name] = A.ids.editorUserId;
        else if (name === "ids") out[name] = [A.ids.notification ?? A.ids.job];
        else out[name] = bodyFor(props[name], doc, depth + 1);
      }
      return out;
    }
    case "array":
      return [];
    case "string":
      return s.format === "uri" ? "https://hooks.example/x" : "x";
    case "integer":
    case "number":
      return typeof s.minimum === "number" ? s.minimum : 1;
    case "boolean":
      return true;
    default:
      return undefined;
  }
}

/** Operations that answer from the request alone (they never load the household or plan in the path). */
const NOT_READING_PATH_RESOURCE = [
  "/import/csv/analyze",
  // A list filtered by the plan id in the path: B's change sets for that id (there are none).
  "get /api/v1/plans/{id}/change-sets",
];

const SELF_DESTRUCTIVE = new Set([
  "post /api/v1/auth/signout",
  "delete /api/v1/account",
  "delete /api/v1/workspace",
  "post /api/v1/workspace/leave",
  "post /api/v1/workspace/transfer",
  "post /api/v1/account/sessions/revoke-others",
  "post /api/v1/account/password",
]);

/**
 * No A secret in the response, except an id the caller itself has sent: an error message may quote it back,
 * and B's own audit log records the ids of B's own (refused) requests. Names, figures, emails and
 * credentials of A are never sent by B, so they are checked without exception.
 */
let sentByB = "";
function assertNoneOfA(res: Res, what: string, sent = ""): void {
  sentByB += ` ${sent}`;
  for (const secret of A.secrets)
    if (res.text.includes(secret) && !sentByB.includes(secret))
      throw new Error(
        `${what}: response contains A's data (${secret.slice(0, 24)}…), ${res.status}`,
      );
}

/** Every route of the running app under /api (and /mcp) is in the OpenAPI document. */
function undocumentedRoutes(doc: Record<string, unknown>): string[] {
  const app = cloud.app() as { routes?: Array<{ method: string; path: string }> } | null;
  const documented = new Set(
    operations(doc).map((o) => `${o.method.toUpperCase()} ${o.path.replace(/\{(\w+)\}/g, ":$1")}`),
  );
  const out: string[] = [];
  for (const r of app?.routes ?? []) {
    if (!r.path.startsWith("/api/") || r.method === "ALL" || r.path.endsWith("*")) continue;
    if (!documented.has(`${r.method} ${r.path}`)) out.push(`${r.method} ${r.path}`);
  }
  return [...new Set(out)];
}

// ---------------------------------------------------------------------------------------------- targeted
describe("T-ISO targeted cases", () => {
  const mcp = (token: string, method: string, params: Record<string, unknown> = {}, id = 1) =>
    new Client(cloud)
      .withBearer(token)
      .post(
        "/mcp",
        { jsonrpc: "2.0", id, method, params },
        { headers: { accept: "application/json, text/event-stream" } },
      );

  it("MCP: every tool with A's ids answers from B only; defaults resolve to B", async () => {
    // B's owner turns MCP writes on so the write tools exist too.
    await reauth(B.owner.browser);
    expect(
      (await B.owner.browser.patch("/api/v1/workspace/settings", { mcpWrites: true })).status,
    ).toBe(200);
    const list = await mcp(B.oauth.access, "tools/list");
    const tools = list.json.result.tools as Array<{
      name: string;
      inputSchema: Record<string, unknown>;
    }>;
    expect(tools.length).toBeGreaterThanOrEqual(70);
    const before = await dumpTenant(cloud, A.accountId);
    for (const t of tools) {
      const props = (t.inputSchema.properties ?? {}) as Record<string, Record<string, unknown>>;
      const args: Record<string, unknown> = {};
      for (const name of (t.inputSchema.required as string[] | undefined) ?? []) {
        const p = props[name] ?? {};
        if (/plan/i.test(name)) args[name] = p.type === "array" ? [A.ids.plan] : A.ids.plan;
        else if (/household/i.test(name)) args[name] = A.ids.household;
        else if (/job/i.test(name)) args[name] = A.ids.job;
        else if (/changeSet|change_set/i.test(name)) args[name] = A.ids.changeSet;
        else if (/snapshot/i.test(name)) args[name] = A.ids.snapshot;
        else if (p.type === "string") args[name] = Array.isArray(p.enum) ? p.enum[0] : "x";
        else if (p.type === "number" || p.type === "integer") args[name] = 1;
        else if (p.type === "boolean") args[name] = false;
        else if (p.type === "array") args[name] = [];
        else args[name] = {};
      }
      if ("wait" in props) args.wait = 0;
      if ("waitSeconds" in props) args.waitSeconds = 0;
      const r = await mcp(B.oauth.access, "tools/call", { name: t.name, arguments: args });
      assertNoneOfA(r, `mcp ${t.name}`, JSON.stringify(args));
    }
    expect(await dumpTenant(cloud, A.accountId)).toBe(before);
    const summary = await mcp(B.oauth.access, "tools/call", {
      name: "get_plan_summary",
      arguments: {},
    });
    expect(summary.text).toContain("Quillon");
    expect(summary.text).not.toContain("Zephyrine");
  }, 300_000);

  it("jobs: A's job is invisible to B; a job of A never emits on B's stream", async () => {
    const bk = new Client(cloud).withBearer(B.ownerKey);
    for (const p of [
      `/api/v1/jobs/${A.ids.job}`,
      `/api/v1/jobs/${A.ids.job}/result`,
      `/api/v1/jobs/${A.ids.job}/events`,
    ])
      expect((await bk.get(p)).status).toBe(404);
    expect((await bk.post(`/api/v1/jobs/${A.ids.job}/cancel`, {})).status).toBe(404);
    const jobB = await bk.post("/api/v1/plans/plan-main/monte-carlo", {});
    const ak = new Client(cloud).withBearer(A.ownerKey);
    const [stream] = await Promise.all([
      bk.get(`/api/v1/jobs/${jobB.json.id}/events`),
      ak.post("/api/v1/plans/plan-main/monte-carlo?wait=5", {}),
    ]);
    expect(stream.status).toBe(200);
    const ids = [...stream.text.matchAll(/"id":"(job_[a-z0-9]+)"/g)].map((m) => m[1]);
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids)).toEqual(new Set([jobB.json.id]));
  });

  it("scheduler: A's due check-in writes only A's health history and mails only A's members", async () => {
    const ak = new Client(cloud).withBearer(A.ownerKey);
    const bk = new Client(cloud).withBearer(B.ownerKey);
    const healthB = (await bk.get("/api/v1/plans/plan-main/health")).json;
    await ak.patch("/api/v1/schedule", {
      enabled: true,
      intervalHours: 1,
      thresholds: { netWorthBehindPlan: 0.001, successRateDelta: 0.001 },
    });
    // Baseline, then make A fall behind its plan and make the schedule due.
    await cloud.rt.registry.with(A.accountId, (r) => r.services.checkins.runAll("manual"));
    const accts = (await ak.get("/api/v1/households/hh-sample/accounts")).json.items as Array<{
      id: string;
    }>;
    for (const acct of accts)
      await ak.patch(`/api/v1/households/hh-sample/accounts/${acct.id}`, { balance: 1 });
    cloud.transport.clear();
    await cloud.rt.registry.with(A.accountId, async (r) => {
      const raw = (r.db as unknown as { $client: import("better-sqlite3").Database }).$client;
      raw.prepare("UPDATE schedule_config SET last_run_at = ?").run("2000-01-01T00:00:00.000Z");
      await cloud.host.runDue(r);
    });
    await cloud.rt.outbox.drain();
    expect((await bk.get("/api/v1/plans/plan-main/health")).json).toEqual(healthB);
    const recipients = cloud.transport.sent.map((m) => m.to.email);
    expect(recipients.length).toBeGreaterThan(0);
    for (const to of recipients)
      expect([A.owner.email, A.editor.email, A.viewer.email]).toContain(to);
    for (const m of cloud.transport.sent) {
      expect(m.template).toBe("checkin-summary");
      // No figure, plan name or notification title in a check-in email (design 5.3).
      expect(m.text).not.toMatch(/Zephyrine|%|918|\$|€|£/);
      expect(m.subject).not.toMatch(/\d/);
    }
  }, 60_000);

  it("share links: swapped account ids and deleted or suspended workspaces are one 404", async () => {
    const anon = new Client(cloud);
    const good = await anon.get(`/api/v1/shared/${A.ids.shareToken}`);
    expect(good.status).toBe(200);
    const swapped = await anon.get(
      `/api/v1/shared/${A.ids.shareToken.replace(A.accountId, B.accountId)}`,
    );
    expect(swapped.status).toBe(404);
    const bodies = new Set<string>([swapped.text]);
    for (const t of [
      "gws_tzzzzzzzzzzzzzzz_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      A.ids.shareToken.slice(0, -1) + (A.ids.shareToken.endsWith("a") ? "b" : "a"),
      "glideworth_share_abc",
    ]) {
      const r = await anon.get(`/api/v1/shared/${t}`);
      expect(r.status).toBe(404);
      bodies.add(r.text);
    }
    // A third workspace, shared and then suspended, then deleted.
    const c = await seedWorkspace(cloud, "Marravel", 777001.5);
    expect((await anon.get(`/api/v1/shared/${c.ids.shareToken}`)).status).toBe(200);
    cloud.rt.db
      .update(controlSchema.accounts)
      .set({ status: "suspended" })
      .where(eq(controlSchema.accounts.id, c.accountId))
      .run();
    const susp = await anon.get(`/api/v1/shared/${c.ids.shareToken}`);
    expect(susp.status).toBe(404);
    bodies.add(susp.text);
    cloud.rt.db
      .update(controlSchema.accounts)
      .set({ status: "active" })
      .where(eq(controlSchema.accounts.id, c.accountId))
      .run();
    await reauth(c.owner.browser);
    const del = await c.owner.browser.del("/api/v1/workspace", {
      confirmName: (await c.owner.browser.get("/api/v1/workspace/settings")).json.name,
    });
    expect(del.status, del.text).toBeLessThan(300);
    const gone = await anon.get(`/api/v1/shared/${c.ids.shareToken}`);
    expect(gone.status).toBe(404);
    bodies.add(gone.text);
    expect(bodies.size).toBe(1);
    // Seeds a whole third workspace; about 20s on a laptop and over 60s on a shared CI runner.
  }, 180_000);

  it("OAuth: swapped codes and refresh tokens fail, consent needs membership, revoke never crosses", async () => {
    // A fresh grant in A; its code and refresh token with B's account id swapped in.
    const t = await oauthTokens(cloud, A.owner.browser, A.accountId);
    const anon = new Client(cloud);
    const swappedRefresh = t.refresh.replace(A.accountId, B.accountId);
    const r1 = await anon.req("POST", "/oauth/token", {
      form: { grant_type: "refresh_token", refresh_token: swappedRefresh, client_id: t.clientId },
    });
    expect(r1.status).toBe(400);
    expect(r1.json.error).toBe("invalid_grant");
    const r2 = await anon.req("POST", "/oauth/token", {
      form: {
        grant_type: "authorization_code",
        code: t.code.replace(A.accountId, B.accountId),
        client_id: t.clientId,
        redirect_uri: "http://127.0.0.1:9/callback",
        code_verifier: "x".repeat(43),
      },
    });
    expect(r2.status).toBe(400);
    // Revoking A's token with B's id swapped in is a no-op: A's token still works.
    await anon.req("POST", "/oauth/revoke", {
      form: { token: t.access.replace(A.accountId, B.accountId) },
    });
    expect((await mcp(t.access, "tools/list")).status).toBe(200);
    // An access token with the account id swapped is a 401 at /mcp and /api.
    expect((await mcp(t.access.replace(A.accountId, B.accountId), "tools/list")).status).toBe(401);
    // B's owner cannot consent on A's workspace.
    const page = await B.owner.browser.get(
      `/oauth/authorize?${new URLSearchParams({
        response_type: "code",
        client_id: t.clientId,
        redirect_uri: "http://127.0.0.1:9/callback",
        code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
        code_challenge_method: "S256",
        scope: "read",
        _r: "1",
      })}`,
    );
    const csrf = /name="csrf" value="([^"]+)"/.exec(page.text)?.[1] as string;
    expect(page.text).not.toContain(A.accountId);
    const approve = await B.owner.browser.req("POST", "/oauth/authorize", {
      form: {
        csrf,
        decision: "approve",
        workspace: A.accountId,
        grant: "read",
        client_id: t.clientId,
        redirect_uri: "http://127.0.0.1:9/callback",
        code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
        code_challenge_method: "S256",
        response_type: "code",
        scope: "read",
      },
    });
    expect(approve.status).toBe(400);
    expect(approve.headers.get("location")).toBeNull();
    // A client registered and consented by B exists in B only until A consents itself.
    const aClients = (await new Client(cloud).withBearer(A.ownerKey).get("/api/v1/oauth/clients"))
      .json.items as Array<{ id: string }>;
    expect(aClients.map((x) => x.id)).not.toContain(B.ids.oauthClient);
  });

  it("API keys: a key with another account id, or a colliding prefix in another workspace, is a 401", async () => {
    const swapped = A.ownerKey.replace(A.accountId, B.accountId);
    const r = await new Client(cloud).withBearer(swapped).get("/api/v1/households");
    expect(r.status).toBe(401);
    // Put a key row with A's prefix (and another secret's hash) into B: A's key with B's id still fails.
    const prefix = A.ownerKey.split("_")[2] as string;
    await cloud.rt.registry.with(B.accountId, (rb) => {
      const raw = (rb.db as unknown as { $client: import("better-sqlite3").Database }).$client;
      raw
        .prepare(
          "INSERT INTO api_keys (id, name, prefix, hash, scopes, user_id) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(
          `key_${prefix}`,
          "collision",
          prefix,
          "00".repeat(32),
          JSON.stringify(["read"]),
          "owner",
        );
    });
    expect((await new Client(cloud).withBearer(swapped).get("/api/v1/households")).status).toBe(
      401,
    );
    const own = await new Client(cloud).withBearer(A.ownerKey).get("/api/v1/households");
    expect(own.status).toBe(200);
    expect(own.text).toContain("Zephyrine");
    await cloud.rt.registry.with(B.accountId, (rb) => {
      const raw = (rb.db as unknown as { $client: import("better-sqlite3").Database }).$client;
      raw.prepare("DELETE FROM api_keys WHERE name = 'collision'").run();
    });
    // Other credential kinds are never bearer credentials.
    for (const tok of [A.oauth.refresh, A.ids.shareToken, `gwc_${A.accountId}_${"a".repeat(52)}`])
      expect((await new Client(cloud).withBearer(tok).get("/api/v1/households")).status).toBe(401);
  });

  it("webhooks: an event in A is delivered only to A's subscription, with A's workspace header", async () => {
    deliveries.length = 0;
    const ak = new Client(cloud).withBearer(A.ownerKey);
    const touched = await ak.patch(`/api/v1/plans/${A.ids.plan}`, [
      { op: "replace", path: "/name", value: "Zephyrine Touched" },
    ]);
    expect(touched.status, touched.text).toBe(200);
    await cloud.rt.registry.with(A.accountId, (r) => r.services.webhooks.flush());
    expect(deliveries.length).toBeGreaterThan(0);
    for (const d of deliveries) {
      expect(d.url).toContain("zephyrine");
      expect(d.workspace).toBe(A.accountId);
      expect(d.body).not.toContain("Quillon");
    }
    expect(
      (
        await new Client(cloud)
          .withBearer(B.ownerKey)
          .get(`/api/v1/webhooks/${A.ids.webhook}/deliveries`)
      ).status,
    ).toBe(404);
  });

  it("sessions: activating a foreign workspace is 403; a removed member loses session, keys and tokens at once", async () => {
    expect(
      (await B.owner.browser.post(`/api/v1/workspaces/${A.accountId}/activate`, {})).status,
    ).toBe(403);
    const ed = A.editor;
    const edToken = await oauthTokens(cloud, ed.browser, A.accountId, "read simulate");
    const edKey = new Client(cloud).withBearer(A.editorKey);
    expect((await edKey.get("/api/v1/households")).status).toBe(200);
    const rm = await A.owner.browser.del(`/api/v1/workspace/members/${A.ids.editorUserId}`);
    expect(rm.status, rm.text).toBeLessThan(300);
    expect([401, 403]).toContain((await ed.browser.get("/api/v1/households")).status);
    expect((await edKey.get("/api/v1/households")).status).toBe(401);
    expect((await mcp(edToken.access, "tools/list")).status).toBe(401);
  });

  it("quotas and rate limits are per workspace: exhausting A's never throttles B", async () => {
    const q = await bootCloud({ limits: { apiRequestsPerMinute: 30 } });
    try {
      const a = await signUp(q, { name: "Ana" });
      const b = await signUp(q, { name: "Ben" });
      let limited = 0;
      for (let i = 0; i < 40; i++)
        if ((await a.browser.get("/api/v1/households")).status === 429) limited++;
      expect(limited).toBeGreaterThan(0);
      expect((await b.browser.get("/api/v1/households")).status).toBe(200);
    } finally {
      await q.close();
    }
  }, 60_000);

  it("crafted account ids never reach the filesystem", async () => {
    const tenants = join(cloud.dataDir, "tenants");
    const list = () => JSON.stringify(readdirSync(tenants, { recursive: true }).sort());
    const before = list();
    const crafted = [
      "../x",
      "t../../../etc",
      "TAAAAAAAAAAAAAAA",
      "taaaaaaaaaaaaaaaa",
      "taaaaaaaaaaaaaa",
      "t1111111111111111",
      "%2e%2e%2fx",
    ];
    for (const id of crafted) {
      const secret = "a".repeat(52);
      expect(
        (
          await new Client(cloud)
            .withBearer(`gwk_${id}_aaaaaaaa_${secret}`)
            .get("/api/v1/households")
        ).status,
      ).toBe(401);
      expect(
        (await new Client(cloud).withBearer(`gwa_${id}_${secret}`).post("/mcp", {})).status,
      ).toBe(401);
      expect(
        (await new Client(cloud).get(`/api/v1/shared/gws_${encodeURIComponent(id)}_${secret}`))
          .status,
      ).toBe(404);
      expect([403, 404]).toContain(
        (await B.owner.browser.post(`/api/v1/workspaces/${encodeURIComponent(id)}/activate`, {}))
          .status,
      );
    }
    expect(list()).toBe(before);
  });

  it("export download: B cannot fetch A's export, and neither can a non-owner of A", async () => {
    expect([403, 404]).toContain(
      (await B.owner.browser.get(`/api/v1/workspace/exports/${A.ids.exportId}`)).status,
    );
    expect([403, 404]).toContain(
      (await A.viewer.browser.get(`/api/v1/workspace/exports/${A.ids.exportId}`)).status,
    );
    const own = await A.owner.browser.get(`/api/v1/workspace/exports/${A.ids.exportId}`);
    expect(own.status).toBe(200);
  });

  it("the OAuth issuer is the configured public URL, never the request's host", async () => {
    const r = await new Client(cloud).get("/.well-known/oauth-authorization-server", {
      headers: {
        host: "evil.example",
        "x-forwarded-host": "evil.example",
        "x-forwarded-proto": "https",
      },
    });
    expect(r.json.issuer).toBe(PUBLIC_URL);
    expect(r.text).not.toContain("evil.example");
  });
});

// ------------------------------------------------------------------------------------------------- sweep
// Last: the sweep ends with operations that act on B itself (sign-out, account deletion), which the targeted
// cases above must not see.
describe("T-ISO sweep: every operation, B's credentials, A's ids", () => {
  it("never returns A's data and never changes A", async () => {
    const doc = (await (await fetch(`${cloud.base}/openapi.json`)).json()) as Record<
      string,
      unknown
    >;
    const ops = operations(doc);
    expect(ops.length).toBeGreaterThan(250);
    // "Sign in with Google" is configured here, so its routes are swept too.
    for (const p of [
      "/api/v1/auth/google/start",
      "/api/v1/auth/google/callback",
      "/api/v1/account/identities/google",
    ])
      expect(ops.map((o) => o.path)).toContain(p);
    expect(undocumentedRoutes(doc)).toEqual([]);
    // Every parameter of every operation has an A id (a new route with a new parameter fails here).
    for (const o of ops)
      for (const m of o.path.matchAll(/\{(\w+)\}/g)) paramFor(o.path, m[1] as string);

    const before = await dumpTenant(cloud, A.accountId);
    const controlBefore = JSON.stringify(
      cloud.rt.db
        .select()
        .from(controlSchema.memberships)
        .where(eq(controlSchema.memberships.accountId, A.accountId))
        .all(),
    );

    const session = new Client(cloud);
    session.rotateIp = true;
    const signIn = async () => {
      session.jar.clear();
      const r = await session.post("/api/v1/auth/signin", {
        email: B.owner.email,
        password: PASSWORD,
        captchaToken: "captcha-ok",
      });
      expect(r.status, r.text).toBe(200);
    };
    await signIn();
    const key = new Client(cloud).withBearer(B.ownerKey);
    key.rotateIp = true;
    const oauth = new Client(cloud).withBearer(B.oauth.access);
    oauth.rotateIp = true;

    const ordered = [
      ...ops.filter((o) => !SELF_DESTRUCTIVE.has(`${o.method} ${o.path}`)),
      ...ops.filter((o) => SELF_DESTRUCTIVE.has(`${o.method} ${o.path}`)),
    ];
    const statuses = new Map<string, number[]>();
    const succeeded: string[] = [];
    for (const o of ordered) {
      const path = o.path.replace(/\{(\w+)\}/g, (_, n: string) =>
        encodeURIComponent(paramFor(o.path, n)),
      );
      const query = new URLSearchParams();
      for (const p of (o.op.parameters ?? []) as Array<{ name: string; in: string }>)
        if (p.in === "query" && /plan|household/i.test(p.name))
          query.set(p.name, /household/i.test(p.name) ? A.ids.household : A.ids.plan);
      const url = query.size ? `${path}?${query}` : path;
      const reqBody = (
        o.op.requestBody as { content?: Record<string, { schema?: unknown }> } | undefined
      )?.content?.["application/json"]?.schema;
      const body =
        o.method === "get" || o.method === "delete" ? undefined : (bodyFor(reqBody, doc) ?? {});
      for (const [label, client] of [
        ["session", session],
        ["key", key],
        ["oauth", oauth],
      ] as const) {
        if (label === "session") {
          const st = await session.get("/api/v1/auth/status");
          if (!st.json?.authenticated) await signIn();
        }
        const res = await client.req(
          o.method.toUpperCase(),
          url,
          body === undefined ? {} : { body },
        );
        assertNoneOfA(
          res,
          `${label} ${o.method.toUpperCase()} ${o.path}`,
          `${url} ${JSON.stringify(body ?? "")}`,
        );
        // A's ids in the path never resolve to anything: never a success on an A-only resource.
        if (/\{(id|snapId|grantId|userId|token)\}/.test(o.path) && res.status < 300) {
          const hit =
            o.path.includes("/shared/") || /\/(versions|scenarios|tables|fx-rates)\//.test(o.path);
          if (!hit && !/^\/api\/v1\/(non-resident-rules|treaties)/.test(o.path))
            succeeded.push(`${label} ${o.method} ${o.path} ${res.status}`);
        }
        const k = `${o.method} ${o.path}`;
        statuses.set(k, [...(statuses.get(k) ?? []), res.status]);
      }
    }
    expect(statuses.size).toBe(ops.length);
    // Operations that do not read the resource named in the path (pure analysis of the request body).
    expect(succeeded.filter((s) => !NOT_READING_PATH_RESOURCE.some((r) => s.includes(r)))).toEqual(
      [],
    );
    expect(await dumpTenant(cloud, A.accountId)).toBe(before);
    expect(
      JSON.stringify(
        cloud.rt.db
          .select()
          .from(controlSchema.memberships)
          .where(eq(controlSchema.memberships.accountId, A.accountId))
          .all(),
      ),
    ).toBe(controlBefore);
  }, 300_000);
});
