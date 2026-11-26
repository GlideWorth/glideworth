/** Roth conversion plan over REST and MCP: a job, read-only, applied only through a change set. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { createMcpServer } from "../src/mcp/server.js";
import { type Harness, setup } from "./helpers.js";

let h: Harness;
afterEach(() => h.close());
const P = "/api/v1/plans/plan-main";

/** The sample plan uses a flat tax; switch it to estimated tax through a change set. */
async function useEstimatedTax() {
  const cs = await h.call<{ id: string }>(`${P}/change-sets`, {
    method: "POST",
    body: {
      ops: [{ op: "replace", path: "/tax/mode", value: "estimate" }],
      summary: "Estimated tax",
      preview: false,
    },
  });
  expect(cs.status).toBe(201);
  expect((await h.call(`/api/v1/change-sets/${cs.json.id}/apply`, { method: "POST" })).status).toBe(
    200,
  );
}

describe("Roth conversion plan", () => {
  it("a flat-tax plan is reported as unsupported, with the reason", async () => {
    h = setup({ realEngine: true });
    const r = await h.call(`${P}/solve/roth-conversions?wait=60`, { method: "POST", body: {} });
    expect(r.status, r.text.slice(0, 300)).toBe(200);
    const plan = (await h.call(`/api/v1/jobs/${r.json.id}/result`)).json;
    expect(plan.status).toBe("unsupported");
    expect(plan.summary).toMatch(/estimate/);
    expect(plan.patch).toEqual([]);
  }, 60_000);

  it("returns a schedule whose patch is proposed as a change set, leaving the plan as it was", async () => {
    h = setup({ realEngine: true });
    await useEstimatedTax();
    const before = (await h.call<{ version: number; flows: unknown[] }>(P)).json;
    const r = await h.call(`${P}/solve/roth-conversions?wait=90`, {
      method: "POST",
      body: { targets: [{ bracketRate: 0.24 }] },
    });
    expect(r.status, r.text.slice(0, 300)).toBe(200);
    const plan = (await h.call(`/api/v1/jobs/${r.json.id}/result`)).json;
    expect(plan.status).toBe("ok");
    expect(plan.schedule.length).toBeGreaterThan(0);
    for (const s of plan.schedule) expect(typeof s.reason).toBe("string");
    expect(plan.outcomes[0].id).toBe("none");
    // Nothing was written by the calculation.
    const same = (await h.call<{ version: number; flows: unknown[] }>(P)).json;
    expect(same.version).toBe(before.version);
    expect(same.flows).toHaveLength(before.flows.length);
    if (plan.patch.length > 0) {
      const cs = await h.call<{ status: string }>(`${P}/change-sets`, {
        method: "POST",
        body: { ops: plan.patch, summary: "Roth conversion schedule", preview: false },
      });
      expect(cs.status, cs.text.slice(0, 300)).toBe(201);
      expect(cs.json.status).toBe("proposed");
    }
  }, 120_000);

  it("MCP: plan_roth_conversions is a calculation tool on a read-only connection, returning the compact plan", async () => {
    h = setup({ realEngine: true });
    const server = createMcpServer({
      services: h.services,
      scopes: ["read", "simulate"],
      canWrite: false,
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const c = new Client({ name: "t", version: "1" });
    await Promise.all([server.connect(a), c.connect(b)]);
    const tool = (await c.listTools()).tools.find((t) => t.name === "plan_roth_conversions");
    // A calculation: it stores a job record (not read-only) but changes no plan data and repeats its result.
    expect(tool?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    });
    const r = (await c.callTool({
      name: "plan_roth_conversions",
      arguments: { wait: 60 },
    })) as { isError?: boolean; content: { text: string }[] };
    expect(r.isError, r.content[0]!.text.slice(0, 300)).toBeFalsy();
    const out = JSON.parse(r.content[0]!.text);
    const result = out.result ?? out;
    expect(result.verdict).toBeDefined();
    expect(Array.isArray(result.assumptions)).toBe(true);
    await c.close();
  }, 90_000);
});
