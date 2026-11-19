/**
 * Cross-border API on the real engine, for items held in another country than the one the household
 * lives in: explain-taxation, the list of foreign items, tax by country and basis, rule tables, MCP
 * tools and the engine-version cache. All households are synthetic.
 */
import { ENGINE_VERSION, IncomeEvent } from "@glideworth/core";
import {
  createUaeSampleDocument,
  createUkSampleDocument,
  UAE_SAMPLE_PLAN_ID,
} from "@glideworth/core/samples";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { simulationRuns } from "../src/db/schema.js";
import { createMcpServer } from "../src/mcp/server.js";
import { type Harness, READ_KEY, setup } from "./helpers.js";

let h: Harness;
let ukHousehold: string;
let ukPerson: string;
const UK_PLAN = "uk-plan-main";
const AE_PLAN = UAE_SAMPLE_PLAN_ID;
const UK_PAY = "ae-uk-consulting";
beforeAll(() => {
  h = setup({ realEngine: true });
  const uk = createUkSampleDocument();
  ukHousehold = uk.household.id;
  ukPerson = uk.household.people[0]!.id;
  h.services.households.importDocument(uk, { kind: "system", label: "test" });
  // The UAE sample with UK pay as well: the UK taxes it as a non-resident (source tax), so the
  // household in Dubai pays tax in another country than the one it lives in.
  const ae = createUaeSampleDocument();
  ae.plans[0]!.income.push(
    IncomeEvent.parse({
      id: UK_PAY,
      name: "UK consulting (Noor)",
      type: "salary",
      owner: "p-noor",
      country: "GB",
      currency: "GBP",
      amount: { value: 90_000 },
      frequency: "yearly",
      range: { start: { kind: "planStart" }, end: { kind: "date", date: "2032-12" } },
    }),
  );
  h.services.households.importDocument(ae, { kind: "system", label: "test" });
});
afterAll(() => h.close());

// oxlint-disable-next-line typescript/no-explicit-any -- API payloads are untyped JSON that tests probe freely
type J = Record<string, any>;
const get = (path: string, key?: string) => h.call<J>(path, key ? { key } : {});
const send = (method: string, path: string, body: unknown, key?: string) =>
  h.call<J>(path, { method, body, ...(key ? { key } : {}) });

describe("person citizenships", () => {
  it("are set through the plain person routes", async () => {
    const path = `/api/v1/households/${ukHousehold}/people/${ukPerson}`;
    const patched = await send("PATCH", path, { citizenships: ["GB", "US"], usGreenCard: false });
    expect(patched.status).toBe(200);
    expect(patched.json).toMatchObject({ citizenships: ["GB", "US"], usGreenCard: false });
    const cleared = await send("PATCH", path, { citizenships: null, usGreenCard: null });
    expect(cleared.json.citizenships).toBeUndefined();
    expect(cleared.json.usGreenCard).toBeUndefined();
    expect((await send("PATCH", path, { citizenships: ["GB"] }, READ_KEY)).status).toBe(403);
  });
});

describe("explain, foreign items, tax by country", () => {
  it("explains how an item is taxed and why, with a 404 listing valid ids", async () => {
    const e = await send("POST", `/api/v1/plans/${AE_PLAN}/insights/explain-taxation`, {
      itemId: "uk-sipp",
      year: 2028,
    });
    expect(e.status).toBe(200);
    expect(e.json).toMatchObject({ kind: "account", country: "GB" });
    expect(e.json.residence).toBe("AE");
    const pension = e.json.treatments.find((t: J) => t.category === "private-pension");
    expect(pension.sourceTaxes).toBe(false);
    expect(pension.treaty.name).toMatch(/UK-UAE/);
    const missing = await send("POST", `/api/v1/plans/${AE_PLAN}/insights/explain-taxation`, {
      itemId: "nope",
    });
    expect(missing.status).toBe(404);
    expect(missing.json.error.details.validItemIds).toContain("uk-sipp");
    const items = await get(`/api/v1/plans/${AE_PLAN}/cross-border/items`);
    expect(items.json.items.map((i: J) => i.id)).toEqual(
      expect.arrayContaining(["uk-sipp", `${AE_PLAN}-uk-sp`, UK_PAY]),
    );
    expect((await get(`/api/v1/plans/${UK_PLAN}/cross-border/items`)).json.items).toEqual([]);
  });

  it("tax by country and basis sums to the lifetime tax; single-country plans are one residence row", async () => {
    const t = await get(`/api/v1/plans/${AE_PLAN}/tax-breakdown/by-country?basis=real`);
    expect(t.status).toBe(200);
    expect(t.json.crossBorder).toBe(true);
    expect(t.json.engineVersion).toBe(ENGINE_VERSION);
    expect(t.json.simplifications.some((s: string) => /statutory residence/.test(s))).toBe(true);
    expect(t.json.totals.byCountry.GB).toBeGreaterThan(0);
    expect(t.json.totals.byBasis.source).toBeGreaterThan(0);
    expect(t.json.years.every((y: J) => !("residence" in y))).toBe(true);
    const sim = await send("POST", `/api/v1/plans/${AE_PLAN}/simulate`, {});
    expect(sim.json.summary.lifetimeTaxesReal).toBeGreaterThan(0);
    const sum = t.json.totals.rows.reduce((s: number, r: J) => s + r.amount, 0);
    expect(Math.abs(sum - sim.json.summary.lifetimeTaxesReal)).toBeLessThan(
      t.json.totals.rows.length + 2,
    );
    const uk = await get(`/api/v1/plans/${UK_PLAN}/tax-breakdown/by-country`);
    expect(uk.json.crossBorder).toBe(false);
    expect(new Set(uk.json.totals.rows.map((r: J) => `${r.country}|${r.basis}`))).toEqual(
      new Set(["GB|residence"]),
    );
    expect(uk.json.simplifications).toEqual([]);
    // The classic breakdown gains country/basis only for cross-border plans.
    const classic = await get(`/api/v1/plans/${AE_PLAN}/tax-breakdown?detail=lines`);
    expect(classic.json.totals.byCountry).toBeDefined();
    const ukClassic = await get(`/api/v1/plans/${UK_PLAN}/tax-breakdown`);
    expect(ukClassic.json.totals.byCountry).toBeUndefined();
  });
});

