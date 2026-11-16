/**
 * Browser authentication routes (`/api/v1/auth/*`). These are public (no API key): they are how a
 * browser gets a session. See services/svc(c).auth.ts for the model.
 */

import { getConnInfo } from "@hono/node-server/conninfo";
import { createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import {
  assertCsrf,
  CSRF_COOKIE,
  LEGACY_CSRF_COOKIE,
  LEGACY_SESSION_COOKIE,
  loadUser,
  ROLES,
  SESSION_COOKIE,
  sessionToken,
  verifyKey,
} from "../auth.js";
import { ApiError, ErrorBody } from "../errors.js";
import type { IssuedSession } from "../services/auth.js";
import { MIN_PASSPHRASE_LENGTH } from "../services/auth.js";
import { json, type RouteCtx } from "./helpers.js";

export interface AuthRouteOptions {
  /** `true`/`false` to force the cookie Secure flag; `auto` = when the request arrived over https. */
  cookieSecure: boolean | "auto";
  /** Trust X-Forwarded-For for the client address used by login throttling (behind a reverse proxy). */
  trustProxy: boolean;
  webOrigin?: string | undefined;
}

const Status = z
  .object({
    setupRequired: z.boolean().describe("True until the first passphrase has been set."),
    setupTokenRequired: z
      .boolean()
      .optional()
      .describe(
        "Present while `setupRequired`: true when the server has GLIDEWORTH_SETUP_TOKEN, so the setup screen must ask for it.",
      ),
    authenticated: z.boolean(),
    via: z.enum(["session", "key"]).optional(),
    user: z
      .object({ id: z.string(), name: z.string(), role: z.enum(ROLES as [string, ...string[]]) })
      .optional()
      .describe("Who is signed in and with which role (owner, editor, viewer)."),
    multiUser: z
      .boolean()
      .optional()
      .describe(
        "True once the owner has invited someone: the login screen should then ask for a sign-in name.",
      ),
    csrfToken: z
      .string()
      .optional()
      .describe(
        "Session only. Send it back as `X-CSRF-Token` on every write (also available in the `glideworth_csrf` cookie).",
      ),
    expiresAt: z.string().optional(),
  })
  .meta({ id: "AuthStatus" });
const Opened = z
  .object({
    csrfToken: z.string(),
    expiresAt: z.string(),
    user: z
      .object({ id: z.string(), name: z.string(), role: z.enum(ROLES as [string, ...string[]]) })
      .optional(),
  })
  .meta({ id: "AuthSession" });
const Passphrase = z.string().min(1).max(1024);

const errs = {
  400: json(ErrorBody, "Invalid request"),
  401: json(ErrorBody, "Wrong passphrase / not signed in"),
  403: json(ErrorBody, "CSRF check failed or setup token missing"),
  409: json(ErrorBody, "Already configured / setup required"),
  429: json(ErrorBody, "Too many failed attempts (Retry-After)"),
};

export function authRoutes({ app, svc }: RouteCtx, opts: AuthRouteOptions) {
  const P = "/api/v1/auth";

  const secureFor = (c: Context) =>
    opts.cookieSecure === "auto"
      ? new URL(c.req.url).protocol === "https:" ||
        c.req.header("x-forwarded-proto")?.split(",")[0]?.trim() === "https"
      : opts.cookieSecure;

  function clientOf(c: Context): string {
    if (opts.trustProxy) {
      const fwd = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
      if (fwd) return fwd;
    }
    try {
      return getConnInfo(c).remote.address ?? "unknown";
    } catch {
      return "unknown";
    }
  }

  function setSessionCookies(c: Context, s: IssuedSession) {
    const secure = secureFor(c);
    setCookie(c, SESSION_COOKIE, s.token, {
      httpOnly: true,
      sameSite: "Strict",
      path: "/",
      maxAge: s.maxAgeSeconds,
      expires: s.expiresAt,
      secure,
    });
    // Readable by the web app (not httpOnly) so it can echo it in X-CSRF-Token. Useless without the session cookie.
    setCookie(c, CSRF_COOKIE, s.csrf, {
      httpOnly: false,
      sameSite: "Strict",
      path: "/",
      maxAge: s.maxAgeSeconds,
      expires: s.expiresAt,
      secure,
    });
  }

  function clearCookies(c: Context) {
    const secure = secureFor(c);
    for (const name of [SESSION_COOKIE, CSRF_COOKIE, LEGACY_SESSION_COOKIE, LEGACY_CSRF_COOKIE])
      deleteCookie(c, name, { path: "/", secure });
  }

  /** A session signed in before the rename (old cookie names) moves to the new cookie names, same session. */
  function renameLegacyCookies(c: Context, s: { csrf: string; expiresAt: string }) {
    const token = getCookie(c, LEGACY_SESSION_COOKIE);
    if (getCookie(c, SESSION_COOKIE) || !token) return;
    const expiresAt = new Date(s.expiresAt);
    const maxAgeSeconds = Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
    setSessionCookies(c, { token, csrf: s.csrf, expiresAt, maxAgeSeconds });
    const secure = secureFor(c);
    deleteCookie(c, LEGACY_SESSION_COOKIE, { path: "/", secure });
    deleteCookie(c, LEGACY_CSRF_COOKIE, { path: "/", secure });
  }

  const opened = (c: Context, s: IssuedSession, userId?: string) => {
    const u = userId ? loadUser(svc(c).db, userId) : null;
    return { csrfToken: s.csrf, expiresAt: s.expiresAt.toISOString(), ...(u ? { user: u } : {}) };
  };
  const auditAuth = (action: string, userId: string, c: Context) => {
    const u = loadUser(svc(c).db, userId);
    svc(c).audit.record({
      userId,
      userName: u?.name ?? null,
      via: "session",
      action,
      resourceType: "user",
      resourceId: userId,
      status: 200,
      detail: { userAgent: c.req.header("user-agent")?.slice(0, 120) ?? null },
    });
  };

  /** Same-origin check for the unauthenticated POSTs (login/setup): a cross-site page must not drive them. */
  function sameOrigin(c: Context) {
    const origin = c.req.header("origin");
    if (!origin) return;
    let host: string;
    try {
      host = new URL(origin).host;
    } catch {
      throw new ApiError(403, "CSRF", "invalid Origin");
    }
    const allowed = [c.req.header("host"), c.req.header("x-forwarded-host")?.split(",")[0]?.trim()];
    if (opts.webOrigin) allowed.push(new URL(opts.webOrigin).host);
    if (!allowed.includes(host))
      throw new ApiError(403, "CSRF", "cross-origin request rejected", { origin });
  }

  /** The session behind the request cookie, with its CSRF check done (for state-changing auth routes). */
  function sessionOf(c: Context, enforceCsrf: boolean) {
    const s = svc(c).auth.resolve(sessionToken(c));
    if (s && enforceCsrf) assertCsrf(c, s.csrf, opts.webOrigin);
    return s;
  }

  app.openapi(
    createRoute({
      method: "get",
      path: `${P}/status`,
      operationId: "authStatus",
      tags: ["Auth"],
      security: [], // public: this is how a browser gets a session
      summary: "Who am I, and is first-run setup needed? Public",
      description:
        "The web app calls this on load: `setupRequired` -> show the set-passphrase screen; otherwise `authenticated` false -> show login. When signed in by session it returns the `csrfToken` to send on writes.",
      responses: { 200: json(Status, "Status") },
    }),
    (c) => {
      const setupRequired = !svc(c).auth.isConfigured();
      const extra = {
        ...(setupRequired ? { setupTokenRequired: svc(c).auth.setupTokenRequired() } : {}),
        multiUser: svc(c).users.list().length > 1,
      };
      const header = c.req.header("authorization") ?? "";
      const keyed = header.startsWith("Bearer ")
        ? verifyKey(svc(c).db, header.slice(7).trim())
        : null;
      if (keyed)
        return c.json(
          {
            setupRequired,
            ...extra,
            authenticated: true,
            via: "key" as const,
            user: { id: keyed.userId, name: keyed.userName, role: keyed.role },
          },
          200,
        );
      const s = sessionOf(c, false);
      const u = s ? loadUser(svc(c).db, s.userId) : null;
      if (s && u) renameLegacyCookies(c, s);
      return c.json(
        s && u
          ? {
              setupRequired,
              ...extra,
              authenticated: true,
              via: "session" as const,
              user: u,
              csrfToken: s.csrf,
              expiresAt: s.expiresAt,
            }
          : { setupRequired, ...extra, authenticated: false },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: `${P}/setup`,
      operationId: "authSetup",
      tags: ["Auth"],
      security: [], // public: this is how a browser gets a session
      summary: "First run: set the passphrase and sign in. Only works while no passphrase exists",
      description: `Passphrase: at least ${MIN_PASSPHRASE_LENGTH} characters. If the server sets GLIDEWORTH_SETUP_TOKEN, send it as \`setupToken\` so nobody else can claim a fresh instance.`,
      request: {
        body: {
          content: {
            "application/json": {
              schema: z
                .object({ passphrase: Passphrase, setupToken: z.string().max(200).optional() })
                .meta({ id: "AuthSetup" }),
            },
          },
          required: true,
        },
      },
      responses: { 201: json(Opened, "Passphrase set; session cookies issued"), ...errs },
    }),
    async (c) => {
      sameOrigin(c);
      const b = c.req.valid("json");
      await svc(c).auth.setup(b.passphrase, b.setupToken, clientOf(c));
      const s = svc(c).auth.issue("owner", c.req.header("user-agent"));
      setSessionCookies(c, s);
      auditAuth("auth.setup", "owner", c);
      return c.json(opened(c, s, "owner"), 201);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: `${P}/login`,
      operationId: "authLogin",
      tags: ["Auth"],
      security: [], // public: this is how a browser gets a session
      summary: "Log in with the passphrase. Sets an httpOnly, SameSite=Strict session cookie",
      description:
        "Failed attempts are rate limited per client and globally (429 with Retry-After). The response carries the CSRF token (also set as the readable `glideworth_csrf` cookie): send it as `X-CSRF-Token` on every write.",
      request: {
        body: {
          content: {
            "application/json": {
              schema: z
                .object({
                  passphrase: Passphrase,
                  user: z
                    .string()
                    .min(1)
                    .max(64)
                    .optional()
                    .describe(
                      "Sign-in name. Omit it for the owner: a single-user instance never needs it.",
                    ),
                })
                .meta({ id: "AuthLogin" }),
            },
          },
          required: true,
        },
      },
      responses: { 200: json(Opened, "Signed in"), ...errs },
    }),
    async (c) => {
      sameOrigin(c);
      try {
        const b = c.req.valid("json");
        const s = await svc(c).auth.login(
          b.passphrase,
          clientOf(c),
          c.req.header("user-agent"),
          b.user,
        );
        setSessionCookies(c, s);
        auditAuth("auth.login", s.userId, c);
        return c.json(opened(c, s, s.userId), 200);
      } catch (err) {
        if (err instanceof ApiError && err.status === 429)
          c.header(
            "Retry-After",
            String((err.details as { retryAfterSeconds?: number })?.retryAfterSeconds ?? 60),
          );
        throw err;
      }
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: `${P}/logout`,
      operationId: "authLogout",
      tags: ["Auth"],
      security: [], // public: this is how a browser gets a session
      summary: "End the session and clear the cookies (needs X-CSRF-Token)",
      responses: { 204: { description: "Signed out" }, 403: errs[403] },
    }),
    (c) => {
      sessionOf(c, true);
      svc(c).auth.logout(sessionToken(c));
      clearCookies(c);
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: `${P}/change-passphrase`,
      operationId: "authChangePassphrase",
      tags: ["Auth"],
      security: [], // public: this is how a browser gets a session
      summary: "Change your own passphrase. Signs out all your other sessions",
      request: {
        body: {
          content: {
            "application/json": {
              schema: z
                .object({ current: Passphrase, next: Passphrase })
                .meta({ id: "AuthChangePassphrase" }),
            },
          },
          required: true,
        },
      },
      responses: { 200: json(Opened, "Changed; a fresh session was issued"), ...errs },
    }),
    async (c) => {
      const s = sessionOf(c, true);
      const header = c.req.header("authorization") ?? "";
      const key = header.startsWith("Bearer ")
        ? verifyKey(svc(c).db, header.slice(7).trim())
        : null;
      const keyUser = key?.scopes.includes("write") ? key.userId : null;
      const userId = s?.userId ?? keyUser;
      if (!userId) throw new ApiError(401, "UNAUTHORIZED", "sign in first");
      const b = c.req.valid("json");
      await svc(c).auth.changePassphrase(userId, b.current, b.next, clientOf(c));
      const fresh = svc(c).auth.issue(userId, c.req.header("user-agent"));
      setSessionCookies(c, fresh);
      auditAuth("auth.change-passphrase", userId, c);
      return c.json(opened(c, fresh, userId), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: `${P}/accept`,
      operationId: "authAccept",
      tags: ["Auth"],
      security: [], // public: the one-time token is the credential
      summary: "Accept an invite or a passphrase reset: choose a passphrase and sign in",
      description:
        "The owner gives the invitee a one-time token (from `POST /users` or `POST /users/{id}/reset-passphrase`, usually inside a link). It works once and expires after 7 days. Opens a session like login does.",
      request: {
        body: {
          content: {
            "application/json": {
              schema: z
                .object({ token: z.string().min(20).max(200), passphrase: Passphrase })
                .meta({ id: "AuthAccept" }),
            },
          },
          required: true,
        },
      },
      responses: { 200: json(Opened, "Passphrase set; session cookies issued"), ...errs },
    }),
    async (c) => {
      sameOrigin(c);
      const b = c.req.valid("json");
      const user = await svc(c).users.accept(b.token, b.passphrase);
      const s = svc(c).auth.issue(user.id, c.req.header("user-agent"));
      setSessionCookies(c, s);
      auditAuth("auth.accept", user.id, c);
      return c.json(opened(c, s, user.id), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: `${P}/logout-all`,
      operationId: "authLogoutAll",
      tags: ["Auth"],
      security: [],
      summary: "Sign out everywhere (every session of the signed-in user, including this one)",
      responses: { 204: { description: "Signed out" }, 401: errs[401], 403: errs[403] },
    }),
    (c) => {
      const s = sessionOf(c, true);
      if (!s) throw new ApiError(401, "UNAUTHORIZED", "sign in first");
      svc(c).auth.logoutUser(s.userId);
      clearCookies(c);
      return c.body(null, 204);
    },
  );
}
