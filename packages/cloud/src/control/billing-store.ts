/**
 * `BillingStore` (spec 8.2) on the control plane: the only way `@glideworth/billing` reads or writes state.
 *
 * Per-account serialisation across processes (review finding 1): the webhook, checkout, cancel and comp paths
 * run inside `withWriterLock('billing:<account>')` (writer-lock.ts). Inside such a scope every
 * `getSubscription` remembers the row's `version`, and `saveSubscription` / `setCustomer` check, in the write's
 * own transaction, that the lease is still held with its fencing token and that the version is unchanged
 * (compare-and-swap), then increment it. Outside a scope (trial creation) writes still increment the version,
 * so a locked reader notices them. The monotonic `stripeUpdated` rule is kept as well.
 */
import { and, eq, lt, sql } from "drizzle-orm";
import type { BillingStore, SubscriptionRecord } from "../external-types.js";
import type { ControlDb } from "./db.js";
import { accounts, billingNotices, stripeEvents, subscriptions, users } from "./schema.js";
import { assertLeaseHeld, lockScope, VersionConflictError } from "./writer-lock.js";

type Row = typeof subscriptions.$inferSelect;

const toRecord = (r: Row): SubscriptionRecord => ({
  accountId: r.accountId,
  status: r.status,
  productId: r.productId,
  priceLookupKey: r.priceLookupKey,
  trialEndsAt: r.trialEndsAt,
  stripeCustomerId: r.stripeCustomerId,
  stripeSubscriptionId: r.stripeSubscriptionId,
  currentPeriodEnd: r.currentPeriodEnd,
  cancelAtPeriodEnd: r.cancelAtPeriodEnd,
  canceledAt: r.canceledAt,
  pastDueSince: r.pastDueSince,
  compedUntil: r.compedUntil,
  stripeUpdated: r.stripeUpdated,
  updatedAt: r.updatedAt,
});

