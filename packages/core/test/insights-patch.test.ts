import { describe, expect, it } from "vitest";
import {
  applyPatch,
  applyPatchWithInverse,
  applyPlanPatch,
  applyPlanPatchWithInverse,
  createBranch,
  createRng,
  deepEqual,
  detachBranch,
  diffJson,
  diffPlans,
  financeNames,
  formatPointer,
  invertPatch,
  materializePlan,
  mergeBranchIntoParent,
  PatchConflictError,
  type PatchOp,
  PLAN_META_KEYS,
  Plan,
  parsePointer,
  ScenarioError,
  updateBranch,
  ValidationError,
} from "../src/index.js";
import { createSampleDocument } from "../src/samples/index.js";

const doc = createSampleDocument();
const main = doc.plans.find((p) => p.id === "plan-main")!;
const early = doc.plans.find((p) => p.id === "plan-early")!;

function stripMeta(p: Plan): Record<string, unknown> {
  const o: Record<string, unknown> = { ...p };
  for (const k of PLAN_META_KEYS) delete o[k];
  return o;
}

describe("pointer", () => {
  it("parses and formats id segments and RFC 6901 escapes", () => {
    const segs = parsePointer("/income/[id=sal-1]/a~1b/c~0d/0");
    expect(segs).toEqual([
      { kind: "key", key: "income" },
      { kind: "id", id: "sal-1" },
      { kind: "key", key: "a/b" },
      { kind: "key", key: "c~d" },
      { kind: "key", key: "0" },
    ]);
    expect(formatPointer(segs)).toBe("/income/[id=sal-1]/a~1b/c~0d/0");
  });
});

describe("applyPatch (RFC 6902 + [id=])", () => {
  const base = {
    a: 1,
    list: [
      { id: "x", v: 1 },
      { id: "y", v: 2 },
    ],
    tags: ["p", "q"],
  };

  it("implements add/remove/replace/move/test", () => {
    const out = applyPatch(base, [
      { op: "test", path: "/a", value: 1 },
      { op: "replace", path: "/list/[id=y]/v", value: 20 },
      { op: "add", path: "/list/-", value: { id: "z", v: 3 } },
      { op: "add", path: "/list/0", value: { id: "w", v: 0 } },
      { op: "remove", path: "/tags/0" },
      { op: "add", path: "/b", value: { c: true } },
      { op: "move", from: "/list/[id=z]", path: "/list/1" },
      { op: "add", path: "/list/[id=n]", value: { id: "n", v: 9 } },
    ]);
    expect(out).toEqual({
      a: 1,
      b: { c: true },
      list: [
        { id: "w", v: 0 },
        { id: "z", v: 3 },
        { id: "x", v: 1 },
        { id: "y", v: 20 },
        { id: "n", v: 9 },
      ],
      tags: ["q"],
    });
    // input untouched
    expect(base.list).toHaveLength(2);
  });

  it("throws PatchConflictError for missing targets, failed tests and duplicate ids", () => {
    expect(() => applyPatch(base, [{ op: "remove", path: "/list/[id=nope]" }])).toThrow(
      PatchConflictError,
    );
    expect(() => applyPatch(base, [{ op: "test", path: "/a", value: 2 }])).toThrow(
      PatchConflictError,
    );
    expect(() =>
      applyPatch(base, [{ op: "add", path: "/list/[id=x]", value: { id: "x" } }]),
    ).toThrow(PatchConflictError);
    expect(() => applyPatch(base, [{ op: "replace", path: "/zzz", value: 1 }])).toThrow(
      PatchConflictError,
    );
    expect(() => applyPatch(base, [{ op: "add", path: "/list/7", value: {} }])).toThrow(
      PatchConflictError,
    );
    expect(() => applyPatch(base, [{ op: "move", from: "/list", path: "/list/0" }])).toThrow(
      PatchConflictError,
    );
    try {
      applyPatch(base, [{ op: "remove", path: "/nope" }]);
      expect.unreachable();
    } catch (e) {
      expect((e as PatchConflictError).code).toBe("PATCH_CONFLICT");
      expect((e as PatchConflictError).details?.opIndex).toBe(0);
    }
  });

  it("produces exact inverses, including array positions and displaced members", () => {
    const ops: PatchOp[] = [
      { op: "remove", path: "/list/[id=x]" },
      { op: "add", path: "/list/0", value: { id: "k", v: 5 } },
      { op: "replace", path: "/a", value: 42 },
      { op: "add", path: "/a2", value: 1 },
      { op: "move", from: "/a2", path: "/a" },
      { op: "move", from: "/list/[id=k]", path: "/list/1" },
      { op: "remove", path: "/tags/1" },
    ];
    const { result, inverse } = applyPatchWithInverse(base, ops);
    expect(applyPatch(result, inverse)).toEqual(base);
    // Redo = ops again.
    expect(applyPatch(applyPatch(result, inverse), ops)).toEqual(result);
  });
});

