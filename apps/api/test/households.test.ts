import { createSampleDocument } from "@glideworth/core/samples";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Harness, READ_KEY, setup } from "./helpers.js";

let h: Harness;
beforeEach(() => {
  h = setup();
});
afterEach(() => h.close());
const HH = "/api/v1/households/hh-sample";

describe("households and people", () => {
  it("lists with pagination, gets with ETag, and 304s on If-None-Match", async () => {
    const list = await h.call("/api/v1/households?limit=1");
    expect(list.json).toMatchObject({ total: 1, nextCursor: null });
    const got = await h.call(HH);
    expect(got.status).toBe(200);
    const etag = got.headers.get("etag")!;
    expect(etag).toMatch(/^"\d+"$/);
    const again = await h.call(HH, { headers: { "if-none-match": etag } });
    expect(again.status).toBe(304);
  });

  it("patches and replaces a household with optimistic concurrency", async () => {
    const got = await h.call(HH);
    const v = got.headers.get("etag")!;
    const ok = await h.call(HH, {
      method: "PATCH",
      body: { name: "Renamed" },
      headers: { "if-match": v },
    });
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ household: { name: "Renamed" }, version: 2 });
    const stale = await h.call(HH, {
      method: "PATCH",
      body: { name: "X" },
      headers: { "if-match": v },
    });
    expect(stale.status).toBe(409);
    expect(stale.json).toMatchObject({
      error: { code: "VERSION_CONFLICT", details: { currentVersion: 2 } },
    });
    const put = await h.call(HH, {
      method: "PUT",
      body: { ...(got.json as { household: object }).household, name: "Replaced" },
    });
    expect(put.status).toBe(200);
  });

  it("manages people: add partner switches mode; cannot remove the primary", async () => {
    const solo = createSampleDocument();
    solo.household.id = "hh-solo";
    solo.household.people = [solo.household.people[0]!];
    solo.household.planningMode = "individual";
    const created = await h.call("/api/v1/households", {
      method: "POST",
      body: { household: solo.household, finances: { asOf: "2026-01" } },
    });
    expect(created.status).toBe(201);
    const add = await h.call("/api/v1/households/hh-solo/people", {
      method: "POST",
      body: { id: "p-new", name: "Partner", role: "partner", birthMonth: "1990-05" },
    });
    expect(add.status).toBe(201);
    expect((await h.call("/api/v1/households/hh-solo")).json).toMatchObject({
      household: { planningMode: "couple" },
    });
    const upd = await h.call("/api/v1/households/hh-solo/people/p-new", {
      method: "PATCH",
      body: { name: "Pat" },
    });
    expect(upd.json).toMatchObject({ name: "Pat" });
    expect(
      (await h.call("/api/v1/households/hh-solo/people/p-avery", { method: "DELETE" })).status,
    ).toBe(409);
    expect(
      (await h.call("/api/v1/households/hh-solo/people/p-new", { method: "DELETE" })).status,
    ).toBe(204);
    expect((await h.call("/api/v1/households/hh-solo")).json).toMatchObject({
      household: { planningMode: "individual" },
    });
    expect((await h.call("/api/v1/households/hh-solo", { method: "DELETE" })).status).toBe(204);
    expect((await h.call("/api/v1/households/hh-solo")).status).toBe(404);
  });

  it("manages dependents", async () => {
    const add = await h.call(`${HH}/dependents`, {
      method: "POST",
      body: { name: "Kid", birthMonth: "2020-03" },
    });
    expect(add.status).toBe(201);
    const id = (add.json as { id: string }).id;
    expect(((await h.call(`${HH}/dependents`)).json as { items: unknown[] }).items).toHaveLength(2);
    expect(
      (await h.call(`${HH}/dependents/${id}`, { method: "PATCH", body: { independentAtAge: 21 } }))
        .json,
    ).toMatchObject({ independentAtAge: 21 });
    expect((await h.call(`${HH}/dependents/${id}`, { method: "DELETE" })).status).toBe(204);
  });
});

