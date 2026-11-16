/**
 * Cloud mode: the renewal reminder of the terms of service (docs/launch/legal-decisions.md section 3 item 6).
 *
 * An annual subscription that will renew (active, not set to cancel at the period end) gets one email to the
 * owner a few days before the charge: the date and a link to the billing page, never the amount. Sent once per
 * period (`billing_notices`, kind `renewal-reminder`, keyed by the period end). Monthly renewals are not
 * announced. Run it from the host's timers (`cloud-host.ts`, next to `retentionSweep`).
 */
import { controlSchema } from "@glideworth/cloud";
import type { CloudRuntime } from "@glideworth/cloud/server";
import { eq } from "drizzle-orm";
import { log } from "./log.js";
import type { TenantRuntime } from "./tenant-runtime.js";

const DAY = 24 * 3600_000;
/** Days before the renewal the reminder goes out. */
const RENEWAL_REMINDER_DAYS = 7;

const formatDate = (d: Date): string =>
  d.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });

export async function renewalReminderSweep(
  rt: CloudRuntime<TenantRuntime>,
  now: Date = new Date(),
): Promise<{ sent: number }> {
  const { accounts, subscriptions, billingNotices, users } = controlSchema;
  const yearly = new Set<string>();
  for (const product of rt.pricing.products)
    for (const price of product.prices) if (price.interval === "year") yearly.add(price.lookupKey);

  const rows = rt.db
    .select({ account: accounts, sub: subscriptions })
    .from(accounts)
    .innerJoin(subscriptions, eq(subscriptions.accountId, accounts.id))
    .where(eq(accounts.status, "active"))
    .all();
  const publicUrl = rt.config.publicUrl.replace(/\/+$/, "");
  let sent = 0;
  for (const { account, sub } of rows) {
    try {
      if (
        sub.status !== "active" ||
        !sub.stripeSubscriptionId ||
        sub.cancelAtPeriodEnd ||
        !sub.priceLookupKey ||
        !yearly.has(sub.priceLookupKey) ||
        !sub.currentPeriodEnd ||
        !account.ownerUserId
      )
        continue;
      const renewsAt = Date.parse(sub.currentPeriodEnd);
      if (!(renewsAt > now.getTime()) || renewsAt - now.getTime() > RENEWAL_REMINDER_DAYS * DAY)
        continue;
      const owner = rt.db
        .select({ id: users.id, email: users.email, name: users.name })
        .from(users)
        .where(eq(users.id, account.ownerUserId))
        .get();
      if (!owner) continue;
      const recorded =
        rt.db
          .insert(billingNotices)
          .values({
            accountId: account.id,
            kind: "renewal-reminder",
            dedupeKey: sub.currentPeriodEnd,
            sentAt: now.toISOString(),
          })
          .onConflictDoNothing()
          .run().changes === 1;
      if (!recorded) continue;
      rt.outbox.enqueue({
        to: { email: owner.email, name: owner.name },
        template: "renewal-reminder",
        data: {
          name: owner.name,
          renewsOn: formatDate(new Date(renewsAt)),
          billingUrl: `${publicUrl}/settings/billing`,
        },
        userId: owner.id,
        dedupeKey: `renewal-reminder:${account.id}:${sub.currentPeriodEnd}`,
      });
      sent++;
    } catch (err) {
      log.error("cloud.renewal_reminder_failed", { accountId: account.id, err });
    }
  }
  if (sent) void rt.outbox.drain().catch(() => undefined);
  return { sent };
}
