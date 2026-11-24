/**
 * Healthcare and long-term care: the rate next to "Rises with" is the rate the projection
 * compounds above inflation. The form used to say "General inflation" while the engine applied
 * the plan's healthcare premium on top.
 */
import {
  buildSimulationInput,
  FREQUENCY_PER_YEAR,
  type ProjectionResult,
  simulate,
  toBasis,
} from "@glideworth/core";
import { createUkSampleDocument } from "@glideworth/core/samples";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PlanIdContext } from "../src/features/plan-editor/components/plan-context";
import { EventSheet } from "../src/features/plan-editor/sections/events";
import { newExpense } from "../src/features/plan-editor/state/defaults";
import {
  editPlan,
  loadDocument,
  resetEditorStore,
  useEditorStore,
} from "../src/features/plan-editor/state/doc-store";

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  resetEditorStore();
  loadDocument(createUkSampleDocument(), "sample");
});

function openCare(type: "healthcare" | "long-term-care"): string {
  const doc = useEditorStore.getState().draft!;
  const plan = doc.plans[0]!;
  const created = newExpense(
    type,
    { household: doc.household, finances: doc.finances },
    plan.assumptions.healthcareInflationPremium,
  );
  editPlan(plan.id, (p) => ({ ...p, expenses: [...p.expenses, created] }), `Add ${type}`);
  render(
    <QueryClientProvider client={new QueryClient()}>
      <PlanIdContext.Provider value={plan.id}>
        <EventSheet kind="expense" id={created.id} onClose={() => {}} />
      </PlanIdContext.Provider>
    </QueryClientProvider>,
  );
  return created.id;
}

/** The percent field shows a rate (2 for 2%); the engine stores a fraction. */
function displayedRate(): number {
  const input = screen.getByRole("textbox", { name: "Rises above inflation" }) as HTMLInputElement;
  return Number(input.value) / 100;
}

function reals(result: ProjectionResult, id: string): number[] {
  return result.periods.flatMap((p) => {
    const line = p.expenses.find((e) => e.sourceId === id);
    return line && line.requested > 0 ? [toBasis(line.requested, p, "real", "flow")] : [];
  });
}

/** Year-on-year ratio of today's-money cost closest to `ratio` (full years land on it exactly). */
function closestRatio(xs: number[], ratio: number): number {
  let best = Number.POSITIVE_INFINITY;
  let found = Number.NaN;
  for (let i = 1; i < xs.length; i++) {
    const r = xs[i]! / xs[i - 1]!;
    const d = Math.abs(r - ratio);
    if (d < best) {
      best = d;
      found = r;
    }
  }
  return found;
}

function projectStored() {
  const doc = useEditorStore.getState().draft!;
  return simulate(buildSimulationInput(doc, doc.plans[0]!.id));
}

describe("care costs show the growth the projection applies", () => {
  it("long-term care shows the rate the engine compounds, and editing it changes the projection", () => {
    const id = openCare("long-term-care");
    const rises = screen.getByRole("combobox", { name: "Rises with" });
    expect(rises.textContent).toContain("General inflation");
    const rate = displayedRate();
    const exp = useEditorStore.getState().draft!.plans[0]!.expenses.find((e) => e.id === id)!;
    expect(exp.change).toEqual({ kind: "inflation", plus: rate });
    expect(rate).toBeCloseTo(0.02, 8);
    expect(screen.getByText(/rises by the rate above every year/)).toBeTruthy();

    const rising = reals(projectStored(), id);
    expect(closestRatio(rising, 1 + rate)).toBeCloseTo(1 + rate, 6);

    const input = screen.getByRole("textbox", { name: "Rises above inflation" });
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "0" } });
    fireEvent.blur(input);

    const next = displayedRate();
    const saved = useEditorStore.getState().draft!.plans[0]!.expenses.find((e) => e.id === id)!;
    expect(saved.change).toEqual({ kind: "inflation", plus: next });
    expect(next).toBe(0);
    const flat = reals(projectStored(), id);
    expect(closestRatio(flat, 1)).toBeCloseTo(1, 6);
    const annual = saved.amount.value * FREQUENCY_PER_YEAR[saved.frequency];
    expect(Math.max(...flat)).toBeCloseTo(annual, 2);
  });

  it("healthcare shows that same rate instead of general inflation alone", () => {
    const id = openCare("healthcare");
    expect(screen.getByRole("combobox", { name: "Rises with" }).textContent).toContain(
      "General inflation",
    );
    const rate = displayedRate();
    const exp = useEditorStore.getState().draft!.plans[0]!.expenses.find((e) => e.id === id)!;
    expect(exp.change).toEqual({ kind: "inflation", plus: rate });
    expect(rate).toBeCloseTo(0.02, 8);
    expect(
      screen.getByText(/The rate next to Rises with is what the projection grows this cost by/),
    ).toBeTruthy();
    expect(screen.queryByText(/see Change over time/)).toBeNull();
    expect(closestRatio(reals(projectStored(), id), 1 + rate)).toBeCloseTo(1 + rate, 6);
  });
});