describe("accounts, real assets, debts", () => {
  it("CRUD with generated ids, merge patch, archive and in-use protection", async () => {
    const created = await h.call(`${HH}/accounts`, {
      method: "POST",
      body: { name: "New savings", type: "savings", owner: "p-avery", balance: 1000 },
    });
    expect(created.status).toBe(201);
    const id = (created.json as { id: string }).id;
    expect(id).toMatch(/^acct_/);
    expect((await h.call(`${HH}/accounts/${id}`)).json).toMatchObject({ balance: 1000 });
    const patched = await h.call(`${HH}/accounts/${id}`, {
      method: "PATCH",
      body: { balance: 1500, notes: "x" },
    });
    expect(patched.json).toMatchObject({ balance: 1500, notes: "x", name: "New savings" });
    const dup = await h.call(`${HH}/accounts`, {
      method: "POST",
      body: { id, name: "dup", type: "savings", owner: "p-avery", balance: 1 },
    });
    expect(dup.status).toBe(409);
    // An account referenced by a plan flow cannot be deleted without force.
    const inUse = await h.call(`${HH}/accounts/acc-cash`, { method: "DELETE" });
    expect(inUse.status).toBe(409);
    expect(inUse.json).toMatchObject({ error: { code: "IN_USE" } });
    expect((await h.call(`${HH}/accounts/${id}`, { method: "DELETE" })).status).toBe(204);
    const archived = await h.call(`${HH}/accounts/acc-cash`, {
      method: "PATCH",
      body: { archived: true },
    });
    expect((archived.json as { archived: boolean }).archived).toBe(true);
    const visible = (await h.call(`${HH}/accounts`)).json as { items: { id: string }[] };
    expect(visible.items.find((a) => a.id === "acc-cash")).toBeUndefined();
    const all = (await h.call(`${HH}/accounts?includeArchived=true`)).json as {
      items: { id: string }[];
    };
    expect(all.items.find((a) => a.id === "acc-cash")).toBeDefined();
  });

  it("real assets and debts have the same CRUD surface", async () => {
    expect((await h.call(`${HH}/real-assets/ra-home`)).json).toMatchObject({ id: "ra-home" });
    const p = await h.call(`${HH}/real-assets/ra-home`, {
      method: "PATCH",
      body: { currentValue: 999000 },
    });
    expect(p.json).toMatchObject({ currentValue: 999000 });
    expect(
      ((await h.call(`${HH}/debts`)).json as { items: unknown[] }).items.length,
    ).toBeGreaterThan(0);
    expect(
      (await h.call(`${HH}/debts/debt-car`, { method: "PATCH", body: { balance: 100 } })).json,
    ).toMatchObject({ balance: 100 });
    expect((await h.call(`${HH}/debts/nope`)).status).toBe(404);
  });

  it("bulk balance update is atomic, optionally snapshots, and reports unknown ids", async () => {
    const bad = await h.call(`${HH}/balances`, {
      method: "POST",
      body: {
        accounts: [
          { accountId: "acc-cash", balance: 1 },
          { accountId: "ghost", balance: 2 },
        ],
      },
    });
    expect(bad.status).toBe(404);
    expect(bad.json).toMatchObject({ error: { details: { unknownIds: ["ghost"] } } });
    expect((await h.call(`${HH}/accounts/acc-cash`)).json).toMatchObject({ balance: 28500 }); // unchanged
    const ok = await h.call(`${HH}/balances`, {
      method: "POST",
      body: {
        asOf: "2026-06",
        accounts: [
          { accountId: "acc-cash", balance: 30000 },
          { accountId: "acc-brokerage", balance: 170000, costBasis: 100000 },
        ],
        debts: [{ debtId: "debt-car", balance: 5000 }],
        snapshotNote: "bank sync",
      },
    });
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({
      updated: { accounts: 2, debts: 1 },
      snapshot: { source: "auto", note: "bank sync" },
    });
    expect((await h.call(HH)).json).toMatchObject({ finances: { asOf: "2026-06" } });
    expect((await h.call(`${HH}/accounts/acc-brokerage`)).json).toMatchObject({
      balance: 170000,
      costBasis: 100000,
    });
    // Auto snapshots are one per day: a second push replaces today's.
    await h.call(`${HH}/balances`, {
      method: "POST",
      body: { accounts: [{ accountId: "acc-cash", balance: 31000 }] },
    });
    const snaps = (await h.call(`${HH}/snapshots?from=${new Date().toISOString().slice(0, 10)}`))
      .json as {
      items: { source: string }[];
    };
    expect(snaps.items.filter((s) => s.source === "auto")).toHaveLength(1);
    // Opt out.
    const none = await h.call(`${HH}/balances`, {
      method: "POST",
      body: { accounts: [{ accountId: "acc-cash", balance: 1 }], recordSnapshot: false },
    });
    expect((none.json as { snapshot: unknown }).snapshot).toBeNull();
  });
});

