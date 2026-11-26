/** Shareable read-only links: privacy modes, expiry, revocation, rate limiting and the isolation boundary. */
import { afterEach, describe, expect, it } from "vitest";
import { type Harness, READ_KEY, setup } from "./helpers.js";

let h: Harness;
afterEach(() => h?.close());

async function create(body: Record<string, unknown> = {}) {
  const r = await h.call("/api/v1/plans/plan-main/share-links", {
    method: "POST",
    body: { includeSuccessRate: false, ...body },
  });
  expect(r.status, r.text).toBe(201);
  return r.json as {
    link: { id: string; status: string; privacy: string };
    token: string;
    path: string;
    apiPath: string;
  };
}
const pub = (token: string) => h.call(`/api/v1/shared/${token}`, { key: null });

describe("creating and reading a link", () => {
  it("serves the plan’s results to an anonymous caller, with an expiry and a one-time token", async () => {
    h = setup();
    const c = await create({ label: "For the adviser", expiresInDays: 7 });
    expect(c.token).toMatch(/^glideworth_share_/);
    expect(c.path).toBe(`/share/${c.token}`);
    const r = await pub(c.token);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({
      kind: "glideworth-shared-plan",
      label: "For the adviser",
      privacy: "full",
      unit: "currency",
      plan: { name: expect.any(String) },
    });
    expect(r.json.years.length).toBeGreaterThan(2);
    expect(r.json.years[0].netWorth).toEqual(expect.any(Number));
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("x-robots-tag")).toContain("noindex");
    const days = (Date.parse(r.json.expiresAt) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThan(7.1);
    // listing never shows the token, and only its hash is stored
    const list = await h.call("/api/v1/share-links");
    expect(JSON.stringify(list.json)).not.toContain(c.token);
    const row = h.ctx.sqlite.prepare("select token_hash from share_links").get() as {
      token_hash: string;
    };
    expect(row.token_hash).not.toContain(c.token);
    expect(list.json.items[0]).toMatchObject({ status: "active", viewCount: 1 });
  });

  it("exposes only that plan’s computed results: nothing else from the household", async () => {
    h = setup();
    const c = await create();
    const text = (await pub(c.token)).text;
    const rec = h.services.households.get("hh-sample");
    const secrets = [
      rec.household.name,
      ...rec.household.people.map((p) => p.name),
      ...rec.finances.accounts.map((a) => a.name),
      ...rec.finances.realAssets.map((a) => a.name),
      ...rec.finances.debts.map((d) => d.name),
      "hh-sample",
      "acc-",
      ...h.services.plans
        .list({})
        .filter((p) => p.id !== "plan-main")
        .map((p) => p.name),
      "balance",
      "costBasis",
    ];
    for (const s of secrets.filter(Boolean)) expect(text, `leaked ${s}`).not.toContain(s);
    // the top-level shape is fixed
    expect(Object.keys(JSON.parse(text)).sort()).toEqual(
      [
        "basis",
        "currency",
        "expiresAt",
        "generatedAt",
        "kind",
        "label",
        "milestones",
        "note",
        "plan",
        "privacy",
        "summary",
        "unit",
        "version",
        "years",
      ].sort(),
    );
  });

  it("the token is the only key: a share token is not an API credential and opens no other route", async () => {
    h = setup();
    const c = await create();
    for (const path of [
      "/api/v1/plans",
      "/api/v1/plans/plan-main",
      "/api/v1/households",
      "/api/v1/me",
      "/api/v1/share-links",
      "/mcp",
    ]) {
      const r = await h.call(path, { key: c.token });
      expect(r.status, path).toBe(401);
    }
    // not reachable as a path trick either
    expect((await h.call(`/api/v1/shared/${c.token}/../../plans`, { key: null })).status).toBe(401);
    expect((await h.call(`/api/v1/plans/plan-main?token=${c.token}`, { key: null })).status).toBe(
      401,
    );
    expect((await h.call(`/api/v1/shared/${c.token}x`, { key: null })).status).toBe(404);
  });
});

