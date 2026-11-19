/* oxlint-disable typescript/no-explicit-any -- tests probe arbitrary JSON responses */
/** FX rates (multi-currency), strategy matrix and income by tax rate. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { baseConverter, fxRateTo } from "../src/fx.js";
import { createMcpServer } from "../src/mcp/server.js";
import { type Harness, READ_KEY, setup } from "./helpers.js";

let h: Harness;
afterEach(() => h?.close());
const FX = "/api/v1/households/hh-sample/fx-rates";

describe("FX rates", () => {
  it("lists, upserts, replaces and deletes pairs; every change bumps the household version", async () => {
    h = setup();
    expect((await h.call(FX)).json).toEqual({ baseCurrency: "USD", items: [] });
    const v0 = h.services.households.get("hh-sample").version;
    const add = await h.call(FX, {
      method: "POST",
      body: { from: "GBP", to: "USD", rate: 1.27, annualDrift: -0.02 },
    });
    expect(add.status, add.text).toBe(200);
    expect(add.json.version).toBe(v0 + 1);
    expect(add.headers.get("etag")).toBe(`"${v0 + 1}"`);
    await h.call(FX, { method: "POST", body: { from: "GBP", to: "USD", rate: 1.3 } }); // upsert, not duplicate
    await h.call(FX, { method: "POST", body: { from: "EUR", to: "USD", rate: 1.08 } });
    const list = (await h.call(FX)).json.items;
    expect(list).toHaveLength(2);
    expect(list.find((r: any) => r.from === "GBP").rate).toBe(1.3);
    expect((await h.call(`${FX}/gbp-usd`, { method: "DELETE" })).status).toBe(204);
    expect((await h.call(`${FX}/GBP-USD`, { method: "DELETE" })).status).toBe(404);
    const rep = await h.call(FX, {
      method: "PUT",
      body: { items: [{ from: "CAD", to: "USD", rate: 0.73 }] },
    });
    expect(rep.json.items).toHaveLength(1);
    expect((await h.call(FX)).json.items[0].from).toBe("CAD");
    // it is part of the household document (exports, backups)
    expect((await h.call("/api/v1/households/hh-sample")).json.finances.fxRates[0].from).toBe(
      "CAD",
    );
  });

  it("the web editor’s save (current-finances) and the FX routes read and write the same table", async () => {
    h = setup();
    const CF = "/api/v1/households/hh-sample/current-finances";
    const rec = (await h.call("/api/v1/households/hh-sample")).json;
    // 1. The editor saves the whole document with a rate: the FX route lists exactly that.
    const put = await h.call(CF, {
      method: "PUT",
      headers: { "if-match": `"${rec.version}"` },
      body: {
        finances: {
          ...rec.finances,
          fxRates: [{ from: "GBP", to: "USD", rate: 1.25, annualDrift: 0 }],
        },
      },
    });
    expect(put.status, put.text).toBe(200);
    expect((await h.call(FX)).json.items).toEqual([
      { from: "GBP", to: "USD", rate: 1.25, annualDrift: 0 },
    ]);
    // 2. A script upserts the inverse direction: it replaces the pair, it does not add a second one.
    const up = await h.call(FX, { method: "POST", body: { from: "USD", to: "GBP", rate: 0.8 } });
    expect(up.json.version).toBe(put.json.version + 1);
    const after = (await h.call("/api/v1/households/hh-sample")).json;
    expect(after.finances.fxRates).toEqual([{ from: "USD", to: "GBP", rate: 0.8, annualDrift: 0 }]);
    // 3. The editor's next save with its stale version is a conflict (single writer, nothing lost).
    const stale = await h.call(CF, {
      method: "PUT",
      headers: { "if-match": `"${put.json.version}"` },
      body: { finances: rec.finances },
    });
    expect(stale.status).toBe(409);
    // 4. Both paths refuse the same invalid tables.
    const dup = [
      { from: "GBP", to: "USD", rate: 1.25 },
      { from: "USD", to: "GBP", rate: 0.8 },
    ];
    expect((await h.call(FX, { method: "PUT", body: { items: dup } })).status).toBe(400);
    const bad = await h.call(CF, {
      method: "PUT",
      body: { finances: { ...after.finances, fxRates: dup } },
    });
    expect(bad.status).toBe(400);
    expect(bad.json.error.details.issues[0].path).toEqual(["finances", "fxRates", 1]);
    // 5. Deleting either direction removes the pair; an empty table is stored as absent.
    expect((await h.call(`${FX}/GBP-USD`, { method: "DELETE" })).status).toBe(204);
    expect((await h.call("/api/v1/households/hh-sample")).json.finances.fxRates).toBeUndefined();
    expect((await h.call(FX)).json.items).toEqual([]);
  });

  it("validates pairs, honours If-Match and the scopes", async () => {
    h = setup();
    expect(
      (await h.call(FX, { method: "POST", body: { from: "USD", to: "USD", rate: 1 } })).status,
    ).toBe(400);
    expect(
      (await h.call(FX, { method: "POST", body: { from: "GBP", to: "USD", rate: -1 } })).status,
    ).toBe(400);
    expect(
      (await h.call(FX, { method: "POST", body: { from: "gbp!", to: "USD", rate: 1 } })).status,
    ).toBe(400);
    expect(
      (
        await h.call(FX, {
          method: "PUT",
          body: {
            items: [
              { from: "GBP", to: "USD", rate: 1 },
              { from: "GBP", to: "USD", rate: 2 },
            ],
          },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await h.call(FX, {
          method: "POST",
          headers: { "if-match": '"999"' },
          body: { from: "GBP", to: "USD", rate: 1 },
        })
      ).status,
    ).toBe(409);
    expect((await h.call(FX, { key: READ_KEY })).status).toBe(200);
    expect(
      (
        await h.call(FX, {
          method: "POST",
          key: READ_KEY,
          body: { from: "GBP", to: "USD", rate: 1 },
        })
      ).status,
    ).toBe(403);
    expect((await h.call("/api/v1/households/nope/fx-rates")).status).toBe(404);
  });

  it("converts in either direction; net worth snapshots and check-ins use base-currency values", async () => {
    expect(fxRateTo([{ from: "GBP", to: "USD", rate: 1.25, annualDrift: 0 }], "GBP", "USD")).toBe(
      1.25,
    );
    expect(
      fxRateTo([{ from: "USD", to: "GBP", rate: 0.8, annualDrift: 0 }], "GBP", "USD"),
    ).toBeCloseTo(1.25);
    expect(fxRateTo([], "GBP", "USD")).toBeNull();
    const c = baseConverter({ fxRates: [] }, "USD");
    expect(c.convert(100, "GBP")).toBe(100);
    expect([...c.missing]).toEqual(["GBP"]);

    h = setup();
    const before = (
      await h.call("/api/v1/households/hh-sample/snapshots/record", { method: "POST", body: {} })
    ).json.netWorth as number;
    const acct = h.services.households.get("hh-sample").finances.accounts[0]!;
    await h.call(FX, { method: "POST", body: { from: "GBP", to: "USD", rate: 2 } });
    await h.call(`/api/v1/households/hh-sample/accounts/${acct.id}`, {
      method: "PATCH",
      body: { currency: "GBP" },
    });
    const after = (
      await h.call("/api/v1/households/hh-sample/snapshots/record", { method: "POST", body: {} })
    ).json.netWorth as number;
    expect(after).toBeCloseTo(before + acct.balance, 0); // the account counts double
  });
});

describe("analysis tools backed by core", () => {
  it("income by tax rate (real engine)", async () => {
    h = setup({ realEngine: true });
    const r = await h.call("/api/v1/plans/plan-main/insights/income-by-tax-rate", {
      method: "POST",
      body: {},
    });
    expect(r.status, r.text.slice(0, 300)).toBe(200);
    expect(r.json.years.length).toBeGreaterThan(5);
    expect(r.json.columns.length).toBeGreaterThan(0);
    expect(r.json.cells).toHaveLength(r.json.years.length);
  });

  it("strategy matrix is a job (real engine, no Monte Carlo column)", async () => {
    h = setup({ realEngine: true });
    const r = await h.call("/api/v1/plans/plan-main/insights/strategy-matrix?wait=60", {
      method: "POST",
      body: { successRate: false },
    });
    expect(r.status, r.text.slice(0, 300)).toBe(200);
    const m = (await h.call(`/api/v1/jobs/${r.json.id}/result`)).json;
    expect(m.columns.map((c: any) => c.id)).toContain("lifetimeTaxesReal");
    expect(m.rows.length).toBeGreaterThan(1);
  }, 60_000);

  it("MCP exposes them: FX, income by tax rate, strategy matrix", async () => {
    h = setup({ realEngine: true, mcpAllowWrites: true });
    const server = createMcpServer({
      services: h.services,
      scopes: ["read", "simulate", "write"],
      canWrite: true,
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const c = new Client({ name: "t", version: "1" });
    await Promise.all([server.connect(a), c.connect(b)]);
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const r = (await c.callTool({ name, arguments: args })) as {
        isError?: boolean;
        content: { text: string }[];
      };
      return { isError: !!r.isError, json: JSON.parse(r.content[0]!.text) };
    };
    expect((await call("set_fx_rate", { from: "gbp", to: "usd", rate: 1.3 })).isError).toBe(false);
    expect((await call("list_fx_rates")).json.items[0]).toMatchObject({
      from: "GBP",
      to: "USD",
      rate: 1.3,
    });
    expect((await call("unset_fx_rate", { from: "GBP", to: "USD" })).isError).toBe(false);
    expect((await call("income_by_tax_rate", {})).json.years.length).toBeGreaterThan(1);
    const sm = await call("strategy_matrix", { successRate: false });
    expect(sm.isError).toBe(false);
    expect(sm.json.rows.length).toBeGreaterThan(1);
    await c.close();
  }, 90_000);
});

describe("removed features", () => {
  it("debt payoff, 72(t) and bank-file endpoints are gone", async () => {
    h = setup();
    for (const path of [
      "/api/v1/plans/plan-main/insights/debt-payoff",
      "/api/v1/insights/sepp-comparison",
      "/api/v1/households/hh-sample/import/bank-file",
      "/api/v1/plans/plan-main/insights/stay-or-move",
    ])
      expect((await h.call(path, { method: "POST", body: {} })).status, path).toBe(404);
    expect((await h.call("/api/v1/plans/plan-main/residency-timeline")).status).toBe(404);
    const templates = (await h.call("/api/v1/scenarios/templates")).json.items;
    expect(templates.map((t: any) => t.id)).not.toContain("relocation");
  });
});
