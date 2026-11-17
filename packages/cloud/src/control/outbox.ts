/**
 * Mail outbox (review finding 3): must-send mail (billing notices, export-ready, account-deleted) is written to
 * `mail_outbox` first and sent by `drain()`, so a provider failure or a crash between "decided to send" and
 * "sent" is retried instead of lost. `BillingService` claims a notice and calls `notify` synchronously (no await
 * in between), and `notify` only inserts the row here, so the claim and the durable intent are adjacent.
 *
 * Delivery is at-least-once with a per-message dedupe key; the Mailer's own idempotency key is the row id
 * (providers that honour it deduplicate a send repeated after a crash). Backoff: 1, 5, 15, 60 minutes, then
 * every 6 hours; after 12 attempts the row is `dead` and an error is logged for the operator. Finished rows are
 * deleted 30 days after sending by the hourly maintenance job (retention.ts).
 */
import { and, asc, eq, lte } from "drizzle-orm";
import { newId } from "../crypto/random.js";
import type { Mailer, TemplateData, TemplateId } from "../external-types.js";
import type { Logger } from "../log/index.js";
import type { ControlDb } from "./db.js";
import { mailOutbox } from "./schema.js";

const BACKOFF_MS = [60_000, 300_000, 900_000, 3600_000];
const LATE_BACKOFF_MS = 6 * 3600_000;
export const OUTBOX_MAX_ATTEMPTS = 12;

export interface EnqueueInput<T extends TemplateId> {
  to: { email: string; name?: string };
  template: T;
  data: TemplateData[T];
  userId?: string | null;
  /** Same key twice = one message. */
  dedupeKey?: string;
}

export class MailOutbox {
  private draining: Promise<{ sent: number; failed: number }> | null = null;
  private readonly clock: () => Date;

  constructor(
    private readonly d: { db: ControlDb; mailer: Mailer; log: Logger; now?: () => Date },
  ) {
    this.clock = d.now ?? (() => new Date());
  }

  /** Durably record a message. Synchronous: returns once the row is committed. False for a duplicate. */
  enqueue<T extends TemplateId>(m: EnqueueInput<T>): boolean {
    const now = this.clock().toISOString();
    return (
      this.d.db
        .insert(mailOutbox)
        .values({
          id: newId("mo"),
          dedupeKey: m.dedupeKey ?? null,
          userId: m.userId ?? null,
          toEmail: m.to.email,
          toName: m.to.name ?? null,
          template: m.template,
          data: m.data as unknown as Record<string, unknown>,
          nextAttemptAt: now,
          createdAt: now,
        })
        .onConflictDoNothing()
        .run().changes === 1
    );
  }

  /** Send everything due. Concurrent calls share one pass. */
  drain(limit = 100): Promise<{ sent: number; failed: number }> {
    if (this.draining) return this.draining;
    this.draining = this.runDrain(limit).finally(() => {
      this.draining = null;
    });
    return this.draining;
  }

  /** Not in spec: delete a person's queued mail (user deletion). */
  forgetUser(userId: string): number {
    return this.d.db
      .delete(mailOutbox)
      .where(and(eq(mailOutbox.userId, userId), eq(mailOutbox.status, "pending")))
      .run().changes;
  }

  stats(): { pending: number; dead: number } {
    const rows = this.d.db.select({ status: mailOutbox.status }).from(mailOutbox).all();
    return {
      pending: rows.filter((r) => r.status === "pending").length,
      dead: rows.filter((r) => r.status === "dead").length,
    };
  }

  private async runDrain(limit: number): Promise<{ sent: number; failed: number }> {
    const now = this.clock();
    const due = this.d.db
      .select()
      .from(mailOutbox)
      .where(
        and(eq(mailOutbox.status, "pending"), lte(mailOutbox.nextAttemptAt, now.toISOString())),
      )
      .orderBy(asc(mailOutbox.nextAttemptAt))
      .limit(limit)
      .all();
    let sent = 0;
    let failed = 0;
    for (const row of due) {
      let code: string | null = null;
      let outcome: "sent" | "suppressed" | "failed";
      try {
        const res = await this.d.mailer.send(
          { email: row.toEmail, ...(row.toName ? { name: row.toName } : {}) },
          row.template as TemplateId,
          row.data as never,
          { ...(row.userId ? { userId: row.userId } : {}), idempotencyKey: row.id },
        );
        outcome = res.status;
        if (res.status === "failed") code = res.code;
      } catch (err) {
        outcome = "failed";
        code = (err as { code?: unknown })?.code
          ? String((err as { code: unknown }).code).slice(0, 64)
          : "error";
      }
      const at = this.clock();
      if (outcome !== "failed") {
        this.d.db
          .update(mailOutbox)
          .set({
            status: outcome,
            sentAt: at.toISOString(),
            attempts: row.attempts + 1,
            lastErrorCode: null,
          })
          .where(eq(mailOutbox.id, row.id))
          .run();
        sent++;
        continue;
      }
      failed++;
      const attempts = row.attempts + 1;
      const dead = attempts >= OUTBOX_MAX_ATTEMPTS;
      const wait = BACKOFF_MS[attempts - 1] ?? LATE_BACKOFF_MS;
      this.d.db
        .update(mailOutbox)
        .set({
          attempts,
          status: dead ? "dead" : "pending",
          lastErrorCode: code,
          nextAttemptAt: new Date(at.getTime() + wait).toISOString(),
        })
        .where(eq(mailOutbox.id, row.id))
        .run();
      if (dead)
        this.d.log.error("outbox.dead", { template: row.template, userId: row.userId, attempts });
      else
        this.d.log.warn("outbox.retry", { template: row.template, userId: row.userId, attempts });
    }
    return { sent, failed };
  }
}
