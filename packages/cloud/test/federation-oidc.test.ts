/**
 * "Sign in with Google", protocol layer: discovery, the authorization request, the code exchange and every ID
 * token rule (federation/oidc.ts, federation/jws.ts), against the in-process fake provider. Plus configuration.
 */
import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { GOOGLE_ISSUER, loadCloudConfig } from "../src/config.js";
import { googleIssuers } from "../src/federation/google.js";
import { decodeJws, headerProblem, rsaKeyFromJwk } from "../src/federation/jws.js";
import {
  JWKS_REFRESH_COOLDOWN_MS,
  OidcClient,
  OidcError,
  pkceChallenge,
} from "../src/federation/oidc.js";
import { FakeOidcProvider, type FakeUser, googleUser, rsaKey } from "./fake-oidc.js";
import { logLines } from "./helpers.js";

const clock = { t: Date.parse("2026-11-16T10:00:00.000Z") };
const now = () => new Date(clock.t);
let op: FakeOidcProvider;
let client: OidcClient;
let user: FakeUser;

const makeClient = (o: Partial<ConstructorParameters<typeof OidcClient>[0]> = {}) =>
  new OidcClient({
    issuer: op.issuer,
    acceptedIssuers: [op.issuer],
    clientId: op.clientId,
    clientSecret: op.clientSecret,
    redirectUri: op.redirectUri,
    fetch: op.fetch,
    now,
    ...o,
  });

beforeEach(() => {
  clock.t = Date.parse("2026-11-16T10:00:00.000Z");
  op = new FakeOidcProvider(now);
  client = makeClient();
  user = googleUser();
});

/** A full round: authorization URL, the person consents, the code is exchanged. */
async function roundTrip(u: FakeUser = user) {
  const verifier = randomBytes(32).toString("base64url");
  const nonce = randomBytes(32).toString("base64url");
  const url = await client.authorizationUrl({ state: "s".repeat(43), nonce, verifier });
  const back = new URL(op.authorize(url, u), "https://x.test");
  const code = back.searchParams.get("code") as string;
  return { verifier, nonce, url, code };
}

const reason = async (p: Promise<unknown>) => {
  try {
    await p;
    return "accepted";
  } catch (e) {
    expect(e).toBeInstanceOf(OidcError);
    return (e as OidcError).reason;
  }
};

describe("authorization request", () => {
  it("is the code flow with PKCE S256, state, nonce, the fixed redirect URI and openid email profile only", async () => {
    const verifier = randomBytes(32).toString("base64url");
    const url = new URL(
      await client.authorizationUrl({ state: "state-value", nonce: "nonce-value", verifier }),
    );
    expect(`${url.origin}${url.pathname}`).toBe(op.endpoints.authorization);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: "code",
      client_id: op.clientId,
      redirect_uri: "https://app.example.test/api/v1/auth/google/callback",
      scope: "openid email profile",
      state: "state-value",
      nonce: "nonce-value",
      code_challenge: pkceChallenge(verifier),
      code_challenge_method: "S256",
      prompt: "select_account",
    });
    // No offline access (no refresh token), no incremental scopes.
    expect(url.searchParams.has("access_type")).toBe(false);
    expect(url.searchParams.has("include_granted_scopes")).toBe(false);
  });

  it("caches discovery, and refuses a discovery document for another issuer or without S256", async () => {
    await client.metadata();
    await client.metadata();
    expect(op.requests.filter((r) => r.endsWith("openid-configuration"))).toHaveLength(1);

    const evil = new FakeOidcProvider(now);
    const lying = makeClient({
      fetch: async () =>
        new Response(JSON.stringify({ ...evil.discovery(), issuer: "https://evil.example" }), {
          status: 200,
        }),
    });
    expect(await reason(lying.metadata())).toBe("discovery");
    const noS256 = makeClient({
      fetch: async () =>
        new Response(
          JSON.stringify({ ...op.discovery(), code_challenge_methods_supported: ["plain"] }),
        ),
    });
    expect(await reason(noS256.metadata())).toBe("discovery");
    const httpEndpoints = makeClient({
      fetch: async () =>
        new Response(
          JSON.stringify({ ...op.discovery(), token_endpoint: "http://oidc.fake-google.test/t" }),
        ),
    });
    expect(await reason(httpEndpoints.metadata())).toBe("discovery");
  });
});

