import { describe, expect, it } from "vitest";
import type { FakeStripeGateway } from "../src/gateway/fake.js";
import { memoryLimiter } from "../src/limiter.js";
import { MemoryBillingStore } from "../src/memory-store.js";
import { BillingService } from "../src/service.js";
import type {
  BillingNotice,
  StripeEventView,
  StripeGateway,
  StripeSubscriptionView,
} from "../src/types.js";
import { type Harness, harness, permutations, rng, SECRET } from "./helpers.js";

function cloneStore(src: MemoryBillingStore): MemoryBillingStore {
  const s = new MemoryBillingStore();
  for (const [k, v] of src.subscriptions) s.subscriptions.set(k, structuredClone(v));
  for (const [k, v] of src.customers) s.customers.set(k, v);
  for (const [k, v] of src.owners) s.owners.set(k, v);
  return s;
}

/** Delivers `events` in the given order to a fresh copy of `initial`; returns the final record and notices. */
async function run(
  h: Harness,
  initial: MemoryBillingStore,
  events: StripeEventView[],
  gateway: StripeGateway = h.fake,
) {
  const store = cloneStore(initial);
  const notices: BillingNotice[] = [];
  const service = new BillingService({
    gateway,
    store,
    pricing: h.cfg,
    publicUrl: "https://app.glideworth.test",
    webhookSecret: SECRET,
    portalConfigurationId: h.portalConfigurationId,
    notify: async (n) => {
      notices.push(n);
    },
    limiter: memoryLimiter(h.clock.now),
    now: h.clock.now,
  });
  for (const e of events) {
    const { body, header } = h.fake.sign(e, SECRET);
    const out = await service.handleWebhook(body, header);
    if (out.status !== 200) throw new Error(`delivery failed: ${out.result}`);
  }
  h.fake.calls = [];
  return { record: store.getSubscription("tacct1"), notices, store };
}

const sortNotices = (ns: BillingNotice[]) => ns.map((n) => JSON.stringify(n)).sort();

/** A realistic lifecycle: subscribe, renewal fails, card updated and paid, then cancel at period end. */
async function lifecycle() {
  const h = await harness();
  h.service.openAccount("tacct1", false);
  const { subscriptionId, events: checkout } = await h.subscribe("tacct1");
  // The store as it is after checkout created the customer, before any webhook arrived.
  const initial = cloneStore(h.store);
  h.clock.advance(30 * 86_400_000);
  const failed = h.fake.failNextInvoice(subscriptionId);
  h.clock.advance(2 * 86_400_000);
  const paid = h.fake.payLatestInvoice(subscriptionId);
  h.clock.advance(86_400_000);
  const cancel = h.fake.cancelAtPeriodEnd(subscriptionId);
  return { h, initial, subscriptionId, events: [...checkout, ...failed, ...paid, ...cancel] };
}

describe("out-of-order delivery converges (design 4.3: state is re-fetched)", () => {
  it("every permutation of 7 lifecycle events gives the same record and the same notices", async () => {
    const { h, initial, events } = await lifecycle();
    const seven = events.slice(0, 7);
    expect(seven.map((e) => e.type)).toEqual([
      "customer.subscription.created",
      "invoice.paid",
      "checkout.session.completed",
      "invoice.payment_failed",
      "customer.subscription.updated",
      "invoice.paid",
      "customer.subscription.updated",
    ]);
    const reference = await run(h, initial, seven);
    expect(reference.record).toMatchObject({
      status: "active",
      cancelAtPeriodEnd: true,
      pastDueSince: null,
    });
    expect(reference.record?.stripeUpdated).toBe(Math.max(...seven.map((e) => e.created)));
    let count = 0;
    for (const order of permutations(seven)) {
      const out = await run(h, initial, order);
      expect(out.record).toEqual(reference.record);
      expect(sortNotices(out.notices)).toEqual(sortNotices(reference.notices));
      count++;
    }
    expect(count).toBe(5040);
  }, 60_000);

  it("property: random orders of all events with random duplicates converge", async () => {
    const { h, initial, events } = await lifecycle();
    const reference = await run(h, initial, events);
    const random = rng(20261116);
    for (let i = 0; i < 300; i++) {
      const order = [...events];
      for (let j = order.length - 1; j > 0; j--) {
        const k = Math.floor(random() * (j + 1));
        [order[j], order[k]] = [order[k] as StripeEventView, order[j] as StripeEventView];
      }
      const dupes = order.filter(() => random() < 0.3);
      const out = await run(
        h,
        initial,
        [...order, ...dupes].sort(() => random() - 0.5),
      );
      expect(out.record).toEqual(reference.record);
      expect(sortNotices(out.notices)).toEqual(sortNotices(reference.notices));
    }
  }, 60_000);

  it("resubscribing after a cancellation: every order ends on the new subscription", async () => {
    const h = await harness();
    const first = await h.subscribe("tacct1");
    const withCustomer = cloneStore(h.store);
    h.clock.advance(60_000);
    const canceled = h.fake.setSubscription(first.subscriptionId, { status: "canceled" });
    h.clock.advance(11 * 60_000);
    const second = await h.subscribe("tacct1");
    expect(second.subscriptionId).not.toBe(first.subscriptionId);
    const events = [...first.events, canceled, ...second.events];
    for (const order of permutations(events)) {
      const out = await run(h, withCustomer, order);
      expect(out.record).toMatchObject({
        stripeSubscriptionId: second.subscriptionId,
        status: "active",
      });
    }
  }, 60_000);

  it("updated before created, and an older event after a newer one, converge to the fetched state", async () => {
    const { h, initial, events, subscriptionId } = await lifecycle();
    const created = events.find((e) => e.type === "customer.subscription.created");
    const lastUpdate = events.findLast((e) => e.type === "customer.subscription.updated");
    if (!created || !lastUpdate) throw new Error("fixture");
    const out = await run(h, initial, [lastUpdate, created]);
    expect(out.record).toMatchObject({
      stripeSubscriptionId: subscriptionId,
      status: "active",
      cancelAtPeriodEnd: true,
    });
    expect(out.record?.stripeUpdated).toBe(lastUpdate.created);
  });
});

