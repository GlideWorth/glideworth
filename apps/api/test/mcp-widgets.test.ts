/**
 * Chat widgets (MCP Apps): the widget resource, the template metadata on the widget tools, and the payloads in
 * `_meta["glideworth/widget"]`, on the real engine with the synthetic sample household. The text the model reads
 * must not change, and the payload's numbers must equal the text's.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { compactYearNarrative } from "../src/views.js";
import { createMcpServer } from "../src/mcp/server.js";
import {
  WIDGET_CALLABLE_TOOLS,
  WIDGET_META_KEY,
  WIDGET_TOOLS,
  WidgetPayload,
} from "../src/mcp/widget-contract.js";
import { WIDGET_HASH } from "../src/mcp/widget-html.generated.js";
import { WIDGET_URI, widgetBuilders } from "../src/mcp/widgets.js";
import { type Harness, setup } from "./helpers.js";

// oxlint-disable-next-line typescript/no-explicit-any -- tool payloads are untyped JSON that tests probe freely
type Json = any;
type Result = {
  content: { type: string; text: string }[];
  isError?: boolean;
  _meta?: Record<string, unknown>;
};

const WEB = "https://glideworth.example.test";
let h: Harness;
let c: Client;
const clients: Client[] = [];

async function connect(o: { canWrite: boolean; webUrl?: string | null }): Promise<Client> {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer({
    services: h.services,
    scopes: o.canWrite ? ["read", "simulate", "write"] : ["read", "simulate"],
    canWrite: o.canWrite,
    actor: { kind: "mcp", label: "mcp-test" },
    webUrl: o.webUrl,
  });
  await server.connect(b);
  const client = new Client({ name: "widgets-test", version: "0.0.0" });
  await client.connect(a);
  clients.push(client);
  return client;
}

/** Calls a tool: the parsed text, the raw result and the (validated) widget payload, if any. */
async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const raw = (await client.callTool({ name, arguments: args })) as Result;
  expect(raw.isError ?? false).toBe(false);
  expect(raw.content).toHaveLength(1);
  const text = raw.content[0]!.text;
  expect(text).not.toContain(WIDGET_META_KEY);
  const payload = raw._meta?.[WIDGET_META_KEY];
  const widget = payload === undefined ? undefined : (WidgetPayload.parse(payload) as Json);
  return { out: JSON.parse(text) as Json, text, raw, widget };
}

