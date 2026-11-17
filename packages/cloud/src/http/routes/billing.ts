/**
 * Billing routes (spec 4.2, 4.3) and the Stripe webhook.
 *
 * Every billing writer for an account (checkout, webhook) runs inside the cross-process writer lock
 * `billing:<account>` (review finding 1). At most one Checkout Session this cell created is open per account
 * (review finding 2): the same price returns the open session's URL; another price first expires the open session
 * through Stripe and then starts a new one. If Stripe says the open session was already completed, a new checkout
 * is refused (`409 CHECKOUT_IN_PROGRESS`) so the account never pays for two subscriptions.
 */
import { findPrice } from "@glideworth/billing";
import { z } from "@hono/zod-openapi";
import { eq } from "drizzle-orm";
import {
  closeAccountCheckoutSessions,
  closeCheckoutSession,
  openCheckoutSession,
  setCheckoutLookupKey,
} from "../../billing/glue.js";
import { subscriptions } from "../../control/schema.js";
import { withWriterLock } from "../../control/writer-lock.js";
import { isAccountId } from "../../crypto/random.js";
import { CloudError } from "../../errors.js";
import type { RouteKit } from "../kit.js";

const WEBHOOK_MAX_BYTES = 1024 * 1024;
/** Requests a minute from one address to `POST /stripe/webhook` (`floodLimit`). */
export const STRIPE_WEBHOOK_PER_MINUTE = 600;

/** Which account an incoming event concerns, for the lock only (the body is not trusted for anything else). */
export function webhookLockKey(
  raw: string,
  accountForCustomer: (customerId: string) => string | null,
): string | null {
  let ev: { type?: unknown; data?: { object?: Record<string, unknown> } };
  try {
    ev = JSON.parse(raw);
  } catch {
    return null;
  }
  const o = ev?.data?.object;
  if (!o || typeof o !== "object") return null;
  const ref = (v: unknown) =>
    typeof v === "string"
      ? v
      : v && typeof v === "object"
        ? ((v as { id?: unknown }).id as string)
        : undefined;
  const customer = ev.type === "customer.deleted" ? ref(o.id) : ref(o.customer);
  const byCustomer =
    typeof customer === "string" && customer.length < 200 ? accountForCustomer(customer) : null;
  const meta =
    (o.metadata as Record<string, unknown> | undefined)?.account_id ?? o.client_reference_id;
  const account = byCustomer ?? (isAccountId(meta) ? meta : null);
  if (account) return `billing:${account}`;
  return typeof customer === "string" && /^cus_[A-Za-z0-9]{1,100}$/.test(customer)
    ? `billing:${customer}`
    : null;
}

