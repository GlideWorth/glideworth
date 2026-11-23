import {
  type Dependent,
  ExpenseEvent,
  type GlideworthDocument,
  type Plan,
  simulate,
  buildSimulationInput,
} from "@glideworth/core";
import { createSampleDocument } from "@glideworth/core/samples";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  alreadyPast,
  buildDependentCost,
  defaultDraft,
  draftIssues,
  linkedCosts,
  PRESET_ORDER,
  planMentions,
  planWithoutDependent,
} from "../src/features/finances/dependent-costs";
import { DependentCosts } from "../src/features/finances/dependent-costs-panel";
import {
  loadDocument,
  resetEditorStore,
  undo,
  useEditorStore,
} from "../src/features/plan-editor/state/doc-store";

afterEach(() => {
  cleanup();
});

const ROBIN: Dependent = {
  id: "dep-robin",
  name: "Robin",
  birthMonth: "2017-05",
  independentAtAge: 18,
};

const sample = (): GlideworthDocument => createSampleDocument();

describe("dependant cost presets", () => {
  it("never suggest an amount, and name and time the cost from the dependant", () => {
    for (const p of PRESET_ORDER) {
      const d = defaultDraft(ROBIN, p);
      expect(d.amount).toBeNull();
      expect(d.name).toMatch(/^Robin’s /);
      expect(d.endAge).toBeGreaterThan(d.startAge);
      expect(draftIssues(d)).toEqual(["amount"]);
    }
  });

  it("support runs until the dependant's own independence age", () => {
    expect(defaultDraft({ ...ROBIN, independentAtAge: 21 }, "support").endAge).toBe(21);
  });

  it("rejects an end age at or before the start", () => {
    const d = { ...defaultDraft(ROBIN, "college"), amount: 100, endAge: 18 };
    expect(draftIssues(d)).toEqual(["ages"]);
  });
});

describe("buildDependentCost", () => {
  it("creates a valid expense tagged with the dependant and timed by their age", () => {
    const doc = sample();
    const e = buildDependentCost(ROBIN, { ...defaultDraft(ROBIN, "college"), amount: 12_000 }, doc);
    expect(ExpenseEvent.parse(e)).toEqual(e);
    expect(e).toMatchObject({
      type: "education",
      dependentId: "dep-robin",
      name: "Robin’s college",
      amount: { value: 12_000, basis: "real" },
      frequency: "yearly",
      range: {
        start: { kind: "dependentAge", dependentId: "dep-robin", age: 18 },
        end: { kind: "dependentAge", dependentId: "dep-robin", age: 22 },
        endInclusive: false,
      },
    });
  });

  it("moves with the birth month when simulated", () => {
    const doc = sample();
    const e = buildDependentCost(
      ROBIN,
      { ...defaultDraft(ROBIN, "childcare"), amount: 500, startAge: 9, endAge: 10 },
      doc,
    );
    const run = (birthMonth: string) => {
      const d: GlideworthDocument = {
        ...doc,
        household: { ...doc.household, dependents: [{ ...ROBIN, birthMonth }] },
        plans: doc.plans.map((p) => (p.isMain ? { ...p, expenses: [...p.expenses, e] } : p)),
      };
      const main = d.plans.find((p) => p.isMain)!;
      const r = simulate(buildSimulationInput(d, main.id));
      return r.periods
        .filter((p) => p.expenses.some((x) => x.sourceId === e.id && x.requested > 0))
        .map((p) => p.year);
    };
    expect(run("2017-05")).toEqual([2026, 2027]); // age 9 from 2026-05 to 2027-05
    expect(run("2018-01")).toEqual([2027]); // age 9 for calendar 2027
  });
});

