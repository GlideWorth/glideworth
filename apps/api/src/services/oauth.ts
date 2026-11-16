/**
 * OAuth 2.1 authorization server for remote MCP clients (MCP authorization spec, 2026-07-28 revision;
 * compatible with the 2025-06-18 flow the official SDK client implements).
 *
 *  - public clients only (token_endpoint_auth_method "none"), registered with RFC 7591 dynamic client registration
 *  - authorization code + PKCE (S256 only, required), exact redirect URI match, https or loopback http only
 *  - RFC 8707 `resource`: tokens are bound to the MCP endpoint (`<origin>/mcp`) and accepted nowhere else
 *  - short-lived access tokens (1 h), rotating refresh tokens (30 d) with replay detection
 *  - scopes read / simulate / write, capped by the role of the user who consented
 *  - tokens, codes and refresh tokens are stored as sha256 only
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, asc, count, desc, eq, isNull, lt } from "drizzle-orm";
import { capScopes, loadUser, type Principal, SCOPES, type Scope } from "../auth.js";
import { oauthClients, oauthCodes, oauthTokens } from "../db/schema.js";
import { notFound } from "../errors.js";
import { WindowCounter } from "../middleware.js";
import { nowIso, sha256 } from "../util.js";
import type { ServiceCtx } from "./context.js";

export const ACCESS_TTL_MS = 3600 * 1000;
export const REFRESH_TTL_MS = 30 * 24 * 3600 * 1000;
export const CODE_TTL_MS = 5 * 60 * 1000;
const MAX_CLIENTS = 500;
/** Self-host: dynamic registrations accepted per client address per 24 hours. */
export const REGISTRATIONS_PER_IP_PER_DAY = 50;
/** Self-host: a client nobody has consented to is removed after this long. */
export const UNUSED_CLIENT_TTL_MS = 24 * 3600 * 1000;
const CONSUMED = "1970-01-01T00:00:00.000Z";
/** New access tokens carry the first prefix; tokens issued before the rename (`cairn_oat_`) stay valid until they expire. */
export const ACCESS_TOKEN_PREFIX = "glideworth_oat_";
const ACCESS_TOKEN_PREFIXES = [ACCESS_TOKEN_PREFIX, "cairn_oat_"];

export class OAuthError extends Error {
  constructor(
    readonly error: string,
    readonly description: string,
    readonly status = 400,
  ) {
    super(description);
  }
}

export interface OAuthClient {
  id: string;
  name: string;
  redirectUris: string[];
  scope: string | null;
  createdAt: string;
  lastUsedAt: string | null;
}

const loopback = (h: string) =>
  h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1";

/** https, or http on a loopback host; no fragment; no credentials. Anything else is refused (open redirect). */
export function redirectUriProblem(uri: string): string | null {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return "not an absolute URI";
  }
  if (u.hash) return "must not contain a fragment";
  if (u.username || u.password) return "must not contain credentials";
  if (u.protocol === "https:") return null;
  if (u.protocol === "http:" && loopback(u.hostname)) return null;
  return "must use https (or http on localhost)";
}

export const parseScopes = (s: string | undefined | null): string[] => [
  ...new Set((s ?? "").split(/\s+/).filter(Boolean)),
];

const b64u = (b: Buffer) => b.toString("base64url");
const S256 = (verifier: string) => b64u(createHash("sha256").update(verifier).digest());
const safeEq = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export interface TokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
}

/** Where dynamically registered clients live (cloud: the control plane, before anyone signs in). */
export interface ClientStore {
  /** Insert a validated client registered from `ip`, or throw (rate limits, ceilings). */
  register(
    c: { id: string; name: string; redirectUris: string[]; scope: string | null },
    ip: string,
  ): void;
  get(id: string): OAuthClient | null;
  /** At consent: the client is in use (never purged). */
  markConsented(id: string): void;
}

/** How tokens look (cloud: routed `gwa_`/`gwr_`/`gwc_` with the workspace id inside). */
export interface TokenFormat {
  access(): string;
  refresh(): string;
  code(): string;
  isAccess(token: string): boolean;
}

