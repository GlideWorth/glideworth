/**
 * Long-term-care expense type and bonus as a percentage of a linked salary. All inputs are
 * synthetic; flat 0% tax and zero returns unless stated (see engine-helpers).
 */
import { describe, expect, it } from "vitest";
import { ScenarioError, simulate } from "../src/index.js";
import { auditAssumptions } from "../src/insights/audit.js";
import { explainYear } from "../src/insights/explain.js";
import { careerBreakScenario, longTermCareScenario } from "../src/insights/scenarios.js";
import { ExpenseEvent, IncomeEvent } from "../src/schema/events.js";
import type { ExpenseEventInput, IncomeEventInput } from "../src/schema/events.js";
import { applyPlanPatch } from "../src/insights/patch.js";
import { SimulationInput } from "../src/engine/types.js";
import { createSampleDocument } from "../src/samples/index.js";
import { migrateDocument, SCHEMA_VERSION } from "../src/schema/document.js";
import { acct, always, between, expectInvariants, flatTax, period, sim } from "./engine-helpers.js";

const cash = acct("c", "cash", 0);

const income = (over: Record<string, unknown>): IncomeEventInput =>
  ({
    id: "i",
    type: "other",
    name: "Income",
    owner: "me",
    amount: { value: 1_000 },
    frequency: "yearly",
    range: always,
    ...over,
  }) as IncomeEventInput;

const expense = (over: Record<string, unknown>): ExpenseEventInput =>
  ({
    id: "e",
    type: "living",
    name: "Expense",
    owner: "me",
    amount: { value: 5_000 },
    frequency: "yearly",
    range: always,
    ...over,
  }) as ExpenseEventInput;

const salary = (over: Record<string, unknown> = {}) =>
  income({ id: "sal", type: "salary", name: "Salary", amount: { value: 60_000 }, ...over });
const bonus = (over: Record<string, unknown> = {}) =>
  income({
    id: "bon",
    type: "bonus",
    name: "Bonus",
    amount: { value: 0 },
    percentOfSalary: { salaryIncomeId: "sal", rate: 0.1 },
    ...over,
  });

const bonusIn = (r: ReturnType<typeof simulate>, year: number) =>
  period(r, year)
    .income.filter((l) => l.sourceId === "bon")
    .reduce((s, l) => s + l.amount, 0);

