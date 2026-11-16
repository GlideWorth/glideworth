/**
 * Cross-border API on the real engine: residency entries (CRUD + explanatory validation), the
 * person cross-border profile, the residency timeline, explain-taxation, stay-or-move, tax by
 * country and basis, the relocation template, rule tables, MCP tools and the engine-version cache.
 * All households are synthetic.
 */
import { ENGINE_VERSION } from "@glideworth/core";
import {
  createUaeSampleDocument,
  createUkSampleDocument,
  UAE_RETURN_PLAN_ID,
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
beforeAll(() => {
  h = setup({ realEngine: true });
  const uk = createUkSampleDocument();
  ukHousehold = uk.household.id;
  ukPerson = uk.household.people[0]!.id;
  h.services.households.importDocument(uk, { kind: "system", label: "test" });
  h.services.households.importDocument(createUaeSampleDocument(), {
    kind: "system",
    label: "test",
  });
});
afterAll(() => h.close());

// oxlint-disable-next-line typescript/no-explicit-any -- API payloads are untyped JSON that tests probe freely
type J = Record<string, any>;
const get = (path: string, key?: string) => h.call<J>(path, key ? { key } : {});
const send = (method: string, path: string, body: unknown, key?: string) =>
  h.call<J>(path, { method, body, ...(key ? { key } : {}) });

describe("residency entries", () => {
  it("CRUD under /plans/{id}/residency, starting from a plan without any", async () => {
    const empty = await get(`/api/v1/plans/${UK_PLAN}/residency`);
    expect(empty.status).toBe(200);
    expect(empty.json.items).toEqual([]);
    const add = await send("POST", `/api/v1/plans/${UK_PLAN}/residency`, {
      id: "to-ae",
      personId: ukPerson,
      from: { kind: "date", date: "2030-01" },
      location: { country: "AE" },
    });
    expect(add.status).toBe(201);
    expect(add.json).toMatchObject({ id: "to-ae", location: { country: "AE" } });
    const patch = await send("PATCH", `/api/v1/plans/${UK_PLAN}/residency/to-ae`, {
      from: { kind: "date", date: "2031-04" },
    });
    expect(patch.status).toBe(200);
    expect(patch.json.from.date).toBe("2031-04");
    expect(
      (await send("DELETE", `/api/v1/plans/${UK_PLAN}/residency/to-ae`, undefined)).status,
    ).toBe(204);
  });

  it("validation errors say what is wrong and how to fix it", async () => {
    const who = await send("POST", `/api/v1/plans/${UK_PLAN}/residency`, {
      personId: "nobody",
      from: { kind: "date", date: "2030-01" },
      location: { country: "AE" },
    });
    expect(who.status).toBe(400);
    expect(who.json.error.message).toMatch(
      /'nobody' is not a person in this household.*omit personId/,
    );
    expect(who.json.error.details.validPersonIds).toContain(ukPerson);

    const past = await send("POST", `/api/v1/plans/${UK_PLAN}/residency`, {
      from: { kind: "date", date: "2001-01" },
      location: { country: "AE" },
    });
    expect(past.status).toBe(400);
    expect(past.json.error.message).toMatch(/before the plan starts.*residence history/);

    const ms = await send("POST", `/api/v1/plans/${UK_PLAN}/residency`, {
      from: { kind: "milestone", milestoneId: "nope" },
      location: { country: "AE" },
    });
    expect(ms.status).toBe(400);
    expect(ms.json.error.message).toMatch(/milestone 'nope' does not exist/);

    const bad = await send("POST", `/api/v1/plans/${UK_PLAN}/residency`, {
      from: { kind: "date", date: "2030-01" },
      location: { country: "United Arab Emirates" },
    });
    expect(bad.status).toBe(400);
    expect(bad.json.error.message).toMatch(/location\.country/);

    // Same rules through change sets (the agent path).
    const cs = await send("POST", `/api/v1/plans/${UK_PLAN}/change-sets`, {
      summary: "bad move",
      ops: [
        {
          op: "add",
          path: "/residency",
          value: [
            {
              id: "x",
              personId: "ghost",
              from: { kind: "date", date: "2030-01" },
              location: { country: "AE" },
            },
          ],
        },
      ],
    });
    if (cs.status === 201 || cs.status === 200) {
      const applied = await send("POST", `/api/v1/change-sets/${cs.json.id}/apply`, {});
      expect(applied.status).toBe(400);
    } else expect(cs.status).toBe(400);
  });
});

describe("person cross-border profile", () => {
  const path = () => `/api/v1/households/${ukHousehold}/people/${ukPerson}/cross-border`;
  it("reads, merges and replaces citizenships, green card, past residence and state-pension records", async () => {
    expect((await get(path())).json).toEqual({ personId: ukPerson });
    const put = await send("PUT", path(), {
      citizenships: ["gb", "US"],
      residenceHistory: [
        { country: "US", from: "2001-09", to: "2008-06" },
        { country: "GB", from: "2008-07" },
      ],
      statePensionRecords: [{ country: "GB", qualifyingYears: 17, voluntaryYears: 2 }],
    });
    expect(put.status).toBe(200);
    expect(put.json.profile.citizenships).toEqual(["GB", "US"]);
    const merged = await send("PATCH", path(), { usGreenCard: false });
    expect(merged.json.profile.residenceHistory).toHaveLength(2);
    expect(merged.json.profile.usGreenCard).toBe(false);
    // The person record itself carries the fields (and the plain person routes accept them too).
    const person = await get(`/api/v1/households/${ukHousehold}/people/${ukPerson}`);
    expect(person.json.statePensionRecords[0].voluntaryYears).toBe(2);
    const cleared = await send("PUT", path(), {});
    expect(cleared.json.profile).toEqual({ personId: ukPerson });
  });

  it("rejects overlapping or out-of-order history with a message naming the fix", async () => {
    const overlap = await send("PUT", path(), {
      residenceHistory: [
        { country: "US", from: "2001-09", to: "2009-06" },
        { country: "GB", from: "2008-07" },
      ],
    });
    expect(overlap.status).toBe(400);
    expect(overlap.json.error.message).toMatch(/overlapping the previous entry/);
    const open = await send("PUT", path(), {
      residenceHistory: [
        { country: "US", from: "2001-09" },
        { country: "GB", from: "2008-07" },
      ],
    });
    expect(open.json.error.message).toMatch(/only the most recent entry may have no end date/);
    const future = await send("PUT", path(), {
      residenceHistory: [{ country: "AE", from: "2040-01" }],
    });
    expect(future.json.error.message).toMatch(/plan's residency timeline/);
    const twice = await send("PUT", path(), {
      statePensionRecords: [
        { country: "GB", qualifyingYears: 10 },
        { country: "GB", qualifyingYears: 12 },
      ],
    });
    expect(twice.json.error.message).toMatch(/one record per country/);
    expect((await send("PUT", path(), {}, READ_KEY)).status).toBe(403);
  });
});

describe("timeline, explain, tax by country, stay or move", () => {
  it("timeline lists household, dated and milestone steps per person with yearly residence", async () => {
    const t = await get(`/api/v1/plans/${UAE_RETURN_PLAN_ID}/residency-timeline`);
    expect(t.status).toBe(200);
    expect(t.json.crossBorder).toBe(true);
    expect(t.json.countries.sort()).toEqual(["AE", "GB"]);
    const noor = t.json.people.find((p: J) => p.personId === "p-noor");
    expect(noor.steps[0]).toMatchObject({
      from: null,
      source: "household",
      location: { country: "AE" },
    });
    expect(noor.steps.some((s: J) => s.location.country === "GB" && s.from)).toBe(true);
    expect(t.json.years.length).toBeGreaterThan(5);
    const plain = await get(`/api/v1/plans/${UK_PLAN}/residency-timeline`);
    expect(plain.json.crossBorder).toBe(false);
    expect(plain.json.countries).toEqual(["GB"]);
  });

  it("explains how an item is taxed and why, with a 404 listing valid ids", async () => {
    const e = await send("POST", `/api/v1/plans/${UAE_RETURN_PLAN_ID}/insights/explain-taxation`, {
      itemId: "uk-sipp",
      year: 2028,
    });
    expect(e.status).toBe(200);
    expect(e.json).toMatchObject({ kind: "account", country: "GB" });
    expect(e.json.residence[0].country).toBe("AE");
    const pension = e.json.treatments.find((t: J) => t.category === "private-pension");
    expect(pension.sourceTaxes).toBe(false);
    expect(pension.treaty.name).toMatch(/UK-UAE/);
    const missing = await send(
      "POST",
      `/api/v1/plans/${UAE_RETURN_PLAN_ID}/insights/explain-taxation`,
      {
        itemId: "nope",
      },
    );
    expect(missing.status).toBe(404);
    expect(missing.json.error.details.validItemIds).toContain("uk-sipp");
    const items = await get(`/api/v1/plans/${UAE_RETURN_PLAN_ID}/cross-border/items`);
    expect(items.json.items.map((i: J) => i.id)).toContain("uk-sipp");
  });

  it("tax by country and basis sums to the lifetime tax; single-country plans are one residence row", async () => {
    const t = await get(`/api/v1/plans/${UAE_RETURN_PLAN_ID}/tax-breakdown/by-country?basis=real`);
    expect(t.status).toBe(200);
    expect(t.json.crossBorder).toBe(true);
    expect(t.json.engineVersion).toBe(ENGINE_VERSION);
    expect(t.json.simplifications.some((s: string) => /statutory residence/.test(s))).toBe(true);
    const sim = await send("POST", `/api/v1/plans/${UAE_RETURN_PLAN_ID}/simulate`, {});
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
    const classic = await get(`/api/v1/plans/${UAE_RETURN_PLAN_ID}/tax-breakdown?detail=lines`);
    expect(classic.json.totals.byCountry).toBeDefined();
    const ukClassic = await get(`/api/v1/plans/${UK_PLAN}/tax-breakdown`);
    expect(ukClassic.json.totals.byCountry).toBeUndefined();
  });

  it("compares staying with moving (built move, explicit plan) and explains bad requests", async () => {
    const r = await send("POST", `/api/v1/plans/${UK_PLAN}/insights/stay-or-move`, {
      to: { country: "AE" },
      month: "2030-04",
      returnMonth: "2036-04",
    });
    expect(r.status).toBe(200);
    expect(r.json.changes.length).toBeGreaterThan(0);
    expect(r.json.taxesByCountry.some((x: J) => x.country === "GB")).toBe(true);
    expect(r.json.attribution.at(-1).label).toMatch(/Growth/);
    expect(r.json.notes.join(" ")).toMatch(/keep their country/);
    const explicit = await send("POST", `/api/v1/plans/ae-plan-main/insights/stay-or-move`, {
      movePlanId: UAE_RETURN_PLAN_ID,
    });
    expect(explicit.status).toBe(200);
    expect(explicit.json.changes.length).toBeGreaterThan(0);
    const back = await send("POST", `/api/v1/plans/${UK_PLAN}/insights/stay-or-move`, {
      to: { country: "AE" },
      month: "2030-04",
      returnMonth: "2029-01",
    });
    expect(back.status).toBe(400);
    expect(back.json.error.message).toMatch(/returnMonth .* must be after month/);
    const none = await send("POST", `/api/v1/plans/${UK_PLAN}/insights/stay-or-move`, {});
    expect(none.json.error.message).toMatch(/give `to`/);
  });
});

describe("relocation what-if template", () => {
  it("is in the catalogue with a parameter schema, previews and branches", async () => {
    const list = await get("/api/v1/scenarios/templates");
    const reloc = list.json.items.find((t: J) => t.id === "relocation");
    expect(reloc.paramsSchema.properties.to).toBeDefined();
    const prev = await send("POST", `/api/v1/plans/${UK_PLAN}/scenarios/relocation/preview`, {
      params: { to: { country: "AE" }, month: "2031-01" },
    });
    expect(prev.status).toBe(200);
    expect(prev.json.ops[0].path).toMatch(/^\/residency/);
    const bad = await send("POST", `/api/v1/plans/${UK_PLAN}/scenarios/relocation/preview`, {
      params: { to: { country: "AE" }, month: "2031-01", returnMonth: "2030-01" },
    });
    expect(bad.status).toBe(400);
    expect(bad.json.error.message).toMatch(/returnMonth: returnMonth must be after month/);
    const home = await send("POST", `/api/v1/plans/${UK_PLAN}/scenarios/relocation/preview`, {
      params: { to: { country: "GB" }, month: "2031-01" },
    });
    expect(home.json.error.message).toMatch(/already lives in GB/);
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

  it("read tools: timeline, rules, explain, tax by country, stay or move", async () => {
    const c = await client(false);
    const tools = (await c.listTools()).tools.map((t) => t.name);
    for (const n of [
      "get_residency_timeline",
      "cross_border_rules",
      "explain_item_taxation",
      "tax_by_country",
      "compare_stay_or_move",
    ])
      expect(tools).toContain(n);
    expect(tools).not.toContain("propose_move");
    const t = await call(c, "get_residency_timeline", { planId: UAE_RETURN_PLAN_ID });
    expect(t.crossBorder).toBe(true);
    expect(t.years.length).toBeLessThan(10); // only the years where residence changes
    const tr = await call(c, "cross_border_rules", {
      kind: "treaty",
      country: "GB",
      otherCountry: "AE",
    });
    expect(tr.known).toBe(true);
    const need = await call(c, "cross_border_rules", { kind: "treaty" });
    expect(need.isError).toBe(true);
    expect(need.error.message).toMatch(/needs country/);
    const tax = await call(c, "tax_by_country", { planId: UAE_RETURN_PLAN_ID });
    expect(tax.totals.rows.length).toBeGreaterThan(0);
    const ex = await call(c, "explain_item_taxation", {
      planId: UAE_RETURN_PLAN_ID,
      itemId: "uk-sipp",
    });
    expect(ex.treatments[0].sources).toBeUndefined();
    const sm = await call(c, "compare_stay_or_move", {
      planId: UK_PLAN,
      to: { country: "ae" },
      month: "2030-04",
    });
    expect(sm.deltas).toBeDefined();
    await c.close();
  });

  it("write tools: set_person_cross_border and propose_move (a change set)", async () => {
    const c = await client(true);
    const p = await call(c, "set_person_cross_border", {
      householdId: ukHousehold,
      personId: ukPerson,
      citizenships: ["gb"],
      statePensionRecords: [{ country: "gb", qualifyingYears: 20 }],
    });
    expect(p.profile.statePensionRecords[0].country).toBe("GB");
    const m = await call(c, "propose_move", { planId: UK_PLAN, country: "AE", month: "2032-01" });
    expect(m.status).toBe("proposed");
    expect(m.changes.length).toBeGreaterThan(0);
    await call(c, "discard_change_set", { changeSetId: m.id });
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
