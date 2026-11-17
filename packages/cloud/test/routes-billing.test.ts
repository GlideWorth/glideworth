/**
 * T-BILL at the route level (spec 4, 10) and review findings 1-3: webhook forgery, staleness, replay,
 * duplicates and ordering; per-account single-writer across processes; one open checkout per account and a
 * duplicate-subscription alert; billing notices that survive a mail failure.
 */
import { BillingService, type StripeEventView, type StripeGateway } from "@glideworth/billing";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { billingNotifier } from "../src/billing/glue.js";
import { controlBillingStore } from "../src/control/billing-store.js";
import { openControlDb } from "../src/control/db.js";
import { MailOutbox } from "../src/control/outbox.js";
import { auditEvents, mailOutbox, stripeEvents, subscriptions } from "../src/control/schema.js";
import { withWriterLock } from "../src/control/writer-lock.js";
import { STRIPE_WEBHOOK_PER_MINUTE, webhookLockKey } from "../src/http/routes/billing.js";
import { controlDbPath } from "../src/tenancy/paths.js";
import {
  Browser,
  type Cloud,
  makeCloud,
  PUBLIC_URL,
  removeTempDirs,
  signedUpBrowser,
  uniqueEmail,
  WEBHOOK_SECRET,
} from "./cloud-fixture.js";
import { remember, testLog } from "./helpers.js";

let cloud: Cloud;
beforeEach(async () => {
  cloud = await makeCloud();
});
afterEach(async () => {
  await cloud.accounts.settled();
  await cloud.close();
  removeTempDirs();
});

const deliver = (
  ev: StripeEventView,
  o: { secret?: string; header?: string; body?: string; timestamp?: number } = {},
) => {
  const signed = cloud.fake.sign(
    ev,
    o.secret ?? WEBHOOK_SECRET,
    o.timestamp !== undefined ? { timestamp: o.timestamp } : {},
  );
  return cloud.app.request("/stripe/webhook", {
    method: "POST",
    headers: { "stripe-signature": o.header ?? signed.header, "content-type": "application/json" },
    body: o.body ?? signed.body,
  });
};

const sessionIdOf = (url: string) => url.split("/").at(-1) as string;
const sub = (id: string) =>
  cloud.db.select().from(subscriptions).where(eq(subscriptions.accountId, id)).get();

async function subscribed() {
  const owner = await signedUpBrowser(cloud);
  const r = await owner.browser.post("/api/v1/billing/checkout", { lookupKey: "cloud_monthly_v1" });
  expect(r.status).toBe(200);
  const events = cloud.fake.completeCheckout(sessionIdOf(String(r.body.url)));
  for (const ev of events) expect((await deliver(ev)).status).toBe(200);
  return {
    ...owner,
    id: owner.accountId as string,
    subscriptionId: sub(owner.accountId as string)?.stripeSubscriptionId as string,
  };
}

