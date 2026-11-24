/**
 * Cloud mode: what `apps/api` gives `@glideworth/cloud/server` (`start({ env, host })`, INTEGRATION.md). Loaded
 * only by the dynamic import in `server.ts` when `GLIDEWORTH_MODE=cloud`, and by the `glideworth-cloud` CLI
 * through `GLIDEWORTH_TENANT_RUNTIME_MODULE`. Self-host never loads this module.
 *
 *   createOpener  one workspace database -> `TenantRuntime` (tenant-runtime.ts)
 *   verifiers     API keys, OAuth access tokens and browser sessions, verified inside one workspace only
 *   runDue        the global scheduler's check-in for one workspace (+ the check-in email, no figures)
 *   createApp     the public app: cloud routes, `tenantAuth` on `/api/*` and `/mcp`, the routed share link
 *                 route, OAuth with the control-plane client registry and a fixed issuer, the local docs page
 *   timers        the retention sweep (terms: unpaid and cancelled workspaces deleted after 12 months), renewal
 *                 reminders, and the daily trim of each workspace's audit log to 400 days
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  capScopes,
  controlOAuthClients,
  controlSchema,
  parseRouted,
  publicSessionId,
  SESSION_COOKIE,
  safeNext,
} from "@glideworth/cloud";
import { securityTxt } from "@glideworth/cloud/security-txt";
import type { CloudAppContext, CloudHost, CloudRuntime } from "@glideworth/cloud/server";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { Context, MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { type CloudSurface, createApp } from "./app.js";
import { type AuthEnv, type Principal, ROLE_SCOPES, verifyKey } from "./auth.js";
import { resolveWebDist } from "./config.js";
import type { CoreDeps } from "./deps.js";
import { DOCS_CSP, renderApiReference } from "./docs-page.js";
import type { JobExecutor } from "./jobs/executor.js";
import { type Logger, setLogger } from "./log.js";
import { renewalReminderSweep } from "./renewals.js";
import { retentionSweep, workspaceAuditSweep } from "./retention.js";
import { OAuthService } from "./services/oauth.js";
import {
  type CheckinRunSummary,
  cloudKeyFormat,
  createTenantOpener,
  TenantRuntime,
} from "./tenant-runtime.js";

export { TenantRuntime };

type TenantEnv = AuthEnv & {
  Variables: {
    tenant: {
      accountId: string;
      runtime: TenantRuntime;
      entitlements: { mcpWrites: boolean; level: string };
      session: { sessionId: string } | null;
    };
  };
};

export interface CloudHostOptions {
  /** Tests: run jobs in-process with these engine functions (default: worker threads, the real engine). */
  executor?: JobExecutor;
  deps?: CoreDeps;
  /** Tests: the webhook HTTP client. */
  fetch?: typeof fetch;
  webhookRetryDelaysMs?: number[];
  /** Built web app directory (default: as self-host, from GLIDEWORTH_WEB_DIST / production). */
  webDist?: string | null;
  /** Per-credential requests per minute (design 6.1: 600). */
  rateLimitPerMinute?: number;
  /** Public share-link reads per minute per address (design 6.1: 60). */
  shareRateLimitPerMinute?: number;
  maxBodyMb?: number;
  /**
   * The ChatGPT plugin directory's domain-verification token, served at `/.well-known/openai-apps-challenge`
   * (default: GLIDEWORTH_OPENAI_APPS_CHALLENGE; unset answers 404). docs/launch/ai-directory-submission.md.
   */
  openaiAppsChallenge?: string;
}

const billingUrlOf = (publicUrl: string) => `${publicUrl.replace(/\/+$/, "")}/settings/billing`;

/** Plain-language check-in kinds only (design 5.3): never a title, figure or plan name. */
export function checkinEmailData(
  run: CheckinRunSummary,
  name: string,
  publicUrl: string,
): {
  name: string;
  plansChecked: number;
  changeKinds: CheckinRunSummary["changeKinds"];
  url: string;
} {
  return {
    name,
    plansChecked: run.plansChecked,
    changeKinds: [...new Set(run.changeKinds)].sort(),
    url: `${publicUrl.replace(/\/+$/, "")}/checkins`,
  };
}

