/**
 * OpenID Connect relying party for one provider (Google), on `fetch` and `node:crypto`: discovery, the
 * authorization URL (code flow, PKCE S256, `state`, `nonce`), the code exchange, and ID token validation.
 *
 * Protocol facts used here, from Google's documentation (read 2026-11-16):
 * - discovery at `<issuer>/.well-known/openid-configuration`; `jwks_uri`, `authorization_endpoint`,
 *   `token_endpoint` come from it; ID tokens are signed RS256; PKCE methods `plain` and `S256` are listed;
 * - `iss` is `https://accounts.google.com` or `accounts.google.com`; `aud` is our client id; `azp` is the
 *   authorized presenter; `sub` is the stable identifier ("never reused", "never changed"), `email` may change
 *   and must not be used as an identifier; `email_verified` says whether Google verified the address;
 * - "Google changes its public keys only infrequently": cache them per the response's cache directives.
 *
 * Validation is complete even though the token arrives straight from the token endpoint over TLS (which
 * already authenticates Google): signature and algorithm allow-list (jws.ts), issuer, audience, `azp`,
 * expiry and issue time with 60 s skew, nonce (constant time), subject shape, and `email_verified === true`.
 * Nothing from the provider's response is logged; only a fixed failure reason.
 *
 * Nothing is kept from the token response except the ID token, which is validated and then dropped by the
 * caller. Access and refresh tokens are never read (no `access_type=offline`, so no refresh token is issued).
 */
import { createHash } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { safeEqual } from "../crypto/random.js";
import { type Logger, silentLogger } from "../log/index.js";
import { decodeJws, headerProblem, type Jwk, rsaKeyFromJwk, verifyRs256 } from "./jws.js";

const SCOPES = "openid email profile";
const CLOCK_SKEW_S = 60;
/** An ID token from the token endpoint is minted at that moment; anything older is not this exchange's. */
const MAX_TOKEN_AGE_S = 10 * 60;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_BODY = 256 * 1024;
const DISCOVERY_TTL_MS = 60 * 60 * 1000;
const JWKS_TTL = { min: 5 * 60 * 1000, max: 24 * 60 * 60 * 1000, fallback: 60 * 60 * 1000 };
/** At most one JWK set refresh per this interval on an unknown `kid` (forged tokens cannot make us hammer). */
export const JWKS_REFRESH_COOLDOWN_MS = 30 * 1000;

export type OidcFailure =
  | "discovery"
  | "jwks"
  | "exchange"
  | "malformed"
  | "alg"
  | "kid"
  | "header"
  | "signature"
  | "iss"
  | "aud"
  | "azp"
  | "exp"
  | "iat"
  | "nbf"
  | "nonce"
  | "sub"
  | "email"
  | "email_unverified";

/** A fixed reason, never provider text. */
export class OidcError extends Error {
  constructor(readonly reason: OidcFailure) {
    super(`openid connect: ${reason}`);
    this.name = "OidcError";
  }
}

export interface OidcClientOptions {
  /** Discovery base, e.g. `https://accounts.google.com`. */
  issuer: string;
  /** `iss` values accepted in ID tokens (Google documents two forms). */
  acceptedIssuers: readonly string[];
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  fetch?: typeof fetch;
  now?: () => Date;
  log?: Logger;
}

export interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

/** What the rest of the code may know about the person. Name is optional and free text. */
export interface VerifiedClaims {
  subject: string;
  /** As asserted (trimmed), and its normalised form is computed by the caller. */
  email: string;
  name: string | null;
}

/** PKCE (RFC 7636): S256 of a 43-character base64url verifier. */
export const pkceChallenge = (verifier: string): string =>
  createHash("sha256").update(verifier, "ascii").digest("base64url");

const isHttpsUrl = (v: unknown, allowLoopbackHttp: boolean): v is string => {
  if (typeof v !== "string") return false;
  try {
    const u = new URL(v);
    if (u.username || u.password || u.hash) return false;
    if (u.protocol === "https:") return true;
    return (
      allowLoopbackHttp &&
      u.protocol === "http:" &&
      /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname)
    );
  } catch {
    return false;
  }
};

function maxAgeMs(cacheControl: string | null): number {
  const m = /(?:^|,)\s*max-age=(\d{1,9})\s*(?:,|$)/i.exec(cacheControl ?? "");
  if (!m) return JWKS_TTL.fallback;
  return Math.min(JWKS_TTL.max, Math.max(JWKS_TTL.min, Number(m[1]) * 1000));
}