describe("code exchange", () => {
  it("returns a valid ID token whose claims map to subject, email and name", async () => {
    const r = await roundTrip();
    const idToken = await client.exchangeCode(r.code, r.verifier);
    const claims = await client.verifyIdToken(idToken, r.nonce);
    expect(claims).toEqual({ subject: user.sub, email: user.email, name: user.name });
  });

  it("PKCE: a different verifier is refused by the provider", async () => {
    const r = await roundTrip();
    expect(await reason(client.exchangeCode(r.code, randomBytes(32).toString("base64url")))).toBe(
      "exchange",
    );
  });

  it("an authorization code works once (replay refused)", async () => {
    const r = await roundTrip();
    await client.exchangeCode(r.code, r.verifier);
    expect(await reason(client.exchangeCode(r.code, r.verifier))).toBe("exchange");
  });

  it("a wrong client secret is refused", async () => {
    const r = await roundTrip();
    const wrong = makeClient({ clientSecret: "GOCSPX-wrong-secret-value" });
    expect(await reason(wrong.exchangeCode(r.code, r.verifier))).toBe("exchange");
  });
});

describe("ID token validation", () => {
  const nonce = "n".repeat(43);
  const token = (over: Record<string, unknown> = {}) => op.idToken(user, nonce, over);

  it("accepts a good token", async () => {
    expect((await client.verifyIdToken(token(), nonce)).subject).toBe(user.sub);
  });

  it("issuer: both forms Google documents are accepted for Google; nothing else", async () => {
    expect(googleIssuers(GOOGLE_ISSUER)).toEqual([
      "https://accounts.google.com",
      "accounts.google.com",
    ]);
    const g = makeClient({ acceptedIssuers: googleIssuers(GOOGLE_ISSUER) });
    for (const iss of ["https://accounts.google.com", "accounts.google.com"])
      expect((await g.verifyIdToken(token({ iss }), nonce)).subject).toBe(user.sub);
    for (const iss of ["https://accounts.google.com/", "https://evil.example", "", undefined])
      expect(await reason(g.verifyIdToken(token({ iss }), nonce))).toBe("iss");
    expect(
      await reason(client.verifyIdToken(token({ iss: "https://accounts.google.com" }), nonce)),
    ).toBe("iss");
  });

  it("audience must be our client id; azp, when present, too", async () => {
    expect(await reason(client.verifyIdToken(token({ aud: "someone-else" }), nonce))).toBe("aud");
    expect(await reason(client.verifyIdToken(token({ aud: undefined }), nonce))).toBe("aud");
    expect(await reason(client.verifyIdToken(token({ aud: [] }), nonce))).toBe("aud");
    expect(await reason(client.verifyIdToken(token({ azp: "someone-else" }), nonce))).toBe("azp");
    // Several audiences: accepted only when we are the authorized presenter.
    expect(
      await reason(
        client.verifyIdToken(token({ aud: [op.clientId, "other"], azp: "other" }), nonce),
      ),
    ).toBe("azp");
    expect(
      (await client.verifyIdToken(token({ aud: [op.clientId, "other"], azp: op.clientId }), nonce))
        .subject,
    ).toBe(user.sub);
    expect((await client.verifyIdToken(token({ azp: undefined }), nonce)).subject).toBe(user.sub);
  });

  it("expiry and issue time, with 60 s of clock skew", async () => {
    const t = Math.floor(clock.t / 1000);
    expect(await reason(client.verifyIdToken(token({ exp: t - 61 }), nonce))).toBe("exp");
    expect((await client.verifyIdToken(token({ exp: t - 30 }), nonce)).subject).toBe(user.sub);
    expect(await reason(client.verifyIdToken(token({ exp: "soon" }), nonce))).toBe("exp");
    expect(await reason(client.verifyIdToken(token({ iat: t + 120 }), nonce))).toBe("iat");
    expect(await reason(client.verifyIdToken(token({ iat: t - 3600 }), nonce))).toBe("iat");
    expect(await reason(client.verifyIdToken(token({ iat: undefined }), nonce))).toBe("iat");
    expect(await reason(client.verifyIdToken(token({ nbf: t + 600 }), nonce))).toBe("nbf");
  });

  it("nonce must match", async () => {
    expect(await reason(client.verifyIdToken(token(), "x".repeat(43)))).toBe("nonce");
    expect(await reason(client.verifyIdToken(token({ nonce: undefined }), nonce))).toBe("nonce");
  });

  it("email_verified must be exactly true; the subject must be present", async () => {
    expect(await reason(client.verifyIdToken(token({ email_verified: null }), nonce))).toBe(
      "email_unverified",
    );
    for (const v of [false, "true", 1, "absent"] as const) {
      const u = { ...user, emailVerified: v as never };
      expect(await reason(client.verifyIdToken(op.idToken(u, nonce), nonce))).toBe(
        "email_unverified",
      );
    }
    expect(await reason(client.verifyIdToken(token({ sub: "" }), nonce))).toBe("sub");
    expect(await reason(client.verifyIdToken(token({ sub: 12345 }), nonce))).toBe("sub");
    expect(await reason(client.verifyIdToken(token({ email: undefined }), nonce))).toBe("email");
  });

  it("forged: signed with another key under the provider's kid", async () => {
    const other = rsaKey();
    const forged = op.signWith(
      { alg: "RS256", kid: op.activeKid },
      { ...decodeJws(token())?.payload, sub: "victim" },
      { key: other.privateKey },
    );
    expect(await reason(client.verifyIdToken(forged, nonce))).toBe("signature");
  });

  it("forged: a valid token with its payload edited", async () => {
    const [h, , s] = token().split(".");
    const p = Buffer.from(
      JSON.stringify({ ...decodeJws(token())?.payload, sub: "victim" }),
    ).toString("base64url");
    expect(await reason(client.verifyIdToken(`${h}.${p}.${s}`, nonce))).toBe("signature");
  });

  it("unsigned (alg none) and algorithm confusion (HS256 keyed with the public key) are refused", async () => {
    const claims = decodeJws(token())?.payload as Record<string, unknown>;
    // Unsigned: refused whether the signature part is empty (malformed) or filled in (alg).
    const none = op.signWith({ alg: "none", kid: op.activeKid }, claims);
    expect(await reason(client.verifyIdToken(none, nonce))).toMatch(/^(malformed|alg)$/);
    const noneSig = op.signWith({ alg: "none" }, claims);
    expect(await reason(client.verifyIdToken(`${noneSig}AAAA`, nonce))).toBe("alg");
    const hs = op.signWith({ alg: "HS256", kid: op.activeKid }, claims, {
      hmacSecret: op.publicPem(),
    });
    expect(await reason(client.verifyIdToken(hs, nonce))).toBe("alg");
    for (const alg of ["RS512", "PS256", "ES256", "rs256", "", null])
      expect(
        await reason(client.verifyIdToken(op.signWith({ alg, kid: op.activeKid }, claims), nonce)),
      ).toBe("alg");
  });

  it("keys come only from the provider's JWK set (embedded jwk/jku/x5u headers refused)", async () => {
    const attacker = rsaKey();
    const claims = decodeJws(token())?.payload as Record<string, unknown>;
    for (const extra of [
      { jwk: attacker.jwk },
      { jku: "https://evil.example/jwks" },
      { x5u: "https://evil.example/cert" },
      { crit: ["exp"] },
    ]) {
      const t = op.signWith({ alg: "RS256", kid: attacker.kid, ...extra }, claims, {
        key: attacker.privateKey,
      });
      expect(await reason(client.verifyIdToken(t, nonce))).toBe("header");
    }
    expect(headerProblem({ alg: "RS256" })).toBe("kid");
    expect(op.requests.some((r) => r.includes("evil.example"))).toBe(false);
  });

  it("malformed tokens", async () => {
    for (const t of [
      "",
      "a.b",
      "a.b.c.d",
      "!!.!!.!!",
      `${"a".repeat(20_000)}.b.c`,
      "e30.e30.",
      "W10.e30.AA",
    ])
      expect(await reason(client.verifyIdToken(t, nonce))).toMatch(/malformed|alg/);
  });

  it("weak or wrong-type keys in the JWK set are never used", () => {
    expect(rsaKeyFromJwk(rsaKey(1024).jwk)).toBeNull();
    expect(rsaKeyFromJwk({ ...rsaKey().jwk, use: "enc" })).toBeNull();
    expect(rsaKeyFromJwk({ ...rsaKey().jwk, alg: "RS512" })).toBeNull();
    expect(rsaKeyFromJwk({ kty: "oct", k: "c2VjcmV0" } as never)).toBeNull();
    expect(rsaKeyFromJwk(rsaKey().jwk)).not.toBeNull();
  });
});

