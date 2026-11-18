/**
 * Workspace export and deletion, user deletion (spec 3.8, 3.9) and review finding 5: deletion is a recorded,
 * resumable task; a crash part-way is completed by `resumeLifecycle()`; access ends at the first step.
 */
import { existsSync } from "node:fs";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  accounts,
  backups,
  lifecycleTasks,
  mailOutbox,
  memberships,
  subscriptions,
  tenantKeys,
  tenantSchedules,
  trialGrants,
  users,
} from "../src/control/schema.js";
import { WorkspacesService } from "../src/workspaces/service.js";
import {
  Browser,
  type Cloud,
  type FakeRuntime,
  makeCloud,
  removeTempDirs,
  SENTINEL_HOUSEHOLD,
  signedUpBrowser,
  uniqueEmail,
} from "./cloud-fixture.js";
import { remember } from "./helpers.js";

let cloud: Cloud;
beforeEach(async () => {
  cloud = await makeCloud();
});
afterEach(async () => {
  await cloud.accounts.settled();
  await cloud.close();
  removeTempDirs();
});

/** Crash simulation: make one step throw once, the way a process death between steps leaves the task. */
function crashAt(step: string) {
  const proto = WorkspacesService.prototype as unknown as {
    beforeStep(kind: string, s: string): void;
  };
  const original = proto.beforeStep;
  let fired = false;
  proto.beforeStep = function (kind: string, s: string) {
    if (!fired && s === step) {
      fired = true;
      throw Object.assign(new Error("simulated crash"), { code: "SIMULATED_CRASH" });
    }
    return original.call(this, kind, s);
  };
  return () => {
    proto.beforeStep = original;
  };
}

async function invite(
  owner: Awaited<ReturnType<typeof signedUpBrowser>>,
  role: "editor" | "viewer",
) {
  const email = uniqueEmail(role);
  await owner.browser.post("/api/v1/workspace/invitations", { email, role });
  const token = remember(
    decodeURIComponent(
      String(cloud.mailer.last(email, "invitation")?.data.url).split("#token=")[1] ?? "",
    ),
  );
  const member = await signedUpBrowser(cloud, { email });
  expect(
    (await member.browser.post("/api/v1/workspace/invitations/accept", { token })).status,
  ).toBe(200);
  return member;
}

