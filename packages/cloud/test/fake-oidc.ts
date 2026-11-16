/**
 * An OpenID provider in-process, shaped like Google's: a discovery document, a JWK set, an authorization
 * endpoint (driven by the test, standing in for the person at Google) and a token endpoint that checks the
 * client secret, the redirect URI, single-use codes and PKCE S256 exactly as a real provider must. ID tokens are
 * RS256-signed with a test key; tests can rotate keys and tamper with the next token. No network.
 */
import {
  createHash,
  createHmac,
  generateKeyPairSync,
  type KeyObject,
  randomBytes,
} from "node:crypto";
import { sign as cryptoSign } from "node:crypto";
import { remember } from "./helpers.js";
import { PUBLIC_URL } from "./cloud-fixture.js";

export interface FakeUser {
  sub: string;
  email: string;
  /** Default true. `"absent"` leaves the claim out. */
  emailVerified?: boolean | string | "absent";
  name?: string;
}

interface Key {
  kid: string;
  privateKey: KeyObject;
  jwk: Record<string, unknown>;
}

interface IssuedCode {
  clientId: string;
  redirectUri: string;
  challenge: string;
  method: string;
  nonce: string;
  user: FakeUser;
  used: boolean;
}

export type Tamper = (t: {
  header: Record<string, unknown>;
  claims: Record<string, unknown>;
}) => { header?: Record<string, unknown>; claims?: Record<string, unknown>; token?: string } | void;

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");

export function rsaKey(bits = 2048): Key {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: bits });
  const kid = randomBytes(8).toString("hex");
  return {
    kid,
    privateKey,
    jwk: { ...publicKey.export({ format: "jwk" }), kid, use: "sig", alg: "RS256" },
  };
}

export class FakeOidcProvider {
  readonly issuer: string;
  readonly clientId = "glideworth-test.apps.googleusercontent.com";
  readonly clientSecret = remember("GOCSPX-test-client-secret-value");
  readonly redirectUri = `${PUBLIC_URL}/api/v1/auth/google/callback`;
  /** The `iss` claim written into tokens (Google: `https://accounts.google.com` or `accounts.google.com`). */
  tokenIssuer: string;
  keys: Key[];
  activeKid: string;
  jwksCacheControl = "public, max-age=3600";
  /** Applied to the next issued ID token only. */
  tamperNext: Tamper | null = null;
  /** Every request the client made, by URL (proves where traffic went). */
  readonly requests: string[] = [];
  /** Every ID token and access token handed out (log-leak checks). */
  readonly issued: string[] = [];
  private readonly codes = new Map<string, IssuedCode>();

  constructor(
    readonly now: () => Date = () => new Date(),
    issuer = "https://oidc.fake-google.test",
  ) {
    this.issuer = issuer;
    this.tokenIssuer = issuer;
    const k = rsaKey();
    this.keys = [k];
    this.activeKid = k.kid;
  }

  get endpoints() {
    return {
      authorization: `${this.issuer}/o/oauth2/v2/auth`,
      token: `${this.issuer}/token`,
      jwks: `${this.issuer}/oauth2/v3/certs`,
    };
  }

