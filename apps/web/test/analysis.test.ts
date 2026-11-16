import {
  buildSimulationInput,
  MonteCarloSettings,
  type ProjectionResult,
  simulate,
  toBasis,
} from "@glideworth/core";
import {
  createSampleDocument,
  createUkSampleDocument,
  UK_SAMPLE_PLAN_ID,
} from "@glideworth/core/samples";
import { describe, expect, it } from "vitest";
import { accountColors, categoryColor, SERIES } from "../src/components/charts/palette";
import { buildSankey } from "../src/features/cashflow/sankey";
import { mergeShards, runShard } from "../src/features/chance/mc-handle";
import { attributeDifference, compareMetrics } from "../src/features/compare/compare-model";
import { scaleExpenses, shiftMilestoneAge } from "../src/features/insights/plan-edits";
import {
  importSnapshotsCsv,
  parseCsv,
  snapshotFromFinances,
} from "../src/features/progress/progress-model";
import { exampleMonteCarlo } from "../src/features/results/fixtures";
import {
  buildEntityIndex,
  modeSeries,
  projectionCsv,
  rangePresets,
  tableColumns,
  timelineEvents,
  toCsv,
} from "../src/features/results/model";
import { yearNarrative } from "../src/features/results/narrative";
import { analyseYear, resolveTaxStack, taxSources } from "../src/features/taxes/tax-analytics";

const doc = createSampleDocument();
const plan = doc.plans[0]!;
const input = buildSimulationInput(doc, plan.id);
const result: ProjectionResult = simulate(input);
const index = buildEntityIndex(doc, plan);
const pal = { theme: "light" as const, surface: "#fbfaf6", ink: "#1c2320", negative: "#b0452e" };

describe("colour system", () => {
  it("gives every account category a distinct, stable colour in both themes", () => {
    for (const theme of ["light", "dark"] as const) {
      const cats = [
        "cash",
        "taxable",
        "crypto",
        "tax-deferred",
        "tax-free",
        "hsa",
        "education",
        "real-assets",
      ] as const;
      const colours = cats.map((c) => categoryColor(theme, c));
      expect(new Set(colours).size).toBe(cats.length);
      expect(SERIES[theme]).toHaveLength(8);
    }
  });
  it("steps accounts within a category and keeps colours tied to the entity", () => {
    const a = accountColors(
      "light",
      [
        { id: "x", category: "taxable" },
        { id: "y", category: "taxable" },
        { id: "z", category: "cash" },
      ],
      "#ffffff",
      "#000000",
    );
    expect(a.x).toBe(categoryColor("light", "taxable"));
    expect(a.y).not.toBe(a.x);
    expect(a.z).toBe(categoryColor("light", "cash"));
  });
});

describe("projection model", () => {
  it("builds every chart mode with one value per year", () => {
    for (const mode of [
      "netWorth",
      "byAccount",
      "byTreatment",
      "assetsDebts",
      "incomeExpenses",
      "cashFlow",
    ] as const) {
      const ms = modeSeries(result, mode, "real", index, pal);
      expect(ms.series.length).toBeGreaterThan(0);
      for (const s of ms.series) expect(s.values).toHaveLength(result.periods.length);
    }
  });
  it("net-worth mode stacks to assets minus liabilities", () => {
    const ms = modeSeries(result, "netWorth", "nominal", index, pal);
    const i = 10;
    const stacked = ms.series.reduce((s, x) => s + x.values[i]!, 0);
    expect(stacked).toBeCloseTo(result.periods[i]!.totals.netWorth, -1);
    expect(ms.line!.values[i]).toBeCloseTo(result.periods[i]!.totals.netWorth, 6);
  });
  it("converts balances to today's money with the end-of-year index", () => {
    const real = modeSeries(result, "netWorth", "real", index, pal).line!.values;
    const nominal = modeSeries(result, "netWorth", "nominal", index, pal).line!.values;
    const p = result.periods[20]!;
    expect(real[20]).toBeCloseTo(toBasis(nominal[20]!, p, "real", "stock"), 6);
  });
  it("finds milestones and life events for the timeline", () => {
    const ev = timelineEvents(result, plan);
    expect(ev.some((e) => e.type === "milestone" && /Retirement/.test(e.label))).toBe(true);
    expect(ev.some((e) => e.type === "income-end")).toBe(true);
  });
  it("offers display ranges including retirement", () => {
    expect(rangePresets(result).map((r) => r.id)).toEqual(
      expect.arrayContaining(["all", "next10", "drawdown"]),
    );
  });
  it("exports CSV with currency + basis in money headers and RFC 4180 quoting", () => {
    const cols = tableColumns(result, index).filter((c) => c.defaultOn);
    const csv = projectionCsv(result, cols, "real", "GBP");
    expect(csv.split("\r\n")).toHaveLength(result.periods.length + 1);
    expect(csv).toContain("Net worth (GBP, today's money)");
    expect(toCsv(["a"], [['x,"y"']])).toBe('a\r\n"x,""y"""');
  });
  it("writes an evidence-backed narrative for a year", () => {
    const lines = yearNarrative(
      result,
      5,
      "real",
      index,
      (v) => String(Math.round(v)),
      (v) => v.toFixed(3),
    );
    expect(lines.length).toBeGreaterThan(1);
    expect(lines[0]!.text).toContain(String(result.periods[5]!.year));
  });
});

