import {
  ACCOUNT_TYPES,
  Account,
  buildSimulationInput,
  DEBT_TYPES,
  Debt,
  ExpenseEvent,
  Flow,
  IncomeEvent,
  Milestone,
  Plan,
  REAL_ASSET_TYPES,
  RealAsset,
  simulate,
} from "@glideworth/core";
import { createSampleDocument, createUkSampleDocument } from "@glideworth/core/samples";
import { beforeEach, describe, expect, it } from "vitest";
import { scoreCommand } from "../src/features/plan-editor/components/command-palette";
import {
  newAccount,
  newDebt,
  newExpense,
  newFlow,
  newIncome,
  newMilestone,
  newRealAsset,
} from "../src/features/plan-editor/state/defaults";
import {
  dirtyKeys,
  editHousehold,
  editMany,
  editPlan,
  getEntity,
  type HouseholdEntity,
  isDirty,
  addPlanToWorkspace,
  loadDocument,
  planKey,
  redo,
  removePlanFromWorkspace,
  resetEditorStore,
  syncFromServer,
  undo,
  useEditorStore,
} from "../src/features/plan-editor/state/doc-store";
import {
  addMonths,
  monthsToPayoff,
  netWorth,
  paymentFor,
  ukPensionLocked,
} from "../src/features/plan-editor/state/finance-math";
import { EXPENSE_TYPES, INCOME_TYPES } from "../src/features/plan-editor/state/labels";
import { deepEqual, merge3 } from "../src/features/plan-editor/state/merge";
import { resolveRef, timeContext } from "../src/features/plan-editor/state/resolve";
import { householdOps } from "../src/features/plan-editor/state/sync";
import { collectIssues, validate } from "../src/features/plan-editor/state/validation";
import { buildPlanFromTemplate, PLAN_TEMPLATES } from "../src/features/plans/templates";

const doc = createSampleDocument();
const ctx = { household: doc.household, finances: doc.finances };
const gbCtx = {
  household: { ...doc.household, location: { country: "GB" }, currency: "GBP", locale: "en-GB" },
  finances: doc.finances,
};

describe("three-way merge", () => {
  it("takes non-overlapping edits from both sides", () => {
    const base = { a: 1, b: 2, c: { d: 1 } };
    const mine = { a: 10, b: 2, c: { d: 1 } };
    const theirs = { a: 1, b: 20, c: { d: 1 } };
    expect(merge3(base, mine, theirs)).toEqual({
      value: { a: 10, b: 20, c: { d: 1 } },
      conflicts: [],
    });
  });
  it("keeps mine and reports conflicting paths", () => {
    const r = merge3({ a: 1 }, { a: 2 }, { a: 3 });
    expect(r.value).toEqual({ a: 2 });
    expect(r.conflicts).toEqual(["/a"]);
  });
  it("merges entity arrays by id: additions on both sides survive, deletes apply", () => {
    const base = {
      xs: [
        { id: "a", v: 1 },
        { id: "b", v: 1 },
      ],
    };
    const mine = {
      xs: [
        { id: "a", v: 2 },
        { id: "b", v: 1 },
        { id: "m", v: 1 },
      ],
    };
    const theirs = {
      xs: [
        { id: "a", v: 1 },
        { id: "t", v: 1 },
      ],
    }; // they deleted b, added t
    const r = merge3(base, mine, theirs);
    expect(r.conflicts).toEqual([]);
    expect(r.value.xs.map((x) => x.id)).toEqual(["a", "t", "m"]);
    expect(r.value.xs[0]).toEqual({ id: "a", v: 2 });
  });
  it("flags an item edited here but deleted there", () => {
    const r = merge3(
      { xs: [{ id: "a", v: 1 }] },
      { xs: [{ id: "a", v: 2 }] },
      { xs: [] as { id: string; v: number }[] },
    );
    expect(r.conflicts).toEqual(["/xs/[id=a]"]);
    expect(r.value.xs).toEqual([{ id: "a", v: 2 }]);
  });
  it("deepEqual ignores undefined keys", () => {
    expect(deepEqual({ a: 1, b: undefined }, { a: 1 })).toBe(true);
  });
});