describe("rule tables", () => {
  it("countries, non-resident rules, treaties, wrappers, explain and simplifications", async () => {
    const c = await get("/api/v1/cross-border/countries", READ_KEY);
    expect(c.json.items.find((x: J) => x.country === "AE")).toMatchObject({ taxCurrency: "AED" });
    const gb = await get("/api/v1/cross-border/non-resident-rules/gb");
    expect(gb.json.depth).toBe("high");
    expect(
      (await get("/api/v1/cross-border/non-resident-rules/ZZ")).json.error.details.validCountries,
    ).toContain("GB");
    const t = await get("/api/v1/cross-border/treaties/GB/AE");
    expect(t.json.known).toBe(true);
    expect(t.json.residentInAE["private-pension"].sourceMayTax).toBe(false);
    const nz = await get("/api/v1/cross-border/treaties/NZ/GB");
    expect(nz.json.known).toBe(false);
    expect(nz.json.fallback).toMatch(/credits/);
    const w = await get("/api/v1/cross-border/wrappers?residence=US&accountCountry=GB");
    expect(w.json.accountTypes.find((x: J) => x.accountType === "uk-isa").recognised).toBe(false);
    const ex = await send("POST", "/api/v1/cross-border/explain", {
      residence: "AE",
      source: "GB",
      category: "rental",
    });
    expect(ex.json.sourceTaxes).toBe(true);
    const s = await get("/api/v1/cross-border/simplifications?countries=GB,AE");
    expect(s.json.items.some((x: string) => x.startsWith("United Kingdom:"))).toBe(true);
  });
});

describe("MCP cross-border tools", () => {
  async function client(canWrite: boolean) {
    const [a, b] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer({
      services: h.services,
      scopes: canWrite ? ["read", "simulate", "write"] : ["read", "simulate"],
      canWrite,
      actor: { kind: "mcp", label: "test" },
    });
    await server.connect(b);
    const c = new Client({ name: "t", version: "0" });
    await c.connect(a);
    return c;
  }
  const call = async (c: Client, name: string, args: J) => {
    const r = (await c.callTool({ name, arguments: args })) as {
      content: { text: string }[];
      isError?: boolean;
    };
    return { ...JSON.parse(r.content[0]!.text), isError: r.isError };
  };

  it("read tools: rules, explain, tax by country", async () => {
    const c = await client(false);
    const tools = (await c.listTools()).tools.map((t) => t.name);
    for (const n of ["cross_border_rules", "explain_item_taxation", "tax_by_country"])
      expect(tools).toContain(n);
    const tr = await call(c, "cross_border_rules", {
      kind: "treaty",
      country: "GB",
      otherCountry: "AE",
    });
    expect(tr.known).toBe(true);
    const need = await call(c, "cross_border_rules", { kind: "treaty" });
    expect(need.isError).toBe(true);
    expect(need.error.message).toMatch(/needs country/);
    const tax = await call(c, "tax_by_country", { planId: AE_PLAN });
    expect(tax.totals.rows.length).toBeGreaterThan(0);
    const ex = await call(c, "explain_item_taxation", {
      planId: AE_PLAN,
      itemId: "uk-sipp",
    });
    expect(ex.residence).toBe("AE");
    expect(ex.treatments[0].sources).toBeUndefined();
    await c.close();
  });
});

describe("import", () => {
  it("a document whose plans name another household is a 422 that says how to fix it (not a 500)", async () => {
    const doc = createUkSampleDocument();
    doc.household.id = "hh-renamed";
    // 'cairn', the format name before the rename, is still accepted.
    const r = await send("POST", "/api/v1/import", { format: "cairn", data: doc });
    expect(r.status).toBe(422);
    expect(r.json.error.message).toMatch(/Set each plan's householdId to 'hh-renamed'/);
  });
});

describe("result cache", () => {
  it("keys on the engine version: a row from another engine version is never served", async () => {
    const first = await send("POST", `/api/v1/plans/${UK_PLAN}/simulate`, { view: {} });
    expect(first.status).toBe(200);
    const again = await send("POST", `/api/v1/plans/${UK_PLAN}/simulate`, { view: {} });
    expect(again.json.meta.cached).toBe(true);
    // Pretend every cached row came from an older engine.
    h.services.db.update(simulationRuns).set({ engineVersion: "0.3.9" }).run();
    const after = await send("POST", `/api/v1/plans/${UK_PLAN}/simulate`, { view: {} });
    expect(after.json.meta.cached).toBe(false);
    expect(after.json.meta.engineVersion).toBe(ENGINE_VERSION);
  });
});