describe("webhook forgery", () => {
  it("missing, malformed, wrong-secret, stale and replayed-signature requests: 400 and no state change", async () => {
    const s = await subscribed();
    const before = sub(s.id);
    const ev = cloud.fake.setSubscription(s.subscriptionId, { status: "canceled" });
    const eventsBefore = cloud.db.select().from(stripeEvents).all().length;
    const signed = cloud.fake.sign(ev, WEBHOOK_SECRET);
    const now = Math.floor(cloud.now().getTime() / 1000);
    const cases: Array<Promise<Response> | Response> = [
      deliver(ev, { header: "" }),
      deliver(ev, { header: "t=abc,v1=zzz" }),
      deliver(ev, { secret: "whsec_wrong" }),
      deliver(ev, { timestamp: now - 3600 }),
      // A valid signature for another body (replayed header).
      deliver(ev, { header: signed.header, body: signed.body.replace('"canceled"', '"active"') }),
      cloud.app.request("/stripe/webhook", { method: "POST", body: "{}" }),
    ];
    for (const r of await Promise.all(cases)) expect(r.status).toBe(400);
    expect(sub(s.id)).toEqual(before);
    expect(cloud.db.select().from(stripeEvents).all().length).toBe(eventsBefore);
  });

  it("an event for an unknown customer is orphaned (200, no state change) and alerts the operator", async () => {
    const before = cloud.db.select().from(subscriptions).all();
    const ev = cloud.fake.event("customer.deleted", { id: "cus_nobody" });
    expect((await deliver(ev)).status).toBe(200);
    expect(
      cloud.db.select().from(stripeEvents).where(eq(stripeEvents.id, ev.id)).get()?.status,
    ).toBe("orphaned");
    expect(cloud.db.select().from(subscriptions).all()).toEqual(before);
    expect(
      cloud.db.select().from(auditEvents).where(eq(auditEvents.event, "billing.alert")).all(),
    ).toHaveLength(1);
  });

  it("state comes from the re-fetched subscription, not the event body; duplicates apply once; order converges", async () => {
    const s = await subscribed();
    expect(sub(s.id)?.status).toBe("trialing"); // subscribed mid-trial: the local trial carries over
    // A body that claims "active" while Stripe says canceled: stored canceled.
    cloud.fake.setSubscription(s.subscriptionId, { status: "canceled" });
    const current = cloud.fake.subscriptions.get(s.subscriptionId) as unknown as Record<
      string,
      unknown
    >;
    const lie = cloud.fake.event("customer.subscription.updated", {
      ...current,
      id: s.subscriptionId,
      status: "active",
    });
    expect((await deliver(lie)).status).toBe(200);
    expect(sub(s.id)?.status).toBe("canceled");
    // Duplicate delivery: processed once.
    expect((await deliver(lie)).status).toBe(200);
    expect(
      cloud.db.select().from(stripeEvents).where(eq(stripeEvents.id, lie.id)).get()?.attempts,
    ).toBe(1);
  });
});

