import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { sql } from "drizzle-orm";
import { getTableConfig, type SQLiteTable } from "drizzle-orm/sqlite-core";
import { afterEach, describe, expect, it } from "vitest";
import { controlBillingStore } from "../src/control/billing-store.js";
import { openControlDb } from "../src/control/db.js";
import { controlEmailStores } from "../src/control/email-stores.js";
import { accounts, emailLog, schema, subscriptions, users } from "../src/control/schema.js";
import type { SubscriptionRecord } from "../src/external-types.js";

const SPEC_TABLES = [
  "users",
  "user_tokens",
  "recovery_codes",
  "sessions",
  "known_devices",
  "accounts",
  "memberships",
  "invitations",
  "subscriptions",
  "trial_grants",
  "billing_notices",
  "stripe_events",
  "audit_events",
  "usage_counters",
  "tenant_schedules",
  "tenant_keys",
  "backups",
  "oauth_clients",
  "email_suppressions",
  "email_log",
  "exports",
  "operators",
  "operator_sessions",
  "support_grants",
];
/** Added by the second work package (documented in schema.ts). */
const SECOND_PACKAGE_TABLES = [
  "lifecycle_tasks",
  "mail_outbox",
  "writer_locks",
  "checkout_sessions",
  "webhook_nonces",
  "ops_commands",
  "cell_heartbeat",
  // "Sign in with Google" (schema.ts, migration 0003).
  "user_identities",
  "oidc_flows",
  // Durable schedules of the long-interval periodic jobs (durable-jobs.ts, migration 0005).
  "job_runs",
];

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "gw-cloud-test-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("openControlDb", () => {
  it("applies the migrations to an empty database and creates every table of spec 2.2", () => {
    const path = join(tmp(), "control", "control.db");
    const { close } = openControlDb(path);
    close();
    const raw = new Database(path, { readonly: true });
    const tables = (
      raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
    ).map((r) => r.name);
    for (const t of SPEC_TABLES) expect(tables).toContain(t);
    expect(raw.pragma("journal_mode", { simple: true })).toBe("wal");
    raw.close();
  });

  it("the schema module declares exactly the spec tables plus the documented additions", () => {
    const names = Object.values(schema).map((t) => getTableConfig(t as SQLiteTable).name);
    expect([...names].sort()).toEqual([...SPEC_TABLES, ...SECOND_PACKAGE_TABLES].sort());
  });

  it("is idempotent: reopening applies nothing and keeps data", () => {
    const path = join(tmp(), "control.db");
    const a = openControlDb(path);
    a.db
      .insert(users)
      .values({
        id: "u_x",
        email: "x",
        emailNormalized: "x",
        name: "n",
        passwordHash: "h",
        termsVersion: "1",
      })
      .run();
    a.close();
    const b = openControlDb(path);
    expect(b.db.select().from(users).all()).toHaveLength(1);
    b.close();
    const raw = new Database(path, { readonly: true });
    const applied = raw.prepare("SELECT count(*) AS n FROM __drizzle_migrations").get() as {
      n: number;
    };
    // One row per migration in the journal (so adding a migration does not need this test changed).
    const journal = JSON.parse(
      readFileSync(join(__dirname, "..", "drizzle", "meta", "_journal.json"), "utf8"),
    ) as { entries: unknown[] };
    expect(journal.entries.length).toBeGreaterThanOrEqual(6);
    expect(applied.n).toBe(journal.entries.length);
    raw.close();
  });

  it("creates the directory 0700 and the file 0600, and enforces foreign keys", () => {
    const dir = join(tmp(), "nested");
    const path = join(dir, "control.db");
    const { db, close } = openControlDb(path);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(() =>
      db
        .insert(accounts)
        .values({ id: "taaaaaaaaaaaaaaa", name: "x", ownerUserId: "u_missing" })
        .run(),
    ).toThrow(/FOREIGN KEY/);
    close();
  });

  it("enforces unique normalised email", () => {
    const { db, close } = openControlDb(":memory:");
    const row = {
      email: "a",
      emailNormalized: "a@x.org",
      name: "n",
      passwordHash: "h",
      termsVersion: "1",
    };
    db.insert(users)
      .values({ id: "u_1", ...row })
      .run();
    expect(() =>
      db
        .insert(users)
        .values({ id: "u_2", ...row })
        .run(),
    ).toThrow(/UNIQUE/);
    close();
  });
});