describe("long-term-care expense type", () => {
  it("parses with the common expense defaults", () => {
    const e = ExpenseEvent.parse(expense({ type: "long-term-care", name: "Care home" }));
    expect(e.type).toBe("long-term-care");
    expect(e.spendingType).toBe("essential");
  });

  it("is an expense line in its own category", () => {
    const r = simulate(
      sim({
        accounts: [acct("c", "cash", 100_000)],
        plan: { expenses: [expense({ type: "long-term-care" })] },
        years: 1,
      }),
    );
    const line = period(r, 2027).expenses.find((l) => l.sourceId === "e")!;
    expect(line.category).toBe("long-term-care");
    expect(line.requested).toBeCloseTo(5_000, 6);
    expectInvariants(r);
  });

  it("starts at an age (DateRef) and costs nothing before", () => {
    const r = simulate(
      sim({
        accounts: [acct("c", "cash", 100_000)],
        births: ["1950-01"],
        plan: {
          expenses: [
            expense({
              type: "long-term-care",
              range: {
                start: { kind: "age", personId: "me", age: 78 },
                end: { kind: "planEnd" },
              },
            }),
          ],
        },
        years: 3,
      }),
    );
    expect(period(r, 2027).totals.expenses).toBe(0);
    expect(period(r, 2028).totals.expenses).toBeCloseTo(5_000, 6);
  });

  it("is paid from an HSA tax-free like healthcare (qualified medical use)", () => {
    const run = (type: string) =>
      simulate(
        sim({
          accounts: [acct("c", "cash", 100_000), acct("hsa", "hsa", 10_000)],
          plan: {
            tax: flatTax(0.2),
            expenses: [
              expense({ type, payFrom: { kind: "accounts", accountIds: ["hsa"] } }) as never,
            ],
          },
          years: 1,
        }),
      );
    const taxes = (r: ReturnType<typeof simulate>) => period(r, 2027).taxes.total;
    expect(taxes(run("long-term-care"))).toBeCloseTo(taxes(run("healthcare")), 6);
    expect(taxes(run("long-term-care"))).toBeCloseTo(0, 6);
  });

  it("the what-if template adds a long-term-care expense at healthcare inflation", () => {
    const input = SimulationInput.parse(
      sim({
        births: ["1960-01"],
        plan: { assumptions: { healthcareInflationPremium: 0.025 } as never },
      }),
    );
    const t = longTermCareScenario(input, { fromAge: 85, annualCost: 40_000, years: 3 });
    const plan = applyPlanPatch(input.plan, t.patch);
    const added = plan.expenses.at(-1)!;
    expect(added.type).toBe("long-term-care");
    expect(added.change).toEqual({ kind: "inflation", plus: 0.025 });
    expect(added.range.start).toMatchObject({ kind: "age", personId: "me", age: 85 });
  });

  it("counts as late-life care in the audit", () => {
    const input = SimulationInput.parse(
      sim({
        births: ["1960-01"],
        plan: {
          expenses: [
            expense({
              type: "long-term-care",
              name: "Facility",
              range: {
                start: { kind: "age", personId: "me", age: 85 },
                end: { kind: "planEnd" },
              },
            }),
          ],
        },
        years: 40,
      }),
    );
    const codes = auditAssumptions(input).map((f) => f.code);
    expect(codes).not.toContain("LATE_LIFE_CARE_MISSING");
  });
});

