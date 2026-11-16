/**
 * Agent-facing behaviour of the MCP server: defaults that keep inputs minimal, error hints that say how
 * to recover, compact solver and Monte Carlo outputs (with failure analysis), guards against mixing
 * households, and the six end-to-end tasks an agent is expected to complete using tools alone.
 */
import { createUkSampleDocument } from "@glideworth/core/samples";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { createMcpServer } from "../src/mcp/server.js";
import { compactMonteCarlo, compactSolver } from "../src/views.js";
import { type Harness, setup } from "./helpers.js";

// oxlint-disable-next-line typescript/no-explicit-any -- tool payloads are untyped JSON that tests probe freely
type Json = any;
let h: Harness;
const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close().catch(() => {})));
  h?.close();
});

async function connect(canWrite = true): Promise<Client> {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer({
    services: h.services,
    scopes: canWrite ? ["read", "simulate", "write"] : ["read", "simulate"],
    canWrite,
    actor: { kind: "mcp", label: "agent" },
  });
  await server.connect(b);
  const client = new Client({ name: "agent", version: "0.0.0" });
  await client.connect(a);
  clients.push(client);
  return client;
}
async function call(c: Client, name: string, args: Record<string, unknown> = {}): Promise<Json> {
  const res = (await c.callTool({ name, arguments: args })) as {
    content: { text: string }[];
    isError?: boolean;
  };
  const parsed = JSON.parse(res.content[0]!.text);
  return Object.assign(Array.isArray(parsed) ? [...parsed] : parsed, { isError: !!res.isError });
}

describe("minimal inputs", () => {
  it("defaults planId to the main plan and householdId to the only household", async () => {
    h = setup({ realEngine: true });
    const c = await connect();
    const summary = await call(c, "get_plan_summary");
    expect(summary.plan.id).toBe("plan-main");
    expect(summary.finances.netWorth).toBeTypeOf("number");
    const acc = await call(c, "list_accounts");
    expect(acc.length).toBeGreaterThan(0);
    const upd = await call(c, "update_account_balances", {
      accounts: [{ accountId: acc[0].id, balance: 1234 }],
    });
    expect(upd.updated.accounts).toBe(1);
  });

  it("asks for the id, naming the candidates, when it is ambiguous", async () => {
    h = setup({ realEngine: true });
    h.services.households.importDocument(createUkSampleDocument(), {
      kind: "system",
      label: "test",
    });
    const c = await connect();
    const r = await call(c, "list_accounts");
    expect(r.isError).toBe(true);
    expect(r.error.code).toBe("VALIDATION");
    expect(r.error.message).toMatch(/hh-sample.*hh-uk-sample|hh-uk-sample.*hh-sample/);
    // Plans: two main plans (one per household) -> must be named.
    const p = await call(c, "get_plan_summary");
    expect(p.isError).toBe(true);
    expect(p.error.message).toMatch(/plan-main/);
  });

  it("keeps plans of different households apart in comparisons", async () => {
    h = setup({ realEngine: true });
    h.services.households.importDocument(createUkSampleDocument(), {
      kind: "system",
      label: "test",
    });
    const c = await connect();
    for (const [tool, args] of [
      ["compare_plans", { planIds: ["plan-main", "uk-plan-main"] }],
      ["diff_plans", { basePlanId: "plan-main", otherPlanId: "uk-plan-main" }],
      ["explain_difference", { basePlanId: "plan-main", otherPlanId: "uk-plan-main" }],
    ] as const) {
      const r = await call(c, tool, args);
      expect(r.error?.message, tool).toMatch(/different households/);
    }
  });
});

