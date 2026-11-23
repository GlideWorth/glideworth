/**
 * Dependent-centred planning:
 *  - one "still a dependent this year" rule (engine/dependents.ts) feeds the US child tax credit and
 *    the automatic ACA household size, so the two cannot disagree;
 *  - ACA household size "auto" (the default) follows the tax household year by year, a number stays
 *    a manual override;
 *  - a DateRef can follow a dependent's age, so a child's costs move with their birth month.
 *
 * No tax figure is asserted here: credits are compared with the same plug-in run on an explicit
 * household size, so the tests check which people are counted, not the tables (those are covered,
 * with sources, in tax-us-federal.test.ts).
 */
import { describe, expect, it } from "vitest";
import { isDependentInPeriod } from "../src/engine/dependents.js";
import { simulate } from "../src/engine/simulate.js";
import type { SimulationInputInput } from "../src/engine/types.js";
import { ScenarioError } from "../src/errors.js";
import { ExpenseEvent } from "../src/schema/events.js";
import { DateRef } from "../src/schema/time.js";
import { householdDependents } from "../src/tax/common.js";
import { acaHouseholdSize, usFederalJurisdiction } from "../src/tax/jurisdictions/us-federal.js";
import type { TaxYearInput } from "../src/tax/types.js";
import { period, sim } from "./engine-helpers.js";
import { sumLabel, taxInput } from "./tax-helpers.js";

const mfj = { filingStatus: "married-joint" as const };
const fed = (input: TaxYearInput) => usFederalJurisdiction.computeYear(input, []);
const usInput = (o: Parameters<typeof taxInput>[0]) => taxInput({ country: "US", ...o });

describe("isDependentInPeriod: the household's own rule", () => {
  const dep = { birthMonth: "2020-06", independentAtAge: 18 };
  const year = (y: number) => [y * 12, (y + 1) * 12] as const;
  it("counts a dependent from the year they are born until the year they reach independentAtAge", () => {
    expect(isDependentInPeriod(dep, ...year(2019))).toBe(false);
    expect(isDependentInPeriod(dep, ...year(2020))).toBe(true);
    expect(isDependentInPeriod(dep, ...year(2038))).toBe(true); // 17.6 at the start of 2038
    expect(isDependentInPeriod(dep, ...year(2039))).toBe(false); // 18.6
  });
  it("uses the dependent's own independentAtAge, not a fixed tax age", () => {
    expect(isDependentInPeriod({ ...dep, independentAtAge: 22 }, ...year(2041))).toBe(true);
    expect(isDependentInPeriod({ ...dep, independentAtAge: 10 }, ...year(2031))).toBe(false);
  });
});

describe("US federal: the child tax credit and the ACA size count the same dependents", () => {
  const base = {
    year: 2027,
    config: mfj,
    people: [{ age: 40 }, { age: 40 }],
    income: [{ character: "wage" as const, amount: 60_000 }],
  };

  it("an unborn dependent (negative age) earns no child tax credit", () => {
    const one = fed(usInput({ ...base, dependents: [5] }));
    const withUnborn = fed(usInput({ ...base, dependents: [5, -1] }));
    expect(sumLabel(withUnborn, /Child tax credit/)).toBeCloseTo(
      sumLabel(one, /Child tax credit/),
      6,
    );
  });

  it("a dependent the household marks as no longer dependent earns no child tax credit", () => {
    const input = usInput({ ...base, dependents: [10, 12] });
    input.dependents[1]!.dependent = false;
    const one = fed(usInput({ ...base, dependents: [10] }));
    expect(sumLabel(fed(input), /Child tax credit/)).toBeCloseTo(
      sumLabel(one, /Child tax credit/),
      6,
    );
  });

  it("ACA auto size = adults on the return + householdDependents, and matches an explicit size", () => {
    const input = usInput({
      ...base,
      income: [{ character: "wage", amount: 50_000 }],
      dependents: [3, 15, -1],
      aca: { benchmarkPremium: 20_000 },
    });
    input.dependents[1]!.dependent = false; // independent early by the household's setting
    expect(householdDependents(input).map((d) => d.id)).toEqual(["d0"]);
    expect(acaHouseholdSize(input)).toBe(3);
    const auto = fed(input);
    expect(auto.facts["us.acaHouseholdSize"]).toBe(3);
    expect(auto.facts["us.acaHouseholdSizeAuto"]).toBe(1);
    const manual = fed({ ...input, aca: { benchmarkPremium: 20_000, householdSize: 3 } });
    expect(manual.facts["us.acaHouseholdSizeAuto"]).toBe(0);
    expect(sumLabel(auto, /premium tax credit/)).toBeCloseTo(
      sumLabel(manual, /premium tax credit/),
      6,
    );
  });

  it("only the living adults on the return count: one filer when not filing jointly", () => {
    const single = usInput({
      ...base,
      config: { filingStatus: "single" },
      aca: { benchmarkPremium: 20_000 },
    });
    expect(acaHouseholdSize(single)).toBe(1);
    const widowed = usInput({
      ...base,
      people: [{ age: 60 }, { age: 60, alive: false }],
      aca: { benchmarkPremium: 20_000 },
    });
    expect(acaHouseholdSize(widowed)).toBe(1);
  });

  it("a manual size wins over the tax household", () => {
    const input = usInput({
      ...base,
      dependents: [3, 5],
      aca: { benchmarkPremium: 20_000, householdSize: 2 },
    });
    expect(acaHouseholdSize(input)).toBe(2);
  });
});