export function controlBillingStore(db: ControlDb, o: { now?: () => Date } = {}): BillingStore {
  const nowIso = () => (o.now ? o.now() : new Date()).toISOString();

  /** Inside a lock scope: the lease must still be ours, and the row must be at the version we read. */
  const guard = (tx: Pick<ControlDb, "select">, accountId: string): void => {
    const scope = lockScope.getStore();
    if (!scope) return;
    assertLeaseHeld(tx, scope);
    const seen = scope.versions.get(accountId);
    if (seen === undefined) return;
    const cur = tx
      .select({ version: subscriptions.version })
      .from(subscriptions)
      .where(eq(subscriptions.accountId, accountId))
      .get();
    if ((cur?.version ?? -1) !== seen) throw new VersionConflictError();
  };
  const remember = (accountId: string, version: number | undefined): void => {
    const scope = lockScope.getStore();
    if (scope && version !== undefined) scope.versions.set(accountId, version);
  };

  return {
    getSubscription(accountId) {
      const row = db
        .select()
        .from(subscriptions)
        .where(eq(subscriptions.accountId, accountId))
        .get();
      remember(accountId, row ? row.version : -1);
      return row ? toRecord(row) : null;
    },

    /**
     * Upsert. A record whose `stripeUpdated` is older than the stored one is ignored, so a slow handler of an
     * older event can never overwrite newer state. Read and write happen in one transaction.
     */
    saveSubscription(rec) {
      db.transaction((tx) => {
        guard(tx, rec.accountId);
        const cur = tx
          .select({ stripeUpdated: subscriptions.stripeUpdated, version: subscriptions.version })
          .from(subscriptions)
          .where(eq(subscriptions.accountId, rec.accountId))
          .get();
        if (
          cur?.stripeUpdated != null &&
          (rec.stripeUpdated == null || rec.stripeUpdated < cur.stripeUpdated)
        )
          return;
        const values = {
          accountId: rec.accountId,
          status: rec.status,
          productId: rec.productId,
          priceLookupKey: rec.priceLookupKey,
          trialEndsAt: rec.trialEndsAt,
          stripeCustomerId: rec.stripeCustomerId,
          stripeSubscriptionId: rec.stripeSubscriptionId,
          currentPeriodEnd: rec.currentPeriodEnd,
          cancelAtPeriodEnd: rec.cancelAtPeriodEnd,
          canceledAt: rec.canceledAt,
          pastDueSince: rec.pastDueSince,
          compedUntil: rec.compedUntil,
          stripeUpdated: rec.stripeUpdated,
          updatedAt: rec.updatedAt || nowIso(),
        };
        const { accountId: _ignored, ...update } = values;
        const version = (cur?.version ?? -1) + 1;
        tx.insert(subscriptions)
          .values({ ...values, version })
          .onConflictDoUpdate({ target: subscriptions.accountId, set: { ...update, version } })
          .run();
        remember(rec.accountId, version);
      });
    },

    accountForCustomer(customerId) {
      return (
        db
          .select({ accountId: subscriptions.accountId })
          .from(subscriptions)
          .where(eq(subscriptions.stripeCustomerId, customerId))
          .get()?.accountId ?? null
      );
    },

    setCustomer(accountId, customerId) {
      db.transaction((tx) => {
        guard(tx, accountId);
        const res = tx
          .update(subscriptions)
          .set({
            stripeCustomerId: customerId,
            updatedAt: nowIso(),
            version: sql`${subscriptions.version} + 1`,
          })
          .where(eq(subscriptions.accountId, accountId))
          .run();
        if (res.changes !== 1) throw new Error("no subscription row for this account");
        const v = tx
          .select({ version: subscriptions.version })
          .from(subscriptions)
          .where(eq(subscriptions.accountId, accountId))
          .get();
        remember(accountId, v?.version);
      });
    },

    recordEvent(e) {
      const res = db
        .insert(stripeEvents)
        .values({
          id: e.id,
          type: e.type,
          created: e.created,
          livemode: e.livemode,
          accountId: e.accountId,
          receivedAt: nowIso(),
          status: "received",
        })
        .onConflictDoNothing()
        .run();
      if (res.changes === 1) return "new";
      const row = db
        .select({ status: stripeEvents.status })
        .from(stripeEvents)
        .where(eq(stripeEvents.id, e.id))
        .get();
      if (e.accountId)
        db.update(stripeEvents)
          .set({ accountId: e.accountId })
          .where(eq(stripeEvents.id, e.id))
          .run();
      return row &&
        (row.status === "processed" || row.status === "ignored" || row.status === "orphaned")
        ? "done"
        : "seen-unfinished";
    },

    finishEvent(id, status, errorCode) {
      db.transaction((tx) => {
        const row = tx
          .select({ attempts: stripeEvents.attempts })
          .from(stripeEvents)
          .where(eq(stripeEvents.id, id))
          .get();
        if (!row) return;
        tx.update(stripeEvents)
          .set({
            status,
            processedAt: status === "failed" ? null : nowIso(),
            attempts: row.attempts + 1,
            errorCode: errorCode ?? null,
          })
          .where(eq(stripeEvents.id, id))
          .run();
      });
    },

    failedEvents(limit) {
      return db
        .select({ id: stripeEvents.id, attempts: stripeEvents.attempts })
        .from(stripeEvents)
        .where(eq(stripeEvents.status, "failed"))
        .orderBy(stripeEvents.receivedAt)
        .limit(Math.max(0, Math.min(limit, 1000)))
        .all();
    },

    claimNotice(accountId, kind, dedupeKey) {
      return (
        db
          .insert(billingNotices)
          .values({ accountId, kind, dedupeKey, sentAt: nowIso() })
          .onConflictDoNothing()
          .run().changes === 1
      );
    },

    accountsWithTrialEndingBefore(iso) {
      return db
        .select({ accountId: subscriptions.accountId })
        .from(subscriptions)
        .innerJoin(accounts, eq(accounts.id, subscriptions.accountId))
        .where(
          and(
            eq(subscriptions.status, "trialing_local"),
            lt(subscriptions.trialEndsAt, iso),
            eq(accounts.status, "active"),
          ),
        )
        .all()
        .map((r) => r.accountId);
    },

    ownerContact(accountId) {
      const row = db
        .select({ email: users.email, name: users.name })
        .from(accounts)
        .innerJoin(users, eq(users.id, accounts.ownerUserId))
        .where(eq(accounts.id, accountId))
        .get();
      return row ?? null;
    },
  };
}
