/* oxlint-disable typescript/no-explicit-any -- the sweep walks an arbitrary OpenAPI document and JSON replies */
/**
 * View-only access is enforced by the server, not by the web app hiding buttons.
 *
 * A partner invited as a viewer (self-host) signs in and gets three credentials: their browser session, an API
 * key they mint for themselves and an OAuth access token for an MCP client (consented with every scope). The
 * sweep reads `/openapi.json` and calls EVERY operation with each credential, using real ids of the household so
 * a write would succeed if the role check were missing, and then calls EVERY MCP tool the owner can see. It
 * proves that:
 *   - every operation that needs `write` or the owner role answers 403;
 *   - nothing a viewer may call (reads, simulations, previews, their own read-only keys) changes household data:
 *     every table except a short list of operational ones is byte-for-byte the same afterwards;
 *   - the viewer's MCP tool list holds read-only tools only, and calling a write tool by name fails;
 *   - every route under /api of the running app is in the document, so a new route cannot escape the sweep.
 * A new operation or tool is covered without editing this file.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Browser, browser } from "./browser.js";
import { type Harness, READ_KEY, setup, SIM_KEY, WRITE_KEY } from "./helpers.js";
import { mcpCall, oauthTokenFor } from "./oauth-flow.js";

let h: Harness;
const OWNER_PASS = "owner passphrase one two";
const PAT_PASS = "pat passphrase five six";

let owner: Browser;
let pat: Browser;
let patKey: string;
let patOAuth: string;
let patUserId: string;
const ids: Record<string, string> = {};
/** Values a viewer must never receive: credentials of the owner, the share token, the webhook signing secret. */
const secrets: string[] = [];

/**
 * Tables that may change while a viewer works: compute results and job rows (a viewer may run simulations),
 * audit entries (refused attempts are recorded) and replay records. Every other table, including any added later,
 * must not change. Credentials and sessions are compared without the viewer's own and without last-use times.
 */
const OPERATIONAL = new Set([
  "jobs",
  "simulation_runs",
  "audit_log",
  "idempotency_keys",
  "__drizzle_migrations",
]);
const CREDENTIALS = new Set([
  "api_keys",
  "auth_sessions",
  "oauth_tokens",
  "oauth_codes",
  "oauth_clients",
]);

function dump(): string {
  const raw = h.ctx.sqlite;
  const tables = (
    raw.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as {
      name: string;
    }[]
  ).map((t) => t.name);
  const out: Record<string, unknown[]> = {};
  for (const t of tables) {
    if (OPERATIONAL.has(t) || t.startsWith("sqlite_")) continue;
    let rows = raw.prepare(`SELECT * FROM "${t}" ORDER BY rowid`).all() as Record<
      string,
      unknown
    >[];
    if (CREDENTIALS.has(t))
      rows = rows
        .filter((r) => r.user_id !== patUserId && t !== "oauth_clients")
        .map(({ last_used_at: _u, last_seen_at: _s, ...r }) => r);
    out[t] = rows;
  }
  return JSON.stringify(out);
}