export function createCloudHost(o: CloudHostOptions = {}): CloudHost<TenantRuntime, Principal> & {
  timers(runtime: CloudRuntime<TenantRuntime>): Array<{ name: string; ms: number; run(): unknown }>;
} {
  let bound: {
    runtime: CloudRuntime<TenantRuntime>;
    clients: ReturnType<typeof controlOAuthClients>;
  } | null = null;
  const bind = (runtime: CloudRuntime<TenantRuntime>) => {
    if (bound?.runtime !== runtime)
      bound = {
        runtime,
        clients: controlOAuthClients({ db: runtime.db, limiter: runtime.limiter }),
      };
    return bound;
  };

  /** The check-in email to the workspace's members who did not turn check-in emails off. */
  const sendCheckinEmail = (
    runtime: CloudRuntime<TenantRuntime>,
    accountId: string,
    run: CheckinRunSummary,
  ) => {
    if (!run.changeKinds.length) return;
    const { memberships, users } = controlSchema;
    const people = runtime.db
      .select({ id: users.id, email: users.email, name: users.name })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(
        and(
          eq(memberships.accountId, accountId),
          eq(users.checkinEmails, true),
          isNotNull(users.emailVerifiedAt),
          isNull(users.disabledAt),
        ),
      )
      .all();
    for (const p of people)
      runtime.outbox.enqueue({
        to: { email: p.email, name: p.name },
        template: "checkin-summary",
        data: checkinEmailData(run, p.name, runtime.config.publicUrl),
        userId: p.id,
        dedupeKey: `checkin:${accountId}:${run.at}:${p.id}`,
      });
    if (people.length) void runtime.outbox.drain().catch(() => undefined);
  };

  return {
    createOpener(ctx) {
      setLogger(ctx.log as unknown as Logger);
      return createTenantOpener(ctx, {
        ...(o.executor ? { executor: o.executor } : {}),
        ...(o.deps ? { deps: o.deps } : {}),
        ...(o.fetch ? { fetch: o.fetch } : {}),
        ...(o.webhookRetryDelaysMs ? { webhookRetryDelaysMs: o.webhookRetryDelaysMs } : {}),
        oauthClients: () => bound?.clients ?? null,
      });
    },

    verifiers: {
      apiKey(r, token) {
        const p = verifyKey(r.db, token, cloudKeyFormat(r.accountId));
        return p ? { ...p, via: "key", accountId: r.accountId } : null;
      },
      oauthAccess(r, token, resource) {
        const p = r.services.oauth.verifyAccess(token, resource);
        return p ? { ...p, accountId: r.accountId } : null;
      },
      session(r, m) {
        return {
          keyId: `session_${publicSessionId(m.sessionId).slice(0, 12)}`,
          name: "web session",
          scopes: [...ROLE_SCOPES[m.role]],
          via: "session",
          userId: m.tenantUserId,
          userName: m.userName,
          role: m.role,
          accountId: r.accountId,
        };
      },
      cap(p, e) {
        const { scopes, limited } = capScopes(p.scopes, e);
        if (!limited) return { ...p, scopes, accountId: e.accountId };
        return {
          ...p,
          scopes,
          accountId: e.accountId,
          limitedBy: "entitlement",
          uncappedScopes: p.scopes,
          entitlement: {
            level: e.level === "suspended" ? "suspended" : "read_only",
            reason: e.reason,
            billingUrl: billingUrlOf(bound?.runtime.config.publicUrl ?? ""),
          },
        };
      },
    },

    async runDue(r) {
      const before = r.lastCheckin;
      await r.services.checkins.tick();
      const run = r.lastCheckin;
      if (run && run !== before && bound) sendCheckinEmail(bound.runtime, r.accountId, run);
      return { nextRunAt: r.services.checkins.getConfig().nextRunAt };
    },

    supportView(r) {
      const s = r.services;
      const households = s.households.list();
      const plans = s.plans.list({});
      return {
        sections: [
          {
            title: "Workspace contents (counts)",
            rows: [
              ["Households", String(households.length)],
              ["Plans", String(plans.length)],
              ["Jobs", String(s.jobs.list().length)],
              ["API keys", String(s.keys.list().filter((k) => !k.revokedAt).length)],
              ["Webhooks", String(s.webhooks.list().length)],
              ["Members", String(s.users.listMembers().length)],
            ],
          },
        ],
      };
    },

    timers(runtime) {
      return [
        {
          name: "retention",
          ms: 60 * 60_000,
          run: () => retentionSweep(runtime),
        },
        {
          name: "renewal-reminders",
          ms: 60 * 60_000,
          run: () => renewalReminderSweep(runtime),
        },
        {
          name: "workspace-audit-prune",
          ms: 24 * 60 * 60_000,
          run: () => workspaceAuditSweep(runtime),
        },
      ];
    },

    createApp(cloud) {
      const b = bind(cloud.runtime);
      return createCloudApp(cloud, b.clients, o);
    },
  };
}

