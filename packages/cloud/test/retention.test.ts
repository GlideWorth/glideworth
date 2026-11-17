import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openControlDb } from "../src/control/db.js";
import { CONTROL_RETENTION, pruneControlData } from "../src/control/retention.js";
import {
  auditEvents,
  emailLog,
  knownDevices,
  mailOutbox,
  trialGrants,
  users,
} from "../src/control/schema.js";

const DAY = 86_400_000;
const T0 = Date.parse("2026-11-17T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

let clock = T0;
const now = () => new Date(clock);
let h: ReturnType<typeof openControlDb>;

beforeEach(() => {
  clock = T0;
  h = openControlDb(":memory:");
});
afterEach(() => h.close());

const rows = {
  audit: () => h.db.select().from(auditEvents).all().length,
  emailLog: () => h.db.select().from(emailLog).all().length,
  outbox: () =>
    h.db
      .select({ id: mailOutbox.id })
      .from(mailOutbox)
      .all()
      .map((r) => r.id)
      .sort(),
  grants: () =>
    h.db
      .select({ k: trialGrants.emailHmac })
      .from(trialGrants)
      .all()
      .map((r) => r.k),
  devices: () =>
    h.db
      .select({ d: knownDevices.deviceHmac })
      .from(knownDevices)
      .all()
      .map((r) => r.d),
};

const prune = (o: { batchSize?: number; maxBatches?: number } = {}) =>
  pruneControlData(h.db, { trialDays: 30, now, ...o });

function audit(at: number) {
  h.db
    .insert(auditEvents)
    .values({ at: iso(at), actorType: "user", event: "user.signin" })
    .run();
}

function outbox(
  id: string,
  status: "pending" | "sent" | "suppressed" | "dead",
  createdAt: number,
  sentAt: number | null,
) {
  h.db
    .insert(mailOutbox)
    .values({
      id,
      toEmail: "jane@example.org",
      template: "export_ready",
      data: {},
      status,
      nextAttemptAt: iso(createdAt),
      createdAt: iso(createdAt),
      sentAt: sentAt === null ? null : iso(sentAt),
    })
    .run();
}

describe("control-database retention (privacy policy section 7)", () => {
  it("states the policy's limits", () => {
    expect(CONTROL_RETENTION).toEqual({
      auditEventsMonths: 12,
      emailLogDays: 90,
      mailOutboxDaysAfterSend: 30,
      trialGrantMonthsAfterTrial: 12,
      knownDeviceDays: 400,
    });
  });

  it("deletes account security events 12 months after the event, and nothing younger", async () => {
    audit(Date.parse("2025-11-17T11:59:59.000Z")); // 12 months and a second
    audit(Date.parse("2025-11-17T12:00:01.000Z")); // a second short of 12 months
    audit(T0 - DAY);
    expect((await prune()).counts.auditEvents).toBe(1);
    expect(rows.audit()).toBe(2);
    clock += 2_000;
    expect((await prune()).counts.auditEvents).toBe(1);
    expect(rows.audit()).toBe(1);
  });

  it("deletes email delivery records after 90 days", async () => {
    for (const [id, age] of [
      ["eml_old", 90 * DAY + 1],
      ["eml_new", 90 * DAY - 60_000],
    ] as const)
      h.db
        .insert(emailLog)
        .values({
          id,
          template: "verify",
          category: "essential",
          status: "sent",
          createdAt: iso(T0 - age),
        })
        .run();
    expect((await prune()).counts.emailLog).toBe(1);
    expect(h.db.select({ id: emailLog.id }).from(emailLog).all()).toEqual([{ id: "eml_new" }]);
    clock += 60_001;
    await prune();
    expect(rows.emailLog()).toBe(0);
  });

  it("deletes outbox mail 30 days after sending; pending mail stays until it is sent or given up", async () => {
    // Queued 40 days ago, sent 25 days ago: counted from the send, so it stays.
    outbox("mo_late_send", "sent", T0 - 40 * DAY, T0 - 25 * DAY);
    outbox("mo_sent_old", "sent", T0 - 31 * DAY, T0 - 31 * DAY);
    outbox("mo_suppressed_old", "suppressed", T0 - 31 * DAY, T0 - 31 * DAY);
    outbox("mo_dead_old", "dead", T0 - 31 * DAY, null);
    outbox("mo_dead_new", "dead", T0 - 3 * DAY, null);
    outbox("mo_pending", "pending", T0 - 60 * DAY, null);
    expect((await prune()).counts.mailOutbox).toBe(3);
    expect(rows.outbox()).toEqual(["mo_dead_new", "mo_late_send", "mo_pending"]);
    clock += 5 * DAY + 1;
    await prune();
    expect(rows.outbox()).toEqual(["mo_dead_new", "mo_pending"]);
  });

  it("deletes a trial grant 12 months after the end of its trial (granted at the start), not 24", async () => {
    const at = (s: string) => h.db.insert(trialGrants).values({ emailHmac: s, grantedAt: s }).run();
    // Trial 30 days: granted 2025-10-18T12:00Z, ended 2025-11-17T12:00Z, 12 months ago today.
    at("2025-10-18T11:59:59.000Z");
    at("2025-10-18T12:00:01.000Z");
    at("2025-11-17T00:00:00.000Z"); // trial ended 2025-12-17: 11 months ago
    expect((await prune()).counts.trialGrants).toBe(1);
    expect(rows.grants().sort()).toEqual(["2025-10-18T12:00:01.000Z", "2025-11-17T00:00:00.000Z"]);
    clock = Date.parse("2026-12-17T00:00:01.000Z");
    await prune();
    expect(rows.grants()).toEqual([]);
  });

  it("follows the configured trial length", async () => {
    h.db
      .insert(trialGrants)
      .values({ emailHmac: "g", grantedAt: "2025-11-10T12:00:00.000Z" })
      .run();
    // A 7-day trial ended 2025-11-17T12:00Z: exactly 12 months, not yet over.
    expect((await pruneControlData(h.db, { trialDays: 7, now })).counts.trialGrants).toBe(0);
    clock += 1;
    expect((await pruneControlData(h.db, { trialDays: 7, now })).counts.trialGrants).toBe(1);
  });

  it("deletes a known device 400 days after it was last seen", async () => {
    h.db
      .insert(users)
      .values({
        id: "u_1",
        email: "jane@example.org",
        emailNormalized: "jane@example.org",
        name: "Jane",
        passwordHash: "",
        termsVersion: "1",
      })
      .run();
    h.db
      .insert(knownDevices)
      .values([
        {
          userId: "u_1",
          deviceHmac: "old",
          firstSeenAt: iso(T0 - 500 * DAY),
          lastSeenAt: iso(T0 - 400 * DAY - 1),
        },
        {
          userId: "u_1",
          deviceHmac: "used",
          firstSeenAt: iso(T0 - 500 * DAY),
          lastSeenAt: iso(T0 - 10 * DAY),
        },
      ])
      .run();
    expect((await prune()).counts.knownDevices).toBe(1);
    expect(rows.devices()).toEqual(["used"]);
  });

  it("works in bounded batches and reports a backlog, which the next runs clear", async () => {
    for (let i = 0; i < 25; i++) audit(T0 - 400 * DAY - i * 1000);
    audit(T0 - DAY);
    const first = await prune({ batchSize: 10, maxBatches: 2 });
    expect(first).toMatchObject({ total: 20, more: true });
    expect(rows.audit()).toBe(6);
    const second = await prune({ batchSize: 10, maxBatches: 2 });
    expect(second).toMatchObject({ total: 5, more: false });
    expect(rows.audit()).toBe(1);
  });
});
