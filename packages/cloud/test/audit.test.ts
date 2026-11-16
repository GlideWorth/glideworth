import { describe, expect, it } from "vitest";
import { CONTROL_AUDIT_EVENTS, controlAudit } from "../src/audit.js";
import { openControlDb } from "../src/control/db.js";
import { auditEvents } from "../src/control/schema.js";

describe("controlAudit", () => {
  it("stores allowlisted detail keys with safe scalar values only", () => {
    const { db, close } = openControlDb(":memory:");
    const audit = controlAudit(db);
    audit.record({
      actorType: "user",
      actorId: "u_1",
      accountId: "taaaaaaaaaaaaaaa",
      event: "member.role_changed",
      ip: "203.0.113.1",
      userAgent: "x".repeat(1000),
      detail: {
        from: "editor",
        to: "viewer",
        password: "hunter2hunter2",
        token: "abc",
        reason: "free text with spaces",
        role: "jane@example.org",
        count: 3,
        mfa: true,
        kind: null,
      },
    });
    const row = db.select().from(auditEvents).get();
    expect(row?.detail).toEqual({ from: "editor", to: "viewer", count: 3, mfa: true, kind: null });
    expect(row?.userAgent).toHaveLength(256);
    close();
  });

  it("refuses unknown event names", () => {
    const { db, close } = openControlDb(":memory:");
    const audit = controlAudit(db);
    expect(() =>
      audit.record({ actorType: "user", actorId: null, event: "user.whatever" }),
    ).toThrow();
    expect(() =>
      audit.record({ actorType: "user", actorId: null, event: "x'); DROP TABLE users; --" }),
    ).toThrow();
    expect(db.select().from(auditEvents).all()).toHaveLength(0);
    for (const e of CONTROL_AUDIT_EVENTS)
      audit.record({ actorType: "system", actorId: null, event: e });
    expect(db.select().from(auditEvents).all()).toHaveLength(CONTROL_AUDIT_EVENTS.length);
    close();
  });

  it("nulls IP and user agent after 90 days", () => {
    const { db, close } = openControlDb(":memory:");
    let now = new Date("2026-01-01T00:00:00Z");
    const audit = controlAudit(db, { now: () => now });
    audit.record({
      actorType: "user",
      actorId: "u_1",
      event: "user.signin",
      ip: "203.0.113.1",
      userAgent: "UA",
    });
    now = new Date("2026-03-15T00:00:00Z");
    audit.record({
      actorType: "user",
      actorId: "u_1",
      event: "user.signin",
      ip: "203.0.113.2",
      userAgent: "UA",
    });
    now = new Date("2026-04-02T00:00:00Z");
    expect(audit.scrub()).toBe(1);
    const rows = db.select().from(auditEvents).all();
    expect(rows.map((r) => r.ip)).toEqual([null, "203.0.113.2"]);
    expect(audit.scrub()).toBe(0);
    close();
  });
});
