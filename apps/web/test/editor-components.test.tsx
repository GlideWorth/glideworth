import type { Change, Plan } from "@glideworth/core";
import { createSampleDocument } from "@glideworth/core/samples";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { moveItem, SortableList } from "../src/components/ui/sortable-list";
import { ConflictBanner } from "../src/features/plan-editor/components/editor-chrome";
import { ChangeEditor } from "../src/features/plan-editor/components/form";
import {
  editPlan,
  loadDocument,
  planKey,
  resetEditorStore,
  setSave,
  useEditorStore,
} from "../src/features/plan-editor/state/doc-store";

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
