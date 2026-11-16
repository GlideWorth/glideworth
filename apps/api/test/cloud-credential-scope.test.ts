/**
 * Regressions from the pre-launch security review (docs/launch/security-review.md):
 *
 *  - an OAuth access token is a credential for `/mcp` only; the REST API refuses it, so it can neither write
 *    while the workspace's "MCP writes" switch is off nor mint an API key without re-authentication;
 *  - made-up share tokens naming a real workspace do not use up that workspace's daily share-read quota;
 *  - a password reset revokes the person's connected apps (OAuth grants) in every workspace they belong to,
 *    leaves their API keys and other members' grants working, and still succeeds when a workspace cannot be
 *    opened: that workspace's grants are revoked before its next request is served.
 */
import { controlSchema } from "@glideworth/cloud";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  apiKey,
  bootCloud,
  CAPTCHA,
  Client,
  type Cloud,
  exchangeCode,
  lastMail,
  markedSample,
  oauthCode,
  oauthTokens,
  PUBLIC_URL,
  signUp,
  tokenIn,
} from "./cloud-harness.js";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

const SHARE_READS_PER_DAY = 5;
let cloud: Cloud;
beforeAll(async () => {
  cloud = await bootCloud({ limits: { shareReadsPerDay: SHARE_READS_PER_DAY } });
}, 120_000);
afterAll(async () => {
  await cloud?.close();
}, 120_000);

