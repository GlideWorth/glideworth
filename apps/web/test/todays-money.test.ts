/**
 * Pins the today's-money convention (ARCHITECTURE §3) on every screen's derivation: the UK sample
 * spends £2,300 a month + £4,000 a year in today's money (£31,600 a year), and every screen must show
 * exactly £31,600 for every full year in today's money: Dashboard, Results (chart + table + year
 * narrative), Cash flow (Sankey stats), Taxes (flows by the start-of-year index) and Compare.
 */
import { buildSimulationInput, deflator, type ProjectionResult, simulate } from "@glideworth/core";
import { createUkSampleDocument, UK_SAMPLE_PLAN_ID } from "@glideworth/core/samples";
import { describe, expect, it } from "vitest";
import { buildSankey } from "../src/features/cashflow/sankey";
import { compareMetrics } from "../src/features/compare/compare-model";
import {
  buildEntityIndex,
  cellValue,
  modeSeries,
  tableColumns,
} from "../src/features/results/model";
import { yearNarrative } from "../src/features/results/narrative";
import { byKindSeries } from "../src/features/taxes/tax-model";
import { conv, firstFullYear, measureOf, total } from "../src/lib/money";

const doc = createUkSampleDocument();
const plan = doc.plans.find((p) => p.id === UK_SAMPLE_PLAN_ID)!;
const result: ProjectionResult = simulate(buildSimulationInput(doc, plan.id));
const index = buildEntityIndex(doc, plan);
const pal = { theme: "light" as const, surface: "#fff", ink: "#000", negative: "#b0452e" };
const ENTERED = 2300 * 12 + 4000;
const fullYears = result.periods.map((p, i) => [p, i] as const).filter(([p]) => p.months === 12);
const fmt = (v: number) =>
  new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: "GBP",
    maximumFractionDigits: 0,
  }).format(v);

describe("today's money: what you type is what you see", () => {
  it("the sample really is £31,600 a year in today’s money", () => {
    expect(plan.expenses.map((e) => [e.amount.value, e.amount.basis, e.frequency])).toEqual([
      [2300, "real", "monthly"],
      [4000, "real", "yearly"],
    ]);
    expect(fullYears.length).toBeGreaterThan(10);
  });

  it("dashboard: spending in the first full year", () => {
    const i = firstFullYear(result);
    expect(i).not.toBeNull();
    expect(total(result.periods[i!]!, "spending", "real")).toBeCloseTo(ENTERED, 6);
  });

  it("results: chart, table and narrative show £31,600 in every full year", () => {
    const ie = modeSeries(result, "incomeExpenses", "real", index, pal);
    const spendCol = tableColumns(result, index).find((c) => c.id === "spending")!;
    for (const [p, i] of fullYears.slice(0, 20)) {
      const exp = ie.series
        .filter((s) => s.id.startsWith("exp:"))
        .reduce((s, x) => s + x.values[i]!, 0);
      expect(-exp).toBeCloseTo(ENTERED, 6);
      expect(cellValue(spendCol, p, "real")).toBeCloseTo(ENTERED, 6);
      const story = yearNarrative(result, i, "real", index, fmt, (v) => `${v}`);
      expect(story[0]!.text).toContain(`spent ${fmt(ENTERED)}`);
    }
  });

  it("the partial first year shows the same rate, pro rata", () => {
    const p0 = result.periods[0]!;
    expect(total(p0, "spending", "real")).toBeCloseTo((ENTERED * p0.months) / 12, 6);
  });

  it("cash flow: the Sankey spending stat is £31,600", () => {
    for (const [, i] of fullYears.slice(0, 10)) {
      const g = buildSankey(result, i, i, "real", "grouped", index);
      expect(g.totals.spending).toBeCloseTo(ENTERED, 6);
    }
  });

  it("taxes: tax flows deflate by the start-of-year index, balances by the end-of-year index", () => {
    const [p, i] = fullYears[3]!;
    const byKind = byKindSeries(result, "real", "kind");
    const sum = byKind.reduce((s, k) => s + k.values[i]!, 0);
    expect(sum).toBeCloseTo(
      p.taxes.lines.reduce((s, l) => s + l.amount, 0) / deflator(p, "flow"),
      6,
    );
    expect(deflator(p, "flow")).toBeLessThan(deflator(p, "stock"));
    expect(conv(p, p.totals.netWorth, "real", "netWorth")).toBeCloseTo(
      p.totals.netWorth / p.priceIndex,
      6,
    );
    expect(measureOf("taxes")).toBe("flow");
    expect(measureOf("netWorth")).toBe("stock");
  });

  it("compare: per-year spending series and lifetime spending", () => {
    for (const [p] of fullYears.slice(0, 10))
      expect(conv(p, p.totals.spending, "real", "spending")).toBeCloseTo(ENTERED, 6);
    const m = compareMetrics(result);
    const expected = result.periods.reduce((s, p) => s + (ENTERED * p.months) / 12, 0);
    // Spending stays £31,600 a year until the plan ends (no shortfall in the sample's early years).
    expect(m.lifetimeSpendingReal).toBeLessThanOrEqual(expected + 1);
    expect(m.lifetimeSpendingReal).toBeGreaterThan(expected * 0.9);
  });

  it("future money is the nominal engine output, untouched", () => {
    const [p] = fullYears[5]!;
    expect(total(p, "spending", "nominal")).toBe(p.totals.spending);
    expect(total(p, "spending", "nominal")).toBeGreaterThan(ENTERED);
  });
});