describe("finding 1: per-account single writer across processes", () => {
  it("interleaved handlers in two processes converge on Stripe’s latest state only with the lock", async () => {
    const s = await subscribed();
    const path = controlDbPath(cloud.dataDir);
    /**
     * Two "processes": two control-plane connections to the same file, two BillingService instances. Process 1
     * handles a newer event but fetches the subscription slowly (it reads `active`, then stalls); meanwhile the
     * subscription becomes past_due and process 2 handles an older-stamped event and stores past_due.
     */
    const run = async (useLock: boolean) => {
      cloud.fake.setSubscription(s.subscriptionId, { status: "active" });
      const base = sub(s.id);
      cloud.db
        .update(subscriptions)
        .set({ status: "active", stripeUpdated: 1, pastDueSince: null })
        .where(eq(subscriptions.accountId, s.id))
        .run();
      const c1 = openControlDb(path);
      const c2 = openControlDb(path);
      let releaseFetch!: () => void;
      const fetchGate = new Promise<void>((r) => {
        releaseFetch = r;
      });
      let fetched!: () => void;
      const fetchedOnce = new Promise<void>((r) => {
        fetched = r;
      });
      const slow: StripeGateway = new Proxy(cloud.fake, {
        get(t, p) {
          if (p === "retrieveSubscription")
            return async (id: string) => {
              const v = await t.retrieveSubscription(id);
              fetched();
              await fetchGate;
              return v;
            };
          const v = Reflect.get(t, p, t) as unknown;
          return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
        },
      });
      const svc = (db: typeof cloud.db, gateway: StripeGateway) =>
        new BillingService({
          gateway,
          store: controlBillingStore(db),
          pricing: cloud.pricing,
          publicUrl: PUBLIC_URL,
          webhookSecret: WEBHOOK_SECRET,
          portalConfigurationId: "bpc",
          notify: async () => {},
          limiter: () => true,
          now: cloud.now,
        });
      const p1 = svc(c1.db, slow);
      const p2 = svc(c2.db, cloud.fake);
      const nowS = Math.floor(cloud.now().getTime() / 1000);
      const newer = {
        ...cloud.fake.event("customer.subscription.updated", {
          id: s.subscriptionId,
          customer: base?.stripeCustomerId,
        }),
        created: nowS + 100,
      };
      const older = {
        ...cloud.fake.event("customer.subscription.updated", {
          id: s.subscriptionId,
          customer: base?.stripeCustomerId,
        }),
        created: nowS + 50,
      };
      const handle = (p: BillingService, db: typeof cloud.db, ev: StripeEventView) => {
        const signed = cloud.fake.sign(ev, WEBHOOK_SECRET);
        const go = () => p.handleWebhook(signed.body, signed.header);
        if (!useLock) return go();
        const key = webhookLockKey(signed.body, (c) =>
          controlBillingStore(db).accountForCustomer(c),
        );
        return withWriterLock(db, key as string, go);
      };
      const h1 = handle(p1, c1.db, newer);
      await fetchedOnce; // process 1 has read Stripe's state and stalls
      // The world changes after process 1 read it.
      cloud.fake.setSubscription(s.subscriptionId, { status: "past_due" });
      const h2 = handle(p2, c2.db, older);
      // Let process 2 run as far as it can, then release process 1.
      await new Promise((r) => setTimeout(r, 100));
      releaseFetch();
      await Promise.all([h1, h2]);
      const result = controlBillingStore(c1.db).getSubscription(s.id)?.status;
      c1.close();
      c2.close();
      return result;
    };
    // Without serialisation the slow, stale read wins (the bug the reviewers found).
    expect(await run(false)).toBe("active");
    // With the per-account writer lock the second handler waits, re-reads and stores Stripe's latest state.
    expect(await run(true)).toBe("past_due");
  });

  it("an unsigned request naming a workspace is refused at once, without waiting for its billing lock (security review finding 10)", async () => {
    const { accountId } = await signedUpBrowser(cloud);
    const id = accountId as string;
    let release: () => void = () => {};
    const held = withWriterLock(
      cloud.db,
      `billing:${id}`,
      () => new Promise<void>((r) => (release = r)),
    );
    try {
      await new Promise((r) => setTimeout(r, 20));
      const junk = JSON.stringify({
        id: "evt_junk",
        type: "customer.subscription.updated",
        data: { object: { metadata: { account_id: id }, client_reference_id: id } },
      });
      const t0 = Date.now();
      const r = await Promise.race([
        cloud.app.request("/stripe/webhook", {
          method: "POST",
          headers: { "stripe-signature": "t=1,v1=00", "content-type": "application/json" },
          body: junk,
        }),
        new Promise<"waited">((r) => setTimeout(() => r("waited"), 2_000)),
      ]);
      expect(r).not.toBe("waited");
      expect((r as Response).status).toBe(400);
      expect(Date.now() - t0).toBeLessThan(2_000);
    } finally {
      release();
      await held;
    }
  });

  it("a flood from one address is limited per address, high enough for Stripe's bursts (security review finding 10)", async () => {
    const post = (ip: string, header = "t=1,v1=00") =>
      cloud.app.request("/stripe/webhook", {
        method: "POST",
        headers: {
          "stripe-signature": header,
          "content-type": "application/json",
          "x-forwarded-for": ip,
        },
        body: "{}",
      });
    for (let i = 0; i < STRIPE_WEBHOOK_PER_MINUTE; i++)
      expect((await post("198.51.100.7")).status).toBe(400);
    const limited = await post("198.51.100.7");
    expect(limited.status).toBe(429);
    expect(((await limited.json()) as { error: { code: string } }).error.code).toBe("RATE_LIMITED");
    // Another address (Stripe sends from several) is not held up, and a signed event from it is processed.
    const s = await subscribed();
    const signed = cloud.fake.sign(
      cloud.fake.setSubscription(s.subscriptionId, { status: "past_due" }),
      WEBHOOK_SECRET,
    );
    const ok = await cloud.app.request("/stripe/webhook", {
      method: "POST",
      headers: {
        "stripe-signature": signed.header,
        "content-type": "application/json",
        "x-forwarded-for": "198.51.100.8",
      },
      body: signed.body,
    });
    expect(ok.status).toBe(200);
    expect(sub(s.id)?.status).toBe("past_due");
    // The window is a minute: the first address is served again after it.
    cloud.advance(61_000);
    expect((await post("198.51.100.7")).status).toBe(400);
  });

  it("a writer whose lease was taken over cannot write (fencing token + version check)", async () => {
    const s = await subscribed();
    const initial = sub(s.id)?.status;
    const store = controlBillingStore(cloud.db);
    // Version check: another writer changed the row after we read it inside our lease.
    await expect(
      withWriterLock(cloud.db, `billing:${s.id}`, async () => {
        const rec = store.getSubscription(s.id) as NonNullable<
          ReturnType<typeof store.getSubscription>
        >;
        cloud.db.run(sql`UPDATE subscriptions SET version = version + 1`);
        store.saveSubscription({ ...rec, status: "canceled", stripeUpdated: 2 ** 31 });
      }),
    ).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    expect(sub(s.id)?.status).toBe(initial);
    // Fencing: our lease expired and another process took it (new token); our write is refused.
    await expect(
      withWriterLock(cloud.db, `billing:${s.id}`, async () => {
        const rec = store.getSubscription(s.id) as NonNullable<
          ReturnType<typeof store.getSubscription>
        >;
        cloud.db.run(sql`UPDATE writer_locks SET token = token + 1, holder = 'another-process'`);
        store.saveSubscription({ ...rec, status: "canceled", stripeUpdated: 2 ** 31 });
      }),
    ).rejects.toMatchObject({ code: "LOCK_LOST" });
    expect(sub(s.id)?.status).toBe(initial);
  });
});