describe("linked costs and removing a dependant", () => {
  const withCost = (plan: Plan, e: ExpenseEvent): Plan => ({
    ...plan,
    expenses: [...plan.expenses, e],
  });

  it("groups the same cost across plans, the reference plan first", () => {
    const doc = sample();
    const e = buildDependentCost(ROBIN, { ...defaultDraft(ROBIN, "school"), amount: 3_000 }, doc);
    const plans = doc.plans.map((p) => withCost(p, e));
    const [main, early] = plans as [Plan, Plan];
    const rows = linkedCosts(plans, ROBIN.id, early.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.plans.map((p) => p.id)).toEqual([early.id, main.id]);
    expect(linkedCosts(plans, "someone-else")).toEqual([]);
  });

  it("removes linked costs and pins other dates that followed the dependant", () => {
    const doc = sample();
    const cost = buildDependentCost(ROBIN, { ...defaultDraft(ROBIN, "support"), amount: 200 }, doc);
    const plan = doc.plans[0]!;
    const other: ExpenseEvent = {
      ...plan.expenses[0]!,
      id: "exp-other",
      range: {
        start: { kind: "dependentAge", dependentId: ROBIN.id, age: 18, offsetMonths: 2 },
        end: { kind: "planEnd", offsetMonths: 0 },
        endInclusive: false,
      },
    };
    const before = withCost(withCost(plan, cost), other);
    expect(planMentions(before, ROBIN.id)).toBe(true);
    const after = planWithoutDependent(before, ROBIN);
    expect(after.expenses.some((x) => x.id === cost.id)).toBe(false);
    expect(after.expenses.find((x) => x.id === "exp-other")!.range.start).toEqual({
      kind: "date",
      date: "2035-05",
      offsetMonths: 2,
    });
    expect(planMentions(after, ROBIN.id)).toBe(false);
    expect(after.expenses.length).toBe(plan.expenses.length + 1);
  });

  it("knows when an age range is already over", () => {
    expect(alreadyPast(ROBIN, 5, "2026-11")).toBe(true);
    expect(alreadyPast(ROBIN, 18, "2026-11")).toBe(false);
  });
});

// ------------------------------------------------------------------------------- component

function renderPanel() {
  const Harness = () => {
    const doc = useEditorStore((s) => s.draft)!;
    const ref = doc.plans.find((p) => p.isMain);
    return <DependentCosts dependent={doc.household.dependents[0]!} doc={doc} refPlan={ref} />;
  };
  const root = createRootRoute({ component: Harness });
  const plan = createRoute({ getParentRoute: () => root, path: "/plans/$planId" });
  const router = createRouter({
    routeTree: root.addChildren([plan]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe("Add a cost (About you)", () => {
  beforeEach(() => {
    resetEditorStore();
    loadDocument(createSampleDocument(), "sample");
  });

  const costsIn = () =>
    useEditorStore
      .getState()
      .draft!.plans.map((p) => p.expenses.filter((e) => e.dependentId === "dep-robin").length);

  it("asks for an amount instead of filling one in, then adds the cost to every plan in one undo step", async () => {
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: /Add a cost/ }));
    const dialog = await screen.findByRole("dialog", { name: "Add a cost for Robin" });
    const amount = within(dialog).getByLabelText("Amount");
    expect((amount as HTMLInputElement).value).toBe("");

    fireEvent.click(within(dialog).getByRole("radio", { name: "College" }));
    expect((within(dialog).getByLabelText("Name") as HTMLInputElement).value).toBe(
      "Robin’s college",
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Add cost" }));
    expect(within(dialog).getByText("Enter how much this costs.")).toBeTruthy();
    expect(costsIn()).toEqual([0, 0]);

    fireEvent.change(amount, { target: { value: "15000" } });
    fireEvent.click(within(dialog).getByRole("radio", { name: "All 2 plans" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Add cost" }));

    expect(costsIn()).toEqual([1, 1]);
    const added = useEditorStore
      .getState()
      .draft!.plans[0]!.expenses.find((e) => e.dependentId === "dep-robin")!;
    expect(added).toMatchObject({
      type: "education",
      amount: { value: 15_000, basis: "real" },
      frequency: "yearly",
      range: { start: { kind: "dependentAge", age: 18 }, end: { kind: "dependentAge", age: 22 } },
    });

    // Listed under the dependant, for every plan.
    const list = await screen.findByRole("list", { name: "Costs for Robin" });
    expect(within(list).getByText("Robin’s college")).toBeTruthy();
    expect(list.textContent).toMatch(/ages 18–22 · All plans/);

    undo();
    expect(costsIn()).toEqual([0, 0]);
  });

  it("adds to this plan only by default", async () => {
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: /Add a cost/ }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Amount"), { target: { value: "800" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add cost" }));
    const main = useEditorStore.getState().draft!.plans.findIndex((p) => p.isMain);
    expect(costsIn()[main]).toBe(1);
    expect(costsIn().reduce((a, b) => a + b, 0)).toBe(1);
  });
});
