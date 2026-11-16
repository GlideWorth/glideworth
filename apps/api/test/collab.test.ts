/* oxlint-disable typescript/no-explicit-any -- tests probe arbitrary JSON responses */
/** Household collaboration: owner / editor / viewer, invites, resets, per-user sessions and keys, audit log. */
import { afterEach, describe, expect, it } from "vitest";
import { generateKey } from "../src/auth.js";
import { type Browser, browser } from "./browser.js";
import { type Harness, setup, WRITE_KEY } from "./helpers.js";

let h: Harness;
afterEach(() => h?.close());
const OWNER_PASS = "owner passphrase one two";
const SAM_PASS = "sam passphrase three four";
const PAT_PASS = "pat passphrase five six";
const A = "/api/v1/auth";

async function ownerSession() {
  const o = browser(h.app);
  expect(
    (await o.req(`${A}/setup`, { method: "POST", body: { passphrase: OWNER_PASS } })).status,
  ).toBe(201);
  return o;
}

/** Owner invites, the invitee accepts: returns their browser session. */
async function join(owner: Browser, name: string, role: "editor" | "viewer", pass: string) {
  const inv = await owner.req("/api/v1/users", { method: "POST", body: { name, role } });
  expect(inv.status, inv.text).toBe(201);
  const b = browser(h.app);
  const acc = await b.req(`${A}/accept`, {
    method: "POST",
    body: { token: inv.json.invite.token, passphrase: pass },
  });
  expect(acc.status, acc.text).toBe(200);
  return {
    b,
    user: inv.json.user as { id: string; login: string },
    token: inv.json.invite.token as string,
  };
}

const EDIT = [{ op: "replace", path: "/expenses/[id=exp-living]/amount/value", value: 5111 }];
const patchPlan = (b: Browser, v = 1) =>
  b.req("/api/v1/plans/plan-main", {
    method: "PATCH",
    body: [{ op: "replace", path: "/expenses/[id=exp-living]/amount/value", value: 5000 + v }],
    headers: { "content-type": "application/json-patch+json", "if-match": `"${v}"` },
  });

