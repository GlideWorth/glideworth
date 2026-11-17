/**
 * Tenant registry (spec 2.3, 2.4): path construction, lifecycle, leases, eviction, migration failure.
 */
import { existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { accounts, memberships, users } from "../src/control/schema.js";
import { CloudError } from "../src/errors.js";
import { InvalidTenantIdError, tenantPath } from "../src/tenancy/paths.js";
import {
  type Cloud,
  type FakeRuntime,
  makeCloud,
  removeTempDirs,
  signedUpBrowser,
  tempDir,
} from "./cloud-fixture.js";

const CRAFTED = [
  "../x",
  "../../etc/passwd",
  "/etc/passwd",
  "tAAAAAAAAAAAAAAA",
  "taaaaaaaaaaaaaa",
  "taaaaaaaaaaaaaaaa",
  "taaaaaaaaaaaaaa\u0000",
  "taaaaaaaaaaaaa/a",
  "taaaaaaaaaaaaa..",
  "tаaaaaaaaaaaaaaa", // Cyrillic a
  "ｔaaaaaaaaaaaaaaa", // fullwidth t
  "taaaaaaaaaaaaaa1", // 1 is not base32
  "",
  " taaaaaaaaaaaaaaa",
];

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? [resolve(dir, e.name), ...walk(resolve(dir, e.name))]
      : [resolve(dir, e.name)],
  );
}

const code = async (p: Promise<unknown> | (() => unknown)) => {
  try {
    if (typeof p === "function") p();
    else await p;
  } catch (e) {
    if (e instanceof CloudError) return e.code;
    if (e instanceof InvalidTenantIdError) return "INVALID_ID";
    throw e;
  }
  return undefined;
};

let cloud: Cloud;
beforeEach(async () => {
  cloud = await makeCloud();
});
afterEach(async () => {
  await cloud.close();
  removeTempDirs();
});

describe("tenant paths", () => {
  it("one function builds every path, inside tenants/<id[1..2]>/<id>/", () => {
    const dir = tempDir();
    expect(tenantPath(dir, "tabcdefghijklmno")).toBe(
      resolve(dir, "tenants", "ab", "tabcdefghijklmno", "tenant.db"),
    );
    expect(
      tenantPath(dir, "tabcdefghijklmno", { kind: "pre-migrate", stamp: "20261116T101500123Z" }),
    ).toBe(
      resolve(dir, "tenants", "ab", "tabcdefghijklmno", "pre-migrate", "20261116T101500123Z.db"),
    );
    expect(() =>
      tenantPath(dir, "tabcdefghijklmno", { kind: "pre-restore", stamp: "../../x" }),
    ).toThrow();
  });

  it("crafted ids (traversal, absolute, uppercase, length, NUL, look-alikes) are refused before any filesystem use", async () => {
    const before = walk(cloud.dataDir);
    const opened = cloud.opener.opened.length;
    for (const bad of CRAFTED) {
      expect(() => tenantPath(cloud.dataDir, bad)).toThrow(InvalidTenantIdError);
      expect(() => cloud.registry.pathFor(bad)).toThrow(InvalidTenantIdError);
      expect(await code(() => cloud.registry.acquire(bad))).toBe("NOT_FOUND");
      expect(await code(cloud.registry.provision(bad))).toBe("INVALID_ID");
      expect(await code(cloud.registry.destroy(bad))).toBe("INVALID_ID");
      expect(await code(cloud.backups.backupTenant(bad))).toBe("INVALID_ID");
      await cloud.registry.close(bad);
    }
    expect(cloud.opener.opened.length).toBe(opened);
    expect(walk(cloud.dataDir)).toEqual(before);
  });
});