describe("applyPlanPatch", () => {
  it("validates the patched plan", () => {
    const p = applyPlanPatch(main, [
      { op: "replace", path: "/income/[id=inc-avery-salary]/amount/value", value: 90_000 },
    ]);
    expect(p.income.find((i) => i.id === "inc-avery-salary")!.amount.value).toBe(90_000);
    expect(() =>
      applyPlanPatch(main, [
        { op: "replace", path: "/income/[id=inc-avery-salary]/frequency", value: "fortnightly" },
      ]),
    ).toThrow(ValidationError);
  });

  it("returns an inverse for undo", () => {
    const ops: PatchOp[] = [
      { op: "remove", path: "/expenses/[id=exp-travel]" },
      { op: "replace", path: "/assumptions/inflation", value: { kind: "fixed", rate: 0.02 } },
    ];
    const { plan, inverse } = applyPlanPatchWithInverse(main, ops);
    expect(plan.expenses.some((e) => e.id === "exp-travel")).toBe(false);
    expect(applyPlanPatch(plan, inverse)).toEqual(main);
  });
});

describe("diffPlans", () => {
  it("describes a retirement-age change in plain English", () => {
    const d = diffPlans(main, early);
    expect(d.basePlanId).toBe("plan-main");
    expect(d.changes.map((c) => c.description)).toContain("Retirement moved from age 57 to 52");
    const name = d.changes.find((c) => c.path === "/name")!;
    expect(name.description).toBe('Plan renamed from "Main plan" to "Retire at 52"');
    expect(stripMeta(applyPlanPatch(main, d.patch))).toEqual(stripMeta(early));
  });

  it("describes an added one-off expense with currency", () => {
    const other = applyPlanPatch(main, [
      {
        op: "add",
        path: "/expenses/-",
        value: {
          id: "exp-kitchen",
          type: "other",
          name: "Kitchen refit",
          owner: "joint",
          amount: { value: 25_000 },
          frequency: "once",
          range: { start: { kind: "date", date: "2031-04" }, end: { kind: "never" } },
        },
      },
    ]);
    const d = diffPlans(main, other, { currency: "GBP", locale: "en-GB" });
    expect(d.changes).toHaveLength(1);
    expect(d.changes[0]!.kind).toBe("added");
    expect(d.changes[0]!.entity).toEqual({
      type: "expense",
      id: "exp-kitchen",
      name: "Kitchen refit",
    });
    expect(d.changes[0]!.description).toBe("Added expense: Kitchen refit £25,000 in Apr 2031");
    expect(d.patch).toEqual([{ op: "add", path: "/expenses/-", value: other.expenses.at(-1) }]);
  });

  it("describes amount, assumption, removal and flow priority changes", () => {
    const other = applyPlanPatch(main, [
      { op: "replace", path: "/income/[id=inc-avery-salary]/amount/value", value: 140_000 },
      { op: "replace", path: "/assumptions/stockReturn", value: { kind: "fixed", rate: 0.05 } },
      { op: "remove", path: "/expenses/[id=exp-car]" },
      { op: "move", from: "/flows/[id=fl-taxable]", path: "/flows/0" },
      { op: "replace", path: "/expenses/[id=exp-travel]/enabled", value: false },
    ]);
    const d = diffPlans(main, other, { currency: "USD", locale: "en-US" });
    const descs = d.changes.map((c) => c.description);
    expect(descs).toContain("Avery salary changed from $132,000 to $140,000 a year");
    expect(descs).toContain("Stock return assumption changed from 6% to 5%");
    expect(descs).toContain("Removed expense: Replacement car");
    expect(descs).toContain("Travel disabled");
    expect(descs).toContain("Invest the rest moved to priority 1");
    expect(stripMeta(applyPlanPatch(main, d.patch))).toEqual(stripMeta(other));
  });

  it("is empty for identical plans and ignores identity fields", () => {
    const copy = Plan.parse({ ...structuredClone(main), id: "other", version: 7, isMain: false });
    const d = diffPlans(main, copy);
    expect(d.patch).toEqual([]);
    expect(d.changes).toEqual([]);
  });
});

// ------------------------------------------------------------------------------------------------
// Property tests: random edits -> diff -> patch -> apply round-trips; inverse round-trips.
// ------------------------------------------------------------------------------------------------

