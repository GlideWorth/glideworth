/**
 * "Sign in with Google" end to end over the real cloud routes and services, with the in-process fake OpenID
 * provider (test/fake-oidc.ts): the identity-mapping rules, two-factor, accounts without a password, linking and
 * unlinking, and the attack cases (state, PKCE, code replay, login CSRF, open redirects, forged tokens, email
 * collisions in both directions). Nothing here talks to Google.
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  auditEvents,
  oidcFlows,
  trialGrants,
  userIdentities,
  users,
  userTokens,
} from "../src/control/schema.js";
import { base32Decode } from "../src/crypto/random.js";
import { hotp, totpStep } from "../src/crypto/totp.js";
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
import { FakeOidcProvider, type FakeUser, googleUser } from "./fake-oidc.js";
import { assertAuditClean, logLines, remember } from "./helpers.js";

let cloud: Cloud;
let op: FakeOidcProvider;

beforeEach(async () => {
  op = new FakeOidcProvider(() => cloud.now());
  cloud = await makeCloud({
    google: {
      issuer: op.issuer,
      clientId: op.clientId,
      clientSecret: op.clientSecret,
      fetch: op.fetch,
    },
  });
});
afterEach(async () => {
  await cloud.accounts.settled();
  assertAuditClean(cloud.db);
  await cloud.close();
  removeTempDirs();
});

// ------------------------------------------------------------------------------------------- helpers
const loc = (r: { headers: Headers }) => r.headers.get("location") ?? "";
const cookieLine = (r: { setCookies: string[] }, name: string) =>
  r.setCookies.find((c) => c.startsWith(`${name}=`)) ?? "";

async function start(b: Browser, next?: string): Promise<string> {
  const r = await b.get(
    `/api/v1/auth/google/start${next === undefined ? "" : `?next=${encodeURIComponent(next)}`}`,
  );
  expect(r.status, r.text).toBe(302);
  return loc(r);
}

/** The button, Google, and the callback in one browser. */
async function viaGoogle(b: Browser, u: FakeUser, next?: string) {
  const url = await start(b, next);
  return b.get(op.authorize(url, u));
}

async function signUpWithGoogle(b: Browser, u: FakeUser, name = "Gwen Googler") {
  const cb = await viaGoogle(b, u);
  expect(loc(cb)).toBe("/signup/google");
  const r = await b.post("/api/v1/auth/google/complete", {
    name,
    termsVersion: "2026-11",
    adultConfirmed: true,
  });
  expect(r.status, r.text).toBe(200);
  remember(b.jar.get("__Host-gw_session") as string);
  remember(b.jar.get("__Host-gw_csrf") as string);
  const status = await b.get("/api/v1/auth/status");
  return { status: status.body, user: userOf(u.email) };
}

const userOf = (email: string) =>
  cloud.db.select().from(users).where(eq(users.emailNormalized, email.toLowerCase())).get();
const identities = () => cloud.db.select().from(userIdentities).all();
const status = async (b: Browser) => (await b.get("/api/v1/auth/status")).body;
const reauth = (b: Browser, password: string) => b.post("/api/v1/auth/reauth", { password });

async function link(b: Browser, password: string, u: FakeUser) {
  expect((await reauth(b, password)).status).toBe(200);
  remember(b.jar.get("__Host-gw_session") as string);
  remember(b.jar.get("__Host-gw_csrf") as string);
  const r = await b.post("/api/v1/account/identities/google");
  expect(r.status, r.text).toBe(200);
  return b.get(op.authorize(r.body.url as string, u));
}

async function enableTotp(b: Browser, password: string): Promise<() => string> {
  await reauth(b, password);
  remember(b.jar.get("__Host-gw_session") as string);
  remember(b.jar.get("__Host-gw_csrf") as string);
  const begin = await b.post("/api/v1/account/totp/begin");
  const secret = remember(String(begin.body.secret));
  const code = () => hotp(base32Decode(secret) as Uint8Array, totpStep(cloud.now().getTime()));
  const confirm = await b.post("/api/v1/account/totp/confirm", { code: code() });
  expect(confirm.status).toBe(200);
  for (const c of confirm.body.recoveryCodes as string[]) remember(c);
  cloud.advance(31_000);
  return code;
}

