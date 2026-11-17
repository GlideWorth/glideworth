import { eq, lt } from "drizzle-orm";
import type { Context, MiddlewareHandler } from "hono";
import type { AuthEnv } from "./auth.js";
import type { Db } from "./db/client.js";
import { idempotencyKeys } from "./db/schema.js";
import { ApiError } from "./errors.js";
import { sha256 } from "./util.js";

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const IDEMPOTENCY_TTL_MS = 24 * 3600 * 1000;
/**
 * POST routes whose response contains a one-time secret: never stored for replay (the secret must not be
 * persisted; everywhere else only its hash is). A new route that returns a secret must be added here.
 *   /keys, /me/keys                      a new API key
 *   /webhooks                            the new subscription's signing secret
 *   /plans/{id}/share-links              the share token
 *   /users, /users/{id}/invite, /users/{id}/reset-passphrase   self-host invite and reset tokens
 */
const SECRET_RESPONSE_ROUTES = [
  /^\/api\/v1\/(me\/)?keys\/?$/,
  /^\/api\/v1\/webhooks\/?$/,
  /^\/api\/v1\/plans\/[^/]+\/share-links\/?$/,
  /^\/api\/v1\/users\/?$/,
  /^\/api\/v1\/users\/[^/]+\/(invite|reset-passphrase)\/?$/,
];
export const returnsSecret = (method: string, path: string): boolean =>
  method === "POST" && SECRET_RESPONSE_ROUTES.some((re) => re.test(path));

/**
 * `Idempotency-Key` on writes: the first successful response is stored per (api key, idempotency
 * key) and replayed verbatim for retries. Reusing a key with a different request is a 422.
 */
export function idempotency(dbOf: Db | ((c: Context) => Db)): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    const db = typeof dbOf === "function" ? dbOf(c) : dbOf;
    const key = c.req.header("idempotency-key");
    if (!key || !WRITE_METHODS.has(c.req.method)) return next();
    if (key.length > 255)
      throw new ApiError(400, "VALIDATION", "Idempotency-Key must be at most 255 characters");
    const url = new URL(c.req.url);
    if (returnsSecret(c.req.method, url.pathname)) return next();
    const id = sha256(`${c.get("principal").keyId}:${key}`);
    const body = await c.req.raw.clone().text();
    const requestHash = sha256(`${c.req.method} ${url.pathname}${url.search}\n${body}`);
    const existing = db.select().from(idempotencyKeys).where(eq(idempotencyKeys.id, id)).get();
    if (existing) {
      if (existing.requestHash !== requestHash)
        throw new ApiError(
          422,
          "IDEMPOTENCY_KEY_REUSED",
          "this Idempotency-Key was already used with a different request",
        );
      const headers: Record<string, string> = {
        "content-type": existing.contentType,
        "idempotent-replay": "true",
      };
      if (existing.etag) headers.etag = existing.etag;
      return new Response(existing.status === 204 ? null : existing.response, {
        status: existing.status,
        headers,
      });
    }
    await next();
    const res = c.res;
    if (
      res.status >= 200 &&
      res.status < 300 &&
      !res.headers.get("content-type")?.includes("event-stream")
    ) {
      const text = await res.clone().text();
      db.delete(idempotencyKeys)
        .where(
          lt(idempotencyKeys.createdAt, new Date(Date.now() - IDEMPOTENCY_TTL_MS).toISOString()),
        )
        .run();
      db.insert(idempotencyKeys)
        .values({
          id,
          method: c.req.method,
          path: url.pathname,
          requestHash,
          status: res.status,
          contentType: res.headers.get("content-type") ?? "application/json",
          etag: res.headers.get("etag"),
          response: text,
        })
        .onConflictDoNothing()
        .run();
    }
  };
}

/** Most distinct callers a limiter remembers; beyond it the stalest windows are dropped first. */
const MAX_LIMITER_KEYS = 10_000;

/**
 * Fixed one-minute windows per key, in memory, with a hard bound on the number of keys: expired windows are
 * pruned first, then the oldest (insertion order) are evicted. A flood of distinct keys therefore costs bounded
 * memory, and evicting someone's window can only let them through early, never block someone else.
 */