export const SELFHOST_TOKEN_FORMAT: TokenFormat = {
  access: () => `${ACCESS_TOKEN_PREFIX}${b64u(randomBytes(32))}`,
  refresh: () => `glideworth_ort_${b64u(randomBytes(32))}`,
  code: () => b64u(randomBytes(32)),
  isAccess: (token) => ACCESS_TOKEN_PREFIXES.some((p) => token.startsWith(p)),
};

export interface OAuthOptions {
  clients?: ClientStore;
  tokens?: TokenFormat;
  now?: () => number;
}

export class OAuthService {
  /** Self-host: registrations per client address in the last 24 hours (bounded, in memory). */
  private readonly registrations: WindowCounter;
  private readonly tokens: TokenFormat;

  constructor(
    private readonly ctx: ServiceCtx,
    private readonly opts: OAuthOptions = {},
  ) {
    this.tokens = opts.tokens ?? SELFHOST_TOKEN_FORMAT;
    this.registrations = new WindowCounter(10_000, opts.now);
  }
  private get db() {
    return this.ctx.db;
  }

  /**
   * Cloud: an instance over the control-plane client registry only, for the endpoints that run before a
   * workspace is known (registration, validating an authorization request). It has no database: anything
   * else on it throws.
   */
  static registryOnly(clients: ClientStore): OAuthService {
    const noDb = {
      get db(): never {
        throw new Error("the client registry has no workspace database");
      },
    };
    return new OAuthService(noDb as unknown as ServiceCtx, { clients });
  }

  // ----------------------------------------------------------------------------- clients (RFC 7591)
  register(
    meta: {
      client_name?: string | undefined;
      redirect_uris: string[];
      token_endpoint_auth_method?: string | undefined;
      grant_types?: string[] | undefined;
      response_types?: string[] | undefined;
      scope?: string | undefined;
    },
    ip = "unknown",
  ) {
    if (!meta.redirect_uris?.length || meta.redirect_uris.length > 10)
      throw new OAuthError("invalid_redirect_uri", "give 1 to 10 redirect_uris");
    for (const u of meta.redirect_uris) {
      const p = redirectUriProblem(u);
      if (p) throw new OAuthError("invalid_redirect_uri", `${u}: ${p}`);
    }
    if (meta.token_endpoint_auth_method && meta.token_endpoint_auth_method !== "none")
      throw new OAuthError(
        "invalid_client_metadata",
        'only public clients are supported: token_endpoint_auth_method must be "none"',
      );
    const bad = (meta.grant_types ?? []).filter(
      (g) => g !== "authorization_code" && g !== "refresh_token",
    );
    if (bad.length)
      throw new OAuthError("invalid_client_metadata", `unsupported grant_types: ${bad.join(", ")}`);
    if ((meta.response_types ?? ["code"]).some((r) => r !== "code"))
      throw new OAuthError("invalid_client_metadata", 'response_types must be ["code"]');
    const scopes = parseScopes(meta.scope);
    const unknown = scopes.filter((s) => !(SCOPES as string[]).includes(s));
    if (unknown.length)
      throw new OAuthError("invalid_client_metadata", `unknown scopes: ${unknown.join(", ")}`);
    const id = `glideworth-client-${randomBytes(12).toString("base64url")}`;
    const name =
      [...(meta.client_name ?? "MCP client")]
        .map((ch) => (ch.charCodeAt(0) < 32 ? " " : ch))
        .join("")
        .slice(0, 80) || "MCP client";
    const row = {
      id,
      name,
      redirectUris: [...new Set(meta.redirect_uris)],
      scope: scopes.join(" ") || null,
    };
    if (this.opts.clients) this.opts.clients.register(row, ip);
    else this.registerLocal(row, ip);
    return {
      client_id: id,
      client_name: name,
      redirect_uris: [...new Set(meta.redirect_uris)],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      ...(scopes.length ? { scope: scopes.join(" ") } : {}),
      client_id_issued_at: Math.floor(Date.now() / 1000),
    };
  }

