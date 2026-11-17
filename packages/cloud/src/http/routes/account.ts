/**
 * `/api/v1/account/*` and `DELETE /api/v1/account` (spec 3.2-3.5, 3.8, 3.9): the signed-in person's own
 * profile, email, password, sessions, two-factor settings, personal data and deletion.
 */
import { z } from "@hono/zod-openapi";
import { getCookie } from "hono/cookie";
import { clearSessionCookies, setSessionCookies } from "../common.js";
import type { RouteKit } from "../kit.js";
import { clearCookie, OIDC_COOKIE, OIDC_LINK_COOKIE, setOidcCookie } from "./auth.js";

const Ok = z.object({ status: z.literal("ok") });

export function accountRoutes(k: RouteKit): void {
  const { d } = k;
  const tag = "Cloud account";

  k.op(
    {
      method: "get",
      path: "/api/v1/account/profile",
      tag,
      summary: "Profile and notification settings",
      auth: "session",
      ok: 200,
      okSchema: z.object({ id: z.string(), email: z.string(), name: z.string() }).passthrough(),
    },
    (c) => {
      const s = k.session(c);
      const p = d.accounts.personalData(s).profile as Record<string, unknown>;
      return c.json(
        {
          id: s.userId,
          email: s.email,
          name: s.name,
          emailVerifiedAt: p.emailVerifiedAt,
          twoFactorEnabled: p.twoFactorEnabled,
          signinAlerts: p.signinAlerts,
          checkinEmails: p.checkinEmails,
          // Sign-in methods (security settings): whether a password exists, which providers are linked.
          ...d.accounts.signInMethods(s.userId),
          googleSignIn: !!d.federation,
        },
        200,
      );
    },
  );

  k.op(
    {
      method: "patch",
      path: "/api/v1/account/profile",
      tag,
      summary: "Change name or notification settings",
      auth: "session",
      ok: 200,
      okSchema: Ok,
      body: z.object({
        name: z.string().max(400).optional(),
        signinAlerts: z.boolean().optional(),
        checkinEmails: z.boolean().optional(),
      }),
    },
    async (c, { body }) => {
      const s = k.session(c);
      // A new name is in every workspace's member list before the answer (API keys, credentials).
      await d.accounts.updateProfile(
        s,
        body as { name?: string; signinAlerts?: boolean; checkinEmails?: boolean },
      );
      return c.json({ status: "ok" as const }, 200);
    },
  );

  k.op(
    {
      method: "post",
      path: "/api/v1/account/email",
      tag,
      summary: "Change email address (re-authentication; confirm from the new address)",
      auth: "session",
      ok: 202,
      okSchema: z.object({ status: z.literal("check-email") }),
      body: z.object({ email: z.string().max(512) }),
    },
    async (c, { body }) => {
      const s = k.session(c);
      await d.accounts.requestEmailChange(s, (body as { email: string }).email, k.meta(c));
      return c.json({ status: "check-email" as const }, 202);
    },
  );

  k.op(
    {
      method: "post",
      path: "/api/v1/account/email/confirm",
      tag,
      summary: "Confirm a new email address with the emailed token",
      auth: "none",
      ok: 200,
      okSchema: Ok,
      body: z.object({ token: z.string().max(256) }),
    },
    async (c, { body }) => {
      k.floodLimit(c, "auth");
      await d.accounts.confirmEmailChange((body as { token: string }).token, k.meta(c));
      return c.json({ status: "ok" as const }, 200);
    },
  );

  k.op(
    {
      method: "post",
      path: "/api/v1/account/password",
      tag,
      summary: "Change password (current password required; signs out every other session)",
      auth: "session",
      ok: 200,
      okSchema: z.object({ status: z.literal("ok"), csrfToken: z.string() }),
      body: z.object({ current: z.string().max(4096), next: z.string().max(4096) }),
    },
    async (c, { body }) => {
      const s = k.session(c);
      const b = body as { current: string; next: string };
      const issued = await d.accounts.changePassword(s, b.current, b.next, k.meta(c));
      setSessionCookies(c, issued);
      return c.json({ status: "ok" as const, csrfToken: issued.csrf }, 200);
    },
  );

  k.op(
    {
      method: "post",
      path: "/api/v1/account/password/setup",
      tag,
      summary: "No password yet (Google sign-in): email a link that sets the first password",
      auth: "session",
      ok: 202,
      okSchema: z.object({ status: z.literal("check-email") }),
    },
    (c) => {
      d.accounts.requestPasswordSetup(k.session(c));
      return c.json({ status: "check-email" as const }, 202);
    },
  );

  const fed = d.federation;
  if (fed) {
    k.op(
      {
        method: "post",
        path: "/api/v1/account/identities/google",
        tag,
        summary:
          "Link a Google account (re-authentication); answers the Google URL to open in this browser",
        auth: "session",
        ok: 200,
        okSchema: z.object({ url: z.string() }),
      },
      async (c) => {
        const s = k.session(c);
        const { url, browser } = await fed.startLink(s, getCookie(c, OIDC_COOKIE), k.meta(c));
        setOidcCookie(c, browser);
        return c.json({ url }, 200);
      },
    );

    k.op(
      {
        method: "post",
        path: "/api/v1/account/identities/google/finish",
        tag,
        summary:
          "Finish linking the Google account chosen at Google (the web app's /google-link page)",
        description:
          "Google's redirect cannot finish a link: browsers do not send the SameSite=Strict session cookie on a navigation that starts on Google's page. The callback parks the Google account in a short-lived record bound to this browser, and the web app posts here, with the session and the CSRF token. `google` is `linked`, or why not: `expired` (nothing parked, used, or older than 10 minutes), `session` (not the session that started the link), `taken` or `already-linked`. The parked record is used up either way.",
        auth: "session",
        ok: 200,
        okSchema: z.object({
          google: z.enum(["linked", "expired", "session", "taken", "already-linked"]),
        }),
      },
      (c) => {
        const s = k.session(c);
        const google = fed.finishLink(s, getCookie(c, OIDC_LINK_COOKIE), k.meta(c));
        clearCookie(c, OIDC_LINK_COOKIE, "Lax");
        return c.json({ google }, 200);
      },
    );

    k.op(
      {
        method: "delete",
        path: "/api/v1/account/identities/google",
        tag,
        summary: "Unlink Google (re-authentication; only while a password exists)",
        auth: "session",
        ok: 204,
      },
      (c) => {
        fed.unlink(k.session(c), k.meta(c));
        return c.body(null, 204);
      },
    );
  }

  k.op(
    {
      method: "get",
      path: "/api/v1/account/sessions",
      tag,
      summary: "Signed-in browsers",
      auth: "session",
      ok: 200,
      okSchema: z.object({ items: z.array(z.object({ id: z.string() }).passthrough()) }),
    },
    (c) => c.json({ items: d.accounts.listSessions(k.session(c)) }, 200),
  );

  k.op(
    {
      method: "delete",
      path: "/api/v1/account/sessions/{id}",
      tag,
      summary: "Sign out one browser",
      auth: "session",
      ok: 204,
      params: z.object({ id: z.string().max(64) }),
    },
    (c, { params }) => {
      d.accounts.revokeSession(k.session(c), params.id as string);
      return c.body(null, 204);
    },
  );

  k.op(
    {
      method: "post",
      path: "/api/v1/account/sessions/revoke-others",
      tag,
      summary: "Sign out every other browser",
      auth: "session",
      ok: 200,
      okSchema: z.object({ revoked: z.number() }),
    },
    (c) => c.json({ revoked: d.accounts.revokeOtherSessions(k.session(c)) }, 200),
  );

  k.op(
    {
      method: "post",
      path: "/api/v1/account/totp/begin",
      tag,
      summary: "Start two-factor enrolment (re-authentication)",
      auth: "session",
      ok: 200,
      okSchema: z.object({ secret: z.string(), otpauthUri: z.string() }),
    },
    (c) => c.json(d.accounts.beginTotp(k.session(c)), 200),
  );

  k.op(
    {
      method: "post",
      path: "/api/v1/account/totp/confirm",
      tag,
      summary: "Confirm enrolment with a code; returns 10 recovery codes once",
      auth: "session",
      ok: 200,
      okSchema: z.object({ recoveryCodes: z.array(z.string()) }),
      body: z.object({ code: z.string().max(16) }),
    },
    (c, { body }) =>
      c.json(d.accounts.confirmTotp(k.session(c), (body as { code: string }).code), 200),
  );

  k.op(
    {
      method: "delete",
      path: "/api/v1/account/totp",
      tag,
      summary: "Turn two-factor authentication off (a current code or a recovery code)",
      auth: "session",
      ok: 204,
      body: z.object({ code: z.string().max(40) }),
    },
    async (c, { body }) => {
      await d.accounts.disableTotp(k.session(c), (body as { code: string }).code, k.meta(c));
      return c.body(null, 204);
    },
  );

  k.op(
    {
      method: "post",
      path: "/api/v1/account/recovery-codes",
      tag,
      summary: "Replace the recovery codes (re-authentication)",
      auth: "session",
      ok: 200,
      okSchema: z.object({ recoveryCodes: z.array(z.string()) }),
    },
    (c) => c.json(d.accounts.regenerateRecoveryCodes(k.session(c)), 200),
  );

  k.op(
    {
      method: "get",
      path: "/api/v1/account/personal-data",
      tag,
      summary: "Your control-plane data as JSON (profile, memberships, sessions, security events)",
      auth: "session",
      ok: 200,
      okSchema: z.object({}).passthrough(),
    },
    (c) => {
      const data = d.accounts.personalData(k.session(c));
      c.header("Content-Disposition", 'attachment; filename="glideworth-personal-data.json"');
      return c.json(data, 200);
    },
  );

  k.op(
    {
      method: "delete",
      path: "/api/v1/account",
      tag,
      summary: "Delete your account (re-authentication; a sole-owner workspace is deleted with it)",
      auth: "session",
      ok: 204,
    },
    async (c) => {
      await d.accounts.deleteUser(k.session(c), k.meta(c));
      clearSessionCookies(c);
      return c.body(null, 204);
    },
  );
}
