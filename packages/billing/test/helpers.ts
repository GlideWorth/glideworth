import { fileURLToPath } from "node:url";
import { FakeStripeGateway } from "../src/gateway/fake.js";
import { memoryLimiter } from "../src/limiter.js";
import { MemoryBillingStore } from "../src/memory-store.js";
import { loadPricingConfig, type PricingConfig } from "../src/pricing.js";
import { BillingService, type BillingServiceDeps } from "../src/service.js";
import { syncPricing } from "../src/sync.js";
import type {
  BillingLogFields,
  BillingNotice,
  StripeEventView,
  WebhookOutcome,
} from "../src/types.js";

export const EXAMPLE_PRICING_PATH = fileURLToPath(
  new URL("../pricing.example.json", import.meta.url),
);
export const SECRET = "whsec_test_secret_for_unit_tests_only";
export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
export const T0 = Date.parse("2026-11-16T12:00:00.000Z");

export function pricing(): PricingConfig {
  return loadPricingConfig(EXAMPLE_PRICING_PATH);
}

export class Clock {
  constructor(public t: number = T0) {}
  now = (): Date => new Date(this.t);
  advance(ms: number): void {
    this.t += ms;
  }
  set(iso: string | number): void {
    this.t = typeof iso === "number" ? iso : Date.parse(iso);
  }
}

export interface Harness {
  clock: Clock;
  fake: FakeStripeGateway;
  store: MemoryBillingStore;
  service: BillingService;
  cfg: PricingConfig;
  notices: BillingNotice[];
  logs: Array<{ level: string; event: string; fields: BillingLogFields }>;
  portalConfigurationId: string;
  deliver(event: StripeEventView): Promise<WebhookOutcome>;
  deliverAll(events: StripeEventView[]): Promise<WebhookOutcome[]>;
  /** Owner-initiated checkout through the service, then completed in the fake. */
  subscribe(
    accountId: string,
    lookupKey?: string,
  ): Promise<{ subscriptionId: string; events: StripeEventView[] }>;
}

export const OWNER = (accountId: string) => ({
  email: `owner-${accountId}@example.test`,
  name: `Owner ${accountId}`,
});

export async function harness(
  o: { deps?: Partial<BillingServiceDeps>; accounts?: string[] } = {},
): Promise<Harness> {
  const clock = new Clock();
  const fake = new FakeStripeGateway({ now: clock.now });
  const store = new MemoryBillingStore();
  const cfg = pricing();
  const sync = await syncPricing(fake, cfg, {
    apply: true,
    archiveRemoved: false,
    returnUrl: "https://app.test/x",
  });
  const portalConfigurationId = sync.portalConfigurationId ?? "";
  fake.calls = [];
  for (const a of o.accounts ?? ["tacct1", "tacct2"]) store.addAccount(a, OWNER(a));
  const notices: BillingNotice[] = [];
  const logs: Harness["logs"] = [];
  const service = new BillingService({
    gateway: fake,
    store,
    pricing: cfg,
    publicUrl: "https://app.glideworth.test",
    webhookSecret: SECRET,
    portalConfigurationId,
    notify: async (n) => {
      notices.push(n);
    },
    limiter: memoryLimiter(clock.now),
    now: clock.now,
    log: (level, event, fields) => logs.push({ level, event, fields }),
    ...o.deps,
  });
  const deliver = (event: StripeEventView) => {
    const { body, header } = fake.sign(event, SECRET);
    return service.handleWebhook(body, header);
  };
  const deliverAll = async (events: StripeEventView[]) => {
    const out: WebhookOutcome[] = [];
    for (const e of events) out.push(await deliver(e));
    return out;
  };
  const subscribe = async (accountId: string, lookupKey = "cloud_monthly_v1") => {
    const owner = OWNER(accountId);
    await service.createCheckout({
      accountId,
      ownerEmail: owner.email,
      ownerName: owner.name,
      lookupKey,
      ip: "203.0.113.9",
    });
    const session = [...fake.sessions.values()].findLast(
      (s) => s.client_reference_id === accountId,
    );
    if (!session) throw new Error("no session");
    const events = fake.completeCheckout(session.id);
    const subscriptionId = fake.sessions.get(session.id)?.subscription;
    if (!subscriptionId) throw new Error("no subscription");
    return { subscriptionId, events };
  };
  return {
    clock,
    fake,
    store,
    service,
    cfg,
    notices,
    logs,
    portalConfigurationId,
    deliver,
    deliverAll,
    subscribe,
  };
}

/** Every ordering of `xs` (Heap's algorithm). */
export function* permutations<T>(xs: readonly T[]): Generator<T[]> {
  const a = [...xs];
  const c = new Array<number>(a.length).fill(0);
  yield [...a];
  let i = 1;
  while (i < a.length) {
    if ((c[i] ?? 0) < i) {
      const j = i % 2 === 0 ? 0 : (c[i] ?? 0);
      [a[j], a[i]] = [a[i] as T, a[j] as T];
      yield [...a];
      c[i] = (c[i] ?? 0) + 1;
      i = 1;
    } else {
      c[i] = 0;
      i++;
    }
  }
}

/** Deterministic PRNG (mulberry32) for property-style tests. */
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