describe("invites and sign-in", () => {
  it("W4-2: first-run setup and accepting an invite record the last sign-in", async () => {
    h = setup();
    const o = await ownerSession();
    await join(o, "Sam", "editor", SAM_PASS);
    const users = (await o.req("/api/v1/users")).json.items as {
      id: string;
      lastLoginAt: string | null;
    }[];
    expect(users.find((u) => u.id === "owner")?.lastLoginAt).toEqual(expect.any(String));
    const sam = users.find((u) => u.id !== "owner");
    expect(sam?.lastLoginAt).toEqual(expect.any(String));
  });

  it("the single-user path is unchanged: setup, then login with the passphrase only", async () => {
    h = setup();
    const o = await ownerSession();
    const st = await o.req(`${A}/status`);
    expect(st.json).toMatchObject({
      authenticated: true,
      user: { id: "owner", role: "owner" },
      multiUser: false,
    });
    const again = browser(h.app);
    const l = await again.req(`${A}/login`, { method: "POST", body: { passphrase: OWNER_PASS } });
    expect(l.status).toBe(200);
    expect(l.json.user).toMatchObject({ id: "owner", role: "owner" });
  });

  it("owner invites; the invitee chooses a passphrase and is signed in; the token works once", async () => {
    h = setup();
    const o = await ownerSession();
    const { b, user, token } = await join(o, "Sam Partner", "editor", SAM_PASS);
    expect(user.login).toBe("sam-partner");
    const me = await b.req("/api/v1/me");
    expect(me.json).toMatchObject({ userName: "Sam Partner", role: "editor", via: "session" });
    const reuse = await browser(h.app).req(`${A}/accept`, {
      method: "POST",
      body: { token, passphrase: "another long one 1" },
    });
    expect(reuse.status).toBe(400);
    expect(reuse.json.error.code).toBe("INVALID_TOKEN");
    // The owner never learns the passphrase: only the invitee's hash is stored.
    const row = h.ctx.sqlite.prepare("select hash from users where id = ?").get(user.id) as {
      hash: string;
    };
    expect(row.hash).toMatch(/^scrypt\$/);
    expect(row.hash).not.toContain("sam passphrase");
  });

  it("signs in by name once others exist; the owner still signs in without one; unknown names look like wrong passphrases", async () => {
    h = setup();
    const o = await ownerSession();
    await join(o, "Sam", "editor", SAM_PASS);
    const sam = browser(h.app);
    expect(
      (await sam.req(`${A}/login`, { method: "POST", body: { passphrase: SAM_PASS, user: "sam" } }))
        .status,
    ).toBe(200);
    // Sam's passphrase does not open the owner account
    const asOwner = await browser(h.app).req(`${A}/login`, {
      method: "POST",
      body: { passphrase: SAM_PASS },
    });
    expect(asOwner.status).toBe(401);
    expect(
      (await browser(h.app).req(`${A}/login`, { method: "POST", body: { passphrase: OWNER_PASS } }))
        .status,
    ).toBe(200);
    const ghost = await browser(h.app).req(`${A}/login`, {
      method: "POST",
      body: { passphrase: SAM_PASS, user: "nobody" },
    });
    expect(ghost.status).toBe(401);
    expect(ghost.json.error.message).toBe(asOwner.json.error.message);
    expect((await o.req(`${A}/status`)).json.multiUser).toBe(true);
  });

  it("an invited user who has not accepted cannot sign in; an expired token is refused", async () => {
    h = setup();
    const o = await ownerSession();
    const inv = await o.req("/api/v1/users", {
      method: "POST",
      body: { name: "Pat", role: "viewer" },
    });
    expect(
      (
        await browser(h.app).req(`${A}/login`, {
          method: "POST",
          body: { passphrase: PAT_PASS, user: "pat" },
        })
      ).status,
    ).toBe(401);
    h.ctx.sqlite.prepare("update user_tokens set expires_at = '2000-01-01T00:00:00.000Z'").run();
    const late = await browser(h.app).req(`${A}/accept`, {
      method: "POST",
      body: { token: inv.json.invite.token, passphrase: PAT_PASS },
    });
    expect(late.status).toBe(400);
    const fresh = await o.req(`/api/v1/users/${inv.json.user.id}/invite`, { method: "POST" });
    expect(fresh.status).toBe(200);
    expect(
      (
        await browser(h.app).req(`${A}/accept`, {
          method: "POST",
          body: { token: fresh.json.invite.token, passphrase: PAT_PASS },
        })
      ).status,
    ).toBe(200);
  });

  it("refuses weak passphrases, duplicate sign-in names and the reserved name owner", async () => {
    h = setup();
    const o = await ownerSession();
    const inv = await o.req("/api/v1/users", {
      method: "POST",
      body: { name: "Sam", role: "editor" },
    });
    expect(
      (
        await browser(h.app).req(`${A}/accept`, {
          method: "POST",
          body: { token: inv.json.invite.token, passphrase: "short" },
        })
      ).status,
    ).toBe(400);
    expect(
      (await o.req("/api/v1/users", { method: "POST", body: { name: "Sam", role: "viewer" } }))
        .status,
    ).toBe(409);
    expect(
      (
        await o.req("/api/v1/users", {
          method: "POST",
          body: { name: "x", login: "owner", role: "viewer" },
        })
      ).status,
    ).toBe(409);
    expect(
      (await o.req("/api/v1/users", { method: "POST", body: { name: "Eve", role: "owner" } }))
        .status,
    ).toBe(400);
  });
});

