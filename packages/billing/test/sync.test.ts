import { describe, expect, it } from "vitest";
import { WEBHOOK_ENABLED_EVENTS } from "../src/events.js";
import { FakeStripeGateway } from "../src/gateway/fake.js";
import { STRIPE_API_VERSION } from "../src/gateway/stripe.js";
import { syncPricing, syncWebhookEndpoint, WEBHOOK_DESCRIPTION } from "../src/sync.js";
import { pricing } from "./helpers.js";

const WRITES = ["createProduct", "createPrice", "setPriceActive", "upsertPortalConfiguration"];
const writes = (g: FakeStripeGateway) => g.calls.filter((c) => WRITES.includes(c.method));
const opts = { archiveRemoved: false, returnUrl: "https://app.test/settings/billing" };

describe("syncPricing", () => {
  it("dry run on an empty account: plans every create and writes nothing", async () => {
    const g = new FakeStripeGateway();
    const r = await syncPricing(g, pricing(), { ...opts, apply: false });
    expect(r).toEqual({
      created: [
        "product:gw_cloud",
        "price:cloud_monthly_v1",
        "price:cloud_yearly_v1",
        "portal:configuration (create, or update the one marked as managed)",
      ],
      unchanged: [],
      conflicts: [],
      archived: [],
      portalConfigurationId: null,
    });
    expect(writes(g)).toEqual([]);
    expect(g.products.size + g.prices.size + g.portalConfigurations.size).toBe(0);
  });

  it("apply creates with idempotency keys; a second run changes nothing and reuses the portal", async () => {
    const g = new FakeStripeGateway();
    const first = await syncPricing(g, pricing(), { ...opts, apply: true });
    expect(first.created).toEqual([
      "product:gw_cloud",
      "price:cloud_monthly_v1",
      "price:cloud_yearly_v1",
    ]);
    expect(first.portalConfigurationId).toMatch(/^bpc_/);
    expect(g.callsTo("createProduct")[0]?.args[1]).toBe("product:gw_cloud");
    expect(g.callsTo("createPrice").map((c) => c.args[1])).toEqual([
      "price:cloud_monthly_v1",
      "price:cloud_yearly_v1",
    ]);
    const monthly = [...g.prices.values()].find((p) => p.lookup_key === "cloud_monthly_v1");
    expect(monthly).toMatchObject({
      unit_amount: 900,
      currency: "usd",
      tax_behavior: "exclusive",
      recurring: { interval: "month" },
    });
    expect(monthly?.currency_options?.gbp).toEqual({ unit_amount: 900, tax_behavior: "inclusive" });

    g.calls = [];
    // Without passing the id: the adapter finds the managed configuration by its metadata marker.
    const second = await syncPricing(g, pricing(), { ...opts, apply: true });
    expect(second.created).toEqual([]);
    expect(second.conflicts).toEqual([]);
    expect(second.unchanged).toEqual([
      "product:gw_cloud",
      "price:cloud_monthly_v1",
      "price:cloud_yearly_v1",
      `portal:${first.portalConfigurationId}`,
    ]);
    expect(second.portalConfigurationId).toBe(first.portalConfigurationId);
    expect(g.portalConfigurations.size).toBe(1);
    expect(writes(g).map((c) => c.method)).toEqual(["upsertPortalConfiguration"]);
    expect(g.products.size).toBe(1);
    expect(g.prices.size).toBe(2);

    const third = await syncPricing(g, pricing(), {
      ...opts,
      apply: true,
      portalConfigurationId: first.portalConfigurationId ?? "",
    });
    expect(third.portalConfigurationId).toBe(first.portalConfigurationId);
  });

  it("dry run after apply reports everything unchanged", async () => {
    const g = new FakeStripeGateway();
    const applied = await syncPricing(g, pricing(), { ...opts, apply: true });
    g.calls = [];
    const r = await syncPricing(g, pricing(), {
      ...opts,
      apply: false,
      portalConfigurationId: applied.portalConfigurationId ?? "",
    });
    expect(r.created).toEqual([]);
    expect(r.unchanged).toContain(`portal:${applied.portalConfigurationId} (would be reconciled)`);
    expect(writes(g)).toEqual([]);
  });

  it("a changed amount, currency option or tax behaviour is a conflict, never an update", async () => {
    const g = new FakeStripeGateway();
    await syncPricing(g, pricing(), { ...opts, apply: true });
    const changed = pricing();
    const monthly = changed.products[0]!.prices[0];
    if (!monthly) throw new Error("fixture");
    monthly.unitAmount = 1200;
    monthly.currencyOptions.eur = { unitAmount: 900, taxBehavior: "exclusive" };
    delete monthly.currencyOptions.gbp;
    g.calls = [];
    const r = await syncPricing(g, changed, { ...opts, apply: true });
    expect(r.conflicts).toHaveLength(1);
    expect(r.conflicts[0]).toContain("price:cloud_monthly_v1");
    expect(r.conflicts[0]).toContain("unitAmount 900 != 1200");
    expect(r.conflicts[0]).toContain("currencyOptions.eur.taxBehavior inclusive != exclusive");
    expect(r.conflicts[0]).toContain("currencyOptions.gbp only in Stripe");
    expect(r.conflicts[0]).toContain("add a new _vN lookup key");
    // With a conflict, nothing is written: no new price, no portal update.
    expect(writes(g)).toEqual([]);
    expect(r.portalConfigurationId).toBeNull();
  });

  it("a version bump creates the new price beside the old one", async () => {
    const g = new FakeStripeGateway();
    await syncPricing(g, pricing(), { ...opts, apply: true });
    const bumped = pricing();
    const product = bumped.products[0];
    if (!product) throw new Error("fixture");
    product.prices[0] = { ...structuredClone(product.prices[0]!), offered: false };
    product.prices.push({
      ...structuredClone(product.prices[0]!),
      lookupKey: "cloud_monthly_v2",
      unitAmount: 1200,
      offered: true,
    });
    const r = await syncPricing(g, bumped, { ...opts, apply: true, archiveRemoved: true });
    expect(r.created).toEqual(["price:cloud_monthly_v2"]);
    expect(r.archived).toEqual(["price:cloud_monthly_v1"]);
    expect([...g.prices.values()].find((p) => p.lookup_key === "cloud_monthly_v1")?.active).toBe(
      false,
    );
    // The portal only offers offered prices.
    const config = g.portalConfigurations.get(r.portalConfigurationId ?? "")?.params as {
      features: { subscription_update: { products: Array<{ prices: string[] }> } };
    };
    const v1 = [...g.prices.values()].find((p) => p.lookup_key === "cloud_monthly_v1")?.id;
    expect(config.features.subscription_update.products[0]!.prices).not.toContain(v1);
    expect(config.features.subscription_update.products[0]!.prices).toHaveLength(2);

    // Running again: the archived price is found (inactive prices are listed too) and stays archived.
    g.calls = [];
    const again = await syncPricing(g, bumped, { ...opts, apply: true, archiveRemoved: true });
    expect(again.created).toEqual([]);
    expect(again.archived).toEqual([]);
    expect(writes(g).map((c) => c.method)).toEqual(["upsertPortalConfiguration"]);
  });

  it("without --archive-removed a non-offered price is left active; an archived offered price is reactivated", async () => {
    const g = new FakeStripeGateway();
    await syncPricing(g, pricing(), { ...opts, apply: true });
    const cfg = pricing();
    (cfg.products[0]!.prices[1] as { offered: boolean }).offered = false;
    const r = await syncPricing(g, cfg, { ...opts, apply: true });
    expect(r.archived).toEqual([]);
    expect(r.unchanged).toContain("price:cloud_yearly_v1");

    const monthly = [...g.prices.values()].find((p) => p.lookup_key === "cloud_monthly_v1");
    if (!monthly) throw new Error("fixture");
    monthly.active = false;
    const back = await syncPricing(g, pricing(), { ...opts, apply: true });
    expect(back.created).toEqual(["price:cloud_monthly_v1 (reactivated)"]);
    expect(monthly.active).toBe(true);
  });

  it("an archived product is reported as a conflict", async () => {
    const g = new FakeStripeGateway();
    await syncPricing(g, pricing(), { ...opts, apply: true });
    const product = g.products.get("gw_cloud");
    if (!product) throw new Error("fixture");
    product.active = false;
    const r = await syncPricing(g, pricing(), { ...opts, apply: false });
    expect(r.conflicts).toEqual([
      "product:gw_cloud: archived in Stripe; reactivate it in the Dashboard",
    ]);
  });

  it("a lost response is safe to retry: idempotency keys return the same objects", async () => {
    const g = new FakeStripeGateway();
    const created = await g
      .createPrice({ productId: "nope", price: pricing().products[0]!.prices[0]! }, "price:x")
      .catch((e: unknown) => e);
    expect(created).toMatchObject({ code: "resource_missing" });
    await g.createProduct({ id: "gw_cloud", name: "Glideworth Cloud" }, "product:gw_cloud");
    const again = await g.createProduct(
      { id: "gw_cloud", name: "Glideworth Cloud" },
      "product:gw_cloud",
    );
    expect(again).toEqual({ id: "gw_cloud" });
    await expect(
      g.createProduct({ id: "gw_cloud", name: "Other" }, "product:gw_cloud"),
    ).rejects.toMatchObject({
      type: "idempotency_error",
    });
  });
});

