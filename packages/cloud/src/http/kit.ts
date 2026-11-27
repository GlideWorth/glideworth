/**
 * Route kit: how every cloud route is declared (OpenAPI through `@hono/zod-openapi`), validated, protected and
 * how its errors become the JSON envelope. Handlers never see a request that failed validation, and every
 * error, including a validation failure, is answered here, so the cloud routes do not depend on the host's
 * error mapping.
 */
import type { BillingService, PricingConfig } from "@glideworth/billing";
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { CaptchaVerifier } from "../abuse/captcha.js";
import type { FederationService } from "../federation/service.js";
import type { RateLimiter } from "../abuse/rate-limiter.js";
import type { AccountsService } from "../accounts/service.js";
import type { ControlAudit } from "../audit.js";
import type { BackupService } from "../backups/service.js";
import type { CloudConfig } from "../config.js";
import type { ControlDb } from "../control/db.js";
import type { MailOutbox } from "../control/outbox.js";
import type { Keyring } from "../crypto/keyring.js";
import { CloudError } from "../errors.js";
import type { UnsubscribeSigner } from "../external-types.js";
import type { Logger } from "../log/index.js";
import type { ProductEvents } from "../log/product-events.js";
import type { CalculatorEmailService } from "../marketing/service.js";
import type { QuotaService } from "../quotas.js";
import type { TenantRegistry } from "../tenancy/registry.js";
import type {
  EntitlementsService,
  Membership,
  SessionContext,
  TenantRuntimeBase,
} from "../types.js";
import type { WorkspacesService } from "../workspaces/service.js";
import {
  assertCsrfToken,
  assertSameOrigin,
  clientIp,
  cloudErrorResponse,
  isSafeMethod,
  requestMeta,
  sessionCookie,
} from "./common.js";

export interface CloudHttpDeps {
  config: CloudConfig;
  accounts: AccountsService;
  workspaces: WorkspacesService;
  billing: BillingService;
  entitlements: EntitlementsService;
  quotas: QuotaService;
  backups: BackupService;
  captcha: CaptchaVerifier;
  limiter: RateLimiter;
  audit: ControlAudit;
  log: Logger;
  unsubscribe: UnsubscribeSigner;
  // ---- not in spec 8.3
  /** The control plane (writer locks, checkout sessions, suppressions, operators). */
  db: ControlDb;
  keys: Keyring;
  pricing: PricingConfig;
  /** Must-send mail queue (the console's resend actions use it; drained by the server). */
  outbox?: MailOutbox;
  /** Behind the reverse proxy: take the client address from `X-Forwarded-For`. */
  trustProxy?: boolean;
  /** Cloudflare Turnstile site key (public). Sent in `GET /api/v1/auth/status` as `captcha.siteKey` so the web app renders the widget. */
  captchaSiteKey?: string;
  /** Mailgun webhook signing key; the bounce/complaint route exists only when set. */
  mailgunWebhookSigningKey?: string;
  /** Operator console: the registry (health, restore, migrate) and the host's support view. */
  registry?: TenantRegistry<TenantRuntimeBase>;
  supportView?: (runtime: TenantRuntimeBase) => Promise<SupportView> | SupportView;
  /** Operator console health extras (job pool, scheduler lag) supplied by the server. */
  health?: () => Record<string, string | number | null>;
  now?: () => Date;
  /** Not in spec 8.3: "Sign in with Google". Absent when not configured: no Google route is registered. */
  federation?: FederationService;
  /**
   * Not in spec 8.3: the free calculators' "Email me this result" form. Absent unless
   * `GLIDEWORTH_CALCULATOR_EMAIL_ORIGIN` is set: then no route is registered.
   */
  calculatorEmail?: { service: CalculatorEmailService; siteOrigin: string };
  /** Server-side product events (PostHog); absent when not configured. */
  productEvents?: ProductEvents;
}

/** What the host's support view renders: headings with plain-text rows (escaped by the console). */
export interface SupportView {
  sections: Array<{ title: string; rows: Array<[string, string]> }>;
}

export const ErrorSchema = z
  .object({
    error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }),
  })
  .openapi("CloudError");

type Method = "get" | "post" | "patch" | "delete";

export interface OpDef {
  method: Method;
  path: string;
  tag: string;
  summary: string;
  description?: string;
  body?: z.ZodType;
  params?: z.ZodObject;
  query?: z.ZodObject;
  /** `session`: browser session cookie (+ CSRF on writes). `none`: public. */
  auth: "session" | "none";
  /** 302: a browser redirect (the Google sign-in start and callback). */
  ok: 200 | 201 | 202 | 204 | 302;
  okSchema?: z.ZodType;
  okContentType?: string;
  /** Bodies that are not JSON (raw webhook, form posts): validation is the handler's job. */
  rawBody?: { contentType: string; description: string };
}

export interface OpInput {
  body: never;
  params: Record<string, string>;
  query: Record<string, string>;
}

const errorResponses = {
  400: { description: "Invalid request", content: { "application/json": { schema: ErrorSchema } } },
  401: { description: "Not signed in", content: { "application/json": { schema: ErrorSchema } } },
  403: {
    description: "Forbidden (CSRF, role, re-authentication)",
    content: { "application/json": { schema: ErrorSchema } },
  },
  404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  409: { description: "Conflict", content: { "application/json": { schema: ErrorSchema } } },
  429: { description: "Rate limited", content: { "application/json": { schema: ErrorSchema } } },
} as const;

export class RouteKit {
  readonly publicOrigin: string;
  readonly publicUrl: string;

