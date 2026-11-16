/**
 * HTTP application: REST API v1 (OpenAPI 3.1 generated from the @glideworth/core Zod schemas), docs UI
 * and the MCP Streamable HTTP endpoint. Pure factory: no listening, no env access, so tests drive it
 * with `app.request()`.
 */
import { ENGINE_VERSION, SCHEMA_VERSION } from "@glideworth/core";
import { getConnInfo } from "@hono/node-server/conninfo";
import { OpenAPIHono } from "@hono/zod-openapi";
import { Scalar } from "@scalar/hono-api-reference";
import type { Context, MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { type AuthEnv, authMiddleware, CSRF_HEADER } from "./auth.js";
import type { Db } from "./db/client.js";
import { ApiError, toErrorResponse, zodMessage } from "./errors.js";
import { handleMcpHttp } from "./mcp/http.js";
import { conditionalGet, idempotency, ipRateLimit, rateLimit } from "./middleware.js";
import { adminRoutes } from "./routes/admin.js";
import { authRoutes } from "./routes/auth.js";
import { checkinRoutes } from "./routes/checkins.js";
import { crossBorderRoutes } from "./routes/crossborder.js";
import { exportRoutes } from "./routes/exports.js";
import { extraRoutes } from "./routes/extras.js";
import { householdRoutes } from "./routes/households.js";
import { type CloudOAuth, oauthRoutes } from "./routes/oauth.js";
import { type RouteCtx, servicesOf } from "./routes/helpers.js";
import { planRoutes } from "./routes/plans.js";
import { shareRoutes } from "./routes/shares.js";
import { simulationRoutes } from "./routes/simulation.js";
import { userRoutes } from "./routes/users.js";
import { findUnsafeInput } from "./security.js";
import { resourceOf } from "./services/audit.js";
import { Services, type ServicesOptions } from "./services.js";
import { staticSite } from "./static.js";

/**
 * Cloud mode (built by `cloud-host.ts` from `@glideworth/cloud`; this module never imports a cloud package).
 * Everything that differs from self-host: who the caller is and which workspace's services serve them.
 */
export interface CloudSurface {
  /** `registerCloudRoutes`: sign-up, sign-in, account, workspace, billing, Stripe webhook, email. */
  registerRoutes(app: OpenAPIHono<AuthEnv>): void;
  isCloudRoute(path: string): boolean;
  /**
   * `tenantAuth('api')` followed by setting `services` from the workspace runtime and `holdLease` (SSE).
   * Session cookies (with CSRF) or `gwk_`/`gwa_` bearer credentials.
   */
  apiAuth: MiddlewareHandler<AuthEnv>;
  /** `tenantAuth('mcp')`: bearer only, the 401 carries the RFC 9728 `WWW-Authenticate`. */
  mcpAuth: MiddlewareHandler<AuthEnv>;
  /** Public share links: the workspace from the routed `gws_` token, the daily read quota, one 404 for all failures. */
  sharedTenant: MiddlewareHandler<AuthEnv>;
  /** After `apiAuth` on `/api/*`: cloud-only checks (a write-scoped key needs a recent re-authentication). */
  apiGuard?: MiddlewareHandler<AuthEnv>;
  /** MCP write tools: the principal has `write` and the workspace owner turned MCP writes on. */
  mcpAllowWrites(c: Context<AuthEnv>): boolean;
  /** Per-credential rate-limit key: `<accountId>:<credential id>`. */
  rateLimitKey(c: Context<AuthEnv>): string;
  oauth: CloudOAuth;
  /** The API reference page (no third-party script). */
  docs: (c: Context) => Response | Promise<Response>;
}

export interface AppOptions {
  /** The database (self-host). Cloud mode has one per workspace and passes none. */
  db?: Db;
  /** Cloud mode. Absent: self-host, exactly as before. */
  cloud?: CloudSurface;
  /** Routes registered before everything else (cloud development helpers). */
  beforeRoutes?: (app: OpenAPIHono<AuthEnv>) => void;
  /** Reuse a Services instance (tests inject fakes through it). */
  services?: Services;
  servicesOptions?: ServicesOptions;
  /** Browser origin allowed by CORS/CSRF (the Vite dev server). `null` = none (same-origin only). Default localhost:5173. */
  webOrigin?: string | null;
  /** Largest request body in bytes (413 beyond it). Default 10 MiB. */
  maxBodyBytes?: number;
  mcpAllowWrites?: boolean;
  /** Requests per minute per API key (0 = unlimited). Default 600. */
  rateLimitPerMinute?: number;
  /** Browser sign-in (passphrase + session cookie). Default true. API keys always work. */
  browserAuth?: boolean;
  /** Cookie `Secure` flag: `auto` (default) = when the request arrived over https. */
  cookieSecure?: boolean | "auto";
  /** Trust X-Forwarded-For for login throttling (behind a reverse proxy). */
  trustProxy?: boolean;
  /** Directory of the built web app (apps/web/dist). When set, it is served with SPA fallback. */
  webDist?: string | undefined;
  /** Public base URL of this server (GLIDEWORTH_PUBLIC_URL), used as the OAuth issuer and in metadata. Default: the request's origin. */
  publicUrl?: string | undefined;
  /** Requests per minute per client address for public share links (0 = unlimited). Default 60. */
  shareRateLimitPerMinute?: number;
}

export const API_DESCRIPTION = [
  "Glideworth planning API. Everything the web app does is available here, and it can run simulations.",
  "",
  "**Units.** Money is in major currency units (1234.56), rates are decimal fractions (0.07 = 7%). Simulation results are nominal with a per-period `priceIndex`; compact views default to real (today's) money.",
  "",
  "**Auth.** `Authorization: Bearer glideworth_<prefix>_<secret>`. Scopes: `read`, `simulate`, `write` (write implies the others).",
  "",
  '**Concurrency.** Plans and households return `ETag: "<version>"`. Send `If-Match: "<version>"` on writes; a stale version is `409 VERSION_CONFLICT`. `If-None-Match` on GET gives `304`.',
  "",
  "**Idempotency.** Send `Idempotency-Key: <unique>` on any write to make retries safe (replayed for 24h).",
  "",
  '**Errors.** `{ "error": { "code", "message", "details" } }`. 501 `NOT_IMPLEMENTED` carries `details.feature` and `details.workstream`.',
  "",
  "**Pagination.** List endpoints take `limit` and `cursor` and return `{ items, nextCursor, total }`.",
].join("\n");

const CLOUD_API_DESCRIPTION = API_DESCRIPTION.replace(
  "**Auth.** `Authorization: Bearer glideworth_<prefix>_<secret>`.",
  "**Auth.** `Authorization: Bearer gwk_<workspace>_<prefix>_<secret>` (an API key of one workspace) or an OAuth access token (`gwa_…`, MCP clients). The web app uses the `__Host-gw_session` cookie with the `X-CSRF-Token` header. A read-only workspace answers writes with `402 ACCOUNT_READ_ONLY`.",
);

export function createApp(opts: AppOptions) {
  const cloud = opts.cloud;
  if (!cloud && !opts.db && !opts.services) throw new Error("createApp: db or services required");
  // Self-host: one Services for the process. Cloud: none here; each request gets its workspace's.
  const services = cloud
    ? null
    : (opts.services ?? new Services(opts.db as Db, opts.servicesOptions));
  const app = new OpenAPIHono<AuthEnv>({
    defaultHook: (result) => {
      if (!result.success)
        throw new ApiError(
          400,
          "VALIDATION",
          `request ${zodMessage(result.error as never)}`,
          result.error.issues,
        );
    },
  });
  app.onError((err, c) => toErrorResponse(err, c));
  // Self-host: one Services instance for the whole process; route handlers read it from the context
  // (servicesOf). Cloud: the auth middleware sets the workspace's own.
  if (services)
    app.use("*", async (c, next) => {
      c.set("services", services);
      await next();
    });
  const webOrigin = cloud
    ? undefined
    : opts.webOrigin === undefined
      ? "http://localhost:5173"
      : (opts.webOrigin ?? undefined);
  // Hardening headers on every response (the static site adds its own on top).
  app.use("*", async (c, next) => {
    await next();
    c.header("X-Content-Type-Options", "nosniff");
    // The OAuth consent page posts back to this origin. Under "no-referrer" Chrome sends `Origin: null` on that
    // form post, which the same-origin check must refuse, so consent could never be given.
    c.header("Referrer-Policy", c.req.path.startsWith("/oauth/") ? "same-origin" : "no-referrer");
    if (c.req.path.startsWith("/api/") || c.req.path === "/mcp")
      c.header("Cache-Control", "no-store");
  });
  const maxBody = opts.maxBodyBytes ?? 10 * 1024 * 1024;
  const tooLarge = bodyLimit({
    maxSize: maxBody,
    onError: (c) =>
      c.json(
        {
          error: {
            code: "PAYLOAD_TOO_LARGE",
            message: `request body exceeds the ${Math.round(maxBody / 1024 / 1024)} MiB limit (GLIDEWORTH_MAX_BODY_MB)`,
          },
        },
        413,
      ),
  });
  /** JSON bodies that address Object.prototype are refused before any handler (or core's patch engine) sees them. */
  const rejectUnsafePatch: MiddlewareHandler = async (c, next) => {
    if (c.req.method === "GET" || c.req.method === "HEAD" || c.req.method === "OPTIONS")
      return next();
    if (!/json/i.test(c.req.header("content-type") ?? "")) return next();
    const text = await c.req.raw.clone().text();
    if (/__proto__|constructor|prototype/.test(text)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return next(); // the handler reports malformed JSON
      }
      const hit = findUnsafeInput(parsed);
      if (hit)
        throw new ApiError(
          400,
          "VALIDATION",
          `forbidden key or path segment at ${hit} (__proto__, constructor, prototype)`,
        );
    }
    return next();
  };
  app.use("/api/*", tooLarge);
  app.use("/mcp", tooLarge);
  app.use("/api/*", rejectUnsafePatch);
  app.use("/mcp", rejectUnsafePatch);
  // Endpoints that MCP clients call from other origins with a bearer token (never cookies): open CORS.
  const openCors = cors({
    origin: "*",
    allowHeaders: [
      "authorization",
      "content-type",
      "mcp-session-id",
      "mcp-protocol-version",
      "last-event-id",
    ],
    exposeHeaders: ["www-authenticate", "mcp-session-id", "retry-after"],
    maxAge: 600,
  });
  const isOpenCors = (path: string) =>
    path === "/mcp" ||
    path.startsWith("/.well-known/") ||
    path === "/oauth/token" ||
    path === "/oauth/register" ||
    path === "/oauth/revoke";
  app.use("*", (c, next) => (isOpenCors(c.req.path) ? openCors(c, next) : next()));
  const credentialedCors = webOrigin
    ? cors({
        origin: webOrigin,
        credentials: true,
        allowHeaders: [
          "authorization",
          "content-type",
          CSRF_HEADER,
          "if-match",
          "if-none-match",
          "idempotency-key",
          "mcp-session-id",
          "mcp-protocol-version",
        ],
        exposeHeaders: [
          "etag",
          "idempotent-replay",
          "retry-after",
          "x-ratelimit-limit",
          "x-ratelimit-remaining",
          "mcp-session-id",
        ],
      })
    : null;
  if (credentialedCors)
    app.use("*", (c, next) => (isOpenCors(c.req.path) ? next() : credentialedCors(c, next)));
  app.use("*", conditionalGet());
  app.openAPIRegistry.registerComponent("securitySchemes", "bearer", {
    type: "http",
    scheme: "bearer",
    description: cloud
      ? "API key of one workspace: `gwk_<workspace>_<8 chars>_<secret>`, or an OAuth access token. Scopes: read, simulate, write. The web app uses the `__Host-gw_session` cookie and the `X-CSRF-Token` header instead."
      : "API key: `glideworth_<8 chars>_<secret>`. Scopes: read, simulate, write. The web app uses a session cookie instead (see the Auth tag).",
  });
  // Cloud routes come first: they are self-contained (own sessions, CSRF, body limits, error envelope).
  if (cloud) cloud.registerRoutes(app);
  opts.beforeRoutes?.(app);

  // ------------------------------------------------------------------------- public
  app.get("/health", (c) =>
    c.json({ status: "ok", engineVersion: ENGINE_VERSION, schemaVersion: SCHEMA_VERSION }),
  );
  app.doc31("/openapi.json", {
    openapi: "3.1.0",
    info: {
      title: "Glideworth API",
      version: "1.0.0",
      description: cloud ? CLOUD_API_DESCRIPTION : API_DESCRIPTION,
    },
    servers: [{ url: "/" }],
    tags: [
      {
        name: "FX rates",
        description: "Exchange rates for foreign-currency accounts, assets and debts.",
      },
      {
        name: "Users",
        description:
          "Collaboration: invite a partner or adviser, roles, passphrase resets, audit log.",
      },
      {
        name: "Share links",
        description: "Expiring, revocable read-only links to a plan’s results.",
      },
      { name: "Check-ins", description: "Scheduled re-runs, plan health history, notifications." },
      {
        name: "OAuth",
        description:
          "OAuth 2.1 grants and clients for remote MCP clients (the protocol endpoints are under /oauth and /.well-known).",
      },
      { name: "Households", description: "Household, people and dependents." },
      {
        name: "Plan: residency",
        description:
          "Where each person lives over the plan (dated moves, per person or everyone) and the resulting timeline.",
      },
      {
        name: "Cross-border rules",
        description:
          "Read-only tables the engine uses: non-resident rules, treaties, foreign-wrapper recognition, simplifications.",
      },
      { name: "Accounts", description: "Current-finance accounts and bulk balance updates." },
      { name: "Plans", description: "Plans, versions and lifecycle." },
      { name: "Plan history", description: "Version history and undo." },
      { name: "Branches", description: "Plan branching: child plans that patch a parent." },
      {
        name: "Change sets",
        description: "Propose, preview, apply or discard edits (the safe way for agents).",
      },
      {
        name: "Simulation",
        description: "Deterministic projections, Monte Carlo and historical runs.",
      },
      { name: "Solvers", description: "Goal-seek solvers (async jobs)." },
      { name: "Insights", description: "Explain, audit, sensitivity, guardrails, compare, tax." },
      { name: "Jobs", description: "Async job status, results, cancellation and SSE." },
      { name: "Progress", description: "Progress snapshots (actuals over time)." },
      { name: "Data", description: "Export, import and backup." },
      { name: "Settings", description: "User settings." },
      { name: "Keys", description: "API key management." },
      { name: "Webhooks", description: "Signed event webhooks." },
      {
        name: "Scenarios",
        description: "What-if templates and survivor scenarios, as previews or branches.",
      },
      {
        name: "Auth",
        description:
          "Browser sign-in: first-run setup, login, logout (session cookie + CSRF token).",
      },
    ],
  });
  if (cloud) app.get("/docs", cloud.docs);
  else app.get("/docs", Scalar({ url: "/openapi.json", pageTitle: "Glideworth API" }));

  // ------------------------------------------------------------------------- auth + cross-cutting
  const limiter = rateLimit(
    opts.rateLimitPerMinute ?? 600,
    cloud ? { keyOf: cloud.rateLimitKey } : {},
  );
  const browserAuth = cloud ? false : (opts.browserAuth ?? true);
  const apiAuth = cloud
    ? cloud.apiAuth
    : authMiddleware(opts.db ?? (services as Services).db, {
        sessions: browserAuth ? (services as Services).auth : undefined,
        webOrigin,
      });
  const trustProxy = opts.trustProxy ?? false;
  const publicOrigin = (c: Context): string => {
    if (opts.publicUrl) return opts.publicUrl.replace(/\/+$/, "");
    if (trustProxy) {
      const proto = c.req.header("x-forwarded-proto")?.split(",")[0]?.trim();
      const host = c.req.header("x-forwarded-host")?.split(",")[0]?.trim();
      if (proto && host) return `${proto}://${host}`;
    }
    return new URL(c.req.url).origin;
  };
  const clientAddress = (c: Context): string => {
    if (trustProxy) {
      const f = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
      if (f) return f;
    }
    try {
      return getConnInfo(c).remote.address ?? "unknown";
    } catch {
      return "unknown";
    }
  };
  // Public routes: /api/v1/auth/* (how a browser gets a session) and /api/v1/shared/* (share links).
  const isPublicApi = (path: string) =>
    (browserAuth && path.startsWith("/api/v1/auth/")) ||
    path.startsWith("/api/v1/shared/") ||
    (!!cloud && cloud.isCloudRoute(path));
  const exceptPublic =
    (mw: MiddlewareHandler<AuthEnv>): MiddlewareHandler<AuthEnv> =>
    (c, next) =>
      isPublicApi(c.req.path) ? next() : mw(c, next);
  /** Who changed what: every successful or refused write is recorded with the person behind it. */
  const audit: MiddlewareHandler<AuthEnv> = async (c, next) => {
    await next();
    const method = c.req.method;
    if (method === "GET" || method === "HEAD" || method === "OPTIONS") return;
    const p = c.get("principal");
    const status = c.res.status;
    if (!p || c.get("need") !== "write" || !(status < 300 || status === 402 || status === 403))
      return;
    const res = resourceOf(c.req.path, c.req.param() as Record<string, string>);
    servicesOf(c).audit.record({
      userId: p.userId,
      userName: p.userName,
      via: p.via ?? "key",
      credentialId: p.keyId,
      action: `${method} ${c.req.routePath}`,
      resourceType: res.type,
      resourceId: res.id,
      status,
    });
  };
  app.use("/api/*", exceptPublic(apiAuth));
  if (cloud?.apiGuard) app.use("/api/*", exceptPublic(cloud.apiGuard));
  app.use("/api/*", exceptPublic(limiter));
  app.use("/api/*", exceptPublic(audit));
  app.use("/api/*", exceptPublic(idempotency((c) => servicesOf(c).db)));
  // MCP takes bearer credentials only (API keys or OAuth access tokens): cookies are never accepted there.
  app.use(
    "/mcp",
    cloud
      ? cloud.mcpAuth
      : authMiddleware((services as Services).db, {
          oauth: (token, c) =>
            (services as Services).oauth.verifyAccess(token, `${publicOrigin(c)}/mcp`),
          resourceMetadataUrl: (c) => `${publicOrigin(c)}/.well-known/oauth-protected-resource/mcp`,
        }),
  );
  app.use("/mcp", limiter);

  // ------------------------------------------------------------------------- REST
  const ctx: RouteCtx = { app, svc: servicesOf, mode: cloud ? "cloud" : "selfhost" };
  householdRoutes(ctx);
  planRoutes(ctx);
  simulationRoutes(ctx);
  adminRoutes(ctx);
  exportRoutes(ctx);
  extraRoutes(ctx);
  userRoutes(ctx);
  checkinRoutes(ctx);
  crossBorderRoutes(ctx);
  shareRoutes(
    ctx,
    ipRateLimit(opts.shareRateLimitPerMinute ?? 60, clientAddress),
    cloud?.sharedTenant,
  );
  oauthRoutes(app as never, servicesOf, {
    publicUrl: opts.publicUrl,
    trustProxy,
    cookieSecure: opts.cookieSecure ?? "auto",
    webOrigin,
    allowWrites: !!opts.mcpAllowWrites,
    ...(cloud ? { cloud: cloud.oauth } : {}),
  });
  if (browserAuth)
    authRoutes(ctx, {
      cookieSecure: opts.cookieSecure ?? "auto",
      trustProxy,
      webOrigin,
    });

  // ------------------------------------------------------------------------- MCP
  app.all("/mcp", (c) =>
    handleMcpHttp(c.req.raw, {
      services: servicesOf(c),
      principal: c.get("principal"),
      allowWrites: cloud ? cloud.mcpAllowWrites(c) : !!opts.mcpAllowWrites,
    }),
  );

  // ------------------------------------------------------------------------- web app (one process, one port)
  if (opts.webDist) app.use("*", staticSite(opts.webDist));
  app.notFound((c) =>
    c.json(
      { error: { code: "NOT_FOUND", message: `no route for ${c.req.method} ${c.req.path}` } },
      404,
    ),
  );

  return app;
}
