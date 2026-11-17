/**
 * How `@glideworth/billing` is wired to the control plane (not in spec 8.3 as named exports):
 *
 * - `billingNotifier`: `BillingService.notify` -> the mail outbox (review finding 3) for owner mail, the audit
 *   trail for operator alerts (disputes, early fraud warnings, orphaned events).
 * - `billingLogBridge`: the billing package's log callback -> the allowlisted logger, plus audit entries for
 *   state changes and an operator alert when two live subscriptions exist for one account (review finding 2).
 * - `trackCheckoutSessions`: wraps the Stripe gateway so every Checkout Session this cell creates is recorded;
 *   the checkout route keeps at most one session open per account (review finding 2).
 */
import { and, desc, eq, gt } from "drizzle-orm";
import type { ControlAudit } from "../audit.js";
import type { ControlDb } from "../control/db.js";
import type { MailOutbox } from "../control/outbox.js";
import { accounts, checkoutSessions, users } from "../control/schema.js";
import type { BillingNotice } from "../external-types.js";
import type { Logger } from "../log/index.js";

type StripeGateway = import("@glideworth/billing").StripeGateway;
type BillingLogger = import("@glideworth/billing").BillingLogger;

/** Stripe's default Checkout Session lifetime, used when the gateway call does not set `expiresAt`. */
export const CHECKOUT_SESSION_TTL_MS = 24 * 3600_000;

const day = (iso: string) => iso.slice(0, 10);

export function billingNotifier(d: {
  db: ControlDb;
  outbox: MailOutbox;
  audit: ControlAudit;
  log: Logger;
  publicUrl: string;
  /** Called after a message is queued (the server starts a drain). */
  kick?: () => void;
}): (n: BillingNotice) => Promise<void> {
  const billingUrl = `${d.publicUrl.replace(/\/+$/, "")}/settings/billing`;
  const owner = (accountId: string) =>
    d.db
      .select({ userId: users.id, email: users.email, name: users.name })
      .from(accounts)
      .innerJoin(users, eq(users.id, accounts.ownerUserId))
      .where(eq(accounts.id, accountId))
      .get();
  return async (n) => {
    switch (n.kind) {
      case "dispute":
      case "early-fraud-warning":
      case "orphaned-event":
        d.audit.record({
          actorType: "stripe",
          actorId: null,
          accountId: n.accountId,
          event: n.kind === "orphaned-event" ? "billing.alert" : "billing.dispute",
          detail: { kind: n.kind, objectId: n.stripeObjectId },
        });
        d.log.error("billing.operator_alert", { kind: n.kind, accountId: n.accountId });
        return;
      case "payment-succeeded":
      case "subscription-activated":
        // Stripe sends receipts; activation is visible in the app. Nothing to mail.
        return;
    }
    const o = owner(n.accountId);
    if (!o) {
      d.log.warn("billing.notice_no_owner", { accountId: n.accountId, kind: n.kind });
      return;
    }
    const to = { email: o.email, name: o.name };
    const queued =
      n.kind === "trial-ending"
        ? d.outbox.enqueue({
            to,
            userId: o.userId,
            template: "trial-ending",
            data: { name: o.name, trialEndsOn: day(n.trialEndsAt), billingUrl },
            dedupeKey: `billing:${n.accountId}:trial-ending:${n.trialEndsAt}`,
          })
        : n.kind === "trial-expired"
          ? d.outbox.enqueue({
              to,
              userId: o.userId,
              template: "trial-expired",
              data: { name: o.name, billingUrl },
              dedupeKey: `billing:${n.accountId}:trial-expired`,
            })
          : n.kind === "payment-problem"
            ? d.outbox.enqueue({
                to,
                userId: o.userId,
                template: "payment-problem",
                data: { name: o.name, portalUrl: billingUrl, readOnlyFrom: day(n.readOnlyFrom) },
                dedupeKey: `billing:${n.accountId}:payment-problem:${n.readOnlyFrom}`,
              })
            : d.outbox.enqueue({
                to,
                userId: o.userId,
                template: "subscription-canceled",
                data: { name: o.name, accessUntil: day(n.accessUntil), billingUrl },
                dedupeKey: `billing:${n.accountId}:subscription-canceled:${n.accessUntil}`,
              });
    if (queued) d.kick?.();
  };
}

const FIELD_MAP: Record<string, string> = {
  accountId: "accountId",
  eventId: "eventId",
  type: "eventType",
  code: "errCode",
  reason: "reason",
  from: "status",
  kind: "kind",
};