describe("bonus as a percentage of a salary", () => {
  it("parses a fixed bonus unchanged and a percentage bonus with its link", () => {
    expect(IncomeEvent.parse(income({ type: "bonus" }))).not.toHaveProperty("percentOfSalary");
    const b = IncomeEvent.parse(bonus());
    expect(b.type === "bonus" && b.percentOfSalary).toEqual({ salaryIncomeId: "sal", rate: 0.1 });
    expect(() =>
      IncomeEvent.parse(bonus({ percentOfSalary: { salaryIncomeId: "sal", rate: -0.1 } })),
    ).toThrow();
  });

  it("is the rate times that year's salary after the salary's own growth", () => {
    const r = simulate(
      sim({
        accounts: [cash],
        plan: {
          income: [salary({ change: { kind: "rate", rate: 0.05 } }), bonus()],
        },
        years: 3,
      }),
    );
    expect(bonusIn(r, 2027)).toBeCloseTo(6_000, 6);
    expect(bonusIn(r, 2028)).toBeCloseTo(6_300, 6);
    expect(bonusIn(r, 2029)).toBeCloseTo(6_615, 6);
    expectInvariants(r);
  });

  it("ignores the bonus's own amount, change and currency", () => {
    const r = simulate(
      sim({
        accounts: [cash],
        plan: {
          income: [
            salary(),
            bonus({ amount: { value: 99_999 }, change: { kind: "rate", rate: 0.5 } }),
          ],
        },
        years: 2,
      }),
    );
    expect(bonusIn(r, 2028)).toBeCloseTo(6_000, 6);
  });

  it("is 0 before the salary starts and after it ends; pro rata in a part year", () => {
    const r = simulate(
      sim({
        accounts: [cash],
        plan: {
          income: [salary({ range: between("2028-07", "2030-01") }), bonus()],
        },
        years: 4,
      }),
    );
    expect(bonusIn(r, 2027)).toBe(0);
    expect(bonusIn(r, 2028)).toBeCloseTo(3_000, 6);
    expect(bonusIn(r, 2029)).toBeCloseTo(6_000, 6);
    expect(bonusIn(r, 2030)).toBe(0);
  });

  it("follows the bonus's own timing and recurrence", () => {
    const r = simulate(
      sim({
        accounts: [cash],
        plan: {
          income: [
            salary(),
            bonus({
              frequency: "once",
              range: { start: { kind: "date", date: "2027-03" }, end: { kind: "never" } },
              recurrence: { yearsBetween: 2, scalingRate: 0, until: { kind: "planEnd" } },
            }),
          ],
        },
        years: 4,
      }),
    );
    expect(bonusIn(r, 2027)).toBeCloseTo(6_000, 6);
    expect(bonusIn(r, 2028)).toBe(0);
    expect(bonusIn(r, 2029)).toBeCloseTo(6_000, 6);
  });

  it("a part-year bonus range is prorated like a fixed bonus", () => {
    const r = simulate(
      sim({
        accounts: [cash],
        plan: { income: [salary(), bonus({ range: between("2027-01", "2027-07") })] },
        years: 1,
      }),
    );
    expect(bonusIn(r, 2027)).toBeCloseTo(3_000, 6);
  });

  it("is taxed like any other bonus", () => {
    const run = (b: IncomeEventInput) =>
      simulate(
        sim({ accounts: [cash], plan: { tax: flatTax(0.2), income: [salary(), b] }, years: 1 }),
      );
    const pct = run(bonus());
    const fixed = run(income({ id: "bon", type: "bonus", amount: { value: 6_000 } }));
    expect(period(pct, 2027).taxes.total).toBeCloseTo(period(fixed, 2027).taxes.total, 6);
  });

  it("explain_year shows how the bonus was derived", () => {
    const input = SimulationInput.parse(
      sim({ accounts: [cash], plan: { income: [salary(), bonus()] }, years: 1 }),
    );
    const r = simulate(input);
    const ev = explainYear(input, r, 0).evidence.find(
      (e) => e.source === "trace" && (e as { code?: string }).code === "BONUS_FROM_SALARY",
    ) as { message: string } | undefined;
    expect(ev?.message).toMatch(/10(\.0)?% of Salary/);
  });

  it.each([
    ["a missing income", "nope"],
    ["a non-salary income", "oth"],
    ["itself", "bon"],
  ])("rejects a link to %s with a ScenarioError", (_what, target) => {
    expect(() =>
      simulate(
        sim({
          accounts: [cash],
          plan: {
            income: [
              salary(),
              income({ id: "oth" }),
              bonus({ percentOfSalary: { salaryIncomeId: target, rate: 0.1 } }),
            ],
          },
        }),
      ),
    ).toThrow(ScenarioError);
  });
});

describe("bonus as a percentage of a salary: what-ifs", () => {
  it("a career break scales the salary once, and the bonus follows it", () => {
    const input = SimulationInput.parse(
      sim({ accounts: [cash], plan: { income: [salary(), bonus()] }, years: 2 }),
    );
    const t = careerBreakScenario(input, {
      personId: "me",
      start: "2028-01",
      months: 12,
      share: 0.5,
    });
    expect(t.patch.map((op) => op.path)).toEqual(["/income/[id=sal]/partTime"]);
    const r = simulate({ ...input, plan: applyPlanPatch(input.plan, t.patch) });
    expect(bonusIn(r, 2028)).toBeCloseTo(3_000, 6);
  });
});

describe("schema 4 -> 5", () => {
  it("is the current version", () => {
    expect(SCHEMA_VERSION).toBe(5);
  });

  it("a version 4 document loads unchanged", () => {
    const current = createSampleDocument();
    const v4 = { ...JSON.parse(JSON.stringify(current)), schemaVersion: 4 };
    expect(migrateDocument(v4)).toEqual(current);
  });

  it("refuses a document newer than the current version", () => {
    const newer = {
      ...JSON.parse(JSON.stringify(createSampleDocument())),
      schemaVersion: SCHEMA_VERSION + 1,
    };
    expect(() => migrateDocument(newer)).toThrow(/newer than supported/);
  });
});