describe("lifecycle", () => {
  it("create provisions a migrated database with the owner row, 0700 directory and 0600 file", async () => {
    const { accountId } = await signedUpBrowser(cloud, { name: "Pat Owner" });
    const path = cloud.registry.pathFor(accountId as string);
    expect(existsSync(path)).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(resolve(path, "..")).mode & 0o777).toBe(0o700);
    const db = new Database(path, { readonly: true });
    expect(db.prepare("SELECT role, name FROM users WHERE id = 'owner'").get()).toEqual({
      role: "owner",
      name: "Pat Owner",
    });
    db.close();
    const row = cloud.db
      .select()
      .from(accounts)
      .where(eq(accounts.id, accountId as string))
      .get();
    expect(row?.schemaVersion).toBe(2);
  });

  it("a failed provisioning removes the control-plane rows and the directory", async () => {
    cloud.opener.failNext = { migration: "THIS IS NOT SQL" };
    const { browser } = await signedUpBrowser(cloud).catch(() => ({ browser: null }));
    expect(browser).not.toBeNull();
    expect(cloud.db.select().from(accounts).all()).toHaveLength(0);
    expect(walk(resolve(cloud.dataDir, "tenants")).filter((f) => f.endsWith(".db"))).toHaveLength(
      0,
    );
  });

  it("acquire refuses unknown, deleting and deleted (NOT_FOUND), suspended (unless allowed), migration_failed (503)", async () => {
    const { accountId } = await signedUpBrowser(cloud);
    const id = accountId as string;
    expect(await code(() => cloud.registry.acquire("taaaaaaaaaaaaaaa"))).toBe("NOT_FOUND");
    for (const [status, expected] of [
      ["suspended", "ACCOUNT_SUSPENDED"],
      ["migration_failed", "TENANT_UNAVAILABLE"],
      ["deleting", "NOT_FOUND"],
      ["deleted", "NOT_FOUND"],
    ] as const) {
      await cloud.registry.close(id);
      cloud.db.update(accounts).set({ status }).where(eq(accounts.id, id)).run();
      expect(await code(() => cloud.registry.acquire(id))).toBe(expected);
    }
    cloud.db.update(accounts).set({ status: "suspended" }).where(eq(accounts.id, id)).run();
    const lease = cloud.registry.acquire(id, { allowSuspended: true });
    lease.release();
  });

  it("a missing file for an active account is unavailable, never silently recreated", async () => {
    const { accountId } = await signedUpBrowser(cloud);
    await cloud.registry.close(accountId as string);
    const { rmSync } = await import("node:fs");
    rmSync(cloud.registry.pathFor(accountId as string));
    expect(await code(() => cloud.registry.acquire(accountId as string))).toBe(
      "TENANT_UNAVAILABLE",
    );
    expect(existsSync(cloud.registry.pathFor(accountId as string))).toBe(false);
  });
});