  /**
   * Unauthenticated registration must not let one address exhaust the table for everyone: a per-address
   * daily limit, clients nobody consented to are removed after 24 hours, and when the table is still full the
   * oldest never-consented client makes room (a client someone consented to is never evicted).
   */
  private registerLocal(
    row: { id: string; name: string; redirectUris: string[]; scope: string | null },
    ip: string,
  ): void {
    if (this.registrations.hit(ip, 24 * 3600_000).count > REGISTRATIONS_PER_IP_PER_DAY)
      throw new OAuthError(
        "temporarily_unavailable",
        "too many client registrations from this address today",
        429,
      );
    const now = this.opts.now?.() ?? Date.now();
    this.db
      .delete(oauthClients)
      .where(
        and(
          isNull(oauthClients.lastUsedAt),
          lt(oauthClients.createdAt, new Date(now - UNUSED_CLIENT_TTL_MS).toISOString()),
        ),
      )
      .run();
    if ((this.db.select({ n: count() }).from(oauthClients).get()?.n ?? 0) >= MAX_CLIENTS) {
      const oldest = this.db
        .select({ id: oauthClients.id })
        .from(oauthClients)
        .where(isNull(oauthClients.lastUsedAt))
        .orderBy(asc(oauthClients.createdAt))
        .limit(1)
        .get();
      if (!oldest)
        throw new OAuthError(
          "temporarily_unavailable",
          "too many registered clients; ask the owner to remove unused ones",
          503,
        );
      this.db.delete(oauthClients).where(eq(oauthClients.id, oldest.id)).run();
    }
    this.db
      .insert(oauthClients)
      .values({ ...row, createdAt: new Date(now).toISOString() })
      .run();
  }

  /** A client as the authorization endpoint sees it (cloud: the control plane's registry). */
  client(id: string): OAuthClient | null {
    if (this.opts.clients) return this.opts.clients.get(id);
    return this.localClient(id);
  }

  /** This database's copy of a client (cloud: made at consent, so codes and tokens can reference it). */
  localClient(id: string): OAuthClient | null {
    const r = this.db.select().from(oauthClients).where(eq(oauthClients.id, id)).get();
    return r
      ? {
          id: r.id,
          name: r.name,
          redirectUris: r.redirectUris,
          scope: r.scope,
          createdAt: r.createdAt,
          lastUsedAt: r.lastUsedAt,
        }
      : null;
  }

  listClients(): (OAuthClient & { activeTokens: number })[] {
    return this.db
      .select()
      .from(oauthClients)
      .orderBy(desc(oauthClients.createdAt))
      .all()
      .map((r) => ({
        id: r.id,
        name: r.name,
        redirectUris: r.redirectUris,
        scope: r.scope,
        createdAt: r.createdAt,
        lastUsedAt: r.lastUsedAt,
        activeTokens:
          this.db
            .select({ n: count() })
            .from(oauthTokens)
            .where(and(eq(oauthTokens.clientId, r.id), isNull(oauthTokens.revokedAt)))
            .get()?.n ?? 0,
      }));
  }

  deleteClient(id: string): void {
    if (!this.localClient(id)) throw notFound("oauth client", id);
    this.db.delete(oauthClients).where(eq(oauthClients.id, id)).run(); // codes and tokens cascade
  }

  /** The signed-in user's active grants (one per client with live tokens). */
  grantsOf(userId: string) {
    return this.db
      .select()
      .from(oauthTokens)
      .where(and(eq(oauthTokens.userId, userId), isNull(oauthTokens.revokedAt)))
      .all()
      .map((t) => ({
        id: t.id,
        clientId: t.clientId,
        clientName: this.localClient(t.clientId)?.name ?? t.clientId,
        scopes: t.scopes,
        createdAt: t.createdAt,
        lastUsedAt: t.lastUsedAt,
        refreshExpiresAt: t.refreshExpiresAt,
      }));
  }

