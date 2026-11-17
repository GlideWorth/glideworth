/**
 * Regression tests for the planner QA findings left open on launch day
 * (docs/launch/qa-planner.md, bugs 14, 15, 16 and 18).
 */
import { buildSimulationInput, simulate } from "@glideworth/core";
import { createSampleDocument } from "@glideworth/core/samples";
import { importProjectionLab } from "@glideworth/importers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { buildSyntheticExport } from "../../../packages/importers/test/fixtures/projectionlab-synthetic";
import { Chart } from "../src/components/charts/echarts";
import { buildSankey } from "../src/features/cashflow/sankey";
import { TrialExplorer } from "../src/features/chance/chance-page";
import { planItems, scoreCommand } from "../src/features/plan-editor/components/command-palette";
import { SECTION_OF_ITEM } from "../src/features/plan-editor/state/intent";
import { buildEntityIndex } from "../src/features/results/model";

const resize = vi.fn();
vi.mock("../src/components/charts/echarts-runtime", () => ({
  init: () => ({
    resize,
    setOption: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    dispose: vi.fn(),
  }),
}));

describe("bug 14: cash-flow Saved tile", () => {
  it("counts pay that goes straight into an account, so the tiles add up like the diagram", () => {
    const imported = importProjectionLab(buildSyntheticExport() as never);
    const doc = imported.document;
    const plan = doc.plans[0]!;
    const result = simulate(buildSimulationInput(doc, plan.id));
    const index = buildEntityIndex(doc, plan);
    // 2026: the salary of 5,400 is paid into the current account without touching the cash pool.
    const first = buildSankey(result, 0, 0, "nominal", "grouped", index);
    const toAccounts = result.periods[0]!.ledger.filter(
      (e) => e.kind === "income" && e.to.startsWith("account:"),
    );
    const direct = toAccounts.reduce((s, e) => s + e.amount, 0);
    expect(direct).toBeGreaterThan(5000);
    expect(first.totals.saved).toBeGreaterThanOrEqual(direct);
    // Every year: money in = taxes + spending + saved + debt.
    for (let i = 0; i < result.periods.length; i++) {
      const t = buildSankey(result, i, i, "nominal", "grouped", index).totals;
      const out = t.taxes + t.spending + t.saved + t.debt;
      expect(Math.abs(t.inflow - out), `year index ${i}`).toBeLessThan(1);
    }
  });
});

describe("bug 15: search finds items in the active plan", () => {
  it("lists the plan's income, expenses, milestones and flows by name", () => {
    const doc = createSampleDocument();
    const plan = doc.plans[0]!;
    const items = planItems(plan);
    const income = plan.income[0]!;
    const hit = items.find((x) => x.item === "income" && x.id === income.id);
    expect(hit?.name).toBe(income.name);
    expect(items.some((x) => x.item === "milestone")).toBe(true);
    expect(items.some((x) => x.item === "expense")).toBe(true);
    // Typing part of the name matches it.
    const q = income.name.toLowerCase().slice(0, 4);
    expect(
      scoreCommand({ label: hit!.name, group: "In this plan", hint: hit!.hint }, q),
    ).toBeGreaterThan(0);
    expect(SECTION_OF_ITEM.income).toBe("income");
    expect(SECTION_OF_ITEM.expense).toBe("expenses");
  });
});

describe("bug 16: charts refit when the print layout applies", () => {
  it("resizes on the print media query, beforeprint and afterprint", async () => {
    let onMedia: (() => void) | undefined;
    window.matchMedia = ((q: string) => ({
      matches: false,
      media: q,
      addEventListener: (_: string, fn: () => void) => {
        if (q === "print") onMedia = fn;
      },
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
      onchange: null,
    })) as never;
    globalThis.ResizeObserver = class {
      observe() {}
      disconnect() {}
      unobserve() {}
    } as never;
    render(createElement(Chart, { build: () => ({}), ariaLabel: "test chart" }));
    await waitFor(() => expect(onMedia).toBeDefined());
    resize.mockClear();
    act(() => onMedia?.());
    expect(resize).toHaveBeenCalledTimes(1);
    act(() => {
      window.dispatchEvent(new Event("beforeprint"));
      window.dispatchEvent(new Event("afterprint"));
    });
    expect(resize).toHaveBeenCalledTimes(3);
  });
});

describe("bug 18: the lowest trial is the lowest ending net worth, and says so", () => {
  const trials = [
    { trial: 0, success: true, endNetWorthReal: 900_000, firstShortfallYear: null },
    // Failed early but ended with property equity.
    { trial: 1, success: false, endNetWorthReal: 2_320_000, firstShortfallYear: 2057 },
    { trial: 2, success: false, endNetWorthReal: 150_000, firstShortfallYear: 2080 },
  ];
  const mc = {
    trialSummaries: trials,
    representativeTrials: {
      worst: { trial: 2 },
      p10: { trial: 2 },
      median: { trial: 0 },
      p90: { trial: 1 },
      best: { trial: 1 },
    },
    percentiles: [],
  };
  it("labels the ends by the measure used and picks the matching trial", () => {
    const onTrial = vi.fn();
    render(
      createElement(
        QueryClientProvider,
        { client: new QueryClient() },
        createElement(TrialExplorer, {
          mc: mc as never,
          det: {} as never,
          input: {} as never,
          settings: {} as never,
          example: true,
          trial: null,
          onTrial,
          filter: null,
        }),
      ),
    );
    expect(screen.queryByRole("radio", { name: "Worst" })).toBeNull();
    expect(screen.queryByRole("radio", { name: "Best" })).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "Lowest" }));
    expect(onTrial).toHaveBeenLastCalledWith(2);
    expect(screen.getByText(/ranked by what they end with/i)).toBeTruthy();
    expect(screen.getByLabelText(/ranked by ending net worth, lowest first/i)).toBeTruthy();
  });
});