describe("schema: ACA household size and dependentAge", () => {
  const aca = (householdSize?: unknown) =>
    ExpenseEvent.parse({
      id: "aca",
      type: "healthcare",
      name: "ACA",
      owner: "joint",
      amount: { value: 1_000 },
      frequency: "monthly",
      range: { start: { kind: "planStart" }, end: { kind: "planEnd" } },
      healthcare: {
        kind: "aca",
        benchmarkPremium: { value: 900 },
        ...(householdSize === undefined ? {} : { householdSize }),
      },
    });
  it("defaults to auto, keeps a number, rejects nonsense", () => {
    const size = (e: ExpenseEvent) =>
      e.type === "healthcare" && e.healthcare.kind === "aca" ? e.healthcare.householdSize : null;
    expect(size(aca())).toBe("auto");
    expect(size(aca(4))).toBe(4);
    expect(() => aca(0)).toThrow();
    expect(() => aca("household")).toThrow();
  });
  it("parses a dependentAge DateRef", () => {
    expect(DateRef.parse({ kind: "dependentAge", dependentId: "kid", age: 5 })).toEqual({
      kind: "dependentAge",
      dependentId: "kid",
      age: 5,
      offsetMonths: 0,
    });
  });
});

// ------------------------------------------------------------------------------- engine

/** A US couple filing jointly (born 1985) with two children, simulated 2027-2033. */
function usFamily(
  acaSize: "auto" | number | undefined,
  kids: { id: string; name: string; birthMonth: string; independentAtAge?: number }[],
): SimulationInputInput {
  const input = sim({
    births: ["1985-01", "1985-01"],
    location: { country: "US", region: "TX" },
    years: 7,
    accounts: [{ id: "cash", name: "Cash", type: "cash", owner: "joint", balance: 2_000_000 }],
    plan: {
      tax: { mode: "estimate", filingStatus: "married-joint" },
      income: [
        {
          id: "sal",
          type: "salary",
          name: "Salary",
          owner: "a",
          amount: { value: 50_000 },
          frequency: "yearly",
          range: { start: { kind: "planStart" }, end: { kind: "planEnd" } },
        },
      ],
      expenses: [
        {
          id: "aca",
          type: "healthcare",
          name: "Marketplace cover",
          owner: "joint",
          amount: { value: 1_500 },
          frequency: "monthly",
          range: { start: { kind: "planStart" }, end: { kind: "planEnd" } },
          healthcare: {
            kind: "aca",
            benchmarkPremium: { value: 1_400 },
            ...(acaSize === undefined ? {} : { householdSize: acaSize }),
            advanceCreditShare: 0,
          },
        },
      ],
    },
  });
  (input.household as { dependents?: unknown }).dependents = kids;
  return input;
}

const KIDS = [
  // Turns 18 in 2029-03: dependent through 2029, independent from 2030.
  { id: "older", name: "Older", birthMonth: "2011-03", independentAtAge: 18 },
  // Born 2028-09: counted from 2028.
  { id: "baby", name: "Baby", birthMonth: "2028-09" },
];