describe("concurrent handlers", () => {
  /** A gateway whose first `retrieveSubscription` returns `stale` after `gate` resolves. */
  function slowStaleGateway(
    fake: FakeStripeGateway,
    stale: StripeSubscriptionView,
    gate: Promise<void>,
  ) {
    let first = true;
    const g = Object.create(fake) as FakeStripeGateway;
    g.retrieveSubscription = async (id: string) => {
      if (first) {
        first = false;
        await gate;
        return stale;
      }
      return fake.retrieveSubscription(id);
    };
    return g;
  }

  it("two processes: a slow handler with an older event cannot overwrite newer state (monotonic stamp)", async () => {
    const h = await harness();
    const { subscriptionId, events } = await h.subscribe("tacct1");
    await h.deliverAll(events);
    h.clock.advance(1000);
    const older = h.fake.setSubscription(subscriptionId, { cancelAtPeriodEnd: true });
    const stale = await h.fake.retrieveSubscription(subscriptionId);
    h.clock.advance(5000);
    const newer = h.fake.setSubscription(subscriptionId, { status: "canceled" });

    let open!: () => void;
    const gate = new Promise<void>((r) => {
      open = r;
    });
    const make = (gateway: StripeGateway) =>
      new BillingService({
        gateway,
        store: h.store,
        pricing: h.cfg,
        publicUrl: "https://app.glideworth.test",
        webhookSecret: SECRET,
        portalConfigurationId: h.portalConfigurationId,
        notify: async () => {},
        limiter: () => true,
        now: h.clock.now,
      });
    const processA = make(slowStaleGateway(h.fake, stale, gate));
    const processB = make(h.fake);
    const a = h.fake.sign(older, SECRET);
    const b = h.fake.sign(newer, SECRET);
    const pending = processA.handleWebhook(a.body, a.header);
    await processB.handleWebhook(b.body, b.header);
    open();
    await pending;
    expect(h.store.getSubscription("tacct1")?.status).toBe("canceled");
    expect(h.store.rejectedSaves).toBe(1);
  });

  it("one process: handlers for the same customer are serialised, so even same-second events converge", async () => {
    const h = await harness();
    const { subscriptionId, events } = await h.subscribe("tacct1");
    await h.deliverAll(events);
    h.clock.advance(1000);
    const e1 = h.fake.setSubscription(subscriptionId, { cancelAtPeriodEnd: true });
    const stale = await h.fake.retrieveSubscription(subscriptionId);
    const e2 = h.fake.setSubscription(subscriptionId, { status: "canceled" });
    expect(e1.created).toBe(e2.created);

    let open!: () => void;
    const gate = new Promise<void>((r) => {
      open = r;
    });
    const service = new BillingService({
      gateway: slowStaleGateway(h.fake, stale, gate),
      store: h.store,
      pricing: h.cfg,
      publicUrl: "https://app.glideworth.test",
      webhookSecret: SECRET,
      portalConfigurationId: h.portalConfigurationId,
      notify: async () => {},
      limiter: () => true,
      now: h.clock.now,
    });
    const a = h.fake.sign(e1, SECRET);
    const b = h.fake.sign(e2, SECRET);
    const first = service.handleWebhook(a.body, a.header);
    const second = service.handleWebhook(b.body, b.header);
    // The slow handler resumes only after the second one had every chance to finish. Without the per-customer
    // lock the second would write the fresh state first and the stale write (same `created` second, so not
    // rejected by the stamp) would win.
    setTimeout(open, 25);
    await Promise.all([first, second]);
    expect(h.store.getSubscription("tacct1")?.status).toBe("canceled");
  });
});
