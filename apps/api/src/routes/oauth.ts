/**
 * OAuth 2.1 endpoints for remote MCP clients. Plain Hono routes (not part of /api/v1 or its OpenAPI document):
 *
 *   GET  /.well-known/oauth-protected-resource[/mcp]   RFC 9728 protected resource metadata
 *   GET  /.well-known/oauth-authorization-server       RFC 8414 authorization server metadata
 *   POST /oauth/register                               RFC 7591 dynamic client registration (public clients)
 *   GET  /oauth/authorize                              consent screen (signs the user in when needed)
 *   POST /oauth/authorize                              the user's decision -> redirect with `code` and `iss`
 *   POST /oauth/login                                  sign-in from the consent screen
 *   POST /oauth/token                                  authorization_code (PKCE) and refresh_token grants
 *   POST /oauth/revoke                                 RFC 7009
 */
import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context, Hono } from "hono";
import { setCookie } from "hono/cookie";
import {
  CSRF_COOKIE,
  loadUser,
  ROLE_SCOPES,
  SCOPES,
  SESSION_COOKIE,
  sessionToken,
} from "../auth.js";
import { ApiError, cloudLikeError } from "../errors.js";
import { ipRateLimit } from "../middleware.js";
import { OAuthError, type OAuthService, parseScopes } from "../services/oauth.js";
import type { Services } from "../services.js";

export interface OAuthRouteOptions {
  /** Public base URL (GLIDEWORTH_PUBLIC_URL). Without it the origin of the request is used. */
  publicUrl?: string | undefined;
  trustProxy: boolean;
  cookieSecure: boolean | "auto";
  webOrigin?: string | undefined;
  allowWrites: boolean;
  /** Cloud mode: people, workspaces and tenants come from the control plane (spec 9 steps 14, 20). */
  cloud?: CloudOAuth;
}

/**
 * What the OAuth endpoints need in cloud mode. Clients are registered in the control plane (registration is
 * unauthenticated and happens before anyone signs in); people sign in with their cloud account; consent picks
 * one of their workspaces; codes and tokens are routed (`gwc_`/`gwr_`/`gwa_<account>_…`) so the token and
 * revocation endpoints find the workspace without any global index.
 */
export interface CloudOAuth {
  /** An `OAuthService` over the control-plane client registry (register and validate requests only). */
  registry: OAuthService;
  /** The signed-in person (cloud session cookie), or null. */
  session(c: Context): { userId: string; name: string; csrf: string } | null;
  workspaces(userId: string): Array<{ accountId: string; name: string; role: string }>;
  /** The membership, read again at approval (removal applies at once). */
  membership(
    accountId: string,
    userId: string,
  ): { tenantUserId: string; role: "owner" | "editor" | "viewer"; userName: string } | null;
  /** Run `fn` with the workspace's services under a lease; throws when the workspace cannot be used. */
  withTenant<T>(accountId: string, fn: (s: Services) => T | Promise<T>): Promise<T>;
  /** The workspace a routed OAuth credential names, when it is one of `kinds`. */
  accountOf(
    token: string,
    kinds: ReadonlyArray<"oauth_code" | "oauth_refresh" | "oauth_access">,
  ): string | null;
  /** Same-origin relative sign-in URL that returns to `next`. */
  signinUrl(next: string): string;
}

const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
  );

/** The authorization request parameters carried through the consent form. */
const AUTHORIZE_FIELDS = [
  "client_id",
  "redirect_uri",
  "state",
  "code_challenge",
  "code_challenge_method",
  "response_type",
  "resource",
  "scope",
] as const;

const SCOPE_TEXT: Record<string, string> = {
  read: "See your households, plans, balances and results",
  simulate: "Run projections, Monte Carlo and what-if previews",
  write: "Change things: edit plans, record balances and snapshots",
};