describe("credential scope in cloud mode", () => {
  it("an OAuth access token works at /mcp and is a 401 on the REST API", async () => {
    const o = await signUp(cloud);
    const b = o.browser;
    // The session alone cannot mint a write key: that needs a recent re-authentication.
    const direct = await b.post("/api/v1/me/keys", { name: "k", scopes: ["read", "write"] });
    expect(direct.status).toBe(403);
    expect(direct.json.error.code).toBe("REAUTH_REQUIRED");

    // Consent needs only the session, so the token it yields must not be a way around that.
    const t = await oauthTokens(cloud, b, o.accountId as string);
    const bearer = new Client(cloud).withBearer(t.access);
    const list = await bearer.post(
      "/mcp",
      { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
      { headers: { accept: "application/json, text/event-stream" } },
    );
    expect(list.status).toBe(200);

    const key = await bearer.post("/api/v1/me/keys", {
      name: "via-oauth",
      scopes: ["read", "write"],
    });
    expect(key.status).toBe(401);
    expect(
      (await bearer.post("/api/v1/import", { data: markedSample("Scope", 1234) })).status,
    ).toBe(401);
    expect((await bearer.get("/api/v1/households")).status).toBe(401);
  });

  it("made-up share tokens for a real workspace do not use up its share-read quota", async () => {
    const o = await signUp(cloud);
    const b = o.browser;
    await b.post("/api/v1/import", { data: markedSample("Share", 999) });
    const planId = (await b.get("/api/v1/plans")).json.items[0].id as string;
    const s = await b.post(`/api/v1/plans/${planId}/share-links`, { includeSuccessRate: false });
    expect(s.status).toBe(201);
    const token = s.json.token as string;

    const anon = new Client(cloud);
    anon.rotateIp = true;
    const junk = `gws_${o.accountId}_${"a".repeat(52)}`;
    for (let i = 0; i < SHARE_READS_PER_DAY * 3; i++) {
      const r = await anon.get(`/api/v1/shared/${junk}`);
      expect(r.status).toBe(404);
    }
    // The real link still has its whole quota, and the quota still applies to it.
    for (let i = 0; i < SHARE_READS_PER_DAY; i++)
      expect((await anon.get(`/api/v1/shared/${token}`)).status).toBe(200);
    const over = await anon.get(`/api/v1/shared/${token}`);
    expect(over.status).toBe(429);
    expect(over.json.error.code).toBe("QUOTA_EXCEEDED");
  });

  const NEW_PASSWORD = "an entirely different passphrase 77";
  const mcpList = (access: string) =>
    new Client(cloud)
      .withBearer(access)
      .post(
        "/mcp",
        { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
        { headers: { accept: "application/json, text/event-stream" } },
      );
  const refresh = (t: { clientId: string; refresh: string }) =>
    new Client(cloud).req("POST", "/oauth/token", {
      form: {
        grant_type: "refresh_token",
        refresh_token: t.refresh,
        client_id: t.clientId,
        resource: `${PUBLIC_URL}/mcp`,
      },
    });
  /** Forgot password, the emailed link, a new password. */
  async function resetPassword(email: string) {
    const anon = new Client(cloud);
    const forgot = await anon.post("/api/v1/auth/password/forgot", {
      email,
      captchaToken: CAPTCHA,
    });
    expect(forgot.status, forgot.text).toBeLessThan(300);
    await cloud.rt.accounts.settled();
    const mail = lastMail(cloud, email, "password-reset");
    if (!mail) throw new Error("no password-reset email");
    const r = await anon.post("/api/v1/auth/password/reset", {
      token: tokenIn(mail.text),
      password: NEW_PASSWORD,
    });
    await cloud.rt.accounts.settled();
    return r;
  }
  const revocationsAudited = (accountId: string, userId: string) =>
    cloud.rt.db
      .select()
      .from(controlSchema.auditEvents)
      .where(
        and(
          eq(controlSchema.auditEvents.accountId, accountId),
          eq(controlSchema.auditEvents.subjectUserId, userId),
          eq(controlSchema.auditEvents.event, "member.connected_apps_revoked"),
        ),
      )
      .all();

  it("a password reset revokes the person's connected apps in every workspace; API keys and other members' apps keep working", async () => {
    // The editor belongs to two workspaces: their own (from sign-up) and the owner's (by invitation).
    const owner = await signUp(cloud, { name: "Olive Owner" });
    const shared = owner.accountId as string;
    const ed = await signUp(cloud, { name: "Eddie Editor" });
    const own = ed.accountId as string;
    const inv = await owner.browser.post("/api/v1/workspace/invitations", {
      email: ed.email,
      role: "editor",
    });
    expect(inv.status, inv.text).toBeLessThan(300);
    await cloud.rt.accounts.settled();
    await cloud.rt.outbox.drain();
    const invitation = lastMail(cloud, ed.email, "invitation");
    if (!invitation) throw new Error("no invitation email");
    const accepted = await ed.browser.post("/api/v1/workspace/invitations/accept", {
      token: tokenIn(invitation.text),
    });
    expect(accepted.status, accepted.text).toBe(200);
    const status = await ed.browser.get("/api/v1/auth/status");
    expect((status.json.workspaces as Array<{ id: string }>).map((w) => w.id).sort()).toEqual(
      [shared, own].sort(),
    );

    const ownerTokens = await oauthTokens(cloud, owner.browser, shared);
    const inShared = await oauthTokens(cloud, ed.browser, shared);
    const inOwn = await oauthTokens(cloud, ed.browser, own);
    const key = new Client(cloud).withBearer(await apiKey(ed.browser));
    for (const t of [ownerTokens, inShared, inOwn])
      expect((await mcpList(t.access)).status).toBe(200);
    expect((await key.get("/api/v1/households")).status).toBe(200);

    const reset = await resetPassword(ed.email);
    expect(reset.status, reset.text).toBe(200);

    // The editor's grants are gone in both workspaces: access token, then the refresh-token exchange.
    for (const t of [inShared, inOwn]) {
      expect((await mcpList(t.access)).status).toBe(401);
      const again = await refresh(t);
      expect(again.status).toBe(400);
      expect(again.json.error).toBe("invalid_grant");
    }
    // Their API key still works, and so does the other member's connected app in the same workspace.
    expect((await key.get("/api/v1/households")).status).toBe(200);
    expect((await mcpList(ownerTokens.access)).status).toBe(200);
    const ownerAgain = await refresh(ownerTokens);
    expect(ownerAgain.status, ownerAgain.text).toBe(200);

    // Recorded once in each workspace's audit trail, and nothing is left owed.
    for (const accountId of [shared, own]) {
      const events = revocationsAudited(accountId, ed.userId);
      expect(events).toHaveLength(1);
      expect(events[0]?.detail).toEqual({ reason: "password_reset", count: 1 });
    }
    expect(revocationsAudited(shared, owner.userId)).toHaveLength(0);
    const owed = cloud.rt.db
      .select()
      .from(controlSchema.memberships)
      .where(eq(controlSchema.memberships.userId, ed.userId))
      .all()
      .filter((m) => m.oauthRevokePendingAt !== null);
    expect(owed).toHaveLength(0);
    expect(lastMail(cloud, ed.email, "security-change")?.text).toContain("API keys still work");

    // A grant made after the reset is not affected by it.
    const signedIn = new Client(cloud);
    const signin = await signedIn.post("/api/v1/auth/signin", {
      email: ed.email,
      password: NEW_PASSWORD,
    });
    expect(signin.status, signin.text).toBe(200);
    const fresh = await oauthTokens(cloud, signedIn, shared);
    expect((await mcpList(fresh.access)).status).toBe(200);
  });

  it("an unused authorization code issued before a reset cannot be exchanged after it", async () => {
    const o = await signUp(cloud);
    const pending = await oauthCode(cloud, o.browser, o.accountId as string);
    const reset = await resetPassword(o.email);
    expect(reset.status, reset.text).toBe(200);
    const tok = await exchangeCode(cloud, pending);
    expect(tok.status).toBe(400);
    expect(tok.json.error).toBe("invalid_grant");
  });

  it("a reset succeeds when a workspace cannot be opened, and that workspace's grants are revoked before it serves again", async () => {
    const o = await signUp(cloud);
    const accountId = o.accountId as string;
    const t = await oauthTokens(cloud, o.browser, accountId);
    const key = new Client(cloud).withBearer(await apiKey(o.browser));
    const setStatus = (status: "active" | "migration_failed") =>
      cloud.rt.db
        .update(controlSchema.accounts)
        .set({ status })
        .where(eq(controlSchema.accounts.id, accountId))
        .run();

    setStatus("migration_failed");
    const reset = await resetPassword(o.email);
    expect(reset.status, reset.text).toBe(200);
    expect(revocationsAudited(accountId, o.userId)).toHaveLength(0);

    // The workspace comes back: nothing ran in between, yet the old grant never works again.
    setStatus("active");
    expect((await mcpList(t.access)).status).toBe(401);
    const again = await refresh(t);
    expect(again.status).toBe(400);
    expect(again.json.error).toBe("invalid_grant");
    expect((await key.get("/api/v1/households")).status).toBe(200);
    expect(revocationsAudited(accountId, o.userId)).toHaveLength(1);
  });
});