function randomEdit(plan: Plan, rng: ReturnType<typeof createRng>, n: number): Plan {
  const p = structuredClone(plan) as Plan;
  const pick = <T>(xs: T[]): T | undefined =>
    xs.length ? xs[Math.floor(rng.next() * xs.length)] : undefined;
  const edits = [
    () => {
      const e = pick(p.expenses);
      if (e) e.amount.value = Math.round(rng.next() * 50_000);
    },
    () => {
      const i = Math.floor(rng.next() * p.expenses.length);
      p.expenses.splice(i, 1);
    },
    () => {
      p.expenses.splice(Math.floor(rng.next() * (p.expenses.length + 1)), 0, {
        ...structuredClone(p.expenses[0] ?? main.expenses[0]!),
        id: `x-${n}-${Math.floor(rng.next() * 1e6)}`,
        name: `Random ${n}`,
      });
    },
    () => {
      if (p.flows.length > 1) {
        const [f] = p.flows.splice(Math.floor(rng.next() * p.flows.length), 1);
        p.flows.splice(Math.floor(rng.next() * (p.flows.length + 1)), 0, f!);
      }
    },
    () => {
      p.assumptions.inflation = { kind: "fixed", rate: Math.round(rng.next() * 60) / 1000 };
    },
    () => {
      const m = pick(p.milestones.filter((x) => x.criteria[0]?.kind === "age"));
      const c = m?.criteria[0];
      if (c && c.kind === "age") c.age = 50 + Math.floor(rng.next() * 20);
    },
    () => {
      p.description = rng.next() < 0.5 ? undefined : `d${n}`;
    },
    () => {
      p.excludedIds = rng.next() < 0.5 ? [] : ["acc-hsa"];
    },
    () => {
      const inc = pick(p.income);
      if (inc)
        inc.range.end =
          rng.next() < 0.5
            ? { kind: "planEnd", offsetMonths: 0 }
            : { kind: "age", personId: "p-avery", age: 60, offsetMonths: 0 };
    },
    () => {
      p.accountSettings = rng.next() < 0.5 ? {} : { "acc-brokerage": { isExcessCash: true } };
    },
  ];
  const count = 1 + Math.floor(rng.next() * 5);
  for (let k = 0; k < count; k++) pick(edits)!();
  return Plan.parse(p);
}

describe("round-trip properties", () => {
  it("diff -> patch -> apply reproduces the target; inverse restores the base (300 random cases)", () => {
    const rng = createRng(20261115);
    for (let n = 0; n < 300; n++) {
      const a = rng.next() < 0.3 ? randomEdit(main, rng, n) : main;
      const b = randomEdit(a, rng, n + 1000);
      const d = diffPlans(a, b);
      const applied = applyPlanPatch(a, d.patch);
      expect(deepEqual(stripMeta(applied), stripMeta(b))).toBe(true);
      const { plan, inverse } = applyPlanPatchWithInverse(a, d.patch);
      expect(deepEqual(applyPlanPatch(plan, inverse), a)).toBe(true);
      // every change has a description and the diff of a plan with itself is empty
      for (const c of d.changes) expect(c.description.length).toBeGreaterThan(3);
      expect(diffJson(b, b)).toEqual([]);
      // inverse patch is itself invertible back to the forward result
      expect(deepEqual(applyPatch(applyPatch(a, d.patch), invertPatch(a, d.patch)), a)).toBe(true);
    }
  });
});