describe("editor store: dirty tracking and undo/redo", () => {
  beforeEach(() => {
    resetEditorStore();
    loadDocument(createSampleDocument(), "sample");
  });
  const plan = () => useEditorStore.getState().draft!.plans[0]!;

  it("marks an edited plan dirty and clean again after undo", () => {
    editPlan(plan().id, (p) => ({ ...p, name: "Renamed" }), "Rename");
    expect(isDirty(useEditorStore.getState(), planKey(plan().id))).toBe(true);
    expect(undo()).toBe("Rename");
    expect(plan().name).toBe("Main plan");
    expect(dirtyKeys(useEditorStore.getState())).toEqual([]);
    redo();
    expect(plan().name).toBe("Renamed");
  });

  it("coalesces rapid edits of the same field into one undo step", () => {
    for (const n of ["M", "Ma", "Mai"])
      editPlan(plan().id, (p) => ({ ...p, name: n }), "Rename", "name");
    expect(useEditorStore.getState().past).toHaveLength(1);
    undo();
    expect(plan().name).toBe("Main plan");
  });

  it("skips no-op edits", () => {
    editPlan(plan().id, (p) => ({ ...p }), "Nothing");
    expect(useEditorStore.getState().past).toHaveLength(0);
  });

  it("undoes a multi-entity edit as one step", () => {
    const ids = useEditorStore.getState().draft!.plans.map((p) => p.id);
    editMany(
      [
        {
          key: "household",
          update: (v) => ({
            ...(v as HouseholdEntity),
            household: { ...(v as HouseholdEntity).household, name: "X" },
          }),
        },
        ...ids.map((id) => ({
          key: planKey(id),
          update: (v: unknown) => ({ ...(v as Plan), notes: "n" }),
        })),
      ],
      "Bulk",
    );
    expect(dirtyKeys(useEditorStore.getState())).toHaveLength(1 + ids.length);
    undo();
    expect(dirtyKeys(useEditorStore.getState())).toEqual([]);
  });

  it("household edits are entity-scoped", () => {
    editHousehold((h) => ({ ...h, finances: { ...h.finances, asOf: "2027-01" } }), "asOf");
    const s = useEditorStore.getState();
    expect(dirtyKeys(s)).toEqual(["household"]);
    expect((getEntity(s.draft!, "household") as HouseholdEntity).finances.asOf).toBe("2027-01");
  });
});

describe("a removed plan is not restored by a stale workspace document", () => {
  beforeEach(() => {
    resetEditorStore();
    loadDocument(createSampleDocument(), "api");
  });

  it("drops the plan and ignores a refetch that still contains it", () => {
    const id = useEditorStore.getState().draft!.plans[0]!.id;
    const stale = structuredClone(useEditorStore.getState().base!);
    removePlanFromWorkspace(id);
    syncFromServer(stale);
    expect(useEditorStore.getState().draft!.plans.map((p) => p.id)).not.toContain(id);
    expect(useEditorStore.getState().base!.plans.map((p) => p.id)).not.toContain(id);
  });

  it("keeps a plan added locally that the older document has not seen", () => {
    const before = structuredClone(useEditorStore.getState().base!);
    const src = useEditorStore.getState().draft!.plans[0]!;
    const extra = Plan.parse({
      ...structuredClone(src),
      id: "plan-local",
      name: "Local plan",
      isMain: false,
    });
    addPlanToWorkspace(extra);
    syncFromServer(before);
    expect(useEditorStore.getState().draft!.plans.some((p) => p.id === "plan-local")).toBe(true);
  });
});

