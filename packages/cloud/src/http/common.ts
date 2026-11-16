/**
 * Request plumbing shared by the cloud routes, `tenantAuth` and the operator console: the JSON error envelope,
 * cookies, client address, CSRF and origin checks, and the `next` redirect rule.
 */
import { timingSafeEqual } from "node:crypto";
import { isBillingError } from "@glideworth/billing";
import type { Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { CloudError, storageQuotaError } from "../errors.js";
import type { Logger } from "../log/index.js";
import type { RequestMeta } from "../types.js";

// --------------------------------------------------------------------------------------------- cookies
export const SESSION_COOKIE = "__Host-gw_session";
/** Readable by the web app (it echoes the value in `X-CSRF-Token`). */
export const CSRF_COOKIE = "__Host-gw_csrf";
export const DEVICE_COOKIE = "__Host-gw_device";
export const CSRF_HEADER = "x-csrf-token";
const DEVICE_MAX_AGE = 400 * 24 * 3600;

export function setSessionCookies(
  c: Context,
  s: { token: string; csrf: string; maxAgeSeconds: number; newDeviceToken?: string | null },
): void {
  const base = { path: "/", secure: true, sameSite: "Strict" as const };
  setCookie(c, SESSION_COOKIE, s.token, { ...base, httpOnly: true, maxAge: s.maxAgeSeconds });
  setCookie(c, CSRF_COOKIE, s.csrf, { ...base, httpOnly: false, maxAge: s.maxAgeSeconds });
  if (s.newDeviceToken)
    setCookie(c, DEVICE_COOKIE, s.newDeviceToken, {
      ...base,
      httpOnly: true,
      maxAge: DEVICE_MAX_AGE,
    });
}

export function clearSessionCookies(c: Context): void {
  const base = { path: "/", secure: true, sameSite: "Strict" as const, maxAge: 0 };
  setCookie(c, SESSION_COOKIE, "", { ...base, httpOnly: true });
  setCookie(c, CSRF_COOKIE, "", { ...base, httpOnly: false });
}

export const sessionCookie = (c: Context): string | undefined => getCookie(c, SESSION_COOKIE);

// ------------------------------------------------------------------------------------------- addresses
/** The client address: the first `X-Forwarded-For` hop behind a trusted proxy, else the socket address. */
export function clientIp(c: Context, trustProxy: boolean): string {
  if (trustProxy) {
    const f = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
    if (f && /^[0-9a-fA-F:.]{2,45}$/.test(f)) return f;
  }
  const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
  return env?.incoming?.socket?.remoteAddress ?? "unknown";
}

export function requestMeta(c: Context, trustProxy: boolean): RequestMeta {
  const ua = c.req.header("user-agent");
  return {
    ip: clientIp(c, trustProxy),
    userAgent: ua ? ua.slice(0, 256) : null,
    deviceToken: getCookie(c, DEVICE_COOKIE) ?? null,
  };
}

// -------------------------------------------------------------------------------------- origin and CSRF
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
export const isSafeMethod = (m: string) => SAFE_METHODS.has(m.toUpperCase());

/**
 * A write must not come from another site: `Origin` (when sent) must be the public origin, and
 * `Sec-Fetch-Site` (when sent) must be same-origin or none. Applies to every cloud write, signed in or not
 * (sign-in CSRF).
 */
export function assertSameOrigin(c: Context, publicOrigin: string): void {
  const origin = c.req.header("origin");
  if (origin !== undefined && origin !== publicOrigin)
    throw new CloudError(403, "CSRF", "cross-origin request refused");
  const site = c.req.header("sec-fetch-site");
  if (site !== undefined && site !== "same-origin" && site !== "none")
    throw new CloudError(403, "CSRF", "cross-site request refused");
}

/** Cookie-authenticated writes also echo the session's CSRF token (compared in constant time). */
export function assertCsrfToken(c: Context, expected: string): void {
  const given = c.req.header(CSRF_HEADER) ?? "";
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (!given || a.length !== b.length || !timingSafeEqual(a, b))
    throw new CloudError(403, "CSRF", `missing or invalid ${CSRF_HEADER} header`);
}

/**
 * The `next` redirect rule: only a same-origin relative path (`/settings`, `/plans/1?tab=x`). Absolute URLs,
 * scheme-relative `//host`, backslash tricks, control characters and anything that resolves to another origin
 * become `/`.
 */
export function safeNext(next: unknown, publicOrigin: string): string {
  if (typeof next !== "string" || next.length === 0 || next.length > 2048) return "/";
  // oxlint-disable-next-line eslint/no-control-regex -- control characters are what we refuse
  if (!next.startsWith("/") || next.startsWith("//") || /[\\\u0000-\u001f\u007f]/.test(next))
    return "/";
  try {
    const u = new URL(next, publicOrigin);
    if (u.origin !== publicOrigin) return "/";
    return `${u.pathname}${u.search}${u.hash}`;
  } catch {
    return "/";
  }
}

// ----------------------------------------------------------------------------------------------- errors
const BILLING_STATUS: Record<string, [CloudError["status"], CloudError["code"]]> = {
  ALREADY_SUBSCRIBED: [409, "ALREADY_SUBSCRIBED"],
  UNKNOWN_PRICE: [400, "VALIDATION"],
  NOT_OFFERED: [400, "VALIDATION"],
  NO_CUSTOMER: [409, "CONFLICT"],
  NO_SUBSCRIPTION: [409, "CONFLICT"],
  CHECKOUT_RATE_LIMITED: [429, "RATE_LIMITED"],
  CHECKOUT_PAUSED: [503, "TENANT_UNAVAILABLE"],
  STRIPE_UNAVAILABLE: [503, "TENANT_UNAVAILABLE"],
  FORBIDDEN: [403, "FORBIDDEN"],
  CONFIG_INVALID: [500, "INTERNAL"],
  SIGNATURE_INVALID: [400, "VALIDATION"],
};

/** Billing errors as CloudErrors (fixed messages; the billing package's messages are not shown). */
export function fromBillingError(err: unknown): CloudError | null {
  if (!isBillingError(err)) return null;
  const [status, code] = BILLING_STATUS[err.code] ?? [500, "INTERNAL"];
  const messages: Partial<Record<CloudError["code"], string>> = {
    ALREADY_SUBSCRIBED: "a subscription exists; manage it in the billing portal",
    RATE_LIMITED: "too many checkout attempts; try again later",
    TENANT_UNAVAILABLE: "billing is temporarily unavailable; try again shortly",
    FORBIDDEN: "only the verified workspace owner can do this",
    VALIDATION: "unknown or unavailable price",
    CONFLICT: "no billing account yet; subscribe first",
    INTERNAL: "billing is misconfigured",
  };
  return new CloudError(status, code, messages[code] ?? "billing request failed", {
    billingCode: err.code,
  });
}

/**
 * `{ error: { code, message, details } }`. CloudError messages are fixed strings (safe to show); anything
 * else is a 500 with a generic message, logged only through `describeErrorForLog`.
 */
export function cloudErrorResponse(err: unknown, c: Context, log?: Logger): Response {
  const e = err instanceof CloudError ? err : (fromBillingError(err) ?? storageQuotaError(err));
  if (e) {
    const retry = e.details?.retryAfterSeconds;
    if (e.status === 429 || e.status === 503)
      c.header("Retry-After", String(typeof retry === "number" ? retry : 60));
    return c.json({ error: { code: e.code, message: e.message, details: e.details } }, e.status);
  }
  const status = (err as { status?: unknown })?.status;
  if (status === 413)
    return c.json({ error: { code: "PAYLOAD_TOO_LARGE", message: "request body too large" } }, 413);
  log?.error("http.unhandled", { route: c.req.routePath, method: c.req.method, err });
  return c.json({ error: { code: "INTERNAL", message: "something went wrong" } }, 500);
}
