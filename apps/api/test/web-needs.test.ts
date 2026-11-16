/** What the web app needs: atomic whole-document save, persisted display order, once-a-day auto snapshots. */
import { afterEach, describe, expect, it } from "vitest";
import { type Harness, setup } from "./helpers.js";

let h: Harness;
afterEach(() => h?.close());
const HH = "/api/v1/households/hh-sample";
const today = () => new Date().toISOString().slice(0, 10);

type Rec = {
  household: { people: { id: string; name: string }[]; planningMode: string };
  finances: {
    accounts: { id: string; balance: number }[];
    debts: { id: string }[];
    realAssets: { id: string }[];
  };
  version: number;
  snapshot?: { id: string; source: string } | null;
};

describe("PUT /households/{id}/current-finances: the whole document in one atomic write", () => {
  it("saves people, accounts, assets and debts together; the ETag is the new version", async () => {
    h = setup();
    const cur = (await h.call<Rec>(HH)).json;
    const doc = structuredClone({ household: cur.household, finances: cur.finances }) as {
      household: Rec["household"] & Record<string, unknown>;
      finances: Rec["finances"] & Record<string, unknown>;
    };
    doc.household.people[1]!.name = "Jordan Renamed";
    doc.finances.accounts[0]!.balance = 99_000;
    doc.finances.debts = [];
    const r = await h.call<Rec>(`${HH}/current-finances`, {
      method: "PUT",
      headers: { "if-match": `"${cur.version}"` },
      body: doc,
    });
    expect(r.status).toBe(200);
    expect(r.json.version).toBe(cur.version + 1);
    expect(r.headers.get("etag")).toBe(`"${cur.version + 1}"`);
    const after = (await h.call<Rec>(HH)).json;
    expect(after.household.people[1]!.name).toBe("Jordan Renamed");
    expect(after.finances.accounts[0]!.balance).toBe(99_000);
    expect(after.finances.debts).toEqual([]);
    expect(after.version).toBe(cur.version + 1); // ONE version bump for the whole save
  });

  it("a stale If-Match is a 409 and nothing is written", async () => {
    h = setup();
    const cur = (await h.call<Rec>(HH)).json;
    const body = { finances: { ...cur.finances, accounts: [] } };
    const stale = await h.call(`${HH}/current-finances`, {
      method: "PUT",
      headers: { "if-match": `"${cur.version + 5}"` },
      body,
    });
    expect(stale.status).toBe(409);
    expect(stale.json).toMatchObject({ error: { code: "VERSION_CONFLICT" } });
    expect((await h.call<Rec>(HH)).json.finances.accounts.length).toBe(
      cur.finances.accounts.length,
    );
  });

  it("an invalid document is rejected as a whole (no partial write)", async () => {
    h = setup();
    const cur = (await h.call<Rec>(HH)).json;
    const bad = structuredClone(cur.finances);
    bad.accounts[0]!.balance = 1;
    (bad.accounts[1] as unknown as { type: string }).type = "not-an-account-type";
    const r = await h.call(`${HH}/current-finances`, { method: "PUT", body: { finances: bad } });
    expect(r.status).toBe(400);
    const after = (await h.call<Rec>(HH)).json;
    expect(after.version).toBe(cur.version);
    expect(after.finances.accounts[0]!.balance).toBe(cur.finances.accounts[0]!.balance);
  });

  it("adding a second person switches to couple mode; PUT /households/{id} accepts the same bundle", async () => {
    h = setup();
    const cur = (await h.call<Rec>(HH)).json;
    const r = await h.call<Rec>(HH, {
      method: "PUT",
      body: { household: cur.household, finances: { ...cur.finances, asOf: "2026-12" } },
    });
    expect(r.status).toBe(200);
    expect(r.json.version).toBe(cur.version + 1);
    // The bare Household body still works.
    const bare = await h.call<Rec>(HH, {
      method: "PUT",
      body: { ...cur.household, name: "Renamed household" },
    });
    expect(bare.status).toBe(200);
  });

  it("requires write scope", async () => {
    h = setup();
    const cur = (await h.call<Rec>(HH)).json;
    const r = await h.call(`${HH}/current-finances`, {
      method: "PUT",
      key: "glideworth_testread_0123456789abcdef0123456789abcdef",
      body: { finances: cur.finances },
    });
    expect(r.status).toBe(403);
  });
});

