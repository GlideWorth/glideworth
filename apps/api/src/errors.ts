import { GlideworthError, isNotImplemented, PatchConflictError } from "@glideworth/core";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import { log } from "./log.js";

export class ApiError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export const notFound = (what: string, id: string) =>
  new ApiError(404, "NOT_FOUND", `${what} '${id}' not found`);
export const conflict = (message: string, details?: unknown, code = "CONFLICT") =>
  new ApiError(409, code, message, details);

export const ErrorBody = z
  .object({
    error: z.object({
      code: z
        .string()
        .describe("Stable machine-readable code, e.g. VALIDATION, NOT_FOUND, VERSION_CONFLICT."),
      message: z.string(),
      details: z.unknown().optional(),
    }),
  })
  .meta({ id: "Error" });

/**
 * HTTP status for a core error code. `PATCH_CONFLICT` (an op whose target is missing or whose
 * `test` failed: core's PatchConflictError) is a 409; scenario problems are 422.
 */
export function statusForCoreCode(code: string): ContentfulStatusCode {
  if (code === "VALIDATION") return 400;
  if (code === "PATCH_CONFLICT") return 409;
  if (code === "ABORTED") return 409;
  return 422;
}

const GLIDEWORTH_ERROR_NAMES = new Set([
  "GlideworthError",
  "NotImplementedError",
  "ValidationError",
  "ScenarioError",
  "PatchConflictError",
  "MonteCarloAbortedError",
]);

/** Duck-typed so errors revived from a worker thread, or from a second copy of core, map identically. */
function isGlideworthLike(err: unknown): err is GlideworthError {
  if (err instanceof GlideworthError || err instanceof PatchConflictError) return true;
  // Only Glideworth's own error classes: a driver or runtime error (SqliteError `SQLITE_CONSTRAINT_*`, a
  // TypeError `ERR_*`) also has a SHOUTY `code` and must not be echoed to callers as a 422.
  return (
    err instanceof Error &&
    GLIDEWORTH_ERROR_NAMES.has(err.name) &&
    typeof (err as unknown as { code?: unknown }).code === "string" &&
    /^[A-Z][A-Z_]+$/.test((err as unknown as { code: string }).code)
  );
}

/** "validation failed: residency.0.location.country: ..." — the first issues, with their paths. */
export function zodMessage(err: z.ZodError): string {
  const parts = err.issues
    .slice(0, 3)
    .map((i) => `${i.path.length ? `${i.path.join(".")}: ` : ""}${i.message}`);
  const more = err.issues.length > 3 ? ` (and ${err.issues.length - 3} more)` : "";
  return parts.length ? `validation failed: ${parts.join("; ")}${more}` : "validation failed";
}

/**
 * Errors from the cloud package (`CloudError`: name, numeric status, string code, a fixed message that is safe
 * to show) and a full database (`SQLITE_FULL`: the workspace storage quota in cloud mode, a full disk in
 * self-host mode). Duck-typed: this module never imports a cloud package.
 */
export function cloudLikeError(err: unknown): ApiError | null {
  const e = err as {
    name?: unknown;
    status?: unknown;
    code?: unknown;
    message?: unknown;
    details?: unknown;
  };
  if (!e || typeof e !== "object") return null;
  if (
    e.name === "CloudError" &&
    typeof e.status === "number" &&
    typeof e.code === "string" &&
    typeof e.message === "string"
  )
    return new ApiError(e.status as ContentfulStatusCode, e.code, e.message, e.details);
  if (e.code === "SQLITE_FULL")
    return new ApiError(
      507,
      "STORAGE_QUOTA_EXCEEDED",
      "the workspace has reached the storage limit of its plan",
    );
  return null;
}

/** Map domain errors to HTTP. NotImplemented -> 501 with the feature id + owning workstream. */
export function toErrorResponse(err: unknown, c: Context) {
  const cloud = cloudLikeError(err);
  if (cloud) {
    if (cloud.status === 429 || cloud.status === 503) {
      const retry = (cloud.details as { retryAfterSeconds?: unknown } | undefined)
        ?.retryAfterSeconds;
      c.header("Retry-After", String(typeof retry === "number" ? retry : 60));
    }
    return c.json(
      { error: { code: cloud.code, message: cloud.message, details: cloud.details } },
      cloud.status,
    );
  }
  if (err instanceof ApiError) {
    // A busy server or a per-workspace limit says when to retry (e.g. 503 IMPORT_BUSY, 429 RATE_LIMITED).
    const retry = (err.details as { retryAfterSeconds?: unknown } | undefined)?.retryAfterSeconds;
    if ((err.status === 429 || err.status === 503) && typeof retry === "number")
      c.header("Retry-After", String(retry));
    return c.json(
      { error: { code: err.code, message: err.message, details: err.details } },
      err.status,
    );
  }
  if (isNotImplemented(err)) {
    const e = err as GlideworthError;
    return c.json({ error: { code: e.code, message: e.message, details: e.details } }, 501);
  }
  if (isGlideworthLike(err))
    return c.json(
      { error: { code: err.code, message: err.message, details: err.details } },
      statusForCoreCode(err.code),
    );
  if (err instanceof z.ZodError)
    return c.json(
      { error: { code: "VALIDATION", message: zodMessage(err), details: err.issues } },
      400,
    );
  if (err instanceof HTTPException)
    return c.json(
      { error: { code: err.status === 400 ? "VALIDATION" : "HTTP_ERROR", message: err.message } },
      err.status as ContentfulStatusCode,
    );
  if (err instanceof SyntaxError)
    return c.json(
      { error: { code: "VALIDATION", message: "request body is not valid JSON" } },
      400,
    );
  // Cloud mode: the workspace the request ran in (the error report's distinct id). Self-host has no tenant.
  const tenant = (c.var as { tenant?: { accountId?: unknown } }).tenant;
  const accountId = typeof tenant?.accountId === "string" ? tenant.accountId : undefined;
  log.error("http.unhandled", { route: c.req.routePath, method: c.req.method, accountId, err });
  return c.json({ error: { code: "INTERNAL", message: "internal error" } }, 500);
}

/** Same mapping for non-HTTP surfaces (MCP). */
export function describeError(err: unknown): { code: string; message: string; details?: unknown } {
  const cloud = cloudLikeError(err);
  if (cloud) return { code: cloud.code, message: cloud.message, details: cloud.details };
  if (err instanceof ApiError)
    return { code: err.code, message: err.message, details: err.details };
  if (isGlideworthLike(err)) return { code: err.code, message: err.message, details: err.details };
  if (err instanceof z.ZodError)
    return { code: "VALIDATION", message: zodMessage(err), details: err.issues };
  // Unknown failures are logged server-side (never their message); the caller never sees internals.
  log.error("error.unhandled", { err });
  return { code: "INTERNAL", message: "internal error; see the server log" };
}
