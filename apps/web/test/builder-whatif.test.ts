import { applyPlanPatch, buildSimulationInput, simulate } from "@glideworth/core";
import { createUkSampleDocument, UK_SAMPLE_PLAN_ID } from "@glideworth/core/samples";
import { describe, expect, it } from "vitest";
import {
  buildCatalog,
  buildSeries,
  defaultAxis,
  emptyView,
  loadViews,
  saveViews,
  upsertView,
} from "../src/features/builder/builder-model";
import {
  branchFor,
  capabilities,
  NEUTRAL,
  stage,
} from "../src/features/plan-editor/whatif/whatif-model";
import { buildEntityIndex } from "../src/features/results/model";

const doc = createUkSampleDocument();
const plan = doc.plans.find((p) => p.id === UK_SAMPLE_PLAN_ID)!;
const input = buildSimulationInput(doc, plan.id);
const result = simulate(input);
const index = buildEntityIndex(doc, plan);

describe("custom chart builder", () => {
  const catalog = buildCatalog(result, index);
  it("offers metrics, every account, categories and tax lines", () => {
    const refs = new Set(catalog.map((c) => c.ref));
    expect(refs.has("metric:netWorth")).toBe(true);
    expect(refs.has("tax:effective")).toBe(true);
    for (const a of doc.finances.accounts) expect(refs.has(`acct:${a.id}:closing`)).toBe(true);
    expect([...refs].some((r) => r.startsWith("cat:"))).toBe(true);
    expect(new Set(refs).size).toBe(catalog.length);
  });
  it("builds chart values in the chosen basis and stacks only money bars/areas", () => {
    const v = {
      ...emptyView(),
      chartType: "bar" as const,
      stacked: true,
      series: [
        { ref: "metric:netWorth", axis: "left" as const },
        { ref: "tax:effective", axis: "right" as const, type: "line" as const },
        { ref: "gone:missing", axis: "left" as const },
      ],
    };
    const real = buildSeries({ ...v, basis: "real" }, catalog, result, "nominal");
    const nominal = buildSeries({ ...v, basis: "nominal" }, catalog, result, "real");
    expect(real.missing).toEqual(["gone:missing"]);
    expect(real.series[0]!.stack).toBe("stack-left");
    expect(real.series[1]!.stack).toBeUndefined();
    const last = result.periods.length - 1;
    expect(nominal.series[0]!.values[last]).toBeCloseTo(result.periods[last]!.totals.netWorth, 4);
    expect(real.series[0]!.values[last]).toBeCloseTo(
      result.periods[last]!.totals.netWorth / result.periods[last]!.priceIndex,
      4,
    );
  });
  it("puts percentages on the right axis alongside money", () => {
    expect(defaultAxis("percent", [{ kind: "money", axis: "left" }])).toBe("right");
    expect(defaultAxis("percent", [])).toBe("left");
    expect(defaultAxis("money", [{ kind: "percent", axis: "left" }])).toBe("right");
  });
  it("saves named views per plan and survives broken storage", () => {
    const mem = new Map<string, string>();
    const s = {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
    };
    const view = { ...emptyView(), id: "v1", name: "Tax rates" };
    expect(saveViews("p1", upsertView([], view), s)).toBe(true);
    expect(loadViews("p1", s)).toEqual([view]);
    expect(loadViews("other-plan", s)).toEqual([]);
    mem.set("glideworth:chart-views:v1:p1", "{not json");
    expect(loadViews("p1", s)).toEqual([]);
    expect(saveViews("p1", [view], null)).toBe(false);
  });
});

describe("what-if staging", () => {
  it("stages nothing for neutral settings", () => {
    expect(stage(input, NEUTRAL)).toBeNull();
  });
  it("turns sliders into patch ops, a described diff, and an inverse that restores the plan", () => {
    const caps = capabilities(input);
    expect(caps.spending.ok).toBe(true);
    const st = stage(input, { ...NEUTRAL, spending: 0.9, retireShift: -2, growth: -0.01 })!;
    expect(st.ops.length).toBeGreaterThan(2);
    expect(st.changes.length).toBeGreaterThan(0);
    expect(applyPlanPatch(st.plan, st.inverse)).toEqual(plan);
    const alt = simulate({ ...input, plan: st.plan });
    expect(alt.summary.endNetWorthReal).not.toBe(result.summary.endNetWorthReal);
  });
  it("spending down helps and saving more helps", () => {
    const base = result.summary.endNetWorthReal;
    const less = stage(input, { ...NEUTRAL, spending: 0.8 })!;
    expect(simulate({ ...input, plan: less.plan }).summary.endNetWorthReal).toBeGreaterThan(base);
    if (capabilities(input).saving.ok) {
      const more = stage(input, { ...NEUTRAL, saving: 1.5 })!;
      expect(simulate({ ...input, plan: more.plan }).summary.endNetWorthReal).toBeGreaterThan(base);
    }
  });
  it("creates a branch whose lineage patch holds only the staged differences", () => {
    const st = stage(input, { ...NEUTRAL, spending: 1.1 })!;
    const b = branchFor(plan, st.ops, "Spend 10% more", "plan-whatif-test");
    expect(b.lineage?.parentPlanId).toBe(plan.id);
    expect(b.name).toBe("Spend 10% more");
    expect(b.lineage!.patch.some((o) => o.path.includes("/expenses"))).toBe(true);
  });
});
