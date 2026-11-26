/* oxlint-disable typescript/no-explicit-any -- tests probe arbitrary JSON responses */
/**
 * "Why did my results change?" (GET /plans/{id}/result-change, MCP explain_result_change) on the real engine:
 * the split is computed from the inputs stored with each check-in, and nothing is stored by asking.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { jobs, planHealth, simulationRuns } from "../src/db/schema.js";
import { createMcpServer } from "../src/mcp/server.js";
import { type Harness, READ_KEY, setup, SIM_KEY } from "./helpers.js";

let h: Harness;
afterEach(() => {
  h?.services.checkins.stop();
  h?.close();
});

const P = "/api/v1/plans/plan-main";

function make() {
  h = setup({ realEngine: true });
  h.services.checkins.setConfig({ monteCarloTrials: 100 });
  return h;
}
const checkin = async () => {
  const r = await h.call(`${P}/checkins`, { method: "POST" });
  expect(r.status, r.text).toBe(200);
  return r.json.health as { id: string };
};
const editLiving = (value: number) =>
  h.call(P, {
    method: "PATCH",
    body: [{ op: "replace", path: "/expenses/[id=exp-living]/amount/value", value }],
    headers: { "content-type": "application/json-patch+json" },
  });
const setCash = (balance: number) =>
  h.call("/api/v1/households/hh-sample/balances", {
    method: "POST",
    body: { accounts: [{ accountId: "acc-cash", balance }], snapshot: false },
  });
const change = async (q = "") => {
  const r = await h.call(`${P}/result-change${q}`);
  expect(r.status, r.text).toBe(200);
  return r.json;
};
const metric = (r: any, m: string) => r.metrics.find((x: any) => x.metric === m);
const partOf = (r: any, m: string, cause: string) =>
  metric(r, m).parts.find((p: any) => p.cause === cause).delta as number;
const addsUp = (r: any) => {
  for (const m of r.metrics) {
    if (m.total === null) continue;
    const sum = m.parts.reduce((s: number, p: any) => s + (p.delta ?? 0), 0) + m.unexplained;
    expect(sum, m.metric).toBeCloseTo(m.total, 6);
  }
};
const counts = () => ({
  health: h.ctx.db
    .select({ n: sql<number>`count(*)` })
    .from(planHealth)
    .get()!.n,
  jobs: h.ctx.db
    .select({ n: sql<number>`count(*)` })
    .from(jobs)
    .get()!.n,
});
const tamper = (id: string, f: (body: any) => void) => {
  const row = h.ctx.db.select().from(planHealth).where(eq(planHealth.id, id)).get()!;
  const body = structuredClone(row.body) as any;
  f(body);
  h.ctx.db.update(planHealth).set({ body }).where(eq(planHealth.id, id)).run();
};

describe("why did my results change?", { timeout: 60_000 }, () => {
  it("says nothing changed right after a check-in, and the recompute matches what was stored", async () => {
    make();
    await checkin();
    const r = await change();
    expect(r.available).toBe(true);
    expect(r.noChange).toBe(true);
    expect(r.summary[0]).toMatch(/^Nothing changed/);
    expect(r.order).toEqual(["glideworth", "time", "balances", "household", "plan"]);
    for (const m of r.metrics) {
      expect(m.total, m.metric).toBeCloseTo(0, 9);
      expect(m.unexplained, m.metric).toBeCloseTo(0, 9);
    }
    expect(r.to.checkInId).toBeNull();
  });

  it("splits a plan edit and updated balances, names the edit, and the parts add up", async () => {
    make();
    const first = await checkin();
    expect((await editLiving(70_000)).status).toBe(200);
    expect((await setCash(128_500)).status).toBe(200);
    const before = counts();
    const r = await change();
    expect(counts()).toEqual(before); // read-only: no check-in, no job row
    expect(r.available).toBe(true);
    expect(r.noChange).toBe(false);
    expect(r.from.checkInId).toBe(first.id);
    addsUp(r);
    expect(r.metrics.map((m: any) => m.metric)).toEqual([
      "successRate",
      "fiYear",
      "endNetWorthReal",
    ]);
    // Steps that did not change move nothing.
    expect(partOf(r, "endNetWorthReal", "glideworth")).toBe(0);
    expect(partOf(r, "endNetWorthReal", "time")).toBeCloseTo(0, 6);
    expect(partOf(r, "endNetWorthReal", "household")).toBeCloseTo(0, 6);
    // £100,000 more cash raises, and more spending lowers, the end-of-plan net worth.
    expect(partOf(r, "endNetWorthReal", "balances")).toBeGreaterThan(0);
    expect(partOf(r, "endNetWorthReal", "plan")).toBeLessThan(0);
    const steps = Object.fromEntries(r.steps.map((s: any) => [s.cause, s]));
    expect(steps.balances.details).toEqual(["1 account value updated"]);
    expect(steps.plan.details.join(" ")).toMatch(/living/i);
    const plan = metric(r, "endNetWorthReal").parts.find((p: any) => p.cause === "plan");
    expect(plan.edits.map((e: any) => e.key)).toEqual(["/expenses/[id=exp-living]"]);
    expect(r.notes.join(" ")).toMatch(/not financial advice/);
  });

  it("puts an engine version change on Glideworth's side", async () => {
    make();
    const c = await checkin();
    tamper(c.id, (b) => {
      b.snapshot.fingerprints.engineVersion = "0.0.1";
      b.snapshot.values.endNetWorthReal += 1_000;
    });
    const r = await change();
    expect(r.noChange).toBe(false);
    expect(partOf(r, "endNetWorthReal", "glideworth")).toBeCloseTo(-1_000, 6);
    expect(metric(r, "endNetWorthReal").unexplained).toBeCloseTo(0, 6);
    expect(r.steps.find((s: any) => s.cause === "glideworth").details[0]).toMatch(
      /^Engine version 0\.0\.1 → /,
    );
    addsUp(r);
  });

  it("an old check-in without stored inputs gives the total movement and says the split is unavailable", async () => {
    make();
    const c = await checkin();
    tamper(c.id, (b) => delete b.snapshot);
    await setCash(128_500);
    const r = await change();
    expect(r.available).toBe(false);
    expect(r.reason).toMatch(/not available for check-ins taken before/);
    expect(metric(r, "endNetWorthReal").total).toBeGreaterThan(0);
    expect(metric(r, "successRate").before).not.toBeNull();
    expect(r.metrics[0].parts).toBeUndefined();
    expect(r.notes.join(" ")).toMatch(/estimates/);
  });

  it("compares two check-ins; unknown or foreign check-in ids are 404", async () => {
    make();
    const a = await checkin();
    await setCash(78_500);
    const b = await checkin();
    const r = await change(`?from=${a.id}&to=${b.id}`);
    expect(r.available).toBe(true);
    expect(r.to.checkInId).toBe(b.id);
    expect(partOf(r, "endNetWorthReal", "balances")).toBeGreaterThan(0);
    addsUp(r);
    expect((await h.call(`${P}/result-change?from=chk_nope`)).status).toBe(404);
    // A check-in of another plan is not found through this plan.
    const other = h.services.plans.list({}).find((p) => p.id !== "plan-main")!;
    expect((await h.call(`/api/v1/plans/${other.id}/result-change?from=${a.id}`)).status).toBe(404);
  });

  it("with no check-in yet, says there is nothing to compare with", async () => {
    make();
    const r = await change();
    expect(r.available).toBe(false);
    expect(r.from).toBeNull();
    expect(r.reason).toMatch(/no check-in yet/);
  });

  it("is a compute operation (simulate scope): read and simulate keys may call it", async () => {
    make();
    await checkin();
    expect((await h.call(`${P}/result-change`, { key: READ_KEY })).status).toBe(200);
    expect((await h.call(`${P}/result-change`, { key: SIM_KEY })).status).toBe(200);
  });

  it("MCP explain_result_change is read-only and stores nothing", async () => {
    make();
    await checkin();
    await editLiving(70_000);
    const server = createMcpServer({
      services: h.services,
      scopes: ["read", "simulate"],
      canWrite: false,
    });
    const [x, y] = InMemoryTransport.createLinkedPair();
    const c = new Client({ name: "t", version: "1" });
    await Promise.all([server.connect(x), c.connect(y)]);
    const tool = (await c.listTools()).tools.find((t) => t.name === "explain_result_change")!;
    expect(tool.annotations?.readOnlyHint).toBe(true);
    const before = counts();
    const runs = h.ctx.db
      .select({ n: sql<number>`count(*)` })
      .from(simulationRuns)
      .get()!.n;
    const res: any = await c.callTool({
      name: "explain_result_change",
      arguments: { planId: "plan-main" },
    });
    expect(res.isError).toBeFalsy();
    const out = JSON.parse(res.content[0].text);
    expect(out.available).toBe(true);
    expect(out.steps.find((s: any) => s.cause === "plan").changed).toBe(true);
    expect(counts()).toEqual(before);
    expect(
      h.ctx.db
        .select({ n: sql<number>`count(*)` })
        .from(simulationRuns)
        .get()!.n,
    ).toBe(runs);
    await c.close();
  });
});