describe("export", () => {
  it("owner + re-auth; a valid database file; one download within 24 h; other owners and members get 404", async () => {
    const owner = await signedUpBrowser(cloud);
    await cloud.registry.with(owner.accountId as string, (r) =>
      (r as FakeRuntime).addHousehold("h", SENTINEL_HOUSEHOLD, 1),
    );
    expect((await owner.browser.post("/api/v1/workspace/export")).body).toMatchObject({
      error: { code: "REAUTH_REQUIRED" },
    });
    await owner.browser.post("/api/v1/auth/reauth", { password: owner.password });
    const ex = await owner.browser.post("/api/v1/workspace/export");
    expect(ex.status).toBe(202);
    const exportId = String(ex.body.exportId);
    await cloud.outbox.drain();
    expect(cloud.mailer.to(owner.email, "export-ready")).toHaveLength(1);
    const status = (b: typeof owner.browser) =>
      b.get(`/api/v1/workspace/exports/${exportId}/status`);
    // The status does not use the download up.
    expect((await status(owner.browser)).body).toMatchObject({ status: "ready" });
    expect((await status(owner.browser)).body).toMatchObject({ status: "ready" });
    const other = await signedUpBrowser(cloud);
    expect((await other.browser.get(`/api/v1/workspace/exports/${exportId}`)).status).toBe(404);
    // Another workspace learns nothing: the id does not exist there.
    expect((await status(other.browser)).status).toBe(404);
    const member = await invite(owner, "editor");
    expect((await member.browser.get(`/api/v1/workspace/exports/${exportId}`)).status).toBe(403);
    expect(
      (await owner.browser.get("/api/v1/workspace/exports/../../control/control.db")).status,
    ).toBe(404);
    const res = await cloud.app.request(`/api/v1/workspace/exports/${exportId}`, {
      headers: { cookie: [...owner.browser.jar].map(([k, v]) => `${k}=${v}`).join("; ") },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toMatch(
      /^attachment; filename="glideworth-workspace-/,
    );
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes.subarray(0, 15).toString()).toBe("SQLite format 3");
    const path = `${cloud.dataDir}/check.db`;
    (await import("node:fs")).writeFileSync(path, bytes);
    const db = new Database(path, { readonly: true });
    expect((db.prepare("SELECT name FROM households").get() as { name: string }).name).toBe(
      SENTINEL_HOUSEHOLD,
    );
    db.close();
    await new Promise((r) => setTimeout(r, 20));
    expect(existsSync(`${cloud.dataDir}/exports/${exportId}.db`)).toBe(false);
    expect((await owner.browser.get(`/api/v1/workspace/exports/${exportId}`)).status).toBe(404); // single download
    // The link in the email can now say so.
    expect((await status(owner.browser)).body).toMatchObject({ status: "downloaded" });
    expect((await status(member.browser)).status).toBe(403);
  });

  it("expires after 24 hours", async () => {
    const owner = await signedUpBrowser(cloud);
    await owner.browser.post("/api/v1/auth/reauth", { password: owner.password });
    const ex = await owner.browser.post("/api/v1/workspace/export");
    cloud.advance(24 * 3600_000 + 1000);
    // Keep the session alive across the jump by signing in again.
    const b = new Browser(cloud.app);
    await b.post("/api/v1/auth/signin", { email: owner.email, password: owner.password });
    remember(b.jar.get("__Host-gw_session") as string);
    expect(
      (await b.get(`/api/v1/workspace/exports/${ex.body.exportId}/status`)).body,
    ).toMatchObject({ status: "expired" });
    expect((await b.get(`/api/v1/workspace/exports/${ex.body.exportId}`)).status).toBe(404);
    expect(cloud.workspaces.sweepExports()).toBeGreaterThanOrEqual(1);
  });
});

describe("workspace deletion", () => {
  it("owner, re-auth, typed name; data, key, backups, rows go; tombstone and emails remain", async () => {
    const owner = await signedUpBrowser(cloud);
    const id = owner.accountId as string;
    const member = await invite(owner, "viewer");
    await cloud.backups.backupTenant(id);
    expect(
      (await owner.browser.del("/api/v1/workspace", { confirmName: "My workspace" })).body,
    ).toMatchObject({
      error: { code: "REAUTH_REQUIRED" },
    });
    await owner.browser.post("/api/v1/auth/reauth", { password: owner.password });
    expect(
      (await owner.browser.del("/api/v1/workspace", { confirmName: "my workspace" })).status,
    ).toBe(400);
    expect(
      (await member.browser.del("/api/v1/workspace", { confirmName: "My workspace" })).status,
    ).toBe(403);
    expect(
      (await owner.browser.del("/api/v1/workspace", { confirmName: "My workspace" })).status,
    ).toBe(204);
    const row = cloud.db.select().from(accounts).where(eq(accounts.id, id)).get();
    expect(row).toMatchObject({ status: "deleted", name: null, ownerUserId: null });
    expect(row?.deletedAt).toBeTruthy();
    expect(existsSync(cloud.registry.pathFor(id))).toBe(false);
    expect(
      cloud.db.select().from(tenantKeys).where(eq(tenantKeys.accountId, id)).get()?.wrappedDek,
    ).toBeNull();
    expect(cloud.db.select().from(backups).where(eq(backups.accountId, id)).all()).toHaveLength(0);
    expect([...cloud.store.objects.keys()].some((k) => k.includes(id))).toBe(false);
    expect(
      cloud.db.select().from(memberships).where(eq(memberships.accountId, id)).all(),
    ).toHaveLength(0);
    expect(
      cloud.db.select().from(tenantSchedules).where(eq(tenantSchedules.accountId, id)).all(),
    ).toHaveLength(0);
    expect(
      cloud.db.select().from(subscriptions).where(eq(subscriptions.accountId, id)).get(),
    ).toBeTruthy(); // accounting
    expect(cloud.db.select().from(lifecycleTasks).all()).toHaveLength(0);
    await cloud.outbox.drain();
    expect(cloud.mailer.to(owner.email, "account-deleted")).toHaveLength(1);
    expect(cloud.mailer.to(member.email, "account-deleted")).toHaveLength(1);
    expect((await member.browser.get("/api/v1/whoami")).status).toBe(403);
  });

  it("a subscribed workspace is canceled at Stripe immediately, without proration", async () => {
    const owner = await signedUpBrowser(cloud);
    const id = owner.accountId as string;
    const r = await owner.browser.post("/api/v1/billing/checkout", {
      lookupKey: "cloud_monthly_v1",
    });
    for (const ev of cloud.fake.completeCheckout(String(r.body.url).split("/").at(-1) as string)) {
      const signed = cloud.fake.sign(ev, "whsec_test_cloud_fixture_secret");
      await cloud.app.request("/stripe/webhook", {
        method: "POST",
        headers: { "stripe-signature": signed.header },
        body: signed.body,
      });
    }
    await owner.browser.post("/api/v1/auth/reauth", { password: owner.password });
    expect(
      (await owner.browser.del("/api/v1/workspace", { confirmName: "My workspace" })).status,
    ).toBe(204);
    expect(cloud.fake.callsTo("cancelSubscription")[0]?.args[1]).toEqual({
      prorate: false,
      invoiceNow: false,
    });
    expect(
      cloud.db.select().from(subscriptions).where(eq(subscriptions.accountId, id)).get()?.status,
    ).toBe("canceled");
  });

  for (const step of ["destroy_files", "shred_keys", "control_rows", "notify", "finish"]) {
    it(`a crash before "${step}" leaves the workspace inaccessible and resumeLifecycle finishes it`, async () => {
      const owner = await signedUpBrowser(cloud);
      const id = owner.accountId as string;
      await owner.browser.post("/api/v1/auth/reauth", { password: owner.password });
      const restore = crashAt(step);
      try {
        expect(
          (await owner.browser.del("/api/v1/workspace", { confirmName: "My workspace" })).status,
        ).toBe(204);
      } finally {
        restore();
      }
      const task = cloud.db.select().from(lifecycleTasks).get();
      expect(task).toMatchObject({
        kind: "workspace_delete",
        subjectId: id,
        step,
        attempts: 1,
        lastErrorCode: "SIMULATED_CRASH",
      });
      expect(cloud.db.select().from(accounts).where(eq(accounts.id, id)).get()?.status).toBe(
        "deleting",
      );
      expect(() => cloud.registry.acquire(id)).toThrow(/no such workspace/);
      expect(await cloud.workspaces.resumeLifecycle()).toEqual({ completed: 1, failed: 0 });
      expect(cloud.db.select().from(accounts).where(eq(accounts.id, id)).get()?.status).toBe(
        "deleted",
      );
      expect(existsSync(cloud.registry.pathFor(id))).toBe(false);
      expect(cloud.db.select().from(lifecycleTasks).all()).toHaveLength(0);
      await cloud.outbox.drain();
      expect(cloud.mailer.to(owner.email, "account-deleted")).toHaveLength(1); // exactly once
    });
  }
});

describe("user deletion (finding 5)", () => {
  it("a sole owner is deleted with their workspace through the internal path; trial grant kept", async () => {
    const u = await signedUpBrowser(cloud);
    const id = u.accountId as string;
    await u.browser.post("/api/v1/auth/reauth", { password: u.password });
    expect((await u.browser.del("/api/v1/account")).status).toBe(204);
    expect(cloud.db.select().from(users).where(eq(users.id, u.userId)).get()).toBeUndefined();
    expect(cloud.db.select().from(accounts).where(eq(accounts.id, id)).get()?.status).toBe(
      "deleted",
    );
    expect(cloud.db.select().from(trialGrants).all()).toHaveLength(1);
    expect(
      cloud.db
        .select()
        .from(mailOutbox)
        .where(eq(mailOutbox.userId, u.userId))
        .all()
        .every((r) => r.status !== "pending"),
    ).toBe(true);
    expect((await u.browser.get("/api/v1/auth/status")).body.authenticated).toBe(false);
  });

  it("refused while the owned workspace has other members; members leave cleanly", async () => {
    const owner = await signedUpBrowser(cloud);
    const member = await invite(owner, "editor");
    await owner.browser.post("/api/v1/auth/reauth", { password: owner.password });
    expect((await owner.browser.del("/api/v1/account")).status).toBe(409);
    await member.browser.post("/api/v1/auth/reauth", { password: member.password });
    expect((await member.browser.del("/api/v1/account")).status).toBe(204);
    const lease = cloud.registry.acquire(owner.accountId as string);
    expect((lease.runtime as FakeRuntime).members.list().map((m) => m.tenantUserId)).toEqual([
      "owner",
    ]);
    lease.release();
  });

  it("a crash mid-way: the user is already signed out and disabled; resume completes the deletion", async () => {
    const u = await signedUpBrowser(cloud);
    const other = new Browser(cloud.app);
    await other.post("/api/v1/auth/signin", { email: u.email, password: u.password });
    remember(other.jar.get("__Host-gw_session") as string);
    await u.browser.post("/api/v1/auth/reauth", { password: u.password });
    const restore = crashAt("user_row");
    try {
      expect((await u.browser.del("/api/v1/account")).status).toBe(204); // accepted; finished on resume
    } finally {
      restore();
    }
    expect(
      cloud.db.select().from(users).where(eq(users.id, u.userId)).get()?.disabledAt,
    ).toBeTruthy();
    expect((await other.get("/api/v1/auth/status")).body.authenticated).toBe(false);
    expect(
      (
        await new Browser(cloud.app).post("/api/v1/auth/signin", {
          email: u.email,
          password: u.password,
        })
      ).status,
    ).toBe(401);
    expect(await cloud.workspaces.resumeLifecycle()).toEqual({ completed: 1, failed: 0 });
    expect(cloud.db.select().from(users).where(eq(users.id, u.userId)).get()).toBeUndefined();
    expect(cloud.db.select().from(lifecycleTasks).all()).toHaveLength(0);
  });
});