beforeAll(async () => {
  h = setup({ mcpAllowWrites: true });
  owner = browser(h.app);
  expect(
    (await owner.req("/api/v1/auth/setup", { method: "POST", body: { passphrase: OWNER_PASS } }))
      .status,
  ).toBe(201);
  const inv = await owner.req("/api/v1/users", {
    method: "POST",
    body: { name: "Pat", role: "viewer", login: "pat" },
  });
  expect(inv.status).toBe(201);
  patUserId = inv.json.user.id;
  pat = browser(h.app);
  expect(
    (
      await pat.req("/api/v1/auth/accept", {
        method: "POST",
        body: { token: inv.json.invite.token, passphrase: PAT_PASS },
      })
    ).status,
  ).toBe(200);
  const k = await pat.req("/api/v1/me/keys", {
    method: "POST",
    body: { name: "pat tools", scopes: ["read", "simulate"] },
  });
  expect(k.status).toBe(201);
  patKey = k.json.key;
  const o = await oauthTokenFor(h, { user: "pat", pass: PAT_PASS });
  expect(o.scope.split(" ").sort()).toEqual(["read", "simulate"]);
  patOAuth = o.access;

  // Real ids of everything a path can name, created by the owner, so the sweep would succeed without the check.
  const own = (path: string, method: string, body?: unknown) =>
    h.call(path, { method, ...(body !== undefined ? { body } : {}) });
  const share = await own("/api/v1/plans/plan-main/share-links", "POST", {
    includeSuccessRate: false,
  });
  ids.share = share.json.link?.id;
  secrets.push(share.json.token);
  ids.changeSet = (
    await own("/api/v1/plans/plan-main/change-sets", "POST", {
      ops: [{ op: "replace", path: "/expenses/[id=exp-living]/amount/value", value: 4321 }],
      summary: "x",
    })
  ).json.id;
  const hook = await own("/api/v1/webhooks", "POST", {
    url: "https://example.test/hook",
    events: ["plan.updated"],
  });
  ids.webhook = hook.json.id;
  secrets.push(hook.json.secret, WRITE_KEY);
  ids.job = (await own("/api/v1/plans/plan-main/monte-carlo?wait=30", "POST", {})).json.id;
  ids.snapshot = (await own("/api/v1/households/hh-sample/snapshots/record", "POST", {})).json?.id;
  for (const [k, v] of Object.entries(ids)) expect(v, k).toBeTruthy();
  const raw = h.ctx.sqlite;
  for (const r of raw.prepare("SELECT hash FROM api_keys WHERE hash IS NOT NULL").all() as any[])
    secrets.push(r.hash);
  for (const r of raw.prepare("SELECT hash FROM auth_credentials").all() as any[])
    secrets.push(r.hash);
  for (const r of raw.prepare("SELECT hash FROM users WHERE hash IS NOT NULL").all() as any[])
    secrets.push(r.hash);
  expect(secrets.every(Boolean)).toBe(true);
  ids.ownerKey = (await own("/api/v1/keys", "GET")).json.items.find(
    (x: any) => x.name === "test-write",
  ).id;
}, 120_000);
afterAll(async () => {
  // The sweep starts compute jobs (a viewer may simulate): let them finish before the database closes.
  await h?.services.jobs.close(30_000);
  h?.close();
}, 60_000);

// ------------------------------------------------------------------------------------- request building
type Op = { method: string; path: string; op: any };
const operations = (doc: any): Op[] =>
  Object.entries<any>(doc.paths).flatMap(([path, item]) =>
    ["get", "post", "put", "patch", "delete"]
      .filter((m) => item[m])
      .map((method) => ({ method, path, op: item[method] })),
  );

function paramFor(path: string, name: string): string {
  const before = path.split("/")[path.split("/").indexOf(`{${name}}`) - 1] ?? "";
  const byContext: Record<string, string> = {
    "households/{id}": "hh-sample",
    "plans/{id}": "plan-main",
    "change-sets/{id}": ids.changeSet!,
    "jobs/{id}": ids.job!,
    "keys/{id}": ids.ownerKey!,
    "webhooks/{id}": ids.webhook!,
    "share-links/{id}": ids.share!,
    "users/{id}": patUserId,
    "clients/{id}": "oac_none",
    "notifications/{id}": "ntf_none",
    "checkins/{id}": "chk_none",
    "imports/{id}": "imp_none",
  };
  const byName: Record<string, string> = {
    snapId: ids.snapshot ?? "snap_none",
    grantId: "oag_none",
    personId: "p-avery",
    dependentId: "d-1",
    itemId: "exp-living",
    version: "1",
    collection: "expenses",
    templateId: "market-crash",
    table: "year-by-year",
    pair: "EUR-USD",
    country: "GB",
    a: "GB",
    b: "US",
    token: "x".repeat(40),
    section: "x",
  };
  const v = byContext[`${before}/{${name}}`] ?? byName[name];
  if (v === undefined) throw new Error(`no value for path parameter {${name}} of ${path}`);
  return v;
}

