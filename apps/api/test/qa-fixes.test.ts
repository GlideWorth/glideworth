/** Regression tests for the defects logged against apps/api in docs/QA-FINDINGS.md (Q7-Q9, version numbering, import history). */
import { createSampleDocument } from "@glideworth/core/samples";
import { afterEach, describe, expect, it } from "vitest";
import { listenOrigin, setupTokenWarning } from "../src/startup.js";
import { type Harness, SIM_KEY, setup } from "./helpers.js";

let h: Harness;
afterEach(() => h?.close());

const solo = () => {
  const d = createSampleDocument();
  d.household.id = "hh-new";
  d.household.people = [d.household.people[0]!];
  d.household.planningMode = "individual";
  return d.household;
};

describe("Q7: a household created without finances is dated this month", () => {
  it("REST: omitted finances -> asOf is the current month, empty balances", async () => {
    h = setup();
    const r = await h.call("/api/v1/households", { method: "POST", body: { household: solo() } });
    expect(r.status).toBe(201);
    const month = new Date().toISOString().slice(0, 7);
    expect(r.json.finances.asOf).toBe(month);
    expect(r.json.finances.accounts).toEqual([]);
    expect(r.json.finances.asOf).not.toBe("2000-01");
    const back = await h.call("/api/v1/households/hh-new");
    expect(back.json.finances.asOf).toBe(month);
  });

  it("a plan that follows live finances starts this year, not 2000 (real engine)", async () => {
    h = setup({ realEngine: true, seed: false });
    await h.call("/api/v1/households", { method: "POST", body: { household: solo() } });
    const sampleDoc = createSampleDocument();
    const cash = sampleDoc.finances.accounts.find((a) => a.id === "acc-cash")!;
    const added = await h.call("/api/v1/households/hh-new/accounts", {
      method: "POST",
      body: { ...cash, owner: solo().people[0]!.id },
    });
    expect(added.status, added.text.slice(0, 300)).toBe(201);
    const plan = sampleDoc.plans[0]!;
    const p = await h.call("/api/v1/plans", {
      method: "POST",
      body: {
        ...plan,
        id: "plan-new",
        householdId: "hh-new",
        flows: [],
        income: [],
        expenses: [],
        milestones: [],
      },
    });
    expect(p.status).toBe(201);
    const sim = await h.call("/api/v1/plans/plan-new/simulate", {
      method: "POST",
      body: { view: { everyNYears: 50 } },
    });
    expect(sim.status, sim.text.slice(0, 400)).toBe(200);
    const first = JSON.stringify(sim.json).match(/"year":(\d{4})/);
    expect(Number(first?.[1])).toBeGreaterThanOrEqual(new Date().getFullYear());
  });

  it("explicit finances are kept as given", async () => {
    h = setup();
    const r = await h.call("/api/v1/households", {
      method: "POST",
      body: { household: solo(), finances: { asOf: "2025-03" } },
    });
    expect(r.json.finances.asOf).toBe("2025-03");
  });
});

describe("Q8: balances update mortgage and other debt balances", () => {
  const home = (h: Harness) =>
    h.services.households.get("hh-sample").finances.realAssets.find((a) => a.loan);

  it("realAssets[].loanBalance sets the loan balance; currentValue stays", async () => {
    h = setup();
    const before = home(h)!;
    const r = await h.call("/api/v1/households/hh-sample/balances", {
      method: "POST",
      body: { realAssets: [{ assetId: before.id, loanBalance: 111_111 }], recordSnapshot: false },
    });
    expect(r.status).toBe(200);
    expect(home(h)!.loan!.balance).toBe(111_111);
    expect(home(h)!.currentValue).toBe(before.currentValue);
  });

  it("debts[] accepts the asset id to set its loan balance, and plain debts still work", async () => {
    h = setup();
    const a = home(h)!;
    const debt = h.services.households.get("hh-sample").finances.debts[0];
    const r = await h.call("/api/v1/households/hh-sample/balances", {
      method: "POST",
      body: {
        debts: [
          { debtId: a.id, balance: 90_000 },
          ...(debt ? [{ debtId: debt.id, balance: 1234 }] : []),
        ],
        recordSnapshot: false,
      },
    });
    expect(r.status).toBe(200);
    expect(home(h)!.loan!.balance).toBe(90_000);
    if (debt)
      expect(
        h.services.households.get("hh-sample").finances.debts.find((d) => d.id === debt.id)!
          .balance,
      ).toBe(1234);
  });

  it("is atomic: an unknown id changes nothing; an asset without a loan is a 422", async () => {
    h = setup();
    const a = home(h)!;
    const bad = await h.call("/api/v1/households/hh-sample/balances", {
      method: "POST",
      body: {
        realAssets: [{ assetId: a.id, loanBalance: 5 }],
        debts: [{ debtId: "nope", balance: 1 }],
      },
    });
    expect(bad.status).toBe(404);
    expect(home(h)!.loan!.balance).toBe(a.loan!.balance);
    const rec = h.services.households.get("hh-sample").finances;
    const noLoan = rec.realAssets.find((x) => !x.loan);
    if (noLoan) {
      const r = await h.call("/api/v1/households/hh-sample/balances", {
        method: "POST",
        body: { realAssets: [{ assetId: noLoan.id, loanBalance: 5 }] },
      });
      expect(r.status).toBe(422);
    }
    const empty = await h.call("/api/v1/households/hh-sample/balances", {
      method: "POST",
      body: { realAssets: [{ assetId: a.id }] },
    });
    expect(empty.status).toBe(400);
  });

  it("the snapshot records the new loan balance (net worth moves)", async () => {
    h = setup();
    const a = home(h)!;
    const r = await h.call("/api/v1/households/hh-sample/balances", {
      method: "POST",
      body: { realAssets: [{ assetId: a.id, loanBalance: 1 }], recordSnapshot: true },
    });
    const snap = r.json.snapshot;
    expect(snap.realAssets.find((x: { assetId: string }) => x.assetId === a.id).loanBalance).toBe(
      1,
    );
  });

  it("MCP update_account_balances sets a mortgage balance", async () => {
    h = setup({ mcpAllowWrites: true });
    const { createMcpServer } = await import("../src/mcp/server.js");
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const server = createMcpServer({
      services: h.services,
      scopes: ["read", "simulate", "write"],
      canWrite: true,
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "1" });
    await Promise.all([server.connect(a), client.connect(b)]);
    const asset = home(h)!;
    const res = (await client.callTool({
      name: "update_account_balances",
      arguments: {
        householdId: "hh-sample",
        realAssets: [{ assetId: asset.id, loanBalance: 42_000 }],
        recordSnapshot: false,
      },
    })) as { isError?: boolean };
    expect(res.isError).toBeFalsy();
    expect(home(h)!.loan!.balance).toBe(42_000);
    await client.close();
  });
});