  revokeGrant(userId: string, tokenId: string, owner: boolean): void {
    const row = this.db.select().from(oauthTokens).where(eq(oauthTokens.id, tokenId)).get();
    if (!row || (row.userId !== userId && !owner)) throw notFound("grant", tokenId);
    this.db
      .update(oauthTokens)
      .set({ revokedAt: nowIso() })
      .where(eq(oauthTokens.id, tokenId))
      .run();
  }

  /**
   * Cloud, password reset: every live access and refresh token of a person and their unused authorization
   * codes. Returns the number of grants revoked. API keys and other people's grants are not touched.
   */
  revokeAllOf(userId: string): number {
    return this.db.transaction((tx) => {
      const live = and(eq(oauthTokens.userId, userId), isNull(oauthTokens.revokedAt));
      const n = tx.select({ n: count() }).from(oauthTokens).where(live).get()?.n ?? 0;
      tx.update(oauthTokens).set({ revokedAt: nowIso() }).where(live).run();
      tx.delete(oauthCodes)
        .where(and(eq(oauthCodes.userId, userId), isNull(oauthCodes.usedAt)))
        .run();
      return n;
    });
  }

  // ----------------------------------------------------------------------------- authorization endpoint
  /** Validate an authorization request. Errors before the redirect URI is trusted are `fatal` (shown, never redirected). */
  validateAuthorize(q: Record<string, string | undefined>): {
    client: OAuthClient;
    redirectUri: string;
    scopes: string[];
    state: string | undefined;
    codeChallenge: string;
    resource: string | undefined;
  } {
    const client = q.client_id ? this.client(q.client_id) : null;
    if (!client) throw new OAuthError("invalid_client", "unknown client_id", 400);
    let redirectUri = q.redirect_uri;
    if (!redirectUri && client.redirectUris.length === 1) redirectUri = client.redirectUris[0];
    if (!redirectUri || !client.redirectUris.includes(redirectUri))
      throw new OAuthError(
        "invalid_request",
        "redirect_uri does not match a registered redirect URI",
        400,
      );
    return this.validateRest(client, redirectUri, q);
  }

  private validateRest(
    client: OAuthClient,
    redirectUri: string,
    q: Record<string, string | undefined>,
  ) {
    const fail = (error: string, description: string): never => {
      throw Object.assign(new OAuthError(error, description), {
        redirectable: true,
        redirectUri,
        state: q.state,
      });
    };
    if (q.response_type !== "code")
      fail("unsupported_response_type", 'response_type must be "code"');
    if (!q.code_challenge) fail("invalid_request", "PKCE is required: send code_challenge (S256)");
    if (q.code_challenge_method !== "S256")
      fail("invalid_request", "code_challenge_method must be S256");
    if (!/^[A-Za-z0-9_-]{43}$/.test(q.code_challenge ?? ""))
      fail("invalid_request", "code_challenge must be a base64url SHA-256 (43 characters)");
    const scopes = parseScopes(q.scope ?? client.scope ?? SCOPES.join(" "));
    const unknown = scopes.filter((s) => !(SCOPES as string[]).includes(s));
    if (unknown.length) fail("invalid_scope", `unknown scopes: ${unknown.join(", ")}`);
    if (!scopes.length) fail("invalid_scope", "no scope requested");
    return {
      client,
      redirectUri,
      scopes,
      state: q.state,
      codeChallenge: q.code_challenge as string,
      resource: q.resource,
    };
  }