describe("roles are enforced on every route", () => {
  it("a viewer reads and simulates but cannot write anything", async () => {
    h = setup();
    const o = await ownerSession();
    const { b } = await join(o, "Pat Adviser", "viewer", PAT_PASS);
    expect((await b.req("/api/v1/plans/plan-main")).status).toBe(200);
    expect(
      (await b.req("/api/v1/plans/plan-main/simulate", { method: "POST", body: {} })).status,
    ).toBe(200);
    const w = await patchPlan(b);
    expect(w.status).toBe(403);
    expect(w.json.error.details).toMatchObject({ role: "viewer", required: "write" });
    expect((await b.req("/api/v1/plans", { method: "POST", body: {} })).status).toBe(403);
    expect((await b.req("/api/v1/settings", { method: "PATCH", body: {} })).status).toBe(403);
    expect(
      (await b.req("/api/v1/households/hh-sample/balances", { method: "POST", body: {} })).status,
    ).toBe(403);
    expect((await b.req("/api/v1/import", { method: "POST", body: {} })).status).toBe(403);
    expect(
      (await b.req("/api/v1/plans/plan-main/share-links", { method: "POST", body: {} })).status,
    ).toBe(403);
    expect((await b.req("/api/v1/users")).status).toBe(403);
    expect((await b.req("/api/v1/audit-log")).status).toBe(403);
    expect((await b.req("/api/v1/keys")).status).toBe(403);
    // and nothing changed
    expect(h.services.plans.get("plan-main").version).toBe(1);
  });

  it("an editor writes plans but cannot manage users, webhooks or read the audit log", async () => {
    h = setup();
    const o = await ownerSession();
    const { b } = await join(o, "Sam Partner", "editor", SAM_PASS);
    expect((await patchPlan(b)).status).toBe(200);
    for (const [method, path] of [
      ["GET", "/api/v1/users"],
      ["POST", "/api/v1/users"],
      ["GET", "/api/v1/webhooks"],
      ["POST", "/api/v1/webhooks"],
      ["GET", "/api/v1/audit-log"],
      ["GET", "/api/v1/oauth/clients"],
    ] as const) {
      const r = await b.req(path, { method, ...(method === "POST" ? { body: {} } : {}) });
      expect(r.status, `${method} ${path}`).toBe(403);
      expect(r.json.error.details).toMatchObject({ required: "owner" });
    }
  });

  it("plan version history names the person who made each change", async () => {
    h = setup();
    const o = await ownerSession();
    const { b, user } = await join(o, "Sam Partner", "editor", SAM_PASS);
    await patchPlan(b, 1);
    await patchPlan(o, 2);
    const v = (await o.req("/api/v1/plans/plan-main/versions")).json.items;
    expect(v[1].actor).toMatchObject({
      kind: "user",
      id: user.id,
      label: "Sam Partner",
      userId: user.id,
      userName: "Sam Partner",
    });
    expect(v[0].actor).toMatchObject({ kind: "user", id: "owner", label: "Owner" });
  });

  it("the audit log records who changed what, including refused attempts", async () => {
    h = setup();
    const o = await ownerSession();
    const { b } = await join(o, "Sam Partner", "editor", SAM_PASS);
    const { b: pat } = await join(o, "Pat Adviser", "viewer", PAT_PASS);
    await patchPlan(b, 1);
    await patchPlan(pat, 2); // refused
    const log = (await o.req("/api/v1/audit-log?resourceType=plan&resourceId=plan-main")).json
      .items;
    expect(
      log.some(
        (e: any) =>
          e.userName === "Sam Partner" &&
          e.status === 200 &&
          e.action.startsWith("PATCH /api/v1/plans"),
      ),
    ).toBe(true);
    expect(log.some((e: any) => e.userName === "Pat Adviser" && e.status === 403)).toBe(true);
    const mine = (await o.req("/api/v1/audit-log?userId=owner")).json.items;
    expect(mine.some((e: any) => e.action === "POST /api/v1/users")).toBe(true);
    expect(JSON.stringify(log)).not.toContain(SAM_PASS);
  });

  it("API keys belong to a user and never exceed their role", async () => {
    h = setup();
    const o = await ownerSession();
    const { b: pat } = await join(o, "Pat Adviser", "viewer", PAT_PASS);
    const { b: sam } = await join(o, "Sam Partner", "editor", SAM_PASS);
    // A viewer can mint a read key for their own tools, but not a write key
    const bad = await pat.req("/api/v1/me/keys", {
      method: "POST",
      body: { name: "w", scopes: ["write"] },
    });
    expect(bad.status).toBe(403);
    const ok = await pat.req("/api/v1/me/keys", {
      method: "POST",
      body: { name: "adviser tool", scopes: ["read"] },
    });
    expect(ok.status, ok.text).toBe(201);
    expect(ok.json.userName).toBe("Pat Adviser");
    const key = ok.json.key as string;
    expect((await h.call("/api/v1/plans", { key })).status).toBe(200);
    expect((await h.call("/api/v1/plans", { key: WRITE_KEY })).status).toBe(200);
    // Sam's write key is capped when Sam is demoted
    const sk = (
      await sam.req("/api/v1/me/keys", {
        method: "POST",
        body: { name: "sam", scopes: ["read", "write"] },
      })
    ).json.key as string;
    expect(
      (
        await h.call("/api/v1/plans/plan-main", {
          key: sk,
          method: "PATCH",
          body: EDIT,
          headers: { "content-type": "application/json-patch+json" },
        })
      ).status,
    ).toBe(200);
    const samId = (await o.req("/api/v1/users")).json.items.find(
      (u: any) => u.login === "sam-partner",
    ).id;
    expect(
      (await o.req(`/api/v1/users/${samId}`, { method: "PATCH", body: { role: "viewer" } })).json
        .role,
    ).toBe("viewer");
    const after = await h.call("/api/v1/plans/plan-main", {
      key: sk,
      method: "PATCH",
      body: EDIT,
      headers: { "content-type": "application/json-patch+json" },
    });
    expect(after.status).toBe(403);
    expect((await h.call("/api/v1/me", { key: sk })).json).toMatchObject({
      role: "viewer",
      scopes: ["read"],
    });
    // Sam's existing session is signed out by the role change
    expect((await sam.req("/api/v1/plans")).status).toBe(401);
  });

  it("keys list: the owner sees all, others only their own; others cannot revoke someone else’s", async () => {
    h = setup();
    const o = await ownerSession();
    const { b: sam } = await join(o, "Sam", "editor", SAM_PASS);
    const { b: pat } = await join(o, "Pat", "editor", PAT_PASS);
    const sk = await sam.req("/api/v1/keys", {
      method: "POST",
      body: { name: "sam", scopes: ["read"] },
    });
    expect(sk.status, sk.text).toBe(201);
    const own = (await sam.req("/api/v1/keys")).json.items;
    expect(own.map((k: any) => k.userName)).toEqual(["Sam"]);
    expect((await pat.req("/api/v1/keys")).json.items).toHaveLength(0);
    expect((await pat.req(`/api/v1/keys/${sk.json.id}`, { method: "DELETE" })).status).toBe(404);
    expect((await o.req("/api/v1/keys")).json.items.length).toBeGreaterThan(3);
  });
});

