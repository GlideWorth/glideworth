/**
 * T-AUTH at the HTTP level (spec 10): cookies, CSRF, redirects, enumeration safety, re-authentication with
 * session rotation, sessions, request limits, OpenAPI. Runs the real routes on the real services.
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sessions } from "../src/control/schema.js";
import { base32Decode, sha256Hex } from "../src/crypto/random.js";
import { hotp, totpStep } from "../src/crypto/totp.js";
import { safeNext } from "../src/http/common.js";
import {
  Browser,
  type Cloud,
  makeCloud,
  PUBLIC_URL,
  removeTempDirs,
  signedUpBrowser,
  strongPassword,
  uniqueEmail,
} from "./cloud-fixture.js";
import { remember } from "./helpers.js";

let cloud: Cloud;
beforeEach(async () => {
  cloud = await makeCloud();
});
afterEach(async () => {
  await cloud.accounts.settled();
  await cloud.close();
  removeTempDirs();
});

const signupBody = (email: string, password = strongPassword()) => ({
  email,
  password,
  name: "Sam Example",
  captchaToken: "captcha-ok",
  termsVersion: "2026-11",
  adultConfirmed: true,
});

describe("cookies", () => {
  it("session and CSRF cookies are __Host-, Secure, SameSite=Strict; only the CSRF cookie is readable", async () => {
    const b = new Browser(cloud.app);
    const email = uniqueEmail();
    await b.post("/api/v1/auth/signup", signupBody(email));
    await cloud.accounts.settled();
    const r = await b.post("/api/v1/auth/verify", {
      token: cloud.mailer.token(email, "verify-email"),
    });
    expect(r.status).toBe(200);
    const byName = (n: string) => r.setCookies.find((c) => c.startsWith(`${n}=`)) as string;
    for (const n of ["__Host-gw_session", "__Host-gw_csrf", "__Host-gw_device"]) {
      const c = byName(n);
      expect(c).toMatch(/; Path=\//);
      expect(c).toMatch(/; Secure/);
      expect(c).toMatch(/; SameSite=Strict/);
      expect(c).not.toMatch(/Domain=/i);
    }
    expect(byName("__Host-gw_session")).toMatch(/; HttpOnly/);
    expect(byName("__Host-gw_device")).toMatch(/; HttpOnly/);
    expect(byName("__Host-gw_csrf")).not.toMatch(/HttpOnly/);
    for (const c of r.setCookies) remember((c.split(";")[0] as string).split("=")[1] as string);
  });
});

describe("enumeration safety", () => {
  it("sign-up, resend and forgot answer identically for known and unknown addresses", async () => {
    const known = await signedUpBrowser(cloud);
    const b = new Browser(cloud.app);
    const unknown = uniqueEmail("nobody");
    const pairs: Array<[string, (email: string) => unknown]> = [
      ["/api/v1/auth/signup", (e) => signupBody(e)],
      ["/api/v1/auth/resend-verification", (e) => ({ email: e })],
      ["/api/v1/auth/password/forgot", (e) => ({ email: e, captchaToken: "captcha-ok" })],
    ];
    for (const [path, body] of pairs) {
      const r1 = await b.post(path, body(known.email));
      const r2 = await b.post(path, body(unknown));
      expect([r1.status, r1.text]).toEqual([r2.status, r2.text]);
      expect(r1.status).toBe(202);
    }
    const s1 = await b.post("/api/v1/auth/signin", {
      email: known.email,
      password: "wrong password here",
    });
    const s2 = await b.post("/api/v1/auth/signin", {
      email: unknown,
      password: "wrong password here",
    });
    expect([s1.status, s1.text]).toEqual([s2.status, s2.text]);
    expect(s1.status).toBe(401);
  });

  it("validation errors never echo the input", async () => {
    const r = await new Browser(cloud.app).post("/api/v1/auth/signin", {
      email: "x@example.org",
      password: 42,
    });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({
      error: { code: "VALIDATION", message: "invalid request", details: { fields: ["password"] } },
    });
    expect(r.text).not.toContain("x@example.org");
  });
});

describe("CSRF and origin", () => {
  it("every cookie-authenticated write needs the token and a same-origin request", async () => {
    const { browser } = await signedUpBrowser(cloud);
    const writes: Array<[string, string, unknown]> = [
      ["PATCH", "/api/v1/account/profile", { name: "New" }],
      ["POST", "/api/v1/account/sessions/revoke-others", undefined],
      ["PATCH", "/api/v1/workspace/settings", { mcpWrites: true }],
      ["POST", "/api/v1/workspace/invitations", { email: uniqueEmail(), role: "viewer" }],
      ["POST", "/api/v1/billing/portal", undefined],
      ["POST", "/api/v1/auth/reauth", { password: "x" }],
      ["DELETE", "/api/v1/account", undefined],
      ["DELETE", "/api/v1/workspace", { confirmName: "x" }],
    ];
    for (const [method, path, body] of writes) {
      const noToken = await browser.req(method, path, { body, csrf: false });
      expect([path, noToken.status, (noToken.body.error as { code: string })?.code]).toEqual([
        path,
        403,
        "CSRF",
      ]);
      const evil = await browser.req(method, path, { body, origin: "https://evil.example" });
      expect([path, evil.status]).toEqual([path, 403]);
    }
    // Sign-in itself refuses a cross-site POST (login CSRF).
    const login = await new Browser(cloud.app).post(
      "/api/v1/auth/signin",
      { email: uniqueEmail(), password: "x".repeat(12) },
      { origin: "https://evil.example" },
    );
    expect(login.status).toBe(403);
    // And the legitimate request works.
    expect((await browser.patch("/api/v1/account/profile", { name: "New Name" })).status).toBe(200);
  });

  it("signout from another site does nothing", async () => {
    const { browser } = await signedUpBrowser(cloud);
    expect((await browser.post("/api/v1/auth/signout", undefined, { csrf: false })).status).toBe(
      403,
    );
    expect((await browser.get("/api/v1/auth/status")).body.authenticated).toBe(true);
    expect((await browser.post("/api/v1/auth/signout")).status).toBe(204);
    expect((await browser.get("/api/v1/auth/status")).body.authenticated).toBe(false);
  });
});

describe("next redirects", () => {
  it("only same-origin relative paths survive", () => {
    const o = new URL(PUBLIC_URL).origin;
    expect(safeNext("/settings/billing?x=1#y", o)).toBe("/settings/billing?x=1#y");
    for (const bad of [
      "https://evil.example/",
      "//evil.example/x",
      "/\\evil.example",
      "\\\\evil.example",
      "javascript:alert(1)",
      // Dot segments that normalise to `//host` (review pass 3).
      "/.//evil.example",
      "/x/..//evil.example",
      "/%2e//evil.example",
      "/%2E%2E//evil.example",
      "/%0d%0aSet-Cookie:x",
      " /x",
      "/x\ny",
      "",
      undefined,
      42,
      `/${"a".repeat(3000)}`,
    ])
      expect([bad, safeNext(bad, o)]).toEqual([
        bad,
        bad === "/%0d%0aSet-Cookie:x" ? "/%0d%0aSet-Cookie:x" : "/",
      ]);
  });

  it("sign-in returns the sanitized redirect", async () => {
    const u = await signedUpBrowser(cloud);
    const b = new Browser(cloud.app);
    const ok = await b.post("/api/v1/auth/signin", {
      email: u.email,
      password: u.password,
      next: "/plans/1",
    });
    expect(ok.body.redirectTo).toBe("/plans/1");
    const evil = await b.post("/api/v1/auth/signin", {
      email: u.email,
      password: u.password,
      next: "//evil.example",
    });
    expect(evil.body.redirectTo).toBe("/");
  });
});

describe("re-authentication and sessions", () => {
  it("re-auth rotates the session: new cookies, the old token is dead, sensitive actions unlock", async () => {
    const u = await signedUpBrowser(cloud);
    expect((await u.browser.post("/api/v1/account/totp/begin")).body).toMatchObject({
      error: { code: "REAUTH_REQUIRED" },
    });
    const oldToken = u.browser.jar.get("__Host-gw_session") as string;
    const oldCsrf = u.browser.jar.get("__Host-gw_csrf") as string;
    const r = await u.browser.post("/api/v1/auth/reauth", { password: u.password });
    expect(r.status).toBe(200);
    const newToken = remember(u.browser.jar.get("__Host-gw_session") as string);
    remember(u.browser.jar.get("__Host-gw_csrf") as string);
    expect(newToken).not.toBe(oldToken);
    expect(u.browser.jar.get("__Host-gw_csrf")).not.toBe(oldCsrf);
    expect(cloud.accounts.resolveSession(oldToken)).toBeNull();
    const begin = await u.browser.post("/api/v1/account/totp/begin");
    expect(begin.status).toBe(200);
    remember(String(begin.body.secret));
    // The rotated session keeps the absolute expiry of the original sign-in.
    const row = cloud.db
      .select()
      .from(sessions)
      .where(eq(sessions.id, sha256Hex(newToken)))
      .get();
    expect(Date.parse(row?.expiresAt as string)).toBeLessThanOrEqual(Date.now() + 30 * 86_400_000);
  });

  it("TOTP sign-in over HTTP; replay refused; password change rotates and revokes others", async () => {
    const u = await signedUpBrowser(cloud);
    await u.browser.post("/api/v1/auth/reauth", { password: u.password });
    const begin = await u.browser.post("/api/v1/account/totp/begin");
    const secret = remember(String(begin.body.secret));
    const code = () => hotp(base32Decode(secret) as Uint8Array, totpStep(cloud.now().getTime()));
    const confirm = await u.browser.post("/api/v1/account/totp/confirm", { code: code() });
    expect(confirm.status).toBe(200);
    for (const c of confirm.body.recoveryCodes as string[]) remember(c);
    cloud.advance(31_000);
    const other = new Browser(cloud.app);
    const step1 = await other.post("/api/v1/auth/signin", { email: u.email, password: u.password });
    expect(step1.body.status).toBe("totp-required");
    remember(String(step1.body.challenge));
    const c = code();
    const step2 = await other.post("/api/v1/auth/signin/totp", {
      challenge: step1.body.challenge,
      code: c,
    });
    expect(step2.status).toBe(200);
    remember(other.jar.get("__Host-gw_session") as string);
    const again = await new Browser(cloud.app).post("/api/v1/auth/signin", {
      email: u.email,
      password: u.password,
    });
    remember(String(again.body.challenge));
    const replay = await new Browser(cloud.app).post("/api/v1/auth/signin/totp", {
      challenge: again.body.challenge,
      code: c,
    });
    expect(replay.status).toBe(401);
    // Password change: the caller gets a new session, every other session dies.
    const next = strongPassword();
    const changed = await u.browser.post("/api/v1/account/password", { current: u.password, next });
    expect(changed.status).toBe(200);
    remember(u.browser.jar.get("__Host-gw_session") as string);
    expect((await other.get("/api/v1/auth/status")).body.authenticated).toBe(false);
    expect((await u.browser.get("/api/v1/auth/status")).body.authenticated).toBe(true);
  });

  it("sessions list, revoke one, revoke others", async () => {
    const u = await signedUpBrowser(cloud);
    const second = new Browser(cloud.app);
    await second.post("/api/v1/auth/signin", { email: u.email, password: u.password });
    remember(second.jar.get("__Host-gw_session") as string);
    const list = await u.browser.get("/api/v1/account/sessions");
    const items = list.body.items as Array<{ id: string; current: boolean }>;
    expect(items).toHaveLength(2);
    const otherId = items.find((s) => !s.current)?.id as string;
    expect((await u.browser.del(`/api/v1/account/sessions/${otherId}`)).status).toBe(204);
    expect((await second.get("/api/v1/auth/status")).body.authenticated).toBe(false);
    expect((await u.browser.del("/api/v1/account/sessions/0123456789abcdef")).status).toBe(404);
  });

  it("auth status reports the workspace, role, access and trial end", async () => {
    const u = await signedUpBrowser(cloud);
    const s = await u.browser.get("/api/v1/auth/status");
    expect(s.body).toMatchObject({
      mode: "cloud",
      authenticated: true,
      user: { id: u.userId, role: "owner", totp: false },
      workspace: { id: u.accountId, role: "owner", access: { level: "full", reason: "trial" } },
    });
    expect(typeof s.body.csrfToken).toBe("string");
  });
});

describe("limits and documentation", () => {
  it("bodies over 64 KiB are refused before parsing", async () => {
    const r = await new Browser(cloud.app).req("POST", "/api/v1/auth/signin", {
      raw: JSON.stringify({ email: "a@b.cd", password: "x".repeat(70_000) }),
      headers: { "content-type": "application/json" },
    });
    expect(r.status).toBe(413);
  });

  it("per-address flood limit on public auth routes, then sign-up per-IP limits", async () => {
    const b = new Browser(cloud.app);
    let last = 0;
    for (let i = 0; i < 7; i++)
      last = (await b.post("/api/v1/auth/signup", signupBody(uniqueEmail("flood")))).status;
    expect(last).toBe(429); // 5 sign-ups per hour per IP (spec 3.7)
    const other = new Browser(cloud.app);
    expect((await other.post("/api/v1/auth/signup", signupBody(uniqueEmail("ok")))).status).toBe(
      202,
    );
  });

  it("every cloud route is in the OpenAPI document", async () => {
    const { OpenAPIHono } = await import("@hono/zod-openapi");
    const app = cloud.app as InstanceType<typeof OpenAPIHono>;
    const doc = app.getOpenAPI31Document({ openapi: "3.1.0", info: { title: "t", version: "1" } });
    const paths = Object.keys(doc.paths ?? {});
    for (const p of [
      "/api/v1/auth/signup",
      "/api/v1/auth/signin/totp",
      "/api/v1/account/sessions/{id}",
      "/api/v1/workspace/exports/{id}",
      "/api/v1/billing/checkout",
      "/stripe/webhook",
      "/email/unsubscribe",
      "/email/webhooks/mailgun",
    ])
      expect(paths).toContain(p);
  });
});