  /** Issue an authorization code once the signed-in user consented. */
  issueCode(a: {
    clientId: string;
    userId: string;
    redirectUri: string;
    codeChallenge: string;
    scopes: string[];
    resource: string | undefined;
  }): string {
    this.db.delete(oauthCodes).where(lt(oauthCodes.expiresAt, nowIso())).run();
    if (this.opts.clients) {
      // Cloud: copy the client into this workspace at consent so the foreign keys and cascades hold.
      const c = this.opts.clients.get(a.clientId);
      if (!c) throw new OAuthError("invalid_client", "unknown client_id", 400);
      this.db
        .insert(oauthClients)
        .values({ id: c.id, name: c.name, redirectUris: c.redirectUris, scope: c.scope })
        .onConflictDoNothing()
        .run();
      this.opts.clients.markConsented(c.id);
    }
    const code = this.tokens.code();
    this.db
      .insert(oauthCodes)
      .values({
        id: sha256(code),
        clientId: a.clientId,
        userId: a.userId,
        redirectUri: a.redirectUri,
        codeChallenge: a.codeChallenge,
        scopes: a.scopes,
        resource: a.resource ?? null,
        expiresAt: new Date(Date.now() + CODE_TTL_MS).toISOString(),
      })
      .run();
    return code;
  }

  // ----------------------------------------------------------------------------- token endpoint
  private mint(
    clientId: string,
    userId: string,
    scopes: string[],
    resource: string | null,
    reuse?: string,
  ): TokenResponse {
    const access = this.tokens.access();
    const refresh = this.tokens.refresh();
    const now = Date.now();
    const row = {
      accessHash: sha256(access),
      refreshHash: sha256(refresh),
      clientId,
      userId,
      scopes,
      resource,
      accessExpiresAt: new Date(now + ACCESS_TTL_MS).toISOString(),
      refreshExpiresAt: new Date(now + REFRESH_TTL_MS).toISOString(),
    };
    this.db
      .insert(oauthTokens)
      .values({ id: reuse ?? `oat_${b64u(randomBytes(9))}`, ...row })
      .run();
    return {
      access_token: access,
      token_type: "Bearer",
      expires_in: ACCESS_TTL_MS / 1000,
      refresh_token: refresh,
      scope: scopes.join(" "),
    };
  }