// ------------------------------------------------------------------------------------ the button
describe("starting the flow", () => {
  it("redirects to the provider with the fixed redirect URI and sets a short-lived, __Host-, Lax, HttpOnly binding cookie", async () => {
    const b = new Browser(cloud.app);
    // A forged Host or X-Forwarded-Host never changes the redirect URI, and a redirect_uri parameter is ignored.
    const r = await b.get(
      "/api/v1/auth/google/start?redirect_uri=https%3A%2F%2Fevil.example%2Fcb&next=/plans/1",
      { headers: { host: "evil.example", "x-forwarded-host": "evil.example" } },
    );
    expect(r.status).toBe(302);
    const u = new URL(loc(r));
    expect(`${u.origin}${u.pathname}`).toBe(op.endpoints.authorization);
    expect(u.searchParams.get("redirect_uri")).toBe(`${PUBLIC_URL}/api/v1/auth/google/callback`);
    expect(u.searchParams.get("scope")).toBe("openid email profile");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(loc(r)).not.toContain("evil.example");
    const c = cookieLine(r, "__Host-gw_oidc");
    expect(c).toMatch(/; Max-Age=600/);
    expect(c).toMatch(/; Path=\//);
    expect(c).toMatch(/; HttpOnly/);
    expect(c).toMatch(/; Secure/);
    expect(c).toMatch(/; SameSite=Lax/);
    expect(c).not.toMatch(/Domain=/i);
    expect(r.headers.get("referrer-policy")).toBe("no-referrer");
    // The state lives server side: sealed, nothing readable stored.
    const row = cloud.db.select().from(oidcFlows).get();
    expect(row?.kind).toBe("authorize");
    expect(row?.payloadEnc).not.toContain(u.searchParams.get("nonce") as string);
  });

  it("auth status says Google sign-in is available", async () => {
    expect((await status(new Browser(cloud.app))).googleSignIn).toBe(true);
  });
});

// ----------------------------------------------------------------------------- identity mapping
describe("identity mapping", () => {
  it("unknown subject, unknown address: no account until the sign-up step is confirmed; then a verified, password-less account with a workspace and trial", async () => {
    const b = new Browser(cloud.app);
    const g = googleUser();
    const usersBefore = cloud.db.select().from(users).all().length;
    const cb = await viaGoogle(b, g);
    expect(cb.status).toBe(302);
    expect(loc(cb)).toBe("/signup/google");
    // The binding cookie is cleared; the parked sign-up cookie is Strict.
    expect(cookieLine(cb, "__Host-gw_oidc")).toMatch(/Max-Age=0/);
    expect(cookieLine(cb, "__Host-gw_oidc_signup")).toMatch(/SameSite=Strict/);
    expect(cookieLine(cb, "__Host-gw_session")).toBe("");
    expect(cloud.db.select().from(users).all()).toHaveLength(usersBefore);

    const pending = await b.get("/api/v1/auth/google/pending");
    expect(pending.body).toEqual({ name: g.name, email: g.email });

    // The sign-up rules: adults only and a terms version, checked before anything is created.
    const noAdult = await b.post("/api/v1/auth/google/complete", {
      name: "Gwen",
      termsVersion: "2026-11",
      adultConfirmed: false,
    });
    expect(noAdult.status).toBe(400);
    const noTerms = await b.post("/api/v1/auth/google/complete", {
      name: "Gwen",
      termsVersion: "no spaces allowed",
      adultConfirmed: true,
    });
    expect(noTerms.status).toBe(400);
    expect(cloud.db.select().from(users).all()).toHaveLength(usersBefore);

    const done = await b.post("/api/v1/auth/google/complete", {
      name: "Gwen Edited",
      termsVersion: "2026-11",
      adultConfirmed: true,
    });
    expect(done.status, done.text).toBe(200);
    expect(done.body).toMatchObject({ status: "signed-in", redirectTo: "/" });
    remember(b.jar.get("__Host-gw_session") as string);
    remember(b.jar.get("__Host-gw_csrf") as string);
    const s = await status(b);
    expect(s).toMatchObject({
      authenticated: true,
      user: { name: "Gwen Edited", password: false, google: true, totp: false },
      workspace: { role: "owner", access: { level: "full", reason: "trial" } },
    });
    const row = userOf(g.email);
    expect(row?.passwordHash).toBe("");
    expect(row?.emailVerifiedAt).not.toBeNull();
    expect(row?.termsVersion).toBe("2026-11");
    expect(row?.adultConfirmedAt).not.toBeNull();
    const idn = identities();
    expect(idn).toEqual([
      expect.objectContaining({ userId: row?.id, provider: "google", subject: g.sub }),
    ]);
    const events = cloud.db.select().from(auditEvents).all();
    expect(events.filter((e) => e.subjectUserId === row?.id).map((e) => e.event)).toEqual(
      expect.arrayContaining(["user.signup", "user.email_verified", "identity.linked"]),
    );
    // The parked sign-up is single use.
    expect((await b.get("/api/v1/auth/google/pending")).status).toBe(400);
    const again = await b.post("/api/v1/auth/google/complete", {
      name: "x",
      termsVersion: "2026-11",
      adultConfirmed: true,
    });
    expect(again.status).toBe(400);
  });

  it("known subject: signs in as that user, from a new browser, with the alert and audit of a password sign-in", async () => {
    const g = googleUser();
    const first = await signUpWithGoogle(new Browser(cloud.app), g);
    await cloud.accounts.settled();
    cloud.mailer.clear();
    const b = new Browser(cloud.app);
    const cb = await viaGoogle(b, g, "/plans/1");
    expect(loc(cb)).toBe("/plans/1");
    expect(cookieLine(cb, "__Host-gw_session")).toMatch(/SameSite=Strict/);
    remember(b.jar.get("__Host-gw_session") as string);
    expect((await status(b)).user).toMatchObject({ id: first.user?.id });
    await cloud.accounts.settled();
    expect(cloud.mailer.to(g.email, "signin-alert")).toHaveLength(1);
    const events = cloud.db
      .select()
      .from(auditEvents)
      .all()
      .filter((e) => e.event === "user.signin" && e.subjectUserId === first.user?.id);
    expect(events.at(-1)?.detail).toMatchObject({ method: "google", mfa: false });
    expect(identities()[0]?.lastUsedAt).not.toBeNull();
  });

  it("a Google account whose address changed still maps by subject, and the Glideworth address is not changed", async () => {
    const g = googleUser();
    const { user } = await signUpWithGoogle(new Browser(cloud.app), g);
    const moved = { ...g, email: remember(`moved.${Date.now()}@gmail.com`) };
    const b = new Browser(cloud.app);
    const cb = await viaGoogle(b, moved);
    expect(loc(cb)).toBe("/");
    remember(b.jar.get("__Host-gw_session") as string);
    expect((await status(b)).user).toMatchObject({ id: user?.id, email: g.email });
    expect(userOf(g.email)?.id).toBe(user?.id);
    expect(userOf(moved.email)).toBeUndefined();
  });

  it("takeover attempt: a Google account asserting the address of an existing verified account neither signs in nor links", async () => {
    const victim = await signedUpBrowser(cloud);
    const attacker = googleUser({ email: victim.email });
    const b = new Browser(cloud.app);
    const cb = await viaGoogle(b, attacker);
    expect(loc(cb)).toBe("/signin/google-exists");
    expect(cookieLine(cb, "__Host-gw_session")).toBe("");
    expect(cookieLine(cb, "__Host-gw_oidc_signup")).toBe("");
    expect((await status(b)).authenticated).toBe(false);
    expect(identities()).toHaveLength(0);
    // Upper-case and spaced variants are the same address.
    const shouty = googleUser({ email: ` ${victim.email.toUpperCase()} ` });
    expect(loc(await viaGoogle(new Browser(cloud.app), shouty))).toBe("/signin/google-exists");
    expect(identities()).toHaveLength(0);
    // The real owner proves the account with the password, then links from settings.
    const linked = await link(victim.browser, victim.password, googleUser({ email: victim.email }));
    expect(loc(linked)).toBe("/settings/security?google=linked");
    expect(identities()).toHaveLength(1);
  });

  it("takeover attempt: an attacker's unverified password registration of the victim's address is discarded, never merged", async () => {
    const victimEmail = uniqueEmail("victim");
    const attackerPassword = strongPassword();
    const a = new Browser(cloud.app);
    expect(
      (
        await a.post("/api/v1/auth/signup", {
          email: victimEmail,
          password: attackerPassword,
          name: "Attacker",
          captchaToken: "captcha-ok",
          termsVersion: "2026-11",
          adultConfirmed: true,
        })
      ).status,
    ).toBe(202);
    await cloud.accounts.settled();
    const squatterVerifyToken = cloud.mailer.token(victimEmail, "verify-email");
    const squatter = userOf(victimEmail);
    expect(squatter?.emailVerifiedAt).toBeNull();

    // The victim uses Google for the first time.
    const g = googleUser({ email: victimEmail });
    const { user } = await signUpWithGoogle(new Browser(cloud.app), g, "Real Owner");
    expect(user?.id).not.toBe(squatter?.id);
    expect(user?.name).toBe("Real Owner");
    expect(user?.passwordHash).toBe("");
    // The attacker's password opens nothing, and the verification link they triggered is dead.
    const s = await new Browser(cloud.app).post("/api/v1/auth/signin", {
      email: victimEmail,
      password: attackerPassword,
    });
    expect(s.status).toBe(401);
    const v = await new Browser(cloud.app).post("/api/v1/auth/verify", {
      token: squatterVerifyToken,
    });
    expect(v.status).toBe(400);
    expect(
      cloud.db
        .select()
        .from(userTokens)
        .where(eq(userTokens.userId, squatter?.id as string))
        .all(),
    ).toHaveLength(0);
  });

  it("an address that already had a trial gets no second one through Google", async () => {
    const first = await signedUpBrowser(cloud);
    expect(cloud.db.select().from(trialGrants).all().length).toBeGreaterThan(0);
    expect((await reauth(first.browser, first.password)).status).toBe(200);
    remember(first.browser.jar.get("__Host-gw_session") as string);
    remember(first.browser.jar.get("__Host-gw_csrf") as string);
    expect((await first.browser.del("/api/v1/account")).status).toBe(204);
    const { status: s } = await signUpWithGoogle(
      new Browser(cloud.app),
      googleUser({ email: first.email }),
    );
    expect((s.workspace as { access: { reason: string } }).access.reason).not.toBe("trial");
  });

  it("refuses an address Google has not verified, and disposable domains", async () => {
    const b = new Browser(cloud.app);
    expect(loc(await viaGoogle(b, googleUser({ emailVerified: false })))).toBe(
      "/signin?google=unverified",
    );
    expect(loc(await viaGoogle(b, googleUser({ emailVerified: "absent" })))).toBe(
      "/signin?google=unverified",
    );
    expect(
      loc(await viaGoogle(b, googleUser({ email: remember("throwaway@mailinator.com") }))),
    ).toBe("/signin?google=disposable");
    expect(
      cloud.db
        .select()
        .from(oidcFlows)
        .all()
        .filter((f) => f.kind === "pending_signup"),
    ).toHaveLength(0);
  });

  it("the sign-up limits per address apply to Google sign-ups too", async () => {
    const ip = "203.0.113.77";
    let last = 0;
    for (let i = 0; i < 6; i++) {
      const b = new Browser(cloud.app);
      b.ip = ip;
      const cb = await viaGoogle(b, googleUser());
      expect(loc(cb)).toBe("/signup/google");
      const r = await b.post("/api/v1/auth/google/complete", {
        name: "Many",
        termsVersion: "2026-11",
        adultConfirmed: true,
      });
      last = r.status;
      if (r.status === 200) remember(b.jar.get("__Host-gw_session") as string);
    }
    expect(last).toBe(429);
  });

  it("cancelling at Google lands on sign-in with a reason", async () => {
    const b = new Browser(cloud.app);
    const url = await start(b);
    const cb = await b.get(op.authorize(url, googleUser(), { deny: true }));
    expect(loc(cb)).toBe("/signin?google=cancelled");
  });
});

// ------------------------------------------------------------------------------------- two-factor
describe("two-factor and re-authentication", () => {
  it("Google sign-in still asks for the TOTP code: no session until the second step", async () => {
    const u = await signedUpBrowser(cloud);
    const g = googleUser({ email: u.email });
    expect(loc(await link(u.browser, u.password, g))).toBe("/settings/security?google=linked");
    const code = await enableTotp(u.browser, u.password);

    const b = new Browser(cloud.app);
    const cb = await viaGoogle(b, g, "/plans/2");
    const l = loc(cb);
    expect(l.startsWith("/signin/2fa#")).toBe(true);
    expect(cookieLine(cb, "__Host-gw_session")).toBe("");
    expect((await status(b)).authenticated).toBe(false);
    const frag = new URLSearchParams(l.split("#")[1]);
    const challenge = remember(frag.get("challenge") as string);
    expect(frag.get("next")).toBe("/plans/2");

    const wrong = await b.post("/api/v1/auth/signin/totp", { challenge, code: "000000" });
    expect(wrong.status).toBe(401);
    const ok = await b.post("/api/v1/auth/signin/totp", { challenge, code: code() });
    expect(ok.status, ok.text).toBe(200);
    remember(b.jar.get("__Host-gw_session") as string);
    expect((await status(b)).authenticated).toBe(true);
    const ev = cloud.db
      .select()
      .from(auditEvents)
      .all()
      .findLast((e) => e.event === "user.signin");
    expect(ev?.detail).toMatchObject({ method: "google", mfa: true });
  });

  it("a Google sign-in is not a re-authentication: sensitive actions answer REAUTH_REQUIRED", async () => {
    const g = googleUser();
    const b = new Browser(cloud.app);
    await signUpWithGoogle(b, g);
    const fresh = new Browser(cloud.app);
    await viaGoogle(fresh, g);
    remember(fresh.jar.get("__Host-gw_session") as string);
    remember(fresh.jar.get("__Host-gw_csrf") as string);
    for (const [m, p] of [
      ["POST", "/api/v1/account/totp/begin"],
      ["DELETE", "/api/v1/account"],
      ["POST", "/api/v1/account/email"],
    ] as const) {
      const r = await fresh.req(m, p, {
        body: p.endsWith("email") ? { email: uniqueEmail() } : undefined,
      });
      expect([p, r.status, (r.body.error as { code: string }).code]).toEqual([
        p,
        403,
        "REAUTH_REQUIRED",
      ]);
    }
    // No password to re-authenticate with: a clear refusal (and the same scrypt work as a wrong password).
    const r = await fresh.post("/api/v1/auth/reauth", { password: "anything at all here" });
    expect(r.status).toBe(409);
    expect((r.body.error as { details: { reason: string } }).details.reason).toBe("no-password");
  });
});

// --------------------------------------------------------------------------- no password, linking
describe("accounts without a password", () => {
  it("password sign-in answers exactly like a wrong password; password change is refused", async () => {
    const g = googleUser();
    const b = new Browser(cloud.app);
    await signUpWithGoogle(b, g);
    const s1 = await new Browser(cloud.app).post("/api/v1/auth/signin", {
      email: g.email,
      password: "a guess at a password",
    });
    const s2 = await new Browser(cloud.app).post("/api/v1/auth/signin", {
      email: uniqueEmail("nobody"),
      password: "a guess at a password",
    });
    expect([s1.status, s1.text]).toEqual([s2.status, s2.text]);
    const ch = await b.post("/api/v1/account/password", { current: "", next: strongPassword() });
    expect(ch.status).toBe(409);
  });

  it("the first-password link still arrives after strangers used up the address's forgot-password and mail limits (security review finding 9)", async () => {
    const g = googleUser();
    const b = new Browser(cloud.app);
    await signUpWithGoogle(b, g);
    // Anyone can ask for password resets and sign up again with the address.
    for (let i = 0; i < 4; i++)
      await new Browser(cloud.app).post("/api/v1/auth/password/forgot", {
        email: g.email,
        captchaToken: "captcha-ok",
      });
    for (let i = 0; i < 6; i++)
      await new Browser(cloud.app).post("/api/v1/auth/signup", {
        email: g.email,
        password: strongPassword(),
        name: "Someone Else",
        captchaToken: "captcha-ok",
        termsVersion: "2026-11",
        adultConfirmed: true,
      });
    await cloud.accounts.settled();
    const before = cloud.mailer.to(g.email, "password-reset").length;
    const setup = await b.post("/api/v1/account/password/setup");
    expect(setup.status, setup.text).toBe(202);
    await cloud.accounts.settled();
    expect(cloud.mailer.to(g.email, "password-reset")).toHaveLength(before + 1);
  });

  it("sets a first password through the emailed link; then can unlink Google; unlinking without a password is refused", async () => {
    const g = googleUser();
    const b = new Browser(cloud.app);
    await signUpWithGoogle(b, g);
    // No other way in: unlink refused (with or without re-auth there is nothing to re-auth with).
    const refuse = await b.del("/api/v1/account/identities/google");
    expect(refuse.status).toBe(403); // REAUTH_REQUIRED first
    const setup = await b.post("/api/v1/account/password/setup");
    expect(setup.status).toBe(202);
    await cloud.accounts.settled();
    const token = cloud.mailer.token(g.email, "password-reset");
    const password = strongPassword();
    const reset = await new Browser(cloud.app).post("/api/v1/auth/password/reset", {
      token,
      password,
    });
    expect(reset.status).toBe(200);
    // Signs out everywhere (including the Google session).
    expect((await status(b)).authenticated).toBe(false);
    const pw = new Browser(cloud.app);
    expect((await pw.post("/api/v1/auth/signin", { email: g.email, password })).status).toBe(200);
    remember(pw.jar.get("__Host-gw_session") as string);
    remember(pw.jar.get("__Host-gw_csrf") as string);
    expect((await status(pw)).user).toMatchObject({ password: true, google: true });
    // A second setup link is refused now that a password exists.
    expect((await pw.post("/api/v1/account/password/setup")).status).toBe(409);
    const un = await pw.del("/api/v1/account/identities/google");
    expect(un.status, un.text).toBe(204);
    expect(identities()).toHaveLength(0);
    const ev = cloud.db
      .select()
      .from(auditEvents)
      .all()
      .map((e) => e.event);
    expect(ev).toContain("identity.unlinked");
    // Unlinked: the Google account now meets a verified account with its address -> no sign-in.
    expect(loc(await viaGoogle(new Browser(cloud.app), g))).toBe("/signin/google-exists");
  });

  it("unlink is refused while the account has no password, even right after a TOTP re-authentication", async () => {
    // A Google-only person sets a password, enables TOTP... simpler: drop the password again directly.
    const u = await signedUpBrowser(cloud);
    const g = googleUser({ email: u.email });
    await link(u.browser, u.password, g);
    const code = await enableTotp(u.browser, u.password);
    cloud.db.update(users).set({ passwordHash: "" }).where(eq(users.email, u.email)).run();
    expect((await u.browser.post("/api/v1/auth/reauth", { totpCode: code() })).status).toBe(200);
    remember(u.browser.jar.get("__Host-gw_session") as string);
    remember(u.browser.jar.get("__Host-gw_csrf") as string);
    const r = await u.browser.del("/api/v1/account/identities/google");
    expect(r.status).toBe(409);
    expect((r.body.error as { details: { reason: string } }).details.reason).toBe("no-password");
    expect(identities()).toHaveLength(1);
  });

  it("deleting the account removes its identities; the personal-data export lists them without secrets", async () => {
    const u = await signedUpBrowser(cloud);
    const g = googleUser();
    await link(u.browser, u.password, g);
    const pd = await u.browser.get("/api/v1/account/personal-data");
    const idn = pd.body.identities as Array<Record<string, unknown>>;
    expect(idn).toEqual([
      expect.objectContaining({ provider: "google", linkedAt: expect.any(String) }),
    ]);
    expect(pd.text).not.toContain(g.sub);
    for (const t of op.issued) expect(pd.text).not.toContain(t);
    await reauth(u.browser, u.password);
    remember(u.browser.jar.get("__Host-gw_session") as string);
    remember(u.browser.jar.get("__Host-gw_csrf") as string);
    expect((await u.browser.del("/api/v1/account")).status).toBe(204);
    expect(identities()).toHaveLength(0);
  });
});

describe("linking from security settings", () => {
  it("needs a recent re-authentication and the CSRF token", async () => {
    const u = await signedUpBrowser(cloud);
    const noReauth = await u.browser.post("/api/v1/account/identities/google");
    expect((noReauth.body.error as { code: string }).code).toBe("REAUTH_REQUIRED");
    await reauth(u.browser, u.password);
    remember(u.browser.jar.get("__Host-gw_session") as string);
    remember(u.browser.jar.get("__Host-gw_csrf") as string);
    const noCsrf = await u.browser.post("/api/v1/account/identities/google", undefined, {
      csrf: false,
    });
    expect(noCsrf.status).toBe(403);
    const evil = await u.browser.post("/api/v1/account/identities/google", undefined, {
      origin: "https://evil.example",
    });
    expect(evil.status).toBe(403);
  });

  it("a Google account linked to someone else is refused; a second Google account is refused", async () => {
    const a = await signedUpBrowser(cloud);
    const b = await signedUpBrowser(cloud);
    const g = googleUser();
    expect(loc(await link(a.browser, a.password, g))).toBe("/settings/security?google=linked");
    expect(loc(await link(b.browser, b.password, g))).toBe("/settings/security?google=taken");
    expect(identities().map((i) => i.userId)).toEqual([identities()[0]?.userId]);
    await reauth(a.browser, a.password);
    const second = await a.browser.post("/api/v1/account/identities/google");
    expect(second.status).toBe(409);
  });

  it("linking CSRF: an attacker's link callback delivered to the victim's browser links nothing", async () => {
    const attacker = await signedUpBrowser(cloud);
    const victim = await signedUpBrowser(cloud);
    await reauth(attacker.browser, attacker.password);
    remember(attacker.browser.jar.get("__Host-gw_session") as string);
    remember(attacker.browser.jar.get("__Host-gw_csrf") as string);
    const r = await attacker.browser.post("/api/v1/account/identities/google");
    const cb = op.authorize(r.body.url as string, googleUser());
    // The victim's browser opens the attacker's callback URL.
    const hit = await victim.browser.get(cb);
    expect(loc(hit)).toBe("/signin?google=expired");
    expect(identities()).toHaveLength(0);
  });

  it("the link must finish in the session that started it", async () => {
    const u = await signedUpBrowser(cloud);
    await reauth(u.browser, u.password);
    remember(u.browser.jar.get("__Host-gw_session") as string);
    remember(u.browser.jar.get("__Host-gw_csrf") as string);
    const r = await u.browser.post("/api/v1/account/identities/google");
    // Signed out (and in again) in between: a new session, so the old link request is void.
    await u.browser.post("/api/v1/auth/signout");
    await u.browser.post("/api/v1/auth/signin", { email: u.email, password: u.password });
    remember(u.browser.jar.get("__Host-gw_session") as string);
    const cb = await u.browser.get(op.authorize(r.body.url as string, googleUser()));
    expect(loc(cb)).toBe("/settings/security?google=session");
    expect(identities()).toHaveLength(0);
  });
});

// ------------------------------------------------------------------------------------ attack cases
describe("state, PKCE and code handling", () => {
  it("missing, unknown, reused, expired and other-browser states are all refused before any token exchange", async () => {
    const g = googleUser();
    await signUpWithGoogle(new Browser(cloud.app), g);
    const tokenCalls = () => op.requests.filter((r) => r === op.endpoints.token).length;

    // Missing state.
    const b = new Browser(cloud.app);
    const url = await start(b);
    const cb = op.authorize(url, g);
    const before = tokenCalls();
    const noState = cb.replace(/state=[^&]+&?/, "");
    expect(loc(await b.get(noState))).toBe("/signin?google=expired");
    // Unknown state.
    expect(loc(await b.get(cb.replace(/state=[^&]+/, `state=${"A".repeat(43)}`)))).toBe(
      "/signin?google=expired",
    );
    expect(tokenCalls()).toBe(before);

    // Reused: a second callback with the same state, even with the binding cookie put back.
    const b2 = new Browser(cloud.app);
    const url2 = await start(b2);
    const binding = b2.jar.get("__Host-gw_oidc") as string;
    remember(binding);
    const cb2 = op.authorize(url2, g);
    expect(loc(await b2.get(cb2))).toBe("/");
    remember(b2.jar.get("__Host-gw_session") as string);
    b2.jar.set("__Host-gw_oidc", binding);
    const n = tokenCalls();
    expect(loc(await b2.get(cb2))).toBe("/signin?google=expired");
    expect(tokenCalls()).toBe(n);

    // Expired: 10 minutes.
    const b3 = new Browser(cloud.app);
    const url3 = await start(b3);
    cloud.advance(10 * 60_000 + 1_000);
    expect(loc(await b3.get(op.authorize(url3, g)))).toBe("/signin?google=expired");

    // Another browser's state (no binding cookie at all, or its own different cookie).
    const owner = new Browser(cloud.app);
    const url4 = await start(owner);
    const cb4 = op.authorize(url4, g);
    const other = new Browser(cloud.app);
    expect(loc(await other.get(cb4))).toBe("/signin?google=expired");
    const other2 = new Browser(cloud.app);
    await start(other2);
    expect(loc(await other2.get(cb4))).toBe("/signin?google=expired");
    // And the owner cannot use it afterwards either: single use, whoever tried first.
    expect(loc(await owner.get(cb4))).toBe("/signin?google=expired");
    expect(tokenCalls()).toBe(n);
  });

  it("login CSRF: the attacker's code and state delivered to a victim's browser never sign the victim in to the attacker's account", async () => {
    const attackerGoogle = googleUser();
    await signUpWithGoogle(new Browser(cloud.app), attackerGoogle);
    // The attacker runs the flow in their own browser and stops before the callback.
    const attackerBrowser = new Browser(cloud.app);
    const url = await start(attackerBrowser);
    const trap = op.authorize(url, attackerGoogle);
    // The victim, signed in to their own account or not, is made to open the callback URL.
    const victim = await signedUpBrowser(cloud);
    const hit = await victim.browser.get(trap);
    expect(loc(hit)).toBe("/signin?google=expired");
    expect(cookieLine(hit, "__Host-gw_session")).toBe("");
    expect((await status(victim.browser)).user).toMatchObject({ id: victim.userId });
    const fresh = new Browser(cloud.app);
    expect(loc(await fresh.get(trap))).toBe("/signin?google=expired");
    expect((await status(fresh)).authenticated).toBe(false);
  });

  it("an authorization code is good once: replayed with a fresh state it fails at the provider", async () => {
    const g = googleUser();
    await signUpWithGoogle(new Browser(cloud.app), g);
    const b = new Browser(cloud.app);
    const url = await start(b);
    const cb = op.authorize(url, g);
    expect(loc(await b.get(cb))).toBe("/");
    remember(b.jar.get("__Host-gw_session") as string);
    const code = new URL(cb, PUBLIC_URL).searchParams.get("code") as string;
    const c = new Browser(cloud.app);
    const url2 = await start(c);
    const state2 = new URL(url2).searchParams.get("state") as string;
    const replay = await c.get(
      `/api/v1/auth/google/callback?state=${encodeURIComponent(state2)}&code=${encodeURIComponent(code)}`,
    );
    expect(loc(replay)).toBe("/signin?google=failed");
    expect(cookieLine(replay, "__Host-gw_session")).toBe("");
  });

  it("PKCE: a code obtained for one authorization request cannot be redeemed by another (verifier mismatch)", async () => {
    const g = googleUser();
    await signUpWithGoogle(new Browser(cloud.app), g);
    // Code from flow 1 (never redeemed), presented with flow 2's state: flow 2's verifier does not match.
    const b1 = new Browser(cloud.app);
    const code = new URL(op.authorize(await start(b1), g), PUBLIC_URL).searchParams.get("code");
    const b2 = new Browser(cloud.app);
    const state2 = new URL(await start(b2)).searchParams.get("state") as string;
    const r = await b2.get(
      `/api/v1/auth/google/callback?state=${encodeURIComponent(state2)}&code=${encodeURIComponent(code as string)}`,
    );
    expect(loc(r)).toBe("/signin?google=failed");
    expect(cookieLine(r, "__Host-gw_session")).toBe("");
  });

  it("forged or tampered ID tokens from the token endpoint never sign anyone in", async () => {
    const victimGoogle = googleUser();
    await signUpWithGoogle(new Browser(cloud.app), victimGoogle);
    const attacker = googleUser();
    const cases: Array<FakeOidcProvider["tamperNext"]> = [
      // Claims changed to the victim's subject, signature left as it was.
      ({ header, claims }) => {
        const good = op.signWith(header, claims);
        const [h, , s] = good.split(".");
        const p = Buffer.from(JSON.stringify({ ...claims, sub: victimGoogle.sub })).toString(
          "base64url",
        );
        return { token: `${h}.${p}.${s}` };
      },
      ({ claims }) => ({
        token: op.signWith({ alg: "none" }, { ...claims, sub: victimGoogle.sub }),
      }),
      ({ claims }) => ({
        token: op.signWith(
          { alg: "HS256", kid: op.activeKid },
          { ...claims, sub: victimGoogle.sub },
          {
            hmacSecret: op.publicPem(),
          },
        ),
      }),
      ({ header, claims }) => ({ header, claims: { ...claims, aud: "another-client" } }),
      ({ header, claims }) => ({ header, claims: { ...claims, iss: "https://evil.example" } }),
      ({ header, claims }) => ({ header, claims: { ...claims, exp: 1 } }),
      ({ header, claims }) => ({ header, claims: { ...claims, nonce: "replayed-nonce-value" } }),
    ];
    for (const t of cases) {
      const b = new Browser(cloud.app);
      const url = await start(b);
      op.tamperNext = t;
      const r = await b.get(op.authorize(url, attacker));
      expect(loc(r)).toBe("/signin?google=failed");
      expect(cookieLine(r, "__Host-gw_session")).toBe("");
    }
    const parked = cloud.db.select().from(oidcFlows).all();
    expect(parked.filter((f) => f.kind === "pending_signup" && !f.usedAt)).toHaveLength(0);
  });

  it("open redirects: next is same-origin only, at start and after sign-in", async () => {
    const g = googleUser();
    await signUpWithGoogle(new Browser(cloud.app), g);
    for (const [next, expected] of [
      ["/plans/1?tab=x", "/plans/1?tab=x"],
      ["//evil.example/x", "/"],
      ["https://evil.example/", "/"],
      ["/\\evil.example", "/"],
      ["javascript:alert(1)", "/"],
    ] as const) {
      const b = new Browser(cloud.app);
      const r = await viaGoogle(b, g, next);
      expect([next, loc(r)]).toEqual([next, expected]);
      remember(b.jar.get("__Host-gw_session") as string);
    }
  });
});

describe("privacy", () => {
  it("nothing from Google's response reaches a log line or the audit trail", async () => {
    const before = logLines.length;
    const g = googleUser({ name: remember("Zebulon Quackenbush") });
    const b = new Browser(cloud.app);
    await signUpWithGoogle(b, g, "Zebulon Quackenbush");
    await viaGoogle(new Browser(cloud.app), g);
    await viaGoogle(new Browser(cloud.app), googleUser({ emailVerified: false }));
    const lines = logLines.slice(before).join("\n");
    expect(lines).toContain("auth.signin");
    for (const v of [g.sub, g.email, "Zebulon", "lh3.googleusercontent.com", ...op.issued])
      expect(lines).not.toContain(v);
    assertAuditClean(cloud.db);
    // Never stored: no column anywhere holds the ID token or the access token.
    const dump = JSON.stringify(cloud.db.select().from(userIdentities).all());
    for (const t of op.issued) expect(dump).not.toContain(t);
    expect(dump).not.toContain("googleusercontent");
  });

  it("only the provider's own endpoints were ever contacted", () => {
    for (const r of op.requests) expect(r.startsWith(op.issuer)).toBe(true);
  });
});

describe("feature off", () => {
  it("without a Google client: no routes, no button, sign-in methods still reported", async () => {
    const plain = await makeCloud();
    try {
      const b = new Browser(plain.app);
      expect((await b.get("/api/v1/auth/google/start")).status).toBe(404);
      expect((await b.get("/api/v1/auth/google/callback?state=x&code=y")).status).toBe(404);
      expect((await b.get("/api/v1/auth/status")).body.googleSignIn).toBe(false);
      const { OpenAPIHono } = await import("@hono/zod-openapi");
      const doc = (plain.app as InstanceType<typeof OpenAPIHono>).getOpenAPI31Document({
        openapi: "3.1.0",
        info: { title: "t", version: "1" },
      });
      expect(Object.keys(doc.paths ?? {}).filter((p) => p.includes("google"))).toEqual([]);
      const u = await signedUpBrowser(plain);
      const prof = await u.browser.get("/api/v1/account/profile");
      expect(prof.body).toMatchObject({ passwordSet: true, identities: [], googleSignIn: false });
      expect((await u.browser.post("/api/v1/account/identities/google")).status).toBe(404);
    } finally {
      await plain.accounts.settled();
      await plain.close();
    }
  });
});
