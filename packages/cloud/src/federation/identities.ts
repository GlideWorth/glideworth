/**
 * `user_identities`: the link between a person and a federated identity, keyed on the provider's subject.
 * Lookups go by (provider, subject) only. An email address is never used to find an identity or a person here.
 */
import { and, eq } from "drizzle-orm";
import type { ControlDb } from "../control/db.js";
import { userIdentities } from "../control/schema.js";
import { newId } from "../crypto/random.js";

export type Provider = (typeof userIdentities.$inferSelect)["provider"];
export type IdentityRow = typeof userIdentities.$inferSelect;
type Tx = Pick<ControlDb, "select" | "insert" | "update" | "delete">;

export function identityBySubject(
  db: Tx,
  provider: Provider,
  subject: string,
): IdentityRow | undefined {
  return db
    .select()
    .from(userIdentities)
    .where(and(eq(userIdentities.provider, provider), eq(userIdentities.subject, subject)))
    .get();
}

export function identityOfUser(
  db: Tx,
  userId: string,
  provider: Provider,
): IdentityRow | undefined {
  return db
    .select()
    .from(userIdentities)
    .where(and(eq(userIdentities.userId, userId), eq(userIdentities.provider, provider)))
    .get();
}

export function identitiesOfUser(db: Tx, userId: string): IdentityRow[] {
  return db.select().from(userIdentities).where(eq(userIdentities.userId, userId)).all();
}

/** Insert a link. Throws the SQLite constraint error when the subject or the user's provider slot is taken. */
export function insertIdentity(
  tx: Tx,
  i: { userId: string; provider: Provider; subject: string; email: string | null; now: Date },
): void {
  tx.insert(userIdentities)
    .values({
      id: newId("idn"),
      userId: i.userId,
      provider: i.provider,
      subject: i.subject,
      emailAtLink: i.email ? i.email.slice(0, 320) : null,
      createdAt: i.now.toISOString(),
      lastUsedAt: i.now.toISOString(),
    })
    .run();
}

export function touchIdentity(db: Tx, id: string, now: Date): void {
  db.update(userIdentities)
    .set({ lastUsedAt: now.toISOString() })
    .where(eq(userIdentities.id, id))
    .run();
}