describe("cash-flow sankey", () => {
  it("conserves money through the pool for a year and for a range", () => {
    for (const [a, b] of [
      [3, 3],
      [0, 10],
    ] as const) {
      const g = buildSankey(result, a, b, "nominal", "detail", index);
      const into = g.links.filter((l) => l.target === "pool").reduce((s, l) => s + l.value, 0);
      const out = g.links.filter((l) => l.source === "pool").reduce((s, l) => s + l.value, 0);
      expect(into).toBeGreaterThan(0);
      expect(Math.abs(into - out) / into).toBeLessThan(0.01);
      expect(g.links.every((l) => l.source !== l.target)).toBe(true);
    }
  });
  it("balances its headline totals: money in = taxes + spending + saved + debt (employer pension included)", () => {
    const uk = createUkSampleDocument();
    const ukPlan = uk.plans.find((p) => p.id === UK_SAMPLE_PLAN_ID)!;
    const ukRes = simulate(buildSimulationInput(uk, ukPlan.id));
    const ukIndex = buildEntityIndex(uk, ukPlan);
    for (const [a, b] of [
      [0, 0],
      [1, 1],
      [0, ukRes.periods.length - 1],
    ] as const) {
      const t = buildSankey(ukRes, a, b, "real", "grouped", ukIndex).totals;
      const out = t.taxes + t.spending + t.saved + t.debt;
      expect(t.inflow).toBeGreaterThan(0);
      expect(Math.abs(t.inflow - out) / t.inflow).toBeLessThan(0.001);
    }
    // The working-year income stat includes the employer contribution, like the engine's totals.
    const p1 = ukRes.periods[1]!;
    const t1 = buildSankey(ukRes, 1, 1, "nominal", "grouped", ukIndex).totals;
    expect(t1.inflow).toBeCloseTo(p1.totals.income + p1.totals.withdrawals, 0);
  });
  it("groups nodes when asked", () => {
    const detail = buildSankey(result, 3, 3, "real", "detail", index);
    const grouped = buildSankey(result, 3, 3, "real", "grouped", index);
    expect(grouped.nodes.length).toBeLessThanOrEqual(detail.nodes.length);
  });
});

function withEstimatedTax(d: ReturnType<typeof createSampleDocument>, planId: string) {
  const copy = structuredClone(d);
  const pl = copy.plans.find((x) => x.id === planId)!;
  pl.tax = { ...pl.tax, mode: "estimate" };
  return { doc: copy, plan: pl };
}

