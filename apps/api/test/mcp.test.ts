import { NotImplementedError } from "@glideworth/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { createMcpServer } from "../src/mcp/server.js";
import { type Harness, READ_KEY, SIM_KEY, setup, WRITE_KEY } from "./helpers.js";

// oxlint-disable-next-line typescript/no-explicit-any -- tool payloads are untyped JSON that tests probe freely
type Json = any;
let h: Harness;
const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close().catch(() => {})));
  h?.close();
});

async function httpClient(key: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
    fetch: h.fetchViaApp,
    requestInit: { headers: { authorization: `Bearer ${key}` } },
  });
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(transport);
  clients.push(client);
  return client;
}

/** Same server as stdio uses, connected in memory (stdio only differs in the byte pipe). */
async function stdioLikeClient(canWrite: boolean): Promise<Client> {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer({
    services: h.services,
    scopes: canWrite ? ["read", "simulate", "write"] : ["read", "simulate"],
    canWrite,
    actor: { kind: "mcp", label: "mcp-stdio" },
  });
  await server.connect(b);
  const client = new Client({ name: "stdio-test", version: "0.0.0" });
  await client.connect(a);
  clients.push(client);
  return client;
}

type Result = { content: { type: string; text: string }[]; isError?: boolean };
async function call<T = Json>(
  c: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<T & { __raw: Result }> {
  const res = (await c.callTool({ name, arguments: args })) as Result;
  const parsed = JSON.parse(res.content[0]!.text);
  return Object.assign(Array.isArray(parsed) ? ([...parsed] as never) : parsed, { __raw: res });
}
const names = async (c: Client) => (await c.listTools()).tools.map((t) => t.name).sort();

const fakeMc = {
  method: "normal",
  trials: 100,
  seed: 1,
  successRate: 0.9,
  outcomeCounts: { comfortable: 90 },
  percentiles: [
    {
      metric: "netWorth",
      years: [2026, 2031],
      bands: [
        { p: 0.1, values: [1, 2] },
        { p: 0.5, values: [2, 3] },
        { p: 0.9, values: [3, 4] },
        { p: 0.25, values: [1, 1] },
      ],
    },
  ],
  milestoneTiming: [],
  trialSummaries: [{ trial: 0 }],
};
const finding = {
  code: "X",
  severity: "warning",
  title: "t",
  message: "m",
  periodIndex: null,
  refs: [],
  evidence: [],
};

describe("tool registration follows scope and the writes flag", () => {
  it("read key: only read-only tools; no write tools even when the server allows writes is off", async () => {
    h = setup();
    const c = await httpClient(READ_KEY);
    const tools = (await c.listTools()).tools;
    expect(tools.length).toBeGreaterThan(20);
    expect(tools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);
    const n = tools.map((t) => t.name);
    expect(n).toEqual(
      expect.arrayContaining([
        "list_households",
        "get_household",
        "list_accounts",
        "list_plans",
        "get_plan",
        "get_plan_summary",
        "simulate_plan",
        "run_monte_carlo",
        "compare_plans",
        "explain_projection",
        "audit_plan",
        "solve_max_spending",
        "solve_retirement_date",
        "solve_required_savings",
        "preview_changes",
        "get_job",
      ]),
    );
    for (const w of [
      "propose_change_set",
      "apply_change_set",
      "discard_change_set",
      "record_progress_snapshot",
      "update_account_balances",
      "create_branch",
      "cancel_job",
    ])
      expect(n).not.toContain(w);
  });

  it("write key without GLIDEWORTH_MCP_ALLOW_WRITES stays read-only; with it, write tools appear", async () => {
    h = setup({ mcpAllowWrites: false });
    expect(await names(await httpClient(WRITE_KEY))).not.toContain("apply_change_set");
    h.close();
    h = setup({ mcpAllowWrites: true });
    const writer = await names(await httpClient(WRITE_KEY));
    for (const w of [
      "propose_change_set",
      "apply_change_set",
      "discard_change_set",
      "record_progress_snapshot",
      "update_account_balances",
      "create_branch",
    ])
      expect(writer).toContain(w);
    // The same server with a read-scoped key still has no write tools.
    expect(await names(await httpClient(READ_KEY))).not.toContain("apply_change_set");
    // There is no delete/remove tool at all: destructive operations only exist as change sets.
    expect(writer.filter((x) => /delete|remove|drop|wipe/.test(x))).toEqual([]);
  });

  it("simulate-only key gets compute tools but no raw-data tools", async () => {
    h = setup();
    const n = await names(await httpClient(SIM_KEY));
    expect(n).toContain("simulate_plan");
    expect(n).not.toContain("list_households");
    expect(n).not.toContain("get_plan");
  });

  it("the stdio-style server is read-only unless writes are enabled", async () => {
    h = setup();
    expect(await names(await stdioLikeClient(false))).not.toContain("propose_change_set");
    expect(await names(await stdioLikeClient(true))).toContain("propose_change_set");
  });

  it("every tool has a description and an input schema; write tools are not marked read-only", async () => {
    h = setup({ mcpAllowWrites: true });
    const tools = (await (await httpClient(WRITE_KEY)).listTools()).tools;
    for (const t of tools) {
      expect(t.description!.length, t.name).toBeGreaterThan(30);
      expect(t.inputSchema.type).toBe("object");
    }
    const w = tools.find((t) => t.name === "apply_change_set")!;
    expect(w.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
  });
});

describe("read and compute tools", () => {
  it("lists and gets households, accounts and plans compactly", async () => {
    h = setup();
    const c = await httpClient(READ_KEY);
    const hh = await call<{ id: string }[]>(c, "list_households");
    expect(hh[0]!.id).toBe("hh-sample");
    const house = await call<Json>(c, "get_household", { householdId: "hh-sample" });
    expect(house.accounts.length).toBe(5);
    expect(house.totals.accounts).toBeGreaterThan(500000);
    const accts = await call<Json[]>(c, "list_accounts", { householdId: "hh-sample" });
    expect(accts[0]).toHaveProperty("balance");
    const plans = await call<Json[]>(c, "list_plans", {});
    expect(plans.map((p) => p.id).sort()).toEqual(["plan-early", "plan-main"]);
    const compact = await c.callTool({ name: "get_plan", arguments: { planId: "plan-main" } });
    const full = await c.callTool({
      name: "get_plan",
      arguments: { planId: "plan-main", detail: "full" },
    });
    const cl = (compact as Result).content[0]!.text.length;
    const fl = (full as Result).content[0]!.text.length;
    expect(cl).toBeLessThan(fl / 2); // compact is much smaller
    expect((compact as Result).content[0]!.text).not.toContain("\n"); // no pretty-printing
    const parsed = JSON.parse((compact as Result).content[0]!.text);
    expect(parsed.income[0]).toMatchObject({
      id: "inc-avery-salary",
      amount: "132000 real/yearly",
    });
    expect(parsed.expenses.find((e: Json) => e.id === "exp-living").amount).toBe(
      "5200 real/monthly",
    );
  });

  it("get_plan_summary combines plan and outcome; simulate_plan returns a thin yearly table", async () => {
    h = setup();
    const c = await httpClient(READ_KEY);
    const s = await call<Json>(c, "get_plan_summary", { planId: "plan-main" });
    expect(s.plan.id).toBe("plan-main");
    expect(s.outcome).toMatchObject({ basis: "real", currency: "USD" });
    expect(s.outcome.years.length).toBeGreaterThan(1);
    const sim = await call<Json>(c, "simulate_plan", {
      planId: "plan-main",
      fromYear: 2036,
      series: ["netWorth"],
      everyNYears: 2,
    });
    expect(sim.meta.basis).toBe("real");
    expect(Object.keys(sim.years[0]).sort()).toEqual(["ages", "netWorth", "year"]);
  });

  it("runs Monte Carlo (waiting for the job), compare, explain, audit, sensitivity, solvers, tax and what-if previews", async () => {
    h = setup({
      deps: {
        runMonteCarloAsync: (() => fakeMc) as never,
        explainProjection: (() => ({ headline: "because", findings: [finding] })) as never,
        explainDifference: (() => ({ headline: "diff", findings: [] })) as never,
        auditAssumptions: (() => [finding]) as never,
        sensitivityAnalysis: (async () => ({
          metric: "endNetWorthReal",
          base: 1,
          bars: [],
          skipped: [],
        })) as never,
        solveMaxSpending: (async () => ({
          converged: true,
          value: 1.2,
          achieved: 0.85,
          evaluations: [],
          sensitivity: [],
          explanation: "ok",
        })) as never,
        solveEarliestRetirement: (async () => ({
          converged: true,
          value: 12,
          achieved: 0.85,
          evaluations: [],
          sensitivity: [],
          explanation: "ok",
        })) as never,
      },
    });
    const c = await httpClient(READ_KEY);
    const mc = await call<Json>(c, "run_monte_carlo", { planId: "plan-main", trials: 100 });
    expect(mc).toMatchObject({ status: "succeeded", successRate: 0.9 });
    expect(mc.percentiles[0].bands).toHaveLength(3);
    expect(mc.trialSummaries).toBeUndefined();
    const full = await call<Json>(c, "run_monte_carlo", {
      planId: "plan-main",
      trials: 100,
      detail: "full",
    });
    expect(full.trialSummaries).toHaveLength(1);
    const cmp = await call<Json>(c, "compare_plans", {
      planIds: ["plan-main", "plan-early"],
      explain: true,
    });
    expect(cmp.plans).toHaveLength(2);
    expect((await call<Json>(c, "explain_projection", { planId: "plan-main" })).headline).toBe(
      "because",
    );
    expect((await call<Json>(c, "audit_plan", { planId: "plan-main" })).counts.warning).toBe(1);
    expect((await call<Json>(c, "sensitivity", { planId: "plan-main" })).metric).toBe(
      "endNetWorthReal",
    );
    expect(
      await call<Json>(c, "solve_max_spending", { planId: "plan-main", targetSuccessRate: 0.85 }),
    ).toMatchObject({ status: "succeeded", value: 1.2 });
    expect(
      (
        await call<Json>(c, "solve_retirement_date", {
          planId: "plan-main",
          milestoneId: "ms-retire",
        })
      ).value,
    ).toBe(12);
    const tax = await call<Json>(c, "tax_breakdown", { planId: "plan-main" });
    expect(tax.totals.byJurisdiction["us-federal"]).toBeGreaterThan(0);
    const prev = await call<Json>(c, "preview_changes", {
      planId: "plan-main",
      ops: [{ op: "replace", path: "/expenses/[id=exp-travel]/amount/value", value: 30000 }],
    });
    expect(prev.preview.after.endNetWorthReal).toBeLessThan(prev.preview.before.endNetWorthReal);
    expect(prev.changes.length).toBeGreaterThan(0);
  });

  it("long jobs return a job handle; get_job polls (with wait) and reports progress", async () => {
    let finish!: () => void;
    h = setup({
      executor: (_s, hooks) =>
        new Promise((res) => {
          hooks.onProgress(0.4);
          finish = () => res(fakeMc);
        }),
    });
    const c = await httpClient(READ_KEY);
    const pending = await call<Json>(c, "run_monte_carlo", { planId: "plan-main", wait: 0 });
    expect(pending.status).toMatch(/queued|running/);
    expect(pending.hint).toContain("get_job");
    setTimeout(finish, 30);
    const done = await call<Json>(c, "get_job", { jobId: pending.jobId, wait: 5 });
    expect(done).toMatchObject({ status: "succeeded", successRate: 0.9 });
  });

  it("tool failures are structured isError results with the stable code, not protocol errors", async () => {
    h = setup({
      deps: {
        runMonteCarloAsync: (() => {
          throw new NotImplementedError("stochastic.runMonteCarlo", "c");
        }) as never,
      },
    });
    const c = await httpClient(READ_KEY);
    const missing = await call<Json>(c, "get_plan", { planId: "nope" });
    expect(missing.__raw.isError).toBe(true);
    expect(missing.error).toMatchObject({ code: "NOT_FOUND" });
    const ni = await call<Json>(c, "run_monte_carlo", { planId: "plan-main" });
    expect(ni).toMatchObject({
      status: "failed",
      error: { code: "NOT_IMPLEMENTED", details: { workstream: "c" } },
    });
    const bad = await call<Json>(c, "preview_changes", {
      planId: "plan-main",
      ops: [{ op: "explode" }],
    });
    expect(bad.__raw.isError).toBe(true);
    expect(bad.error.code).toBe("VALIDATION");
  });
});

describe("write tools: change-set workflow", () => {
  const ops = [{ op: "replace", path: "/expenses/[id=exp-travel]/amount/value", value: 15000 }];

  it("propose -> apply attributes the version to the MCP key; discard; revert is a proposal", async () => {
    h = setup({ mcpAllowWrites: true });
    const c = await httpClient(WRITE_KEY);
    const p = await call<Json>(c, "propose_change_set", {
      planId: "plan-main",
      ops,
      summary: "More travel",
      rationale: "because",
    });
    expect(p).toMatchObject({ status: "proposed", baseVersion: 1, summary: "More travel" });
    expect(p.before.endNetWorthReal).toBeGreaterThan(p.after.endNetWorthReal);
    expect(p.next).toContain("apply_change_set");
    expect(h.services.plans.get("plan-main").version).toBe(1); // nothing applied yet
    const applied = await call<Json>(c, "apply_change_set", { changeSetId: p.id });
    expect(applied).toMatchObject({ status: "applied", newVersion: 2 });
    const versions = h.services.plans.listVersions("plan-main");
    expect(versions[0]).toMatchObject({ version: 2, changeSetId: p.id });
    expect(versions[0]!.actor).toMatchObject({
      kind: "mcp",
      id: "key_testwrit",
      label: "test-write",
    });

    const p2 = await call<Json>(c, "propose_change_set", {
      planId: "plan-main",
      ops: [{ op: "replace", path: "/expenses/[id=exp-travel]/amount/value", value: 1 }],
      summary: "x",
    });
    expect(await call<Json>(c, "discard_change_set", { changeSetId: p2.id })).toMatchObject({
      status: "discarded",
    });
    expect((await call<Json>(c, "apply_change_set", { changeSetId: p2.id })).error.code).toBe(
      "CHANGESET_NOT_PROPOSED",
    );

    const hist = await call<Json[]>(c, "list_plan_versions", { planId: "plan-main" });
    expect(hist.map((v) => v.version)).toEqual([2, 1]);
    const rev = await call<Json>(c, "propose_revert", { planId: "plan-main", version: 1 });
    expect(rev).toMatchObject({ status: "proposed", summary: "Revert to version 1" });
    expect(h.services.plans.get("plan-main").version).toBe(2); // still just a proposal
    await call<Json>(c, "apply_change_set", { changeSetId: rev.id });
    expect(
      h.services.plans.get("plan-main").expenses.find((e) => e.id === "exp-travel")!.amount.value,
    ).toBe(9000);
    expect((await call<Json[]>(c, "list_change_sets", { planId: "plan-main" })).length).toBe(3);
    expect((await call<Json>(c, "get_change_set", { changeSetId: p.id })).ops).toHaveLength(1);
  });

  it("a stale change set is a CHANGESET_CONFLICT tool error", async () => {
    h = setup({ mcpAllowWrites: true });
    const c = await httpClient(WRITE_KEY);
    const p = await call<Json>(c, "propose_change_set", { planId: "plan-main", ops, summary: "s" });
    await h.call("/api/v1/plans/plan-main/expenses/exp-living", {
      method: "PATCH",
      body: { name: "user edit" },
    });
    const r = await call<Json>(c, "apply_change_set", { changeSetId: p.id });
    expect(r.__raw.isError).toBe(true);
    expect(r.error.code).toBe("CHANGESET_CONFLICT");
  });

  it("update_account_balances, record_progress_snapshot and create_branch", async () => {
    h = setup({ mcpAllowWrites: true });
    const c = await httpClient(WRITE_KEY);
    const u = await call<Json>(c, "update_account_balances", {
      householdId: "hh-sample",
      accounts: [
        { accountId: "acc-cash", balance: 40000 },
        { accountId: "acc-hsa", balance: 15000 },
      ],
    });
    expect(u).toMatchObject({ updated: { accounts: 2 } });
    expect(u.snapshotId).toBeTruthy();
    expect(h.services.households.getFinance("hh-sample", "accounts", "acc-cash")).toMatchObject({
      balance: 40000,
    });
    const bad = await call<Json>(c, "update_account_balances", {
      householdId: "hh-sample",
      accounts: [{ accountId: "ghost", balance: 1 }],
    });
    expect(bad.__raw.isError).toBe(true);
    const snap = await call<Json>(c, "record_progress_snapshot", {
      householdId: "hh-sample",
      note: "mcp",
    });
    expect(snap.netWorth).toBeGreaterThan(0);
    expect(
      (await call<Json[]>(c, "list_progress_snapshots", { householdId: "hh-sample" })).length,
    ).toBeGreaterThan(1);
    const b = await call<Json>(c, "create_branch", {
      planId: "plan-main",
      name: "Spend more",
      ops,
    });
    expect(b).toMatchObject({ branchOf: "plan-main", name: "Spend more" });
    expect(
      h.services.plans.get("plan-main").expenses.find((e) => e.id === "exp-travel")!.amount.value,
    ).toBe(9000); // parent untouched
    expect(
      h.services.plans.get(b.id).expenses.find((e) => e.id === "exp-travel")!.amount.value,
    ).toBe(15000);
    const created = await call<Json>(c, "cancel_job", { jobId: "nope" });
    expect(created.__raw.isError).toBe(true);
  });
});

describe("resources and prompts", () => {
  it("serves schema, glossary, units, workflow and plan documents", async () => {
    h = setup();
    const c = await httpClient(READ_KEY);
    const res = await c.listResources();
    const uris = res.resources.map((r) => r.uri);
    expect(uris).toEqual(
      expect.arrayContaining([
        "glideworth://schema/document",
        "glideworth://schema/plan",
        "glideworth://docs/glossary",
        "glideworth://docs/units",
        "glideworth://docs/change-sets",
        "glideworth://plans/plan-main",
        "glideworth://plans/plan-main/summary",
      ]),
    );
    const schema = await c.readResource({ uri: "glideworth://schema/document" });
    const js = JSON.parse((schema.contents[0] as { text: string }).text);
    expect(js.$defs.GlideworthDocument.properties).toHaveProperty("plans");
    const glossary = await c.readResource({ uri: "glideworth://docs/glossary" });
    expect((glossary.contents[0] as { text: string }).text).toContain("Change set");
    const plan = await c.readResource({ uri: "glideworth://plans/plan-main" });
    expect(JSON.parse((plan.contents[0] as { text: string }).text).id).toBe("plan-main");
    const sum = await c.readResource({ uri: "glideworth://plans/plan-early/summary" });
    expect(JSON.parse((sum.contents[0] as { text: string }).text).id).toBe("plan-early");
    const templates = await c.listResourceTemplates();
    expect(templates.resourceTemplates.map((t) => t.uriTemplate)).toContain(
      "glideworth://plans/{planId}",
    );
  });

  it("still resolves pre-rename cairn:// resource URIs (not listed), with the same access rules", async () => {
    h = setup();
    const c = await httpClient(READ_KEY);
    const uris = (await c.listResources()).resources.map((r) => r.uri);
    expect(uris.some((u) => u.startsWith("cairn://"))).toBe(false);
    const read = async (uri: string) => {
      const r = await c.readResource({ uri });
      expect(r.contents[0]!.uri).toBe(uri);
      return (r.contents[0] as { text: string }).text;
    };
    expect(await read("cairn://docs/glossary")).toBe(await read("glideworth://docs/glossary"));
    expect(await read("cairn://schema/plan")).toBe(await read("glideworth://schema/plan"));
    expect(JSON.parse(await read("cairn://plans/plan-main")).id).toBe("plan-main");
    expect(JSON.parse(await read("cairn://plans/plan-early/summary")).id).toBe("plan-early");
    expect(JSON.parse(await read("cairn://households/hh-sample/document")).app).toBe("glideworth");
    await expect(c.readResource({ uri: "cairn://nope/x" })).rejects.toThrow();
    // A key without read scope gets the documentation, not the data, under either scheme.
    const simOnly = await httpClient(SIM_KEY);
    expect((await simOnly.readResource({ uri: "cairn://docs/units" })).contents).toHaveLength(1);
    await expect(simOnly.readResource({ uri: "cairn://plans/plan-main" })).rejects.toThrow();
  });

  it("offers prompts that point the agent at the right tools", async () => {
    h = setup();
    const c = await httpClient(READ_KEY);
    const prompts = (await c.listPrompts()).prompts.map((p) => p.name);
    expect(prompts).toEqual(
      expect.arrayContaining([
        "review_my_plan",
        "can_i_retire_earlier",
        "what_if_spending",
        "monthly_checkin",
      ]),
    );
    const review = await c.getPrompt({ name: "review_my_plan", arguments: {} });
    const text = (review.messages[0]!.content as { text: string }).text;
    expect(text).toContain("plan-main"); // defaults to the main plan
    expect(text).toContain("get_plan_summary");
    const retire = await c.getPrompt({
      name: "can_i_retire_earlier",
      arguments: { planId: "plan-early", targetSuccessRate: "0.9" },
    });
    const rt = (retire.messages[0]!.content as { text: string }).text;
    expect(rt).toContain("solve_retirement_date");
    expect(rt).toContain("0.9");
  });

  it("server instructions state the units and the safety workflow", async () => {
    h = setup();
    const c = await httpClient(READ_KEY);
    const instr = c.getInstructions()!;
    expect(instr).toContain("MAJOR currency units");
    expect(instr).toContain("propose_change_set");
  });
});

describe("MCP endpoint auth", () => {
  it("requires a valid key", async () => {
    h = setup();
    const r = await h.call("/mcp", {
      method: "POST",
      key: null,
      body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    });
    expect(r.status).toBe(401);
  });
});