  exchangeCode(
    p: {
      code?: string | undefined;
      redirect_uri?: string | undefined;
      client_id?: string | undefined;
      code_verifier?: string | undefined;
      resource?: string | undefined;
    },
    canonicalResource: string,
  ): TokenResponse {
    if (!p.code || !p.client_id || !p.code_verifier)
      throw new OAuthError("invalid_request", "code, client_id and code_verifier are required");
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(p.code_verifier))
      throw new OAuthError("invalid_grant", "invalid code_verifier");
    const row = this.db
      .select()
      .from(oauthCodes)
      .where(eq(oauthCodes.id, sha256(p.code)))
      .get();
    if (!row || row.clientId !== p.client_id)
      throw new OAuthError("invalid_grant", "unknown or expired authorization code");
    // Single use: claim it before anything else, so a replay (and a racing second request) fails.
    const claimed = this.db
      .update(oauthCodes)
      .set({ usedAt: nowIso() })
      .where(and(eq(oauthCodes.id, row.id), isNull(oauthCodes.usedAt)))
      .run();
    if (claimed.changes !== 1) {
      // A replayed code: everything issued from it is revoked (OAuth 2.1 7.5).
      this.db
        .update(oauthTokens)
        .set({ revokedAt: nowIso() })
        .where(and(eq(oauthTokens.clientId, row.clientId), eq(oauthTokens.userId, row.userId)))
        .run();
      throw new OAuthError("invalid_grant", "authorization code already used");
    }
    if (row.expiresAt <= nowIso())
      throw new OAuthError("invalid_grant", "authorization code expired");
    if (p.redirect_uri !== row.redirectUri)
      throw new OAuthError(
        "invalid_grant",
        "redirect_uri does not match the authorization request",
      );
    if (!safeEq(S256(p.code_verifier), row.codeChallenge))
      throw new OAuthError("invalid_grant", "PKCE verification failed");
    const resource = p.resource ?? row.resource ?? canonicalResource;
    if (resource !== canonicalResource || (row.resource && row.resource !== canonicalResource))
      throw new OAuthError("invalid_target", `resource must be ${canonicalResource}`);
    this.db
      .update(oauthClients)
      .set({ lastUsedAt: nowIso() })
      .where(eq(oauthClients.id, row.clientId))
      .run();
    return this.mint(row.clientId, row.userId, row.scopes, canonicalResource);
  }

  refresh(p: {
    refresh_token?: string | undefined;
    client_id?: string | undefined;
    scope?: string | undefined;
  }): TokenResponse {
    if (!p.refresh_token || !p.client_id)
      throw new OAuthError("invalid_request", "refresh_token and client_id are required");
    const row = this.db
      .select()
      .from(oauthTokens)
      .where(eq(oauthTokens.refreshHash, sha256(p.refresh_token)))
      .get();
    if (!row || row.clientId !== p.client_id)
      throw new OAuthError("invalid_grant", "unknown refresh token");
    if (row.revokedAt) {
      // A rotated token being replayed means it leaked: revoke the whole grant.
      if (row.refreshExpiresAt === CONSUMED)
        this.db
          .update(oauthTokens)
          .set({ revokedAt: nowIso() })
          .where(
            and(
              eq(oauthTokens.clientId, row.clientId),
              eq(oauthTokens.userId, row.userId),
              isNull(oauthTokens.revokedAt),
            ),
          )
          .run();
      throw new OAuthError("invalid_grant", "refresh token revoked");
    }
    if (row.refreshExpiresAt <= nowIso())
      throw new OAuthError("invalid_grant", "refresh token expired");
    const user = loadUser(this.db, row.userId);
    if (!user) throw new OAuthError("invalid_grant", "the user can no longer sign in");
    let scopes = row.scopes;
    if (p.scope) {
      const want = parseScopes(p.scope);
      if (want.some((s) => !row.scopes.includes(s)))
        throw new OAuthError("invalid_scope", "cannot widen the granted scopes");
      scopes = want;
    }
    // Rotate: the presented token is consumed (marker), a new pair is issued.
    this.db
      .update(oauthTokens)
      .set({ revokedAt: nowIso(), refreshExpiresAt: CONSUMED })
      .where(eq(oauthTokens.id, row.id))
      .run();
    this.db
      .update(oauthClients)
      .set({ lastUsedAt: nowIso() })
      .where(eq(oauthClients.id, row.clientId))
      .run();
    return this.mint(row.clientId, row.userId, scopes, row.resource);
  }

  /** RFC 7009. Unknown tokens are not an error. */
  revoke(token: string, clientId: string | undefined): void {
    const h = sha256(token);
    const row =
      this.db.select().from(oauthTokens).where(eq(oauthTokens.accessHash, h)).get() ??
      this.db.select().from(oauthTokens).where(eq(oauthTokens.refreshHash, h)).get();
    if (row && (!clientId || row.clientId === clientId))
      this.db
        .update(oauthTokens)
        .set({ revokedAt: nowIso() })
        .where(eq(oauthTokens.id, row.id))
        .run();
  }

  // ----------------------------------------------------------------------------- resource server side
  /** The principal behind an access token, or null. The token must be bound to THIS MCP endpoint (RFC 8707). */
  verifyAccess(token: string, canonicalResource: string): Principal | null {
    if (!this.tokens.isAccess(token)) return null;
    const row = this.db
      .select()
      .from(oauthTokens)
      .where(eq(oauthTokens.accessHash, sha256(token)))
      .get();
    if (!row || row.revokedAt || row.accessExpiresAt <= nowIso()) return null;
    if (row.resource !== canonicalResource) return null;
    const user = loadUser(this.db, row.userId);
    if (!user) return null;
    this.db
      .update(oauthTokens)
      .set({ lastUsedAt: nowIso() })
      .where(eq(oauthTokens.id, row.id))
      .run();
    return {
      keyId: `oauth_${row.id}`,
      name: this.localClient(row.clientId)?.name ?? "MCP client",
      scopes: capScopes(row.scopes as Scope[], user.role),
      via: "oauth",
      userId: user.id,
      userName: user.name,
      role: user.role,
    };
  }
}
