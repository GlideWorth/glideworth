import { describe, expect, it } from "vitest";
import { parseArgs, readOnly, runSetup, type SetupDeps } from "../scripts/setup.js";
import { FakeStripeGateway } from "../src/gateway/fake.js";

function deps(o: { env?: Record<string, string>; gateway?: FakeStripeGateway } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const keys: string[] = [];
  const gateway = o.gateway ?? new FakeStripeGateway();
  const d: SetupDeps = {
    env: { ...o.env },
    stdout: (l) => out.push(l),
    stderr: (l) => err.push(l),
    makeGateway: async (key) => {
      keys.push(key);
      return gateway;
    },
  };
  return { d, out, err, keys, gateway };
}

const KEY = "sk_test_51abcdefghijklmnopqrstuvwxyz";
const URL_ENV = {
  GLIDEWORTH_STRIPE_SECRET_KEY: KEY,
  GLIDEWORTH_PUBLIC_URL: "https://app.glideworth.test",
};

describe("stripe:setup", () => {
  it("--dry-run prints the full plan without a key and never creates a Stripe client", async () => {
    const t = deps();
    expect(await runSetup(["--dry-run"], t.d)).toBe(0);
    expect(t.keys).toEqual([]);
    expect(t.out).toContain("would create: product:gw_cloud");
    expect(t.out).toContain("would create: price:cloud_monthly_v1");
    expect(t.out).toContain("would create: price:cloud_yearly_v1");
    expect(
      t.out.some((l) =>
        l.startsWith(
          "webhook endpoint https://app.glideworth.example/stripe/webhook: would create",
        ),
      ),
    ).toBe(true);
  });

  it("default mode checks read-only: no writes even though a key is given", async () => {
    const t = deps({ env: URL_ENV });
    expect(await runSetup([], t.d)).toBe(0);
    expect(t.keys).toEqual([KEY]);
    expect(t.gateway.products.size + t.gateway.prices.size + t.gateway.webhookEndpoints.size).toBe(
      0,
    );
    expect(t.out).toContain("would create: product:gw_cloud");
    expect(t.out.join("\n")).not.toContain(KEY);
  });

  it("--apply creates everything; running it twice changes nothing", async () => {
    const t = deps({ env: URL_ENV });
    expect(await runSetup(["--apply"], t.d)).toBe(0);
    expect(t.out).toContain("created: price:cloud_monthly_v1");
    expect(
      t.out.some((l) => l.startsWith("  set GLIDEWORTH_STRIPE_PORTAL_CONFIGURATION=bpc_")),
    ).toBe(true);
    expect(t.out.some((l) => /webhook endpoint .*: created \(we_/.test(l))).toBe(true);
    expect(t.out.join("\n")).not.toMatch(/whsec_/);

    const again = deps({ env: URL_ENV, gateway: t.gateway });
    expect(await runSetup(["--apply"], again.d)).toBe(0);
    expect(again.out.filter((l) => l.startsWith("created:"))).toEqual([]);
    expect(again.out.some((l) => /webhook endpoint .*: unchanged/.test(l))).toBe(true);
    expect(t.gateway.prices.size).toBe(2);
    expect(t.gateway.portalConfigurations.size).toBe(1);
    expect(t.gateway.webhookEndpoints.size).toBe(1);
  });

  it("exits 1 on conflicts and explains the version bump", async () => {
    const g = new FakeStripeGateway();
    const t = deps({ env: URL_ENV, gateway: g });
    await runSetup(["--apply"], t.d);
    const price = [...g.prices.values()].find((p) => p.lookup_key === "cloud_yearly_v1");
    if (!price) throw new Error("fixture");
    price.unit_amount = 8000;
    const again = deps({ env: URL_ENV, gateway: g });
    expect(await runSetup(["--apply"], again.d)).toBe(1);
    expect(again.out.some((l) => l.startsWith("CONFLICT: price:cloud_yearly_v1"))).toBe(true);
    expect(again.err.join("\n")).toContain("_v2");
  });

  it("refuses a live key without --live, a missing key, a missing URL and conflicting flags", async () => {
    const live = deps({ env: { ...URL_ENV, GLIDEWORTH_STRIPE_SECRET_KEY: "sk_live_abc" } });
    expect(await runSetup(["--apply"], live.d)).toBe(2);
    expect(live.keys).toEqual([]);
    const liveOk = deps({ env: { ...URL_ENV, GLIDEWORTH_STRIPE_SECRET_KEY: "sk_live_abc" } });
    expect(await runSetup(["--apply", "--live"], liveOk.d)).toBe(0);

    const noKey = deps({ env: { GLIDEWORTH_PUBLIC_URL: "https://x.test" } });
    expect(await runSetup(["--apply"], noKey.d)).toBe(2);
    const noUrl = deps({ env: { GLIDEWORTH_STRIPE_SECRET_KEY: KEY } });
    expect(await runSetup(["--apply"], noUrl.d)).toBe(2);
    const both = deps({ env: URL_ENV });
    expect(await runSetup(["--apply", "--dry-run"], both.d)).toBe(2);
    expect(await runSetup(["--bogus"], both.d)).toBe(2);
    expect(await runSetup(["--pricing"], both.d)).toBe(2);
    const badPricing = deps({ env: URL_ENV });
    expect(
      await runSetup(["--dry-run", "--pricing", "/nonexistent/pricing.json"], badPricing.d),
    ).toBe(2);
    expect(badPricing.err.join("\n")).toContain("Pricing file cannot be read");
  });

  it("reports a Stripe failure by code only", async () => {
    const g = new FakeStripeGateway();
    g.failNext("retrieveProduct");
    const t = deps({ env: URL_ENV, gateway: g });
    expect(await runSetup(["--apply"], t.d)).toBe(1);
    expect(t.err).toEqual(["error: Stripe request failed (connection_error)"]);
  });

  it("the read-only wrapper refuses every write method", async () => {
    const g = readOnly(new FakeStripeGateway());
    await expect(g.createProduct({ id: "p", name: "n" }, "k")).rejects.toThrow("read-only");
    await expect(
      g.createWebhookEndpoint(
        { url: "u", enabledEvents: [], description: "d", apiVersion: "v" },
        "k",
      ),
    ).rejects.toThrow("read-only");
    await expect(g.retrieveProduct("p")).resolves.toBeNull();
  });

  it("parses flags", () => {
    expect(
      parseArgs(["--archive-removed", "--no-webhook", "--portal-configuration", "bpc_1"]),
    ).toMatchObject({
      archiveRemoved: true,
      webhook: false,
      portalConfiguration: "bpc_1",
      apply: false,
      dryRun: false,
    });
  });
});