describe("JWK set caching and rotation", () => {
  const nonce = "n".repeat(43);

  it("is fetched once while fresh, refreshed when a new kid appears, and not hammered by unknown kids", async () => {
    await client.verifyIdToken(op.idToken(user, nonce), nonce);
    await client.verifyIdToken(op.idToken(user, nonce), nonce);
    const jwksFetches = () => op.requests.filter((r) => r === op.endpoints.jwks).length;
    expect(jwksFetches()).toBe(1);

    // Google rotates: a token under a new kid makes the client refresh (after the short cooldown).
    op.rotate();
    clock.t += JWKS_REFRESH_COOLDOWN_MS;
    expect((await client.verifyIdToken(op.idToken(user, nonce), nonce)).subject).toBe(user.sub);
    expect(jwksFetches()).toBe(2);

    // A forged kid right after a refresh does not cause another fetch.
    const attacker = rsaKey();
    const claims = decodeJws(op.idToken(user, nonce))?.payload as Record<string, unknown>;
    const t = op.signWith({ alg: "RS256", kid: attacker.kid }, claims, {
      key: attacker.privateKey,
    });
    expect(await reason(client.verifyIdToken(t, nonce))).toBe("kid");
    expect(jwksFetches()).toBe(2);
  });

  it("expires with the response's max-age (bounded) and drops removed keys", async () => {
    op.jwksCacheControl = "public, max-age=600";
    await client.verifyIdToken(op.idToken(user, nonce), nonce);
    const oldToken = op.idToken(user, nonce);
    op.rotate(true);
    clock.t += 601_000;
    // The cache expired: refetched, and the retired key no longer verifies anything.
    expect(await reason(client.verifyIdToken(oldToken, nonce))).toBe("kid");
    expect((await client.verifyIdToken(op.idToken(user, nonce), nonce)).subject).toBe(user.sub);
  });
});