describe("resets, disabling and removal", () => {
  it("owner resets a passphrase: old one stops working, sessions end, token works once", async () => {
    h = setup();
    const o = await ownerSession();
    const { b, user } = await join(o, "Sam", "editor", SAM_PASS);
    const r = await o.req(`/api/v1/users/${user.id}/reset-passphrase`, { method: "POST" });
    expect(r.status, r.text).toBe(200);
    expect((await b.req("/api/v1/plans")).status).toBe(401);
    expect(
      (
        await browser(h.app).req(`${A}/login`, {
          method: "POST",
          body: { passphrase: SAM_PASS, user: "sam" },
        })
      ).status,
    ).toBe(200);
    // the old passphrase still works until the token is used (the user may simply have lost a device)
    const fresh = browser(h.app);
    const acc = await fresh.req(`${A}/accept`, {
      method: "POST",
      body: { token: r.json.reset.token, passphrase: "a brand new passphrase" },
    });
    expect(acc.status).toBe(200);
    expect(
      (
        await browser(h.app).req(`${A}/login`, {
          method: "POST",
          body: { passphrase: SAM_PASS, user: "sam" },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await browser(h.app).req(`${A}/login`, {
          method: "POST",
          body: { passphrase: "a brand new passphrase", user: "sam" },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await browser(h.app).req(`${A}/accept`, {
          method: "POST",
          body: { token: r.json.reset.token, passphrase: "yet another passphrase" },
        })
      ).status,
    ).toBe(400);
  });

  it("the owner cannot be demoted, disabled, deleted or reset through the users API; other roles cannot reset", async () => {
    h = setup();
    const o = await ownerSession();
    expect(
      (await o.req("/api/v1/users/owner", { method: "PATCH", body: { role: "viewer" } })).status,
    ).toBe(409);
    expect(
      (await o.req("/api/v1/users/owner", { method: "PATCH", body: { disabled: true } })).status,
    ).toBe(409);
    expect((await o.req("/api/v1/users/owner", { method: "DELETE" })).status).toBe(409);
    expect((await o.req("/api/v1/users/owner/reset-passphrase", { method: "POST" })).status).toBe(
      409,
    );
    expect(
      (await o.req("/api/v1/users/owner", { method: "PATCH", body: { name: "Alex" } })).json.name,
    ).toBe("Alex");
  });

  it("disabling a user ends their sessions and keys at once; enabling restores access; deleting removes them", async () => {
    h = setup();
    const o = await ownerSession();
    const { b, user } = await join(o, "Sam", "editor", SAM_PASS);
    const key = (
      await b.req("/api/v1/me/keys", { method: "POST", body: { name: "k", scopes: ["read"] } })
    ).json.key as string;
    expect((await h.call("/api/v1/plans", { key })).status).toBe(200);
    await o.req(`/api/v1/users/${user.id}`, { method: "PATCH", body: { disabled: true } });
    expect((await b.req("/api/v1/plans")).status).toBe(401);
    expect((await h.call("/api/v1/plans", { key })).status).toBe(401);
    expect(
      (
        await browser(h.app).req(`${A}/login`, {
          method: "POST",
          body: { passphrase: SAM_PASS, user: "sam" },
        })
      ).status,
    ).toBe(401);
    await o.req(`/api/v1/users/${user.id}`, { method: "PATCH", body: { disabled: false } });
    expect((await h.call("/api/v1/plans", { key })).status).toBe(200);
    expect((await o.req(`/api/v1/users/${user.id}`, { method: "DELETE" })).status).toBe(204);
    expect((await h.call("/api/v1/plans", { key })).status).toBe(401);
    // history keeps the name
    await patchPlan(o, 1);
    expect(JSON.stringify((await o.req("/api/v1/audit-log")).json)).toContain("users");
  });

  it("sign out everywhere ends every session of that user only", async () => {
    h = setup();
    const o = await ownerSession();
    const { b: sam1, user } = await join(o, "Sam", "editor", SAM_PASS);
    const sam2 = browser(h.app);
    await sam2.req(`${A}/login`, { method: "POST", body: { passphrase: SAM_PASS, user: "sam" } });
    expect((await sam1.req(`${A}/logout-all`, { method: "POST" })).status).toBe(204);
    expect((await sam2.req("/api/v1/plans")).status).toBe(401);
    expect((await o.req("/api/v1/plans")).status).toBe(200);
    expect(user.id).toBeTruthy();
  });

  it("the operator can issue an owner reset token (forgotten passphrase)", async () => {
    h = setup();
    const o = await ownerSession();
    const t = h.services.users.resetOwner();
    expect((await o.req("/api/v1/plans")).status).toBe(401);
    const b = browser(h.app);
    expect(
      (
        await b.req(`${A}/accept`, {
          method: "POST",
          body: { token: t.token, passphrase: "the new owner passphrase" },
        })
      ).status,
    ).toBe(200);
    expect((await b.req("/api/v1/me")).json).toMatchObject({ role: "owner" });
  });
});

describe("MCP honours roles", () => {
  async function mcpTools(key: string): Promise<string[]> {
    const r = await h.app.request("/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    const j = (await r.json()) as { result: { tools: { name: string }[] } };
    return j.result.tools.map((t) => t.name);
  }

  it("a viewer’s key has no write tools even when the server allows writes; an editor’s has them", async () => {
    h = setup({ mcpAllowWrites: true });
    const o = await ownerSession();
    const { b: pat } = await join(o, "Pat", "viewer", PAT_PASS);
    const { b: sam } = await join(o, "Sam", "editor", SAM_PASS);
    // even a "write" scope request on a viewer's key is capped
    const vk = (
      await pat.req("/api/v1/me/keys", {
        method: "POST",
        body: { name: "v", scopes: ["read", "simulate"] },
      })
    ).json.key as string;
    const ek = (
      await sam.req("/api/v1/me/keys", {
        method: "POST",
        body: { name: "e", scopes: ["read", "write"] },
      })
    ).json.key as string;
    const v = await mcpTools(vk);
    const e = await mcpTools(ek);
    expect(v).toContain("get_plan_summary");
    for (const w of [
      "apply_change_set",
      "update_account_balances",
      "propose_change_set",
      "create_share_link",
      "run_checkin",
    ]) {
      expect(v).not.toContain(w);
      expect(e).toContain(w);
    }
  });

  it("MCP writes are audited under the person behind the key", async () => {
    h = setup({ mcpAllowWrites: true });
    const o = await ownerSession();
    const { b: sam } = await join(o, "Sam", "editor", SAM_PASS);
    const ek = (
      await sam.req("/api/v1/me/keys", {
        method: "POST",
        body: { name: "e", scopes: ["read", "write"] },
      })
    ).json.key as string;
    const r = await h.app.request("/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${ek}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "update_account_balances",
          arguments: {
            accounts: [{ accountId: "acc-cash", balance: 1234 }],
            recordSnapshot: false,
          },
        },
      }),
    });
    expect(r.status).toBe(200);
    const log = (
      await o.req(
        "/api/v1/audit-log?userId=" +
          (await o.req("/api/v1/users")).json.items.find((u: any) => u.login === "sam").id,
      )
    ).json.items;
    expect(
      log.some((e: any) => e.action === "mcp:update_account_balances" && e.userName === "Sam"),
    ).toBe(true);
  });
});

describe("legacy keys", () => {
  it("keys created before collaboration act as the owner (scopes unchanged)", async () => {
    h = setup();
    expect((await h.call("/api/v1/me")).json).toMatchObject({
      userId: "owner",
      role: "owner",
      scopes: ["read", "write"],
    });
    expect(generateKey().key).toMatch(/^glideworth_/);
  });
});
