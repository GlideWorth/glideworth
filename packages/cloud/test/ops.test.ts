/**
 * Operator console (spec 6.3): private listener only, password + mandatory TOTP, CSRF, audit of every view and
 * action, no tenant financial data on any page, escaping, strict headers, support access only through a live
 * owner-created grant, session idle expiry.
 */
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { accounts, auditEvents, operators } from "../src/control/schema.js";
import { base32Decode } from "../src/crypto/random.js";
import { hotp, totpStep } from "../src/crypto/totp.js";
import { createOpsApp } from "../src/ops/app.js";
import { OperatorService } from "../src/ops/operators.js";
import {
  type Cloud,
  type FakeRuntime,
  makeCloud,
  removeTempDirs,
  SENTINEL_AMOUNT,
  SENTINEL_HOUSEHOLD,
  signedUpBrowser,
  strongPassword,
  uniqueEmail,
} from "./cloud-fixture.js";
import { remember } from "./helpers.js";

type Server = ReturnType<typeof serve>;
let cloud: Cloud;
let servers: Server[] = [];
let opsBase = "";
let publicBase = "";

const listen = (fetch: (r: Request, env?: unknown) => Response | Promise<Response>) =>
  new Promise<{ server: Server; port: number }>((resolve) => {
    const server = serve(
      { fetch: fetch as never, hostname: "127.0.0.1", port: 0 },
      (info: AddressInfo) => resolve({ server, port: info.port }),
    );
    servers.push(server);
  });

beforeEach(async () => {
  cloud = await makeCloud();
  let bound: { port: number; address: string } | null = null;
  const app = createOpsApp(cloud.http, { boundTo: () => bound });
  const ops = await listen(app.fetch);
  bound = { port: ops.port, address: "127.0.0.1" };
  opsBase = `http://127.0.0.1:${ops.port}`;
  // The same app's fetch mounted on another listener (as if someone wired it to the public port).
  const pub = await listen(app.fetch);
  publicBase = `http://127.0.0.1:${pub.port}`;
});
afterEach(async () => {
  await Promise.all(
    servers.map(
      (s) =>
        new Promise<void>((r) => {
          s.close(() => r());
          (s as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
        }),
    ),
  );
  servers = [];
  await cloud.accounts.settled();
  await cloud.close();
  removeTempDirs();
});

async function operator(role: "admin" | "support" = "admin") {
  const svc = new OperatorService({
    db: cloud.db,
    keys: cloud.keys,
    limiter: cloud.limiter,
    audit: cloud.audit,
    now: cloud.now,
  });
  const email = uniqueEmail("op");
  const password = strongPassword();
  const r = await svc.create({ email, name: "Opal Operator", role, password });
  remember(r.totpSecret);
  const code = (offset = 0) =>
    hotp(base32Decode(r.totpSecret) as Uint8Array, totpStep(cloud.now().getTime()) + offset);
  return { email, password, code, id: r.id };
}

/** A browser for the console: cookies, form posts, no redirects followed. */
class OpsClient {
  jar = new Map<string, string>();
  csrf = "";
  constructor(readonly base: string) {}
  async req(
    method: string,
    path: string,
    form?: Record<string, string>,
    headers: Record<string, string> = {},
  ) {
    const h: Record<string, string> = { ...headers };
    if (this.jar.size) h.cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");
    let body: string | undefined;
    if (form) {
      body = new URLSearchParams(form).toString();
      h["content-type"] = "application/x-www-form-urlencoded";
      h.origin ??= this.base;
    }
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: h,
      redirect: "manual",
      ...(body ? { body } : {}),
    });
    for (const sc of res.headers.getSetCookie()) {
      const [pair] = sc.split(";");
      const [k, v] = (pair as string).split("=") as [string, string];
      if (/Max-Age=0/i.test(sc)) this.jar.delete(k);
      else this.jar.set(k, remember(v));
    }
    const text = await res.text();
    const m = /name="_csrf" value="([^"]+)"/.exec(text);
    if (m) this.csrf = m[1] as string;
    return {
      status: res.status,
      text,
      headers: res.headers,
      location: res.headers.get("location"),
    };
  }
  get = (p: string) => this.req("GET", p);
  post = (p: string, form: Record<string, string> = {}, headers?: Record<string, string>) =>
    this.req("POST", p, { _csrf: this.csrf, ...form }, headers);
  async login(o: { email: string; password: string; code: string }) {
    await this.get("/login");
    return this.post("/login", { email: o.email, password: o.password, code: o.code });
  }
}

