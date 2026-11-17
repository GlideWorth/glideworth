import type {
  BillingNotice,
  BillingStore,
  StripeEventStatus,
  SubscriptionRecord,
} from "./types.js";

export interface MemoryEventRow {
  id: string;
  type: string;
  created: number;
  livemode: boolean;
  accountId: string | null;
  status: "received" | StripeEventStatus;
  attempts: number;
  errorCode: string | null;
}

/**
 * In-memory `BillingStore` for tests and for `GLIDEWORTH_BILLING=fake` development. Mirrors the control-plane
 * semantics: `INSERT OR IGNORE` event log, monotonic `stripeUpdated`, unique customer ids, exactly-once notices.
 */
export class MemoryBillingStore implements BillingStore {
  readonly subscriptions = new Map<string, SubscriptionRecord>();
  readonly customers = new Map<string, string>();
  readonly events = new Map<string, MemoryEventRow>();
  readonly notices = new Set<string>();
  readonly owners = new Map<string, { email: string; name: string }>();
  /** Saves rejected because `stripeUpdated` went backwards (a slow handler losing the race). */
  rejectedSaves = 0;

  addAccount(accountId: string, owner: { email: string; name: string }): void {
    this.owners.set(accountId, owner);
  }

  getSubscription(accountId: string): SubscriptionRecord | null {
    const rec = this.subscriptions.get(accountId);
    return rec ? { ...rec } : null;
  }

  saveSubscription(rec: SubscriptionRecord): void {
    const stored = this.subscriptions.get(rec.accountId);
    if (stored?.stripeUpdated != null && (rec.stripeUpdated ?? 0) < stored.stripeUpdated) {
      this.rejectedSaves++;
      return;
    }
    if (rec.stripeCustomerId !== null) {
      const owner = this.customers.get(rec.stripeCustomerId);
      if (owner !== undefined && owner !== rec.accountId)
        throw new Error("UNIQUE constraint: stripe_customer_id");
    }
    if (rec.stripeSubscriptionId !== null) {
      for (const other of this.subscriptions.values()) {
        if (
          other.accountId !== rec.accountId &&
          other.stripeSubscriptionId === rec.stripeSubscriptionId
        ) {
          throw new Error("UNIQUE constraint: stripe_subscription_id");
        }
      }
    }
    this.subscriptions.set(rec.accountId, { ...rec });
    if (rec.stripeCustomerId !== null) this.customers.set(rec.stripeCustomerId, rec.accountId);
  }

  accountForCustomer(customerId: string): string | null {
    return this.customers.get(customerId) ?? null;
  }

  setCustomer(accountId: string, customerId: string): void {
    const owner = this.customers.get(customerId);
    if (owner !== undefined && owner !== accountId)
      throw new Error("UNIQUE constraint: stripe_customer_id");
    this.customers.set(customerId, accountId);
  }

  recordEvent(e: {
    id: string;
    type: string;
    created: number;
    livemode: boolean;
    accountId: string | null;
  }): "new" | "seen-unfinished" | "done" {
    const row = this.events.get(e.id);
    if (!row) {
      this.events.set(e.id, { ...e, status: "received", attempts: 0, errorCode: null });
      return "new";
    }
    return row.status === "received" || row.status === "failed" ? "seen-unfinished" : "done";
  }

  finishEvent(id: string, status: StripeEventStatus, errorCode?: string): void {
    const row = this.events.get(id);
    if (!row) return;
    row.status = status;
    row.attempts += 1;
    row.errorCode = errorCode ?? null;
  }

  failedEvents(limit: number): Array<{ id: string; attempts: number }> {
    return [...this.events.values()]
      .filter((e) => e.status === "failed")
      .sort((a, b) => a.created - b.created)
      .slice(0, limit)
      .map((e) => ({ id: e.id, attempts: e.attempts }));
  }

  claimNotice(accountId: string, kind: BillingNotice["kind"], dedupeKey: string): boolean {
    const key = JSON.stringify([accountId, kind, dedupeKey]);
    if (this.notices.has(key)) return false;
    this.notices.add(key);
    return true;
  }

  accountsWithTrialEndingBefore(iso: string): string[] {
    const limit = Date.parse(iso);
    return [...this.subscriptions.values()]
      .filter(
        (s) =>
          s.status === "trialing" && s.trialEndsAt !== null && Date.parse(s.trialEndsAt) < limit,
      )
      .map((s) => s.accountId)
      .sort();
  }

  ownerContact(accountId: string): { email: string; name: string } | null {
    return this.owners.get(accountId) ?? null;
  }
}