describe("tax analytics on the real jurisdiction stacks", () => {
  const uk = withEstimatedTax(createUkSampleDocument(), UK_SAMPLE_PLAN_ID);
  const ukResult = simulate(buildSimulationInput(uk.doc, uk.plan.id));
  const stackRes = resolveTaxStack(uk.doc, uk.plan);
  it("resolves the UK stack and reports tax-year sources", () => {
    expect(stackRes.ok).toBe(true);
    if (!stackRes.ok) return;
    expect(stackRes.stack.map((j) => j.id)).toContain("uk");
    const src = taxSources(stackRes.stack);
    expect(src[0]!.years.length).toBeGreaterThan(0);
    expect(src[0]!.links[0]!.url).toMatch(/^https:/);
  });
  it("rebuilds a year, fills bands and reports marginal rates per income type", () => {
    if (!stackRes.ok) throw new Error("no stack");
    const i = ukResult.periods.findIndex((p) => p.taxes.grossIncome > 20_000);
    expect(i).toBeGreaterThanOrEqual(0);
    const a = analyseYear(uk.doc, uk.plan, ukResult, stackRes.stack, i);
    expect(a.analysis.total).toBeGreaterThan(0);
    expect(a.analysis.brackets.length).toBeGreaterThan(0);
    for (const b of a.analysis.brackets) expect(b.bands.every((x) => x.amount >= 0)).toBe(true);
    expect(a.analysis.marginalByType.ordinary).toBeGreaterThan(0);
    expect(a.analysis.marginalByType.ordinary).toBeLessThan(1);
    expect(Math.abs(a.drift)).toBeLessThan(0.5);
  });
  it("resolves stacks for every supported country, flat and custom plans", () => {
    const base = createSampleDocument();
    for (const [country, region, expected] of [
      ["US", "CO", "us-federal"],
      ["CA", "ON", "ca-federal"],
      ["AU", undefined, "au"],
      ["DE", undefined, "de"],
      ["NL", undefined, "nl"],
      ["FR", undefined, "fr"],
      ["ES", "MD", "es:MD"],
      ["IL", undefined, "il"],
      ["IE", undefined, "ie"],
      ["NZ", undefined, "nz"],
    ] as const) {
      const d = structuredClone(base);
      d.household.location = { country, ...(region ? { region } : {}) };
      const pl = d.plans[0]!;
      pl.tax = { ...pl.tax, mode: "estimate" };
      const r = resolveTaxStack(d, pl);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.stack.map((j) => j.id)).toContain(expected);
    }
    const flat = resolveTaxStack(base, base.plans[0]!);
    expect(flat.ok && flat.stack[0]!.id).toBe("flat");
    const noPreset = structuredClone(base);
    // A country without a tax preset ('XX' = somewhere else) cannot be estimated.
    noPreset.household.location = { country: "XX" };
    noPreset.plans[0]!.tax = { ...noPreset.plans[0]!.tax, mode: "estimate" };
    expect(resolveTaxStack(noPreset, noPreset.plans[0]!).ok).toBe(false);
  });
});

describe("progress snapshots", () => {
  it("records a snapshot from current finances", () => {
    const s = snapshotFromFinances(doc, "2026-11-15");
    expect(s.netWorth).toBeCloseTo(s.assets - s.liabilities, 6);
    expect(s.accounts).toHaveLength(doc.finances.accounts.length);
  });
  it("parses CSV with quotes and imports snapshots with errors reported", () => {
    expect(parseCsv('a,b\r\n"1,2",3\n')).toEqual([
      ["a", "b"],
      ["1,2", "3"],
    ]);
    const r = importSnapshotsCsv(
      'Date,Assets,Liabilities,Note\n2024-01-31,500000,200000,"start"\n31/12/2024,550000,190000,\nbad,1,1,',
    );
    expect(r.drafts).toHaveLength(2);
    expect(r.drafts[0]!.netWorth).toBe(300_000);
    expect(r.drafts[1]!.date).toBe("2024-12-31");
    expect(r.errors).toHaveLength(1);
  });
});

describe("compare and what-if", () => {
  it("attribution parts add up to the end net worth difference", () => {
    const other = simulate({ ...input, plan: scaleExpenses(plan, 1.1).plan });
    const a = attributeDifference(result, other);
    expect(a.parts.reduce((s, p) => s + p.value, 0)).toBeCloseTo(a.total, 3);
    expect(a.total).toBeLessThan(0);
    expect(compareMetrics(other).endNetWorthReal).toBeCloseTo(other.summary.endNetWorthReal, 6);
  });
  it("plan edits describe what they changed", () => {
    const v = shiftMilestoneAge(plan, "retirement", -3);
    expect(v.changes[0]).toMatch(/57 to 54/);
    expect(v.plan.milestones.find((m) => m.id === "ms-retire")!.criteria[0]).toMatchObject({
      age: 54,
    });
    expect(plan.milestones.find((m) => m.id === "ms-retire")!.criteria[0]).toMatchObject({
      age: 57,
    });
  });
});

describe("chance of success", () => {
  const settings = MonteCarloSettings.parse({ method: "normal", trials: 24, seed: 7 });
  it("example data is internally consistent", () => {
    const mc = exampleMonteCarlo(result, settings);
    expect(mc.successRate).toBeGreaterThanOrEqual(0);
    expect(mc.successRate).toBeLessThanOrEqual(1);
    expect(Object.values(mc.outcomeCounts).reduce((s, x) => s + x, 0)).toBe(mc.trials);
  });
  it("sharded runs merge to the single-run result (when core stochastic is available)", () => {
    let one: ReturnType<typeof mergeShards>;
    try {
      one = mergeShards([runShard(input, settings, 0, 1, () => {})], settings);
    } catch (e) {
      expect((e as { code?: string }).code).toBe("NOT_IMPLEMENTED");
      return;
    }
    const two = mergeShards(
      [runShard(input, settings, 1, 2, () => {}), runShard(input, settings, 0, 2, () => {})],
      settings,
    );
    expect(two.trials).toBe(24);
    expect(two.successRate).toBe(one.successRate);
  });
});