const PAGE_CSS = `body{font:16px/1.5 system-ui,sans-serif;background:#f6f5f2;color:#1d2420;margin:0;display:grid;place-items:center;min-height:100vh}
main{background:#fff;max-width:30rem;margin:1rem;padding:1.5rem 1.75rem;border-radius:12px;box-shadow:0 1px 8px #0002}
h1{font-size:1.25rem;margin:0 0 .75rem}code{background:#eee;padding:.1rem .3rem;border-radius:4px;word-break:break-all}
label{display:block;margin:.4rem 0}input[type=text],input[type=password]{width:100%;box-sizing:border-box;padding:.5rem;margin:.25rem 0 .75rem;font:inherit}
button{font:inherit;padding:.55rem 1.1rem;border-radius:8px;border:1px solid #1d2420;background:#1d2420;color:#fff;cursor:pointer;margin-right:.5rem}
button.secondary{background:#fff;color:#1d2420}.err{color:#a40000}.muted{color:#555;font-size:.9rem}
@media (prefers-color-scheme:dark){body{background:#151a17;color:#e8ece9}main{background:#1f2622}code{background:#2c342f}button{background:#e8ece9;color:#151a17;border-color:#e8ece9}button.secondary{background:#1f2622;color:#e8ece9}.muted{color:#aab}.err{color:#ff8a8a}}`;

