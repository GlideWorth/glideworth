import { ExpenseEvent, IncomeEvent } from "@glideworth/core";
import { createUkSampleDocument } from "@glideworth/core/samples";
import { describe, expect, it } from "vitest";
import { eventFigureRejected, replaceEventType } from "../src/features/plan-editor/sections/events";
import { newExpense, newIncome } from "../src/features/plan-editor/state/defaults";
import { INCOME_TYPES } from "../src/features/plan-editor/state/labels";
import {
  nextBonusRate,
  sourceOptionLabel,
  uniqueEventName,
} from "../src/features/plan-editor/state/event-edit";

const doc = createUkSampleDocument();
const ctx = { household: doc.household, finances: doc.finances };
const plan = doc.plans[0]!;

describe("adding and retitling income", () => {
  it("lists Bonus immediately after Salary", () => {
    const order = INCOME_TYPES.map((t) => t.value);
    expect(order[order.indexOf("salary") + 1]).toBe("bonus");
  });

  it("turns an untouched salary into a bonus with its own name and amount", () => {
    const salary = newIncome("salary", ctx, plan);
    expect(salary.name).toBe("Sam's salary");
    expect(salary.amount.value).toBe(45_000);
    const bonus = replaceEventType("income", salary, "bonus", ctx, plan, [salary.name]);
    expect(bonus.type).toBe("bonus");
    expect(bonus.id).toBe(salary.id);
    expect(bonus.name).toBe("Annual bonus");
    expect(bonus.amount.value).toBe(5_000);
  });

  it("keeps a name or amount the user has edited", () => {
    const salary = newIncome("salary", ctx, plan);
    const renamed = IncomeEvent.parse({ ...salary, name: "Contract" });
    expect(replaceEventType("income", renamed, "bonus", ctx, plan, []).name).toBe("Contract");
    const repriced = IncomeEvent.parse({
      ...salary,
      amount: { value: 80_000, basis: "real" },
    });
    const next = replaceEventType("income", repriced, "bonus", ctx, plan, []);
    expect(next.name).toBe("Annual bonus");
    expect(next.amount.value).toBe(80_000);
  });

  it("does not add a second event with a name that already exists", () => {
    expect(uniqueEventName("Sam's salary", ["Sam's salary"])).toBe("Sam's salary (2)");
    expect(uniqueEventName("Sam's salary", ["Sam's salary", "Sam's salary (2)"])).toBe(
      "Sam's salary (3)",
    );
    expect(uniqueEventName("Annual bonus", [])).toBe("Annual bonus");
  });

  it("labels two salaries of the same name apart in the bonus source list", () => {
    const peers = [
      { id: "sal-aaaa", name: "Sam's salary", detail: "£45,000" },
      { id: "sal-bbbb", name: "Sam's salary", detail: "£45,000" },
      { id: "sal-cccc", name: "Other", detail: "£10,000" },
    ];
    const labels = peers.map((p) => sourceOptionLabel(p.id, p.name, p.detail, peers));
    expect(labels[2]).toBe("Other");
    expect(labels[0]).not.toBe(labels[1]);
    expect(new Set(labels).size).toBe(3);
  });
});

describe("figures a field rejects", () => {
  it("does not treat 150% of salary as invalid, and does reject 1,000,000%", () => {
    const salary = newIncome("salary", ctx, plan);
    const bonus = newIncome("bonus", ctx, plan);
    const ok = IncomeEvent.parse({
      ...bonus,
      percentOfSalary: { salaryIncomeId: salary.id, rate: 1.5 },
    });
    expect(eventFigureRejected("income", ok)).toBe(false);
    const huge = {
      ...bonus,
      percentOfSalary: { salaryIncomeId: salary.id, rate: 10_000 },
    };
    expect(eventFigureRejected("income", huge)).toBe(true);
  });

  it("rejects a negative expense amount", () => {
    const expense = newExpense("living", ctx);
    expect(eventFigureRejected("expense", expense)).toBe(false);
    const negative = ExpenseEvent.parse({
      ...expense,
      amount: { value: 0, basis: "real" },
    });
    expect(eventFigureRejected("expense", negative)).toBe(false);
    expect(
      eventFigureRejected("expense", { ...expense, amount: { value: -100, basis: "real" } }),
    ).toBe(true);
  });

  it("does not turn an empty bonus percentage into zero", () => {
    expect(nextBonusRate(0.1, null)).toBe(0.1);
    expect(nextBonusRate(0.1, 0)).toBe(0);
    expect(nextBonusRate(0.1, 1.5)).toBe(1.5);
  });
});