describe("branching", () => {
  const lookupFrom = (plans: Plan[]) => (id: string) => plans.find((p) => p.id === id);

  it("creates a branch that stores only its patch and materialises from the parent", () => {
    const branch = createBranch(main, {
      id: "plan-b",
      name: "Kitchen",
      patch: [{ op: "replace", path: "/expenses/[id=exp-living]/amount/value", value: 6_000 }],
    });
    expect(branch.lineage?.parentPlanId).toBe("plan-main");
    expect(branch.lineage?.patch).toEqual([
      { op: "replace", path: "/name", value: "Kitchen" },
      { op: "replace", path: "/expenses/[id=exp-living]/amount/value", value: 6_000 },
    ]);
    const m = materializePlan(branch, lookupFrom([main]));
    expect(m.id).toBe("plan-b");
    expect(m.isMain).toBe(false);
    expect(m.expenses.find((e) => e.id === "exp-living")!.amount.value).toBe(6_000);
  });

  it("inherits later parent edits (follow-latest) unless the branch overrides them", () => {
    const branch = createBranch(main, {
      id: "plan-b",
      name: "Lower spend",
      patch: [{ op: "replace", path: "/expenses/[id=exp-living]/amount/value", value: 4_000 }],
    });
    const parent2 = applyPlanPatch(main, [
      { op: "replace", path: "/assumptions/inflation", value: { kind: "fixed", rate: 0.04 } },
      { op: "replace", path: "/expenses/[id=exp-living]/amount/value", value: 5_500 },
    ]);
    const m = materializePlan(branch, lookupFrom([parent2]));
    expect(m.assumptions.inflation).toEqual({ kind: "fixed", rate: 0.04 });
    expect(m.expenses.find((e) => e.id === "exp-living")!.amount.value).toBe(4_000);
  });

  it("supports multi-level lineage, pinned versions and detects cycles and missing parents", () => {
    const b1 = createBranch(main, {
      id: "b1",
      name: "B1",
      patch: [{ op: "remove", path: "/expenses/[id=exp-car]" }],
    });
    const b2 = createBranch(materializePlan(b1, lookupFrom([main])), {
      id: "b2",
      name: "B2",
      pin: true,
    });
    expect(b2.lineage?.parentVersion).toBe(0);
    const seen: (number | null)[] = [];
    const m = materializePlan(b2, (id, v) => {
      seen.push(v);
      return [main, b1].find((p) => p.id === id);
    });
    expect(m.expenses.some((e) => e.id === "exp-car")).toBe(false);
    expect(seen).toEqual([0, null]);
    const cyc = { ...b1, lineage: { parentPlanId: "b1", parentVersion: null, patch: [] } } as Plan;
    expect(() => materializePlan(cyc, lookupFrom([cyc]))).toThrow(ScenarioError);
    expect(() => materializePlan(b1, () => undefined)).toThrow(ScenarioError);
  });

  it("re-derives the lineage patch after an edit, merges into the parent and detaches", () => {
    const branch = createBranch(main, { id: "b", name: "B" });
    const edited = applyPlanPatch(branch, [{ op: "remove", path: "/expenses/[id=exp-travel]" }]);
    const updated = updateBranch(branch, edited, main);
    expect(updated.lineage!.patch).toEqual([
      { op: "replace", path: "/name", value: "B" },
      { op: "remove", path: "/expenses/[id=exp-travel]" },
    ]);
    const merged = mergeBranchIntoParent(main, updated);
    expect(merged.name).toBe("Main plan");
    expect(merged.expenses.some((e) => e.id === "exp-travel")).toBe(false);
    expect(detachBranch(updated).lineage).toBeUndefined();
  });

  it("reports a conflict when the parent removed what the branch edits", () => {
    const branch = createBranch(main, {
      id: "b",
      name: "B",
      patch: [{ op: "replace", path: "/expenses/[id=exp-car]/amount/value", value: 1 }],
    });
    const parent2 = applyPlanPatch(main, [{ op: "remove", path: "/expenses/[id=exp-car]" }]);
    expect(() => materializePlan(branch, lookupFrom([parent2]))).toThrow(PatchConflictError);
  });
});

describe("describing account settings in a plan diff", () => {
  // A real report: a what-if read "c2883250-… withdrawals changed from from to always" and "Plan overrides added for
  // account 78ec00a3-…": ids instead of names, and a withdrawal rule shown by its internal kind.
  const names = financeNames(doc.finances);
  const base = Plan.parse({
    ...main,
    accountSettings: {
      "acc-brokerage": {
        withdrawals: { kind: "from", ref: { kind: "milestone", milestoneId: "ms-retire" } },
      },
    },
  });
  const other = Plan.parse({
    ...base,
    accountSettings: {
      "acc-brokerage": { withdrawals: { kind: "always" } },
      "acc-cash": { withdrawals: { kind: "never" } },
    },
  });

  it("names accounts and says when withdrawals are allowed, once", () => {
    const d = diffPlans(base, other, { entities: names });
    const lines = d.changes.map((c) => c.description);
    expect(lines).toContain("Joint brokerage: withdrawals allowed any time (was from Retirement)");
    expect(lines).toContain(
      "Plan overrides added for account High-yield savings: withdrawals never",
    );
    expect(lines.filter((l) => l.startsWith("Joint brokerage"))).toHaveLength(1);
    expect(lines.join("\n")).not.toMatch(/acc-|from from/);
  });

  it("financeNames maps accounts, real assets and debts by id", () => {
    expect(names["acc-brokerage"]).toBe("Joint brokerage");
    for (const e of [...doc.finances.realAssets, ...doc.finances.debts])
      expect(names[e.id]).toBe(e.name);
  });
});
