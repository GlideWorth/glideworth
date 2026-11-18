/**
 * Product rules from the terms of service (docs/launch/legal-decisions.md section 3) in cloud mode:
 *  - sign-up requires an explicit adults-only confirmation, recorded with its time;
 *  - unpaid-trial and cancelled workspaces are deleted 12 months later, after warnings 30 and 7 days before;
 *  - the hosted API reference loads nothing from another origin;
 *  - check-in emails carry counts and kinds of change only, never a figure, name or notification title.
 * Plus the cloud surface: self-host-only routes absent, OAuth sign-in through the cloud account.
 */
import { existsSync } from "node:fs";
import { controlSchema } from "@glideworth/cloud";
import { SECURITY_TXT } from "@glideworth/cloud/security-txt";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { checkinEmailData } from "../src/cloud-host.js";
import { renderApiReference } from "../src/docs-page.js";
import { renewalReminderSweep } from "../src/renewals.js";
import { retentionSweep, twelveMonthsAfter, workspaceAuditSweep } from "../src/retention.js";
import {
  addMember,
  apiKey,
  bootCloud,
  CAPTCHA,
  Client,
  type Cloud,
  lastMail,
  PASSWORD,
  PUBLIC_URL,
  reauth,
  signUp,
  tokenIn,
  uniqueEmail,
} from "./cloud-harness.js";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

let cloud: Cloud;
beforeAll(async () => {
  cloud = await bootCloud();
}, 120_000);
afterAll(() => cloud?.close(), 120_000);

describe("sign-up", () => {
  it("requires the 18-or-over confirmation and records when it was given", async () => {
    const b = new Client(cloud);
    const email = uniqueEmail("adult");
    const body = {
      email,
      password: PASSWORD,
      name: "Robin",
      captchaToken: CAPTCHA,
      termsVersion: "2026-11",
    };
    for (const adultConfirmed of [undefined, false, "yes"]) {
      const r = await b.post("/api/v1/auth/signup", { ...body, adultConfirmed });
      expect(r.status).toBe(400);
      expect(r.json.error.code).toBe("VALIDATION");
      expect(r.json.error.details.fields).toContain("adultConfirmed");
    }
    const before = Date.now();
    expect((await b.post("/api/v1/auth/signup", { ...body, adultConfirmed: true })).status).toBe(
      202,
    );
    await cloud.rt.accounts.settled();
    const row = cloud.rt.db
      .select()
      .from(controlSchema.users)
      .where(eq(controlSchema.users.emailNormalized, email.toLowerCase()))
      .get();
    expect(row?.adultConfirmedAt).toBeTruthy();
    expect(Date.parse(row?.adultConfirmedAt as string)).toBeGreaterThanOrEqual(before - 1000);
  });
});

