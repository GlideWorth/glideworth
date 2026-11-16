/**
 * Cloud mode: the retention rule of the terms of service (docs/launch/legal-decisions.md section 3 item 1).
 *
 * A workspace whose trial ended without a subscription, or whose subscription was cancelled, is deleted 12
 * months after the trial end or the end of the last paid period, with warning emails to the owner 30 days and
 * 7 days before. Subscribing again restores access and stops the clock (a workspace at full access is never
 * touched; a later lapse starts a new 12 months from its own date). Signing in does not extend it.
 *
 * Fail-safe ordering: the deletion date is pushed back so it is always at least 30 days after the first warning
 * and 7 days after the second, whatever the sweep's history (a late first run, a stopped server). Each warning
 * is recorded once in the control plane's `billing_notices` (permanent, `sent_at`) and mailed through the
 * outbox; the deletion itself is the cloud package's resumable workspace deletion (backups crypto-shredded).
 * Suspended workspaces and any other lapse (`past_due`, `unpaid`, `paused`) are left alone: they need a person.
 */
import { controlSchema } from "@glideworth/cloud";
import type { CloudRuntime } from "@glideworth/cloud/server";
import { and, eq } from "drizzle-orm";
import { log } from "./log.js";
import type { TenantRuntime } from "./tenant-runtime.js";

const DAY = 24 * 3600_000;
const RETENTION_WARNINGS_DAYS = [30, 7] as const;

const formatDate = (d: Date): string =>
  d.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });

/** 12 calendar months after `iso`. */
export function twelveMonthsAfter(iso: string): Date {
  const d = new Date(iso);
  d.setUTCMonth(d.getUTCMonth() + 12);
  return d;
}

type Sub = typeof controlSchema.subscriptions.$inferSelect;

/** When the 12 months started, or null when the rule does not apply to this subscription. */
function lapseStart(sub: Sub, now: Date): { since: string; why: "trial" | "canceled" } | null {
  if (
    sub.status === "trialing_local" &&
    !sub.stripeSubscriptionId &&
    sub.trialEndsAt &&
    Date.parse(sub.trialEndsAt) <= now.getTime()
  )
    return { since: sub.trialEndsAt, why: "trial" };
  if (sub.status === "canceled") {
    const since = sub.currentPeriodEnd ?? sub.canceledAt;
    if (since && Date.parse(since) <= now.getTime()) return { since, why: "canceled" };
  }
  return null;
}

export interface RetentionResult {
  warned: number;
  deleted: number;
}

export async function retentionSweep(
  rt: CloudRuntime<TenantRuntime>,
  now: Date = new Date(),
): Promise<RetentionResult> {
  const { accounts, subscriptions, billingNotices, users } = controlSchema;
  const rows = rt.db
    .select({ account: accounts, sub: subscriptions })
    .from(accounts)
    .innerJoin(subscriptions, eq(subscriptions.accountId, accounts.id))
    .where(eq(accounts.status, "active"))
    .all();
  const out: RetentionResult = { warned: 0, deleted: 0 };
  const publicUrl = rt.config.publicUrl.replace(/\/+$/, "");

  for (const { account, sub } of rows) {
    const ownerUserId = account.ownerUserId;
    if (!ownerUserId) continue;
    try {
      // Paid, trialing, comped or in grace: full access, the rule does not apply.
      if (rt.entitlements.get(account.id, now).level === "full") continue;
      const lapse = lapseStart(sub, now);
      if (!lapse) continue;
      const kind = (days: number) => `retention-warning-${days}`;
      const sentAt = (days: number) =>
        rt.db
          .select({ at: billingNotices.sentAt })
          .from(billingNotices)
          .where(
            and(
              eq(billingNotices.accountId, account.id),
              eq(billingNotices.kind, kind(days)),
              eq(billingNotices.dedupeKey, lapse.since),
            ),
          )
          .get()?.at ?? null;

      let due = twelveMonthsAfter(lapse.since).getTime();
      let pending = false;
      for (const days of RETENTION_WARNINGS_DAYS) {
        const sent = sentAt(days);
        if (sent) {
          due = Math.max(due, Date.parse(sent) + days * DAY);
          continue;
        }
        if (now.getTime() < due - days * DAY) {
          pending = true;
          break;
        }
        // Send this warning now; the deletion moves so that it is at least `days` days away.
        const owner = rt.db
          .select({ id: users.id, email: users.email, name: users.name })
          .from(users)
          .where(eq(users.id, ownerUserId))
          .get();
        if (!owner) {
          pending = true;
          break;
        }
        const recorded =
          rt.db
            .insert(billingNotices)
            .values({
              accountId: account.id,
              kind: kind(days),
              dedupeKey: lapse.since,
              sentAt: now.toISOString(),
            })
            .onConflictDoNothing()
            .run().changes === 1;
        if (recorded) {
          // Closest existing templates (packages/email has no deletion-warning template yet; reported).
          const deletesOn = Math.max(due, now.getTime() + days * DAY);
          rt.outbox.enqueue({
            to: { email: owner.email, name: owner.name },
            template: "deletion-warning",
            data: {
              name: owner.name,
              workspaceName: account.name ?? "Untitled workspace",
              deletesOn: formatDate(new Date(deletesOn)),
              daysLeft: days,
              billingUrl: `${publicUrl}/settings/billing`,
              exportUrl: `${publicUrl}/settings/workspace`,
            },
            userId: owner.id,
            dedupeKey: `retention:${account.id}:${lapse.since}:${days}`,
          });
          rt.audit.record({
            actorType: "system",
            actorId: null,
            accountId: account.id,
            event: "workspace.retention_warning",
            detail: { days },
          });
          out.warned++;
        }
        pending = true;
        break;
      }
      if (pending || now.getTime() < due) continue;
      await rt.workspaces.deleteOwnedByUser(ownerUserId, account.id);
      log.info("cloud.retention_deleted", { accountId: account.id, reason: lapse.why });
      out.deleted++;
    } catch (err) {
      log.error("cloud.retention_failed", { accountId: account.id, err });
    }
  }
  if (out.warned) void rt.outbox.drain().catch(() => undefined);
  return out;
}
