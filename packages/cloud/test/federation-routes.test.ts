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
  invitations,
  memberships,
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
/**
 * Google's redirect back is a top-level navigation started on Google's page: a real browser sends the Lax
 * cookies (the flow's binding cookie) and leaves out the SameSite=Strict ones (the session and CSRF cookies).
 * Every callback below is requested this way (security review finding 13).
 */
const xs = { crossSite: true } as const;
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
  return b.get(op.authorize(url, u), xs);
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

/**
 * What the web app's `/google-link` page does: the same-origin POST that finishes a link, then the security
 * settings page with the answer. Returns that page's address.
 */
async function finishLink(b: Browser): Promise<string> {
  const r = await b.post("/api/v1/account/identities/google/finish");
  expect(r.status, r.text).toBe(200);
  return `/settings/security?google=${String(r.body.google)}`;
}

/** Security settings → Link Google → Google → the callback (cross-site) → `/google-link` → its POST. */
async function link(b: Browser, password: string, u: FakeUser): Promise<string> {
  expect((await reauth(b, password)).status).toBe(200);
  remember(b.jar.get("__Host-gw_session") as string);
  remember(b.jar.get("__Host-gw_csrf") as string);
  const r = await b.post("/api/v1/account/identities/google");
  expect(r.status, r.text).toBe(200);
  const cb = await b.get(op.authorize(r.body.url as string, u), xs);
  if (loc(cb) !== "/google-link") return loc(cb);
  return finishLink(b);
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
    expect(pending.body).toEqual({ name: g.name, email: g.email, invitedTo: null });

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
    expect(linked).toBe("/settings/security?google=linked");
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
    const cb = await b.get(op.authorize(url, googleUser(), { deny: true }), xs);
    expect(loc(cb)).toBe("/signin?google=cancelled");
  });
});

