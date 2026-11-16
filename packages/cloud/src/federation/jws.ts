/**
 * The smallest JWS verifier "Sign in with Google" needs: compact serialisation, RS256 only, keys from a JWK
 * set. Written on `node:crypto` instead of adding a JOSE library: Node imports an RSA JWK natively
 * (`createPublicKey({ format: "jwk" })`) and verifies RSASSA-PKCS1-v1_5 / SHA-256 natively
 * (`crypto.verify`), so what remains is base64url and JSON parsing. A library would bring every other
 * algorithm and key type, which is exactly the surface algorithm-confusion attacks use.
 *
 * Rules (each has a test in test/federation-oidc.test.ts):
 * - the header `alg` must be in `ALLOWED_ALGS` (RS256): `none`, `HS256` and every other value are refused
 *   before any key is looked at, so an RSA public key can never be used as an HMAC secret;
 * - the key comes from the provider's JWK set by `kid`, never from the token (`jwk`, `jku`, `x5u`, `x5c` and
 *   `crit` headers are refused);
 * - only RSA keys of 2048-8192 bits whose `use` (when given) is `sig` and `alg` (when given) is RS256;
 * - strict base64url (no padding, no other alphabet), JSON objects only, at most 16 KiB.
 */
import { createPublicKey, verify as cryptoVerify, type KeyObject } from "node:crypto";

const ALLOWED_ALGS = ["RS256"] as const;
const MAX_TOKEN = 16 * 1024;
const FORBIDDEN_HEADERS = ["jwk", "jku", "x5u", "x5c", "crit"] as const;

export interface Jwk {
  kty?: unknown;
  kid?: unknown;
  use?: unknown;
  alg?: unknown;
  n?: unknown;
  e?: unknown;
}

export interface DecodedJws {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  signingInput: Buffer;
  signature: Buffer;
}

const B64URL = /^[A-Za-z0-9_-]+$/;
const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function base64urlDecode(s: string): Buffer | null {
  if (!B64URL.test(s) || s.length % 4 === 1) return null;
  return Buffer.from(s, "base64url");
}

/** Split and parse a compact JWS. Null for anything malformed (no signature check here). */
export function decodeJws(token: unknown): DecodedJws | null {
  if (typeof token !== "string" || token.length > MAX_TOKEN) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, s] = parts as [string, string, string];
  const hb = base64urlDecode(h);
  const pb = base64urlDecode(p);
  const sb = base64urlDecode(s);
  if (!hb || !pb || !sb) return null;
  let header: unknown;
  let payload: unknown;
  try {
    header = JSON.parse(hb.toString("utf8"));
    payload = JSON.parse(pb.toString("utf8"));
  } catch {
    return null;
  }
  if (!isObject(header) || !isObject(payload)) return null;
  return { header, payload, signingInput: Buffer.from(`${h}.${p}`, "ascii"), signature: sb };
}

/** Why a header is unacceptable, or null when it names an allowed algorithm and a key id only. */
export function headerProblem(header: Record<string, unknown>): "alg" | "kid" | "header" | null {
  if (typeof header.alg !== "string" || !(ALLOWED_ALGS as readonly string[]).includes(header.alg))
    return "alg";
  if (FORBIDDEN_HEADERS.some((k) => k in header)) return "header";
  if (typeof header.kid !== "string" || header.kid.length < 1 || header.kid.length > 256)
    return "kid";
  return null;
}

/** An RSA public key for RS256 from one JWK, or null when the JWK is not one. */
export function rsaKeyFromJwk(jwk: Jwk): KeyObject | null {
  if (jwk.kty !== "RSA" || typeof jwk.n !== "string" || typeof jwk.e !== "string") return null;
  if (jwk.use !== undefined && jwk.use !== "sig") return null;
  if (jwk.alg !== undefined && jwk.alg !== "RS256") return null;
  if (!B64URL.test(jwk.n) || !B64URL.test(jwk.e)) return null;
  try {
    const key = createPublicKey({ key: { kty: "RSA", n: jwk.n, e: jwk.e }, format: "jwk" });
    const bits = key.asymmetricKeyDetails?.modulusLength ?? 0;
    if (key.asymmetricKeyType !== "rsa" || bits < 2048 || bits > 8192) return null;
    return key;
  } catch {
    return null;
  }
}

/** RS256 signature check. The caller has already required `alg === "RS256"` (`headerProblem`). */
export function verifyRs256(d: DecodedJws, key: KeyObject): boolean {
  if (key.type !== "public" || key.asymmetricKeyType !== "rsa" || d.signature.length === 0)
    return false;
  try {
    return cryptoVerify("RSA-SHA256", d.signingInput, key, d.signature);
  } catch {
    return false;
  }
}