describe("finding 2: one open checkout per account, duplicate subscriptions alert", () => {
  it("the same price reuses the open session; another price expires it and opens a new one", async () => {
    const owner = await signedUpBrowser(cloud);
    const first = await owner.browser.post("/api/v1/billing/checkout", {
      lookupKey: "cloud_monthly_v1",
    });
    expect(first.body.reused).toBe(false);
    const again = await owner.browser.post("/api/v1/billing/checkout", {
      lookupKey: "cloud_monthly_v1",
    });
    expect(again.body).toMatchObject({ url: first.body.url, reused: true });
    // Back from Stripe, then the other period: the monthly session is expired on Stripe and a yearly one opens.
    const yearly = await owner.browser.post("/api/v1/billing/checkout", {
      lookupKey: "cloud_yearly_v1",
    });
    expect(yearly.status).toBe(200);
    expect(yearly.body.reused).toBe(false);
    expect(yearly.body.url).not.toBe(first.body.url);
    const firstId = sessionIdOf(String(first.body.url));
    expect(cloud.fake.sessions.get(firstId)?.status).toBe("expired");
    expect(cloud.fake.callsTo("expireCheckoutSession")).toHaveLength(1);
    // The session is short-lived: Stripe is asked to end it after about an hour, not the default 24 hours.
    const created = cloud.fake.callsTo("createCheckoutSession");
    const params = created.at(-1)?.args[0] as { expiresAt?: number };
    const nowS = cloud.now().getTime() / 1000;
    expect(params.expiresAt).toBeGreaterThanOrEqual(nowS + 3600);
    expect(params.expiresAt).toBeLessThanOrEqual(nowS + 4200);
    // Switching back within the same idempotency window gives a fresh monthly session, not the expired one.
    const monthly = await owner.browser.post("/api/v1/billing/checkout", {
      lookupKey: "cloud_monthly_v1",
    });
    expect(monthly.status).toBe(200);
    expect(monthly.body.url).not.toBe(first.body.url);
    expect(cloud.fake.sessions.get(sessionIdOf(String(monthly.body.url)))?.status).toBe("open");
    expect(cloud.fake.sessions.get(sessionIdOf(String(yearly.body.url)))?.status).toBe("expired");
    expect([...cloud.fake.sessions.values()].filter((x) => x.status === "open")).toHaveLength(1);
    // The expired-session webhooks Stripe sends are accepted and change nothing.
    for (const ev of cloud.fake.outbox.filter((e) => e.type === "checkout.session.expired"))
      expect((await deliver(ev)).status).toBe(200);
    // Completing it makes a live subscription; checkout is then refused outright.
    for (const ev of cloud.fake.completeCheckout(sessionIdOf(String(monthly.body.url))))
      await deliver(ev);
    const after = await owner.browser.post("/api/v1/billing/checkout", {
      lookupKey: "cloud_yearly_v1",
    });
    expect(after.body).toMatchObject({ error: { code: "ALREADY_SUBSCRIBED" } });
  });

  it("a session already completed on Stripe (webhook not yet here) blocks a checkout for the other price", async () => {
    const owner = await signedUpBrowser(cloud);
    const first = await owner.browser.post("/api/v1/billing/checkout", {
      lookupKey: "cloud_monthly_v1",
    });
    // Paid on Stripe, but the events have not been delivered.
    cloud.fake.completeCheckout(sessionIdOf(String(first.body.url)));
    const yearly = await owner.browser.post("/api/v1/billing/checkout", {
      lookupKey: "cloud_yearly_v1",
    });
    expect(yearly.status).toBe(409);
    expect(yearly.body).toMatchObject({ error: { code: "CHECKOUT_IN_PROGRESS" } });
    expect(cloud.fake.callsTo("createCheckoutSession")).toHaveLength(1);
    expect(
      cloud.db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.event, "billing.checkout_refused"))
        .all(),
    ).toHaveLength(1);
  });

  it("a session Stripe could not expire leaves the block in place and creates nothing", async () => {
    const owner = await signedUpBrowser(cloud);
    await owner.browser.post("/api/v1/billing/checkout", { lookupKey: "cloud_monthly_v1" });
    cloud.fake.failNext("expireCheckoutSession");
    const yearly = await owner.browser.post("/api/v1/billing/checkout", {
      lookupKey: "cloud_yearly_v1",
    });
    expect(yearly.status).toBeGreaterThanOrEqual(500);
    expect(cloud.fake.callsTo("createCheckoutSession")).toHaveLength(1);
  });

  it("a second live subscription for the account (two sessions completed) raises an operator alert", async () => {
    const s = await subscribed();
    // A session created outside this cell's guard (another cell, or before the guard): complete it too.
    const customer = sub(s.id)?.stripeCustomerId as string;
    const price = [...cloud.fake.prices.values()].find((p) => p.lookup_key === "cloud_yearly_v1")
      ?.id as string;
    const extra = await cloud.fake.createCheckoutSession(
      {
        customerId: customer,
        priceId: price,
        accountId: s.id,
        trialEnd: null,
        successUrl: `${PUBLIC_URL}/x`,
        cancelUrl: `${PUBLIC_URL}/x`,
        allowPromotionCodes: false,
        collectTaxIds: false,
      },
      "dup-session",
    );
    for (const ev of cloud.fake.completeCheckout(extra.id)) await deliver(ev);
    expect(sub(s.id)?.stripeSubscriptionId).toBe(s.subscriptionId); // the stored one is kept
    const alerts = cloud.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.event, "billing.duplicate_subscription"))
      .all();
    expect(alerts.length).toBeGreaterThan(0);
    expect(alerts[0]?.accountId).toBe(s.id);
  });

  it("checkout refuses non-owners, unknown and non-offered prices; status is visible to members", async () => {
    const owner = await signedUpBrowser(cloud);
    const email = uniqueEmail("viewer");
    await owner.browser.post("/api/v1/workspace/invitations", { email, role: "viewer" });
    const token = remember(
      decodeURIComponent(
        String(cloud.mailer.last(email, "invitation")?.data.url).split("#token=")[1] ?? "",
      ),
    );
    const viewer = await signedUpBrowser(cloud, { email });
    await viewer.browser.post("/api/v1/workspace/invitations/accept", { token });
    expect(
      (await viewer.browser.post("/api/v1/billing/checkout", { lookupKey: "cloud_monthly_v1" }))
        .status,
    ).toBe(403);
    expect(
      (await owner.browser.post("/api/v1/billing/checkout", { lookupKey: "nope_v1" })).status,
    ).toBe(400);
    const st = await viewer.browser.get("/api/v1/billing");
    expect(st.status).toBe(200);
    expect(st.body).toMatchObject({
      status: "trialing_local",
      role: "viewer",
      access: { level: "full" },
    });
    expect(st.text).not.toMatch(/card|last4/i);
    // The prices come from the pricing file: amount in minor units, currency, interval and tax behaviour.
    const offered = (st.body as { offered: Array<Record<string, unknown>> }).offered;
    expect(offered).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          lookupKey: "cloud_monthly_v1",
          interval: "month",
          unitAmount: 900,
          currency: "usd",
          taxBehavior: "exclusive",
        }),
        expect.objectContaining({
          lookupKey: "cloud_yearly_v1",
          interval: "year",
          unitAmount: 9000,
          currency: "usd",
          taxBehavior: "exclusive",
        }),
      ]),
    );
    for (const o of offered) {
      expect(typeof o.unitAmount).toBe("number");
      expect(typeof o.currency).toBe("string");
      expect(["month", "year"]).toContain(o.interval);
      expect(["inclusive", "exclusive"]).toContain(o.taxBehavior);
    }
  });
});

