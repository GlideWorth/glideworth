import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Harness, READ_KEY, setup } from "./helpers.js";

let h: Harness;
beforeEach(() => {
  h = setup();
});
afterEach(() => h.close());
const P = "/api/v1/plans/plan-main";
type Plan = {
  id: string;
  version: number;
  name: string;
  income: { id: string; amount: { value: number } }[];
  expenses: { id: string; amount: { value: number } }[];
  flows: { id: string }[];
  milestones: { id: string }[];
  isMain: boolean;
  status: string;
  lineage?: { parentPlanId: string; patch: unknown[] };
};
const getPlan = async (id = "plan-main") => (await h.call<Plan>(`/api/v1/plans/${id}`)).json;

describe("plan CRUD, concurrency, idempotency", () => {
  it("lists, filters and paginates", async () => {
    const all = await h.call<{ items: Plan[]; total: number; nextCursor: string | null }>(
      "/api/v1/plans?limit=1",
    );
    expect(all.json.total).toBe(2);
    expect(all.json.nextCursor).toBeTruthy();
    const next = await h.call<{ items: Plan[] }>(
      `/api/v1/plans?limit=1&cursor=${all.json.nextCursor}`,
    );
    expect(next.json.items[0]!.id).not.toBe(all.json.items[0]!.id);
    expect(((await h.call("/api/v1/plans?q=retire")).json as { total: number }).total).toBe(1);
    expect((await h.call("/api/v1/plans?limit=0")).status).toBe(400);
  });

  it("PUT requires If-Match and is 409 when stale; PATCH applies JSON Patch with id addressing", async () => {
    const plan = await getPlan();
    const {
      id: _a,
      householdId: _b,
      version,
      createdAt: _c,
      updatedAt: _d,
      lineage: _e,
      ...body
    } = plan as never as Record<string, unknown>;
    const noHeader = await h.call(P, { method: "PUT", body });
    expect(noHeader.status).toBe(400);
    const ok = await h.call(P, {
      method: "PUT",
      body: { ...body, name: "Renamed" },
      headers: { "if-match": `"${version}"` },
    });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("etag")).toBe(`"${(version as number) + 1}"`);
    expect(
      (await h.call(P, { method: "PUT", body, headers: { "if-match": `"${version}"` } })).status,
    ).toBe(409);
    const patched = await h.call<Plan>(P, {
      method: "PATCH",
      headers: { "content-type": "application/json-patch+json" },
      body: [{ op: "replace", path: "/income/[id=inc-avery-salary]/amount/value", value: 150000 }],
    });
    expect(patched.status).toBe(200);
    expect(patched.json.income.find((i) => i.id === "inc-avery-salary")!.amount.value).toBe(150000);
    const bad = await h.call(P, {
      method: "PATCH",
      body: [{ op: "replace", path: "/income/[id=ghost]/amount/value", value: 1 }],
    });
    expect(bad.status).toBe(409);
    expect(bad.json).toMatchObject({ error: { code: "PATCH_CONFLICT" } });
    expect((await h.call(P, { method: "PATCH", body: { op: "replace" } })).status).toBe(400);
  });

  it("Idempotency-Key replays the first response and rejects a different request", async () => {
    const headers = { "idempotency-key": "abc-123" };
    const body = { name: "idem copy" };
    const first = await h.call<Plan>(`${P}/duplicate`, { method: "POST", body, headers });
    expect(first.status).toBe(201);
    const second = await h.call<Plan>(`${P}/duplicate`, { method: "POST", body, headers });
    expect(second.status).toBe(201);
    expect(second.headers.get("idempotent-replay")).toBe("true");
    expect(second.json.id).toBe(first.json.id);
    expect(((await h.call("/api/v1/plans")).json as { total: number }).total).toBe(3);
    const different = await h.call(`${P}/duplicate`, {
      method: "POST",
      body: { name: "other" },
      headers,
    });
    expect(different.status).toBe(422);
    expect(different.json).toMatchObject({ error: { code: "IDEMPOTENCY_KEY_REUSED" } });
  });

  it("records history with actor attribution and emits plan.updated", async () => {
    const events: { name: string; data: { planId: string } }[] = [];
    h.services.events.on("event", (e) => events.push(e));
    await h.call(`${P}/expenses/exp-travel`, {
      method: "PATCH",
      body: { amount: { value: 10000, basis: "real" } },
    });
    const versions = await h.call<{
      items: { version: number; actor: { kind: string; label: string }; message: string }[];
    }>(`${P}/versions`);
    expect(versions.json.items[0]).toMatchObject({
      version: 2,
      actor: { kind: "api-key", label: "test-write" },
      message: "updated expense event 'exp-travel'",
    });
    expect(events.some((e) => e.name === "plan.updated" && e.data.planId === "plan-main")).toBe(
      true,
    );
  });
});