export class OidcClient {
  private readonly fetchImpl: typeof fetch;
  private readonly clock: () => Date;
  private readonly log: Logger;
  private readonly loopbackOk: boolean;
  private discovery: { doc: Discovery; expires: number } | null = null;
  private jwks: { keys: Map<string, KeyObject>; expires: number; fetchedAt: number } | null = null;

  constructor(private readonly o: OidcClientOptions) {
    this.fetchImpl = o.fetch ?? fetch;
    this.clock = o.now ?? (() => new Date());
    this.log = o.log ?? silentLogger;
    // A local fake provider over http is allowed only when the configured issuer itself is one (never Google).
    this.loopbackOk = o.issuer.startsWith("http://");
  }

  get clientId(): string {
    return this.o.clientId;
  }

  // ------------------------------------------------------------------------------------- discovery
  async metadata(): Promise<Discovery> {
    const now = this.clock().getTime();
    if (this.discovery && this.discovery.expires > now) return this.discovery.doc;
    const res = await this.get(`${this.o.issuer}/.well-known/openid-configuration`, "discovery");
    const d = (await this.json(res, "discovery")) as Record<string, unknown>;
    const algs = d.id_token_signing_alg_values_supported;
    const pkce = d.code_challenge_methods_supported;
    if (
      d.issuer !== this.o.issuer ||
      !isHttpsUrl(d.authorization_endpoint, this.loopbackOk) ||
      !isHttpsUrl(d.token_endpoint, this.loopbackOk) ||
      !isHttpsUrl(d.jwks_uri, this.loopbackOk) ||
      (algs !== undefined && !(Array.isArray(algs) && algs.includes("RS256"))) ||
      (pkce !== undefined && !(Array.isArray(pkce) && pkce.includes("S256")))
    )
      throw this.fail("discovery");
    const doc: Discovery = {
      issuer: d.issuer,
      authorization_endpoint: d.authorization_endpoint,
      token_endpoint: d.token_endpoint,
      jwks_uri: d.jwks_uri,
    };
    this.discovery = { doc, expires: now + DISCOVERY_TTL_MS };
    return doc;
  }

  // -------------------------------------------------------------------------------- authorization
  /**
   * The provider's authorization URL. `prompt=select_account` so a browser with several Google accounts
   * chooses deliberately; no `access_type=offline` (no refresh token), no `include_granted_scopes`.
   */
  async authorizationUrl(i: { state: string; nonce: string; verifier: string }): Promise<string> {
    const md = await this.metadata();
    const u = new URL(md.authorization_endpoint);
    const q = u.searchParams;
    q.set("response_type", "code");
    q.set("client_id", this.o.clientId);
    q.set("redirect_uri", this.o.redirectUri);
    q.set("scope", SCOPES);
    q.set("state", i.state);
    q.set("nonce", i.nonce);
    q.set("code_challenge", pkceChallenge(i.verifier));
    q.set("code_challenge_method", "S256");
    q.set("prompt", "select_account");
    return u.toString();
  }