// ------------------------------------------------------------------------------------- two-factor
describe("two-factor and re-authentication", () => {
  it("Google sign-in still asks for the TOTP code: no session until the second step", async () => {
    const u = await signedUpBrowser(cloud);
    const g = googleUser({ email: u.email });
    expect(await link(u.browser, u.password, g)).toBe("/settings/security?google=linked");
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
    const before = cloud.mailer.to(g.email, "password-setup").length;
    const setup = await b.post("/api/v1/account/password/setup");
    expect(setup.status, setup.text).toBe(202);
    await cloud.accounts.settled();
    expect(cloud.mailer.to(g.email, "password-setup")).toHaveLength(before + 1);
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
    const token = cloud.mailer.token(g.email, "password-setup");
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

// ---------------------------------------------------- the first-password link as a re-authentication
describe("the first-password link answers a re-authentication prompt", () => {
  const REAUTH_ACTION = "/api/v1/account/totp/begin";
  const keep = (b: Browser) => {
    remember(b.jar.get("__Host-gw_session") as string);
    remember(b.jar.get("__Host-gw_csrf") as string);
  };
  /** A Google-only person, signed in, whose change was just refused (REAUTH_REQUIRED). */
  async function refusedGooglePerson() {
    const g = googleUser();
    const b = new Browser(cloud.app);
    await signUpWithGoogle(b, g);
    const refused = await b.post(REAUTH_ACTION);
    expect((refused.body.error as { code: string }).code).toBe("REAUTH_REQUIRED");
    return { g, b };
  }
  async function askForLink(b: Browser, email: string, returnTo?: string): Promise<string> {
    const q = returnTo === undefined ? "" : `?returnTo=${encodeURIComponent(returnTo)}`;
    const r = await b.post(`/api/v1/account/password/setup${q}`);
    expect(r.status, r.text).toBe(202);
    await cloud.accounts.settled();
    return cloud.mailer.token(email, "password-setup");
  }

  it("sends a set-a-password email (not reset wording) whose link opens /set-password", async () => {
    const { g, b } = await refusedGooglePerson();
    await askForLink(b, g.email, "/settings/keys");
    const mail = cloud.mailer.last(g.email, "password-setup");
    expect(String(mail?.data.url)).toMatch(/^https:\/\/[^/]+\/set-password#token=/);
    expect(cloud.mailer.to(g.email, "password-reset")).toEqual([]);
    // The return path is not in the link: it stays in the token's row on the server.
    expect(String(mail?.data.url)).not.toContain("settings");
  });

  it("in the browser and session that asked: the new session counts as re-authenticated and returns to the section", async () => {
    const { g, b } = await refusedGooglePerson();
    const token = await askForLink(b, g.email, "/settings/keys");
    const r = await b.post("/api/v1/auth/password/reset", { token, password: strongPassword() });
    expect(r.status, r.text).toBe(200);
    expect(r.body).toMatchObject({
      status: "signed-in",
      redirectTo: "/settings/keys",
      recentAuth: true,
    });
    keep(b);
    // The refused change now goes through without typing the new password.
    const again = await b.post(REAUTH_ACTION);
    expect(again.status, again.text).toBe(200);
    remember(String(again.body.secret));
    const ev = cloud.db.select().from(auditEvents).all();
    expect(ev.findLast((e) => e.event === "user.reauthenticated")?.detail).toEqual({
      method: "setup-link",
    });
    expect(ev.findLast((e) => e.event === "user.password_reset")?.detail).toEqual({
      method: "setup-link",
    });
    expect(cloud.mailer.last(g.email, "security-change")?.data.change).toBe("password-set");
  });

  it("keeps the normal 10-minute window", async () => {
    const { g, b } = await refusedGooglePerson();
    const token = await askForLink(b, g.email, "/settings/keys");
    const r = await b.post("/api/v1/auth/password/reset", { token, password: strongPassword() });
    expect(r.body.recentAuth).toBe(true);
    keep(b);
    cloud.advance(10 * 60 * 1000 + 1000);
    const late = await b.post(REAUTH_ACTION);
    expect((late.body.error as { code: string }).code).toBe("REAUTH_REQUIRED");
  });

  it("in another browser: an ordinary reset, not a re-authentication; the asking browser is signed out", async () => {
    const { g, b } = await refusedGooglePerson();
    const token = await askForLink(b, g.email, "/settings/keys");
    const other = new Browser(cloud.app);
    const r = await other.post("/api/v1/auth/password/reset", {
      token,
      password: strongPassword(),
    });
    expect(r.status, r.text).toBe(200);
    expect(r.body).toMatchObject({ redirectTo: "/settings/keys", recentAuth: false });
    keep(other);
    const refused = await other.post(REAUTH_ACTION);
    expect((refused.body.error as { code: string }).code).toBe("REAUTH_REQUIRED");
    expect((await status(b)).authenticated).toBe(false);
    expect(
      cloud.db
        .select()
        .from(auditEvents)
        .all()
        .some((e) => e.event === "user.reauthenticated"),
    ).toBe(false);
  });

  it("in the same browser but a different session (signed in again since): not a re-authentication", async () => {
    const { g, b } = await refusedGooglePerson();
    const token = await askForLink(b, g.email, "/settings/keys");
    // Signed out and in again with Google: a new session in the same browser.
    await b.post("/api/v1/auth/signout");
    await viaGoogle(b, g);
    keep(b);
    const r = await b.post("/api/v1/auth/password/reset", { token, password: strongPassword() });
    expect(r.status, r.text).toBe(200);
    expect(r.body.recentAuth).toBe(false);
    keep(b);
    const refused = await b.post(REAUTH_ACTION);
    expect((refused.body.error as { code: string }).code).toBe("REAUTH_REQUIRED");
  });

  it("a cross-site request (no SameSite=Strict session cookie) gets no re-authentication", async () => {
    const { g, b } = await refusedGooglePerson();
    const token = await askForLink(b, g.email, "/settings/keys");
    const r = await b.post(
      "/api/v1/auth/password/reset",
      { token, password: strongPassword() },
      { crossSite: true },
    );
    expect(r.status, r.text).toBe(200);
    expect(r.body.recentAuth).toBe(false);
  });

  it.each([
    "https://evil.example/settings/keys",
    "//evil.example/settings/keys",
    "/\\evil.example",
    "/settings/../../evil",
    "/settings/keys?next=https://evil.example",
    "/settings/keys#x",
    "/settings/%2F%2Fevil.example",
    "/plans/2",
    "javascript:alert(1)",
    "",
  ])("the return path %j can only be a settings section (else Security settings)", async (bad) => {
    const { g, b } = await refusedGooglePerson();
    const token = await askForLink(b, g.email, bad);
    const r = await b.post("/api/v1/auth/password/reset", { token, password: strongPassword() });
    expect(r.status, r.text).toBe(200);
    expect(r.body.redirectTo).toBe("/settings/security");
  });

  it("with no return path given, goes back to Security settings", async () => {
    const { g, b } = await refusedGooglePerson();
    const token = await askForLink(b, g.email);
    const r = await b.post("/api/v1/auth/password/reset", { token, password: strongPassword() });
    expect(r.body.redirectTo).toBe("/settings/security");
  });

  it("the link is single use", async () => {
    const { g, b } = await refusedGooglePerson();
    const token = await askForLink(b, g.email, "/settings/keys");
    const first = await b.post("/api/v1/auth/password/reset", {
      token,
      password: strongPassword(),
    });
    expect(first.status).toBe(200);
    keep(b);
    const second = await b.post("/api/v1/auth/password/reset", {
      token,
      password: strongPassword(),
    });
    expect(second.status).toBe(400);
    expect((second.body.error as { code: string }).code).toBe("INVALID_TOKEN");
  });

  it("with two-step sign-in on, the code is still required: no session until the second step", async () => {
    // A linked account with TOTP whose password is dropped: the shape of a Google-only person with TOTP.
    const u = await signedUpBrowser(cloud);
    const g = googleUser({ email: u.email });
    await link(u.browser, u.password, g);
    const code = await enableTotp(u.browser, u.password);
    cloud.db.update(users).set({ passwordHash: "" }).where(eq(users.email, u.email)).run();
    cloud.advance(11 * 60 * 1000);
    const b = u.browser;
    const token = await askForLink(b, u.email, "/settings/keys");
    const r = await b.post("/api/v1/auth/password/reset", { token, password: strongPassword() });
    expect(r.status, r.text).toBe(200);
    expect(r.body).toMatchObject({
      status: "totp-required",
      redirectTo: "/settings/keys",
      // The code step will re-authenticate; this browser is the one that asked, so the waiting tab may retry.
      recentAuth: true,
    });
    expect(cookieLine(r, "__Host-gw_session")).toBe("");
    expect((await status(b)).authenticated).toBe(false);
    const challenge = remember(String(r.body.challenge));
    const wrong = await b.post("/api/v1/auth/signin/totp", { challenge, code: "000000" });
    expect(wrong.status).toBe(401);
    cloud.advance(31_000);
    const ok = await b.post("/api/v1/auth/signin/totp", { challenge, code: code() });
    expect(ok.status, ok.text).toBe(200);
    keep(b);
  });

  it("the same session keeps the workspace it was in, so the change it retries runs there", async () => {
    const { g, b } = await refusedGooglePerson();
    const own = (await status(b)).workspace as { id: string };
    // Also an editor in someone else's workspace, and working there when the change was refused.
    const other = await signedUpBrowser(cloud);
    const theirs = (await status(other.browser)).workspace as { id: string };
    const me = userOf(g.email)!;
    cloud.db
      .insert(memberships)
      .values({ accountId: theirs.id, userId: me.id, role: "editor", tenantUserId: "usr_test1" })
      .run();
    expect((await b.post(`/api/v1/workspaces/${theirs.id}/activate`)).status).toBe(204);
    expect(((await status(b)).workspace as { id: string }).id).toBe(theirs.id);
    expect(own.id).not.toBe(theirs.id);
    const token = await askForLink(b, g.email, "/settings/keys");
    const r = await b.post("/api/v1/auth/password/reset", { token, password: strongPassword() });
    expect(r.body.recentAuth).toBe(true);
    keep(b);
    expect(((await status(b)).workspace as { id: string }).id).toBe(theirs.id);
    // Another browser completing a link opens the default workspace, as any sign-in does.
    cloud.db.update(users).set({ passwordHash: "" }).where(eq(users.id, me.id)).run();
    const token2 = await askForLink(b, g.email, "/settings/keys");
    const elsewhere = new Browser(cloud.app);
    await elsewhere.post("/api/v1/auth/password/reset", {
      token: token2,
      password: strongPassword(),
    });
    keep(elsewhere);
    expect(((await status(elsewhere)).workspace as { id: string }).id).toBe(own.id);
  });

  it("a request from another origin (even of the same site) is refused and leaves the link usable", async () => {
    const { g, b } = await refusedGooglePerson();
    const token = await askForLink(b, g.email, "/settings/keys");
    const r = await b.post(
      "/api/v1/auth/password/reset",
      { token, password: strongPassword() },
      { origin: "https://www.example.org" },
    );
    expect(r.status).toBe(403);
    const ok = await b.post("/api/v1/auth/password/reset", { token, password: strongPassword() });
    expect(ok.body.recentAuth).toBe(true);
    keep(b);
  });

  it("forgot-password for an account with no password sends the set-a-password email, never a re-authentication", async () => {
    const { g } = await refusedGooglePerson();
    const f = await new Browser(cloud.app).post("/api/v1/auth/password/forgot", {
      email: g.email,
      captchaToken: "captcha-ok",
    });
    expect(f.status).toBe(202);
    await cloud.accounts.settled();
    expect(cloud.mailer.to(g.email, "password-reset")).toEqual([]);
    expect(String(cloud.mailer.last(g.email, "password-setup")?.data.url)).toMatch(
      /\/set-password#token=/,
    );
    const token = cloud.mailer.token(g.email, "password-setup");
    const fresh = new Browser(cloud.app);
    const r = await fresh.post("/api/v1/auth/password/reset", {
      token,
      password: strongPassword(),
    });
    expect(r.status, r.text).toBe(200);
    expect(r.body).toMatchObject({ redirectTo: "/settings/security", recentAuth: false });
  });

  it("a forgot-password reset of an account with a password keeps reset wording and gets no re-authentication", async () => {
    const u = await signedUpBrowser(cloud);
    const f = await u.browser.post("/api/v1/auth/password/forgot", {
      email: u.email,
      captchaToken: "captcha-ok",
    });
    expect(f.status).toBe(202);
    await cloud.accounts.settled();
    expect(cloud.mailer.to(u.email, "password-setup")).toEqual([]);
    const mail = cloud.mailer.last(u.email, "password-reset");
    expect(String(mail?.data.url)).toMatch(/\/reset-password#token=/);
    const token = cloud.mailer.token(u.email, "password-reset");
    const r = await u.browser.post("/api/v1/auth/password/reset", {
      token,
      password: strongPassword(),
    });
    expect(r.status, r.text).toBe(200);
    expect(r.body.recentAuth).toBeUndefined();
    expect(r.body.redirectTo).toBe("/");
    keep(u.browser);
    const refused = await u.browser.post(REAUTH_ACTION);
    expect((refused.body.error as { code: string }).code).toBe("REAUTH_REQUIRED");
    expect(cloud.mailer.last(u.email, "security-change")?.data.change).toBe("password-reset");
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
    expect(await link(a.browser, a.password, g)).toBe("/settings/security?google=linked");
    expect(await link(b.browser, b.password, g)).toBe("/settings/security?google=taken");
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
    const hit = await victim.browser.get(cb, xs);
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
    remember(u.browser.jar.get("__Host-gw_csrf") as string);
    const cb = await u.browser.get(op.authorize(r.body.url as string, googleUser()), xs);
    expect(loc(cb)).toBe("/google-link");
    expect(await finishLink(u.browser)).toBe("/settings/security?google=session");
    expect(identities()).toHaveLength(0);
  });

  it("the callback works without the Strict session cookie: it parks the Google account and the web app's same-origin POST links it (security review finding 13)", async () => {
    const u = await signedUpBrowser(cloud);
    expect(u.browser.sameSite.get("__Host-gw_session")).toBe("strict");
    await reauth(u.browser, u.password);
    remember(u.browser.jar.get("__Host-gw_session") as string);
    remember(u.browser.jar.get("__Host-gw_csrf") as string);
    const r = await u.browser.post("/api/v1/account/identities/google");
    const g = googleUser({ email: u.email });
    const cb = await u.browser.get(op.authorize(r.body.url as string, g), xs);
    // No session reached the callback, and it did not need one.
    expect(cb.status).toBe(302);
    expect(loc(cb)).toBe("/google-link");
    expect(cb.headers.get("referrer-policy")).toBe("no-referrer");
    const c = cookieLine(cb, "__Host-gw_oidc_link");
    expect(c).toMatch(/; Max-Age=600/);
    expect(c).toMatch(/; Path=\//);
    expect(c).toMatch(/; HttpOnly/);
    expect(c).toMatch(/; Secure/);
    expect(c).toMatch(/; SameSite=Lax/);
    expect(c).not.toMatch(/Domain=/i);
    // Parked, sealed and bound to this user and session; nothing is linked yet.
    expect(identities()).toHaveLength(0);
    const parked = cloud.db
      .select()
      .from(oidcFlows)
      .all()
      .filter((f) => f.kind === "pending_link");
    expect(parked).toHaveLength(1);
    expect(parked[0]?.userId).toBe(u.userId);
    expect(parked[0]?.payloadEnc).not.toContain(g.sub);
    // The finishing POST is an ordinary cookie-authenticated write: CSRF token and same origin required,
    // and a refused attempt leaves the parked link for the real one.
    const noCsrf = await u.browser.post("/api/v1/account/identities/google/finish", undefined, {
      csrf: false,
    });
    expect(noCsrf.status).toBe(403);
    const evil = await u.browser.post("/api/v1/account/identities/google/finish", undefined, {
      origin: "https://evil.example",
    });
    expect(evil.status).toBe(403);
    expect(await finishLink(u.browser)).toBe("/settings/security?google=linked");
    expect(identities().map((i) => [i.userId, i.subject])).toEqual([[u.userId, g.sub]]);
    expect(u.browser.jar.has("__Host-gw_oidc_link")).toBe(false);
    expect(
      cloud.db
        .select()
        .from(auditEvents)
        .all()
        .filter((e) => e.event === "identity.linked"),
    ).toHaveLength(1);
    // Single use: the same parked link cannot be finished twice.
    u.browser.jar.set("__Host-gw_oidc_link", c.split(";")[0]?.split("=")[1] as string);
    expect(await finishLink(u.browser)).toBe("/settings/security?google=expired");
    // And Google sign-in now works with that Google account.
    expect(loc(await viaGoogle(new Browser(cloud.app), g))).toBe("/");
  });

  it("a parked link is finished only by the browser and session that started it, within 10 minutes", async () => {
    const u = await signedUpBrowser(cloud);
    const other = await signedUpBrowser(cloud);
    await reauth(u.browser, u.password);
    remember(u.browser.jar.get("__Host-gw_session") as string);
    remember(u.browser.jar.get("__Host-gw_csrf") as string);
    const begin = async () => {
      const r = await u.browser.post("/api/v1/account/identities/google");
      expect(r.status, r.text).toBe(200);
      const cb = await u.browser.get(op.authorize(r.body.url as string, googleUser()), xs);
      expect(loc(cb)).toBe("/google-link");
      return u.browser.jar.get("__Host-gw_oidc_link") as string;
    };
    // Another signed-in person who somehow holds the cookie value gets "session", and uses it up.
    const stolen = remember(await begin());
    other.browser.jar.set("__Host-gw_oidc_link", stolen);
    expect(await finishLink(other.browser)).toBe("/settings/security?google=session");
    expect(await finishLink(u.browser)).toBe("/settings/security?google=expired");
    // Without the cookie (another browser of the same person, or nothing parked): "expired".
    u.browser.jar.delete("__Host-gw_oidc_link");
    expect(await finishLink(u.browser)).toBe("/settings/security?google=expired");
    // Signed out: the POST needs a session at all.
    const anon = new Browser(cloud.app);
    expect((await anon.post("/api/v1/account/identities/google/finish")).status).toBe(401);
    // Older than 10 minutes: "expired". (Re-authenticate first: starting a link needs it.)
    await reauth(u.browser, u.password);
    remember(u.browser.jar.get("__Host-gw_session") as string);
    remember(u.browser.jar.get("__Host-gw_csrf") as string);
    await begin();
    cloud.advance(10 * 60_000 + 1);
    expect(await finishLink(u.browser)).toBe("/settings/security?google=expired");
    expect(identities()).toHaveLength(0);
  });
});

// ------------------------------------------------------------------------------------ invitations
describe("from an invitation page", () => {
  async function invited(role: "editor" | "viewer" = "viewer") {
    const owner = await signedUpBrowser(cloud, { name: "Olive Owner" });
    expect(
      (await owner.browser.patch("/api/v1/workspace/settings", { name: "Example Household" }))
        .status,
    ).toBe(200);
    const email = uniqueEmail("guest");
    const created = await owner.browser.post("/api/v1/workspace/invitations", { email, role });
    expect(created.status).toBe(201);
    await new Promise((r) => setTimeout(r, 0));
    const token = remember(
      decodeURIComponent(
        String(cloud.mailer.last(email, "invitation")?.data.url).split("#token=")[1] ?? "",
      ),
    );
    return { owner, email, token, page: `/invite#token=${encodeURIComponent(token)}` };
  }
  const startFrom = async (b: Browser, token: string, next?: string) => {
    const q = new URLSearchParams({ invitation: token, ...(next ? { next } : {}) });
    const r = await b.get(`/api/v1/auth/google/start?${q.toString()}`);
    expect(r.status, r.text).toBe(302);
    return loc(r);
  };

  it("a Google sign-up returns to the invitation, through the sign-up step, and starts no trial", async () => {
    const { email, token, page } = await invited();
    const g = googleUser({ email });
    const b = new Browser(cloud.app);
    const cb = await b.get(op.authorize(await startFrom(b, token), g), xs);
    expect(loc(cb)).toBe("/signup/google");
    // The sign-up step names the workspace (the copy then says "join", not "start a trial").
    const pending = await b.get("/api/v1/auth/google/pending");
    expect(pending.body).toMatchObject({ email, invitedTo: "Example Household" });
    const trials = cloud.db.select().from(trialGrants).all().length;
    const done = await b.post("/api/v1/auth/google/complete", {
      name: "Gus Guest",
      termsVersion: "2026-11",
      adultConfirmed: true,
    });
    expect(done.status, done.text).toBe(200);
    remember(b.jar.get("__Host-gw_session") as string);
    remember(b.jar.get("__Host-gw_csrf") as string);
    expect(done.body.redirectTo).toBe(page);
    const accepted = await b.post("/api/v1/workspace/invitations/accept", { token });
    expect(accepted.status, accepted.text).toBe(200);
    expect(accepted.body).toMatchObject({ role: "viewer", name: "Gus Guest" });
    // An invitee joins the inviting workspace: no workspace of their own, no trial.
    expect(cloud.db.select().from(trialGrants).all().length).toBe(trials);
    expect(((await status(b)).workspace as { name: string }).name).toBe("Example Household");
  });

  it("a Google sign-in (with or without two-step) returns to the invitation", async () => {
    const { email, token, page } = await invited("editor");
    const u = await signedUpBrowser(cloud, { email });
    const g = googleUser({ email });
    expect(await link(u.browser, u.password, g)).toBe("/settings/security?google=linked");
    const b = new Browser(cloud.app);
    const cb = await b.get(op.authorize(await startFrom(b, token, "/plans/3"), g), xs);
    expect(loc(cb)).toBe(page);
    remember(b.jar.get("__Host-gw_session") as string);
    remember(b.jar.get("__Host-gw_csrf") as string);

    await enableTotp(u.browser, u.password);
    const b2 = new Browser(cloud.app);
    const cb2 = await b2.get(op.authorize(await startFrom(b2, token), g), xs);
    const frag = new URLSearchParams(loc(cb2).split("#")[1]);
    remember(frag.get("challenge") as string);
    expect(loc(cb2).startsWith("/signin/2fa#")).toBe(true);
    expect(frag.get("next")).toBe(page);
  });

  it("an unknown, used or withdrawn invitation is ignored: the flow ends where it would have", async () => {
    const { email, token } = await invited();
    const b = new Browser(cloud.app);
    const g = googleUser({ email: uniqueEmail("stranger") });
    const fake = remember("A".repeat(43));
    const cb = await b.get(op.authorize(await startFrom(b, fake), g), xs);
    expect(loc(cb)).toBe("/signup/google");
    expect((await b.get("/api/v1/auth/google/pending")).body).toMatchObject({ invitedTo: null });
    const done = await b.post("/api/v1/auth/google/complete", {
      name: "Sam Stranger",
      termsVersion: "2026-11",
      adultConfirmed: true,
    });
    remember(b.jar.get("__Host-gw_session") as string);
    remember(b.jar.get("__Host-gw_csrf") as string);
    expect(done.body.redirectTo).toBe("/");

    // Live at the start, accepted by someone before the sign-up step was confirmed: plain `/`.
    const b2 = new Browser(cloud.app);
    const g2 = googleUser({ email });
    expect(loc(await b2.get(op.authorize(await startFrom(b2, token), g2), xs))).toBe(
      "/signup/google",
    );
    cloud.db.update(invitations).set({ acceptedAt: cloud.now().toISOString() }).run();
    const done2 = await b2.post("/api/v1/auth/google/complete", {
      name: "Gus Guest",
      termsVersion: "2026-11",
      adultConfirmed: true,
    });
    remember(b2.jar.get("__Host-gw_session") as string);
    remember(b2.jar.get("__Host-gw_csrf") as string);
    expect(done2.status, done2.text).toBe(200);
    expect(done2.body.redirectTo).toBe("/");
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
    expect(loc(await b.get(cb.replace(/state=[^&]+/, `state=${"A".repeat(43)}`), xs))).toBe(
      "/signin?google=expired",
    );
    expect(tokenCalls()).toBe(before);

    // Reused: a second callback with the same state, even with the binding cookie put back.
    const b2 = new Browser(cloud.app);
    const url2 = await start(b2);
    const binding = b2.jar.get("__Host-gw_oidc") as string;
    remember(binding);
    const cb2 = op.authorize(url2, g);
    expect(loc(await b2.get(cb2, xs))).toBe("/");
    remember(b2.jar.get("__Host-gw_session") as string);
    b2.jar.set("__Host-gw_oidc", binding);
    const n = tokenCalls();
    expect(loc(await b2.get(cb2, xs))).toBe("/signin?google=expired");
    expect(tokenCalls()).toBe(n);

    // Expired: 10 minutes.
    const b3 = new Browser(cloud.app);
    const url3 = await start(b3);
    cloud.advance(10 * 60_000 + 1_000);
    expect(loc(await b3.get(op.authorize(url3, g), xs))).toBe("/signin?google=expired");

    // Another browser's state (no binding cookie at all, or its own different cookie).
    const owner = new Browser(cloud.app);
    const url4 = await start(owner);
    const cb4 = op.authorize(url4, g);
    const other = new Browser(cloud.app);
    expect(loc(await other.get(cb4, xs))).toBe("/signin?google=expired");
    const other2 = new Browser(cloud.app);
    await start(other2);
    expect(loc(await other2.get(cb4, xs))).toBe("/signin?google=expired");
    // And the owner cannot use it afterwards either: single use, whoever tried first.
    expect(loc(await owner.get(cb4, xs))).toBe("/signin?google=expired");
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
    const hit = await victim.browser.get(trap, xs);
    expect(loc(hit)).toBe("/signin?google=expired");
    expect(cookieLine(hit, "__Host-gw_session")).toBe("");
    expect((await status(victim.browser)).user).toMatchObject({ id: victim.userId });
    const fresh = new Browser(cloud.app);
    expect(loc(await fresh.get(trap, xs))).toBe("/signin?google=expired");
    expect((await status(fresh)).authenticated).toBe(false);
  });

  it("an authorization code is good once: replayed with a fresh state it fails at the provider", async () => {
    const g = googleUser();
    await signUpWithGoogle(new Browser(cloud.app), g);
    const b = new Browser(cloud.app);
    const url = await start(b);
    const cb = op.authorize(url, g);
    expect(loc(await b.get(cb, xs))).toBe("/");
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
      const r = await b.get(op.authorize(url, attacker), xs);
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
