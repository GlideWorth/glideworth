/**
 * MCP: the flow summary in get_plan, plan lifecycle tools, household edits (preview then apply) and the plan
 * optimiser. Synthetic sample household only.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { createMcpServer } from "../src/mcp/server.js";
import { type Harness, setup } from "./helpers.js";

// oxlint-disable-next-line typescript/no-explicit-any -- tool payloads are untyped JSON that tests probe freely
type Json = any;
let h: Harness;
const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close().catch(() => {})));
  h?.close();
});

async function client(canWrite = true): Promise<Client> {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer({
    services: h.services,
    scopes: canWrite ? ["read", "simulate", "write"] : ["read", "simulate"],
    canWrite,
    actor: { kind: "mcp", label: "mcp-test" },
  });
  await server.connect(b);
  const c = new Client({ name: "t", version: "0" });
  await c.connect(a);
  clients.push(c);
  return c;
}

type Result = { content: { text: string }[]; isError?: boolean };
async function call(c: Client, name: string, args: Record<string, unknown> = {}): Promise<Json> {
  const res = (await c.callTool({ name, arguments: args })) as Result;
  const text = res.content[0]!.text;
  // Arguments the input schema refuses come back as plain text from the SDK, not as our JSON error.
  if (res.isError && !text.startsWith("{")) return { isError: true, text };
  const body = JSON.parse(text);
  return res.isError ? { isError: true, ...body } : body;
}
const actor = { kind: "system" as const, label: "test" };

describe("get_plan summary: flows", () => {
  it("shows each flow's amount, resolved dates, target by name, priority and whether it is mandatory", async () => {
    h = setup();
    // The case that was invisible before: £40,000/yr for one month, from a date with an offset.
    h.services.plans.patch(
      "plan-main",
      [
        {
          op: "add",
          path: "/flows/-",
          value: {
            kind: "debtPaydown",
            id: "fl-overpay",
            name: "Overpay the mortgage",
            owner: "joint",
            targetId: "ra-home",
            range: {
              start: { kind: "date", date: "2027-12" },
              end: { kind: "date", date: "2027-12", offsetMonths: 1 },
            },
            method: {
              kind: "amount",
              amount: { value: 40_000, basis: "real" },
              frequency: "yearly",
            },
          },
        },
      ],
      undefined,
      actor,
    );
    const c = await client(false);
    const plan = await call(c, "get_plan", { planId: "plan-main" });
    const flows = Object.fromEntries(plan.flows.map((f: Json) => [f.id, f]));
    expect(flows["fl-overpay"]).toEqual({
      id: "fl-overpay",
      name: "Overpay the mortgage",
      kind: "debtPaydown",
      priority: 5,
      amount: "40000 real/yearly",
      target: "Home",
      targetId: "ra-home",
      from: "2027-12",
      to: "2028-01",
      months: 1,
      mandatory: false,
    });
    expect(flows["fl-401k"]).toMatchObject({
      priority: 1,
      amount: "23000 real/yearly",
      target: "Avery 401(k)",
      targetId: "acc-avery-401k",
      from: "plan start",
      to: "milestone ms-retire",
      mandatory: true,
    });
    expect(flows["fl-401k"].months).toBeUndefined();
    expect(flows["fl-emergency"]).toMatchObject({
      amount: "max (up to the limit)",
      fillTo: "36000 real",
      target: "High-yield savings",
    });
    expect(flows["fl-taxable"]).toMatchObject({ amount: "100% of remaining surplus" });
    expect(plan.leftover).toBe("save to High-yield savings");
    // Ages resolve to their month too (Avery, born 1984-03, is 57 in 2041-03).
    h.services.plans.patch(
      "plan-main",
      [
        {
          op: "replace",
          path: "/flows/[id=fl-roth]/range/end",
          value: { kind: "age", personId: "p-avery", age: 57 },
        },
        { op: "replace", path: "/flows/[id=fl-roth]/enabled", value: false },
      ],
      undefined,
      actor,
    );
    const again = await call(c, "get_plan", { planId: "plan-main" });
    expect(again.flows.find((f: Json) => f.id === "fl-roth")).toMatchObject({
      to: "p-avery age 57 (2041-03)",
      disabled: true,
    });
  });
});

describe("plan lifecycle tools", () => {
  it("duplicate, rename, set main and archive, with version checks", async () => {
    h = setup();
    const c = await client();
    const copy = await call(c, "duplicate_plan", { planId: "plan-main", name: "Copy to edit" });
    expect(copy).toMatchObject({
      name: "Copy to edit",
      version: 1,
      isMain: false,
      status: "active",
      copiedFrom: "plan-main",
    });
    expect(h.services.plans.get(copy.id).lineage).toBeUndefined();

    const renamed = await call(c, "rename_plan", {
      planId: copy.id,
      name: "Sabbatical",
      description: "A year off in 2030",
      expectedVersion: 1,
    });
    expect(renamed).toMatchObject({
      id: copy.id,
      name: "Sabbatical",
      version: 2,
      previousName: "Copy to edit",
    });
    expect(h.services.plans.get(copy.id).description).toBe("A year off in 2030");
    const stale = await call(c, "rename_plan", {
      planId: copy.id,
      name: "Again",
      expectedVersion: 1,
    });
    expect(stale.isError).toBe(true);
    expect(stale.error.code).toBe("VERSION_CONFLICT");
    expect(h.services.plans.get(copy.id).name).toBe("Sabbatical");

    const main = await call(c, "set_main_plan", { planId: copy.id });
    expect(main).toMatchObject({ id: copy.id, isMain: true, previousMain: "plan-main" });
    expect(h.services.plans.get("plan-main").isMain).toBe(false);

    const archived = await call(c, "set_plan_archived", { planId: copy.id, archived: true });
    expect(archived).toMatchObject({ status: "archived", isMain: false });
    expect(archived.note).toMatch(/no plan is main now/);
    const back = await call(c, "set_plan_archived", { planId: copy.id, archived: false });
    expect(back).toMatchObject({ status: "active" });

    // Each write is in the audit log under its tool name.
    const actions = h.services.audit.list().map((a) => a.action);
    for (const t of [
      "mcp:duplicate_plan",
      "mcp:rename_plan",
      "mcp:set_main_plan",
      "mcp:set_plan_archived",
    ])
      expect(actions).toContain(t);
  });
});

describe("household changes: preview, then apply", () => {
  const isa = {
    action: "add",
    kind: "account",
    item: {
      id: "acc-isa",
      name: "New brokerage",
      type: "taxable",
      owner: "p-avery",
      balance: 20_000,
    },
  };

  it("preview stores nothing and reports the main plan before and after", async () => {
    h = setup();
    const c = await client();
    const before = h.services.households.get("hh-sample");
    const audit = h.services.audit.list().length;
    const p = await call(c, "preview_household_change", {
      operations: [
        isa,
        { action: "update", kind: "debt", id: "debt-car", changes: { interest: { apr: 0.045 } } },
      ],
    });
    expect(p.householdVersion).toBe(before.version);
    expect(p.changes[0]).toMatch(
      /^Add account "New brokerage" \(acc-isa\), taxable, balance \$20,000/,
    );
    expect(p.changes[1]).toBe('Update debt "Car loan" (debt-car): interest.apr: 0.064 -> 0.045');
    expect(p.mainPlan.planId).toBe("plan-main");
    expect(p.mainPlan.after.endNetWorthReal).toBeGreaterThan(p.mainPlan.before.endNetWorthReal);
    const after = h.services.households.get("hh-sample");
    expect(after).toEqual(before);
    expect(h.services.audit.list().length).toBe(audit);
  });

  it("apply adds, updates and removes in one write, with the version from the preview", async () => {
    h = setup();
    const c = await client();
    const v = h.services.households.get("hh-sample").version;
    const ops = [
      isa,
      {
        action: "update",
        kind: "realAsset",
        id: "ra-home",
        changes: { loan: { interest: { apr: 0.049 } } },
      },
      { action: "updateHousehold", changes: { name: "Avery & Jordan" } },
    ];
    const done = await call(c, "apply_household_change", { operations: ops, householdVersion: v });
    expect(done).toMatchObject({ applied: true, householdVersion: v + 1 });
    expect(done.changes).toHaveLength(3);
    const rec = h.services.households.get("hh-sample");
    expect(rec.finances.accounts.find((a) => a.id === "acc-isa")?.balance).toBe(20_000);
    expect(rec.finances.realAssets[0]!.loan?.interest.apr).toBe(0.049);
    expect(rec.finances.realAssets[0]!.loan?.balance).toBe(342_000);
    expect(rec.household.name).toBe("Avery & Jordan");
    expect(h.services.audit.list()[0]!.action).toBe("mcp:apply_household_change");

    // Remove the account just added: no plan uses it.
    const removed = await call(c, "apply_household_change", {
      operations: [{ action: "remove", kind: "account", id: "acc-isa" }],
      householdVersion: v + 1,
    });
    expect(removed.changes[0]).toMatch(/^Remove account "New brokerage"/);
    expect(
      h.services.households.get("hh-sample").finances.accounts.some((a) => a.id === "acc-isa"),
    ).toBe(false);
  });

  it("refuses a stale version and changes nothing", async () => {
    h = setup();
    const c = await client();
    const v = h.services.households.get("hh-sample").version;
    const out = await call(c, "apply_household_change", {
      operations: [isa],
      householdVersion: v - 1,
    });
    expect(out.isError).toBe(true);
    expect(out.error.code).toBe("VERSION_CONFLICT");
    expect(out.error.hint).toMatch(/preview_household_change/);
    expect(h.services.households.get("hh-sample").version).toBe(v);
  });

  it("names the operation and field in validation errors, and the plans that use an item it would remove", async () => {
    h = setup();
    const c = await client();
    const v = h.services.households.get("hh-sample").version;
    const bad = await call(c, "preview_household_change", {
      operations: [
        isa,
        {
          action: "add",
          kind: "debt",
          item: { name: "Loan", type: "personal-loan", owner: "joint", balance: "lots" },
        },
      ],
    });
    expect(bad.isError).toBe(true);
    expect(bad.error.code).toBe("VALIDATION");
    expect(bad.error.message).toMatch(/^operations\[1\] \(add debt\): validation failed: balance/);

    const unknown = await call(c, "preview_household_change", {
      operations: [{ action: "update", kind: "account", id: "acc-nope", changes: { balance: 1 } }],
    });
    expect(unknown.error.code).toBe("NOT_FOUND");
    expect(unknown.error.details.validIds).toContain("acc-cash");

    const used = await call(c, "apply_household_change", {
      operations: [{ action: "remove", kind: "account", id: "acc-brokerage" }],
      householdVersion: v,
    });
    expect(used.error.code).toBe("IN_USE");
    expect(used.error.message).toMatch(
      /Main plan \(plan-main\): flows\/fl-taxable \(Invest the rest\)/,
    );
    expect(used.error.message).toMatch(/archive the account instead/);

    const person = await call(c, "preview_household_change", {
      operations: [{ action: "remove", kind: "person", id: "p-jordan" }],
    });
    expect(person.error.code).toBe("IN_USE");
    expect(person.error.message).toMatch(/owns: Jordan Roth IRA \(acc-jordan-roth\)/);

    const third = await call(c, "preview_household_change", {
      operations: [
        {
          action: "add",
          kind: "person",
          item: { name: "Sam", role: "partner", birthMonth: "1990-01" },
        },
      ],
    });
    expect(third.error.code).toBe("VALIDATION");
    expect(third.error.message).toMatch(/^household: validation failed: people/);

    const currency = await call(c, "preview_household_change", {
      operations: [{ action: "updateHousehold", changes: { currency: "EUR" } }],
    });
    expect(currency.isError).toBe(true);
    expect(currency.text).toMatch(/currency/);
    const empty = await call(c, "preview_household_change", {
      operations: [{ action: "updateHousehold", changes: {} }],
    });
    expect(empty.error.message).toMatch(/nothing to change/);
    expect(h.services.households.get("hh-sample").version).toBe(v);
  });

  it("is not registered without writes", async () => {
    h = setup();
    const c = await client(false);
    const names = (await c.listTools()).tools.map((t) => t.name);
    for (const n of [
      "preview_household_change",
      "apply_household_change",
      "duplicate_plan",
      "rename_plan",
      "set_main_plan",
      "set_plan_archived",
    ])
      expect(names).not.toContain(n);
    expect(names).toContain("optimise_plan");
  });
});

describe("optimise_plan", () => {
  it("runs as a job and returns the best ops, the baseline and alternatives; get_job finishes it", async () => {
    h = setup({ realEngine: true });
    h.services.plans.patch(
      "plan-main",
      [
        {
          op: "add",
          path: "/flows/0",
          value: {
            kind: "debtPaydown",
            id: "fl-overpay",
            name: "Overpay the mortgage",
            owner: "joint",
            targetId: "ra-home",
            range: {
              start: { kind: "planStart" },
              end: { kind: "milestone", milestoneId: "ms-retire" },
            },
            method: {
              kind: "amount",
              amount: { value: 12_000, basis: "real" },
              frequency: "yearly",
            },
          },
        },
      ],
      undefined,
      actor,
    );
    const c = await client(false);
    const args = {
      planId: "plan-main",
      goal: "earliest-retirement",
      levers: [{ kind: "redirect", flowId: "fl-overpay", accountId: "acc-brokerage" }],
    };
    const out = await call(c, "optimise_plan", { ...args, wait: 60 });
    expect(out.status).toBe("succeeded");
    expect(out.goal).toBe("earliest-retirement");
    expect(out.milestoneId).toBe("ms-retire");
    expect(out.best.month).toMatch(/^\d{4}-\d{2}$/);
    expect(out.best.noShortfall).toBe(true);
    expect(out.alternatives.columns).toEqual([
      "changes",
      "month",
      "endNetWorthReal",
      "noShortfall",
    ]);
    expect(out.alternatives.rows).toHaveLength(1);
    expect(out.search).toMatchObject({ method: "exhaustive", candidates: 2, spaceSize: 2 });
    expect(out.milestoneOps.length).toBeGreaterThan(0);
    // The ops preview cleanly.
    if (out.best.ops.length) {
      const preview = await call(c, "preview_changes", { planId: "plan-main", ops: out.best.ops });
      expect(preview.isError).toBeUndefined();
    }
    // Not waiting: a jobId to finish with get_job (the same request is now served from the cache).
    const again = await call(c, "optimise_plan", { ...args, wait: 0 });
    const job = await call(c, "get_job", { jobId: again.jobId, wait: 60 });
    expect(job.status).toBe("succeeded");
    expect(job.best).toEqual(out.best);
  }, 60_000);

  it("rejects a lever it cannot apply before starting a job", async () => {
    h = setup({ realEngine: true });
    const c = await client(false);
    const out = await call(c, "optimise_plan", {
      planId: "plan-main",
      goal: "max-end-net-worth",
      levers: [{ kind: "scale", flowId: "fl-emergency" }],
    });
    expect(out.isError).toBe(true);
    expect(out.error.code).toBe("SCENARIO");
    expect(out.error.message).toMatch(/fl-emergency.*no fixed amount or share to scale/);
  });
});

describe("REST twins", () => {
  it("POST /households/{id}/changes previews with dryRun and applies with If-Match", async () => {
    h = setup();
    const path = "/api/v1/households/hh-sample/changes";
    const v = h.services.households.get("hh-sample").version;
    const operations = [
      { action: "update", kind: "account", id: "acc-cash", changes: { name: "Emergency fund" } },
    ];
    const dry = await h.call(path, { method: "POST", body: { operations, dryRun: true } });
    expect(dry.status).toBe(200);
    expect(dry.json).toMatchObject({ applied: false, version: v });
    expect(dry.json.changes[0]).toBe(
      'Update account "Emergency fund" (acc-cash): name: High-yield savings -> Emergency fund',
    );
    expect(h.services.households.get("hh-sample").version).toBe(v);
    const stale = await h.call(path, {
      method: "POST",
      body: { operations },
      headers: { "if-match": `"${v - 1}"` },
    });
    expect(stale.status).toBe(409);
    const ok = await h.call(path, {
      method: "POST",
      body: { operations },
      headers: { "if-match": `"${v}"` },
    });
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ applied: true, version: v + 1 });
    expect(h.services.households.get("hh-sample").finances.accounts[0]!.name).toBe(
      "Emergency fund",
    );
  });

  it("POST /plans/{id}/solve/optimise runs the optimiser as a job", async () => {
    h = setup({ realEngine: true });
    const r = await h.call("/api/v1/plans/plan-main/solve/optimise?wait=60", {
      method: "POST",
      body: { goal: "max-end-net-worth", levers: [{ kind: "toggle", flowId: "fl-roth" }] },
    });
    expect(r.status).toBe(200);
    expect(r.json.status).toBe("succeeded");
    const result = await h.call(`/api/v1/jobs/${r.json.id}/result`);
    expect(result.json.goal).toBe("max-end-net-worth");
    expect(result.json.spaceSize).toBe(2);
  });
});
