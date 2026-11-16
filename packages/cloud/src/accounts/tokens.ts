/**
 * One-time tokens in `user_tokens` (verification, reset, email change, sign-in challenge).
 *
 * A token is a random 256-bit value handed to the user once; only its SHA-256 is stored. Lookup is by the hash
 * (unique index) and the stored hash is compared again in constant time. Claiming is a single transaction:
 * the row must exist, have the right purpose, be unused and unexpired, and the `UPDATE … WHERE used_at IS NULL`
 * must change exactly one row, so two concurrent claims cannot both win.
 */
import { and, eq, gt, isNull } from "drizzle-orm";
import type { ControlDb } from "../control/db.js";
import { userTokens } from "../control/schema.js";
import { newId, randomToken, safeEqual, sha256Hex, TOKEN_RE } from "../crypto/random.js";
import { CloudError } from "../errors.js";

export type TokenPurpose = (typeof userTokens.$inferSelect)["purpose"];
export type TokenRow = typeof userTokens.$inferSelect;
type Tx = Pick<ControlDb, "select" | "insert" | "update" | "delete">;

export const invalidToken = () =>
  new CloudError(400, "INVALID_TOKEN", "this link or code is invalid or has expired");

export const hashToken = (token: string): string => sha256Hex(token);

export function issueToken(
  tx: Tx,
  o: {
    userId: string;
    purpose: TokenPurpose;
    ttlMs: number;
    now: Date;
    payload?: Record<string, unknown>;
  },
): { token: string; expiresAt: Date } {
  const token = randomToken();
  const expiresAt = new Date(o.now.getTime() + o.ttlMs);
  tx.insert(userTokens)
    .values({
      id: newId("tok"),
      userId: o.userId,
      purpose: o.purpose,
      tokenHash: hashToken(token),
      payload: o.payload ?? null,
      expiresAt: expiresAt.toISOString(),
      createdAt: o.now.toISOString(),
    })
    .run();
  return { token, expiresAt };
}

/** Delete a user's unused tokens of one purpose (a new link supersedes the old ones). */
export function dropUnused(tx: Tx, userId: string, purpose: TokenPurpose): void {
  tx.delete(userTokens)
    .where(
      and(
        eq(userTokens.userId, userId),
        eq(userTokens.purpose, purpose),
        isNull(userTokens.usedAt),
      ),
    )
    .run();
}

/** The live row for a token, without claiming it. Null for anything malformed, unknown, used or expired. */
export function peekToken(
  db: Tx,
  token: unknown,
  purpose: TokenPurpose,
  now: Date,
): TokenRow | null {
  if (typeof token !== "string" || !TOKEN_RE.test(token)) return null;
  const hash = hashToken(token);
  const row = db.select().from(userTokens).where(eq(userTokens.tokenHash, hash)).get();
  if (!row || !safeEqual(row.tokenHash, hash)) return null;
  if (row.purpose !== purpose || row.usedAt !== null || row.expiresAt <= now.toISOString())
    return null;
  return row;
}

/** Atomically mark a live token used. Returns the row, or null if it was not live (or another claim won). */
export function claimToken(
  db: ControlDb,
  token: unknown,
  purpose: TokenPurpose,
  now: Date,
): TokenRow | null {
  return db.transaction((tx) => claimTokenTx(tx, token, purpose, now));
}

export function claimTokenTx(
  tx: Tx,
  token: unknown,
  purpose: TokenPurpose,
  now: Date,
): TokenRow | null {
  const row = peekToken(tx, token, purpose, now);
  if (!row) return null;
  const res = tx
    .update(userTokens)
    .set({ usedAt: now.toISOString() })
    .where(
      and(
        eq(userTokens.id, row.id),
        isNull(userTokens.usedAt),
        gt(userTokens.expiresAt, now.toISOString()),
      ),
    )
    .run();
  return res.changes === 1 ? { ...row, usedAt: now.toISOString() } : null;
}
