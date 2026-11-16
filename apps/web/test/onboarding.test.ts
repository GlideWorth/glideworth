import { buildSimulationInput, GlideworthDocument, simulate } from "@glideworth/core";
import { describe, expect, it } from "vitest";
import {
  buildSetupDocument,
  defaultAnswers,
  type SetupAnswers,
  suggestedAccounts,
  validateAnswers,
} from "../src/features/onboarding/build-document";

const NOW = new Date(Date.UTC(2026, 10, 15));

function answers(over: Partial<SetupAnswers> = {}): SetupAnswers {
  return {
    ...defaultAnswers("GB", NOW),
    you: { name: "Robin", birthMonth: "1985-04" },
    accounts: [
      { key: "a", type: "savings", name: "Rainy day", balance: 12_000, owner: "me" },
      { key: "b", type: "uk-isa", name: "ISA", balance: 40_000, owner: "me" },
      { key: "c", type: "uk-workplace-pension", name: "Pension", balance: 85_000, owner: "me" },
    ],
    salary: { me: 52_000, partner: 0 },
    spending: { essential: 2_100, discretionary: 400, frequency: "monthly" },
    retirementAge: 60,
    lifeExpectancy: 93,
    planName: "Retire at 60",
    ...over,
  };
}

describe("guided setup → document", () => {
  it("builds a valid document with one main plan that simulates", () => {
    const doc = buildSetupDocument(answers(), { now: NOW });
    expect(GlideworthDocument.safeParse(doc).success).toBe(true);
    expect(doc.finances.asOf).toBe("2026-11");
    expect(doc.household.currency).toBe("GBP");
    expect(doc.finances.accounts.map((a) => a.balance)).toEqual([12_000, 40_000, 85_000]);
    expect(doc.plans).toHaveLength(1);
    const plan = doc.plans[0]!;
    expect(plan.isMain).toBe(true);
    expect(plan.name).toBe("Retire at 60");
    const salary = plan.income.find((i) => i.type === "salary");
    expect(salary?.amount.value).toBe(52_000);
    expect(plan.expenses.map((e) => [e.amount.value, e.frequency])).toEqual([
      [2_100, "monthly"],
      [400, "monthly"],
    ]);
    const retire = plan.milestones.find((m) => m.id === "ms-retire");
    expect(retire?.criteria[0]).toMatchObject({ kind: "age", age: 60 });
    expect(doc.settings.onboarding.completed).toBe(true);
    // A UK household gets the GB default market history (US 1928-2025; see defaultsForCountry).
    expect(plan.monteCarlo.dataset).toBe("us-1928");
    // ...and is taxed with the UK rules (personal allowance, bands, NI), not a flat 20% on everything.
    expect(plan.tax.mode).toBe("estimate");
    const strict = simulate(buildSimulationInput(doc, plan.id, { trace: "off" }));
    const year = strict.periods.find((p) => p.months === 12)!;
    expect(year.taxes.lines.some((l) => l.jurisdictionId === "uk")).toBe(true);
    // Every flow points at an account that exists.
    const ids = new Set(doc.finances.accounts.map((a) => a.id));
    for (const f of plan.flows)
      if (f.kind === "contribution") expect(ids.has(f.accountId)).toBe(true);
    const result = simulate(buildSimulationInput(doc, plan.id, { strict: false, trace: "off" }));
    expect(result.periods.length).toBeGreaterThan(30);
  });

  it("supports couples with joint and partner-owned accounts", () => {
    const doc = buildSetupDocument(
      answers({
        partner: { name: "Sam", birthMonth: "1987-09" },
        salary: { me: 52_000, partner: 38_000 },
        accounts: [
          { key: "a", type: "savings", name: "Joint savings", balance: 9_000, owner: "joint" },
          { key: "b", type: "uk-sipp", name: "Sam SIPP", balance: 30_000, owner: "partner" },
        ],
      }),
      { now: NOW },
    );
    expect(doc.household.planningMode).toBe("couple");
    expect(doc.finances.accounts.map((a) => a.owner)).toEqual(["joint", "p-partner"]);
    const salaries = doc.plans[0]!.income.filter((i) => i.type === "salary");
    expect(salaries.map((s) => s.amount.value).sort()).toEqual([38_000, 52_000]);
  });

  it("drops zero salaries and empty spending lines", () => {
    const doc = buildSetupDocument(
      answers({
        salary: { me: 0, partner: 0 },
        spending: { essential: 30_000, discretionary: 0, frequency: "yearly" },
      }),
      { now: NOW },
    );
    const plan = doc.plans[0]!;
    expect(plan.income.some((i) => i.type === "salary")).toBe(false);
    expect(plan.expenses).toHaveLength(1);
  });

  it("validates the answers with human messages", () => {
    const e = validateAnswers(
      { ...answers(), you: { name: "", birthMonth: "2020-01" }, lifeExpectancy: 50 },
      NOW,
    );
    expect(Object.keys(e).sort()).toEqual(["lifeExpectancy", "you.birthMonth", "you.name"]);
    expect(validateAnswers(answers(), NOW)).toEqual({});
  });

  it("suggests country-native accounts", () => {
    expect(suggestedAccounts("GB").map((a) => a.type)).toContain("uk-isa");
    expect(suggestedAccounts("US").map((a) => a.type)).toContain("401k");
    expect(suggestedAccounts("ZZ").every((a) => a.type)).toBe(true);
  });
});