describe("errors say how to recover", () => {
  it("lists valid ids for a missing plan and explains conflicts", async () => {
    h = setup({ realEngine: true });
    const c = await connect();
    const nf = await call(c, "get_plan", { planId: "plan-nope" });
    expect(nf.error.code).toBe("NOT_FOUND");
    expect(nf.error.hint).toMatch(/list_/);
    expect(nf.error.validIds).toContain("plan-main");
    const stale = await call(c, "propose_change_set", {
      planId: "plan-main",
      summary: "x",
      baseVersion: 99,
      ops: [{ op: "replace", path: "/expenses/[id=exp-living]/amount/value", value: 1 }],
    });
    expect(stale.error.code).toBe("VERSION_CONFLICT");
    expect(stale.error.hint).toMatch(/get_plan_summary/);
    const bad = await call(c, "propose_change_set", {
      planId: "plan-main",
      summary: "x",
      ops: [{ op: "replace", path: "/expenses/[id=nope]/amount/value", value: 1 }],
    });
    expect(bad.error.code).toBe("PATCH_CONFLICT");
    expect(bad.error.hint).toMatch(/\[id=/);
  });

  it("never leaks internals of an unexpected failure", async () => {
    h = setup({ realEngine: true });
    h.services.plans.get = () => {
      throw new Error("ENOENT: no such file /Users/secret/glideworth.db");
    };
    const c = await connect();
    const r = await call(c, "get_plan", { planId: "plan-main" });
    expect(r.error.code).toBe("INTERNAL");
    expect(JSON.stringify(r)).not.toMatch(/secret|ENOENT/);
  });
});

describe("compact outputs", () => {
  it("reduces a solver result to an answer, details and ops, without the search trace", () => {
    const out = compactSolver({
      converged: true,
      value: 1.1,
      achieved: 0.9,
      evaluations: Array.from({ length: 40 }, (_, i) => ({ value: i, metric: 1 })),
      sensitivity: [{ label: "85%", value: 1.2 }],
      explanation: "You can spend about 36,000 a year.",
      status: "solved",
      patch: [{ op: "replace", path: "/expenses/[id=a]/amount/value", value: 1 }],
      details: { annualSpending: 36000 },
      seed: 7,
    } as never) as Json;
    expect(out.answer).toBe("You can spend about 36,000 a year.");
    expect(out.evaluations).toBe(40);
    expect(out.details.annualSpending).toBe(36000);
    expect(out.ops).toHaveLength(1);
    expect(JSON.stringify(out).length).toBeLessThan(700);
  });

  it("adds a headline and failure analysis to a Monte Carlo result that can fail", () => {
    const base = {
      method: "historical-random-restart",
      trials: 100,
      seed: 1,
      successRate: 0.8,
      outcomeCounts: { comfortable: 80, "failed-mid": 20 },
      percentiles: [],
      milestoneTiming: [],
      trialSummaries: [],
      failureYearHistogram: [
        { year: 2041, count: 5 },
        { year: 2044, count: 15 },
      ],
      sequenceRisk: {
        anchor: "retirement",
        years: 10,
        bondShare: 0.3,
        buckets: [
          {
            fromReturn: -0.05,
            toReturn: 0,
            trials: 50,
            successRate: 0.6,
            medianEndNetWorthReal: 1,
          },
        ],
        rankCorrelation: 0.5,
      },
      representativeTrials: { worst: { trial: 3, endNetWorthReal: 0, success: false } },
    };
    const out = compactMonteCarlo(base as never) as Json;
    expect(out.headline).toMatch(
      /80% chance of success: 20 of 100 trials ran short \(earliest in 2041, most often in 2044\)/,
    );
    expect(out.failureAnalysis.firstFailureYears[0]).toEqual([2041, 5]);
    expect(out.failureAnalysis.medianFirstFailureYear).toBe(2044);
    expect(out.failureAnalysis.sequenceRisk.byEarlyReturnQuintile).toHaveLength(1);
    const ok = compactMonteCarlo({
      ...base,
      successRate: 1,
      failureYearHistogram: [],
    } as never) as Json;
    expect(ok.failureAnalysis).toBeUndefined();
    expect(ok.headline).toMatch(/none of the 100 trials/);
  });
});

describe("the six agent tasks, using tools alone", () => {
  it("1. summarises finances and plan in one call", async () => {
    h = setup({ realEngine: true });
    const c = await connect(false);
    const s = await call(c, "get_plan_summary");
    expect(Object.keys(s)).toEqual(expect.arrayContaining(["plan", "finances", "outcome"]));
    expect(JSON.stringify(s).length).toBeLessThan(7000);
    expect(s.outcome.years.length).toBeGreaterThan(3);
  });

  it("2. reports the chance of success and, when it fails, when and why", async () => {
    h = setup({ realEngine: true });
    const c = await connect();
    const br = await call(c, "create_branch", {
      name: "Overspend",
      ops: [{ op: "replace", path: "/expenses/[id=exp-living]/amount/value", value: 14000 }],
    });
    const mc = await call(c, "run_monte_carlo", { planId: br.id, trials: 100 });
    expect(mc.headline).toMatch(/ran short/);
    expect(mc.failureAnalysis.failedTrials).toBeGreaterThan(0);
    expect(mc.failureAnalysis.earliestFailureYear).toBeTypeOf("number");
    const why = await call(c, "explain_year", {
      planId: br.id,
      year: mc.failureAnalysis.earliestFailureYear,
    });
    expect(why.sentences.length).toBeGreaterThan(0);
  });

  it("3. retires three years earlier, shows the difference and saves it as a branch", async () => {
    h = setup({ realEngine: true });
    const c = await connect();
    const prev = await call(c, "preview_whatif", {
      templateId: "early-retirement",
      params: { years: 3 },
    });
    expect(prev.before).toBeDefined();
    const br = await call(c, "create_branch_from_template", {
      templateId: "early-retirement",
      params: { years: 3 },
    });
    expect(br.branchOf).toBe("plan-main");
    const cmp = await call(c, "compare_plans", { planIds: ["plan-main", br.id], explain: true });
    expect(cmp.plans).toHaveLength(2);
    const main = await call(c, "get_plan", { planId: "plan-main" });
    expect(main.version).toBe(1); // the main plan is untouched
  });

  it("4. finds the most it can spend at 90% success, in money", async () => {
    h = setup({ realEngine: true });
    const c = await connect(false);
    const r = await call(c, "solve_max_spending", {
      targetSuccessRate: 0.9,
      trials: 100,
      maxEvaluations: 12,
    });
    expect(r.answer).toMatch(/spend about/);
    expect(r.details.annualSpending).toBeTypeOf("number");
    expect(r.evaluations).toBeTypeOf("number"); // a count, not the trace
    expect(JSON.stringify(r).length).toBeLessThan(2500);
  }, 60_000);

  it("5. updates balances and records a snapshot", async () => {
    h = setup({ realEngine: true });
    const c = await connect();
    const accounts = await call(c, "list_accounts");
    const r = await call(c, "update_account_balances", {
      accounts: accounts
        .slice(0, 2)
        .map((a: Json, i: number) => ({ accountId: a.id, balance: 1000 * (i + 1) })),
      recordSnapshot: true,
    });
    expect(r.snapshotId).toMatch(/^snap_/);
    const snaps = await call(c, "list_progress_snapshots");
    expect(snaps.length).toBeGreaterThan(0);
  });

  it("6. audits the assumptions and fixes the top finding through a change set", async () => {
    h = setup({ realEngine: true, seed: false });
    h.services.households.importDocument(createUkSampleDocument(), {
      kind: "system",
      label: "test",
    });
    const c = await connect();
    const audit = await call(c, "audit_plan");
    const fixable = audit.findings.find((f: Json) => f.fix?.patch?.length);
    expect(fixable, "the sample has at least one fixable finding").toBeDefined();
    expect(fixable.evidence).toBeUndefined(); // compact by default
    const cs = await call(c, "propose_change_set", {
      ops: fixable.fix.patch,
      summary: fixable.title,
      rationale: fixable.message,
    });
    expect(cs.status).toBe("proposed");
    const before = await call(c, "get_plan");
    expect(before.version).toBe(1); // proposing changes nothing
    const applied = await call(c, "apply_change_set", { changeSetId: cs.id });
    expect(applied.newVersion).toBe(2);
  });
});