describe("email verification (security review finding 6)", () => {
  const OTHER_PASSWORD = "a different long passphrase 77";
  /** Submit the sign-up form in `b`; returns the token of the verification link that was mailed. */
  const submit = async (b: Client, email: string, password = PASSWORD) => {
    const r = await b.post("/api/v1/auth/signup", {
      email,
      password,
      name: "Robin Example",
      captchaToken: CAPTCHA,
      termsVersion: "2026-11",
      adultConfirmed: true,
    });
    expect(r.status).toBe(202);
    await cloud.rt.accounts.settled();
    return { res: r, token: tokenIn(lastMail(cloud, email, "verify-email")?.text ?? "") };
  };
  const verify = (
    b: Client,
    token: string,
    more: { password?: string; captchaToken?: string } = {},
  ) => b.post("/api/v1/auth/verify", { token, ...more });
  const signIn = (email: string, password: string) =>
    new Client(cloud).post("/api/v1/auth/signin", { email, password });
  const verified = (email: string) =>
    !!cloud.rt.db
      .select()
      .from(controlSchema.users)
      .where(eq(controlSchema.users.emailNormalized, email.toLowerCase()))
      .get()?.emailVerifiedAt;

  it("the browser that signed up verifies with the link alone; its cookie is __Host-, HttpOnly, Lax, 48 hours", async () => {
    const b = new Client(cloud);
    const email = uniqueEmail("same");
    const { res, token } = await submit(b, email);
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith("__Host-gw_signup="));
    expect(cookie).toMatch(/^__Host-gw_signup=[A-Za-z0-9_-]{43}; /);
    for (const attr of ["Max-Age=172800", "Path=/", "HttpOnly", "Secure", "SameSite=Lax"])
      expect(cookie).toContain(`; ${attr}`);
    expect(cookie).not.toMatch(/Domain=/i);

    const v = await verify(b, token);
    expect(v.status).toBe(200);
    expect(v.json.status).toBe("signed-in");
    expect((await b.get("/api/v1/auth/status")).json.user.email).toBe(email);

    // A sign-up for an address that already has an account answers the same, cookie included.
    const again = await submit(new Client(cloud), uniqueEmail("fresh"));
    const existing = await new Client(cloud).post("/api/v1/auth/signup", {
      email,
      password: OTHER_PASSWORD,
      name: "Robin Example",
      captchaToken: CAPTCHA,
      termsVersion: "2026-11",
      adultConfirmed: true,
    });
    expect(existing.status).toBe(202);
    expect(existing.json).toEqual(again.res.json);
    expect(existing.headers.getSetCookie().some((c) => c.startsWith("__Host-gw_signup="))).toBe(
      true,
    );
  });

  it("another browser is asked for the password; a wrong one fails without using up the link", async () => {
    const email = uniqueEmail("other");
    const { token } = await submit(new Client(cloud), email);
    const phone = new Client(cloud);

    const ask = await verify(phone, token);
    expect(ask.status).toBe(403);
    expect(ask.json.error.code).toBe("PASSWORD_REQUIRED");
    expect(phone.jar.has("__Host-gw_session")).toBe(false);

    const wrong = await verify(phone, token, { password: OTHER_PASSWORD });
    const wrongSignIn = await signIn(uniqueEmail("nobody"), OTHER_PASSWORD);
    expect(wrong.status).toBe(401);
    expect(wrong.json).toEqual(wrongSignIn.json);
    expect(verified(email)).toBe(false);

    const right = await verify(phone, token, { password: PASSWORD });
    expect(right.status).toBe(200);
    expect((await phone.get("/api/v1/auth/status")).json.workspace?.id).toBeTruthy();
    // Used up now, and a dead link says the same thing with or without a password.
    for (const more of [{}, { password: PASSWORD }, { password: OTHER_PASSWORD }]) {
      const dead = await verify(new Client(cloud), token, more);
      expect(dead.status).toBe(400);
      expect(dead.json.error.code).toBe("INVALID_TOKEN");
    }
  });

  it("a later sign-up by someone else no longer leaves the person with that someone's password", async () => {
    const email = uniqueEmail("victim");
    const victim = new Client(cloud);
    const attacker = new Client(cloud);
    const first = await submit(victim, email, PASSWORD);
    // The attacker repeats the sign-up with their own password. The newest sign-up still wins.
    const second = await submit(attacker, email, OTHER_PASSWORD);
    expect((await verify(victim, first.token)).status).toBe(400);

    // The victim clicks the newer email. Before the fix this signed them in to an account the attacker
    // could open; now it asks for a password, and the one the victim chose is not it.
    const click = await verify(victim, second.token);
    expect(click.status).toBe(403);
    expect(click.json.error.code).toBe("PASSWORD_REQUIRED");
    expect((await verify(victim, second.token, { password: PASSWORD })).status).toBe(401);
    expect(victim.jar.has("__Host-gw_session")).toBe(false);
    expect(verified(email)).toBe(false);
    // The attacker has a password but no inbox: nothing verified to sign in to, and no link to follow.
    const a = await signIn(email, OTHER_PASSWORD);
    expect(a.status).toBe(403);
    expect(a.json.error.code).toBe("EMAIL_NOT_VERIFIED");

    // A resend from the victim's browser does not move the link to them: it stays with the browser that
    // set the current password.
    expect((await victim.post("/api/v1/auth/resend-verification", { email })).status).toBe(202);
    await cloud.rt.accounts.settled();
    const resent = tokenIn(lastMail(cloud, email, "verify-email")?.text ?? "");
    expect(resent).not.toBe(second.token);
    expect((await verify(victim, resent)).json.error.code).toBe("PASSWORD_REQUIRED");

    // The victim signs up again (the squatter cannot block them) and their own link works at once.
    const third = await submit(victim, email, PASSWORD);
    expect((await verify(victim, third.token)).status).toBe(200);
    expect((await signIn(email, OTHER_PASSWORD)).status).toBe(401);
    expect((await signIn(email, PASSWORD)).status).toBe(200);
  });

  it("a resent link opens without the password in the browser that signed up", async () => {
    const email = uniqueEmail("resend");
    const b = new Client(cloud);
    const first = await submit(b, email);
    // Asked for from somewhere else (a phone, the operator console): same binding.
    expect(
      (await new Client(cloud).post("/api/v1/auth/resend-verification", { email })).status,
    ).toBe(202);
    await cloud.rt.accounts.settled();
    const resent = tokenIn(lastMail(cloud, email, "verify-email")?.text ?? "");
    expect(resent).not.toBe(first.token);
    expect((await verify(new Client(cloud), resent)).json.error.code).toBe("PASSWORD_REQUIRED");
    expect((await verify(b, resent)).status).toBe(200);
  });

  it("wrong passwords on a link count against the sign-in limits: a CAPTCHA after five", async () => {
    const email = uniqueEmail("guess");
    const { token } = await submit(new Client(cloud), email);
    const guesser = new Client(cloud);
    for (let i = 0; i < 5; i++)
      expect((await verify(guesser, token, { password: `${OTHER_PASSWORD} ${i}` })).status).toBe(
        401,
      );
    const sixth = await verify(guesser, token, { password: PASSWORD });
    expect(sixth.status).toBe(403);
    expect(sixth.json.error.code).toBe("CAPTCHA_REQUIRED");
    expect(verified(email)).toBe(false);
    // Same counter as sign-in for this address and client.
    const s = await guesser.post("/api/v1/auth/signin", { email, password: PASSWORD });
    expect(s.json.error.code).toBe("CAPTCHA_REQUIRED");
    // Never a lock-out: with the CAPTCHA the right password still verifies.
    const ok = await verify(guesser, token, { password: PASSWORD, captchaToken: CAPTCHA });
    expect(ok.status).toBe(200);
  });
});