describe("leases, cache and eviction", () => {
  async function tenants(n: number) {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) ids.push((await signedUpBrowser(cloud)).accountId as string);
    for (const id of ids) await cloud.registry.close(id);
    return ids;
  }

  it("leases are reference-counted; release is idempotent", async () => {
    const [a] = await tenants(1);
    const l1 = cloud.registry.acquire(a as string);
    const l2 = cloud.registry.acquire(a as string);
    expect(l1.runtime).toBe(l2.runtime);
    expect(cloud.registry.stats()).toMatchObject({ open: 1, leased: 1 });
    l1.release();
    l1.release();
    expect(cloud.registry.stats().leased).toBe(1);
    l2.release();
    expect(cloud.registry.stats().leased).toBe(0);
  });

  it("LRU evicts the least recently used idle runtime, never a leased or busy one; overflow grows and logs", async () => {
    await cloud.close();
    cloud = await makeCloud({ maxOpen: 2 });
    const [a, b, c, d] = await tenants(4);
    const la = cloud.registry.acquire(a as string); // leased
    const lb = cloud.registry.acquire(b as string);
    lb.release();
    (lb.runtime as FakeRuntime).jobs = 1; // busy (running job)
    const lc = cloud.registry.acquire(c as string);
    lc.release();
    // a leased, b busy: neither may go; the cache grows past its size.
    expect(cloud.registry.isOpen(a as string)).toBe(true);
    expect(cloud.registry.isOpen(b as string)).toBe(true);
    expect(cloud.registry.stats().open).toBe(3);
    (lb.runtime as FakeRuntime).jobs = 0;
    const ld = cloud.registry.acquire(d as string);
    ld.release();
    // Now b (idle, least recently used among evictable) and c go; a stays leased.
    expect(cloud.registry.isOpen(a as string)).toBe(true);
    expect(cloud.registry.isOpen(d as string)).toBe(true);
    expect(cloud.registry.stats().open).toBeLessThanOrEqual(3);
    la.release();
    const { logLines } = await import("./helpers.js");
    expect(logLines.some((l) => l.includes("tenant.cache_overflow"))).toBe(true);
  });

  it("idle eviction closes only runtimes idle past idleMs with no lease and nothing running", async () => {
    const [a, b, c] = await tenants(3);
    for (const id of [a, b, c]) cloud.registry.acquire(id as string).release();
    const held = cloud.registry.acquire(a as string);
    const busy = cloud.registry.acquire(b as string);
    busy.release();
    (busy.runtime as FakeRuntime).jobs = 2;
    cloud.advance(11 * 60_000);
    expect(await cloud.registry.evictIdle()).toBe(1);
    expect(cloud.registry.isOpen(c as string)).toBe(false);
    expect(cloud.registry.isOpen(a as string)).toBe(true);
    expect(cloud.registry.isOpen(b as string)).toBe(true);
    held.release();
    (busy.runtime as FakeRuntime).jobs = 0;
  });

  it("close waits for leases to drain; acquire during close is unavailable", async () => {
    const [a] = await tenants(1);
    const lease = cloud.registry.acquire(a as string);
    const closing = cloud.registry.close(a as string);
    expect(await code(() => cloud.registry.acquire(a as string))).toBe("TENANT_UNAVAILABLE");
    expect((lease.runtime as FakeRuntime).closed).toBe(false);
    lease.release();
    await closing;
    expect((lease.runtime as FakeRuntime).closed).toBe(true);
    cloud.registry.acquire(a as string).release();
  });
});