describe("finding 3: billing notices survive a mail failure", () => {
  it("the notice is queued in the same step as the claim and retried until sent", async () => {
    const owner = await signedUpBrowser(cloud);
    const id = owner.accountId as string;
    cloud.mailer.fail = true;
    // Trial ending: the billing sweep claims the notice and queues it.
    cloud.db
      .update(subscriptions)
      .set({ trialEndsAt: new Date(cloud.now().getTime() + 86_400_000).toISOString() })
      .where(eq(subscriptions.accountId, id))
      .run();
    expect((await cloud.billing.sweep()).noticesSent).toBe(1);
    await cloud.outbox.drain();
    let row = cloud.db
      .select()
      .from(mailOutbox)
      .where(eq(mailOutbox.template, "trial-ending"))
      .get();
    expect(row).toMatchObject({ status: "pending", attempts: 1, lastErrorCode: "TEST_FAILURE" });
    // The claim is spent: a second sweep does not queue it again, and the queued row is not lost.
    expect((await cloud.billing.sweep()).noticesSent).toBe(0);
    cloud.mailer.fail = false;
    await cloud.outbox.drain();
    expect(
      cloud.db.select().from(mailOutbox).where(eq(mailOutbox.template, "trial-ending")).get()
        ?.status,
    ).toBe("pending"); // backoff
    cloud.advance(61_000);
    await cloud.outbox.drain();
    row = cloud.db.select().from(mailOutbox).where(eq(mailOutbox.template, "trial-ending")).get();
    expect(row?.status).toBe("sent");
    // Two provider calls: the failed first attempt and the successful retry.
    expect(cloud.mailer.to(owner.email, "trial-ending")).toHaveLength(2);
  });

  it("dead after the attempt limit, logged for the operator; duplicates are enqueued once", async () => {
    const outbox = new MailOutbox({
      db: cloud.db,
      mailer: cloud.mailer,
      log: testLog,
      now: cloud.now,
    });
    cloud.mailer.fail = true;
    const email = uniqueEmail("dead");
    const data = { name: "N", billingUrl: `${PUBLIC_URL}/settings/billing` };
    expect(
      outbox.enqueue({ to: { email }, template: "trial-expired", data, dedupeKey: "k1" }),
    ).toBe(true);
    expect(
      outbox.enqueue({ to: { email }, template: "trial-expired", data, dedupeKey: "k1" }),
    ).toBe(false);
    for (let i = 0; i < 12; i++) {
      await outbox.drain();
      cloud.advance(7 * 3600_000);
    }
    expect(
      cloud.db.select().from(mailOutbox).where(eq(mailOutbox.dedupeKey, "k1")).get()?.status,
    ).toBe("dead");
    const { logLines } = await import("./helpers.js");
    expect(logLines.some((l) => l.includes("outbox.dead"))).toBe(true);
  });

  it("operator alerts (disputes) go to the audit trail, owner notices to the outbox", async () => {
    const notify = billingNotifier({
      db: cloud.db,
      outbox: cloud.outbox,
      audit: cloud.audit,
      log: testLog,
      publicUrl: PUBLIC_URL,
    });
    await notify({ kind: "dispute", accountId: null, stripeObjectId: "du_123" });
    expect(
      cloud.db.select().from(auditEvents).where(eq(auditEvents.event, "billing.dispute")).all(),
    ).toHaveLength(1);
  });
});

describe("read-only after a lapse, from Stripe", () => {
  it("canceled subscription: writes 402, reads and export work, nothing deleted", async () => {
    const s = await subscribed();
    for (const ev of cloud.fake.exhaustRetries(s.subscriptionId)) await deliver(ev);
    expect(cloud.entitlements.get(s.id)).toMatchObject({ level: "read_only" });
    const w = await s.browser.post("/api/v1/households", { id: "h", name: "n", netWorth: 1 });
    expect(w.status).toBe(402);
    expect((await s.browser.get("/api/v1/households")).status).toBe(200);
    await s.browser.post("/api/v1/auth/reauth", { password: s.password });
    expect((await s.browser.post("/api/v1/workspace/export")).status).toBe(202);
  });
});

describe("the unauthenticated surface", () => {
  it("billing routes need a session", async () => {
    const b = new Browser(cloud.app);
    expect((await b.get("/api/v1/billing")).status).toBe(401);
    expect(
      (await b.post("/api/v1/billing/checkout", { lookupKey: "cloud_monthly_v1" })).status,
    ).toBe(401);
  });
});