describe("progress snapshots", () => {
  it("records, lists, edits, deletes and bulk imports", async () => {
    const rec = await h.call(`${HH}/snapshots/record`, {
      method: "POST",
      body: { date: "2026-01-31", note: "jan" },
    });
    expect(rec.status).toBe(201);
    const snap = rec.json as { id: string; netWorth: number; assets: number };
    expect(snap.netWorth).toBeGreaterThan(0);
    const created = await h.call(`${HH}/snapshots`, {
      method: "POST",
      body: { date: "2026-02-28", netWorth: 100, assets: 150, liabilities: 50 },
    });
    expect(created.status).toBe(201);
    const list = await h.call(`${HH}/snapshots`);
    const dates = (list.json as { items: { date: string }[] }).items.map((s) => s.date);
    expect(dates).toEqual([...dates].sort().reverse());
    expect(dates).toEqual(expect.arrayContaining(["2026-02-28", "2026-01-31"]));
    const edited = await h.call(`${HH}/snapshots/${snap.id}`, {
      method: "PATCH",
      body: { note: "edited" },
    });
    expect(edited.json).toMatchObject({ note: "edited", id: snap.id });
    expect((await h.call(`${HH}/snapshots/${snap.id}`, { method: "DELETE" })).status).toBe(204);
    const bulk = await h.call(`${HH}/snapshots/bulk`, {
      method: "POST",
      body: {
        items: [
          { id: "s1", date: "2020-01-01", netWorth: 1, assets: 1, liabilities: 0 },
          { id: "s2", date: "2020-02-01", netWorth: 2, assets: 2, liabilities: 0 },
        ],
      },
    });
    expect(bulk.json).toEqual({ created: 2, replaced: 0, skipped: 0 });
    const again = await h.call(`${HH}/snapshots/bulk`, {
      method: "POST",
      body: {
        items: [{ id: "s1", date: "2020-01-01", netWorth: 9, assets: 9, liabilities: 0 }],
        onConflict: "replace",
      },
    });
    expect(again.json).toEqual({ created: 0, replaced: 1, skipped: 0 });
    expect((await h.call(`${HH}/snapshots/s1`)).json).toMatchObject({ netWorth: 9 });
    expect(
      (
        await h.call(`${HH}/snapshots/bulk`, {
          method: "POST",
          body: {
            items: [{ id: "s1", date: "2020-01-01", netWorth: 1, assets: 1, liabilities: 0 }],
            onConflict: "error",
          },
        })
      ).status,
    ).toBe(409);
  });

  it("emits snapshot.created events", async () => {
    const seen: string[] = [];
    h.services.events.on("event", (e: { name: string }) => seen.push(e.name));
    await h.call(`${HH}/snapshots/record`, { method: "POST", body: {} });
    expect(seen).toContain("snapshot.created");
  });
});