describe("migrations", () => {
  it("a failed migration marks the tenant migration_failed, answers 503 and leaves the file un-migrated", async () => {
    const { accountId } = await signedUpBrowser(cloud);
    const id = accountId as string;
    await cloud.registry.close(id);
    cloud.opener.migrations.push("CREATE TABLE plans (id TEXT PRIMARY KEY);");
    cloud.opener.failNext = { migration: "CREATE TABLE plans (id TEXT); -- duplicate: fails" };
    expect(await code(() => cloud.registry.acquire(id))).toBe("TENANT_UNAVAILABLE");
    expect(cloud.db.select().from(accounts).where(eq(accounts.id, id)).get()?.status).toBe(
      "migration_failed",
    );
    const db = new Database(cloud.registry.pathFor(id), { readonly: true });
    expect(
      (db.prepare("SELECT count(*) AS n FROM __drizzle_migrations").get() as { n: number }).n,
    ).toBe(2);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'plans'").get()).toBeUndefined();
    db.close();
    expect(await code(() => cloud.registry.acquire(id))).toBe("TENANT_UNAVAILABLE");
    // A pre-migrate copy was taken before the attempt.
    const pre = resolve(cloud.registry.pathFor(id), "..", "pre-migrate");
    expect(readdirSync(pre).filter((f) => f.endsWith(".db"))).toHaveLength(1);
    // migrateAll after the fix: migrated, back to active.
    const r = await cloud.registry.migrateAll({ concurrency: 2 });
    expect(r.failed).toEqual([]);
    expect(cloud.db.select().from(accounts).where(eq(accounts.id, id)).get()?.status).toBe(
      "active",
    );
    const lease = cloud.registry.acquire(id);
    expect(
      (lease.runtime as FakeRuntime).db
        .prepare("SELECT name FROM sqlite_master WHERE name = 'plans'")
        .get(),
    ).toBeTruthy();
    lease.release();
  });

  it("opening reconciles the member mirror from the control plane (removal is enforced on open)", async () => {
    const { accountId, userId } = await signedUpBrowser(cloud);
    const id = accountId as string;
    let lease = cloud.registry.acquire(id);
    // A stale tenant row (a member removed while the tenant was unreachable) and a wrong role.
    (lease.runtime as FakeRuntime).db
      .prepare("INSERT INTO users (id, login, name, role) VALUES ('usr_ghost', 'g', 'G', 'editor')")
      .run();
    (lease.runtime as FakeRuntime).db
      .prepare("UPDATE users SET role = 'viewer' WHERE id = 'owner'")
      .run();
    lease.release();
    await cloud.registry.close(id);
    lease = cloud.registry.acquire(id);
    expect((lease.runtime as FakeRuntime).members.list()).toEqual([
      { tenantUserId: "owner", role: "owner", name: expect.any(String) },
    ]);
    lease.release();
    expect(
      cloud.db.select().from(memberships).where(eq(memberships.userId, userId)).all(),
    ).toHaveLength(1);
    expect(cloud.db.select().from(users).all().length).toBeGreaterThan(0);
  });

  it("opening corrects a member's name that differs from the account name (a rename that could not reach it)", async () => {
    const { accountId, userId } = await signedUpBrowser(cloud);
    const id = accountId as string;
    const account = cloud.db.select().from(users).where(eq(users.id, userId)).get();
    let lease = cloud.registry.acquire(id);
    (lease.runtime as FakeRuntime).db
      .prepare("UPDATE users SET name = 'Old Name' WHERE id = 'owner'")
      .run();
    lease.release();
    await cloud.registry.close(id);
    lease = cloud.registry.acquire(id);
    expect((lease.runtime as FakeRuntime).members.list()).toEqual([
      { tenantUserId: "owner", role: "owner", name: account?.name },
    ]);
    lease.release();
  });

  it("a membership marked by a password reset has its OAuth grants revoked before the next lease; a failure is 503 and stays owed", async () => {
    const { accountId, userId } = await signedUpBrowser(cloud);
    const id = accountId as string;
    const first = cloud.registry.acquire(id);
    const rt = first.runtime as FakeRuntime;
    first.release();
    const mark = () =>
      cloud.db
        .update(memberships)
        .set({ oauthRevokePendingAt: new Date().toISOString() })
        .where(eq(memberships.userId, userId))
        .run();
    const owed = () =>
      cloud.db.select().from(memberships).where(eq(memberships.userId, userId)).get()
        ?.oauthRevokePendingAt;
    const revoked: string[] = [];
    const real = rt.members.revokeOAuthGrants;
    let fail = true;
    rt.members.revokeOAuthGrants = (tenantUserId) => {
      if (fail) throw new Error("disk I/O error");
      revoked.push(tenantUserId);
      return real(tenantUserId);
    };

    mark();
    expect(await code(() => cloud.registry.acquire(id))).toBe("TENANT_UNAVAILABLE");
    expect(owed()).not.toBeNull();
    expect(cloud.registry.stats().leased).toBe(0);

    fail = false;
    cloud.registry.acquire(id).release();
    expect(revoked).toEqual(["owner"]);
    expect(owed()).toBeNull();
    cloud.registry.acquire(id).release();
    expect(revoked).toEqual(["owner"]);
  });

  it("destroy removes the directory after draining leases", async () => {
    const { accountId } = await signedUpBrowser(cloud);
    const id = accountId as string;
    const dir = resolve(cloud.registry.pathFor(id), "..");
    writeFileSync(join(dir, "extra.txt"), "x");
    cloud.db.update(accounts).set({ status: "deleting" }).where(eq(accounts.id, id)).run();
    await cloud.registry.destroy(id);
    expect(existsSync(dir)).toBe(false);
  });
});
