import { type Change, MonteCarloSettings, type Plan } from "@glideworth/core";
import { createSampleDocument } from "@glideworth/core/samples";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { moveItem, SortableList } from "../src/components/ui/sortable-list";
import { DEFAULT_SAMPLING_METHOD } from "../src/features/chance/method-advanced";
import { ConflictBanner } from "../src/features/plan-editor/components/editor-chrome";
import { ChangeEditor } from "../src/features/plan-editor/components/form";
import { PlanIdContext } from "../src/features/plan-editor/components/plan-context";
import { MonteCarloSection } from "../src/features/plan-editor/sections/settings";
import {
  editPlan,
  loadDocument,
  planKey,
  resetEditorStore,
  setSave,
  useEditorStore,
} from "../src/features/plan-editor/state/doc-store";

// No vitest globals here, so Testing Library cannot unmount on its own. Without this, components from
// earlier tests stay mounted, re-render when a later beforeEach resets the editor store, and can do so
// after jsdom has been torn down ("window is not defined" on CI).
afterEach(() => {
  cleanup();
});

function SortHarness() {
  const [items, setItems] = useState(["Pension", "ISA", "GIA"]);
  return (
    <SortableList
      aria-label="Flows"
      items={items}
      getId={(x) => x}
      getLabel={(x) => x}
      onReorder={(a, b) => setItems((xs) => moveItem(xs, a, b))}
      renderItem={(x, { handle }) => (
        <div>
          {handle}
          <span data-testid="item">{x}</span>
        </div>
      )}
    />
  );
}

describe("SortableList", () => {
  it("reorders with the keyboard and announces it", () => {
    render(<SortHarness />);
    fireEvent.keyDown(screen.getByRole("button", { name: /Reorder Pension/ }), {
      key: "ArrowDown",
    });
    expect(screen.getAllByTestId("item").map((n) => n.textContent)).toEqual([
      "ISA",
      "Pension",
      "GIA",
    ]);
    expect(screen.getByText("Moved Pension to position 2 of 3.")).toBeTruthy();
  });
});

function ChangeHarness() {
  const [c, setC] = useState<Change>({ kind: "inflation", plus: 0 });
  return (
    <>
      <ChangeEditor value={c} onChange={setC} />
      <output data-testid="kind">{c.kind}</output>
    </>
  );
}

describe("ChangeEditor", () => {
  it("switches to a custom schedule with editable points", () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ChangeHarness />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole("radio", { name: "Custom schedule" }));
    expect(screen.getByTestId("kind").textContent).toBe("schedule");
    expect(screen.getAllByRole("group", { name: /Point \d time/ })).toHaveLength(2);
  });
});

describe("ConflictBanner", () => {
  beforeEach(() => {
    resetEditorStore();
    loadDocument(createSampleDocument(), "sample");
  });
  it('merges our edit with the server version on "Merge both"', () => {
    const s = useEditorStore.getState();
    const base = s.base!.plans[0]!;
    editPlan(base.id, (p) => ({ ...p, notes: "mine" }), "Notes");
    const theirs: Plan = { ...base, description: "theirs", version: base.version + 1 };
    setSave(planKey(base.id), {
      status: "conflict",
      theirs,
      theirsVersion: theirs.version,
      message: "Saved elsewhere.",
    });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ConflictBanner entity={planKey(base.id)} what="This plan" />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: /Merge both/ }));
    const merged = useEditorStore.getState().draft!.plans[0]!;
    expect(merged.notes).toBe("mine");
    expect(merged.description).toBe("theirs");
    expect(merged.version).toBeGreaterThanOrEqual(theirs.version);
    expect(useEditorStore.getState().save[planKey(base.id)]?.status).not.toBe("conflict");
  });
});

describe("Monte Carlo method", () => {
  beforeEach(() => {
    resetEditorStore();
    loadDocument(createSampleDocument(), "sample");
  });
  const renderSection = (planId: string) =>
    render(
      <QueryClientProvider client={new QueryClient()}>
        <PlanIdContext.Provider value={planId}>
          <MonteCarloSection />
        </PlanIdContext.Provider>
      </QueryClientProvider>,
    );

  it("defaults to what a new plan gets", () => {
    expect(DEFAULT_SAMPLING_METHOD).toBe(MonteCarloSettings.parse({}).method);
  });

  it("states the method in use and keeps the picker in a collapsed Advanced section", () => {
    const plan = useEditorStore.getState().draft!.plans[0]!;
    const { container } = renderSection(plan.id);
    expect(plan.monteCarlo.method).toBe(DEFAULT_SAMPLING_METHOD);
    expect(container.textContent).toMatch(
      /Market paths: Historical, random start years \(default\)/,
    );
    const details = screen.getByText("Advanced").closest("details")!;
    expect(details.open).toBe(false);
    expect(details.contains(screen.getByText("Market paths", { selector: "label" }))).toBe(true);
  });

  it("shows a stored non-default method without changing it", () => {
    const plan = useEditorStore.getState().draft!.plans[0]!;
    editPlan(
      plan.id,
      (p) => ({ ...p, monteCarlo: { ...p.monteCarlo, method: "block-bootstrap" } }),
      "Method",
    );
    const { container } = renderSection(plan.id);
    expect(container.textContent).toMatch(/Market paths: Block bootstrap of history/);
    expect(container.textContent).not.toMatch(/\(default\)/);
    expect(useEditorStore.getState().draft!.plans[0]!.monteCarlo.method).toBe("block-bootstrap");
  });
});
