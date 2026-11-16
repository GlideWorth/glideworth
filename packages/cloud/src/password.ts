/**
 * Password hashing, byte-compatible with `apps/api/src/services/auth.ts:23-54` (the package cannot import
 * `apps/api`): `scrypt$N$r$p$<salt b64>$<hash b64>`, N=2^15, r=8, p=1, 16-byte salt, 32-byte key, input NFKC.
 *
 * At most 4 scrypt computations run at once in the process (spec 3.2); further callers wait in a bounded queue
 * (a full queue answers 429 instead of growing without limit). Stored parameters are bounds-checked before use
 * so a malformed row can never ask for an unbounded amount of memory or time.
 */
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { Semaphore, SemaphoreFullError } from "./crypto/semaphore.js";
import { CloudError } from "./errors.js";

export const SCRYPT = { N: 32_768, r: 8, p: 1, keylen: 32, saltBytes: 16 } as const;
export const MIN_PASSWORD_LENGTH = 12;
/** Upper bound in characters. With the byte bound below it caps the input scrypt has to process. */
export const MAX_PASSWORD_LENGTH = 1024;
/** NFKC can expand a string (one code point can become 18); the hashed input is capped in bytes too. */
export const MAX_PASSWORD_BYTES = 4096;

const LIMITS = { maxN: 1 << 20, maxR: 32, maxP: 16, minKey: 16, maxKey: 64 } as const;

/** The process-wide scrypt gate (4 concurrent hashes). Exported for tests and metrics. */
export const scryptGate = new Semaphore(4, 512);

/**
 * Verified against when an address is unknown, so a sign-in for a missing account costs the same scrypt work.
 * Same constant as `apps/api` (valid format, current parameters, matches no password).
 */
export const DUMMY_HASH =
  "scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

function rawScrypt(
  pw: string,
  salt: Buffer,
  p: { N: number; r: number; p: number; keylen: number },
) {
  return new Promise<Buffer>((resolve, reject) => {
    scrypt(
      pw.normalize("NFKC"),
      salt,
      p.keylen,
      { N: p.N, r: p.r, p: p.p, maxmem: 128 * p.N * p.r + 1024 * 1024 },
      (err, key) => (err ? reject(err) : resolve(key)),
    );
  });
}

async function gatedScrypt(
  pw: string,
  salt: Buffer,
  p: { N: number; r: number; p: number; keylen: number },
) {
  let release: () => void;
  try {
    release = await scryptGate.acquire();
  } catch (err) {
    if (err instanceof SemaphoreFullError)
      throw new CloudError(429, "RATE_LIMITED", "the service is busy; try again shortly", {
        retryAfterSeconds: 2,
      });
    throw err;
  }
  try {
    return await rawScrypt(pw, salt, p);
  } finally {
    release();
  }
}

/** Input bounds shared by hashing and verifying. Over-long input is never hashed. */
function tooLong(pw: string): boolean {
  return (
    pw.length > MAX_PASSWORD_LENGTH ||
    Buffer.byteLength(pw.normalize("NFKC"), "utf8") > MAX_PASSWORD_BYTES
  );
}

/** `scrypt$32768$8$1$<salt>$<hash>` */
export async function hashPassword(pw: string): Promise<string> {
  if (typeof pw !== "string" || tooLong(pw))
    throw new CloudError(400, "WEAK_PASSWORD", "the password is too long");
  const salt = randomBytes(SCRYPT.saltBytes);
  const key = await gatedScrypt(pw, salt, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${key.toString("base64")}`;
}

interface Parsed {
  N: number;
  r: number;
  p: number;
  salt: Buffer;
  hash: Buffer;
}

function parse(stored: string): Parsed | null {
  if (typeof stored !== "string") return null;
  const [alg, n, r, p, salt, hash, extra] = stored.split("$");
  if (alg !== "scrypt" || !n || !r || !p || !salt || !hash || extra !== undefined) return null;
  const N = Number(n);
  const R = Number(r);
  const P = Number(p);
  if (!Number.isInteger(N) || N < 2 || N > LIMITS.maxN || (N & (N - 1)) !== 0) return null;
  if (!Number.isInteger(R) || R < 1 || R > LIMITS.maxR) return null;
  if (!Number.isInteger(P) || P < 1 || P > LIMITS.maxP) return null;
  const hashBuf = Buffer.from(hash, "base64");
  if (hashBuf.length < LIMITS.minKey || hashBuf.length > LIMITS.maxKey) return null;
  return { N, r: R, p: P, salt: Buffer.from(salt, "base64"), hash: hashBuf };
}

/** Constant-time verify. False for malformed hashes and over-long input (no hash work for those). */
export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const parsed = parse(stored);
  if (!parsed || typeof pw !== "string" || tooLong(pw)) return false;
  const key = await gatedScrypt(pw, parsed.salt, {
    N: parsed.N,
    r: parsed.r,
    p: parsed.p,
    keylen: parsed.hash.length,
  });
  return key.length === parsed.hash.length && timingSafeEqual(key, parsed.hash);
}

/** True when the stored hash uses other parameters than the current ones (upgrade on next sign-in). */
export function needsRehash(stored: string): boolean {
  const p = parse(stored);
  if (!p) return true;
  return (
    p.N !== SCRYPT.N ||
    p.r !== SCRYPT.r ||
    p.p !== SCRYPT.p ||
    p.hash.length !== SCRYPT.keylen ||
    p.salt.length < SCRYPT.saltBytes
  );
}

export interface PasswordPolicyInput {
  password: string;
  email: string;
}

/**
 * Policy (spec 3.3): 12-1024 characters, at most 4 KiB after NFKC, not equal to the email address or its local
 * part, and not containing the local part when that part is 4 characters or longer (shorter local parts would
 * forbid ordinary words). Throws `WEAK_PASSWORD` with a fixed message; the password is never echoed.
 */
export function assertPasswordPolicy({ password, email }: PasswordPolicyInput): void {
  if (typeof password !== "string")
    throw new CloudError(400, "WEAK_PASSWORD", "the password must be a string");
  if ([...password].length < MIN_PASSWORD_LENGTH)
    throw new CloudError(
      400,
      "WEAK_PASSWORD",
      `the password must be at least ${MIN_PASSWORD_LENGTH} characters`,
      {
        minLength: MIN_PASSWORD_LENGTH,
      },
    );
  if (tooLong(password))
    throw new CloudError(
      400,
      "WEAK_PASSWORD",
      `the password must be at most ${MAX_PASSWORD_LENGTH} characters`,
      {
        maxLength: MAX_PASSWORD_LENGTH,
      },
    );
  const pw = password.normalize("NFKC").toLowerCase();
  const addr = email.normalize("NFKC").toLowerCase().trim();
  const local = addr.split("@")[0] ?? "";
  if (
    pw.trim() === addr ||
    (local.length > 0 && pw.trim() === local) ||
    (local.length >= 4 && pw.includes(local))
  )
    throw new CloudError(400, "WEAK_PASSWORD", "the password must not contain your email address");
}