describe("privacy modes", () => {
  it("percent: amounts are percentages of the starting net worth, no currency", async () => {
    h = setup();
    const c = await create({ privacy: "percent" });
    const j = (await pub(c.token)).json;
    expect(j).toMatchObject({
      privacy: "percent",
      unit: "percent-of-starting-net-worth",
      currency: null,
    });
    expect(j.years[0].netWorth).toBe(100);
    expect(j.years[j.years.length - 1].netWorth).toBeGreaterThan(100);
    expect(j.summary.endNetWorth).toBe(j.years[j.years.length - 1].netWorth);
    // no absolute money anywhere: every amount is small relative to a real net worth
    expect(Math.max(...j.years.map((y: { netWorth: number }) => y.netWorth))).toBeLessThan(5000);
  });

  it("hidden: no amounts at all, only success information and years", async () => {
    h = setup();
    const c = await create({ privacy: "hidden" });
    const j = (await pub(c.token)).json;
    expect(j.currency).toBeUndefined();
    expect(j.unit).toBe("none");
    for (const y of j.years)
      expect([y.netWorth, y.portfolio, y.income, y.spending, y.taxes]).toEqual([
        null,
        null,
        null,
        null,
        null,
      ]);
    expect(j.summary.endNetWorth).toBeNull();
    expect(typeof j.summary.fundedThroughout).toBe("boolean");
  });

  it("the plan’s chance of success is included when asked", async () => {
    h = setup({ realEngine: true });
    const r = await h.call("/api/v1/plans/plan-main/share-links", {
      method: "POST",
      body: { privacy: "hidden" },
    });
    expect(r.status, r.text).toBe(201);
    const j = (await pub(r.json.token)).json;
    expect(j.summary.successRate).toBeGreaterThanOrEqual(0);
    expect(j.summary.successRate).toBeLessThanOrEqual(1);
    expect(j.summary.monteCarloTrials).toBeGreaterThan(0);
    expect(r.json.monteCarlo.status).toBe("included");
  }, 60_000);

  it("returns the link before a deferred Monte Carlo run finishes, then fills in the rate", async () => {
    h = setup({ realEngine: true });
    const patched = await h.call("/api/v1/plans/plan-main/monte-carlo-settings", {
      method: "PATCH",
      body: { trials: 40 },
    });
    expect(patched.status, patched.text).toBe(200);
    const started = Date.now();
    const r = await h.call("/api/v1/plans/plan-main/share-links", {
      method: "POST",
      body: { privacy: "hidden", includeSuccessRate: true, deferMonteCarlo: true },
    });
    expect(r.status, r.text).toBe(201);
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(r.json.monteCarlo).toMatchObject({ status: "pending" });
    expect(typeof r.json.monteCarlo.jobId).toBe("string");
    let rate: number | null = null;
    for (let i = 0; i < 40 && typeof rate !== "number"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      rate = (await pub(r.json.token)).json.summary.successRate;
    }
    expect(rate).toBeGreaterThanOrEqual(0);
    expect(rate).toBeLessThanOrEqual(1);
  }, 30_000);
});

describe("a chance of success that was asked for and did not arrive", () => {
  it("is run again by Refresh, and the stored request never reaches the public payload", async () => {
    h = setup({ realEngine: true });
    const patched = await h.call("/api/v1/plans/plan-main/monte-carlo-settings", {
      method: "PATCH",
      body: { trials: 2000 },
    });
    expect(patched.status, patched.text).toBe(200);
    const r = await h.call("/api/v1/plans/plan-main/share-links", {
      method: "POST",
      body: { privacy: "hidden", includeSuccessRate: true, deferMonteCarlo: true },
    });
    expect(r.json.monteCarlo.status).toBe("pending");
    const cancelled = await h.call(`/api/v1/jobs/${r.json.monteCarlo.jobId}/cancel`, {
      method: "POST",
    });
    expect(cancelled.json.status).toBe("cancelled");
    expect((await pub(r.json.token)).json.summary.successRate).toBeNull();

    const refreshed = await h.call(`/api/v1/share-links/${r.json.link.id}/refresh`, {
      method: "POST",
    });
    expect(refreshed.status, refreshed.text).toBe(200);
    const view = (await pub(r.json.token)).json;
    expect(view.summary.successRate).toBeGreaterThanOrEqual(0);
    expect(view.summary.successRate).toBeLessThanOrEqual(1);
    expect(view.summary.monteCarloTrials).toBe(2000);
    expect(JSON.stringify(view)).not.toContain("successRateRequested");
  }, 120_000);

  it("stays off after Refresh on a link created without it", async () => {
    h = setup();
    const c = await create();
    const refreshed = await h.call(`/api/v1/share-links/${c.link.id}/refresh`, { method: "POST" });
    expect(refreshed.status, refreshed.text).toBe(200);
    const view = (await pub(c.token)).json;
    expect(view.summary.successRate).toBeNull();
    expect(JSON.stringify(view)).not.toContain("successRateRequested");
  });
});