describe("logging", () => {
  it("failures log a fixed reason, never the token, email, name or subject", async () => {
    const before = logLines.length;
    const logged = makeClient({
      log: (await import("./helpers.js")).testLog,
    });
    const t = op.idToken(user, "n".repeat(43), { aud: "x" });
    await reason(logged.verifyIdToken(t, "n".repeat(43)));
    const lines = logLines.slice(before).join("\n");
    expect(lines).toContain('"reason":"aud"');
    for (const v of [t, user.email, user.sub, user.name as string]) expect(lines).not.toContain(v);
  });
});

describe("configuration", () => {
  const base = {
    GLIDEWORTH_PUBLIC_URL: "https://app.example.test/",
    GLIDEWORTH_SECRETS_KEY: randomBytes(32).toString("hex"),
    GLIDEWORTH_BACKUP_KEK: randomBytes(32).toString("hex"),
    GLIDEWORTH_PRICING_FILE: "/etc/glideworth/pricing.json",
  };
  const problems = (env: Record<string, string>) => {
    try {
      loadCloudConfig({ ...base, ...env });
      return [];
    } catch (e) {
      return (e as { problems: string[] }).problems;
    }
  };

  it("off when neither variable is set; on with both; the redirect URI is fixed from the public URL", () => {
    expect(loadCloudConfig(base).google).toBeNull();
    const c = loadCloudConfig({
      ...base,
      GLIDEWORTH_GOOGLE_CLIENT_ID: "123-abc.apps.googleusercontent.com",
      GLIDEWORTH_GOOGLE_CLIENT_SECRET: "GOCSPX-abcdefgh",
    });
    expect(c.google).toEqual({
      clientId: "123-abc.apps.googleusercontent.com",
      clientSecret: "GOCSPX-abcdefgh",
      issuer: "https://accounts.google.com",
      redirectUri: "https://app.example.test/api/v1/auth/google/callback",
    });
  });

  it("refuses half a configuration, a test issuer in production, and never echoes the secret", () => {
    expect(
      problems({ GLIDEWORTH_GOOGLE_CLIENT_ID: "x.apps.googleusercontent.com" }).join(),
    ).toMatch(/must be set together/);
    const prod = problems({
      NODE_ENV: "production",
      GLIDEWORTH_EMAIL_TRANSPORT: "mailgun",
      GLIDEWORTH_BILLING: "stripe",
      GLIDEWORTH_TURNSTILE_SECRET: "x",
      GLIDEWORTH_GOOGLE_CLIENT_ID: "not-a-google-client",
      GLIDEWORTH_GOOGLE_CLIENT_SECRET: "super-secret-value-123",
      GLIDEWORTH_GOOGLE_ISSUER: "https://oidc.fake-google.test",
    });
    expect(prod.join("\n")).toMatch(/GLIDEWORTH_GOOGLE_ISSUER must not be set in production/);
    expect(prod.join("\n")).toMatch(/must be a Google web client id/);
    expect(prod.join("\n")).not.toContain("super-secret-value-123");
    expect(
      problems({
        GLIDEWORTH_GOOGLE_CLIENT_ID: "x",
        GLIDEWORTH_GOOGLE_CLIENT_SECRET: "GOCSPX-abcdefgh",
        GLIDEWORTH_GOOGLE_ISSUER: "http://evil.example",
      }).join(),
    ).toMatch(/https/);
    expect(problems({ GLIDEWORTH_GOOGLE_ISSUER: "https://x.test" }).join()).toMatch(
      /without a Google client/,
    );
  });
});
