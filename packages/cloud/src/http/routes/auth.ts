/**
 * `/api/v1/auth/*` (spec 3.1-3.4, 8.3). Sign-up, resend and forgot-password always answer 202 with the same
 * body after the same work (enumeration-safe); sign-in failures are one 401. Session cookies are
 * `__Host-`, Secure, HttpOnly (the CSRF cookie is readable), SameSite=Strict.
 *
 * Every accepted sign-up also sets `__Host-gw_signup` (HttpOnly, Lax, as long as the verification link
 * lives): the browser that chose the password. `/auth/verify` signs in on the link alone only with that
 * cookie; any other browser must send the password too (`403 PASSWORD_REQUIRED`, accounts/service.ts).
 *
 * "Sign in with Google" (`/api/v1/auth/google/*`, federation/service.ts) is registered only when the Google
 * client is configured. Its two browser-facing routes answer with redirects to fixed web-app paths:
 *   start     GET  -> 302 to Google (sets `__Host-gw_oidc`, the browser binding of the flow)
 *   callback  GET  -> 302 to `/`, `/signin/2fa#challenge=…`, `/signup/google`, `/signin/google-exists`,
 *                    `/signin?google=<code>` or `/settings/security?google=<code>`
 */
import { z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { ACCOUNT_TTL } from "../../accounts/service.js";
import { randomToken, TOKEN_RE } from "../../crypto/random.js";
import { CloudError } from "../../errors.js";
import type { CallbackOutcome } from "../../federation/service.js";
import type { IssuedSession, SignInResult } from "../../types.js";
import { clearSessionCookies, safeNext, sessionCookie, setSessionCookies } from "../common.js";
import type { RouteKit } from "../kit.js";

/** The browser binding of an OpenID Connect flow (flows.ts). Lax: it must survive Google's redirect back. */
export const OIDC_COOKIE = "__Host-gw_oidc";
/** A new Google user's parked sign-up (flows.ts), read by the sign-up step's same-origin requests only. */
const OIDC_SIGNUP_COOKIE = "__Host-gw_oidc_signup";
const OIDC_COOKIE_MAX_AGE = 10 * 60;
const OIDC_SIGNUP_MAX_AGE = 15 * 60;

/**
 * The browser that submitted a sign-up (accounts/service.ts `verifyEmail`). Lax, so it is there when the
 * person arrives from their mail client. It names no account and is the same for every sign-up answer.
 */
export const SIGNUP_COOKIE = "__Host-gw_signup";

export function setOidcCookie(c: Context, value: string): void {
  setCookie(c, OIDC_COOKIE, value, {
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "Lax",
    maxAge: OIDC_COOKIE_MAX_AGE,
  });
}
const clearCookie = (c: Context, name: string, sameSite: "Lax" | "Strict") =>
  setCookie(c, name, "", { path: "/", secure: true, httpOnly: true, sameSite, maxAge: 0 });

const Email = z.string().max(512);
const Password = z.string().max(4096);
const Token = z.string().max(256);
const Captcha = z.string().max(2048).optional();
const Next = z.string().max(2048).optional();

const CheckEmail = z.object({ status: z.literal("check-email") }).openapi("CheckEmail");
const SignedIn = z
  .object({
    status: z.enum(["signed-in", "totp-required"]),
    next: z.string().optional(),
    challenge: z.string().optional(),
    expiresAt: z.string().optional(),
    redirectTo: z.string().optional(),
    csrfToken: z.string().optional(),
  })
  .openapi("SignInResult");

export function authRoutes(k: RouteKit): void {
  const { d } = k;
  const accepted = (c: Context) => c.json({ status: "check-email" as const }, 202);

  const signedIn = (c: Context, session: IssuedSession, next?: string) => {
    setSessionCookies(c, session);
    return c.json(
      { status: "signed-in", redirectTo: safeNext(next, k.publicOrigin), csrfToken: session.csrf },
      200,
    );
  };
  const signInResult = (c: Context, r: SignInResult, next?: string) =>
    r.kind === "signed-in"
      ? signedIn(c, r.session, next)
      : c.json(
          {
            status: "totp-required",
            next: "totp",
            challenge: r.challenge,
            expiresAt: r.expiresAt.toISOString(),
          },
          200,
        );

  k.op(
    {
      method: "get",
      path: "/api/v1/auth/status",
      tag: "Cloud auth",
      summary: "Who is signed in, the active workspace and its access level",
      auth: "none",
      ok: 200,
      okSchema: z.object({ mode: z.literal("cloud"), authenticated: z.boolean() }).passthrough(),
    },
    (c) => {
      const googleSignIn = !!d.federation;
      const s = d.accounts.resolveSession(sessionCookie(c));
      if (!s)
        return c.json(
          {
            mode: "cloud",
            authenticated: false,
            csrfToken: null,
            googleSignIn,
            ...(d.captchaSiteKey ? { captcha: { siteKey: d.captchaSiteKey } } : {}),
          },
          200,
        );
      const list = d.workspaces.listForUser(s.userId);
      const m = s.activeAccountId ? d.workspaces.membership(s.activeAccountId, s.userId) : null;
      let workspace = null;
      if (m) {
        const e = d.entitlements.get(m.accountId);
        workspace = {
          id: m.accountId,
          name: list.find((w) => w.accountId === m.accountId)?.name ?? "",
          role: m.role,
          access: { level: e.level, reason: e.reason, changesAt: e.changesAt },
          trialEndsAt: e.trialEndsAt,
        };
      }
      const profile = d.accounts.personalData(s).profile as { twoFactorEnabled?: boolean };
      const methods = d.accounts.signInMethods(s.userId);
      return c.json(
        {
          mode: "cloud",
          authenticated: true,
          user: {
            id: s.userId,
            email: s.email,
            name: s.name,
            role: m?.role ?? null,
            totp: !!profile.twoFactorEnabled,
            password: methods.passwordSet,
            google: methods.identities.some((i) => i.provider === "google"),
          },
          googleSignIn,
          workspace,
          workspaces: list.map((w) => ({
            id: w.accountId,
            name: w.name,
            role: w.role,
            access: w.access,
          })),
          csrfToken: s.csrf,
          expiresAt: s.expiresAt.toISOString(),
        },
        200,
      );
    },
  );

  k.op(
    {
      method: "post",
      path: "/api/v1/auth/signup",
      tag: "Cloud auth",
      summary: 'Sign up (always 202 "check-email")',
      auth: "none",
      ok: 202,
      okSchema: CheckEmail,
      body: z.object({
        email: Email,
        password: Password,
        name: z.string().max(400),
        captchaToken: Captcha,
        termsVersion: z.string().max(64),
        /** Terms: adults only. The sign-up form's required "I am 18 or over" checkbox. */
        adultConfirmed: z.literal(true),
        /**
         * The token of the invitation this sign-up started from. Confirming the address then leads back to it
         * (`/auth/verify` answers `redirectTo` `/invite#token=…`). Ignored unless the invitation is live.
         */
        invitation: Token.optional(),
      }),
    },
    async (c, { body }) => {
      k.floodLimit(c, "auth");
      const b = body as {
        email: string;
        password: string;
        name: string;
        captchaToken?: string;
        termsVersion: string;
        adultConfirmed: true;
        invitation?: string;
      };
      // One value per browser, kept across sign-ups so an earlier link still opens here; set on every
      // accepted answer, whether or not the address had an account.
      const sent = getCookie(c, SIGNUP_COOKIE);
      const browser = sent && TOKEN_RE.test(sent) ? sent : randomToken();
      await d.accounts.signUp({ ...b, browser }, k.meta(c));
      setCookie(c, SIGNUP_COOKIE, browser, {
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
        maxAge: ACCOUNT_TTL.verifyEmail / 1000,
      });
      return accepted(c);
    },
  );

  k.op(
    {
      method: "post",
      path: "/api/v1/auth/verify",
      tag: "Cloud auth",
      summary:
        "Confirm the email address (signs in; creates the workspace and trial for a new sign-up)",
      description:
        "The link alone is enough in the browser that signed up. Any other browser gets 403 PASSWORD_REQUIRED and sends the request again with the password chosen at sign-up; a wrong password answers like a wrong sign-in (401, then 403 CAPTCHA_REQUIRED after too many) and leaves the link usable. When the sign-up started from an invitation that is still open and was sent to this address, `redirectTo` is that invitation's page (`/invite#token=…`) instead of `next`.",
      auth: "none",
      ok: 200,
      okSchema: SignedIn,
      body: z.object({
        token: Token,
        password: Password.optional(),
        captchaToken: Captcha,
        next: Next,
      }),
    },
    async (c, { body }) => {
      k.floodLimit(c, "auth");
      const b = body as { token: string; password?: string; captchaToken?: string; next?: string };
      const r = await d.accounts.verifyEmail(b.token, k.meta(c), {
        browser: getCookie(c, SIGNUP_COOKIE) ?? null,
        ...(b.password !== undefined ? { password: b.password } : {}),
        ...(b.captchaToken !== undefined ? { captchaToken: b.captchaToken } : {}),
      });
      // Back to the invitation the person signed up from; the token travels in the fragment as in its email.
      const next = r.invitation ? `/invite#token=${encodeURIComponent(r.invitation)}` : b.next;
      return signedIn(c, r.session, next);
    },
  );

  k.op(
    {
      method: "post",
      path: "/api/v1/auth/resend-verification",
      tag: "Cloud auth",
      summary: "Send the verification email again (always 202)",
      auth: "none",
      ok: 202,
      okSchema: CheckEmail,
      body: z.object({ email: Email }),
    },
    async (c, { body }) => {
      k.floodLimit(c, "auth");
      await d.accounts.resendVerification((body as { email: string }).email, k.meta(c));
      return accepted(c);
    },
  );

  k.op(
    {
      method: "post",
      path: "/api/v1/auth/signin",
      tag: "Cloud auth",
      summary: "Sign in with email and password (then TOTP when enabled)",
      auth: "none",
      ok: 200,
      okSchema: SignedIn,
      body: z.object({ email: Email, password: Password, captchaToken: Captcha, next: Next }),
    },
    async (c, { body }) => {
      k.floodLimit(c, "auth");
      const b = body as { email: string; password: string; captchaToken?: string; next?: string };
      const r = await d.accounts.signIn(b, k.meta(c));
      return signInResult(c, r, b.next);
    },
  );

  k.op(
    {
      method: "post",
      path: "/api/v1/auth/signin/totp",
      tag: "Cloud auth",
      summary: "Second factor: a TOTP code or a recovery code",
      auth: "none",
      ok: 200,
      okSchema: SignedIn,
      body: z.object({
        challenge: Token,
        code: z.string().max(16).optional(),
        recoveryCode: z.string().max(40).optional(),
        next: Next,
      }),
    },
    async (c, { body }) => {
      k.floodLimit(c, "auth");
      const b = body as { challenge: string; code?: string; recoveryCode?: string; next?: string };
      const r = await d.accounts.completeSecondFactor(b, k.meta(c));
      return signedIn(c, r.session, b.next);
    },
  );

  k.op(
    {
      method: "post",
      path: "/api/v1/auth/signout",
      tag: "Cloud auth",
      summary: "Sign out this browser",
      auth: "none",
      ok: 204,
    },
    (c) => {
      const s = d.accounts.resolveSession(sessionCookie(c));
      if (s) {
        // A signed-in browser must prove it is the page (CSRF), so another site cannot sign people out.
        k.session(c);
        d.accounts.signOut(sessionCookie(c));
      }
      clearSessionCookies(c);
      return c.body(null, 204);
    },
  );

  k.op(
    {
      method: "post",
      path: "/api/v1/auth/reauth",
      tag: "Cloud auth",
      summary: "Re-authenticate for sensitive actions (rotates the session)",
      auth: "session",
      ok: 200,
      okSchema: z.object({ status: z.literal("ok"), csrfToken: z.string() }),
      body: z.object({ password: Password.optional(), totpCode: z.string().max(16).optional() }),
    },
    async (c, { body }) => {
      const s = k.session(c);
      const issued = await d.accounts.reauthenticate(
        s,
        body as { password?: string; totpCode?: string },
        k.meta(c),
      );
      setSessionCookies(c, issued);
      return c.json({ status: "ok" as const, csrfToken: issued.csrf }, 200);
    },
  );

  k.op(
    {
      method: "post",
      path: "/api/v1/auth/password/forgot",
      tag: "Cloud auth",
      summary: "Request a password reset link (always 202)",
      auth: "none",
      ok: 202,
      okSchema: CheckEmail,
      body: z.object({ email: Email, captchaToken: Captcha }),
    },
    async (c, { body }) => {
      k.floodLimit(c, "auth");
      const b = body as { email: string; captchaToken?: string };
      await d.accounts.requestPasswordReset(b.email, b.captchaToken, k.meta(c));
      return accepted(c);
    },
  );

  k.op(
    {
      method: "post",
      path: "/api/v1/auth/password/reset",
      tag: "Cloud auth",
      summary: "Set a new password with a reset token (signs out everywhere; 2FA still applies)",
      auth: "none",
      ok: 200,
      okSchema: SignedIn,
      body: z.object({ token: Token, password: Password }),
    },
    async (c, { body }) => {
      k.floodLimit(c, "auth");
      const b = body as { token: string; password: string };
      const r = await d.accounts.resetPassword(b.token, b.password, k.meta(c));
      return signInResult(c, r);
    },
  );

  if (d.federation) googleRoutes(k);
}

/** `/api/v1/auth/google/*`: only when the Google client is configured. */
function googleRoutes(k: RouteKit): void {
  const { d } = k;
  const fed = d.federation;
  if (!fed) return;
  const tag = "Cloud auth";

  const redirect = (c: Context, path: string) => {
    // The callback URL carries the code and state: never hand it on in a Referer header.
    c.header("Referrer-Policy", "no-referrer");
    return c.redirect(path, 302);
  };

  k.op(
    {
      method: "get",
      path: "/api/v1/auth/google/start",
      tag,
      summary: "Continue with Google (redirects to Google; the sign-in page links here)",
      auth: "none",
      ok: 302,
      query: z.object({ next: Next }),
    },
    async (c, { query }) => {
      k.floodLimit(c, "auth");
      const next = safeNext(query.next, k.publicOrigin);
      const { url, browser } = await fed.startSignIn(getCookie(c, OIDC_COOKIE), next, k.meta(c));
      setOidcCookie(c, browser);
      return redirect(c, url);
    },
  );

  k.op(
    {
      method: "get",
      path: "/api/v1/auth/google/callback",
      tag,
      summary: "Where Google sends the browser back (redirects into the web app)",
      description:
        "The redirect URI registered with Google. Validates the state against this browser, exchanges the code with PKCE, validates the ID token, then signs in, asks for TOTP, asks a new person to confirm the sign-up, or explains why not.",
      auth: "none",
      ok: 302,
      query: z.object({
        code: z.string().max(4096).optional(),
        state: z.string().max(256).optional(),
        error: z.string().max(256).optional(),
      }),
    },
    async (c, { query }) => {
      k.floodLimit(c, "auth");
      const session = d.accounts.resolveSession(sessionCookie(c));
      const out = await fed.callback(
        { code: query.code, state: query.state, error: query.error },
        getCookie(c, OIDC_COOKIE),
        session,
        k.meta(c),
      );
      // Single use: the binding cookie goes whatever the outcome.
      clearCookie(c, OIDC_COOKIE, "Lax");
      return redirect(c, landing(c, out));
    },
  );

  const landing = (c: Context, out: CallbackOutcome): string => {
    switch (out.kind) {
      case "signed-in":
        setSessionCookies(c, out.session);
        return safeNext(out.next, k.publicOrigin);
      case "totp": {
        // In the fragment: never sent to a server or a Referer (as the emailed links, accounts/service.ts).
        const f = new URLSearchParams({ challenge: out.challenge, next: out.next });
        return `/signin/2fa#${f.toString()}`;
      }
      case "pending-signup":
        setCookie(c, OIDC_SIGNUP_COOKIE, out.pendingToken, {
          path: "/",
          secure: true,
          httpOnly: true,
          sameSite: "Strict",
          maxAge: OIDC_SIGNUP_MAX_AGE,
        });
        return "/signup/google";
      case "linked":
        return "/settings/security?google=linked";
      case "failed":
        if (out.intent === "link") return `/settings/security?google=${out.code}`;
        if (out.code === "exists") return "/signin/google-exists";
        return `/signin?google=${out.code}`;
    }
  };

  k.op(
    {
      method: "get",
      path: "/api/v1/auth/google/pending",
      tag,
      summary: "The new Google user's sign-up step: the name to prefill and the address",
      auth: "none",
      ok: 200,
      okSchema: z.object({ name: z.string(), email: z.string() }),
    },
    (c) => {
      k.floodLimit(c, "auth");
      const p = fed.pending(getCookie(c, OIDC_SIGNUP_COOKIE));
      if (!p)
        throw new CloudError(
          400,
          "INVALID_TOKEN",
          "this sign-up has expired; continue with Google again",
        );
      return c.json(p, 200);
    },
  );

  k.op(
    {
      method: "post",
      path: "/api/v1/auth/google/complete",
      tag,
      summary: "Create the account for a new Google user (name, 18 or over, terms), then sign in",
      auth: "none",
      ok: 200,
      okSchema: SignedIn,
      body: z.object({
        name: z.string().max(400),
        termsVersion: z.string().max(64),
        adultConfirmed: z.literal(true),
      }),
    },
    async (c, { body }) => {
      k.floodLimit(c, "auth");
      const b = body as { name: string; termsVersion: string; adultConfirmed: true };
      try {
        const r = await fed.completeSignup(getCookie(c, OIDC_SIGNUP_COOKIE), b, k.meta(c));
        clearCookie(c, OIDC_SIGNUP_COOKIE, "Strict");
        setSessionCookies(c, r.session);
        return c.json(
          {
            status: "signed-in",
            redirectTo: safeNext(r.next, k.publicOrigin),
            csrfToken: r.session.csrf,
          },
          200,
        );
      } catch (err) {
        // The parked sign-up is used up unless the form itself was wrong.
        if (!(err instanceof CloudError && err.code === "VALIDATION"))
          clearCookie(c, OIDC_SIGNUP_COOKIE, "Strict");
        throw err;
      }
    },
  );
}