describe("Q9: start-up messages", () => {
  it("shows the bound address, not localhost, for a specific bind; localhost for a wildcard", () => {
    expect(listenOrigin({ address: "127.0.0.1", port: 8794 })).toBe("http://127.0.0.1:8794");
    expect(listenOrigin({ address: "192.168.1.5", port: 1 })).toBe("http://192.168.1.5:1");
    expect(listenOrigin({ address: "::1", port: 2 })).toBe("http://[::1]:2");
    expect(listenOrigin({ address: "::", port: 3 })).toBe("http://localhost:3");
    expect(listenOrigin({ address: "0.0.0.0", port: 3 })).toBe("http://localhost:3");
  });

  it("warns about the missing setup token only when others can reach the port", () => {
    const base = { production: true, setupToken: undefined };
    expect(setupTokenWarning({ ...base, address: "127.0.0.1" })).toBeNull();
    expect(setupTokenWarning({ ...base, address: "::1" })).toBeNull();
    expect(setupTokenWarning({ ...base, address: "::" })).toMatch(/GLIDEWORTH_SETUP_TOKEN/);
    expect(setupTokenWarning({ ...base, address: "10.0.0.4" })).toMatch(/GLIDEWORTH_SETUP_TOKEN/);
    expect(setupTokenWarning({ ...base, address: undefined })).toMatch(/GLIDEWORTH_SETUP_TOKEN/);
    expect(
      setupTokenWarning({ production: true, setupToken: "a-long-token", address: "::" }),
    ).toBeNull();
    expect(
      setupTokenWarning({ production: false, setupToken: undefined, address: "::" }),
    ).toBeNull();
  });
});

describe("versions: households start at 1 like plans", () => {
  it('a new household is version 1 (ETag "1"); the first edit makes 2', async () => {
    h = setup({ seed: false });
    const r = await h.call("/api/v1/households", { method: "POST", body: { household: solo() } });
    expect(r.json.version).toBe(1);
    expect(r.headers.get("etag")).toBe('"1"');
    const p = await h.call("/api/v1/households/hh-new", {
      method: "PATCH",
      body: { name: "N" },
      headers: { "if-match": '"1"' },
    });
    expect(p.json.version).toBe(2);
  });

  it("imported households (create) are version 1 as well", async () => {
    h = setup();
    expect(h.services.households.get("hh-sample").version).toBe(1);
  });
});

