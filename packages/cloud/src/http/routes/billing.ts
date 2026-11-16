/**
 * Billing routes (spec 4.2, 4.3) and the Stripe webhook.
 *
 * Every billing writer for an account (checkout, webhook) runs inside the cross-process writer lock
 * `billing:<account>` (review finding 1). Checkout refuses a second session while one this cell created is
 * still open for the account (review finding 2): the same price returns the open session's URL, another price is
 * `409 CHECKOUT_IN_PROGRESS` until it completes or expires (the gateway cannot expire
 * sessions).
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
      summary: "Plan, status, trial and period end, access level (all members; no card data)",
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
          d.audit.record({
            actorType: "user",
            actorId: s.userId,
            accountId: m.accountId,
            subjectUserId: s.userId,
            event: "billing.checkout_refused",
            detail: { reason: "session_open" },
          });
          throw new CloudError(
            409,
            "CHECKOUT_IN_PROGRESS",
            "a checkout is already open for this workspace; finish it or wait for it to expire",
            { expiresAt: open.expiresAt },
          );
        }
        const r = await d.billing.createCheckout({
          accountId: m.accountId,
          ownerEmail: s.email,
          ownerName: s.name,
          lookupKey,
          ip: k.ip(c),
          actor: { userId: s.userId, role: m.role, emailVerified: true },
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
      const len = Number(c.req.header("content-length") ?? "0");
      if (len > WEBHOOK_MAX_BYTES)
        throw new CloudError(413, "PAYLOAD_TOO_LARGE", "request body too large");
      const raw = await c.req.text();
      if (Buffer.byteLength(raw, "utf8") > WEBHOOK_MAX_BYTES)
        throw new CloudError(413, "PAYLOAD_TOO_LARGE", "request body too large");
      const signature = c.req.header("stripe-signature");
      const key = webhookLockKey(raw, accountForCustomer);
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