  // -------------------------------------------------------------------------------------- exchange
  /** Exchange the code (with the PKCE verifier and the fixed redirect URI) and return only the ID token. */
  async exchangeCode(code: string, verifier: string): Promise<string> {
    const md = await this.metadata();
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: this.o.redirectUri,
      client_id: this.o.clientId,
      client_secret: this.o.clientSecret,
      code_verifier: verifier,
    });
    let res: Response;
    try {
      res = await this.fetchImpl(md.token_endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
        },
        body: body.toString(),
        redirect: "error",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch {
      throw this.fail("exchange");
    }
    if (!res.ok) {
      // invalid_grant (reused, expired or PKCE mismatch) and every other refusal: one fixed reason.
      await res.body?.cancel().catch(() => undefined);
      throw this.fail("exchange", res.status);
    }
    const j = (await this.json(res, "exchange")) as { id_token?: unknown };
    if (typeof j.id_token !== "string") throw this.fail("exchange");
    return j.id_token;
  }

  // ------------------------------------------------------------------------------------ validation
  async verifyIdToken(idToken: string, expectedNonce: string): Promise<VerifiedClaims> {
    const d = decodeJws(idToken);
    if (!d) throw this.fail("malformed");
    const hp = headerProblem(d.header);
    if (hp) throw this.fail(hp);
    const key = await this.key(d.header.kid as string);
    if (!key) throw this.fail("kid");
    if (!verifyRs256(d, key)) throw this.fail("signature");

    const c = d.payload;
    const now = Math.floor(this.clock().getTime() / 1000);
    if (typeof c.iss !== "string" || !this.o.acceptedIssuers.includes(c.iss))
      throw this.fail("iss");
    const aud = c.aud;
    const audOk =
      aud === this.o.clientId ||
      (Array.isArray(aud) &&
        aud.length > 0 &&
        aud.every((a) => typeof a === "string") &&
        aud.includes(this.o.clientId));
    if (!audOk) throw this.fail("aud");
    // Several audiences: the presenter must be us. One audience: a present azp must be us too.
    if (Array.isArray(aud) && aud.length > 1 && c.azp !== this.o.clientId) throw this.fail("azp");
    if (c.azp !== undefined && c.azp !== this.o.clientId) throw this.fail("azp");
    if (typeof c.exp !== "number" || !Number.isFinite(c.exp) || now >= c.exp + CLOCK_SKEW_S)
      throw this.fail("exp");
    if (
      typeof c.iat !== "number" ||
      !Number.isFinite(c.iat) ||
      c.iat > now + CLOCK_SKEW_S ||
      c.iat < now - MAX_TOKEN_AGE_S - CLOCK_SKEW_S
    )
      throw this.fail("iat");
    if (c.nbf !== undefined && (typeof c.nbf !== "number" || c.nbf > now + CLOCK_SKEW_S))
      throw this.fail("nbf");
    if (typeof c.nonce !== "string" || !safeEqual(c.nonce, expectedNonce)) throw this.fail("nonce");
    // Printable ASCII, at most 255 characters (OpenID Connect Core 2: "MUST NOT exceed 255 ASCII characters").
    if (typeof c.sub !== "string" || !/^[\x21-\x7e]{1,255}$/.test(c.sub)) throw this.fail("sub");
    if (c.email_verified !== true) throw this.fail("email_unverified");
    if (typeof c.email !== "string" || c.email.length < 3 || c.email.length > 320)
      throw this.fail("email");
    const name = typeof c.name === "string" ? c.name : null;
    return { subject: c.sub, email: c.email.trim(), name };
  }

  // --------------------------------------------------------------------------------------- the JWKS
  /** The key for `kid`, refreshing the set once (rate-limited) when the id is unknown or the cache expired. */
  private async key(kid: string): Promise<KeyObject | null> {
    const now = this.clock().getTime();
    if (!this.jwks || this.jwks.expires <= now) await this.loadJwks();
    let k = this.jwks?.keys.get(kid) ?? null;
    if (!k && this.jwks && now - this.jwks.fetchedAt >= JWKS_REFRESH_COOLDOWN_MS) {
      await this.loadJwks();
      k = this.jwks?.keys.get(kid) ?? null;
    }
    return k;
  }

  private async loadJwks(): Promise<void> {
    const md = await this.metadata();
    const res = await this.get(md.jwks_uri, "jwks");
    const body = (await this.json(res, "jwks")) as { keys?: unknown };
    if (!Array.isArray(body.keys)) throw this.fail("jwks");
    const keys = new Map<string, KeyObject>();
    for (const raw of body.keys.slice(0, 50)) {
      const jwk = (raw ?? {}) as Jwk;
      if (typeof jwk.kid !== "string" || keys.has(jwk.kid)) continue;
      const key = rsaKeyFromJwk(jwk);
      if (key) keys.set(jwk.kid, key);
    }
    const now = this.clock().getTime();
    this.jwks = {
      keys,
      fetchedAt: now,
      expires: now + maxAgeMs(res.headers.get("cache-control")),
    };
  }

  // ------------------------------------------------------------------------------------ plumbing
  private async get(url: string, reason: OidcFailure): Promise<Response> {
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        headers: { accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch {
      throw this.fail(reason);
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw this.fail(reason, res.status);
    }
    return res;
  }

  private async json(res: Response, reason: OidcFailure): Promise<unknown> {
    let text: string;
    try {
      text = await res.text();
    } catch {
      throw this.fail(reason);
    }
    if (text.length > MAX_BODY) throw this.fail(reason);
    try {
      const v: unknown = JSON.parse(text);
      if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error("shape");
      return v;
    } catch {
      throw this.fail(reason);
    }
  }

  private fail(reason: OidcFailure, statusCode?: number): OidcError {
    this.log.warn("oidc.failed", { provider: "google", reason, statusCode });
    return new OidcError(reason);
  }
}