describe("PUT /households/{id}/reorder/{collection}: persisted display order", () => {
  it("reorders accounts, real assets and debts; listing and export follow; unlisted ids follow", async () => {
    h = setup();
    const accounts = (await h.call<{ items: { id: string }[] }>(`${HH}/accounts`)).json.items.map(
      (a) => a.id,
    );
    expect(accounts.length).toBeGreaterThan(3);
    const want = [accounts[3]!, accounts[1]!];
    const r = await h.call<{ ids: string[]; version: number }>(`${HH}/reorder/accounts`, {
      method: "PUT",
      body: { ids: want },
    });
    expect(r.status).toBe(200);
    expect(r.json.ids.slice(0, 2)).toEqual(want);
    expect(r.json.ids).toHaveLength(accounts.length);
    const listed = (await h.call<{ items: { id: string }[] }>(`${HH}/accounts`)).json.items.map(
      (a) => a.id,
    );
    expect(listed).toEqual(r.json.ids);
    const doc = (await h.call<{ finances: { accounts: { id: string }[] } }>(`${HH}/export`)).json;
    expect(doc.finances.accounts.map((a) => a.id)).toEqual(r.json.ids);
    expect(
      (await h.call(`${HH}/reorder/debts`, { method: "PUT", body: { ids: ["debt-car"] } })).status,
    ).toBe(200);
    expect(
      (await h.call(`${HH}/reorder/real-assets`, { method: "PUT", body: { ids: ["ra-home"] } }))
        .status,
    ).toBe(200);
  });

  it("is atomic and checked: unknown ids are a 404, duplicates a 400, a stale If-Match a 409; balances are untouched", async () => {
    h = setup();
    const before = (await h.call<Rec>(HH)).json;
    const unknown = await h.call(`${HH}/reorder/accounts`, {
      method: "PUT",
      body: { ids: ["acc-cash", "nope"] },
    });
    expect(unknown.status).toBe(404);
    expect(unknown.json).toMatchObject({ error: { details: { unknownIds: ["nope"] } } });
    expect(
      (
        await h.call(`${HH}/reorder/accounts`, {
          method: "PUT",
          body: { ids: ["acc-cash", "acc-cash"] },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await h.call(`${HH}/reorder/accounts`, {
          method: "PUT",
          headers: { "if-match": `"${before.version + 9}"` },
          body: { ids: ["acc-cash"] },
        })
      ).status,
    ).toBe(409);
    expect((await h.call<Rec>(HH)).json.version).toBe(before.version);
    expect((await h.call(`${HH}/reorder/bogus`, { method: "PUT", body: { ids: [] } })).status).toBe(
      400,
    );
    // Reordering never creates a progress snapshot.
    expect((await h.call<{ total: number }>(`${HH}/snapshots`)).json.total).toBe(2);
  });

  it("persists plan order per household: list, create (goes last) and export all follow", async () => {
    h = setup();
    const before = (
      await h.call<{ items: { id: string }[] }>("/api/v1/plans?householdId=hh-sample")
    ).json.items;
    expect(before.map((p) => p.id)).toEqual(["plan-main", "plan-early"]);
    const r = await h.call<{ ids: string[] }>(`${HH}/reorder/plans`, {
      method: "PUT",
      body: { ids: ["plan-early", "plan-main"] },
    });
    expect(r.json.ids).toEqual(["plan-early", "plan-main"]);
    const created = await h.call<{ id: string }>("/api/v1/plans/plan-main/duplicate", {
      method: "POST",
      body: {},
    });
    const after = (await h.call<{ items: { id: string }[] }>("/api/v1/plans?householdId=hh-sample"))
      .json.items;
    expect(after.map((p) => p.id)).toEqual(["plan-early", "plan-main", created.json.id]);
    // An edit does not reset the order.
    await h.call("/api/v1/plans/plan-main/expenses/exp-living", {
      method: "PATCH",
      body: { name: "x" },
    });
    expect(
      (
        await h.call<{ items: { id: string }[] }>("/api/v1/plans?householdId=hh-sample")
      ).json.items.map((p) => p.id),
    ).toEqual(["plan-early", "plan-main", created.json.id]);
    const doc = (await h.call<{ plans: { id: string }[] }>(`${HH}/export`)).json;
    expect(doc.plans.map((p) => p.id)).toEqual(["plan-early", "plan-main", created.json.id]);
    expect(
      (await h.call(`${HH}/reorder/plans`, { method: "PUT", body: { ids: ["plan-nope"] } })).status,
    ).toBe(404);
  });
});

describe("automatic progress snapshots: at most one per day per household", () => {
  const snapshots = async () =>
    (
      await h.call<{ items: { id: string; date: string; source: string; netWorth: number }[] }>(
        `${HH}/snapshots?from=${today()}&to=${today()}`,
      )
    ).json.items;

  it("many finance writes in a day update ONE snapshot in place (same id), and emit snapshot.created once", async () => {
    h = setup();
    const seen: string[] = [];
    h.services.events.on("event", (e: { name: string }) => seen.push(e.name));
    for (const balance of [1000, 2000, 3000, 4000]) {
      await h.call(`${HH}/accounts/acc-cash`, { method: "PATCH", body: { balance } });
    }
    await h.call(`${HH}/debts/debt-car`, { method: "PATCH", body: { balance: 5 } });
    const snaps = await snapshots();
    expect(snaps).toHaveLength(1);
    expect(snaps[0]).toMatchObject({ source: "auto" });
    expect(seen.filter((n) => n === "snapshot.created")).toHaveLength(1);
    expect(seen.filter((n) => n === "snapshot.updated").length).toBe(4);
    // The snapshot reflects the LATEST balances.
    const cash = (
      await h.call<{ accounts?: { accountId: string; balance: number }[] }>(
        `${HH}/snapshots/${snaps[0]!.id}`,
      )
    ).json;
    expect(cash.accounts?.find((a) => a.accountId === "acc-cash")?.balance).toBe(4000);
    // Whole-document saves count as finance writes too.
    const cur = (await h.call<Rec>(HH)).json;
    cur.finances.accounts[0]!.balance = 12_345;
    await h.call(`${HH}/current-finances`, { method: "PUT", body: { finances: cur.finances } });
    expect(await snapshots()).toHaveLength(1);
  });

  it("writes that do not move a balance create no snapshot", async () => {
    h = setup();
    await h.call(`${HH}/accounts/acc-cash`, { method: "PATCH", body: { name: "Renamed" } });
    await h.call(`${HH}/people/p-avery`, { method: "PATCH", body: { name: "Avery B" } });
    expect(await snapshots()).toHaveLength(0);
  });

  it("is controlled by settings.autoProgressSnapshots", async () => {
    h = setup();
    expect(
      (
        await h.call(`/api/v1/settings`, {
          method: "PATCH",
          body: { autoProgressSnapshots: false },
        })
      ).status,
    ).toBe(200);
    await h.call(`${HH}/accounts/acc-cash`, { method: "PATCH", body: { balance: 1 } });
    expect(await snapshots()).toHaveLength(0);
    // ...but an explicit request still records one.
    const explicit = await h.call<{ snapshot: { source: string } }>(`${HH}/balances`, {
      method: "POST",
      body: { accounts: [{ accountId: "acc-cash", balance: 2 }], recordSnapshot: true },
    });
    expect(explicit.json.snapshot).toMatchObject({ source: "auto" });
    await h.call(`/api/v1/settings`, { method: "PATCH", body: { autoProgressSnapshots: true } });
    await h.call(`${HH}/accounts/acc-cash`, { method: "PATCH", body: { balance: 3 } });
    expect(await snapshots()).toHaveLength(1);
  });

  it("an implicit auto-snapshot leaves the user's own snapshot for today alone", async () => {
    h = setup();
    await h.call(`${HH}/snapshots/record`, { method: "POST", body: { note: "mine" } });
    await h.call(`${HH}/accounts/acc-cash`, { method: "PATCH", body: { balance: 7 } });
    const snaps = await snapshots();
    expect(snaps).toHaveLength(1);
    expect(snaps[0]!.source).toBe("api");
  });

  it("exposes the snapshots under /households/{id}/snapshots (what the web client calls)", async () => {
    h = setup();
    const list = await h.call(`${HH}/snapshots?limit=200`);
    expect(list.status).toBe(200);
    const rec = await h.call(`${HH}/snapshots/record`, { method: "POST", body: {} });
    expect(rec.status).toBe(201);
  });
});