  discovery(): Record<string, unknown> {
    return {
      issuer: this.issuer,
      authorization_endpoint: this.endpoints.authorization,
      token_endpoint: this.endpoints.token,
      jwks_uri: this.endpoints.jwks,
      response_types_supported: ["code"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["RS256"],
      scopes_supported: ["openid", "email", "profile"],
      code_challenge_methods_supported: ["plain", "S256"],
      token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
    };
  }

  /** A new signing key; the old one stays published unless `dropOld`. */
  rotate(dropOld = false): void {
    const k = rsaKey();
    this.keys = dropOld ? [k] : [...this.keys, k];
    this.activeKid = k.kid;
  }

  // ------------------------------------------------------------------------------------ the "browser"
  /**
   * The person at Google: checks the authorization request as Google would and answers with the redirect
   * back to the client (path and query relative to the public URL), or an error redirect.
   */
  authorize(authUrl: string, user: FakeUser, o: { deny?: boolean } = {}): string {
    const u = new URL(authUrl);
    if (`${u.origin}${u.pathname}` !== this.endpoints.authorization)
      throw new Error("not this provider's authorization endpoint");
    const q = u.searchParams;
    if (q.get("client_id") !== this.clientId) throw new Error("unknown client");
    // Exact match, as Google requires (scheme, case, trailing slash).
    if (q.get("redirect_uri") !== this.redirectUri) throw new Error("redirect_uri_mismatch");
    if (q.get("response_type") !== "code") throw new Error("unsupported response_type");
    if (q.get("scope") !== "openid email profile") throw new Error("unexpected scope");
    if (q.get("code_challenge_method") !== "S256" || !q.get("code_challenge"))
      throw new Error("PKCE S256 required");
    if (!q.get("state") || !q.get("nonce")) throw new Error("state and nonce required");
    const back = new URL(this.redirectUri);
    back.searchParams.set("state", q.get("state") as string);
    if (o.deny) back.searchParams.set("error", "access_denied");
    else {
      const code = remember(`4/0A${randomBytes(24).toString("base64url")}`);
      this.codes.set(code, {
        clientId: this.clientId,
        redirectUri: q.get("redirect_uri") as string,
        challenge: q.get("code_challenge") as string,
        method: "S256",
        nonce: q.get("nonce") as string,
        user,
        used: false,
      });
      back.searchParams.set("code", code);
    }
    return `${back.pathname}${back.search}`;
  }

  // ------------------------------------------------------------------------------------ the server
  readonly fetch: typeof fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    this.requests.push(url);
    const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json", ...headers },
      });
    if (url === `${this.issuer}/.well-known/openid-configuration`) return json(this.discovery());
    if (url === this.endpoints.jwks)
      return json({ keys: this.keys.map((k) => k.jwk) }, 200, {
        "cache-control": this.jwksCacheControl,
      });
    if (url === this.endpoints.token && (init?.method ?? "GET").toUpperCase() === "POST") {
      const f = new URLSearchParams(String(init?.body ?? ""));
      const bad = (error: string) => json({ error }, 400);
      if (f.get("grant_type") !== "authorization_code") return bad("unsupported_grant_type");
      if (f.get("client_id") !== this.clientId || f.get("client_secret") !== this.clientSecret)
        return json({ error: "invalid_client" }, 401);
      const code = this.codes.get(f.get("code") ?? "");
      if (!code) return bad("invalid_grant");
      if (code.used) return bad("invalid_grant"); // authorization codes are single use
      code.used = true;
      if (f.get("redirect_uri") !== code.redirectUri) return bad("invalid_grant");
      const verifier = f.get("code_verifier") ?? "";
      const s256 = createHash("sha256").update(verifier).digest("base64url");
      if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || s256 !== code.challenge)
        return bad("invalid_grant");
      const idToken = this.idToken(code.user, code.nonce);
      const accessToken = remember(`ya29.${randomBytes(30).toString("base64url")}`);
      this.issued.push(idToken, accessToken);
      return json({
        access_token: accessToken,
        expires_in: 3599,
        id_token: idToken,
        scope: "openid email profile",
        token_type: "Bearer",
      });
    }
    return json({ error: "not_found" }, 404);
  };

  /** Sign an ID token for `user` (with the next-token tamper applied). */
  idToken(user: FakeUser, nonce: string, over: Record<string, unknown> = {}): string {
    const iat = Math.floor(this.now().getTime() / 1000);
    let claims: Record<string, unknown> = {
      iss: this.tokenIssuer,
      azp: this.clientId,
      aud: this.clientId,
      sub: user.sub,
      email: user.email,
      ...(user.emailVerified === "absent" ? {} : { email_verified: user.emailVerified ?? true }),
      at_hash: randomBytes(16).toString("base64url"),
      nonce,
      name: user.name ?? "Taylor Example",
      picture: "https://lh3.googleusercontent.com/a/fake-picture",
      given_name: "Taylor",
      family_name: "Example",
      iat,
      exp: iat + 3600,
      ...over,
    };
    let header: Record<string, unknown> = { alg: "RS256", kid: this.activeKid, typ: "JWT" };
    const t = this.tamperNext;
    this.tamperNext = null;
    if (t) {
      const r = t({ header, claims });
      if (r?.token) return remember(r.token);
      if (r?.header) header = r.header;
      if (r?.claims) claims = r.claims;
    }
    return remember(this.signWith(header, claims));
  }

  /** RS256 with the key named by `header.kid` (or the active key); HS256 with `hmacSecret`; none unsigned. */
  signWith(
    header: Record<string, unknown>,
    claims: Record<string, unknown>,
    o: { key?: KeyObject; hmacSecret?: Buffer } = {},
  ): string {
    const input = `${b64(header)}.${b64(claims)}`;
    if (header.alg === "none") return `${input}.`;
    if (header.alg === "HS256")
      return `${input}.${createHmac("sha256", o.hmacSecret ?? Buffer.alloc(32))
        .update(input)
        .digest("base64url")}`;
    const key =
      o.key ?? this.keys.find((k) => k.kid === header.kid)?.privateKey ?? this.keys[0]?.privateKey;
    return `${input}.${cryptoSign("RSA-SHA256", Buffer.from(input), key as KeyObject).toString("base64url")}`;
  }

  /** The active public key as PEM (algorithm-confusion attempts use it as an HMAC secret). */
  publicPem(): Buffer {
    const jwk = this.keys.find((k) => k.kid === this.activeKid)?.jwk as Record<string, unknown>;
    return Buffer.from(JSON.stringify(jwk));
  }
}

let subSeq = 0;
/** A Google-like user: numeric `sub`, and an address that tests remember (log-leak checks). */
export function googleUser(o: Partial<FakeUser> = {}): FakeUser {
  const sub = remember(
    o.sub ?? `1${String(Date.now()).slice(-9)}${String(++subSeq).padStart(10, "0")}`,
  );
  const email = remember(o.email ?? `g.${subSeq}.${randomBytes(3).toString("hex")}@gmail.com`);
  return { ...o, sub, email, name: remember(o.name ?? `Gwen Googler ${subSeq}`) };
}