/** INTEGRATION.md step 19. */
function createCloudApp(
  cloud: CloudAppContext<TenantRuntime, Principal>,
  clients: ReturnType<typeof controlOAuthClients>,
  o: CloudHostOptions = {},
) {
  const rt = cloud.runtime;
  const publicUrl = rt.config.publicUrl;
  const tenantApi = cloud.tenantAuth("api") as unknown as MiddlewareHandler<TenantEnv>;
  const tenantMcp = cloud.tenantAuth("mcp") as unknown as MiddlewareHandler<TenantEnv>;

  /** After `tenantAuth`: the workspace's services, and a way for a stream to keep the workspace open. */
  const withServices =
    (auth: MiddlewareHandler<TenantEnv>): MiddlewareHandler<AuthEnv> =>
    (c, next) =>
      auth(c as unknown as Context<TenantEnv>, async () => {
        const t = (c as unknown as Context<TenantEnv>).get("tenant");
        c.set("services", t.runtime.services);
        c.set("holdLease", () => {
          const lease = rt.registry.acquire(t.accountId);
          const stop = lease.runtime.holdStream();
          return () => {
            stop();
            lease.release();
          };
        });
        await next();
      });

  const notFoundShare = (c: Context) =>
    c.json(
      {
        error: {
          code: "NOT_FOUND",
          message: "this link does not exist, has expired or was revoked",
        },
      },
      404,
    );

  /** Spec 2.5, step 15: the routed token names the workspace; every failure is the same 404. */
  const sharedTenant: MiddlewareHandler<AuthEnv> = async (c, next) => {
    const raw = c.req.path.slice("/api/v1/shared/".length);
    let token = "";
    try {
      token = decodeURIComponent(raw);
    } catch {
      return notFoundShare(c);
    }
    const routed = parseRouted(token);
    if (!routed || routed.kind !== "share") return notFoundShare(c);
    let lease: ReturnType<typeof rt.registry.acquire>;
    try {
      lease = rt.registry.acquire(routed.accountId);
    } catch {
      return notFoundShare(c);
    }
    try {
      // Only a live link counts against the workspace's daily share-read quota. Counting first would let anyone
      // who knows a workspace id (it is part of every share link) exhaust the quota with made-up tokens and
      // take that workspace's real links offline for the day.
      if (!lease.runtime.services.shares.isLive(token)) return notFoundShare(c);
      rt.policy(routed.accountId).admitShareRead();
      c.set("services", lease.runtime.services);
      await next();
    } finally {
      lease.release();
    }
  };

  const sessionOf = (c: Context) => rt.accounts.resolveSession(getCookie(c, SESSION_COOKIE));

  /**
   * Design 3.2: creating a write-scoped API key from a browser session needs a re-authentication within the
   * last 10 minutes (a stolen session cookie alone cannot mint a long-lived write credential).
   */
  const apiGuard: MiddlewareHandler<AuthEnv> = async (c, next) => {
    const path = c.req.path.replace(/\/+$/, "");
    if (
      c.req.method === "POST" &&
      (path === "/api/v1/keys" || path === "/api/v1/me/keys") &&
      c.get("principal").via === "session"
    ) {
      const body = (await c.req.raw
        .clone()
        .json()
        .catch(() => ({}))) as { scopes?: unknown };
      const session = (c as unknown as Context<TenantEnv>).get("tenant").session;
      if (Array.isArray(body.scopes) && body.scopes.includes("write") && session)
        rt.accounts.assertRecentAuth(session as never);
    }
    await next();
  };

  let docsHtml: string | null = null;
  const surface: CloudSurface = {
    apiGuard,
    registerRoutes: (app) => cloud.registerRoutes(app as never),
    isCloudRoute: cloud.isCloudRoute,
    apiAuth: withServices(tenantApi),
    mcpAuth: withServices(tenantMcp),
    sharedTenant,
    mcpAllowWrites(c) {
      const t = (c as unknown as Context<TenantEnv>).get("tenant");
      return c.get("principal").scopes.includes("write") && t.entitlements.mcpWrites;
    },
    rateLimitKey(c) {
      const t = (c as unknown as Context<TenantEnv>).get("tenant");
      return `${t.accountId}:${c.get("principal").keyId}`;
    },
    oauth: {
      registry: OAuthService.registryOnly(clients),
      session(c) {
        const s = sessionOf(c);
        return s ? { userId: s.userId, name: s.name, csrf: s.csrf } : null;
      },
      workspaces: (userId) =>
        rt.workspaces
          .listForUser(userId)
          .map((w) => ({ accountId: w.accountId, name: w.name, role: w.role })),
      membership(accountId, userId) {
        const m = rt.workspaces.membership(accountId, userId);
        return m ? { tenantUserId: m.tenantUserId, role: m.role, userName: m.userName } : null;
      },
      withTenant: (accountId, fn) => rt.registry.with(accountId, (r) => fn(r.services)),
      accountOf(token, kinds) {
        const r = parseRouted(token);
        return r && (kinds as readonly string[]).includes(r.kind) ? r.accountId : null;
      },
      signinUrl: (next) =>
        `/signin?next=${encodeURIComponent(safeNext(next, new URL(publicUrl).origin))}`,
    },
    async docs(c) {
      if (!docsHtml) {
        const res = await app.request("/openapi.json");
        docsHtml = renderApiReference((await res.json()) as Record<string, unknown>);
      }
      c.header("Content-Security-Policy", DOCS_CSP);
      c.header("X-Frame-Options", "DENY");
      return c.html(docsHtml);
    },
    securityTxt: securityTxt(`${publicUrl.replace(/\/+$/, "")}/.well-known/security.txt`),
    openaiAppsChallenge:
      o.openaiAppsChallenge ?? (process.env.GLIDEWORTH_OPENAI_APPS_CHALLENGE?.trim() || undefined),
  };

  const here = dirname(fileURLToPath(import.meta.url));
  const webDist =
    o.webDist === null
      ? undefined
      : (o.webDist ??
        resolveWebDist(
          {
            serveWeb: process.env.GLIDEWORTH_SERVE_WEB
              ? process.env.GLIDEWORTH_SERVE_WEB === "true"
              : undefined,
            webDist: process.env.GLIDEWORTH_WEB_DIST || undefined,
            production: rt.config.production,
          } as never,
          here,
        ));
  const app = createApp({
    cloud: surface,
    beforeRoutes: (a) => devFakeBilling(a, rt),
    publicUrl,
    trustProxy: !!rt.http.trustProxy,
    maxBodyBytes: Math.round((o.maxBodyMb ?? 10) * 1024 * 1024),
    rateLimitPerMinute: o.rateLimitPerMinute ?? 600,
    shareRateLimitPerMinute: o.shareRateLimitPerMinute ?? 60,
    cookieSecure: true,
    webDist: webDist && existsSync(join(webDist, "index.html")) ? webDist : undefined,
  });
  return app;
}

