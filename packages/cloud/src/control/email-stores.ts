/**
 * `SuppressionStore` and `EmailLogStore` (spec 8.1) on the control plane. The log never holds an address,
 * subject or body: only who (user id), which template, category, outcome and the provider's message id.
 */
import { and, eq, inArray } from "drizzle-orm";
import { newId } from "../crypto/random.js";
import type {
  EmailCategory,
  EmailLogStore,
  SuppressionReason,
  SuppressionStore,
} from "../external-types.js";
import type { ControlDb } from "./db.js";
import { emailLog, emailSuppressions } from "./schema.js";

export function controlEmailStores(
  db: ControlDb,
  o: { now?: () => Date } = {},
): {
  suppressions: SuppressionStore & {
    reasonFor(emailNormalized: string, category: EmailCategory): SuppressionReason | null;
    /**
     * Removes one category's suppression, only when it has this reason (a confirmed new opt-in lifts an earlier
     * list unsubscribe; a bounce or complaint, stored under `all`, is never lifted here).
     */
    lift(emailNormalized: string, category: EmailCategory, reason: SuppressionReason): void;
  };
  log: EmailLogStore;
} {
  const nowIso = () => (o.now ? o.now() : new Date()).toISOString();
  const reasonFor = (emailNormalized: string, category: EmailCategory): SuppressionReason | null =>
    db
      .select({ reason: emailSuppressions.reason })
      .from(emailSuppressions)
      .where(
        and(
          eq(emailSuppressions.emailNormalized, emailNormalized),
          inArray(emailSuppressions.category, [category, "all"]),
        ),
      )
      .get()?.reason ?? null;

  return {
    suppressions: {
      isSuppressed: (emailNormalized, category) => reasonFor(emailNormalized, category) !== null,
      reasonFor,
      suppress(emailNormalized, category, reason) {
        db.insert(emailSuppressions)
          .values({ emailNormalized, category, reason, createdAt: nowIso() })
          .onConflictDoUpdate({
            target: [emailSuppressions.emailNormalized, emailSuppressions.category],
            set: { reason },
          })
          .run();
      },
      lift(emailNormalized, category, reason) {
        db.delete(emailSuppressions)
          .where(
            and(
              eq(emailSuppressions.emailNormalized, emailNormalized),
              eq(emailSuppressions.category, category),
              eq(emailSuppressions.reason, reason),
            ),
          )
          .run();
      },
    },
    log: {
      record(e) {
        db.insert(emailLog)
          .values({
            id: newId("eml"),
            userId: e.userId,
            template: e.template,
            category: e.category,
            providerMessageId: e.providerMessageId,
            status: e.status,
            createdAt: nowIso(),
          })
          .run();
      },
    },
  };
}