describe("listener and sign-in", () => {
  it("serves nothing on any socket but the ops listener", async () => {
    const r = await fetch(`${publicBase}/login`);
    expect(r.status).toBe(404);
    expect(await r.text()).toBe("Not Found");
    expect((await fetch(`${opsBase}/login`)).status).toBe(200);
  });

  it("password alone is not enough; a correct code signs in once; the code cannot be replayed", async () => {
    const op = await operator();
    const c = new OpsClient(opsBase);
    expect((await c.login({ ...op, code: "" })).status).toBe(401);
    expect((await c.login({ ...op, code: "000000" })).status).toBe(401);
    expect((await c.login({ ...op, password: "wrong password!!", code: op.code() })).status).toBe(
      401,
    );
    const code = op.code();
    const ok = await c.login({ ...op, code });
    expect(ok.status).toBe(303);
    expect(ok.location).toBe("/");
    const cookie = ok.headers.getSetCookie().find((s) => s.startsWith("__Host-gw_ops="));
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/SameSite=Strict/);
    expect((await new OpsClient(opsBase).login({ ...op, code })).status).toBe(401);
    expect(
      cloud.db.select().from(auditEvents).where(eq(auditEvents.event, "operator.signin")).all(),
    ).toHaveLength(1);
    expect(
      cloud.db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.event, "operator.signin_failed"))
        .all().length,
    ).toBeGreaterThanOrEqual(3);
  });

  it("sign-in refuses a missing double-submit token and a cross-site origin", async () => {
    const op = await operator();
    const c = new OpsClient(opsBase);
    await c.get("/login");
    expect(
      (await c.req("POST", "/login", { email: op.email, password: op.password, code: op.code() }))
        .status,
    ).toBe(403);
    expect(
      (
        await c.post(
          "/login",
          { email: op.email, password: op.password, code: op.code() },
          { origin: "https://evil.example" },
        )
      ).status,
    ).toBe(403);
  });

  it("unauthenticated pages redirect to sign-in; sessions expire after 30 idle minutes", async () => {
    const c = new OpsClient(opsBase);
    expect((await c.get("/workspaces")).location).toBe("/login");
    const op = await operator();
    await c.login({ ...op, code: op.code() });
    expect((await c.get("/")).status).toBe(200);
    cloud.advance(31 * 60_000);
    expect((await c.get("/")).location).toBe("/login");
  });

  it("resetTotp: a new sealed secret, the old one stops working, every session ends, audited", async () => {
    const svc = new OperatorService({
      db: cloud.db,
      keys: cloud.keys,
      limiter: cloud.limiter,
      audit: cloud.audit,
      now: cloud.now,
    });
    const op = await operator();
    const other = await operator();
    const c = new OpsClient(opsBase);
    await c.login({ ...op, code: op.code() });
    const o = new OpsClient(opsBase);
    await o.login({ ...other, code: other.code() });
    expect((await c.get("/")).status).toBe(200);
    const before = cloud.db.select().from(operators).where(eq(operators.id, op.id)).get();

    const r = svc.resetTotp(op.email.toUpperCase());
    remember(r.totpSecret);
    expect(r.id).toBe(op.id);
    expect(r.totpSecret).toMatch(/^[A-Z2-7]{32}$/);
    expect(r.otpauthUri).toContain(`secret=${r.totpSecret}`);
    const after = cloud.db.select().from(operators).where(eq(operators.id, op.id)).get();
    expect(after?.totpSecretEnc).toMatch(/^v1\./);
    expect(after?.totpSecretEnc).not.toBe(before?.totpSecretEnc);
    expect(after?.totpSecretEnc).not.toContain(r.totpSecret);
    expect(after?.totpLastStep).toBeNull();

    // The operator's session is gone; another operator's is not.
    expect((await c.get("/")).location).toBe("/login");
    expect((await o.get("/")).status).toBe(200);
    // A code from the old secret no longer signs in; one from the new secret does.
    cloud.advance(60_000);
    expect((await new OpsClient(opsBase).login({ ...op, code: op.code() })).status).toBe(401);
    const fresh = hotp(base32Decode(r.totpSecret) as Uint8Array, totpStep(cloud.now().getTime()));
    expect((await new OpsClient(opsBase).login({ ...op, code: fresh })).status).toBe(303);

    const rows = cloud.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.event, "operator.action"))
      .all()
      .filter((e) => (e.detail as { action?: string } | null)?.action === "operator_totp_reset");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.detail).toEqual({ action: "operator_totp_reset", objectId: op.id, count: 1 });
    expect(JSON.stringify(rows)).not.toContain(r.totpSecret);

    expect(() => svc.resetTotp("nobody@example.org")).toThrow(/no operator/);
    svc.disable(other.email);
    expect(() => svc.resetTotp(other.email)).toThrow(/disabled/);
  });
});