describe("factories produce schema-valid entities for every type", () => {
  it("income", () => {
    for (const t of INCOME_TYPES)
      expect(IncomeEvent.safeParse(newIncome(t.value, gbCtx, doc.plans[0])).success, t.value).toBe(
        true,
      );
  });
  it("expenses", () => {
    for (const t of EXPENSE_TYPES)
      expect(ExpenseEvent.safeParse(newExpense(t.value, gbCtx)).success, t.value).toBe(true);
  });
  it("accounts, assets, debts", () => {
    for (const t of ACCOUNT_TYPES)
      expect(Account.safeParse(newAccount(t, gbCtx)).success, t).toBe(true);
    for (const t of REAL_ASSET_TYPES) {
      expect(RealAsset.safeParse(newRealAsset(t, gbCtx)).success, t).toBe(true);
      expect(RealAsset.safeParse(newRealAsset(t, gbCtx, true)).success, t).toBe(true);
    }
    for (const t of DEBT_TYPES) expect(Debt.safeParse(newDebt(t, gbCtx)).success, t).toBe(true);
  });
  it("flows and milestones", () => {
    for (const k of ["contribution", "debtPaydown", "transfer"] as const)
      expect(Flow.safeParse(newFlow(k, ctx, doc.plans[0])).success, k).toBe(true);
    for (const k of [
      "custom",
      "financial-independence",
      "debt-free",
      "retirement",
      "move",
    ] as const)
      expect(Milestone.safeParse(newMilestone(ctx, k)).success, k).toBe(true);
  });
  it("UK pensions default to UFPLS with 25% tax-free and access at 57", () => {
    const sipp = newAccount("uk-sipp", gbCtx);
    expect(sipp.behaviour.ukDrawdownMethod).toBe("ufpls");
    expect(sipp.behaviour.taxFreeWithdrawalShare).toBe(0.25);
    expect(sipp.behaviour.withdrawals).toEqual({ kind: "afterQualifiedAge" });
    expect(sipp.behaviour.earlyWithdrawal.qualifiedAge).toBe(57);
  });
});

describe("plan templates", () => {
  for (const t of PLAN_TEMPLATES) {
    it(`${t.id} builds a valid plan that simulates`, () => {
      const plan = buildPlanFromTemplate(t.id, gbCtx, { id: `plan-${t.id}`, name: t.name });
      expect(Plan.safeParse(plan).success).toBe(true);
      const d = { ...doc, household: gbCtx.household, plans: [plan] };
      const r = simulate({
        ...buildSimulationInput(d, plan.id),
        options: { ...buildSimulationInput(d, plan.id).options, strict: false },
      });
      expect(r.periods.length).toBeGreaterThan(10);
    });
  }
  it("each person's state pension is named for and starts at that person's State Pension age", () => {
    const plan = buildPlanFromTemplate("work-save-retire", gbCtx, { id: "p", name: "p" });
    const sp = plan.income.filter((i) => i.type === "state-pension");
    expect(sp).toHaveLength(2);
    for (const i of sp) {
      const person = gbCtx.household.people.find((p) => p.id === i.owner)!;
      expect(i.name).toContain(person.name);
      // Both are born after April 1978: 68 under the Pensions Act 2007 (not a flat 67).
      expect(i.range.start).toMatchObject({ kind: "age", personId: person.id, age: 68 });
    }
  });
  it("UK plans use the April tax year", () => {
    const plan = buildPlanFromTemplate("blank", gbCtx, { id: "p", name: "p" });
    expect(plan.assumptions.yearAlignment).toEqual({ kind: "fiscal", startMonth: 4 });
  });
});