function bodyFor(schema: any, doc: any, depth = 0): unknown {
  if (!schema || depth > 6) return undefined;
  if (schema.$ref)
    return bodyFor(doc.components.schemas[schema.$ref.split("/").pop()], doc, depth + 1);
  const alt = schema.anyOf ?? schema.oneOf ?? schema.allOf;
  if (Array.isArray(alt)) return bodyFor(alt[0], doc, depth + 1);
  if (schema.default !== undefined) return schema.default;
  if (Array.isArray(schema.enum)) return schema.enum[0];
  if (schema.const !== undefined) return schema.const;
  switch (schema.type) {
    case "object": {
      const out: Record<string, unknown> = {};
      const props = schema.properties ?? {};
      for (const name of schema.required ?? Object.keys(props).slice(0, 4)) {
        if (/^(planId|basePlanId|otherPlanId)$/.test(name)) out[name] = "plan-main";
        else if (name === "planIds") out[name] = ["plan-main", "plan-main"];
        else if (name === "householdId") out[name] = "hh-sample";
        else out[name] = bodyFor(props[name], doc, depth + 1);
      }
      return out;
    }
    case "array":
      return [];
    case "string":
      return schema.format === "uri" ? "https://hooks.example/x" : "x";
    case "integer":
    case "number":
      return typeof schema.minimum === "number" ? schema.minimum : 1;
    case "boolean":
      return true;
    default:
      return undefined;
  }
}

function requestFor(o: Op, doc: any): { url: string; body?: unknown } {
  const path = o.path.replace(/\{(\w+)\}/g, (_, n) => paramFor(o.path, n));
  const q = new URLSearchParams();
  for (const p of o.op.parameters ?? [])
    if (p.in === "query" && p.required) q.set(p.name, String(bodyFor(p.schema, doc) ?? "x"));
  if (o.op.parameters?.some((p: any) => p.in === "query" && p.name === "wait")) q.set("wait", "0");
  const schema = o.op.requestBody?.content?.["application/json"]?.schema;
  const url = `${path}${q.size ? `?${q}` : ""}`;
  return schema ? { url, body: bodyFor(schema, doc) } : { url };
}

/** Ending the viewer's own sign-in mid-sweep would only stop the sweep early; they are checked separately. */
const OWN_SESSION_ENDERS = new Set(["post /api/v1/auth/logout", "post /api/v1/auth/logout-all"]);

const writes = (o: Op) =>
  o.op["x-required-scope"] === "write" || o.op["x-required-role"] === "owner";