function page(
  c: Context,
  title: string,
  body: string,
  status: 200 | 400 | 401 | 429 = 200,
  head = "",
) {
  c.header("Cache-Control", "no-store");
  c.header("X-Frame-Options", "DENY");
  c.header(
    "Content-Security-Policy",
    "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
  );
  return c.html(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title><style>${PAGE_CSS}</style>${head}</head><body><main>${body}</main></body></html>`,
    status,
  );
}

export function oauthRoutes(
  // oxlint-disable-next-line typescript/no-explicit-any -- the registrar only needs plain Hono routes
  app: Hono<any>,
  svc: (c: Context) => Services,
  opts: OAuthRouteOptions,
) {
  const secureFor = (c: Context) =>
    opts.cookieSecure === "auto"
      ? new URL(c.req.url).protocol === "https:" ||
        c.req.header("x-forwarded-proto")?.split(",")[0]?.trim() === "https"
      : opts.cookieSecure;

  const clientIp = (c: Context): string => {
    if (opts.trustProxy) {
      const f = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
      if (f) return f;
    }
    try {
      return getConnInfo(c).remote.address ?? "unknown";
    } catch {
      return "unknown";
    }
  };
  const limit = (perMinute: number) => ipRateLimit(perMinute, clientIp);

  const sameOrigin = (c: Context) => {
    const origin = c.req.header("origin");
    if (!origin) return;
    let host: string;
    try {
      host = new URL(origin).host;
    } catch {
      throw new ApiError(403, "CSRF", "invalid Origin");
    }
    const allowed = [c.req.header("host"), c.req.header("x-forwarded-host")?.split(",")[0]?.trim()];
    if (opts.publicUrl) allowed.push(new URL(opts.publicUrl).host);
    if (opts.webOrigin) allowed.push(new URL(opts.webOrigin).host);
    if (!allowed.includes(host)) throw new ApiError(403, "CSRF", "cross-origin request rejected");
  };

  /** `https://host` (no trailing slash): the OAuth issuer and the base of every endpoint. */
  const issuer = (c: Context): string => {
    if (opts.publicUrl) return opts.publicUrl.replace(/\/+$/, "");
    if (opts.trustProxy) {
      const proto = c.req.header("x-forwarded-proto")?.split(",")[0]?.trim();
      const host = c.req.header("x-forwarded-host")?.split(",")[0]?.trim();
      if (proto && host) return `${proto}://${host}`;
    }
    return new URL(c.req.url).origin;
  };
  const mcpResource = (c: Context) => `${issuer(c)}/mcp`;
  app.use("/oauth/*", async (c, next) => {
    // Never let a proxy or browser cache anything issued here.
    await next();
    c.header("Cache-Control", "no-store");
    c.header("Pragma", "no-cache");
  });

  // ----------------------------------------------------------------------------- discovery
  const protectedResource = (c: Context) =>
    c.json({
      resource: mcpResource(c),
      authorization_servers: [issuer(c)],
      scopes_supported: SCOPES,
      bearer_methods_supported: ["header"],
      resource_name: "Glideworth MCP server",
      resource_documentation: `${issuer(c)}/docs`,
    });
  app.get("/.well-known/oauth-protected-resource", protectedResource);
  app.get("/.well-known/oauth-protected-resource/mcp", protectedResource);

  const asMetadata = (c: Context) => {
    const i = issuer(c);
    return c.json({
      issuer: i,
      authorization_endpoint: `${i}/oauth/authorize`,
      token_endpoint: `${i}/oauth/token`,
      registration_endpoint: `${i}/oauth/register`,
      revocation_endpoint: `${i}/oauth/revoke`,
      scopes_supported: SCOPES,
      response_types_supported: ["code"],
      response_modes_supported: ["query"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none"],
      revocation_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"],
      authorization_response_iss_parameter_supported: true,
      client_id_metadata_document_supported: false,
      service_documentation: `${i}/docs`,
    });
  };
  app.get("/.well-known/oauth-authorization-server", asMetadata);
  // Clients that discover with OpenID Connect fall back to this; the content is the same.
  app.get("/.well-known/openid-configuration", asMetadata);

  // ----------------------------------------------------------------------------- registration
  const oauthJson = async (c: Context, fn: () => unknown, ok: 200 | 201 = 200) => {
    try {
      return c.json((await fn()) as never, ok);
    } catch (err) {
      if (err instanceof OAuthError)
        return c.json({ error: err.error, error_description: err.description }, err.status as 400);
      const limited = cloudLikeError(err);
      if (limited && (limited.status === 429 || limited.status === 503)) {
        const retry = (limited.details as { retryAfterSeconds?: unknown } | undefined)
          ?.retryAfterSeconds;
        c.header("Retry-After", String(typeof retry === "number" ? retry : 60));
        return c.json(
          { error: "temporarily_unavailable", error_description: limited.message },
          limited.status as 429,
        );
      }
      throw err;
    }
  };
  /** Client registration and request validation: the control plane in cloud, this database in self-host. */
  const clients = (c: Context): OAuthService => opts.cloud?.registry ?? svc(c).oauth;
  app.post("/oauth/register", limit(20), async (c) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== "object")
      return c.json(
        { error: "invalid_client_metadata", error_description: "send a JSON object" },
        400,
      );
    const strs = (v: unknown) =>
      Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : undefined;
    return oauthJson(
      c,
      () =>
        clients(c).register(
          {
            client_name: typeof body.client_name === "string" ? body.client_name : undefined,
            redirect_uris: strs(body.redirect_uris) ?? [],
            token_endpoint_auth_method:
              typeof body.token_endpoint_auth_method === "string"
                ? body.token_endpoint_auth_method
                : undefined,
            grant_types: strs(body.grant_types),
            response_types: strs(body.response_types),
            scope: typeof body.scope === "string" ? body.scope : undefined,
          },
          clientIp(c),
        ),
      201,
    );
  });

  // ----------------------------------------------------------------------------- authorize
  const currentUser = (c: Context) => {
    const s = svc(c).auth.resolve(sessionToken(c));
    const u = s ? loadUser(svc(c).db, s.userId) : null;
    return s && u ? { session: s, user: u } : null;
  };

  const redirectWith = (
    c: Context,
    redirectUri: string,
    params: Record<string, string | undefined>,
  ) => {
    const u = new URL(redirectUri);
    for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
    u.searchParams.set("iss", issuer(c));
    return c.redirect(u.toString(), 302);
  };

  /** Parse + validate; returns the request, or a Response for errors. */
  const checkRequest = (c: Context, q: Record<string, string | undefined>) => {
    try {
      const r = clients(c).validateAuthorize(q);
      if (q.resource && q.resource !== mcpResource(c))
        throw Object.assign(
          new OAuthError("invalid_target", `resource must be ${mcpResource(c)}`),
          {
            redirectable: true,
            redirectUri: r.redirectUri,
            state: q.state,
          },
        );
      return { ok: true as const, r };
    } catch (err) {
      if (!(err instanceof OAuthError)) throw err;
      const e = err as OAuthError & {
        redirectable?: boolean;
        redirectUri?: string;
        state?: string;
      };
      if (e.redirectable && e.redirectUri)
        return {
          ok: false as const,
          res: redirectWith(c, e.redirectUri, {
            error: e.error,
            error_description: e.description,
            state: e.state,
          }),
        };
      return {
        ok: false as const,
        res: page(
          c,
          "Cannot authorize",
          `<h1>This request cannot be authorized</h1><p class="err">${esc(e.description)}</p><p class="muted">Nothing was shared. Go back to the app that sent you here and try again.</p>`,
          400,
        ),
      };
    }
  };

  const queryOf = (c: Context): Record<string, string | undefined> => {
    const out: Record<string, string | undefined> = {};
    for (const [k, v] of new URL(c.req.url).searchParams) out[k] = v;
    return out;
  };

  app.get("/oauth/authorize", limit(120), (c) => {
    const q = queryOf(c);
    const chk = checkRequest(c, q);
    if (!chk.ok) return chk.res;
    const { r } = chk;
    if (opts.cloud) return cloudConsentPage(c, opts.cloud, q, r);
    const me = currentUser(c);
    const here = new URL(c.req.url);
    if (!me) {
      // The session cookie is SameSite=Strict, so it is not sent on the cross-site navigation that brought
      // the user here. One same-origin hop (a page of ours navigating to ourselves) sends it.
      if (q._r !== "1") {
        here.searchParams.set("_r", "1");
        const next = `${here.pathname}${here.search}`;
        return page(
          c,
          "Continue",
          `<h1>Continue to Glideworth</h1><p><a href="${esc(next)}">Continue</a></p>`,
          200,
          `<meta http-equiv="refresh" content="0;url=${esc(next)}">`,
        );
      }
      const login = svc(c).auth.userIdForLogin(undefined) !== "" && svc(c).users.list().length > 1;
      return page(
        c,
        "Sign in to Glideworth",
        `<h1>Sign in to Glideworth</h1><p><strong>${esc(r.client.name)}</strong> wants to connect to your Glideworth. Sign in first.</p>
<form method="post" action="/oauth/login">
${login ? '<label>Sign-in name (leave empty for the owner)<input type="text" name="user" autocomplete="username"></label>' : ""}
<label>Passphrase<input type="password" name="passphrase" autocomplete="current-password" required autofocus></label>
<input type="hidden" name="qs" value="${esc(here.search.slice(1))}">
<button type="submit">Sign in</button></form>
${q.error ? `<p class="err">${esc(q.error)}</p>` : ""}`,
      );
    }
    const allowed = new Set(ROLE_SCOPES[me.user.role]);
    const boxes = r.scopes
      .map((s) => {
        const ok = allowed.has(s as never);
        return `<label><input type="checkbox" name="grant" value="${esc(s)}" ${ok ? "checked" : "disabled"}> <strong>${esc(s)}</strong>: ${esc(SCOPE_TEXT[s] ?? s)}${ok ? "" : ` <span class="muted">(not available to your ${esc(me.user.role)} role)</span>`}</label>`;
      })
      .join("");
    const hidden = [
      "client_id",
      "redirect_uri",
      "state",
      "code_challenge",
      "code_challenge_method",
      "response_type",
      "resource",
      "scope",
    ]
      .map((k) =>
        q[k] !== undefined
          ? `<input type="hidden" name="${k}" value="${esc(q[k] as string)}">`
          : "",
      )
      .join("");
    const host = new URL(r.redirectUri);
    return page(
      c,
      "Allow access to Glideworth",
      `<h1>Allow <em>${esc(r.client.name)}</em> to use Glideworth?</h1>
<p>Signed in as <strong>${esc(me.user.name)}</strong> (${esc(me.user.role)}). After you decide you are sent back to <code>${esc(host.origin)}</code>${loopbackWarning(host)}.</p>
<form method="post" action="/oauth/authorize">${hidden}<input type="hidden" name="csrf" value="${esc(me.session.csrf)}">
<p>This app will be able to:</p>${boxes}
<p class="muted">You can remove this access later in Glideworth. ${opts.allowWrites ? "" : "This server has MCP write tools turned off, so write access has no effect until the owner enables them."}</p>
<button type="submit" name="decision" value="approve">Allow</button><button class="secondary" type="submit" name="decision" value="deny">Deny</button></form>`,
    );
  });

  const loopbackWarning = (u: URL) =>
    u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]"
      ? ' <span class="muted">(an app running on this computer: only approve if you started it)</span>'
      : "";

  /** Cloud consent: signed in with the cloud account, pick the workspace, then the scopes. */
  const cloudConsentPage = (
    c: Context,
    cloud: CloudOAuth,
    q: Record<string, string | undefined>,
    r: ReturnType<OAuthService["validateAuthorize"]>,
  ) => {
    const me = cloud.session(c);
    const here = new URL(c.req.url);
    if (!me) {
      if (q._r !== "1") {
        here.searchParams.set("_r", "1");
        const next = `${here.pathname}${here.search}`;
        return page(
          c,
          "Continue",
          `<h1>Continue to Glideworth</h1><p><a href="${esc(next)}">Continue</a></p>`,
          200,
          `<meta http-equiv="refresh" content="0;url=${esc(next)}">`,
        );
      }
      here.searchParams.delete("_r");
      return c.redirect(cloud.signinUrl(`${here.pathname}${here.search}`), 302);
    }
    const spaces = cloud.workspaces(me.userId);
    if (!spaces.length)
      return page(
        c,
        "No workspace",
        "<h1>You are not a member of any workspace</h1><p>Create or join a workspace first, then start again from the app.</p>",
        400,
      );
    const radios = spaces
      .map(
        (w, i) =>
          `<label><input type="radio" name="workspace" value="${esc(w.accountId)}" ${i === 0 ? "checked" : ""} required> <strong>${esc(w.name)}</strong> <span class="muted">(${esc(w.role)})</span></label>`,
      )
      .join("");
    const boxes = r.scopes
      .map(
        (sc) =>
          `<label><input type="checkbox" name="grant" value="${esc(sc)}" checked> <strong>${esc(sc)}</strong>: ${esc(SCOPE_TEXT[sc] ?? sc)}</label>`,
      )
      .join("");
    const hidden = AUTHORIZE_FIELDS.map((k) =>
      q[k] !== undefined ? `<input type="hidden" name="${k}" value="${esc(q[k] as string)}">` : "",
    ).join("");
    const host = new URL(r.redirectUri);
    return page(
      c,
      "Allow access to Glideworth",
      `<h1>Allow <em>${esc(r.client.name)}</em> to use Glideworth?</h1>
<p>Signed in as <strong>${esc(me.name)}</strong>. After you decide you are sent back to <code>${esc(host.origin)}</code>${loopbackWarning(host)}.</p>
<form method="post" action="/oauth/authorize">${hidden}<input type="hidden" name="csrf" value="${esc(me.csrf)}">
<p>Workspace:</p>${radios}
<p>This app will be able to:</p>${boxes}
<p class="muted">Access never exceeds your role in the workspace you pick. Write tools also need the workspace owner to turn on MCP writes. You can remove this access later in Glideworth.</p>
<button type="submit" name="decision" value="approve">Allow</button><button class="secondary" type="submit" name="decision" value="deny">Deny</button></form>`,
    );
  };

  const cloudApprove = async (c: Context, cloud: CloudOAuth) => {
    const me = cloud.session(c);
    if (!me)
      return page(
        c,
        "Signed out",
        "<h1>You are signed out</h1><p>Start again from the app.</p>",
        401,
      );
    const b = await c.req.parseBody({ all: true });
    const one = (k: string) => (typeof b[k] === "string" ? (b[k] as string) : undefined);
    const given = Buffer.from(one("csrf") ?? "");
    const want = Buffer.from(me.csrf);
    if (!given.length || given.length !== want.length || !cryptoEqual(given, want))
      throw new ApiError(403, "CSRF", "invalid form token");
    const q: Record<string, string | undefined> = {};
    for (const k of AUTHORIZE_FIELDS) q[k] = one(k);
    const chk = checkRequest(c, q);
    if (!chk.ok) return chk.res;
    const { r } = chk;
    if (one("decision") !== "approve")
      return redirectWith(c, r.redirectUri, {
        error: "access_denied",
        error_description: "the user denied the request",
        state: r.state,
      });
    // The membership is read again here: a person removed since the consent page was shown gets nothing.
    const accountId = one("workspace") ?? "";
    const m = accountId ? cloud.membership(accountId, me.userId) : null;
    if (!m)
      return page(
        c,
        "Not a member",
        "<h1>You are not a member of that workspace</h1><p>Start again from the app.</p>",
        400,
      );
    const picked = (Array.isArray(b.grant) ? b.grant : b.grant ? [b.grant] : []).map(String);
    const allowed = new Set<string>(ROLE_SCOPES[m.role]);
    const granted = picked.filter((sc) => r.scopes.includes(sc) && allowed.has(sc));
    if (!granted.length)
      return redirectWith(c, r.redirectUri, {
        error: "access_denied",
        error_description: "no scope was granted",
        state: r.state,
      });
    const code = await cloud.withTenant(accountId, (s) => {
      const issued = s.oauth.issueCode({
        clientId: r.client.id,
        userId: m.tenantUserId,
        redirectUri: r.redirectUri,
        codeChallenge: r.codeChallenge,
        scopes: granted,
        resource: mcpResource(c),
      });
      s.audit.record({
        userId: m.tenantUserId,
        userName: m.userName,
        via: "session",
        action: "oauth.consent",
        resourceType: "oauth-client",
        resourceId: r.client.id,
        status: 200,
        detail: { client: r.client.name, scopes: granted },
      });
      return issued;
    });
    return redirectWith(c, r.redirectUri, { code, state: r.state });
  };

  if (!opts.cloud)
    app.post("/oauth/login", limit(30), async (c) => {
      sameOrigin(c);
      const b = await c.req.parseBody();
      const qs = typeof b.qs === "string" ? b.qs : "";
      const back = (err: string, status: 401 | 429 = 401) => {
        const u = new URL(`/oauth/authorize?${qs}`, "http://x");
        u.searchParams.set("_r", "1");
        u.searchParams.set("error", err);
        return status === 401
          ? c.redirect(`${u.pathname}${u.search}`, 303)
          : c.redirect(`${u.pathname}${u.search}`, 303);
      };
      try {
        const s = await svc(c).auth.login(
          String(b.passphrase ?? ""),
          clientIp(c),
          c.req.header("user-agent"),
          typeof b.user === "string" && b.user ? b.user : undefined,
        );
        const secure = secureFor(c);
        const cookie = {
          sameSite: "Strict" as const,
          path: "/",
          maxAge: s.maxAgeSeconds,
          expires: s.expiresAt,
          secure,
        };
        setCookie(c, SESSION_COOKIE, s.token, { ...cookie, httpOnly: true });
        setCookie(c, CSRF_COOKIE, s.csrf, { ...cookie, httpOnly: false });
        const u = new URL(`/oauth/authorize?${qs}`, "http://x");
        u.searchParams.set("_r", "1");
        return c.redirect(`${u.pathname}${u.search}`, 303);
      } catch (err) {
        if (err instanceof ApiError && (err.status === 401 || err.status === 429))
          return back(err.message);
        throw err;
      }
    });

  app.post("/oauth/authorize", limit(60), async (c) => {
    sameOrigin(c);
    if (opts.cloud) return cloudApprove(c, opts.cloud);
    const me = currentUser(c);
    if (!me)
      return page(
        c,
        "Signed out",
        "<h1>You are signed out</h1><p>Start again from the app.</p>",
        401,
      );
    const b = await c.req.parseBody({ all: true });
    const one = (k: string) => (typeof b[k] === "string" ? (b[k] as string) : undefined);
    const given = Buffer.from(one("csrf") ?? "");
    const want = Buffer.from(me.session.csrf);
    if (!given.length || given.length !== want.length || !cryptoEqual(given, want))
      throw new ApiError(403, "CSRF", "invalid form token");
    const q: Record<string, string | undefined> = {};
    for (const k of [
      "client_id",
      "redirect_uri",
      "state",
      "code_challenge",
      "code_challenge_method",
      "response_type",
      "resource",
      "scope",
    ])
      q[k] = one(k);
    // Everything is validated again: hidden fields are the browser's, not ours.
    const chk = checkRequest(c, q);
    if (!chk.ok) return chk.res;
    const { r } = chk;
    if (one("decision") !== "approve")
      return redirectWith(c, r.redirectUri, {
        error: "access_denied",
        error_description: "the user denied the request",
        state: r.state,
      });
    // Checkboxes are `grant`; `scope` (hidden) is the original request and is validated again above.
    const picked = (Array.isArray(b.grant) ? b.grant : b.grant ? [b.grant] : []).map(String);
    const allowed = new Set<string>(ROLE_SCOPES[me.user.role]);
    const granted = picked.filter((s) => r.scopes.includes(s) && allowed.has(s));
    if (!granted.length)
      return redirectWith(c, r.redirectUri, {
        error: "access_denied",
        error_description: "no scope was granted",
        state: r.state,
      });
    const code = svc(c).oauth.issueCode({
      clientId: r.client.id,
      userId: me.user.id,
      redirectUri: r.redirectUri,
      codeChallenge: r.codeChallenge,
      scopes: granted,
      resource: mcpResource(c),
    });
    svc(c).audit.record({
      userId: me.user.id,
      userName: me.user.name,
      via: "session",
      action: "oauth.consent",
      resourceType: "oauth-client",
      resourceId: r.client.id,
      status: 200,
      detail: { client: r.client.name, scopes: granted },
    });
    return redirectWith(c, r.redirectUri, { code, state: r.state });
  });

  // ----------------------------------------------------------------------------- token + revoke
  const form = async (c: Context): Promise<Record<string, string | undefined>> => {
    const ct = c.req.header("content-type") ?? "";
    if (ct.includes("application/json")) {
      const j = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
      return Object.fromEntries(
        Object.entries(j).map(([k, v]) => [k, typeof v === "string" ? v : undefined]),
      );
    }
    const b = await c.req.parseBody();
    return Object.fromEntries(
      Object.entries(b).map(([k, v]) => [k, typeof v === "string" ? v : undefined]),
    );
  };

  /**
   * Cloud: the workspace comes from the routed code or refresh token, and the existing exchange runs inside
   * that workspace only. A token naming another workspace cannot verify there (its hash is not stored there).
   */
  const inTokenTenant = async <T>(
    cloud: CloudOAuth,
    token: string | undefined,
    kind: "oauth_code" | "oauth_refresh",
    fn: (s: Services) => T,
  ): Promise<T> => {
    const bad = () =>
      new OAuthError(
        "invalid_grant",
        kind === "oauth_code" ? "unknown or expired authorization code" : "unknown refresh token",
      );
    const accountId = token ? cloud.accountOf(token, [kind]) : null;
    if (!accountId) throw bad();
    try {
      return await cloud.withTenant(accountId, fn);
    } catch (err) {
      if (err instanceof OAuthError) throw err;
      throw bad();
    }
  };

  app.post("/oauth/token", limit(60), async (c) => {
    const p = await form(c);
    return oauthJson(c, () => {
      const cloud = opts.cloud;
      if (cloud && p.grant_type === "authorization_code")
        return inTokenTenant(cloud, p.code, "oauth_code", (s) =>
          s.oauth.exchangeCode(p, mcpResource(c)),
        );
      if (cloud && p.grant_type === "refresh_token")
        return inTokenTenant(cloud, p.refresh_token, "oauth_refresh", (s) => s.oauth.refresh(p));
      if (p.grant_type === "authorization_code")
        return svc(c).oauth.exchangeCode(p, mcpResource(c));
      if (p.grant_type === "refresh_token") return svc(c).oauth.refresh(p);
      throw new OAuthError(
        "unsupported_grant_type",
        "grant_type must be authorization_code or refresh_token",
      );
    });
  });

  app.post("/oauth/revoke", limit(60), async (c) => {
    const p = await form(c);
    const cloud = opts.cloud;
    if (cloud && p.token) {
      // RFC 7009: unknown tokens are not an error, and a token of another workspace is a no-op here.
      const accountId = cloud.accountOf(p.token, ["oauth_access", "oauth_refresh"]);
      const token = p.token;
      if (accountId)
        await cloud
          .withTenant(accountId, (s) => s.oauth.revoke(token, p.client_id))
          .catch(() => undefined);
    } else if (p.token) svc(c).oauth.revoke(p.token, p.client_id);
    return c.body(null, 200);
  });

  void parseScopes;
}

import { timingSafeEqual } from "node:crypto";

const cryptoEqual = (a: Buffer, b: Buffer) => timingSafeEqual(a, b);
