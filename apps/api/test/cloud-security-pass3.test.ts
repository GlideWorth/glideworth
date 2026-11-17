/**
 * Third pass of the pre-launch security review (docs/launch/security-review-pass3.md): the OAuth authorization
 * server and the MCP endpoint in cloud mode, workspace roles and invitations, and tenant isolation of recent
 * routes. Each test is either the regression test of a finding or the proof behind a "found sound" line.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  addMember,
  apiKey,
  bootCloud,
  Client,
  type Cloud,
  exchangeCode,
  lastMail,
  oauthCode,
  oauthTokens,
  reauth,
  signUp,
  tokenIn,
  uniqueEmail,
  markedSample,
} from "./cloud-harness.js";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

let cloud: Cloud;
beforeAll(async () => {
  cloud = await bootCloud();
}, 120_000);
afterAll(async () => {
  await cloud?.close();
}, 120_000);

const mcp = (token: string, method: string, params: Record<string, unknown> = {}) =>
  new Client(cloud)
    .withBearer(token)
    .post(
      "/mcp",
      { jsonrpc: "2.0", id: 1, method, params },
      { headers: { accept: "application/json, text/event-stream" } },
    );

const toolNames = async (token: string): Promise<string[]> => {
  const r = await mcp(token, "tools/list");
  expect(r.status, r.text).toBe(200);
  return (r.json.result.tools as Array<{ name: string }>).map((t) => t.name);
};

const callTool = async (token: string, name: string, args: Record<string, unknown> = {}) => {
  const r = await mcp(token, "tools/call", { name, arguments: args });
  expect(r.status, r.text).toBe(200);
  return r.json.result as { isError?: boolean; content: Array<{ text: string }> };
};

describe("ownership transfer and OAuth authorization codes", () => {
  it("an authorization code the old owner obtained before a transfer cannot be exchanged after it", async () => {
    const o = await signUp(cloud, { name: "Old Owner" });
    const accountId = o.accountId as string;
    await o.browser.post("/api/v1/import", { data: markedSample("Transfer", 4321) });
    const ed = await addMember(cloud, o.browser, accountId, "editor", "New Owner");

    // Before the transfer: the outgoing owner consents and keeps the code, unused.
    const pending = await oauthCode(cloud, o.browser, accountId);
    // And the incoming owner (an editor) does the same.
    const pendingEd = await oauthCode(cloud, ed.browser, accountId);

    await reauth(o.browser);
    const t = await o.browser.post("/api/v1/workspace/transfer", { userId: ed.userId });
    expect(t.status, t.text).toBeLessThan(300);

    // After: neither code may be exchanged. Before the fix the old owner's code minted a token acting as
    // the tenant user `owner`, which is now the new owner: owner role, the new owner's name in the audit.
    const late = await exchangeCode(cloud, pending);
    expect(late.status, late.text).toBe(400);
    expect(late.json.error).toBe("invalid_grant");
    const lateEd = await exchangeCode(cloud, pendingEd);
    expect(lateEd.status, lateEd.text).toBe(400);
    expect(lateEd.json.error).toBe("invalid_grant");

    // A fresh consent after the transfer works, and is cut when the new owner removes the old one. Before
    // the fix the late token above, acting as `owner`, kept working after that removal.
    const fresh = await oauthTokens(cloud, o.browser, accountId, "read simulate write");
    expect(await toolNames(fresh.access)).toContain("list_households");
    const rm = await ed.browser.del(`/api/v1/workspace/members/${o.userId}`);
    expect(rm.status, rm.text).toBeLessThan(300);
    expect((await mcp(fresh.access, "tools/list")).status).toBe(401);
  });
});

describe("OAuth consent and MCP scope in cloud mode", () => {
  it("a viewer's consent never yields write; a demotion removes write tools at once; MCP writes gate them", async () => {
    const o = await signUp(cloud, { name: "Scope Owner" });
    const accountId = o.accountId as string;
    await o.browser.post("/api/v1/import", { data: markedSample("ScopeWs", 1111) });
    const ed = await addMember(cloud, o.browser, accountId, "editor", "Scope Editor");
    const vw = await addMember(cloud, o.browser, accountId, "viewer", "Scope Viewer");

    // The viewer asks for and ticks every scope: write is dropped.
    const vt = await oauthTokens(cloud, vw.browser, accountId, "read simulate write");
    const vTok = await new Client(cloud).req("POST", "/oauth/token", {
      form: { grant_type: "refresh_token", refresh_token: vt.refresh, client_id: vt.clientId },
    });
    expect(vTok.status).toBe(200);
    expect(vTok.json.scope.split(" ").sort()).toEqual(["read", "simulate"]);

    // The editor's write grant: no write tools while MCP writes is off (the default).
    const et = await oauthTokens(cloud, ed.browser, accountId, "read simulate write");
    expect(await toolNames(et.access)).not.toContain("apply_change_set");
    expect((await ed.browser.patch("/api/v1/workspace/settings", { mcpWrites: true })).status).toBe(
      403,
    );
    expect((await o.browser.patch("/api/v1/workspace/settings", { mcpWrites: true })).status).toBe(
      200,
    );
    expect(await toolNames(et.access)).toContain("apply_change_set");
    // The viewer's token still has none, whatever the switch says.
    const vAccess = vTok.json.access_token as string;
    expect(await toolNames(vAccess)).not.toContain("apply_change_set");

    // Demoting the editor to viewer removes the write tools from the token already issued.
    const dm = await o.browser.patch(`/api/v1/workspace/members/${ed.userId}`, { role: "viewer" });
    expect(dm.status, dm.text).toBe(204);
    const after = await toolNames(et.access);
    expect(after).toContain("list_households");
    expect(after).not.toContain("apply_change_set");
    const direct = await callTool(et.access, "record_progress_snapshot", {});
    expect(direct.isError ?? false).toBe(true);
  });

  it("the consent page cannot be framed and its decision needs the form token and a same-origin request", async () => {
    const o = await signUp(cloud, { name: "Consent Owner" });
    const accountId = o.accountId as string;
    const reg = await new Client(cloud).post("/oauth/register", {
      client_name: '<img src=x onerror=alert(1)>"Claude"',
      redirect_uris: ["https://client.example/cb"],
      token_endpoint_auth_method: "none",
    });
    expect(reg.status).toBe(201);
    const q = new URLSearchParams({
      response_type: "code",
      client_id: reg.json.client_id,
      redirect_uri: "https://client.example/cb",
      code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      code_challenge_method: "S256",
      scope: "read",
      state: "st",
      _r: "1",
    });
    const page = await o.browser.get(`/oauth/authorize?${q}`);
    expect(page.status).toBe(200);
    expect(page.headers.get("x-frame-options")).toBe("DENY");
    expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(page.headers.get("cache-control")).toBe("no-store");
    expect(page.text).not.toContain("<img src=x");
    expect(page.text).toContain("&lt;img src=x");
    const csrf = /name="csrf" value="([^"]+)"/.exec(page.text)?.[1] as string;
    const form = (extra: Record<string, string>) => ({
      decision: "approve",
      workspace: accountId,
      grant: "read",
      client_id: reg.json.client_id as string,
      redirect_uri: "https://client.example/cb",
      code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      code_challenge_method: "S256",
      response_type: "code",
      scope: "read",
      state: "st",
      ...extra,
    });
    // No form token, a wrong one, and a cross-site origin are all refused; no code is issued.
    for (const [f, headers] of [
      [form({}), {}],
      [form({ csrf: "x".repeat(csrf.length) }), {}],
      [form({ csrf }), { origin: "https://evil.example" }],
    ] as const) {
      const r = await o.browser.req("POST", "/oauth/authorize", { form: f, headers });
      expect(r.status).toBe(403);
      expect(r.headers.get("location")).toBeNull();
    }
    // A different redirect URI than the registered one is never redirected to, even with a valid form.
    const other = await o.browser.req("POST", "/oauth/authorize", {
      form: form({ csrf, redirect_uri: "https://client.example/cb/../evil" }),
    });
    expect(other.status).toBe(400);
    expect(other.headers.get("location")).toBeNull();
    // A signed-out browser cannot approve.
    const anon = await new Client(cloud).req("POST", "/oauth/authorize", { form: form({ csrf }) });
    expect(anon.status).toBe(401);
  });

  it("a code is bound to its client, redirect URI and verifier, and a used code cannot be replayed", async () => {
    const o = await signUp(cloud);
    const accountId = o.accountId as string;
    const a = await oauthCode(cloud, o.browser, accountId, "read");
    const other = await oauthCode(cloud, o.browser, accountId, "read");
    const anon = new Client(cloud);
    const tryForm = (f: Record<string, string>) =>
      anon.req("POST", "/oauth/token", {
        form: {
          grant_type: "authorization_code",
          code: a.code,
          client_id: a.clientId,
          redirect_uri: "http://127.0.0.1:9/callback",
          code_verifier: a.verifier,
          ...f,
        },
      });
    // Another client's id: refused without using the code up.
    expect((await tryForm({ client_id: other.clientId })).json.error).toBe("invalid_grant");
    const ok = await tryForm({});
    expect(ok.status, ok.text).toBe(200);
    const replay = await tryForm({});
    expect(replay.json.error).toBe("invalid_grant");
    // The replay revoked what the code issued.
    expect((await mcp(ok.json.access_token, "tools/list")).status).toBe(401);
    // The verifier and the redirect URI are checked (each attempt burns the code).
    const b = await oauthCode(cloud, o.browser, accountId, "read");
    const wrongVerifier = await anon.req("POST", "/oauth/token", {
      form: {
        grant_type: "authorization_code",
        code: b.code,
        client_id: b.clientId,
        redirect_uri: "http://127.0.0.1:9/callback",
        code_verifier: "y".repeat(43),
      },
    });
    expect(wrongVerifier.json.error).toBe("invalid_grant");
    expect((await exchangeCode(cloud, b)).json.error).toBe("invalid_grant");
    const c = await oauthCode(cloud, o.browser, accountId, "read");
    const wrongRedirect = await anon.req("POST", "/oauth/token", {
      form: {
        grant_type: "authorization_code",
        code: c.code,
        client_id: c.clientId,
        redirect_uri: "http://127.0.0.1:9/other",
        code_verifier: c.verifier,
      },
    });
    expect(wrongRedirect.json.error).toBe("invalid_grant");
  });

  it("a read-only API key cannot disconnect other members' connected apps", async () => {
    const o = await signUp(cloud, { name: "Grant Owner" });
    const accountId = o.accountId as string;
    const ed = await addMember(cloud, o.browser, accountId, "editor", "Grant Editor");
    const et = await oauthTokens(cloud, ed.browser, accountId, "read");
    const readKey = await apiKey(o.browser, ["read"]);
    // The owner's session sees only the owner's own grants; the editor's grant id comes from the editor.
    const mine = await ed.browser.get("/api/v1/me/oauth-grants");
    const grantId = mine.json.items[0].id as string;
    const r = await new Client(cloud).withBearer(readKey).del(`/api/v1/me/oauth-grants/${grantId}`);
    expect(r.status).toBe(403);
    expect((await mcp(et.access, "tools/list")).status).toBe(200);
    // The owner's session (or a write key) still can.
    const s = await o.browser.del(`/api/v1/me/oauth-grants/${grantId}`);
    expect(s.status).toBe(204);
    expect((await mcp(et.access, "tools/list")).status).toBe(401);
  });
});

describe("workspace roles and invitations", () => {
  it("editors and viewers are refused every owner-only route, by session and by API key", async () => {
    const o = await signUp(cloud, { name: "Roles Owner" });
    const accountId = o.accountId as string;
    await o.browser.post("/api/v1/import", { data: markedSample("Roles", 2222) });
    const ed = await addMember(cloud, o.browser, accountId, "editor", "Roles Editor");
    const vw = await addMember(cloud, o.browser, accountId, "viewer", "Roles Viewer");
    const edKey = await apiKey(ed.browser);
    const routes: Array<[string, string, unknown?]> = [
      ["PATCH", "/api/v1/workspace/settings", { mcpWrites: true }],
      ["PATCH", "/api/v1/workspace/settings", { name: "Taken over" }],
      ["GET", "/api/v1/workspace/invitations"],
      ["POST", "/api/v1/workspace/invitations", { email: uniqueEmail("x"), role: "editor" }],
      ["PATCH", `/api/v1/workspace/members/${vw.userId}`, { role: "editor" }],
      ["DELETE", `/api/v1/workspace/members/${o.userId}`],
      ["POST", "/api/v1/workspace/transfer", { userId: ed.userId }],
      ["POST", "/api/v1/workspace/export", {}],
      ["GET", "/api/v1/workspace/support-grants"],
      ["POST", "/api/v1/workspace/support-grants", { reason: "help", days: 1 }],
      ["DELETE", "/api/v1/workspace", { confirmName: "x" }],
      ["GET", "/api/v1/webhooks"],
      ["POST", "/api/v1/webhooks", { url: "https://hooks.example/x", events: ["plan.updated"] }],
      ["GET", "/api/v1/audit-log"],
      ["GET", "/api/v1/oauth/clients"],
      ["POST", "/api/v1/billing/checkout", { lookupKey: "x" }],
      ["POST", "/api/v1/billing/portal", {}],
    ];
    const failures: string[] = [];
    for (const who of [
      { name: "editor", c: ed.browser },
      { name: "viewer", c: vw.browser },
      { name: "editor key", c: new Client(cloud).withBearer(edKey) },
    ]) {
      await reauth(who.c);
      for (const [m, p, body] of routes) {
        const r = await who.c.req(m, p, body === undefined ? {} : { body });
        if (r.status !== 403 && r.status !== 401)
          failures.push(`${who.name} ${m} ${p}: ${r.status} ${r.text.slice(0, 120)}`);
      }
    }
    expect(failures).toEqual([]);
    // Nothing changed.
    const members = (await o.browser.get("/api/v1/workspace/members")).json.items as Array<{
      userId: string;
      role: string;
    }>;
    expect(members.find((m) => m.userId === vw.userId)?.role).toBe("viewer");
    expect(members.find((m) => m.userId === o.userId)?.role).toBe("owner");
  });

  it("an invitation is bound to its address, single use, dead once withdrawn, and its role is not the invitee's choice", async () => {
    const o = await signUp(cloud, { name: "Invite Owner" });
    const accountId = o.accountId as string;
    const invited = uniqueEmail("invitee");
    const inv = await o.browser.post("/api/v1/workspace/invitations", {
      email: invited,
      role: "viewer",
    });
    expect(inv.status).toBe(201);
    await cloud.rt.accounts.settled();
    const token = tokenIn((lastMail(cloud, invited, "invitation") as { text: string }).text);

    // Someone else, signed in and verified, holding the link: refused, and the link still works after.
    const stranger = await signUp(cloud, { name: "Stranger" });
    const s1 = await stranger.browser.post("/api/v1/workspace/invitations/accept", {
      token,
      role: "editor",
    });
    expect(s1.status).toBe(403);
    expect(
      (await stranger.browser.post(`/api/v1/workspaces/${accountId}/activate`, {})).status,
    ).toBe(403);

    // The invitee asks for a better role: they get the one offered.
    const me = await signUp(cloud, { email: invited, name: "Invitee" });
    const a = await me.browser.post("/api/v1/workspace/invitations/accept", {
      token,
      role: "owner",
    });
    expect(a.status, a.text).toBe(200);
    const members = (await o.browser.get("/api/v1/workspace/members")).json.items as Array<{
      userId: string;
      role: string;
    }>;
    expect(members.find((m) => m.userId === me.userId)?.role).toBe("viewer");
    // Used once: a second acceptance (after leaving) is refused.
    await me.browser.post(`/api/v1/workspaces/${accountId}/activate`, {});
    expect((await me.browser.post("/api/v1/workspace/leave", {})).status).toBeLessThan(300);
    expect((await me.browser.post("/api/v1/workspace/invitations/accept", { token })).status).toBe(
      400,
    );

    // A withdrawn invitation is dead.
    const invited2 = uniqueEmail("invitee2");
    const inv2 = await o.browser.post("/api/v1/workspace/invitations", {
      email: invited2,
      role: "editor",
    });
    await cloud.rt.accounts.settled();
    const token2 = tokenIn((lastMail(cloud, invited2, "invitation") as { text: string }).text);
    expect(
      (await o.browser.del(`/api/v1/workspace/invitations/${inv2.json.id}`)).status,
    ).toBeLessThan(300);
    const me2 = await signUp(cloud, { email: invited2 });
    expect(
      (await me2.browser.post("/api/v1/workspace/invitations/accept", { token: token2 })).status,
    ).toBe(400);
  });

  it("a removed member's unused authorization code, API key, OAuth token and session all stop working", async () => {
    const o = await signUp(cloud, { name: "Remove Owner" });
    const accountId = o.accountId as string;
    const ed = await addMember(cloud, o.browser, accountId, "editor", "Remove Editor");
    const key = await apiKey(ed.browser);
    const tok = await oauthTokens(cloud, ed.browser, accountId, "read");
    const code = await oauthCode(cloud, ed.browser, accountId, "read");
    const rm = await o.browser.del(`/api/v1/workspace/members/${ed.userId}`);
    expect(rm.status, rm.text).toBeLessThan(300);
    expect((await new Client(cloud).withBearer(key).get("/api/v1/households")).status).toBe(401);
    expect((await mcp(tok.access, "tools/list")).status).toBe(401);
    const refreshed = await new Client(cloud).req("POST", "/oauth/token", {
      form: { grant_type: "refresh_token", refresh_token: tok.refresh, client_id: tok.clientId },
    });
    expect(refreshed.status).toBe(400);
    const late = await exchangeCode(cloud, code);
    expect(late.status).toBe(400);
    expect([401, 403]).toContain((await ed.browser.get("/api/v1/households")).status);
  });
});

describe("names that would stop mail", () => {
  it("line separators, C1 controls and direction overrides are removed from a name, so reset mail still arrives", async () => {
    const o = await signUp(cloud, { name: "Plain Name" });
    const p = await o.browser.patch("/api/v1/account/profile", {
      name: "Sam Lee\u0085 ‮evil",
    });
    expect(p.status).toBe(200);
    const s = await o.browser.get("/api/v1/auth/status");
    expect(s.json.user.name).toBe("SamLee evil");
    const ws = await o.browser.patch("/api/v1/workspace/settings", { name: "Home ⁦ base" });
    expect(ws.status).toBe(200);
    const before = cloud.transport.sent.length;
    const f = await new Client(cloud).post("/api/v1/auth/password/forgot", {
      email: o.email,
      captchaToken: "captcha-ok",
    });
    expect(f.status).toBe(202);
    await cloud.rt.accounts.settled();
    const mail = cloud.transport.sent.slice(before).find((m) => m.template === "password-reset");
    expect(mail?.to).toEqual({ email: o.email, name: "SamLee evil" });
  });
});