describe("pages and actions", () => {
  async function signedInAdmin() {
    const op = await operator("admin");
    const c = new OpsClient(opsBase);
    await c.login({ ...op, code: op.code() });
    return { c, op };
  }

  it("no tenant financial data or workspace name on any page; values are escaped; strict headers", async () => {
    const owner = await signedUpBrowser(cloud);
    const id = owner.accountId as string;
    await owner.browser.patch("/api/v1/workspace/settings", {
      name: `Savings ${SENTINEL_AMOUNT} <script>alert(1)</script>`,
    });
    await cloud.registry.with(id, (r) =>
      (r as FakeRuntime).addHousehold("h1", SENTINEL_HOUSEHOLD, Number(SENTINEL_AMOUNT)),
    );
    await cloud.backups.backupTenant(id);
    const { c } = await signedInAdmin();
    const pages = [
      "/",
      "/workspaces",
      `/workspaces?q=${encodeURIComponent("<script>x</script>")}`,
      `/workspaces?q=${encodeURIComponent(owner.email)}`,
      `/workspaces/${id}`,
      `/users?q=${encodeURIComponent(owner.email)}`,
      `/users/${owner.userId}`,
      "/stripe-events",
    ];
    for (const p of pages) {
      const r = await c.get(p);
      expect([p, r.status]).toEqual([p, 200]);
      expect(r.text).not.toContain(SENTINEL_AMOUNT);
      expect(r.text).not.toContain(SENTINEL_HOUSEHOLD);
      expect(r.text).not.toContain("Savings");
      expect(r.text).not.toMatch(/<script/i);
      expect(r.headers.get("content-security-policy")).toMatch(/default-src 'none'/);
      expect(r.headers.get("content-security-policy")).not.toMatch(/script-src/);
      expect(r.headers.get("x-frame-options")).toBe("DENY");
      expect(r.headers.get("cache-control")).toBe("no-store");
      // Under "no-referrer" browsers post the forms with `Origin: null`, which the CSRF check refuses.
      expect(r.headers.get("referrer-policy")).toBe("same-origin");
      expect(r.text).not.toContain('content="no-referrer"');
    }
    expect(
      (await c.get(`/workspaces?q=${encodeURIComponent("<script>x</script>")}`)).text,
    ).toContain("&lt;script&gt;");
    expect((await c.get(`/workspaces/${id}`)).text).toContain(owner.email);
  });

  it("every view and action is audited; writes need the CSRF token", async () => {
    const owner = await signedUpBrowser(cloud);
    const id = owner.accountId as string;
    const { c, op } = await signedInAdmin();
    await c.get(`/workspaces/${id}`);
    expect((await c.req("POST", `/workspaces/${id}/suspend`, { _csrf: "wrong" })).status).toBe(403);
    expect(cloud.db.select().from(accounts).where(eq(accounts.id, id)).get()?.status).toBe(
      "active",
    );
    expect((await c.post(`/workspaces/${id}/suspend`)).status).toBe(303);
    expect(cloud.db.select().from(accounts).where(eq(accounts.id, id)).get()?.status).toBe(
      "suspended",
    );
    expect((await owner.browser.get("/api/v1/whoami")).status).toBe(403);
    await c.get(`/workspaces/${id}`);
    expect((await c.post(`/workspaces/${id}/unsuspend`)).status).toBe(303);
    expect((await c.post(`/workspaces/${id}/extend-trial`, { days: "7" })).status).toBe(404);
    expect((await c.post(`/workspaces/${id}/comp`, { until: "2027-01-01" })).status).toBe(303);
    const events = cloud.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.actorId, op.id))
      .all()
      .map((e) => [e.event, e.detail?.action ?? null]);
    expect(events).toEqual(
      expect.arrayContaining([
        ["operator.viewed_account", null],
        ["workspace.suspended", null],
        ["operator.action", "suspend"],
        ["operator.action", "unsuspend"],
        ["operator.action", "comp"],
      ]),
    );
    expect(cloud.entitlements.get(id).reason).toBe("comped");
  });

  it("support operators cannot run admin actions; the support view needs a live owner grant", async () => {
    const owner = await signedUpBrowser(cloud);
    const id = owner.accountId as string;
    await cloud.registry.with(id, (r) =>
      (r as FakeRuntime).addHousehold("h1", SENTINEL_HOUSEHOLD, 1),
    );
    const sop = await operator("support");
    const s = new OpsClient(opsBase);
    await s.login({ ...sop, code: sop.code() });
    await s.get(`/workspaces/${id}`);
    expect((await s.post(`/workspaces/${id}/restore`)).status).toBe(403);
    expect((await s.get(`/workspaces/${id}/support-view`)).status).toBe(403);
    const { c } = await signedInAdmin();
    expect((await c.get(`/workspaces/${id}/support-view`)).status).toBe(403); // no grant yet
    const g = await owner.browser.post("/api/v1/workspace/support-grants", {
      reason: "import help",
      days: 2,
    });
    expect(g.status).toBe(201);
    cloud.http.supportView = (r) => ({
      sections: [
        { title: "Households", rows: (r as FakeRuntime).households().map((h) => [h.id, h.name]) },
      ],
    });
    const view = await c.get(`/workspaces/${id}/support-view`);
    expect(view.status).toBe(200);
    expect(view.text).toContain("SUPPORT VIEW");
    expect(view.text).toContain(SENTINEL_HOUSEHOLD); // the one place tenant data may appear, behind a grant
    expect(
      cloud.db.select().from(auditEvents).where(eq(auditEvents.event, "support_grant.used")).all(),
    ).toHaveLength(1);
    await cloud.outbox.drain();
    const notices = cloud.mailer.to(owner.email, "security-change");
    expect(notices).toHaveLength(1);
    expect(notices[0]?.data.change).toBe("support-access-used");
    await c.get(`/workspaces/${id}/support-view`); // a second view does not email again
    await cloud.outbox.drain();
    expect(cloud.mailer.to(owner.email, "security-change")).toHaveLength(1);
    await owner.browser.del(`/api/v1/workspace/support-grants/${g.body.id}`);
    expect((await c.get(`/workspaces/${id}/support-view`)).status).toBe(403);
  });
});
