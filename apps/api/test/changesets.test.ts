import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Harness, READ_KEY, SIM_KEY, setup } from "./helpers.js";

let h: Harness;
beforeEach(() => {
  h = setup();
});
afterEach(() => h.close());
const P = "/api/v1/plans/plan-main";
const ops = [{ op: "replace", path: "/expenses/[id=exp-travel]/amount/value", value: 20000 }];
type CS = {
  id: string;
  status: string;
  baseVersion: number;
  changes: { description: string }[];
  preview?: { before: { endNetWorthReal: number }; after: { endNetWorthReal: number } };
};
const propose = (body: object = {}) =>
  h.call<CS>(`${P}/change-sets`, {
    method: "POST",
    body: { ops, summary: "More travel", rationale: "agent idea", ...body },
  });
const planOf = async () =>
  (await h.call<{ version: number; expenses: { id: string; amount: { value: number } }[] }>(P))
    .json;

describe("change sets", () => {
  it("propose stores a diff + before/after preview WITHOUT touching the plan", async () => {
    const before = await planOf();
    const r = await propose();
    expect(r.status).toBe(201);
    expect(r.json.status).toBe("proposed");
    expect(r.json.baseVersion).toBe(before.version);
    expect(r.json.changes.length).toBeGreaterThan(0);
    expect(r.json.changes[0]!.description).toMatch(/travel|20,?000/i);
    expect(r.json.preview!.after.endNetWorthReal).toBeLessThan(
      r.json.preview!.before.endNetWorthReal,
    );
    const after = await planOf();
    expect(after.version).toBe(before.version);
    expect(after.expenses.find((e) => e.id === "exp-travel")!.amount.value).toBe(9000);
    expect(
      (await h.call<{ items: CS[] }>(`${P}/change-sets?status=proposed`)).json.items,
    ).toHaveLength(1);
    expect((await h.call<CS>(`/api/v1/change-sets/${r.json.id}`)).json.id).toBe(r.json.id);
  });

  it("apply writes a plan version attributed to the caller and links the change set", async () => {
    const cs = (await propose()).json;
    const applied = await h.call<{
      changeSet: CS;
      plan: { version: number; expenses: { id: string; amount: { value: number } }[] };
    }>(`/api/v1/change-sets/${cs.id}/apply`, { method: "POST" });
    expect(applied.status).toBe(200);
    expect(applied.json.changeSet.status).toBe("applied");
    expect(applied.json.plan.expenses.find((e) => e.id === "exp-travel")!.amount.value).toBe(20000);
    const versions = await h.call<{
      items: { version: number; changeSetId: string; actor: { id: string }; message: string }[];
    }>(`${P}/versions`);
    expect(versions.json.items[0]).toMatchObject({
      version: 2,
      changeSetId: cs.id,
      message: "More travel",
    });
    expect(versions.json.items[0]!.actor.id).toMatch(/^key_/);
    expect(
      (await h.call(`/api/v1/change-sets/${cs.id}/apply`, { method: "POST" })).json,
    ).toMatchObject({
      error: { code: "CHANGESET_NOT_PROPOSED" },
    });
    expect((await h.call(`/api/v1/change-sets/${cs.id}/discard`, { method: "POST" })).status).toBe(
      409,
    );
  });

  it("apply is a 409 conflict when the plan moved after the proposal (and the set is marked conflict)", async () => {
    const cs = (await propose()).json;
    await h.call(`${P}/expenses/exp-living`, { method: "PATCH", body: { name: "user edit" } });
    const r = await h.call(`/api/v1/change-sets/${cs.id}/apply`, { method: "POST" });
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({
      error: { code: "CHANGESET_CONFLICT", details: { baseVersion: 1, currentVersion: 2 } },
    });
    expect((await h.call<CS>(`/api/v1/change-sets/${cs.id}`)).json.status).toBe("conflict");
    expect((await planOf()).expenses.find((e) => e.id === "exp-travel")!.amount.value).toBe(9000);
  });

  it("proposing against a stale baseVersion or an invalid path fails at propose time", async () => {
    await h.call(`${P}/expenses/exp-living`, { method: "PATCH", body: { name: "bump" } });
    const stale = await propose({ baseVersion: 1 });
    expect(stale.status).toBe(409);
    expect(stale.json).toMatchObject({ error: { code: "VERSION_CONFLICT" } });
    const bad = await propose({
      ops: [{ op: "replace", path: "/expenses/[id=ghost]/amount/value", value: 1 }],
    });
    expect(bad.status).toBe(409);
    expect(bad.json).toMatchObject({ error: { code: "PATCH_CONFLICT" } });
    expect((await h.call<{ items: unknown[] }>(`${P}/change-sets`)).json.items).toHaveLength(0);
    expect((await propose({ ops: [] })).status).toBe(400);
  });

  it("discard, and skipping the preview", async () => {
    const cs = (await propose({ preview: false })).json;
    expect(cs.preview).toBeUndefined();
    const d = await h.call<CS>(`/api/v1/change-sets/${cs.id}/discard`, { method: "POST" });
    expect(d.json.status).toBe("discarded");
    expect((await h.call(`/api/v1/change-sets/${cs.id}/apply`, { method: "POST" })).status).toBe(
      409,
    );
    expect((await h.call("/api/v1/change-sets/nope")).status).toBe(404);
  });

  it("what-if preview stores nothing and needs only simulate scope; propose/apply need write", async () => {
    const r = await h.call<{ changes: unknown[]; preview: { before: unknown; after: unknown } }>(
      `${P}/preview`,
      { method: "POST", key: SIM_KEY, body: { ops } },
    );
    expect(r.status).toBe(200);
    expect(r.json.preview.after).toBeDefined();
    expect((await h.call<{ items: unknown[] }>(`${P}/change-sets`)).json.items).toHaveLength(0);
    expect(
      (
        await h.call(`${P}/change-sets`, {
          method: "POST",
          key: READ_KEY,
          body: { ops, summary: "x" },
        })
      ).status,
    ).toBe(403);
    const cs = (await propose()).json;
    expect(
      (await h.call(`/api/v1/change-sets/${cs.id}/apply`, { method: "POST", key: READ_KEY }))
        .status,
    ).toBe(403);
    expect((await h.call(`/api/v1/change-sets/${cs.id}`, { key: READ_KEY })).status).toBe(200);
  });

  it("sets blended drawdown entries (fill to a tax ceiling, accounts drawn together) through a change set", async () => {
    const blended = [
      {
        op: "add",
        path: "/drawdown/order/0",
        value: {
          kind: "fillToCeiling",
          ceiling: { kind: "bracket", rate: 0.12 },
          accountIds: ["acc-avery-401k"],
        },
      },
      {
        op: "add",
        path: "/drawdown/order/1",
        value: { kind: "proportional", accountIds: ["acc-brokerage", "acc-jordan-roth"] },
      },
    ];
    const r = await propose({ ops: blended, summary: "Fill the 12% bracket first" });
    expect(r.status).toBe(201);
    expect(r.json.preview!.after).toBeDefined();
    const applied = await h.call<{
      plan: { drawdown: { order: { kind: string }[] } };
    }>(`/api/v1/change-sets/${r.json.id}/apply`, { method: "POST" });
    expect(applied.status).toBe(200);
    expect(applied.json.plan.drawdown.order.slice(0, 2).map((e) => e.kind)).toEqual([
      "fillToCeiling",
      "proportional",
    ]);
    // A proportional entry needs at least two accounts: the schema rejects one.
    const bad = await propose({
      ops: [
        {
          op: "add",
          path: "/drawdown/order/0",
          value: { kind: "proportional", accountIds: ["acc-brokerage"] },
        },
      ],
    });
    expect(bad.status).toBeGreaterThanOrEqual(400);
    expect(bad.status).toBeLessThan(500);
  });
});