describe("plan lifecycle", () => {
  it("duplicates, archives, restores and switches the main plan", async () => {
    const copy = await h.call<Plan>(`${P}/duplicate`, { method: "POST" });
    expect(copy.json).toMatchObject({ name: "Main plan (copy)", isMain: false, version: 1 });
    expect(copy.json.id).not.toBe("plan-main");
    const main = await h.call<Plan>(`/api/v1/plans/${copy.json.id}/set-main`, { method: "POST" });
    expect(main.json.isMain).toBe(true);
    expect((await getPlan("plan-main")).isMain).toBe(false);
    const arch = await h.call<Plan>(`${P}/archive`, { method: "POST" });
    expect(arch.json.status).toBe("archived");
    expect(((await h.call("/api/v1/plans?status=active")).json as { total: number }).total).toBe(2);
    expect((await h.call<Plan>(`${P}/unarchive`, { method: "POST" })).json.status).toBe("active");
    expect((await h.call(`/api/v1/plans/${copy.json.id}`, { method: "DELETE" })).status).toBe(204);
    expect((await h.call(`/api/v1/plans/${copy.json.id}`)).status).toBe(404);
  });
});

describe("nested plan collections and settings", () => {
  it("income: list, add (generated id), get, merge patch, replace, reorder, delete", async () => {
    const list = await h.call<{ items: { id: string }[] }>(`${P}/income`);
    expect(list.json.items).toHaveLength(4);
    const created = await h.call<{ id: string; name: string }>(`${P}/income`, {
      method: "POST",
      body: {
        name: "Side gig",
        type: "self-employment",
        owner: "p-avery",
        amount: { value: 500, basis: "real" },
        frequency: "monthly",
        range: { start: { kind: "planStart" }, end: { kind: "planEnd" } },
      },
    });
    expect(created.status).toBe(201);
    expect(created.json.id).toMatch(/^inc_/);
    const id = created.json.id;
    const merged = await h.call<{ amount: { value: number }; name: string }>(`${P}/income/${id}`, {
      method: "PATCH",
      body: { amount: { value: 800 } },
    });
    expect(merged.json).toMatchObject({ amount: { value: 800, basis: "real" }, name: "Side gig" });
    expect(
      (await h.call(`${P}/income/${id}`, { method: "PUT", body: { ...merged.json, name: "Gig" } }))
        .json,
    ).toMatchObject({ name: "Gig", id });
    expect(
      (await h.call(`${P}/income`, { method: "POST", body: { id, name: "dup" } })).status,
    ).toBe(400); // incomplete body
    const ids = (await h.call<{ items: { id: string }[] }>(`${P}/income`)).json.items.map(
      (i) => i.id,
    );
    const reversed = [...ids].reverse();
    expect(
      (
        await h.call<{ items: { id: string }[] }>(`${P}/reorder/income`, {
          method: "PUT",
          body: { ids: reversed },
        })
      ).json.items.map((i) => i.id),
    ).toEqual(reversed);
    expect(
      (await h.call(`${P}/reorder/income`, { method: "PUT", body: { ids: ["x"] } })).status,
    ).toBe(400);
    expect((await h.call(`${P}/income/${id}`, { method: "DELETE" })).status).toBe(204);
    expect((await h.call(`${P}/income/${id}`)).status).toBe(404);
  });

  it("expenses, milestones and flows are addressable by id with If-Match", async () => {
    const etag = (await h.call(`${P}/expenses`)).headers.get("etag")!;
    const ok = await h.call(`${P}/expenses/exp-living`, {
      method: "PATCH",
      body: { name: "Living costs" },
      headers: { "if-match": etag },
    });
    expect(ok.status).toBe(200);
    expect(
      (
        await h.call(`${P}/expenses/exp-living`, {
          method: "PATCH",
          body: { name: "x" },
          headers: { "if-match": etag },
        })
      ).status,
    ).toBe(409);
    expect((await h.call(`${P}/milestones/ms-fi`)).json).toMatchObject({ id: "ms-fi" });
    expect((await h.call<{ items: unknown[] }>(`${P}/flows`)).json.items.length).toBe(4);
    expect(
      (await h.call(`${P}/flows/fl-roth`, { method: "PATCH", body: { enabled: false } })).json,
    ).toMatchObject({ enabled: false });
    // Merge patch results are validated: an invalid value is a 400 and nothing changes.
    const v = (await getPlan()).version;
    expect(
      (
        await h.call(`${P}/expenses/exp-living`, {
          method: "PATCH",
          body: { frequency: "fortnightly-ish" },
        })
      ).status,
    ).toBe(400);
    expect((await getPlan()).version).toBe(v);
  });

  it("singletons: assumptions, tax, withdrawal strategy, monte carlo", async () => {
    const a = await h.call<{ inflation: unknown }>(`${P}/assumptions`);
    expect(a.status).toBe(200);
    const patched = await h.call<{ inflation: { rate: number } }>(`${P}/assumptions`, {
      method: "PATCH",
      body: { inflation: { kind: "fixed", rate: 0.025 } },
    });
    expect(patched.json.inflation.rate).toBe(0.025);
    expect((await h.call(`${P}/tax-settings`)).status).toBe(200);
    expect(
      (await h.call(`${P}/tax-settings`, { method: "PATCH", body: { mode: "flat" } })).status,
    ).toBe(200);
    expect((await h.call(`${P}/withdrawal-strategy`)).status).toBe(404); // optional, unset
    const ws = await h.call(`${P}/withdrawal-strategy`, {
      method: "PUT",
      body: { kind: "constant-percentage", rate: 0.04 },
    });
    expect([200, 400]).toContain(ws.status); // shape owned by core; exercised for routing only
    const mc = await h.call<{ trials: number }>(`${P}/monte-carlo-settings`);
    expect(mc.status).toBe(200);
    expect(
      (
        await h.call<{ trials: number }>(`${P}/monte-carlo-settings`, {
          method: "PATCH",
          body: { trials: 500 },
        })
      ).json.trials,
    ).toBe(500);
    const reset = await h.call(`${P}/assumptions`, { method: "DELETE" });
    expect(reset.status).toBe(204);
    expect(
      (await h.call<{ inflation: { rate: number } }>(`${P}/assumptions`)).json.inflation.rate,
    ).toBe(0.03);
  });

  it("a read key cannot write plan parts", async () => {
    expect((await h.call(`${P}/income`, { method: "POST", key: READ_KEY, body: {} })).status).toBe(
      403,
    );
    expect(
      (await h.call(`${P}/assumptions`, { method: "PATCH", key: READ_KEY, body: {} })).status,
    ).toBe(403);
  });
});