describe("expiry, revocation and refresh", () => {
  it("unknown, expired and revoked tokens are one indistinguishable 404", async () => {
    h = setup();
    const a = await create();
    const b = await create();
    const e = await create();
    expect(
      (await h.call(`/api/v1/share-links/${b.link.id}`, { method: "DELETE" })).json.status,
    ).toBe("revoked");
    h.ctx.sqlite
      .prepare("update share_links set expires_at = '2000-01-01T00:00:00.000Z' where id = ?")
      .run(e.link.id);
    const results = await Promise.all([pub("glideworth_share_nope"), pub(b.token), pub(e.token)]);
    for (const r of results) {
      expect(r.status).toBe(404);
      expect(r.json.error.message).toBe(results[0]!.json.error.message);
    }
    expect((await pub(a.token)).status).toBe(200);
    expect(
      (await h.call("/api/v1/share-links")).json.items
        .map((l: { status: string }) => l.status)
        .sort(),
    ).toEqual(["active", "expired", "revoked"]);
  });

  it("refresh retakes the snapshot without changing the token", async () => {
    h = setup();
    const c = await create();
    const before = (await pub(c.token)).json;
    await h.call("/api/v1/plans/plan-main", {
      method: "PATCH",
      body: [{ op: "replace", path: "/expenses/[id=exp-living]/amount/value", value: 9000 }],
      headers: { "content-type": "application/json-patch+json" },
    });
    expect((await pub(c.token)).json.summary.endNetWorth).toBe(before.summary.endNetWorth); // still the snapshot
    const r = await h.call(`/api/v1/share-links/${c.link.id}/refresh`, { method: "POST" });
    expect(r.status).toBe(200);
    expect((await pub(c.token)).json.summary.endNetWorth).not.toBe(before.summary.endNetWorth);
  });

  it("deleting the plan removes its links", async () => {
    h = setup();
    const c = await create();
    const copy = await h.call("/api/v1/plans/plan-main/duplicate", {
      method: "POST",
      body: { name: "Temp" },
    });
    const t = await h.call(`/api/v1/plans/${copy.json.id}/share-links`, {
      method: "POST",
      body: { includeSuccessRate: false },
    });
    await h.call(`/api/v1/plans/${copy.json.id}`, { method: "DELETE" });
    expect((await pub(t.json.token)).status).toBe(404);
    expect((await pub(c.token)).status).toBe(200);
  });
});

describe("authorisation and abuse limits", () => {
  it("only owners and editors manage links; read keys cannot", async () => {
    h = setup();
    for (const [method, path] of [
      ["POST", "/api/v1/plans/plan-main/share-links"],
      ["GET", "/api/v1/share-links"],
      ["DELETE", "/api/v1/share-links/x"],
      ["POST", "/api/v1/share-links/x/refresh"],
    ] as const)
      expect(
        (await h.call(path, { method, key: READ_KEY, ...(method === "POST" ? { body: {} } : {}) }))
          .status,
        path,
      ).toBe(403);
  });

  it("the public route is rate limited per client", async () => {
    h = setup({ appOptions: { shareRateLimitPerMinute: 3 } });
    const c = await create();
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await pub(c.token)).status);
    expect(codes).toEqual([200, 200, 200, 429, 429]);
    expect((await pub(c.token)).headers.get("retry-after")).toBeTruthy();
  });

  it("rejects out-of-range expiry and unknown privacy modes; link creation is audited", async () => {
    h = setup();
    expect(
      (
        await h.call("/api/v1/plans/plan-main/share-links", {
          method: "POST",
          body: { expiresInDays: 4000 },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await h.call("/api/v1/plans/plan-main/share-links", {
          method: "POST",
          body: { privacy: "everything" },
        })
      ).status,
    ).toBe(400);
    expect(
      (await h.call("/api/v1/plans/nope/share-links", { method: "POST", body: {} })).status,
    ).toBe(404);
    await create();
    const log = h.services.audit.list({ resourceType: "plan", resourceId: "plan-main" });
    expect(log.some((e) => e.action.includes("share-links"))).toBe(true);
  });
});