describe("settings, export and import", () => {
  it("reads, patches and replaces settings", async () => {
    expect((await h.call("/api/v1/settings", { key: READ_KEY })).json).toMatchObject({
      theme: "system",
    });
    expect(
      (
        await h.call("/api/v1/settings", {
          method: "PATCH",
          body: { theme: "dark", spending: { includeTaxes: true } },
        })
      ).json,
    ).toMatchObject({ theme: "dark", spending: { includeTaxes: true, includeMortgage: true } });
    expect(
      (await h.call("/api/v1/settings", { method: "PATCH", body: { theme: "nope" } })).status,
    ).toBe(400);
  });

  it("exports a document and re-imports it (create conflicts, replace works, dryRun writes nothing)", async () => {
    const exported = await h.call(`${HH}/export`);
    expect(exported.status).toBe(200);
    expect(exported.headers.get("content-disposition")).toContain("attachment");
    const doc = exported.json as { household: { id: string }; plans: unknown[] };
    expect(doc.plans.length).toBe(2);
    const conflict = await h.call("/api/v1/import", { method: "POST", body: { data: doc } });
    expect(conflict.status).toBe(409);
    const dry = await h.call("/api/v1/import", {
      method: "POST",
      body: { data: doc, dryRun: true },
    });
    expect(dry.json).toMatchObject({ format: "glideworth", imported: false, stats: { plans: 2 } });
    const replaced = await h.call("/api/v1/import", {
      method: "POST",
      body: { data: doc, mode: "replace" },
    });
    expect(replaced.json).toMatchObject({ imported: true, householdId: "hh-sample" });
    expect(((await h.call("/api/v1/plans")).json as { total: number }).total).toBe(2);
    // Import into a clean database as a different household id.
    const other = setup({ seed: false });
    const imp = await other.call("/api/v1/import", { method: "POST", body: { data: doc } });
    expect(imp.status).toBe(200);
    expect(
      ((await other.call("/api/v1/plans/plan-main")).json as { version: number }).version,
    ).toBe(1);
    other.close();
  });

  it("rejects an invalid document with 400", async () => {
    const r = await h.call("/api/v1/import", {
      method: "POST",
      body: { data: { app: "glideworth", schemaVersion: 1 } },
    });
    expect(r.status).toBe(400);
  });

  it("routes ProjectionLab exports through the importer (injected fake)", async () => {
    const doc = createSampleDocument();
    doc.household.id = "hh-pl";
    doc.plans = [];
    doc.progress = [];
    const fake = setup({ seed: false });
    (fake.services.ctx as { imports: unknown }).imports = {
      detectProjectionLabExport: () => true,
      importProjectionLab: () => ({
        document: doc,
        issues: [{ severity: "warning", sourcePath: "$.x", message: "m" }],
        stats: { accounts: 5 },
        report: { ok: true },
      }),
    };
    const dry = await fake.call("/api/v1/import", {
      method: "POST",
      body: { data: { today: {}, plans: [], meta: {} }, dryRun: true },
    });
    expect(dry.json).toMatchObject({
      format: "projectionlab",
      imported: false,
      issues: [{ severity: "warning" }],
      stats: { accounts: 5 },
      report: { ok: true },
    });
    const real = await fake.call("/api/v1/import", {
      method: "POST",
      body: { data: { today: {}, plans: [], meta: {} } },
    });
    expect(real.json).toMatchObject({ imported: true, householdId: "hh-pl" });
    fake.close();
  });

  it("an unimplemented importer is a 501 with its workstream", async () => {
    const fake = setup({ seed: false });
    const { NotImplementedError } = await import("@glideworth/core");
    (fake.services.ctx as { imports: unknown }).imports = {
      detectProjectionLabExport: () => false,
      importProjectionLab: () => {
        throw new NotImplementedError("importers.projectionLab", "f");
      },
      importCsvInto: () => {
        throw new NotImplementedError("importers.csv", "f");
      },
    };
    fake.services.households.importDocument(createSampleDocument(), { kind: "system" });
    const r = await fake.call("/api/v1/households/hh-sample/import/csv", {
      method: "POST",
      body: { text: "x", kind: "account-balances" },
    });
    expect(r.status).toBe(501);
    expect(r.json).toMatchObject({
      error: { code: "NOT_IMPLEMENTED", details: { workstream: "f" } },
    });
    fake.close();
  });
});