describe("versions and undo", () => {
  it("lists, gets, diffs and restores", async () => {
    await h.call(`${P}/expenses/exp-travel`, { method: "PATCH", body: { name: "Travel v2" } });
    await h.call(`${P}/expenses/exp-travel`, { method: "PATCH", body: { name: "Travel v3" } });
    const list = await h.call<{ items: { version: number }[]; total: number }>(`${P}/versions`);
    expect(list.json.items.map((v) => v.version)).toEqual([3, 2, 1]);
    const v1 = await h.call<Plan>(`${P}/versions/1`);
    expect(v1.json.expenses.find((e) => e.id === "exp-travel")).toBeDefined();
    const diff = await h.call<{ changes: { description: string }[] }>(`${P}/versions/1/diff`);
    expect(diff.json.changes.length).toBeGreaterThan(0);
    const restored = await h.call<Plan>(`${P}/versions/1/restore`, { method: "POST" });
    expect(restored.status).toBe(200);
    expect(restored.json.version).toBe(4); // history is append-only
    const cur = await getPlan();
    expect(
      (cur.expenses.find((e) => e.id === "exp-travel") as unknown as { name: string }).name,
    ).not.toMatch(/v[23]/);
    const hist = await h.call<{ items: { message: string }[] }>(`${P}/versions`);
    expect(hist.json.items[0]!.message).toBe("restored version 1");
    expect((await h.call(`${P}/versions/99`)).status).toBe(404);
  });
});