beforeAll(async () => {
  h = setup({ realEngine: true });
  c = await connect({ canWrite: true, webUrl: WEB });
});
afterAll(async () => {
  await Promise.all(clients.map((x) => x.close().catch(() => {})));
  h.close();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("widget resource", () => {
  it("lists and reads the hash-versioned MCP App template with an empty CSP", async () => {
    expect(WIDGET_URI).toBe(`ui://glideworth/app-${WIDGET_HASH}.html`);
    const listed = (await c.listResources()).resources.find((r) => r.uri === WIDGET_URI);
    expect(listed).toMatchObject({ mimeType: "text/html;profile=mcp-app" });
    const meta = {
      ui: { csp: { connectDomains: [], resourceDomains: [] }, prefersBorder: true },
      "openai/widgetCSP": { connect_domains: [], resource_domains: [] },
      "openai/widgetPrefersBorder": true,
      "openai/widgetDescription": expect.any(String),
      "openai/widgetDomain": WEB,
    };
    expect(listed!._meta).toEqual(meta);
    const read = await c.readResource({ uri: WIDGET_URI });
    expect(read.contents).toHaveLength(1);
    expect(read.contents[0]).toMatchObject({
      uri: WIDGET_URI,
      mimeType: "text/html;profile=mcp-app",
      _meta: meta,
    });
    expect((read.contents[0] as { text: string }).text).toMatch(/<html/i);
  });

  it("names no widget domain when the public URL is unknown", async () => {
    const anon = await connect({ canWrite: false });
    const listed = (await anon.listResources()).resources.find((r) => r.uri === WIDGET_URI);
    expect(listed!._meta).not.toHaveProperty("openai/widgetDomain");
    expect((listed!._meta as Json).ui.csp).toEqual({ connectDomains: [], resourceDomains: [] });
  });
});

describe("tool metadata", () => {
  it("puts the template on exactly the widget tools and widgetAccessible on the callable ones", async () => {
    const tools = (await c.listTools()).tools;
    const widgetTools = new Set(Object.keys(WIDGET_TOOLS));
    const callable = new Set<string>(WIDGET_CALLABLE_TOOLS);
    for (const name of [...widgetTools, ...callable])
      expect(tools.map((t) => t.name)).toContain(name);
    for (const t of tools) {
      const meta = t._meta as Json;
      if (widgetTools.has(t.name)) {
        expect(meta).toMatchObject({
          ui: { resourceUri: WIDGET_URI },
          "ui/resourceUri": WIDGET_URI,
          "openai/outputTemplate": WIDGET_URI,
          "openai/toolInvocation/invoking": expect.any(String),
          "openai/toolInvocation/invoked": expect.any(String),
        });
        expect(meta["openai/toolInvocation/invoking"].length).toBeLessThanOrEqual(64);
      } else {
        expect(meta?.ui).toBeUndefined();
        expect(meta?.["openai/outputTemplate"]).toBeUndefined();
      }
      if (callable.has(t.name)) expect(meta["openai/widgetAccessible"]).toBe(true);
      else expect(meta?.["openai/widgetAccessible"]).toBeUndefined();
      if (!widgetTools.has(t.name) && !callable.has(t.name)) expect(t._meta).toBeUndefined();
    }
  });
});

// Solvers and Monte Carlo run on the real engine: slow when the whole suite runs in parallel.
describe("payloads", { timeout: 60_000 }, () => {
  it("simulate_plan: a deterministic outcome with the text's end net worth and yearly net worth", async () => {
    const { out, widget } = await call(c, "simulate_plan", { planId: "plan-main" });
    expect(widget).toMatchObject({ view: "outcome", kind: "deterministic", p10: null, p90: null });
    expect(widget.outcome.successRate).toBeNull();
    expect(widget.outcome.endNetWorth).toBe(out.summary.endNetWorthReal);
    expect(widget.outcome.success).toBe(out.summary.success);
    expect(widget.years).toEqual(out.years.map((y: Json) => y.year));
    expect(widget.median).toEqual(out.years.map((y: Json) => y.netWorth));
    expect(widget.markers.map((m: Json) => m.label)).toContain("Retirement");
    expect(widget.plan).toMatchObject({
      planId: "plan-main",
      planName: "Main plan",
      currency: "USD",
      canWrite: true,
      appUrl: `${WEB}/results`,
    });
  });

  it("run_monte_carlo: the outcome fan with the text's headline and success rate", async () => {
    const { out, widget } = await call(c, "run_monte_carlo", {
      planId: "plan-main",
      trials: 200,
      wait: 60,
    });
    expect(out.status).toBe("succeeded");
    expect(widget).toMatchObject({ view: "outcome", kind: "monte-carlo", trials: 200 });
    expect(widget.headline).toBe(out.headline);
    expect(widget.outcome.successRate).toBe(out.successRate);
    expect(widget.median).toHaveLength(widget.years.length);
    expect(widget.p10).toHaveLength(widget.years.length);
    expect(widget.p90).toHaveLength(widget.years.length);
    // The text's thinned fan is a subset of the widget's yearly fan.
    const fan = out.percentiles.find((p: Json) => p.metric === "netWorth");
    const median = fan.bands.find((b: Json) => b.p === 0.5).values;
    fan.years.forEach((y: number, i: number) =>
      expect(widget.median[widget.years.indexOf(y)]).toBe(median[i]),
    );
    expect(widget.plan.appUrl).toBe(`${WEB}/chance`);
    // The text is unchanged: the compact keys, no widget data.
    expect(Object.keys(out)).toEqual(
      expect.arrayContaining(["headline", "successRate", "percentiles"]),
    );
    expect(out).not.toHaveProperty("years");
    expect(out).not.toHaveProperty("median");
  });

  it("run_monte_carlo not finished: pending, then get_job finishes the outcome", async () => {
    const { out, widget } = await call(c, "run_monte_carlo", {
      planId: "plan-main",
      trials: 200,
      seed: 4242,
      wait: 0,
    });
    expect(out.status).toMatch(/queued|running/);
    expect(widget).toMatchObject({ view: "pending", jobId: out.jobId, of: "outcome" });
    const polled = await call(c, "get_job", { jobId: out.jobId, wait: 60 });
    expect(polled.out.status).toBe("succeeded");
    expect(polled.widget).toMatchObject({ view: "outcome", kind: "monte-carlo" });
    expect(polled.widget.outcome.successRate).toBe(polled.out.successRate);
    expect(polled.widget.headline).toBe(polled.out.headline);
  });

  it("solver not finished: pending, then get_job finishes the answer", async () => {
    const solving = await call(c, "solve_safe_withdrawal_rate", {
      planId: "plan-main",
      targetSuccessRate: 0.77,
      trials: 100,
      maxEvaluations: 6,
      wait: 0,
    });
    expect(solving.out.status).toMatch(/queued|running/);
    expect(solving.widget).toMatchObject({
      view: "pending",
      jobId: solving.out.jobId,
      of: "answer",
    });
    const polled = await call(c, "get_job", { jobId: solving.out.jobId, wait: 60 });
    expect(polled.out.status).toBe("succeeded");
    expect(polled.widget).toMatchObject({
      view: "answer",
      solver: "safe-withdrawal-rate",
      answer: polled.out.answer,
      targetSuccessRate: 0.77,
    });
    expect(polled.widget.figure).toMatchObject({
      value: polled.out.details.rate,
      format: "percent",
    });
  });

  it("get_job: no payload for a job without a view", async () => {
    const backtest = await call(c, "run_historical_backtest", { planId: "plan-main", wait: 0 });
    expect(backtest.widget).toBeUndefined();
    const polled = await call(c, "get_job", { jobId: backtest.out.jobId, wait: 60 });
    expect(polled.out.status).toBe("succeeded");
    expect(polled.widget).toBeUndefined();
  });

  it("preview_changes: compare with deterministic series for both sides and the text's outcomes", async () => {
    const ops = [{ op: "replace", path: "/expenses/[id=exp-travel]/amount/value", value: 20_000 }];
    const { out, text, widget } = await call(c, "preview_changes", { planId: "plan-main", ops });
    // The same text as the preview itself produces.
    const direct = h.services.sim.preview("plan-main", ops as never);
    expect(text).toBe(
      JSON.stringify({
        planVersion: direct.plan.version,
        changes: direct.diff.changes.slice(0, 40).map((x) => x.description),
        preview: direct.preview,
      }),
    );
    expect(widget.view).toBe("compare");
    expect(widget.before.endNetWorth).toBe(out.preview.before.endNetWorthReal);
    expect(widget.after.endNetWorth).toBe(out.preview.after.endNetWorthReal);
    expect(widget.after.lifetimeTaxes).toBe(out.preview.after.lifetimeTaxesReal);
    expect(widget.beforeSeries).toHaveLength(widget.years.length);
    expect(widget.afterSeries).toHaveLength(widget.years.length);
    expect(widget.beforeSeries).not.toEqual(widget.afterSeries);
    expect(widget.changes.map((x: Json) => x.label)).toEqual(out.changes);
    expect(widget.ops).toEqual(ops);
    expect(widget.template).toBeNull();
  });

  it("preview_whatif: compare with tweakable numeric params inside their ranges", async () => {
    const crash = await call(c, "preview_whatif", {
      planId: "plan-main",
      templateId: "market-crash",
      params: { year: 2030 },
    });
    expect(crash.text).toBe(
      JSON.stringify(h.services.scenarios.preview("plan-main", "market-crash", { year: 2030 })),
    );
    const w = crash.widget;
    expect(w.view).toBe("compare");
    expect(w.ops).toEqual(crash.out.ops);
    expect(w.after.endNetWorth).toBe(crash.out.after.endNetWorthReal);
    expect(w.afterSeries).toHaveLength(w.years.length);
    expect(w.template).toMatchObject({ id: "market-crash", params: { year: 2030 } });
    const byName = Object.fromEntries(w.template.tweakable.map((p: Json) => [p.name, p]));
    expect(byName.year).toMatchObject({ value: 2030, step: 1, format: "year", min: w.years[0] });
    expect(byName.drop).toMatchObject({
      value: 0.3,
      min: 0.1,
      max: 0.6,
      step: 0.05,
      format: "percent",
    });

    const early = await call(c, "preview_whatif", {
      planId: "plan-main",
      templateId: "early-retirement",
      params: { years: 3, milestoneId: "ms-retire" },
    });
    const tw = early.widget.template;
    expect(tw.params).toEqual({ years: 3, milestoneId: "ms-retire" });
    expect(tw.tweakable).toEqual([
      {
        name: "years",
        label: "Years earlier",
        value: 3,
        min: 1,
        max: 15,
        step: 1,
        format: "number",
      },
    ]);

    const inherit = await call(c, "preview_whatif", {
      planId: "plan-main",
      templateId: "inheritance",
      params: { month: "2035-06", amount: 250_000, taxable: false },
    });
    const amount = inherit.widget.template.tweakable;
    expect(amount).toHaveLength(1);
    expect(amount[0]).toMatchObject({ name: "amount", value: 250_000, format: "money" });
    for (const p of [...w.template.tweakable, ...tw.tweakable, ...amount]) {
      expect(p.min).toBeLessThanOrEqual(p.value);
      expect(p.value).toBeLessThanOrEqual(p.max);
      expect(p.step).toBeGreaterThan(0);
    }
  });

  it("compare_plans: compare the baseline with the other plan, no ops", async () => {
    h.services.sim.compare(["plan-main", "plan-early"], false); // warm the cache: `cached` is in the text
    const { out, text, widget } = await call(c, "compare_plans", {
      planIds: ["plan-main", "plan-early"],
    });
    expect(text).toBe(JSON.stringify(h.services.sim.compare(["plan-main", "plan-early"], false)));
    expect(widget).toMatchObject({ view: "compare", ops: null, template: null });
    expect(widget.beforeLabel).toBe("Main plan");
    expect(widget.afterLabel).toBe("Retire at 52");
    expect(widget.before.endNetWorth).toBe(out.plans[0].outcome.endNetWorthReal);
    expect(widget.after.endNetWorth).toBe(out.plans[1].outcome.endNetWorthReal);
    expect(widget.after.success).toBe(out.plans[1].success);
    expect(widget.changes.map((x: Json) => x.label)).toEqual(out.differences[0].changes);
    expect(widget.beforeSeries).toHaveLength(widget.years.length);
    expect(widget.afterSeries).toHaveLength(widget.years.length);
    expect(widget.plan.appUrl).toBe(`${WEB}/compare`);
  });

  it("solve_max_spending: the answer with the solver's figure, current value and ops", async () => {
    const { out, widget } = await call(c, "solve_max_spending", {
      planId: "plan-main",
      trials: 100,
      maxEvaluations: 8,
      targetSuccessRate: 0.8,
      wait: 110,
    });
    expect(out.status).toBe("succeeded");
    expect(widget).toMatchObject({
      view: "answer",
      solver: "max-spending",
      targetSuccessRate: 0.8,
    });
    expect(widget.answer).toBe(out.answer);
    expect(widget.figure).toEqual({
      label: expect.any(String),
      value: out.details.annualSpending,
      format: "money",
    });
    expect(widget.current.value).toBe(out.details.currentAnnualSpending);
    expect(widget.ops).toEqual(out.ops ?? null);
  });

  it("solve_retirement_date: the answer as a month, with the planned month", async () => {
    const { out, widget } = await call(c, "solve_retirement_date", {
      planId: "plan-main",
      milestoneId: "ms-retire",
      trials: 100,
      maxEvaluations: 8,
      wait: 110,
    });
    expect(widget.figure).toMatchObject({ value: out.details?.month ?? null, format: "month" });
    expect(widget.current?.value ?? null).toBe(out.details?.currentMonth ?? null);
    expect(widget.targetSuccessRate).toBe(0.85);
  });

  it("solve_required_savings, solve_required_portfolio, solve_safe_withdrawal_rate: answers", async () => {
    const args = { planId: "plan-main", trials: 100, maxEvaluations: 6, wait: 110 };
    const savings = await call(c, "solve_required_savings", { ...args, flowId: "fl-401k" });
    expect(savings.widget).toMatchObject({ view: "answer", solver: "required-savings" });
    expect(savings.widget.figure.value).toBe(savings.out.details?.annualContribution ?? null);
    const portfolio = await call(c, "solve_required_portfolio", args);
    expect(portfolio.widget.figure).toMatchObject({
      value: portfolio.out.details?.requiredPortfolio ?? null,
      format: "money",
    });
    expect(portfolio.widget.current?.value ?? null).toBe(
      portfolio.out.details?.currentPortfolio ?? null,
    );
    const swr = await call(c, "solve_safe_withdrawal_rate", args);
    expect(swr.widget.figure).toMatchObject({
      value: swr.out.details?.rate ?? null,
      format: "percent",
    });
  });

  it("propose_change_set and propose_revert: review with the change set id and preview outcomes", async () => {
    const ops = [{ op: "replace", path: "/expenses/[id=exp-travel]/amount/value", value: 15_000 }];
    const { out, widget } = await call(c, "propose_change_set", {
      planId: "plan-main",
      ops,
      summary: "More travel",
      rationale: "Asked to travel more",
    });
    expect(widget).toMatchObject({
      view: "review",
      changeSetId: out.id,
      summary: "More travel",
      rationale: "Asked to travel more",
      status: "proposed",
      appliedVersion: null,
    });
    expect(widget.changes.map((x: Json) => x.label)).toEqual(out.changes);
    expect(widget.before.endNetWorth).toBe(out.before.endNetWorthReal);
    expect(widget.after.endNetWorth).toBe(out.after.endNetWorthReal);
    expect(widget.plan.appUrl).toBe(`${WEB}/plans/plan-main`);
    expect(out).toHaveProperty("next");

    // Apply it, then propose going back to the version before.
    const applied = await call(c, "apply_change_set", { changeSetId: out.id });
    expect(applied.widget).toBeUndefined();
    const revert = await call(c, "propose_revert", {
      planId: "plan-main",
      version: applied.out.newVersion - 1,
    });
    expect(revert.widget).toMatchObject({ view: "review", changeSetId: revert.out.id });
    expect(revert.widget.summary).toBe(revert.out.summary);
    await call(c, "discard_change_set", { changeSetId: revert.out.id });
  });

  it("explain_year: the year's steps reconcile start to end, withdrawals largest first", async () => {
    for (const year of [2026, 2045, 2060]) {
      const { out, text, widget } = await call(c, "explain_year", { planId: "plan-main", year });
      const n = h.services.sim.explainYear("plan-main", { year, basis: "real" });
      expect(text).toBe(
        JSON.stringify({
          planId: n.planId,
          planVersion: n.planVersion,
          ...compactYearNarrative(n),
        }),
      );
      expect(widget).toMatchObject({ view: "year", year });
      expect(widget.endNetWorth).toBe(out.netWorth.end);
      if (out.netWorth.start !== null) expect(widget.startNetWorth).toBe(out.netWorth.start);
      expect(widget.shortfall).toBe(out.shortfall);
      const total = widget.steps.reduce((t: number, s: Json) => t + s.amount, 0);
      expect(Math.abs(widget.startNetWorth + total - widget.endNetWorth)).toBeLessThanOrEqual(1);
      const amounts = widget.withdrawals.map((w: Json) => w.amount);
      expect(amounts).toEqual([...amounts].sort((a: number, b: number) => b - a));
      expect(widget.ages.length).toBeGreaterThan(0);
      expect(widget.narrative).toBe(out.sentences.join(" "));
      // Everything is attributed for the sample plan: no unexplained "Other".
      expect(widget.steps.map((x: Json) => x.label)).not.toContain("Other");
      expect(widget.steps.map((x: Json) => x.label)).toEqual(
        expect.arrayContaining(["Home and property value", "Inflation (today's money)"]),
      );
      if (year === 2045)
        expect(widget.steps.map((x: Json) => x.label)).toContain(
          "Loan principal repaid (kept as equity)",
        );
    }
    // In nominal money there is no inflation step, and the steps still reconcile.
    const nominal = (
      await call(c, "explain_year", { planId: "plan-main", year: 2045, basis: "nominal" })
    ).widget;
    const labels = nominal.steps.map((x: Json) => x.label);
    expect(labels).not.toContain("Inflation (today's money)");
    expect(labels).not.toContain("Other");
    expect(
      nominal.startNetWorth + nominal.steps.reduce((t: number, x: Json) => t + x.amount, 0),
    ).toBe(nominal.endNetWorth);
  });

  it("tax_breakdown: per-year tax by kind adds up to the text's year totals and lifetime total", async () => {
    const { out, text, widget } = await call(c, "tax_breakdown", { planId: "plan-main" });
    expect(text).toBe(
      JSON.stringify(
        h.services.sim.taxBreakdown("plan-main", { basis: "real", detail: "summary" }),
      ),
    );
    expect(widget.view).toBe("tax");
    expect(widget.lifetimeTotal).toBe(out.totals.total);
    expect(widget.years).toEqual(out.years.map((y: Json) => y.year));
    out.years.forEach((y: Json, i: number) => {
      const stacked = widget.kinds.reduce((t: number, k: Json) => t + k.values[i], 0);
      expect(stacked).toBe(y.total);
    });
    for (const k of widget.kinds) expect(k.values).toHaveLength(widget.years.length);
    expect(widget.plan.appUrl).toBe(`${WEB}/taxes`);
  });
});

describe("plan reference", () => {
  it("links a plan other than the main one to its editor, and says when the connection cannot write", async () => {
    const ro = await connect({ canWrite: false, webUrl: WEB });
    const { widget } = await call(ro, "simulate_plan", { planId: "plan-early" });
    expect(widget.plan).toMatchObject({
      planId: "plan-early",
      canWrite: false,
      appUrl: `${WEB}/plans/plan-early`,
    });
    const noUrl = await connect({ canWrite: false });
    expect(
      (await call(noUrl, "simulate_plan", { planId: "plan-main" })).widget.plan.appUrl,
    ).toBeNull();
  });
});

describe("failures", () => {
  it("a payload builder that throws leaves the tool's result intact, without _meta", async () => {
    const good = await call(c, "tax_breakdown", { planId: "plan-main" });
    vi.spyOn(widgetBuilders, "tax").mockImplementation(() => {
      throw new Error("widget broke");
    });
    const bad = await call(c, "tax_breakdown", { planId: "plan-main" });
    expect(bad.raw.isError ?? false).toBe(false);
    expect(bad.raw._meta).toBeUndefined();
    expect(bad.text).toBe(good.text);
  });
});
