/**
 * Retention of personal data in the control database: the deletion side of the privacy policy's "How long we
 * keep it" table (apps/site/src/content/legal/privacy.mdx, section 7). Run by the hourly `maintenance` job
 * (server.ts, durable schedule), so a row is gone within about an hour of its limit.
 *
 *   audit_events   account security events                 12 months after the event
 *   email_log      email delivery records (no body)        90 days after the send
 *   mail_outbox    essential mail: address and contents    30 days after sending (a message that was never
 *                                                          sent: 30 days after it was given up, or queued)
 *   trial_grants   anti-abuse record (hash of the address) 12 months after the end of the trial it relates to
 *   known_devices  keyed hash of the device cookie         400 days after last use (the cookie's own lifetime)
 *
 * Rows a person deletes earlier (their user account) go with that deletion; this is only the time limit.
 * Deletes run in batches of `batchSize` rows, each its own short statement, with a yield to the event loop in
 * between, and at most `maxBatches` per table per run: a large backlog is cleared over several hourly runs
 * instead of holding the database in one long write.
 */
import { and, isNull, lt, lte, ne, or, type SQL, sql } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import type { ControlDb } from "./db.js";
import { auditEvents, emailLog, knownDevices, mailOutbox, trialGrants } from "./schema.js";

const DAY = 86_400_000;

/** The limits, as the privacy policy states them. */
export const CONTROL_RETENTION = {
  auditEventsMonths: 12,
  emailLogDays: 90,
  mailOutboxDaysAfterSend: 30,
  trialGrantMonthsAfterTrial: 12,
  knownDeviceDays: 400,
} as const;

export interface RetentionCounts {
  auditEvents: number;
  emailLog: number;
  mailOutbox: number;
  trialGrants: number;
  knownDevices: number;
}

/** `months` calendar months before `at` (UTC). */
function monthsBefore(at: Date, months: number): Date {
  const d = new Date(at.getTime());
  d.setUTCMonth(d.getUTCMonth() - months);
  return d;
}

const yieldToLoop = () => new Promise<void>((r) => setImmediate(r));

export async function pruneControlData(
  db: ControlDb,
  o: {
    /** The trial length in days (pricing file): a trial grant's trial ends this long after it was granted. */
    trialDays: number;
    now?: () => Date;
    batchSize?: number;
    maxBatches?: number;
  },
): Promise<{ counts: RetentionCounts; total: number; more: boolean }> {
  const now = (o.now ?? (() => new Date()))();
  const batchSize = o.batchSize ?? 500;
  const maxBatches = o.maxBatches ?? 20;
  const iso = (d: Date) => d.toISOString();
  let more = false;

  /** Delete matching rows `batchSize` at a time; true when rows may remain after `maxBatches`. */
  const drain = async (table: SQLiteTable, where: SQL | undefined): Promise<number> => {
    let total = 0;
    for (let i = 0; i < maxBatches; i++) {
      const changes = db
        .delete(table)
        .where(sql`rowid IN (SELECT rowid FROM ${table} WHERE ${where} LIMIT ${batchSize})`)
        .run().changes;
      total += changes;
      if (changes < batchSize) return total;
      await yieldToLoop();
    }
    more = true;
    return total;
  };

  const C = CONTROL_RETENTION;
  const auditCut = iso(monthsBefore(now, C.auditEventsMonths));
  const emailLogCut = iso(new Date(now.getTime() - C.emailLogDays * DAY));
  const outboxCut = iso(new Date(now.getTime() - C.mailOutboxDaysAfterSend * DAY));
  // Granted when the trial started, so the trial ended `trialDays` later.
  const grantCut = iso(
    new Date(
      monthsBefore(now, C.trialGrantMonthsAfterTrial).getTime() - Math.max(0, o.trialDays) * DAY,
    ),
  );
  const deviceCut = iso(new Date(now.getTime() - C.knownDeviceDays * DAY));

  const counts: RetentionCounts = {
    auditEvents: await drain(auditEvents, lt(auditEvents.at, auditCut)),
    emailLog: await drain(emailLog, lt(emailLog.createdAt, emailLogCut)),
    // Pending rows are still being delivered (a few days at most; then `dead`). A sent or suppressed row
    // counts from `sent_at`; a dead one, which has no `sent_at`, from when it was queued.
    mailOutbox: await drain(
      mailOutbox,
      and(
        ne(mailOutbox.status, "pending"),
        or(
          lte(mailOutbox.sentAt, outboxCut),
          and(isNull(mailOutbox.sentAt), lte(mailOutbox.createdAt, outboxCut)),
        ),
      ),
    ),
    trialGrants: await drain(trialGrants, lt(trialGrants.grantedAt, grantCut)),
    knownDevices: await drain(knownDevices, lt(knownDevices.lastSeenAt, deviceCut)),
  };
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return { counts, total, more };
}
