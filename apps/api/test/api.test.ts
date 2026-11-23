import { createSampleDocument } from "@glideworth/core/samples";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Harness, READ_KEY, SIM_KEY, setup } from "./helpers.js";

let h: Harness;
beforeEach(() => {
  h = setup({ seed: false });
});
afterEach(() => h.close());

describe("public routes", () => {
  it("health", async () => {
    const r = await h.call("/health", { key: null });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ status: "ok", schemaVersion: 5 });
  });
  it("serves the docs UI", async () => {
    const r = await h.call("/docs", { key: null });
    expect(r.status).toBe(200);
    expect(r.text).toContain("openapi.json");
  });
});

describe("auth", () => {
  it("rejects missing and invalid keys", async () => {
    expect((await h.call("/api/v1/plans", { key: null })).status).toBe(401);
    expect(
      (
        await h.call("/api/v1/plans", {
          key: "glideworth_nopenope_0123456789abcdef0123456789abcdef",
        })
      ).status,
    ).toBe(401);
    expect((await h.call("/api/v1/plans", { key: "garbage" })).status).toBe(401);
  });
  it("enforces write scope on writes", async () => {
    const r = await h.call("/api/v1/households", { method: "POST", key: READ_KEY, body: {} });
    expect(r.status).toBe(403);
    expect(r.json).toMatchObject({ error: { code: "FORBIDDEN" } });
  });
  it("a simulate-only key can compute but not read data", async () => {
    h.services.households.importDocument(createSampleDocument(), { kind: "system" });
    expect((await h.call("/api/v1/plans", { key: SIM_KEY })).status).toBe(403);
    const sim = await h.call("/api/v1/plans/plan-main/simulate", {
      method: "POST",
      key: SIM_KEY,
      body: { view: {} },
    });
    expect(sim.status).toBe(200);
    const me = await h.call("/api/v1/me", { key: SIM_KEY });
    expect(me.json).toMatchObject({ name: "test-sim", scopes: ["simulate"] });
  });
  it("stores keys hashed and never logs or returns secrets", async () => {
    const created = await h.call("/api/v1/keys", {
      method: "POST",
      body: { name: "ci", scopes: ["read"] },
    });
    expect(created.status).toBe(201);
    const key = (created.json as { key: string }).key;
    expect(key).toMatch(/^glideworth_[a-z0-9]{8}_/);
    const rows = h.ctx.sqlite.prepare("select * from api_keys").all() as {
      hash: string;
      prefix: string;
    }[];
    expect(JSON.stringify(rows)).not.toContain(key.split("_")[2]);
    const list = await h.call("/api/v1/keys");
    expect(list.text).not.toContain(key.split("_")[2]);
    expect(list.text).not.toContain('"hash"');
    // The new key works with its scope only.
    expect((await h.call("/api/v1/plans", { key })).status).toBe(200);
    expect((await h.call("/api/v1/settings", { method: "PUT", key, body: {} })).status).toBe(403);
  });
});

describe("vertical slice: create household + plan -> get -> simulate", () => {
  it("works end to end (real engine)", async () => {
    h.close();
    h = setup({ seed: false, realEngine: true });
    const sample = createSampleDocument();
    const hh = await h.call("/api/v1/households", {
      method: "POST",
      body: { household: sample.household, finances: sample.finances },
    });
    expect(hh.status).toBe(201);
    const { id: _i, version: _v, createdAt: _c, updatedAt: _u, ...planBody } = sample.plans[0]!;
    const created = await h.call("/api/v1/plans", { method: "POST", body: planBody });
    expect(created.status).toBe(201);
    const plan = created.json as { id: string; version: number };
    expect(plan.version).toBe(1);
    expect(created.headers.get("etag")).toBe('"1"');
    const got = await h.call(`/api/v1/plans/${plan.id}`, { key: READ_KEY });
    expect(got.status).toBe(200);
    expect((got.json as { name: string }).name).toBe("Main plan");
    const sim = await h.call(`/api/v1/plans/${plan.id}/simulate`, {
      method: "POST",
      key: READ_KEY,
      body: {},
    });
    expect(sim.status).toBe(200);
    const result = sim.json as { periods: unknown[]; meta: { currency: string } };
    expect(result.periods.length).toBeGreaterThan(10);
    expect(result.meta.currency).toBe("USD");
  });

  it("returns 400 on invalid bodies and 404 on unknown plans, with the error envelope", async () => {
    const bad = await h.call("/api/v1/plans", { method: "POST", body: '{"name":1}' });
    expect(bad.status).toBe(400);
    expect(bad.json).toMatchObject({ error: { code: "VALIDATION" } });
    const missing = await h.call("/api/v1/plans/nope");
    expect(missing.status).toBe(404);
    expect(missing.json).toMatchObject({ error: { code: "NOT_FOUND" } });
    expect((await h.call("/api/v1/plans", { method: "POST", body: "{not json" })).status).toBe(400);
  });
});

describe("rate limiting", () => {
  it("returns 429 with Retry-After once the per-key budget is spent", async () => {
    const limited = setup({ seed: false, rateLimitPerMinute: 3 });
    for (let i = 0; i < 3; i++) expect((await limited.call("/api/v1/plans")).status).toBe(200);
    const r = await limited.call("/api/v1/plans");
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toBeTruthy();
    expect(r.json).toMatchObject({ error: { code: "RATE_LIMITED" } });
    limited.close();
  });
});