/**
 * Development only (never in production, only with the fake billing gateway, only from a loopback address):
 * complete an open fake Checkout session and get back the Stripe events, signed with the webhook secret, for
 * the caller to deliver to `POST /stripe/webhook` exactly as Stripe would. The smoke test uses it.
 */
function devFakeBilling(app: OpenAPIHono<AuthEnv>, rt: CloudRuntime<TenantRuntime>): void {
  const fake = rt.gateway as unknown as {
    completeCheckout?: (id: string) => unknown[];
    sign?: (ev: unknown, secret: string) => { body: string; header: string };
  };
  if (rt.config.production || typeof fake.completeCheckout !== "function" || !fake.sign) return;
  const secret = process.env.GLIDEWORTH_STRIPE_WEBHOOK_SECRET || "whsec_development";
  app.post("/__dev/billing/complete-checkout", async (c) => {
    const addr = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)
      ?.incoming?.socket?.remoteAddress;
    if (!addr || !/^(127\.|::1$|::ffff:127\.)/.test(addr))
      return c.json({ error: { code: "NOT_FOUND", message: "not found" } }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { sessionId?: unknown };
    if (typeof body.sessionId !== "string" || !/^cs_test_[A-Za-z0-9_]{1,80}$/.test(body.sessionId))
      return c.json({ error: { code: "VALIDATION", message: "sessionId required" } }, 400);
    let events: unknown[];
    try {
      events = (fake.completeCheckout as (id: string) => unknown[])(body.sessionId);
    } catch {
      return c.json({ error: { code: "VALIDATION", message: "no such open session" } }, 400);
    }
    return c.json({
      events: events.map((ev) => (fake.sign as NonNullable<typeof fake.sign>)(ev, secret)),
    });
  });
}

/** What `start()` and the `glideworth-cloud` CLI load (`GLIDEWORTH_TENANT_RUNTIME_MODULE`). */
export const cloudHost = createCloudHost();