describe("POST /import preserves plan version history", () => {
  const edit = async (v: number) => {
    const r = await h.call("/api/v1/plans/plan-main", {
      method: "PATCH",
      body: [{ op: "replace", path: "/expenses/[id=exp-living]/amount/value", value: 5000 + v }],
      headers: { "content-type": "application/json-patch+json", "if-match": `"${v}"` },
    });
    expect(r.status).toBe(200);
  };

  it('replace: existing plans continue their numbering, keep their history and add an "imported" entry', async () => {
    h = setup();
    await edit(1);
    await edit(2);
    const before = (await h.call("/api/v1/plans/plan-main/versions")).json.items.length;
    expect(before).toBe(3);
    const doc = (await h.call("/api/v1/households/hh-sample/export")).json;
    const r = await h.call("/api/v1/import", {
      method: "POST",
      body: { data: doc, mode: "replace" },
    });
    expect(r.status).toBe(200);
    const v = (await h.call("/api/v1/plans/plan-main/versions")).json.items as {
      version: number;
      message: string;
    }[];
    expect(v.map((x) => x.version)).toEqual([4, 3, 2, 1]);
    expect(v[0]!.message).toBe("imported");
    expect(v[3]!.message).not.toBe("imported-never");
    expect((await h.call("/api/v1/plans/plan-main")).json.version).toBe(4);
    // history is still restorable
    expect((await h.call("/api/v1/plans/plan-main/versions/2")).status).toBe(200);
  });

  it("replace removes plans that are not in the document (and their history)", async () => {
    h = setup();
    const doc = (await h.call("/api/v1/households/hh-sample/export")).json;
    const extra = await h.call("/api/v1/plans/plan-main/duplicate", {
      method: "POST",
      body: { name: "Extra" },
    });
    expect(extra.status).toBe(201);
    await h.call("/api/v1/import", { method: "POST", body: { data: doc, mode: "replace" } });
    expect((await h.call(`/api/v1/plans/${extra.json.id}`)).status).toBe(404);
  });

  it("merge: keeps plans and snapshots that the document does not have", async () => {
    h = setup();
    const doc = (await h.call("/api/v1/households/hh-sample/export")).json;
    const extra = await h.call("/api/v1/plans/plan-main/duplicate", {
      method: "POST",
      body: { name: "Extra" },
    });
    const r = await h.call("/api/v1/import", {
      method: "POST",
      body: { data: doc, mode: "merge" },
    });
    expect(r.status).toBe(200);
    expect((await h.call(`/api/v1/plans/${extra.json.id}`)).status).toBe(200);
    const v = (await h.call("/api/v1/plans/plan-main/versions")).json.items as {
      version: number;
      message: string;
    }[];
    expect(v[0]!.message).toBe("imported");
    expect(v[0]!.version).toBe(2);
  });

  it('create into a new household: every plan starts at version 1 with an "imported" entry', async () => {
    h = setup({ seed: false });
    const doc = createSampleDocument();
    const r = await h.call("/api/v1/import", { method: "POST", body: { data: doc } });
    expect(r.status).toBe(200);
    const v = (await h.call("/api/v1/plans/plan-main/versions")).json.items as {
      version: number;
      message: string;
    }[];
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ version: 1, message: "imported" });
  });
});

describe("a simulate-only key can no longer cancel every job", () => {
  it("a credential cancels its own jobs; someone else’s need write", async () => {
    h = setup();
    const mine = await h.call("/api/v1/plans/plan-main/monte-carlo", {
      method: "POST",
      key: SIM_KEY,
      body: {},
    });
    const theirs = await h.call("/api/v1/plans/plan-main/monte-carlo", {
      method: "POST",
      body: { settings: { trials: 123 } },
    });
    expect([200, 202]).toContain(mine.status);
    const denied = await h.call(`/api/v1/jobs/${theirs.json.id}/cancel`, {
      method: "POST",
      key: SIM_KEY,
    });
    expect(denied.status).toBe(403);
    expect(denied.json.error.details).toMatchObject({ required: "write" });
    expect(
      (await h.call(`/api/v1/jobs/${mine.json.id}/cancel`, { method: "POST", key: SIM_KEY }))
        .status,
    ).toBe(200);
    // a write key may cancel any job
    expect((await h.call(`/api/v1/jobs/${mine.json.id}/cancel`, { method: "POST" })).status).toBe(
      200,
    );
    await h.services.jobs.waitFor(theirs.json.id, 10_000);
    await h.services.jobs.waitFor(mine.json.id, 10_000);
  });
});

describe("Q1: today’s money uses core’s single conversion (flows by the period-start index)", () => {
  it("first-year flows read back as entered: real equals nominal in year 1, taxes and spending alike", async () => {
    h = setup({ realEngine: true });
    const get = async (basis: "real" | "nominal") =>
      (
        await h.call("/api/v1/plans/plan-main/simulate", {
          method: "POST",
          body: {
            view: {
              basis,
              series: ["spending", "income", "taxes", "netWorth"],
              toYear: new Date().getFullYear() + 2,
            },
          },
        })
      ).json.years as { spending: number; income: number; taxes: number; netWorth: number }[];
    const real = await get("real");
    const nominal = await get("nominal");
    expect(real[0]!.spending).toBe(nominal[0]!.spending);
    expect(real[0]!.income).toBe(nominal[0]!.income);
    expect(real[0]!.taxes).toBe(nominal[0]!.taxes);
    // balances are deflated at the period end, so they differ from nominal in year 1
    expect(real[0]!.netWorth).toBeLessThan(nominal[0]!.netWorth);
    // later years deflate flows by the start-of-year index: smaller than nominal
    expect(real[2]!.spending).toBeLessThan(nominal[2]!.spending);
  });
});