describe("syncWebhookEndpoint", () => {
  const url = "https://app.test/stripe/webhook";

  it("dry run plans a create; apply creates with the pinned API version and handled events; rerun is unchanged", async () => {
    const g = new FakeStripeGateway();
    expect(await syncWebhookEndpoint(g, { url, apply: false })).toEqual({
      action: "create",
      id: null,
      warnings: [],
    });
    expect(g.webhookEndpoints.size).toBe(0);
    const created = await syncWebhookEndpoint(g, { url, apply: true });
    expect(created.action).toBe("create");
    const endpoint = g.webhookEndpoints.get(created.id ?? "");
    expect(endpoint).toMatchObject({
      url,
      apiVersion: STRIPE_API_VERSION,
      description: WEBHOOK_DESCRIPTION,
    });
    expect([...(endpoint?.enabledEvents ?? [])].sort()).toEqual([...WEBHOOK_ENABLED_EVENTS].sort());
    expect(await syncWebhookEndpoint(g, { url, apply: true })).toEqual({
      action: "unchanged",
      id: created.id,
      warnings: [],
    });
    expect(g.webhookEndpoints.size).toBe(1);
  });

  it("updates the events of an existing endpoint and warns about another API version", async () => {
    const g = new FakeStripeGateway();
    g.webhookEndpoints.set("we_old", {
      id: "we_old",
      url,
      enabledEvents: ["invoice.paid"],
      description: null,
      apiVersion: "2025-03-31.basil",
      status: "enabled",
    });
    const r = await syncWebhookEndpoint(g, { url, apply: true });
    expect(r.action).toBe("update");
    expect(r.warnings).toEqual([
      `endpoint we_old uses API version 2025-03-31.basil, expected ${STRIPE_API_VERSION}`,
    ]);
    expect(g.webhookEndpoints.get("we_old")?.enabledEvents.length).toBe(
      WEBHOOK_ENABLED_EVENTS.length,
    );
  });
});
