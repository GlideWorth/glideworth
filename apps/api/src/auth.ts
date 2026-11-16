import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Actor } from "@glideworth/core";
import { eq } from "drizzle-orm";
import type { Context, MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import type { Db } from "./db/client.js";
import { apiKeys, users } from "./db/schema.js";
import { ApiError } from "./errors.js";
import type { AuthService } from "./services/auth.js";

/**
 * Scopes:
 *   read      GET everything (plans, finances, results).
 *   simulate  run compute (simulate, Monte Carlo, solvers, insights) and read job status/results.
 *   write     mutate data (plans, finances, change sets, keys, webhooks...). Implies read + simulate.
 * A `read` key may also run compute (read-only data, derived numbers); a `simulate` key cannot read raw data.
 */
export type Scope = "read" | "write" | "simulate";
export const SCOPES: Scope[] = ["read", "write", "simulate"];

/**
 * Roles (instance-wide):
 *   owner   everything, including users, webhooks and the audit log. Exactly one per instance.
 *   editor  read + simulate + write (plans, finances, imports, share links, own API keys).
 *   viewer  read + simulate only: no route or MCP tool that writes is available.
 * Every route declares the scope it needs, so the role is enforced by capping a caller's scopes
 * (browser session, API key and OAuth token alike) to what the role allows.
 */
export type Role = "owner" | "editor" | "viewer";
export const ROLES: Role[] = ["owner", "editor", "viewer"];
export const ROLE_SCOPES: Record<Role, Scope[]> = {
  owner: ["read", "simulate", "write"],
  editor: ["read", "simulate", "write"],
  viewer: ["read", "simulate"],
};
export const capScopes = (scopes: Scope[], role: Role): Scope[] =>
  scopes.filter((s) => ROLE_SCOPES[role].includes(s));

export interface Principal {
  keyId: string;
  name: string;
  scopes: Scope[];
  /** How the caller authenticated: an API key, a browser session cookie or an OAuth access token. */
  via?: "key" | "session" | "oauth";
  /** The person behind the credential (API keys and OAuth tokens belong to a user). */
  userId: string;
  userName: string;
  role: Role;
  /**
   * Cloud mode: the workspace is not at full access, so `scopes` were capped by entitlement (read-only after a
   * lapse, nothing while suspended). `requireScope` then answers 402 `ACCOUNT_READ_ONLY` (or 403
   * `ACCOUNT_SUSPENDED`) instead of the role message. Never set in self-host mode.
   */
  limitedBy?: "entitlement";
  /** The scopes before the entitlement cap (routes declared `allowWhenReadOnly` are checked against these). */
  uncappedScopes?: Scope[];
  /** Why the cap applies (set together with `limitedBy`). */
  entitlement?: { level: "read_only" | "suspended"; reason: string; billingUrl: string };
  /** Cloud mode: the workspace (tenant) the credential belongs to. */
  accountId?: string;
}

/** Who wrote something: stamped on plan versions and change sets. `userId`/`userName` name the person. */
export type AuditActor = Actor & { userId?: string; userName?: string };

export function actorOf(p: Principal, oauthClientName?: string): AuditActor {
  const who = { userId: p.userId, userName: p.userName };
  if (p.via === "session") return { kind: "user", id: p.userId, label: p.userName, ...who };
  const owner = p.userId === "owner";
  return {
    kind: p.via === "oauth" ? "mcp" : "api-key",
    id: p.keyId,
    label: owner && p.via !== "oauth" ? p.name : `${oauthClientName ?? p.name} (${p.userName})`,
    ...who,
  };
}

export interface AuthUser {
  id: string;
  name: string;
  role: Role;
}

/** The enabled user with this id, or null (unknown or disabled). */
export function loadUser(db: Db, id: string): AuthUser | null {
  const u = db.select().from(users).where(eq(users.id, id)).get();
  if (!u || u.disabledAt) return null;
  return { id: u.id, name: u.name, role: u.role };
}

/** Browser session cookie (httpOnly, SameSite=Strict) and the CSRF companion the web app echoes back. */
export const SESSION_COOKIE = "glideworth_session";
export const CSRF_COOKIE = "glideworth_csrf";
/** Pre-rename cookie names: still accepted on requests (a sign-in before the upgrade stays valid), never set. */
export const LEGACY_SESSION_COOKIE = "cairn_session";
export const LEGACY_CSRF_COOKIE = "cairn_csrf";
/** The session token the browser sent: the current cookie, else the pre-rename one. */
export const sessionToken = (c: Context): string | undefined =>
  getCookie(c, SESSION_COOKIE) ?? getCookie(c, LEGACY_SESSION_COOKIE);
export const CSRF_HEADER = "x-csrf-token";
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
/** A browser session may do everything the single owner can. */
export const SESSION_SCOPES: Scope[] = ["read", "simulate", "write"];

/** What a route declares it needs. */
export type Requirement = "read" | "simulate" | "write";

export function allows(scopes: Scope[], need: Requirement): boolean {
  if (scopes.includes("write")) return true;
  if (need === "read") return scopes.includes("read");
  if (need === "simulate") return scopes.includes("simulate") || scopes.includes("read");
  return false;
}

/** New keys are `glideworth_<prefix>_<secret>`; keys minted before the rename (`cairn_…`) keep verifying. */
export const KEY_PREFIX = "glideworth";
const KEY_RE = /^(?:glideworth|cairn)_([a-z0-9]{8})_([A-Za-z0-9]{32,})$/;

/**
 * How API keys look in a mode. Self-host: `glideworth_<8>_<secret>` (and the pre-rename `cairn_`). Cloud:
 * the routed `gwk_<account>_<8>_<secret>` of `@glideworth/cloud`, recognised only for its own workspace. The
 * stored hash is SHA-256 of the whole key string either way.
 */
export interface KeyFormat {
  generate(): { key: string; prefix: string };
  /** The lookup prefix of a well-formed key of this format, else null. */
  prefixOf(key: string): string | null;
  /** Shown in error messages and docs. */
  readonly example: string;
}

export const SELFHOST_KEY_FORMAT: KeyFormat = {
  generate() {
    const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
    const prefix = Array.from(randomBytes(8), (b) => alphabet[b % alphabet.length]).join("");
    const secret = randomBytes(24).toString("base64url").replace(/[-_]/g, "x").padEnd(32, "x");
    return { key: `${KEY_PREFIX}_${prefix}_${secret}`, prefix };
  },
  prefixOf: (key) => KEY_RE.exec(key)?.[1] ?? null,
  example: "glideworth_<8 lowercase alnum>_<32+ alnum>",
};

/** True when the string has the shape of a self-host API key (as opposed to an OAuth access token). */
const isSelfhostKey = (token: string): boolean => KEY_RE.test(token);

export function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export function generateKey(format: KeyFormat = SELFHOST_KEY_FORMAT): {
  key: string;
  prefix: string;
} {
  return format.generate();
}

export function insertKey(
  db: Db,
  key: string,
  name: string,
  scopes: Scope[],
  userId?: string,
  format: KeyFormat = SELFHOST_KEY_FORMAT,
): string {
  const prefix = format.prefixOf(key);
  if (!prefix) throw new Error(`invalid key format; expected ${format.example}`);
  const id = `key_${prefix}`;
  db.insert(apiKeys)
    .values({ id, name, prefix, hash: hashKey(key), scopes, userId: userId ?? null })
    .run();
  return id;
}

export function verifyKey(
  db: Db,
  key: string,
  format: KeyFormat = SELFHOST_KEY_FORMAT,
): Principal | null {
  const prefix = format.prefixOf(key);
  if (!prefix) return null;
  const row = db.select().from(apiKeys).where(eq(apiKeys.prefix, prefix)).get();
  if (!row || row.revokedAt) return null;
  const a = Buffer.from(row.hash, "hex");
  const b = Buffer.from(hashKey(key), "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  // The key acts for its user, and never with more than that user's role allows (demoting a user
  // demotes their keys; disabling a user disables them).
  const user = loadUser(db, row.userId ?? "owner");
  if (!user) return null;
  db.update(apiKeys)
    .set({ lastUsedAt: new Date().toISOString() })
    .where(eq(apiKeys.id, row.id))
    .run();
  return {
    keyId: row.id,
    name: row.name,
    scopes: capScopes(row.scopes, user.role),
    userId: user.id,
    userName: user.name,
    role: user.role,
  };
}

/** The key printed in .env.example and the docs: public, so never a credential in production. */
export const PUBLIC_EXAMPLE_KEY = "glideworth_devlocal_0123456789abcdef0123456789abcdef";
/** Every example key ever published (the pre-rename one included): all refused in production. */
export const PUBLIC_EXAMPLE_KEYS: readonly string[] = [
  PUBLIC_EXAMPLE_KEY,
  "cairn_devlocal_0123456789abcdef0123456789abcdef",
];

/**
 * Insert the bootstrap key when the key table is empty (single-user self-hosted default). In production the
 * public example key is refused: copying .env.example must not publish a write key. Returns what happened.
 */
export function ensureBootstrapKey(
  db: Db,
  key: string | undefined,
  opts: { production?: boolean } = {},
): "inserted" | "skipped" | "refused-example-key" {
  if (!key) return "skipped";
  if (opts.production && PUBLIC_EXAMPLE_KEYS.includes(key)) return "refused-example-key";
  const any = db.select({ id: apiKeys.id }).from(apiKeys).limit(1).get();
  if (any) return "skipped";
  insertKey(db, key, "bootstrap", ["read", "write"]);
  return "inserted";
}

export type AuthEnv = {
  Variables: {
    principal: Principal;
    need?: Requirement;
    /** The request's services (one instance in self-host, the workspace's own in cloud). */
    services: import("./services.js").Services;
    /**
     * Cloud: keep the workspace open beyond the request (a streaming response); call the returned function
     * when the stream ends. Absent in self-host.
     */
    holdLease?: () => () => void;
  };
};

export interface AuthMiddlewareOptions {
  /** Enables cookie sessions (browser). Without it only API keys authenticate. */
  sessions?: AuthService | undefined;
  /** Extra origin allowed to make cookie-authenticated writes (the dev web origin). */
  webOrigin?: string | undefined;
  /** Accepts OAuth access tokens (remote MCP clients) in addition to API keys. */
  oauth?: ((token: string, c: Context) => Principal | null) | undefined;
  /** Where a 401 points OAuth clients (RFC 9728 `resource_metadata` in `WWW-Authenticate`). */
  resourceMetadataUrl?: ((c: Context) => string) | undefined;
}

const hostOf = (v: string | undefined): string | null => {
  if (!v) return null;
  try {
    return new URL(v).host;
  } catch {
    return null;
  }
};

/**
 * CSRF protection for cookie-authenticated writes. SameSite=Strict already keeps the cookie off
 * cross-site requests; on top of that a write must (1) come from this host when it carries an Origin
 * header and (2) echo the session's CSRF token in `X-CSRF-Token`. API-key requests are exempt:
 * a bearer token is not sent automatically by browsers.
 */
export function assertCsrf(c: Context, csrf: string, webOrigin?: string): void {
  const origin = c.req.header("origin");
  if (origin) {
    const allowed = new Set(
      [
        c.req.header("host"),
        c.req.header("x-forwarded-host")?.split(",")[0]?.trim(),
        hostOf(webOrigin),
      ].filter((h): h is string => !!h),
    );
    const host = hostOf(origin);
    if (!host || !allowed.has(host))
      throw new ApiError(403, "CSRF", "cross-origin write rejected", { origin });
  }
  const given = c.req.header(CSRF_HEADER) ?? "";
  const a = Buffer.from(given);
  const b = Buffer.from(csrf);
  if (!given || a.length !== b.length || !timingSafeEqual(a, b))
    throw new ApiError(
      403,
      "CSRF",
      `missing or invalid ${CSRF_HEADER} header (use the csrfToken from /api/v1/auth/status)`,
    );
}

/**
 * Authenticates the caller: a bearer API key first, else (when sessions are enabled) the session
 * cookie. Scope is enforced per route by `requireScope`.
 */
export function authMiddleware(
  db: Db,
  opts: AuthMiddlewareOptions = {},
): MiddlewareHandler<AuthEnv> {
  const unauthorized = (c: Context, message: string, invalidToken = false): never => {
    // RFC 6750 / RFC 9728 / MCP authorization: tell OAuth clients where the protected resource metadata is
    // and which scopes the endpoint needs.
    c.header(
      "WWW-Authenticate",
      opts.resourceMetadataUrl
        ? `Bearer realm="glideworth"${invalidToken ? ', error="invalid_token"' : ""}, resource_metadata="${opts.resourceMetadataUrl(c)}", scope="read simulate"`
        : 'Bearer realm="glideworth"',
    );
    throw new ApiError(401, "UNAUTHORIZED", message);
  };
  return async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (token) {
      // API keys look like glideworth_<8>_<secret> (or the older cairn_<8>_<secret>); anything else may be an OAuth access token.
      const principal = isSelfhostKey(token)
        ? verifyKey(db, token)
        : (opts.oauth?.(token, c) ?? null);
      if (!principal)
        return unauthorized(
          c,
          "missing or invalid API key or access token (Authorization: Bearer ...)",
          true,
        );
      c.set("principal", { ...principal, via: principal.via ?? "key" });
      return next();
    }
    const session = opts.sessions?.resolve(sessionToken(c));
    if (session) {
      const user = loadUser(db, session.userId);
      if (user) {
        if (!SAFE_METHODS.has(c.req.method)) assertCsrf(c, session.csrf, opts.webOrigin);
        c.set("principal", {
          keyId: `session_${session.id.slice(0, 12)}`,
          name: "web session",
          scopes: ROLE_SCOPES[user.role],
          via: "session",
          userId: user.id,
          userName: user.name,
          role: user.role,
        });
        return next();
      }
    }
    return unauthorized(
      c,
      opts.sessions
        ? "not signed in: log in (POST /api/v1/auth/login) or send Authorization: Bearer glideworth_..."
        : "missing or invalid API key (Authorization: Bearer glideworth_...)",
    );
  };
}

/**
 * The refusal for a principal whose scopes were capped by entitlement (cloud): 402 `ACCOUNT_READ_ONLY` with
 * `{ reason, billingUrl }`, or 403 `ACCOUNT_SUSPENDED`. Null when the cap is not why `need` is missing.
 */
function entitlementRefusal(p: Principal, need: Requirement): ApiError | null {
  if (p.limitedBy !== "entitlement" || !p.entitlement) return null;
  if (!allows(p.uncappedScopes ?? [], need)) return null; // the role alone refuses it
  return p.entitlement.level === "suspended"
    ? new ApiError(403, "ACCOUNT_SUSPENDED", "this workspace is suspended", {
        reason: p.entitlement.reason,
      })
    : new ApiError(
        402,
        "ACCOUNT_READ_ONLY",
        "the workspace is read-only; the owner can subscribe in billing settings",
        { reason: p.entitlement.reason, billingUrl: p.entitlement.billingUrl },
      );
}

export interface ScopeOptions {
  /**
   * Cloud: still allowed while the workspace is read-only (not suspended), because the action only reduces
   * exposure (revoking a key, a grant, a share link or a webhook; marking notifications read). Spec 4.4.
   */
  allowWhenReadOnly?: boolean;
}

/** Route-level scope check. Every operation declares its requirement (see routes/helpers.ts). */
export function requireScope(
  need: Requirement,
  opts: ScopeOptions = {},
): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    c.set("need", need);
    const p = c.get("principal");
    if (!allows(p.scopes, need)) {
      const refusal = entitlementRefusal(p, need);
      if (refusal) {
        if (
          opts.allowWhenReadOnly &&
          p.entitlement?.level === "read_only" &&
          allows(p.uncappedScopes ?? [], need)
        )
          return next();
        throw refusal;
      }
      throw new ApiError(
        403,
        "FORBIDDEN",
        p.role === "viewer" && need === "write"
          ? "viewers are read-only: ask the owner for the editor role"
          : `API key lacks the '${need}' scope`,
        { required: need, role: p.role },
      );
    }
    await next();
  };
}

/** Owner-only operations (users, webhooks, audit log, OAuth client administration). */
export function requireOwner(): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    if (c.get("principal").role !== "owner")
      throw new ApiError(403, "FORBIDDEN", "this operation is for the household owner", {
        required: "owner",
        role: c.get("principal").role,
      });
    await next();
  };
}