export function billingRoutes(k: RouteKit): void {
  const { d } = k;
  const tag = "Cloud billing";
  const accountForCustomer = (customerId: string) =>
    d.db
      .select({ accountId: subscriptions.accountId })
      .from(subscriptions)
      .where(eq(subscriptions.stripeCustomerId, customerId))
      .get()?.accountId ?? null;

  k.op(
    {
      method: "get",
      path: "/api/v1/billing",
      tag,
      summary:
        "Plan, status, trial and period end, the trial the next Checkout would start, access level (all members; no card data)",
      auth: "session",
      ok: 200,
      okSchema: z.object({ status: z.string().nullable() }).passthrough(),
    },
    (c) => {
      const m = k.member(k.session(c));
      const st = d.billing.status(m.accountId);
      const e = d.entitlements.get(m.accountId);
      const r = st.record;
      const price = r?.priceLookupKey ? findPrice(d.pricing, r.priceLookupKey) : null;
      return c.json(
        {
          status: r?.status ?? null,
          productId: r?.productId ?? null,
          plan: price?.product.name ?? null,
          lookupKey: r?.priceLookupKey ?? null,
          interval: price?.price.interval ?? null,
          trialEndsAt: r?.trialEndsAt ?? null,
          trialDays: st.trialDays,
          currentPeriodEnd: r?.currentPeriodEnd ?? null,
          cancelAtPeriodEnd: r?.cancelAtPeriodEnd ?? false,
          access: { level: e.level, reason: e.reason, changesAt: e.changesAt },
          role: m.role,
          offered: d.pricing.products.flatMap((p) =>
            p.prices
              .filter((x) => x.offered)
              .map((x) => ({
                lookupKey: x.lookupKey,
                interval: x.interval,
                product: p.name,
                unitAmount: x.unitAmount,
                currency: x.currency,
                taxBehavior: x.taxBehavior,
              })),
          ),
        },
        200,
      );
    },
  );

  k.op(
    {
      method: "post",
      path: "/api/v1/billing/checkout",
      tag,
      summary: "Start a Stripe Checkout (verified owner); one open session at a time",
      auth: "session",
      ok: 200,
      okSchema: z.object({ url: z.string(), reused: z.boolean() }),
      body: z.object({ lookupKey: z.string().max(200) }),
    },
    async (c, { body }) => {
      const s = k.session(c);
      const m = k.owner(s);
      const lookupKey = (body as { lookupKey: string }).lookupKey;
      const out = await withWriterLock(d.db, `billing:${m.accountId}`, async () => {
        const open = openCheckoutSession(d.db, m.accountId, k.now());
        if (open) {
          if (open.lookupKey === lookupKey) return { url: open.url, reused: true };
          // Another price: end the open session so it can no longer be paid, then start a new one.
          const status = await d.billing.expireCheckout(open.id);
          if (status !== "expired") {
            if (status === "complete") closeCheckoutSession(d.db, open.id, "complete");
            d.audit.record({
              actorType: "user",
              actorId: s.userId,
              accountId: m.accountId,
              subjectUserId: s.userId,
              event: "billing.checkout_refused",
              detail: { reason: status === "complete" ? "session_complete" : "session_open" },
            });
            throw new CloudError(
              409,
              "CHECKOUT_IN_PROGRESS",
              "a checkout for this workspace was just completed; the subscription will appear shortly",
            );
          }
          closeCheckoutSession(d.db, open.id, "expired");
        }
        const r = await d.billing.createCheckout({
          accountId: m.accountId,
          ownerEmail: s.email,
          ownerName: s.name,
          lookupKey,
          ip: k.ip(c),
          actor: { userId: s.userId, role: m.role, emailVerified: true },
          ...(open ? { replaces: open.id } : {}),
        });
        setCheckoutLookupKey(d.db, r.url, m.accountId, lookupKey);
        d.audit.record({
          actorType: "user",
          actorId: s.userId,
          accountId: m.accountId,
          subjectUserId: s.userId,
          event: "billing.checkout_started",
        });
        return { url: r.url, reused: false };
      });
      return c.json(out, 200);
    },
  );

  k.op(
    {
      method: "post",
      path: "/api/v1/billing/portal",
      tag,
      summary: "Open the Stripe Customer Portal (owner)",
      auth: "session",
      ok: 200,
      okSchema: z.object({ url: z.string() }),
    },
    async (c) => {
      const m = k.owner(k.session(c));
      return c.json(await d.billing.createPortal(m.accountId), 200);
    },
  );

  k.op(
    {
      method: "post",
      path: "/stripe/webhook",
      tag,
      summary: "Stripe webhook (signed raw body; idempotent)",
      auth: "none",
      ok: 200,
      okSchema: z.object({ received: z.boolean() }),
      rawBody: {
        contentType: "application/json",
        description: "The event exactly as Stripe sent it",
      },
    },
    async (c) => {
      // Per-address flood limit before the body is read (security review finding 10). Stripe sends from a
      // small set of addresses and can deliver many events a second after an outage or a bulk change, so the
      // limit is far above the other public routes; a refused delivery is retried by Stripe.
      k.floodLimit(c, "stripe-webhook", STRIPE_WEBHOOK_PER_MINUTE);
      const len = Number(c.req.header("content-length") ?? "0");
      if (len > WEBHOOK_MAX_BYTES)
        throw new CloudError(413, "PAYLOAD_TOO_LARGE", "request body too large");
      const raw = await c.req.text();
      if (Buffer.byteLength(raw, "utf8") > WEBHOOK_MAX_BYTES)
        throw new CloudError(413, "PAYLOAD_TOO_LARGE", "request body too large");
      const signature = c.req.header("stripe-signature");
      // Signature first (security review finding 10): the lock key comes from the body, so an unsigned body
      // must not get to queue behind, or ahead of, a workspace's real billing writes. Unsigned requests go
      // straight to `handleWebhook`, which refuses them (400) and logs why.
      const key = d.billing.isSignedWebhook(raw, signature)
        ? webhookLockKey(raw, accountForCustomer)
        : null;
      const run = () => d.billing.handleWebhook(raw, signature);
      const out = key ? await withWriterLock(d.db, key, run, { waitMs: 20_000 }) : await run();
      if (out.status === 200) {
        // Verified by now: a completed or expired Checkout Session no longer blocks a new one.
        try {
          const ev = JSON.parse(raw) as {
            type?: string;
            data?: { object?: { id?: string; client_reference_id?: string } };
          };
          const id = ev.data?.object?.id;
          if (typeof id === "string" && ev.type === "checkout.session.completed")
            closeCheckoutSession(d.db, id, "complete");
          if (typeof id === "string" && ev.type === "checkout.session.expired")
            closeCheckoutSession(d.db, id, "expired");
          const ref = ev.data?.object?.client_reference_id;
          if (ev.type === "checkout.session.completed" && isAccountId(ref))
            closeAccountCheckoutSessions(d.db, ref);
        } catch {
          // not JSON: handleWebhook already refused it
        }
      }
      return c.json({ received: out.status === 200 }, out.status);
    },
  );
}