describe("controlBillingStore", () => {
  const setup = () => {
    const { db, close } = openControlDb(":memory:");
    db.insert(users)
      .values({
        id: "u_o",
        email: "Owner@Example.org",
        emailNormalized: "owner@example.org",
        name: "Owner",
        passwordHash: "h",
        termsVersion: "1",
      })
      .run();
    db.insert(accounts).values({ id: "taaaaaaaaaaaaaaa", name: "W", ownerUserId: "u_o" }).run();
    return { db, close, store: controlBillingStore(db) };
  };
  const rec = (over: Partial<SubscriptionRecord> = {}): SubscriptionRecord => ({
    accountId: "taaaaaaaaaaaaaaa",
    status: "trialing_local",
    productId: "gw_cloud",
    priceLookupKey: null,
    trialEndsAt: "2026-12-16T00:00:00.000Z",
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    canceledAt: null,
    pastDueSince: null,
    compedUntil: null,
    stripeUpdated: null,
    updatedAt: "2026-11-16T00:00:00.000Z",
    ...over,
  });

  it("saves, reads and keeps stripeUpdated monotonic", () => {
    const { store, close } = setup();
    expect(store.getSubscription("taaaaaaaaaaaaaaa")).toBeNull();
    store.saveSubscription(rec());
    expect(store.getSubscription("taaaaaaaaaaaaaaa")?.status).toBe("trialing_local");
    store.saveSubscription(rec({ status: "active", stripeUpdated: 200 }));
    store.saveSubscription(rec({ status: "past_due", stripeUpdated: 100 })); // older: ignored
    expect(store.getSubscription("taaaaaaaaaaaaaaa")).toMatchObject({
      status: "active",
      stripeUpdated: 200,
    });
    store.saveSubscription(rec({ status: "canceled", stripeUpdated: null })); // unstamped after stamped: ignored
    expect(store.getSubscription("taaaaaaaaaaaaaaa")?.status).toBe("active");
    store.saveSubscription(
      rec({ status: "canceled", stripeUpdated: 200, cancelAtPeriodEnd: true }),
    );
    expect(store.getSubscription("taaaaaaaaaaaaaaa")).toMatchObject({
      status: "canceled",
      cancelAtPeriodEnd: true,
    });
    close();
  });

  it("customers, events, notices, trial clock, owner contact", () => {
    const { store, db, close } = setup();
    expect(() => store.setCustomer("taaaaaaaaaaaaaaa", "cus_1")).toThrow();
    store.saveSubscription(rec());
    store.setCustomer("taaaaaaaaaaaaaaa", "cus_1");
    expect(store.accountForCustomer("cus_1")).toBe("taaaaaaaaaaaaaaa");
    expect(store.accountForCustomer("cus_1' OR '1'='1")).toBeNull();

    const ev = { id: "evt_1", type: "invoice.paid", created: 1, livemode: false, accountId: null };
    expect(store.recordEvent(ev)).toBe("new");
    expect(store.recordEvent(ev)).toBe("seen-unfinished");
    store.finishEvent("evt_1", "failed", "STRIPE_UNAVAILABLE");
    expect(store.failedEvents(10)).toEqual([{ id: "evt_1", attempts: 1 }]);
    store.finishEvent("evt_1", "processed");
    expect(store.recordEvent(ev)).toBe("done");
    expect(store.failedEvents(10)).toEqual([]);

    expect(store.claimNotice("taaaaaaaaaaaaaaa", "trial-ending", "2026-12-16")).toBe(true);
    expect(store.claimNotice("taaaaaaaaaaaaaaa", "trial-ending", "2026-12-16")).toBe(false);
    expect(store.claimNotice("taaaaaaaaaaaaaaa", "trial-ending", "2027-01-16")).toBe(true);

    expect(store.accountsWithTrialEndingBefore("2026-12-17T00:00:00.000Z")).toEqual([
      "taaaaaaaaaaaaaaa",
    ]);
    expect(store.accountsWithTrialEndingBefore("2026-12-15T00:00:00.000Z")).toEqual([]);
    db.update(accounts).set({ status: "suspended" }).run();
    expect(store.accountsWithTrialEndingBefore("2026-12-17T00:00:00.000Z")).toEqual([]);

    expect(store.ownerContact("taaaaaaaaaaaaaaa")).toEqual({
      email: "Owner@Example.org",
      name: "Owner",
    });
    expect(store.ownerContact("tbbbbbbbbbbbbbbb")).toBeNull();
    expect(db.select().from(subscriptions).all()).toHaveLength(1);
    close();
  });
});