// --------------------------------------------------------------------------------------------- sweeps
describe("view-only access: every operation, every credential", () => {
  let doc: any;
  beforeAll(async () => {
    doc = await (await h.app.request("/openapi.json")).json();
  });

  it("every route under /api is in the OpenAPI document (nothing escapes the sweep)", () => {
    const documented = new Set(
      operations(doc).map(
        (o) => `${o.method.toUpperCase()} ${o.path.replace(/\{(\w+)\}/g, ":$1")}`,
      ),
    );
    const routes = (h.app as unknown as { routes: { method: string; path: string }[] }).routes;
    const missing = routes
      .filter((r) => r.path.startsWith("/api/") && r.method !== "ALL" && !r.path.endsWith("*"))
      .map((r) => `${r.method} ${r.path}`)
      .filter((r) => !documented.has(r));
    expect([...new Set(missing)]).toEqual([]);
    expect(operations(doc).filter(writes).length).toBeGreaterThan(80);
  });

  for (const via of ["session", "api key", "oauth token"] as const)
    it(`as the viewer's ${via}: every write is refused with 403 and no household data changes`, async () => {
      const before = dump();
      const send = async (method: string, url: string, body?: unknown) => {
        if (via === "session")
          return pat.req(url, {
            method: method.toUpperCase(),
            ...(body !== undefined ? { body } : {}),
          });
        return h.call(url, {
          method: method.toUpperCase(),
          key: via === "api key" ? patKey : patOAuth,
          ...(body !== undefined ? { body } : {}),
        });
      };
      const leaks: string[] = [];
      let refused = 0;
      for (const o of operations(doc)) {
        const where = `${o.method} ${o.path}`;
        if (OWN_SESSION_ENDERS.has(where)) continue;
        const { url, body } = requestFor(o, doc);
        const r = await send(o.method, url, body);
        if (writes(o)) {
          // An OAuth token is bound to the MCP resource, so REST refuses it before the role check (401).
          const ok = r.status === 403 || (via === "oauth token" && r.status === 401);
          if (!ok) leaks.push(`${where} -> ${r.status} ${r.text.slice(0, 120)}`);
          else refused++;
        } else if (r.status >= 500) leaks.push(`${where} -> ${r.status} ${r.text.slice(0, 120)}`);
        for (const secret of secrets)
          if (r.text.includes(secret))
            leaks.push(`${where} returned a secret (${secret.slice(0, 10)}…)`);
      }
      expect(leaks).toEqual([]);
      expect(refused).toBeGreaterThan(80);
      expect(dump()).toBe(before);
      // The viewer is still a viewer and still signed in.
      if (via !== "oauth token") expect((await send("get", "/api/v1/me")).json.role).toBe("viewer");
    }, 180_000);

  it("MCP: the viewer sees no write tool, and every write tool fails when called by name", async () => {
    const ownerTools = (await mcpCall(h, WRITE_KEY, "tools/list")).json.result.tools as any[];
    // A write tool is one an owner sees only with the write scope. readOnlyHint is not the test: the tools that
    // start a calculation are not marked read-only, and a viewer may run them.
    const noWrite = new Set<string>();
    for (const key of [READ_KEY, SIM_KEY])
      for (const t of (await mcpCall(h, key, "tools/list")).json.result.tools as any[])
        noWrite.add(t.name);
    const writeTools = ownerTools.map((t) => t.name as string).filter((n) => !noWrite.has(n));
    expect(writeTools).toEqual(
      expect.arrayContaining(["apply_change_set", "update_account_balances", "create_share_link"]),
    );
    for (const token of [patKey, patOAuth]) {
      const mine = (await mcpCall(h, token, "tools/list")).json.result.tools as any[];
      expect(mine.length).toBeGreaterThan(30);
      expect(mine.map((t) => t.name).filter((n) => writeTools.includes(n))).toEqual([]);
      expect(mine.map((t) => t.name)).toContain("get_partner_summary");
      const before = dump();
      for (const t of ownerTools) {
        const props = t.inputSchema?.properties ?? {};
        const args: Record<string, unknown> = {};
        for (const name of t.inputSchema?.required ?? []) {
          const p = props[name] ?? {};
          if (/plan/i.test(name)) args[name] = p.type === "array" ? ["plan-main"] : "plan-main";
          else if (/household/i.test(name)) args[name] = "hh-sample";
          else if (/changeSet/i.test(name)) args[name] = ids.changeSet;
          else if (/job/i.test(name)) args[name] = ids.job;
          else if (p.type === "string") args[name] = Array.isArray(p.enum) ? p.enum[0] : "x";
          else if (p.type === "number" || p.type === "integer") args[name] = 1;
          else if (p.type === "boolean") args[name] = false;
          else if (p.type === "array") args[name] = [];
          else args[name] = {};
        }
        if ("wait" in props) args.wait = 0;
        const r = await mcpCall(h, token, "tools/call", { name: t.name, arguments: args });
        if (writeTools.includes(t.name))
          expect(
            r.json.error ?? r.json.result?.isError,
            `${t.name} must fail for a viewer: ${JSON.stringify(r.json).slice(0, 200)}`,
          ).toBeTruthy();
      }
      expect(dump()).toBe(before);
    }
  }, 180_000);
});