describe("finance maths", () => {
  it("payoff months and payment are inverse", () => {
    const pay = paymentFor(200_000, 0.045, 300);
    expect(monthsToPayoff(200_000, 0.045, pay)).toBe(300);
    expect(monthsToPayoff(10_000, 0.12, 50)).toBeNull(); // payment below interest
    expect(monthsToPayoff(1200, 0, 100)).toBe(12);
  });
  it("net worth splits by category and subtracts loans and debts", () => {
    const nw = netWorth(doc.finances);
    expect(nw.netWorth).toBeCloseTo(nw.assets - nw.liabilities);
    expect(nw.byCategory["real-assets"]).toBe(585_000);
    expect(nw.liabilities).toBe(342_000 + 12_600);
  });
  it("keeps UK pensions out of liquid net worth before the minimum pension age (as the engine does)", () => {
    const uk = createUkSampleDocument();
    const pensions = uk.finances.accounts
      .filter((a) => ["uk-sipp", "uk-workplace-pension", "uk-pension"].includes(a.type))
      .reduce((s, a) => s + a.balance, 0);
    expect(pensions).toBeGreaterThan(0);
    const withRules = netWorth(uk.finances, uk.household);
    const naive = netWorth(uk.finances);
    expect(naive.liquid - withRules.liquid).toBeCloseTo(pensions);
    // Old enough: the pensions count again.
    const older = { people: uk.household.people.map((p) => ({ ...p, birthMonth: "1960-01" })) };
    expect(netWorth(uk.finances, older).liquid).toBeCloseTo(naive.liquid);
    expect(ukPensionLocked("1972-06", "2027-05")).toBe(true); // 54
    expect(ukPensionLocked("1972-06", "2027-06")).toBe(false); // 55, before April 2028
    expect(ukPensionLocked("1974-06", "2029-06")).toBe(true); // 55 after April 2028: needs 57
  });
  it("adds months across years", () => {
    expect(addMonths("2026-11", 3)).toBe("2027-02");
    expect(addMonths("2026-01", -1)).toBe("2025-12");
  });
});

describe("date resolution for the timeline", () => {
  it("resolves ages, milestones and plan bounds", () => {
    const plan = doc.plans[0]!;
    const t = timeContext(doc, plan);
    expect(resolveRef({ kind: "planStart", offsetMonths: 0 }, t)).toBe(2026 * 12 + 10);
    // Avery born 1984-03, age 57 → 2041-03
    expect(resolveRef({ kind: "milestone", milestoneId: "ms-retire", offsetMonths: 0 }, t)).toBe(
      2041 * 12 + 2,
    );
    expect(resolveRef({ kind: "age", personId: "p-avery", age: 60, offsetMonths: -6 }, t)).toBe(
      2044 * 12 + 2 - 6,
    );
    expect(resolveRef({ kind: "never" }, t)).toBeNull();
    expect(t.end).toBeGreaterThan(t.start + 12 * 40);
  });
});

describe("household save diff", () => {
  it("turns finance edits into per-item API operations", () => {
    const base = { household: doc.household, finances: doc.finances };
    const added = newAccount("uk-isa", gbCtx);
    const draft = {
      household: { ...doc.household, name: "New name" },
      finances: {
        ...doc.finances,
        asOf: "2027-01",
        accounts: [
          ...doc.finances.accounts
            .filter((a) => a.id !== "acc-hsa")
            .map((a) => (a.id === "acc-cash" ? { ...a, balance: 1 } : a)),
          added,
        ],
      },
    };
    const ops = householdOps(base, draft).map((o) => `${o.kind}:${o.id ?? ""}`);
    expect(ops).toEqual([
      "household:",
      "delete:acc-hsa",
      "replace:acc-cash",
      `create:${added.id}`,
      "asOf:",
    ]);
  });
});

describe("validation messages", () => {
  it("humanizes schema issues by path", () => {
    const bad = { ...doc.plans[0]!.income[0]!, name: "" };
    const issues = validate(IncomeEvent, bad);
    expect(issues.get("name")).toBe("Required");
    expect(collectIssues({ success: true }).count).toBe(0);
  });
});

describe("command palette search", () => {
  it("requires every token and ranks label prefixes first", () => {
    const isa = { label: "Add account: ISA", group: "Add to finances" };
    const income = { label: "Add income: Salary", group: "Add to plan" };
    expect(scoreCommand(isa, "isa")).toBeGreaterThan(0);
    expect(scoreCommand(income, "isa")).toBe(0);
    expect(scoreCommand({ label: "Income", group: "Plan sections" }, "inc")).toBeGreaterThan(
      scoreCommand(income, "inc"),
    );
  });
});