describe("branches", () => {
  async function branch(name = "What if") {
    const r = await h.call<Plan>(`${P}/branches`, {
      method: "POST",
      body: {
        name,
        patch: [{ op: "replace", path: "/expenses/[id=exp-travel]/amount/value", value: 20000 }],
      },
    });
    expect(r.status).toBe(201);
    return r.json;
  }

  it("creates a branch with a lineage patch and a materialised body", async () => {
    const b = await branch();
    expect(b.lineage?.parentPlanId).toBe("plan-main");
    expect(b.lineage!.patch.length).toBeGreaterThan(0);
    expect(b.expenses.find((e) => e.id === "exp-travel")!.amount.value).toBe(20000);
    expect(b.isMain).toBe(false);
    const list = await h.call<{ items: Plan[] }>(`${P}/branches`);
    expect(list.json.items.map((x) => x.id)).toEqual([b.id]);
  });

  it("re-materialises children when the parent changes, keeping the branch edit", async () => {
    const b = await branch();
    await h.call(`${P}/expenses/exp-living`, {
      method: "PATCH",
      body: { name: "Parent renamed it" },
    });
    const after = await getPlan(b.id);
    expect(
      (after.expenses.find((e) => e.id === "exp-living") as unknown as { name: string }).name,
    ).toBe("Parent renamed it");
    expect(after.expenses.find((e) => e.id === "exp-travel")!.amount.value).toBe(20000);
    expect(after.version).toBeGreaterThan(b.version);
  });

  it("editing a branch recomputes its patch; diff against parent reports changes and outcomes", async () => {
    const b = await branch();
    await h.call(`/api/v1/plans/${b.id}/expenses/exp-health`, {
      method: "PATCH",
      body: { amount: { value: 8000 } },
    });
    const after = await getPlan(b.id);
    expect(after.lineage!.patch.length).toBeGreaterThanOrEqual(2);
    const diff = await h.call<{
      changes: unknown[];
      outcome: { parent: unknown; branch: unknown };
    }>(`/api/v1/plans/${b.id}/diff`);
    expect(diff.status).toBe(200);
    expect(diff.json.changes.length).toBeGreaterThanOrEqual(2);
    expect(diff.json.outcome.parent).toBeDefined();
  });

  it("merges a branch into its parent (branch deleted) and promotes a branch", async () => {
    const b = await branch();
    const merged = await h.call<{ plan: Plan; branchDeleted: boolean }>(
      `/api/v1/plans/${b.id}/merge`,
      {
        method: "POST",
        body: { strategy: "into-parent" },
      },
    );
    expect(merged.status).toBe(200);
    expect(merged.json.branchDeleted).toBe(true);
    expect((await getPlan()).expenses.find((e) => e.id === "exp-travel")!.amount.value).toBe(20000);
    expect((await getPlan()).name).toBe("Main plan"); // parent keeps its own identity
    expect((await h.call(`/api/v1/plans/${b.id}`)).status).toBe(404);

    const b2 = await branch("Second");
    const promoted = await h.call<{ plan: Plan }>(`/api/v1/plans/${b2.id}/merge`, {
      method: "POST",
      body: { strategy: "promote", makeMain: true },
    });
    expect(promoted.json.plan.lineage).toBeUndefined();
    expect(promoted.json.plan.isMain).toBe(true);
    expect((await getPlan()).isMain).toBe(false);
    expect((await h.call(`${P}/merge`, { method: "POST", body: {} })).status).toBe(400); // not a branch
  });

  it("deleting a parent needs force and promotes its branches", async () => {
    const b = await branch();
    const refused = await h.call(P, { method: "DELETE" });
    expect(refused.status).toBe(409);
    expect(refused.json).toMatchObject({ error: { code: "IN_USE" } });
    expect((await h.call(`${P}?force=true`, { method: "DELETE" })).status).toBe(204);
    expect((await getPlan(b.id)).lineage).toBeUndefined();
  });

  it("branch plans simulate (lineage is dropped for the engine)", async () => {
    const b = await branch();
    const sim = await h.call(`/api/v1/plans/${b.id}/simulate`, {
      method: "POST",
      body: { view: {} },
    });
    expect(sim.status).toBe(200);
  });
});