describe("engine: ACA household size follows the tax household", () => {
  it("auto (the default) changes as a child is born and as another becomes independent", () => {
    const r = simulate(usFamily(undefined, KIDS));
    const size = (y: number) => period(r, y).taxes.facts["us.acaHouseholdSize"];
    expect(size(2027)).toBe(3); // two adults + older
    expect(size(2028)).toBe(4); // baby born in 2028
    expect(size(2029)).toBe(4); // older is 17.8 at the start of 2029
    expect(size(2030)).toBe(3); // older independent at 18
    expect(period(r, 2030).taxes.facts["us.acaHouseholdSizeAuto"]).toBe(1);
  });

  it("the CTC counts the same dependents as the ACA size, year by year", () => {
    const ctc = (kids: typeof KIDS, y: number) =>
      sumLabel(
        { lines: period(simulate(usFamily("auto", kids)), y).taxes.lines } as never,
        /Child tax credit/,
      );
    const [older, baby] = KIDS as [(typeof KIDS)[0], (typeof KIDS)[1]];
    // 2027: the baby is not born yet, so only the older child counts (for both).
    expect(ctc(KIDS, 2027)).toBeLessThan(0);
    expect(ctc(KIDS, 2027)).toBeCloseTo(ctc([older], 2027), 6);
    // 2030: the older child is independent, so only the baby counts (for both).
    expect(ctc(KIDS, 2030)).toBeLessThan(0);
    expect(ctc(KIDS, 2030)).toBeCloseTo(ctc([baby], 2030), 6);
  });

  it("a stored number is a manual override for every year", () => {
    const r = simulate(usFamily(2, KIDS));
    for (const y of [2027, 2028, 2030]) {
      expect(period(r, y).taxes.facts["us.acaHouseholdSize"]).toBe(2);
      expect(period(r, y).taxes.facts["us.acaHouseholdSizeAuto"]).toBe(0);
    }
  });

  it("year-by-year PTC with auto equals the plan with the same sizes typed in by hand", () => {
    const auto = simulate(usFamily("auto", KIDS));
    for (const [y, n] of [
      [2027, 3],
      [2028, 4],
      [2030, 3],
    ] as const) {
      const manual = simulate(usFamily(n, KIDS));
      const ptc = (r: typeof auto) => period(r, y).taxes.facts["us.ptc"];
      expect(ptc(auto)).toBeCloseTo(ptc(manual)!, 6);
    }
  });
});

describe("engine: costs timed by a dependent's age", () => {
  const withChildcare = (birthMonth: string) => {
    const input = sim({
      years: 8,
      accounts: [{ id: "c", name: "c", type: "cash", owner: "me", balance: 1e6 }],
    });
    (input.household as { dependents?: unknown }).dependents = [
      { id: "kid", name: "Kid", birthMonth },
    ];
    input.plan.expenses = [
      {
        id: "care",
        type: "childcare",
        name: "Childcare",
        owner: "me",
        dependentId: "kid",
        amount: { value: 100 },
        frequency: "monthly",
        range: {
          start: { kind: "dependentAge", dependentId: "kid", age: 1 },
          end: { kind: "dependentAge", dependentId: "kid", age: 5 },
        },
      },
    ];
    return input;
  };
  const care = (r: ReturnType<typeof simulate>, y: number) =>
    period(r, y).expenses.find((e) => e.sourceId === "care")?.requested ?? 0;

  it("runs from the dependent's first to fifth birthday", () => {
    const r = simulate(withChildcare("2026-07"));
    expect(care(r, 2027)).toBeCloseTo(100 * 6, 6); // from 2027-07
    expect(care(r, 2028)).toBeCloseTo(1_200, 6);
    expect(care(r, 2031)).toBeCloseTo(100 * 6, 6); // until 2031-07 (exclusive)
    expect(care(r, 2032)).toBe(0);
  });

  it("moves when the birth month changes", () => {
    const r = simulate(withChildcare("2027-01"));
    expect(care(r, 2027)).toBe(0);
    expect(care(r, 2028)).toBeCloseTo(1_200, 6);
    expect(care(r, 2032)).toBe(0);
  });

  it("an unknown dependent id is a scenario error", () => {
    const input = withChildcare("2026-07");
    (input.household as { dependents?: unknown }).dependents = [];
    expect(() => simulate(input)).toThrow(ScenarioError);
  });
});