  constructor(
    readonly app: OpenAPIHono<never>,
    readonly d: CloudHttpDeps,
  ) {
    this.publicUrl = d.config.publicUrl.replace(/\/+$/, "");
    this.publicOrigin = new URL(this.publicUrl).origin;
  }

  now(): Date {
    return this.d.now?.() ?? new Date();
  }

  op(def: OpDef, handler: (c: Context, input: OpInput) => Promise<Response> | Response): void {
    const request: Record<string, unknown> = {};
    if (def.body)
      request.body = { content: { "application/json": { schema: def.body } }, required: true };
    if (def.params) request.params = def.params;
    if (def.query) request.query = def.query;
    const okContent = def.okSchema
      ? { content: { [def.okContentType ?? "application/json"]: { schema: def.okSchema } } }
      : {};
    const route = createRoute({
      method: def.method,
      path: def.path,
      tags: [def.tag],
      summary: def.summary,
      // Raw bodies (signed webhooks, form posts) are read by the handler; declaring them here would make the
      // validator parse them first, so they are documented in the description instead.
      ...(def.description || def.rawBody
        ? {
            description: [
              def.description,
              def.rawBody ? `Body: ${def.rawBody.contentType}. ${def.rawBody.description}` : null,
            ]
              .filter(Boolean)
              .join("\n\n"),
          }
        : {}),
      request: request as never,
      ...(def.auth === "session" ? { security: [{ cloudSession: [] }] } : { security: [] }),
      responses: { [def.ok]: { description: "Success", ...okContent }, ...errorResponses } as never,
    });
    const valid = (c: Context, part: "json" | "param" | "query") =>
      (c.req as unknown as { valid(p: string): unknown }).valid(part);
    const wrapped = async (c: Context) => {
      try {
        const input: OpInput = {
          body: (def.body ? valid(c, "json") : undefined) as never,
          params: (def.params ? valid(c, "param") : {}) as Record<string, string>,
          query: (def.query ? valid(c, "query") : {}) as Record<string, string>,
        };
        if (def.auth === "none" && !isSafeMethod(c.req.method) && !def.rawBody)
          assertSameOrigin(c, this.publicOrigin);
        const res = await handler(c, input);
        res.headers.set("Cache-Control", "no-store");
        return res;
      } catch (err) {
        return cloudErrorResponse(err, c, this.d.log);
      }
    };
    // Validation failures: a fixed message (never an echo of the input), field paths only.
    const hook = (
      result: { success: boolean; error?: { issues: Array<{ path: PropertyKey[] }> } },
      c: Context,
    ) => {
      if (result.success) return;
      const fields = (result.error?.issues ?? [])
        .slice(0, 5)
        .map((i) => i.path.map(String).join("."))
        .filter((p) => /^[A-Za-z0-9_.]{0,64}$/.test(p));
      return cloudErrorResponse(
        new CloudError(400, "VALIDATION", "invalid request", { fields }),
        c,
      );
    };
    (this.app as unknown as { openapi(r: unknown, h: unknown, k: unknown): void }).openapi(
      route,
      wrapped,
      hook,
    );
  }

  /** The signed-in session; writes also need the CSRF token and a same-origin request. */
  session(c: Context): SessionContext {
    const s = this.d.accounts.resolveSession(sessionCookie(c));
    if (!s) throw new CloudError(401, "UNAUTHORIZED", "sign in first");
    if (!isSafeMethod(c.req.method)) {
      assertSameOrigin(c, this.publicOrigin);
      assertCsrfToken(c, s.csrf);
    }
    return s;
  }

  /** The session's membership of its active workspace (re-read). */
  member(s: SessionContext): Membership {
    if (!s.activeAccountId) throw new CloudError(403, "FORBIDDEN", "choose a workspace first");
    const m = this.d.workspaces.membership(s.activeAccountId, s.userId);
    if (!m) throw new CloudError(403, "FORBIDDEN", "you are not a member of that workspace");
    return m;
  }

  owner(s: SessionContext): Membership {
    const m = this.member(s);
    if (m.role !== "owner")
      throw new CloudError(403, "FORBIDDEN", "only the workspace owner can do this");
    return m;
  }

  meta(c: Context) {
    return requestMeta(c, !!this.d.trustProxy);
  }

  ip(c: Context): string {
    return clientIp(c, !!this.d.trustProxy);
  }

  /** Coarse per-address flood limit on public endpoints (the services apply the specific limits). */
  floodLimit(c: Context, bucket: string, limit = 60): void {
    const r = this.d.limiter.hit(`http:${bucket}:${this.ip(c)}`, limit, 60_000);
    if (!r.allowed)
      throw new CloudError(429, "RATE_LIMITED", "too many requests; slow down", {
        retryAfterSeconds: Math.max(1, Math.ceil(r.retryAfterMs / 1000)),
      });
  }
}

/** Paths served by `registerCloudRoutes`; the host must not put `tenantAuth` in front of them. */
export const CLOUD_ROUTE_PREFIXES = [
  "/api/v1/auth/",
  "/api/v1/account",
  "/api/v1/workspaces",
  "/api/v1/workspace",
  "/api/v1/billing",
  "/stripe/webhook",
  "/email/",
] as const;

export function isCloudRoute(path: string): boolean {
  return CLOUD_ROUTE_PREFIXES.some(
    (p) =>
      path === p || path.startsWith(p.endsWith("/") ? p : `${p}/`) || path === p.replace(/\/$/, ""),
  );
}
