/**
 * TOTP (RFC 6238 over RFC 4226 HOTP) on node:crypto, and recovery codes.
 *
 * Enrolment: 20-byte secret, base32, SHA-1, 6 digits, 30-second steps, issuer "Glideworth" (spec 3.5).
 * Verification accepts the current step and one either side, never a step at or before `lastStep` (replay),
 * and compares in constant time.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { base32Decode, base32Encode, randomBase32 } from "./random.js";

export const TOTP = {
  digits: 6,
  periodSeconds: 30,
  window: 1,
  issuer: "Glideworth",
  secretBytes: 20,
} as const;

/** HOTP value for one counter (RFC 4226 section 5.3, dynamic truncation). */
export function hotp(
  secret: Uint8Array,
  counter: number,
  o: { digits?: number; algorithm?: "sha1" | "sha256" | "sha512" } = {},
): string {
  const digits = o.digits ?? TOTP.digits;
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac(o.algorithm ?? "sha1", secret)
    .update(msg)
    .digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const bin =
    ((mac[offset]! & 0x7f) << 24) |
    (mac[offset + 1]! << 16) |
    (mac[offset + 2]! << 8) |
    mac[offset + 3]!;
  return String(bin % 10 ** digits).padStart(digits, "0");
}

/** The RFC 6238 time step for a Unix time in milliseconds. */
export const totpStep = (nowMs: number): number => Math.floor(nowMs / 1000 / TOTP.periodSeconds);

/** A new 20-byte TOTP secret, base32 uppercase without padding (what authenticator apps expect). */
export function newTotpSecret(): string {
  return base32Encode(randomBytes(TOTP.secretBytes), true);
}

export function otpauthUri(secret: string, accountLabel: string): string {
  const label = `${encodeURIComponent(TOTP.issuer)}:${encodeURIComponent(accountLabel)}`;
  const q = new URLSearchParams({
    secret,
    issuer: TOTP.issuer,
    algorithm: "SHA1",
    digits: String(TOTP.digits),
    period: String(TOTP.periodSeconds),
  });
  return `otpauth://totp/${label}?${q.toString()}`;
}

/**
 * Verify a 6-digit code. Returns the matched step (store it as the new `lastStep`) or null. Steps at or below
 * `lastStep` are never accepted, so a code cannot be used twice even inside its window.
 */
export function verifyTotp(
  secret: string,
  code: string,
  nowMs: number,
  lastStep: number | null,
): number | null {
  if (typeof code !== "string" || typeof secret !== "string") return null;
  const clean = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(clean)) return null;
  const key = base32Decode(secret);
  if (!key || key.length < 10) return null;
  const now = totpStep(nowMs);
  const given = Buffer.from(clean, "utf8");
  let matched: number | null = null;
  // Evaluate every candidate step (no early exit) so timing does not reveal which one matched.
  for (let d = -TOTP.window; d <= TOTP.window; d++) {
    const step = now + d;
    if (step < 0) continue;
    const ok = timingSafeEqual(Buffer.from(hotp(key, step), "utf8"), given);
    if (ok && matched === null && (lastStep === null || step > lastStep)) matched = step;
  }
  return matched;
}

// --------------------------------------------------------------------------------------- recovery codes
/** `xxxxx-xxxxx`: 10 base32 characters, 50 bits. */
export const RECOVERY_CODE_RE = /^[a-z2-7]{5}-[a-z2-7]{5}$/;
export const RECOVERY_CODE_COUNT = 10;

export function newRecoveryCodes(n: number = RECOVERY_CODE_COUNT): string[] {
  if (!Number.isInteger(n) || n < 1 || n > 100) throw new Error("recovery code count out of range");
  return Array.from({ length: n }, () => {
    const s = randomBase32(10);
    return `${s.slice(0, 5)}-${s.slice(5)}`;
  });
}

/** Canonical form of a typed recovery code (case, spaces and dash are forgiven), or null if it cannot be one. */
export function normalizeRecoveryCode(input: string): string | null {
  if (typeof input !== "string" || input.length > 40) return null;
  const s = input.toLowerCase().replace(/[\s-]/g, "");
  if (!/^[a-z2-7]{10}$/.test(s)) return null;
  return `${s.slice(0, 5)}-${s.slice(5)}`;
}
