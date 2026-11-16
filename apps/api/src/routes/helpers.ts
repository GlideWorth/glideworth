import { Id } from "@glideworth/core";
import { createRoute, type OpenAPIHono, type RouteConfig, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { AuditActor, AuthEnv, Requirement } from "../auth.js";
import { actorOf as principalActor, requireOwner, requireScope } from "../auth.js";
import { ErrorBody } from "../errors.js";
import { parseIfMatch } from "../middleware.js";
import type { Services } from "../services.js";

export type App = OpenAPIHono<AuthEnv>;
export interface RouteCtx {
  app: App;
  /**
   * The `Services` of the request: the one instance in self-host mode, the workspace's own in cloud mode
   * (set by the auth middleware from `c.get('tenant')`). Never captured at registration.
   */
  svc: (c: Context) => Services;
  /** `cloud`: self-host-only routes (passphrase accounts, instance users) are not registered. */
  mode: "selfhost" | "cloud";
}

/** Services for this request (see `RouteCtx.svc`). */
export const servicesOf = (c: Context): Services => {
  const s = (c as Context<AuthEnv>).get("services");
  if (!s) throw new Error("no services on the request context");
  return s;
};

export const json = <T extends z.ZodType>(schema: T, description: string) => ({
  content: { "application/json": { schema } },
  description,
});

export const errors = {
  400: json(ErrorBody, "Invalid request (VALIDATION)"),
  401: json(ErrorBody, "Missing or invalid API key"),
  403: json(ErrorBody, "API key lacks the required scope"),
  404: json(ErrorBody, "Not found"),
  409: json(ErrorBody, "Conflict (duplicate id, version mismatch, in use)"),
  422: json(
    ErrorBody,
    "Scenario is inconsistent (dangling reference, circular milestone...) or Idempotency-Key reused",
  ),
  429: json(ErrorBody, "Rate limited"),
  501: json(
    ErrorBody,
    "The plan uses a feature that is not implemented yet (details.feature, details.workstream)",
  ),
};

const security = [{ bearer: [] }];
export const IdempotencyHeader = z
  .string()
  .max(255)
  .optional()
  .describe("Makes this write safe to retry: the first successful response is replayed for 24h.");

const SCOPE_NOTE: Record<Requirement, string> = {
  read: "Scope: `read`.",
  simulate: "Scope: `simulate` (or `read`).",
  write: "Scope: `write` (role owner or editor).",
};

/**
 * Declare an operation. Every route states the scope it needs (type-enforced), gets the bearer
 * security requirement, the shared error responses and, for writes, the Idempotency-Key header.
 */
export function route<R extends RouteConfig>(
  need: Requirement,
  cfg: R,
  opts: { owner?: boolean; allowWhenReadOnly?: boolean } = {},
  // oxlint-disable-next-line typescript/no-explicit-any -- see above
): R & { middleware: any } {
  // oxlint-disable-next-line typescript/no-explicit-any -- see above
  const c = cfg as any;
  const write = cfg.method !== "get" && cfg.method !== "head";
  const scopeOpts = opts.allowWhenReadOnly ? { allowWhenReadOnly: true } : {};
  const request = { ...(c.request ?? {}) };
  if (write) {
    const base = request.headers ?? z.object({});
    request.headers = base.extend({ "idempotency-key": IdempotencyHeader });
  }
  return createRoute({
    ...c,
    request,
    security,
    description: `${c.description ?? ""}${c.description ? "\n\n" : ""}${SCOPE_NOTE[need]}${opts.owner ? " Role: `owner`." : ""}`,
    responses: { ...c.responses, ...errors },
    middleware: opts.owner
      ? [requireScope(need, scopeOpts), requireOwner()]
      : [requireScope(need, scopeOpts)],
    "x-required-scope": need,
    ...(opts.owner ? { "x-required-role": "owner" } : {}),
    ...(opts.allowWhenReadOnly ? { "x-allow-when-read-only": true } : {}),
    // oxlint-disable-next-line typescript/no-explicit-any -- see above
  }) as any;
}

export function actorOf(c: {
  get: (k: "principal") => import("../auth.js").Principal;
}): AuditActor {
  return principalActor(c.get("principal"));
}

export { parseIfMatch };

/** Path id parameter (built from the openapi-extended `z`; core's schemas pre-date the extension). */
export const pathId = (name: string) =>
  z
    .string()
    .min(1)
    .max(64)
    .openapi({ param: { name, in: "path" } });

export const IdParam = z.object({ id: pathId("id") });

export const IfMatch = z.object({
  "if-match": z.string().optional().openapi({
    description:
      'Optimistic concurrency: the resource version you last read, e.g. "3". 409 VERSION_CONFLICT if stale.',
  }),
});

/** `id` optional on create (generated when absent), for object or discriminated-union item schemas. */
// oxlint-disable-next-line typescript/no-explicit-any -- schemas are dynamic here
export function withOptionalId(schema: any, metaId: string): z.ZodType {
  const opt = { id: Id.optional().describe("Omit to generate one.") };
  if (schema.options) {
    // oxlint-disable-next-line typescript/no-explicit-any -- discriminated union options
    const opts = schema.options.map((o: any) => o.extend(opt));
    return z.discriminatedUnion(schema._zod.def.discriminator, opts).meta({ id: metaId });
  }
  return schema.extend(opt).meta({ id: metaId });
}

export const MergePatchBody = z
  .record(z.string(), z.unknown())
  .describe("RFC 7386 JSON Merge Patch: send only the fields to change; null removes a field.");

export const Deleted = { 204: { description: "Deleted" } };