export class WindowCounter {
  private readonly windows = new Map<string, { start: number; count: number }>();
  constructor(
    private readonly maxKeys = MAX_LIMITER_KEYS,
    private readonly now: () => number = Date.now,
  ) {}

  get size(): number {
    return this.windows.size;
  }

  /** Count one hit for `key`; returns the window's count and when it resets. */
  hit(key: string, windowMs = 60_000): { count: number; resetInMs: number } {
    const now = this.now();
    let w = this.windows.get(key);
    if (!w || now - w.start >= windowMs) {
      if (w) this.windows.delete(key);
      if (this.windows.size >= this.maxKeys) {
        for (const [k, v] of this.windows) if (now - v.start >= windowMs) this.windows.delete(k);
        for (const k of this.windows.keys()) {
          if (this.windows.size < this.maxKeys) break;
          this.windows.delete(k);
        }
      }
      w = { start: now, count: 0 };
      this.windows.set(key, w);
    }
    w.count++;
    return { count: w.count, resetInMs: windowMs - (now - w.start) };
  }
}

/**
 * Fixed-window per-credential rate limit (in memory; resets on restart). `perMinute <= 0` disables. The key is
 * the credential id in self-host mode and `<accountId>:<credential id>` in cloud mode (`keyOf`), so the same
 * key id in two workspaces never shares a bucket.
 */
export function rateLimit(
  perMinute: number,
  opts: { keyOf?: (c: Context<AuthEnv>) => string; maxKeys?: number } = {},
): MiddlewareHandler<AuthEnv> {
  const counter = new WindowCounter(opts.maxKeys);
  const keyOf = opts.keyOf ?? ((c: Context<AuthEnv>) => c.get("principal").keyId);
  return async (c, next) => {
    if (perMinute <= 0) return next();
    const w = counter.hit(keyOf(c));
    const remaining = Math.max(0, perMinute - w.count);
    c.header("X-RateLimit-Limit", String(perMinute));
    c.header("X-RateLimit-Remaining", String(remaining));
    if (w.count > perMinute) {
      const retry = Math.ceil(w.resetInMs / 1000);
      c.header("Retry-After", String(retry));
      throw new ApiError(
        429,
        "RATE_LIMITED",
        `rate limit of ${perMinute} requests/minute exceeded`,
        {
          retryAfterSeconds: retry,
        },
      );
    }
    await next();
  };
}

/** Conditional GET: a matching If-None-Match on any response with an ETag becomes a bodyless 304. */
export function conditionalGet(): MiddlewareHandler {
  return async (c, next) => {
    await next();
    if (c.req.method !== "GET" || c.res.status !== 200) return;
    const etag = c.res.headers.get("etag");
    const inm = c.req.header("if-none-match");
    if (
      etag &&
      inm
        ?.split(",")
        .map((s) => s.trim().replace(/^W\//, ""))
        .includes(etag)
    ) {
      c.res = new Response(null, { status: 304, headers: { etag } });
    }
  };
}

/** Parse an If-Match header into a plan/household version (`*` or absent = no precondition). */
export function parseIfMatch(c: Context): number | undefined {
  const raw = c.req.header("if-match");
  if (!raw || raw.trim() === "*") return undefined;
  const n = Number(raw.replace(/^W\//, "").replace(/"/g, "").trim());
  if (!Number.isInteger(n) || n < 0)
    throw new ApiError(400, "VALIDATION", 'If-Match must be the resource version, e.g. "3"');
  return n;
}

/** Fixed-window rate limit per client address for public (unauthenticated) endpoints. In memory, bounded. */
export function ipRateLimit(
  perMinute: number,
  clientOf: (c: Context) => string,
  opts: { maxKeys?: number } = {},
): MiddlewareHandler {
  const counter = new WindowCounter(opts.maxKeys);
  return async (c, next) => {
    if (perMinute <= 0) return next();
    const w = counter.hit(clientOf(c));
    if (w.count > perMinute) {
      const retry = Math.ceil(w.resetInMs / 1000);
      c.header("Retry-After", String(retry));
      throw new ApiError(429, "RATE_LIMITED", `too many requests; try again in ${retry}s`, {
        retryAfterSeconds: retry,
      });
    }
    await next();
  };
}