describe("cookie-authenticated writes on workspace routes", () => {
  it("need the CSRF header and a same-origin request; bearer credentials never fall back to cookies", async () => {
    const owner = await signUp(cloud, { name: "Csrf Owner" });
    const b = owner.browser;
    const noCsrf = await b.post("/api/v1/households", {}, { csrf: false });
    expect(noCsrf.status).toBe(403);
    expect(noCsrf.json.error.code).toBe("CSRF");
    const foreign = await b.post(
      "/api/v1/households",
      {},
      { headers: { origin: "https://evil.example" } },
    );
    expect(foreign.status).toBe(403);
    const crossSite = await b.post(
      "/api/v1/households",
      {},
      { headers: { "sec-fetch-site": "cross-site" } },
    );
    expect(crossSite.status).toBe(403);
    // /mcp never accepts the session cookie.
    const mcp = await b.post("/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(mcp.status).toBe(401);
    expect(mcp.headers.get("www-authenticate")).toContain("resource_metadata=");
  });
});

describe("API keys from a browser session", () => {
  it("a write-scoped key needs a re-authentication in the last 10 minutes; a read key does not", async () => {
    const owner = await signUp(cloud, { name: "Key Maker" });
    cloud.rt.db
      .update(controlSchema.sessions)
      .set({ reauthAt: new Date(Date.now() - 3600_000).toISOString() })
      .where(eq(controlSchema.sessions.userId, owner.userId))
      .run();
    for (const path of ["/api/v1/me/keys", "/api/v1/keys"]) {
      const w = await owner.browser.post(path, { name: "w", scopes: ["read", "write"] });
      expect(w.status, w.text).toBe(403);
      expect(w.json.error.code).toBe("REAUTH_REQUIRED");
    }
    expect(
      (await owner.browser.post("/api/v1/me/keys", { name: "r", scopes: ["read"] })).status,
    ).toBe(201);
    expect((await owner.browser.post("/api/v1/auth/reauth", { password: PASSWORD })).status).toBe(
      200,
    );
    const ok = await owner.browser.post("/api/v1/me/keys", {
      name: "w",
      scopes: ["read", "write"],
    });
    expect(ok.status).toBe(201);
    expect(ok.json.key).toMatch(new RegExp(`^gwk_${owner.accountId}_[a-z2-7]{8}_[a-z2-7]{32,}$`));
  });
});

describe("retention (terms: deleted 12 months after an unpaid trial or a cancellation)", () => {
  const sub = (
    accountId: string,
    patch: Partial<typeof controlSchema.subscriptions.$inferInsert>,
  ) =>
    cloud.rt.db
      .update(controlSchema.subscriptions)
      .set(patch)
      .where(eq(controlSchema.subscriptions.accountId, accountId))
      .run();
  const status = (accountId: string) =>
    cloud.rt.db
      .select({ s: controlSchema.accounts.status })
      .from(controlSchema.accounts)
      .where(eq(controlSchema.accounts.id, accountId))
      .get()?.s;
  const at = (iso: string) => new Date(iso);

  it("warns 30 and 7 days before, never earlier than promised, then deletes", async () => {
    const owner = await signUp(cloud, { name: "Lapsed Owner" });
    const id = owner.accountId as string;
    sub(id, { trialEndsAt: "2025-01-01T00:00:00.000Z" });
    expect(twelveMonthsAfter("2025-01-01T00:00:00.000Z").toISOString()).toBe(
      "2026-01-01T00:00:00.000Z",
    );
    const sent = () =>
      cloud.transport.sent.filter(
        (m) => m.to.email === owner.email && m.template === "deletion-warning",
      );
    const mails = () => sent().length;
    const run = async (iso: string) => {
      const r = await retentionSweep(cloud.rt, at(iso));
      await cloud.rt.outbox.drain();
      return r;
    };
    expect((await run("2025-11-15T00:00:00Z")).warned).toBe(0);
    expect((await run("2025-12-05T00:00:00Z")).warned).toBeGreaterThanOrEqual(1);
    expect(mails()).toBe(1);
    expect(sent()[0]?.text).toContain("in 30 days");
    expect(sent()[0]?.text).toContain("/settings/billing");
    expect(sent()[0]?.text).toContain("/settings/workspace");
    expect((await run("2025-12-06T00:00:00Z")).deleted).toBe(0);
    // The deletion moved to 30 days after the first warning (2026-01-04); the 7-day warning comes before it.
    await run("2025-12-29T00:00:00Z");
    expect(mails()).toBe(2);
    expect(sent()[1]?.text).toContain("in 7 days");
    expect((await run("2026-01-03T00:00:00Z")).deleted).toBe(0);
    expect(status(id)).toBe("active");
    const tenantDir = cloud.rt.registry.pathFor(id);
    expect(existsSync(tenantDir)).toBe(true);
    const done = await run("2026-01-06T00:00:00Z");
    expect(done.deleted).toBeGreaterThanOrEqual(1);
    expect(status(id)).toBe("deleted");
    expect(existsSync(tenantDir)).toBe(false);
  });

  it("a first sweep long after the date still warns first (never deletes without both warnings)", async () => {
    const owner = await signUp(cloud, { name: "Old Lapsed" });
    const id = owner.accountId as string;
    sub(id, { trialEndsAt: "2020-01-01T00:00:00.000Z" });
    await retentionSweep(cloud.rt, at("2026-06-01T00:00:00Z"));
    expect(status(id)).toBe("active");
    await retentionSweep(cloud.rt, at("2026-06-20T00:00:00Z"));
    expect(status(id)).toBe("active");
    await retentionSweep(cloud.rt, at("2026-06-30T00:00:00Z")); // 7-day warning
    expect(status(id)).toBe("active");
    await retentionSweep(cloud.rt, at("2026-07-08T00:00:00Z"));
    expect(status(id)).toBe("deleted");
  });

  it("paying stops the clock; trials still running, paid and cancelled-but-paid-up workspaces are kept", async () => {
    const paid = await signUp(cloud, { name: "Paid Owner" });
    const trial = await signUp(cloud, { name: "Trial Owner" });
    const cancelled = await signUp(cloud, { name: "Cancelled Owner" });
    sub(paid.accountId as string, {
      status: "active",
      trialEndsAt: "2020-01-01T00:00:00.000Z",
      stripeSubscriptionId: "sub_paid_1",
      currentPeriodEnd: "2099-01-01T00:00:00.000Z",
    });
    sub(cancelled.accountId as string, {
      status: "canceled",
      trialEndsAt: null,
      currentPeriodEnd: "2026-10-01T00:00:00.000Z",
      canceledAt: "2026-09-01T00:00:00.000Z",
    });
    const r = await retentionSweep(cloud.rt, at("2027-08-01T00:00:00Z"));
    expect(status(paid.accountId as string)).toBe("active");
    expect(status(trial.accountId as string)).toBe("active");
    // Cancelled: 12 months after the last paid period (2027-10-01); in August only the 30-day warning is
    // too early, nothing happens yet.
    expect(status(cancelled.accountId as string)).toBe("active");
    expect(r.deleted).toBe(0);
    const warn = await retentionSweep(cloud.rt, at("2027-09-05T00:00:00Z"));
    expect(warn.warned).toBeGreaterThanOrEqual(1);
    await cloud.rt.outbox.drain();
    expect(
      cloud.transport.sent.some(
        (m) => m.to.email === cancelled.email && m.template === "deletion-warning",
      ),
    ).toBe(true);
    // Subscribing again stops it.
    sub(cancelled.accountId as string, { status: "active", stripeSubscriptionId: "sub_back_1" });
    await retentionSweep(cloud.rt, at("2028-01-01T00:00:00Z"));
    expect(status(cancelled.accountId as string)).toBe("active");
  });
});

describe("workspace audit log (privacy policy: covers the latest 400 days)", () => {
  it("the daily sweep trims every live workspace, even one that writes little", async () => {
    const written = Date.now();
    const owner = await signUp(cloud, { name: "Quiet Owner" });
    const id = owner.accountId as string;
    const entries = () =>
      cloud.rt.registry.with(id, (r) => r.services.audit.list({ limit: 500 }).length);
    await cloud.rt.registry.with(id, (r) =>
      r.services.audit.record({ via: "system", action: "test.retention" }),
    );
    const before = await entries();
    expect(before).toBeGreaterThanOrEqual(1);
    const DAY = 86_400_000;
    const first = await workspaceAuditSweep(cloud.rt, new Date(written - 60_000 + 400 * DAY));
    expect(first).toMatchObject({ ok: true, failed: 0 });
    expect(await entries()).toBe(before);
    const later = await workspaceAuditSweep(cloud.rt, new Date(Date.now() + 400 * DAY + 60_000));
    expect(later.ok).toBe(true);
    expect(later.count).toBeGreaterThanOrEqual(before);
    expect(await entries()).toBe(0);
  });
});

describe("renewal reminder (terms: we email you before an annual renewal)", () => {
  const yearlyKey = () =>
    cloud.rt.pricing.products.flatMap((p) => p.prices).find((p) => p.interval === "year")
      ?.lookupKey as string;
  const monthlyKey = () =>
    cloud.rt.pricing.products.flatMap((p) => p.prices).find((p) => p.interval === "month")
      ?.lookupKey as string;
  const setSub = (id: string, patch: Partial<typeof controlSchema.subscriptions.$inferInsert>) =>
    cloud.rt.db
      .update(controlSchema.subscriptions)
      .set(patch)
      .where(eq(controlSchema.subscriptions.accountId, id))
      .run();
  const reminders = (email: string) =>
    cloud.transport.sent.filter((m) => m.to.email === email && m.template === "renewal-reminder");

  it("emails the date and a link, never an amount, once per period, only for annual renewals", async () => {
    const yearly = await signUp(cloud, { name: "Yearly Owner" });
    const monthly = await signUp(cloud, { name: "Monthly Owner" });
    const cancelling = await signUp(cloud, { name: "Cancelling Owner" });
    const far = await signUp(cloud, { name: "Far Owner" });
    const base = { status: "active", stripeSubscriptionId: "sub_x" } as const;
    setSub(yearly.accountId as string, {
      ...base,
      stripeSubscriptionId: "sub_ren_1",
      priceLookupKey: yearlyKey(),
      currentPeriodEnd: "2027-03-10T00:00:00.000Z",
    });
    setSub(monthly.accountId as string, {
      ...base,
      stripeSubscriptionId: "sub_ren_2",
      priceLookupKey: monthlyKey(),
      currentPeriodEnd: "2027-03-10T00:00:00.000Z",
    });
    setSub(cancelling.accountId as string, {
      ...base,
      stripeSubscriptionId: "sub_ren_3",
      priceLookupKey: yearlyKey(),
      cancelAtPeriodEnd: true,
      currentPeriodEnd: "2027-03-10T00:00:00.000Z",
    });
    setSub(far.accountId as string, {
      ...base,
      stripeSubscriptionId: "sub_ren_4",
      priceLookupKey: yearlyKey(),
      currentPeriodEnd: "2027-09-10T00:00:00.000Z",
    });
    expect((await renewalReminderSweep(cloud.rt, new Date("2027-03-01T00:00:00Z"))).sent).toBe(0);
    expect((await renewalReminderSweep(cloud.rt, new Date("2027-03-04T00:00:00Z"))).sent).toBe(1);
    await cloud.rt.outbox.drain();
    expect(reminders(monthly.email)).toHaveLength(0);
    expect(reminders(cancelling.email)).toHaveLength(0);
    expect(reminders(far.email)).toHaveLength(0);
    const [mail] = reminders(yearly.email);
    expect(mail?.text).toContain("10 March 2027");
    expect(mail?.text).toContain(`${PUBLIC_URL}/settings/billing`);
    expect(mail?.text).not.toMatch(/[£$€]\s?\d/);
    expect((await renewalReminderSweep(cloud.rt, new Date("2027-03-05T00:00:00Z"))).sent).toBe(0);
    // The next period gets its own reminder.
    setSub(yearly.accountId as string, { currentPeriodEnd: "2028-03-10T00:00:00.000Z" });
    expect((await renewalReminderSweep(cloud.rt, new Date("2028-03-05T00:00:00Z"))).sent).toBe(1);
  });
});

describe("the hosted API reference", () => {
  it("is server-rendered with no script and nothing from another origin", async () => {
    const r = await new Client(cloud).get("/docs");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(r.text).not.toMatch(
      /<script|cdn\.|jsdelivr|unpkg|https?:\/\/(?!app\.glideworth\.test)/i,
    );
    expect(r.text).toContain("/api/v1/plans/{id}");
  });

  it("answers /docs/ with a redirect to /docs, not a page under the docs CSP (issue #11)", async () => {
    const r = await new Client(cloud).get("/docs/");
    expect(r.status).toBe(308);
    expect(r.headers.get("location")).toBe("/docs");
  });

  it("escapes everything it renders", () => {
    const html = renderApiReference({
      info: { title: "<img src=x onerror=alert(1)>", version: "1", description: "**b** `c`" },
      paths: { "/x": { get: { summary: "<script>", tags: ["T"], responses: {} } } },
    });
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script>");
    expect(html).toContain("<strong>b</strong>");
  });

  it("wraps long tokens and scrolls wide tables inside themselves on a phone", () => {
    const html = renderApiReference({ info: { title: "T", version: "1" }, paths: {} });
    // `gwk_<workspace>_<prefix>_<secret>` and header names otherwise widen the page past 390px.
    expect(html).toMatch(/code,[^{]*\{overflow-wrap:anywhere\}/);
    expect(html).toContain("table{display:block;max-width:100%;overflow-x:auto}");
  });
});

describe("check-in emails", () => {
  it("carry counts and kinds only", () => {
    const d = checkinEmailData(
      {
        at: "2026-11-16T00:00:00.000Z",
        plansChecked: 2,
        changeKinds: ["behind-plan", "success-rate-change", "behind-plan"],
      },
      "Robin",
      PUBLIC_URL,
    );
    expect(d).toEqual({
      name: "Robin",
      plansChecked: 2,
      changeKinds: ["behind-plan", "success-rate-change"],
      url: `${PUBLIC_URL}/checkins`,
    });
  });
});

describe("the cloud surface", () => {
  it("has no passphrase or instance-user routes, and OAuth sends people to the cloud sign-in", async () => {
    const doc = (await (await fetch(`${cloud.base}/openapi.json`)).json()) as {
      paths: Record<string, unknown>;
    };
    for (const p of [
      "/api/v1/users",
      "/api/v1/auth/setup",
      "/api/v1/auth/login",
      "/api/v1/auth/accept",
      "/api/v1/auth/change-passphrase",
    ])
      expect(Object.keys(doc.paths)).not.toContain(p);
    expect(Object.keys(doc.paths)).toContain("/api/v1/auth/signup");
    const anon = new Client(cloud);
    expect((await anon.post("/oauth/login", {})).status).toBe(404);
    const reg = await anon.post("/oauth/register", { redirect_uris: ["https://c.example/cb"] });
    const q = new URLSearchParams({
      response_type: "code",
      client_id: reg.json.client_id,
      redirect_uri: "https://c.example/cb",
      code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      code_challenge_method: "S256",
      scope: "read",
      _r: "1",
    });
    const r = await anon.get(`/oauth/authorize?${q}`);
    expect(r.status).toBe(302);
    const loc = r.headers.get("location") as string;
    expect(loc.startsWith("/signin?next=%2Foauth%2Fauthorize")).toBe(true);
    // A signed-in person sees the consent page with their workspaces.
    const owner = await signUp(cloud, { name: "Consenting Owner" });
    const page = await owner.browser.get(`/oauth/authorize?${q}`);
    expect(page.status).toBe(200);
    expect(page.text).toContain(owner.accountId as string);
    expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
  });

  it("is kept out of search engines: disallow-all robots.txt and X-Robots-Tag on every response (issue #20)", async () => {
    const anon = new Client(cloud);
    const robots = await anon.get("/robots.txt");
    expect(robots.status).toBe(200);
    expect(robots.headers.get("content-type")).toMatch(/^text\/plain/);
    expect(robots.text).toBe("User-agent: *\nDisallow: /\n");
    for (const p of [
      "/robots.txt",
      "/health",
      "/openapi.json",
      "/api/v1/plans",
      "/oauth/authorize",
    ])
      expect((await anon.get(p)).headers.get("x-robots-tag"), p).toBe("noindex, nofollow");
  });

  it("serves the RFC 9116 security.txt with this host's Canonical and the shared fields", async () => {
    const r = await new Client(cloud).get("/.well-known/security.txt");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toMatch(/^text\/plain/);
    const lines = r.text.split("\n");
    expect(lines).toContain("Contact: mailto:security@glideworth.com");
    expect(lines).toContain(
      "Contact: https://github.com/GlideWorth/glideworth/security/advisories/new",
    );
    expect(lines).toContain(`Expires: ${SECURITY_TXT.expires}`);
    expect(lines).toContain("Preferred-Languages: en");
    expect(lines).toContain(
      `Canonical: ${PUBLIC_URL.replace(/\/+$/, "")}/.well-known/security.txt`,
    );
    expect(lines).toContain("Policy: https://glideworth.com/security/");
    expect(r.text).not.toContain("PGP SIGNED");
  });

  it("development builds expose fake checkout completion (loopback only; unknown session = 400)", async () => {
    const r = await new Client(cloud).post("/__dev/billing/complete-checkout", {
      sessionId: "cs_test_x",
    });
    // The test client connects from 127.0.0.1 (allowed); the session does not exist in the fake.
    expect(r.status).toBe(400);
  });
});

describe("the account name inside workspaces (QA 12)", () => {
  it("a rename shows at once in the workspace's API key list, the members list and on the person's keys", async () => {
    const owner = await signUp(cloud, { name: "Olive Owner" });
    const accountId = owner.accountId as string;
    const member = await addMember(cloud, owner.browser, accountId, "viewer", "Ada Tester");
    const key = await apiKey(member.browser, ["read"]);
    const keyNames = async () =>
      (await owner.browser.get("/api/v1/keys")).json.items.map(
        (k: { userName: string | null }) => k.userName,
      );
    expect(await keyNames()).toContain("Ada Tester");

    const r = await member.browser.patch("/api/v1/account/profile", { name: "Ada Lovelace" });
    expect(r.status, r.text).toBe(200);

    expect(await keyNames()).toContain("Ada Lovelace");
    expect(await keyNames()).not.toContain("Ada Tester");
    const me = await member.browser.withBearer(key).get("/api/v1/me");
    expect(me.json.userName).toBe("Ada Lovelace");
    const members = await owner.browser.get("/api/v1/workspace/members");
    expect(members.json.items.map((m: { name: string }) => m.name)).toContain("Ada Lovelace");
    // The role is untouched.
    expect(me.json.role).toBe("viewer");
  });
});

describe("account deletion (QA 14)", () => {
  it("sends a confirmation to the account's address", async () => {
    const p = await signUp(cloud, { name: "Dee Leted" });
    expect((await reauth(p.browser)).status).toBe(200);
    const del = await p.browser.del("/api/v1/account");
    expect(del.status, del.text).toBe(204);
    await cloud.rt.accounts.settled();
    const mail = lastMail(cloud, p.email, "user-account-deleted");
    expect(mail?.subject).toBe("Your Glideworth account has been deleted");
    expect(mail?.text).toContain("Hello Dee Leted,");
    expect(mail?.text).toContain("Your Glideworth account was deleted on");
  });
});