describe("controlEmailStores", () => {
  it('suppression per category and "all", and a log without addresses', () => {
    const { db, close } = openControlDb(":memory:");
    const { suppressions, log } = controlEmailStores(db);
    expect(suppressions.isSuppressed("a@example.org", "checkin")).toBe(false);
    suppressions.suppress("a@example.org", "checkin", "unsubscribe");
    expect(suppressions.isSuppressed("a@example.org", "checkin")).toBe(true);
    expect(suppressions.isSuppressed("a@example.org", "essential")).toBe(false);
    suppressions.suppress("b@example.org", "all", "bounce");
    expect(suppressions.isSuppressed("b@example.org", "essential")).toBe(true);
    expect(suppressions.reasonFor("b@example.org", "checkin")).toBe("bounce");
    suppressions.suppress("b@example.org", "all", "complaint");
    expect(suppressions.reasonFor("b@example.org", "checkin")).toBe("complaint");
    log.record({
      userId: "u_1",
      template: "verify-email",
      category: "essential",
      status: "sent",
      providerMessageId: "m1",
    });
    const rows = db.select().from(emailLog).all();
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0] as object).sort()).toEqual(
      ["category", "createdAt", "id", "providerMessageId", "status", "template", "userId"].sort(),
    );
    close();
  });
});

describe("migration 0008: start the no-card trials that were never started", () => {
  it("gives 14 days from now only to unstarted workspaces still owed a trial", () => {
    const { db, close } = openControlDb(":memory:");
    db.insert(users)
      .values({
        id: "u_o",
        email: "o@example.org",
        emailNormalized: "o@example.org",
        name: "O",
        passwordHash: "h",
        termsVersion: "1",
      })
      .run();
    const base = {
      status: "trialing_local",
      productId: "gw_cloud",
      priceLookupKey: null,
      trialEndsAt: null,
      trialAvailable: false,
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      canceledAt: null,
      pastDueSince: null,
      compedUntil: null,
      stripeUpdated: null,
      updatedAt: "2026-11-17T00:00:00.000Z",
      version: 0,
    } as const;
    const rows = {
      owed: { trialAvailable: true },
      noTrial: { trialAvailable: false },
      stripeTrial: {
        trialAvailable: false,
        status: "trialing",
        stripeSubscriptionId: "sub_1",
        trialEndsAt: "2026-11-24T00:00:00.000Z",
      },
    } as const;
    const ids = {
      owed: "taaaaaaaaaaaaaa1",
      noTrial: "taaaaaaaaaaaaaa2",
      stripeTrial: "taaaaaaaaaaaaaa3",
    };
    for (const [k, over] of Object.entries(rows) as [
      keyof typeof rows,
      (typeof rows)[keyof typeof rows],
    ][]) {
      db.insert(accounts).values({ id: ids[k], name: k, ownerUserId: "u_o" }).run();
      db.insert(subscriptions)
        .values({ ...base, ...over, accountId: ids[k] })
        .run();
    }
    const before = Date.now();
    db.run(
      sql.raw(
        readFileSync(new URL("../drizzle/0008_start_no_card_trials.sql", import.meta.url), "utf8"),
      ),
    );
    const get = (id: string) =>
      db
        .select()
        .from(subscriptions)
        .all()
        .find((r) => r.accountId === id);
    const owed = get(ids.owed);
    const end = Date.parse(owed?.trialEndsAt ?? "");
    expect(owed?.trialEndsAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    expect(end - before).toBeGreaterThan(14 * 86_400_000 - 60_000);
    expect(end - before).toBeLessThan(14 * 86_400_000 + 60_000);
    expect(owed?.version).toBe(1);
    expect(get(ids.noTrial)?.trialEndsAt).toBeNull();
    expect(get(ids.stripeTrial)?.trialEndsAt).toBe("2026-11-24T00:00:00.000Z");
    close();
  });
});