export function billingLogBridge(d: { log: Logger; audit: ControlAudit }): BillingLogger {
  return (level, event, fields) => {
    const safe: Record<string, string | number | boolean | null> = {};
    for (const [k, v] of Object.entries(fields)) {
      const name = FIELD_MAP[k];
      if (name) safe[name] = v;
    }
    const accountId = typeof fields.accountId === "string" ? fields.accountId : null;
    const logEvent = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/.test(event) ? event : "billing.event";
    d.log[level](logEvent, safe as never);
    try {
      if (event === "billing.duplicate_subscription") {
        d.audit.record({
          actorType: "stripe",
          actorId: null,
          accountId,
          event: "billing.duplicate_subscription",
          detail: {
            kind: "duplicate",
            objectId:
              typeof fields.otherSubscriptionId === "string" ? fields.otherSubscriptionId : null,
          },
        });
        d.log.error("billing.operator_alert", { kind: "duplicate_subscription", accountId });
      } else if (event === "billing.subscription_changed" && accountId) {
        d.audit.record({
          actorType: "stripe",
          actorId: null,
          accountId,
          event: "billing.subscription_changed",
          detail: {
            from: typeof fields.from === "string" ? fields.from : null,
            to: typeof fields.to === "string" ? fields.to : null,
          },
        });
      } else if (event === "billing.payment_failed" && accountId) {
        d.audit.record({
          actorType: "stripe",
          actorId: null,
          accountId,
          event: "billing.payment_failed",
        });
      } else if (event === "billing.refund" && accountId) {
        d.audit.record({ actorType: "stripe", actorId: null, accountId, event: "billing.refund" });
      } else if (event === "billing.checkout_paused") {
        d.log.error("billing.operator_alert", { kind: "checkout_paused" });
      }
    } catch (err) {
      d.log.error("billing.audit_failed", { err });
    }
  };
}

/** Records every Checkout Session created through the gateway (id, account, price, URL, expiry). */
export function trackCheckoutSessions(
  gateway: StripeGateway,
  db: ControlDb,
  now: () => Date = () => new Date(),
): StripeGateway {
  const createCheckoutSession: StripeGateway["createCheckoutSession"] = async (
    p,
    idempotencyKey,
  ) => {
    const s = await gateway.createCheckoutSession(p, idempotencyKey);
    const at = now();
    db.insert(checkoutSessions)
      .values({
        id: s.id,
        accountId: p.accountId,
        priceId: p.priceId,
        url: s.url,
        createdAt: at.toISOString(),
        expiresAt: new Date(
          p.expiresAt !== undefined ? p.expiresAt * 1000 : at.getTime() + CHECKOUT_SESSION_TTL_MS,
        ).toISOString(),
      })
      .onConflictDoNothing()
      .run();
    return s;
  };
  // A proxy (not a copy): every other member is the original's, bound to it, so its state stays in one place.
  return new Proxy(gateway, {
    get(target, prop) {
      if (prop === "createCheckoutSession") return createCheckoutSession;
      const v = Reflect.get(target, prop, target) as unknown;
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}

/** The account's open Checkout Session created by this cell, if any. */
export function openCheckoutSession(db: ControlDb, accountId: string, at: Date) {
  return db
    .select()
    .from(checkoutSessions)
    .where(
      and(
        eq(checkoutSessions.accountId, accountId),
        eq(checkoutSessions.status, "open"),
        gt(checkoutSessions.expiresAt, at.toISOString()),
      ),
    )
    .orderBy(desc(checkoutSessions.createdAt))
    .get();
}

export function setCheckoutLookupKey(
  db: ControlDb,
  url: string,
  accountId: string,
  lookupKey: string,
): void {
  db.update(checkoutSessions)
    .set({ lookupKey })
    .where(and(eq(checkoutSessions.url, url), eq(checkoutSessions.accountId, accountId)))
    .run();
}

/** A session finished (completed or expired): it no longer blocks a new checkout. */
export function closeCheckoutSession(
  db: ControlDb,
  id: string,
  status: "complete" | "expired",
): void {
  db.update(checkoutSessions).set({ status }).where(eq(checkoutSessions.id, id)).run();
}

/** Every open session of an account ends (its subscription became live, or the account is being deleted). */
export function closeAccountCheckoutSessions(db: ControlDb, accountId: string): void {
  db.update(checkoutSessions)
    .set({ status: "expired" })
    .where(and(eq(checkoutSessions.accountId, accountId), eq(checkoutSessions.status, "open")))
    .run();
}
