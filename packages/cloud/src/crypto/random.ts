/**
 * Encodings, random identifiers and hashing primitives shared by the rest of the package.
 */
import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

/** RFC 4648 base32 alphabet, lowercase (account ids, recovery codes, routed secrets). */
const B32 = "abcdefghijklmnopqrstuvwxyz234567";

/** RFC 4648 base32 without padding. Output is lowercase unless `upper`. */
export function base32Encode(bytes: Uint8Array, upper = false): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return upper ? out.toUpperCase() : out;
}

/** Decode RFC 4648 base32 (case-insensitive, padding and spaces ignored). Null on any invalid character. */
export function base32Decode(text: string): Uint8Array | null {
  const clean = text.replace(/[\s=]/g, "").toLowerCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) return null;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Uint8Array.from(out);
}

/** `n` uniformly random lowercase base32 characters (5 bits each). */
export function randomBase32(n: number): string {
  let out = "";
  for (let i = 0; i < n; i++) out += B32[randomInt(32)];
  return out;
}

/** A random 256-bit secret, base64url (43 characters). Used for every one-time token and session. */
export function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Shape check for a value produced by `randomToken()` (cheap rejection before hashing). */
export const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export function sha256Hex(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

/** Constant-time equality of two strings (unequal lengths compare as unequal without early exit on content). */
export function safeEqual(a: string, b: string): boolean {
  const ab = createHash("sha256").update(a, "utf8").digest();
  const bb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ab, bb) && a.length === b.length;
}

// ------------------------------------------------------------------------------------------------ ids
/** User id: `u_` + 20 base32 characters (100 bits). */
export const newUserId = (): string => `u_${randomBase32(20)}`;
export const USER_ID_RE = /^u_[a-z2-7]{20}$/;

/** Account (tenant) id: `t` + 15 lowercase base32 characters (75 bits). Checked before any path join. */
export const newAccountId = (): string => `t${randomBase32(15)}`;
export const ACCOUNT_ID_RE = /^t[a-z2-7]{15}$/;
export const isAccountId = (v: unknown): v is string =>
  typeof v === "string" && ACCOUNT_ID_RE.test(v);

/** Generic row id with a readable prefix (`inv_`, `tok_`, `rc_`...). */
export const newId = (prefix: string): string => `${prefix}_${randomBase32(20)}`;
