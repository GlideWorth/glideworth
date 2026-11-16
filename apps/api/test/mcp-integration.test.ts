/** The integration-gap tools over MCP, on the real engine and importers, with compact outputs. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Harness, READ_KEY, SIM_KEY, setup, WRITE_KEY } from "./helpers.js";

let h: Harness;
const clients: Client[] = [];
beforeAll(() => {
  h = setup({ realEngine: true, mcpAllowWrites: true });
});
afterAll(async () => {
  await Promise.all(clients.map((c) => c.close().catch(() => {})));
  h.close();
});

async function connect(key: string) {
  const transport = new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
    fetch: h.fetchViaApp,
    requestInit: { headers: { authorization: `Bearer ${key}` } },
  });
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(transport);
  clients.push(client);
  return client;
}
// oxlint-disable-next-line typescript/no-explicit-any -- tool payloads are untyped JSON that tests probe freely
type Out = Record<string, any> & { __error?: boolean; __text: string };
async function call(c: Client, name: string, args: Record<string, unknown> = {}): Promise<Out> {
  const res = (await c.callTool({ name, arguments: args })) as {
    content: { text: string }[];
    isError?: boolean;
  };
  const text = res.content[0]!.text;
  const parsed = JSON.parse(text);
  return Object.assign(Array.isArray(parsed) ? { items: parsed } : parsed, {
    __error: res.isError,
    __text: text,
  });
}

describe("tool registration follows scopes", () => {
  it("exposes the new compute/data tools to read and simulate keys, and the new write tools only with writes enabled", async () => {
    const compute = [
      "explain_year",
      "explain_years",
      "explain_difference",
      "guyton_klinger",
      "optimise_tax_strategy",
      "list_whatif_templates",
      "preview_whatif",
      "survivor_scenarios",
      "solve_required_portfolio",
      "solve_safe_withdrawal_rate",
    ];
    const read = (await (await connect(READ_KEY)).listTools()).tools.map((t) => t.name);
    for (const t of [...compute, "export_table", "export_report", "preview_csv_import"])
      expect(read).toContain(t);
    for (const t of ["create_branch_from_template", "apply_csv_import"])
      expect(read).not.toContain(t);
    const sim = (await (await connect(SIM_KEY)).listTools()).tools.map((t) => t.name);
    for (const t of compute) expect(sim).toContain(t);
    expect(sim).not.toContain("export_table"); // raw data export needs read
    const write = (await (await connect(WRITE_KEY)).listTools()).tools.map((t) => t.name);
    for (const t of ["create_branch_from_template", "apply_csv_import"]) expect(write).toContain(t);
    expect(write.some((t) => t.startsWith("delete"))).toBe(false); // still no delete tools
  });
});

describe("insight tools", () => {
  it("explains a year and a range of years compactly (no ledger evidence)", async () => {
    const c = await connect(READ_KEY);
    const y = await call(c, "explain_year", { planId: "plan-main", year: 2040 });
    expect(y).toMatchObject({ year: 2040, basis: "real" });
    expect(y.sentences.length).toBeGreaterThan(1);
    expect(y.evidence).toBeUndefined();
    expect(y.__text.length).toBeLessThan(6000);
    const ys = await call(c, "explain_years", {
      planId: "plan-main",
      fromYear: 2030,
      toYear: 2060,
      everyNYears: 10,
    });
    expect(ys.years.map((x: { year: number }) => x.year)).toEqual([2030, 2040, 2050, 2060]);
    expect(
      (await call(c, "explain_year", { planId: "plan-main", year: 1800 })).error,
    ).toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("explains the difference between plans with attribution, and Guyton-Klinger guardrails", async () => {
    const c = await connect(READ_KEY);
    const d = await call(c, "explain_difference", {
      basePlanId: "plan-main",
      otherPlanId: "plan-early",
    });
    expect(d.changeCount).toBeGreaterThan(0);
    expect(d.attribution.contributions[0]).toMatchObject({
      key: expect.any(String),
      delta: expect.any(Number),
    });
    expect(d.attribution.contributions[0].changes).toBeUndefined(); // summary form
    const gk = await call(c, "guyton_klinger", {
      planId: "plan-main",
      portfolio: 1_000_000,
      spending: 40_000,
    });
    expect(gk.action).toBe("hold");
    const g = await call(c, "evaluate_guardrails", { planId: "plan-main", trials: 100 });
    expect(g.error?.code ?? g.status).toMatch(/VALIDATION|succeeded/); // sample plan has no riskGuardrails: a clear 400-style error
  });
});

describe("solver tools", () => {
  it("solve_required_portfolio and solve_safe_withdrawal_rate return solver results", async () => {
    const c = await connect(READ_KEY);
    const p = await call(c, "solve_required_portfolio", {
      planId: "plan-main",
      targetSuccessRate: 0.8,
      trials: 100,
      maxEvaluations: 5,
      wait: 100,
    });
    expect(p.status).toBe("succeeded");
    expect(p.value).toEqual(expect.any(Number));
    const w = await call(c, "solve_safe_withdrawal_rate", {
      planId: "plan-main",
      targetSuccessRate: 0.8,
      years: 30,
      trials: 100,
      maxEvaluations: 5,
      wait: 100,
    });
    expect(w.status).toBe("succeeded");
  }, 120_000);

  it("optimise_tax_strategy ranks candidates (summary keeps only the best patch)", async () => {
    h.services.households.importDocument(
      (await import("@glideworth/core/samples")).createUkSampleDocument(),
      {
        kind: "system",
      },
    );
    const c = await connect(READ_KEY);
    const t = await call(c, "optimise_tax_strategy", {
      planId: "uk-plan-main",
      objective: "lifetimeTaxesReal",
      wait: 100,
    });
    expect(t.status).toBe("succeeded");
    expect(t.ranked.length).toBeGreaterThan(1);
    expect(t.ranked[0].patch).toBeUndefined();
    expect(t.best.patch.length).toBeGreaterThan(0);
    const again = await call(c, "get_job", { jobId: t.jobId });
    expect(again.ranked.length).toBe(t.ranked.length);
  }, 120_000);
});

describe("what-if tools", () => {
  it("lists templates, previews one, and (with write) branches it; survivor scenarios for a couple", async () => {
    const c = await connect(WRITE_KEY);
    const list = await call(c, "list_whatif_templates");
    expect(list.items.map((t: { id: string }) => t.id)).toContain("market-crash");
    const prev = await call(c, "preview_whatif", {
      planId: "plan-main",
      templateId: "market-crash",
      params: { year: 2035, drop: 0.4 },
    });
    expect(prev.template.id).toContain("market-crash");
    expect(prev.before).toBeTruthy();
    const bad = await call(c, "preview_whatif", {
      planId: "plan-main",
      templateId: "market-crash",
      params: {},
    });
    expect(bad.error.code).toBe("VALIDATION");

    const b = await call(c, "create_branch_from_template", {
      planId: "plan-main",
      templateId: "market-crash",
      params: { year: 2035, drop: 0.4 },
      name: "Crash 2035",
    });
    expect(b).toMatchObject({ name: "Crash 2035", branchOf: "plan-main" });
    expect(h.services.plans.get("plan-main").version).toBe(1);

    const s = await call(c, "survivor_scenarios", {
      planId: "plan-main",
      ages: [75],
      evaluate: true,
    });
    expect(s.scenarios).toHaveLength(2);
    expect(s.scenarios[0].after).toBeTruthy();
  });
});

describe("data tools", () => {
  it("exports a thinned projection table, CSV text and report data", async () => {
    const c = await connect(READ_KEY);
    const t = await call(c, "export_table", {
      planId: "plan-main",
      table: "taxes",
      everyNYears: 10,
    });
    expect(t.columns).toEqual(expect.arrayContaining(["Year"]));
    expect(t.rows.length).toBeLessThan(10);
    const csv = await call(c, "export_table", {
      planId: "plan-main",
      format: "csv",
      everyNYears: 20,
    });
    expect(csv.csv.split("\n")[0]).toContain("Year");
    const r = await call(c, "export_report", { planId: "plan-main" });
    expect(r.caveats.length).toBeGreaterThan(0);
    expect(r.series[0].points.length).toBeLessThan(15);
  });

  it("previews a CSV import (dry run) and applies it only through the write tool", async () => {
    const text = "Account,Balance,Date\nHigh-yield savings,40000,2026-11-15\n";
    const c = await connect(WRITE_KEY);
    const p = await call(c, "preview_csv_import", {
      householdId: "hh-sample",
      kind: "account-balances",
      text,
    });
    expect(p).toMatchObject({ dryRun: true, applied: false });
    expect(p.reconciliation.matched[0]).toMatchObject({
      id: "acc-cash",
      before: 28_500,
      after: 40_000,
    });
    expect(h.services.households.getFinance("hh-sample", "accounts", "acc-cash")).toMatchObject({
      balance: 28_500,
    });
    const a = await call(c, "apply_csv_import", {
      householdId: "hh-sample",
      kind: "account-balances",
      text,
    });
    expect(a).toMatchObject({ applied: true, changes: { finances: true } });
    expect(h.services.households.getFinance("hh-sample", "accounts", "acc-cash")).toMatchObject({
      balance: 40_000,
    });
  });
});
