/**
 * Explainability contracts: every warning the engine emits states its year and its cause in plain
 * English, and every year of a full projection reconciles exactly (reconcileYear).
 */
import { describe, expect, it } from "vitest";
import { simulate } from "../src/engine/simulate.js";
import type { ProjectionResult, SimWarning } from "../src/engine/types.js";
import { buildSimulationInput, reconcileYear, WarningCode } from "../src/index.js";
import {
  createSampleDocument,
  createUkSampleDocument,
  SAMPLE_PLAN_ID,
  UK_SAMPLE_PLAN_ID,
} from "../src/samples/index.js";
import { acct, always, flatTax, sim } from "./engine-helpers.js";

const expense = (id: string, amount: number, extra: Record<string, unknown> = {}) => ({
  id,
  type: "living" as const,
  name: id,
  owner: "me",
  amount: { value: amount },
  frequency: "yearly" as const,
  range: always,
  ...extra,
});

/** One synthetic run per warning code (except DANGLING_REFERENCE, which the engine raises as an error). */
function scenarios(): Record<string, ProjectionResult> {
  return {
    SHORTFALL_DEPLETED: simulate(
      sim({
        accounts: [
          acct("c", "cash", 15_000),
          acct("locked", "taxable", 50_000, { behaviour: { withdrawals: { kind: "never" } } }),
        ],
        plan: { expenses: [expense("e", 10_000)] },
        years: 3,
      }),
    ),
    EARLY_WITHDRAWAL_PENALTY: simulate(
      sim({
        accounts: [
          acct("ira", "traditional-ira", 100_000, {
            behaviour: { earlyWithdrawal: { enabled: true, qualifiedAge: 59.5, penaltyRate: 0.1 } },
          }),
        ],
        plan: { expenses: [expense("e", 10_000)], tax: flatTax(0.1) },
        years: 1,
      }),
    ),
    MILESTONE_NEVER_REACHED: simulate(
      sim({
        accounts: [acct("c", "cash", 1_000)],
        plan: {
          milestones: [
            {
              id: "rich",
              name: "Rich",
              kind: "custom",
              criteria: [
                {
                  kind: "metric",
                  metric: { kind: "netWorth" },
                  comparator: ">=",
                  threshold: { kind: "amount", amount: { value: 1e9 } },
                },
              ],
            },
          ],
        },
        years: 2,
      }),
    ),
    NEGATIVE_BALANCE: simulate(sim({ accounts: [acct("t", "taxable", -1_000)], years: 1 })),
    FEATURE_NOT_MODELLED: simulate(
      sim({
        accounts: [acct("c", "cash", 1_000)],
        plan: {
          assumptions: {
            stockReturn: { kind: "historical", series: "us-stocks", startYear: 1990 },
          },
        },
        options: { strict: false },
        years: 1,
      }),
      { historical: { range: () => null, value: () => undefined } },
    ),
    DATASET_REPLACED: simulate(
      sim({
        accounts: [acct("c", "cash", 1_000)],
        plan: { monteCarlo: { dataset: "uk-1871" } },
        years: 1,
      }),
    ),
    ASSUMPTION: simulate(
      sim({
        accounts: [],
        plan: {
          income: [{ ...expense("i", 5_000), type: "other" as const }],
          leftover: { kind: "save" },
        },
        years: 1,
      }),
    ),
  };
}

describe("every warning code has a plain-English message with its year and cause", () => {
  const runs = scenarios();
  const all: SimWarning[] = Object.values(runs).flatMap((r) => r.warnings);

  it("the scenarios cover every code the engine emits", () => {
    const seen = new Set(all.map((w) => w.code));
    for (const code of WarningCode.options) {
      if (code === "DANGLING_REFERENCE") continue; // dangling ids raise a ScenarioError instead
      expect(seen.has(code), code).toBe(true);
    }
  });

  it('dated warnings name their year; every message gives a cause (a clause after ":" / "because" / "so" / "before")', () => {
    for (const w of all) {
      expect(w.message.length, w.message).toBeGreaterThan(30);
      expect(w.message.trim().endsWith("."), w.message).toBe(true);
      if (w.periodIndex !== null) expect(w.message, w.code).toMatch(/\b(19|20)\d\d\b/);
      expect(w.message, w.code).toMatch(
        /:|because|so |before|while|cannot|instead|for the whole plan/,
      );
    }
  });

  it("SHORTFALL says how much, when, and that money is locked away when it is", () => {
    const w = runs.SHORTFALL_DEPLETED!.warnings.find((x) => x.code === "SHORTFALL")!;
    expect(w.message).toMatch(/^In 2028, .* could not be funded: .*cannot be withdrawn from yet/);
    const d = runs.SHORTFALL_DEPLETED!.warnings.find((x) => x.code === "DEPLETED")!;
    expect(d.message).toMatch(/is depleted in 2028: withdrawals to cover spending/);
  });
});

describe("reconcileYear: every year adds up exactly", () => {
  const cases: [string, ProjectionResult][] = [
    [
      "US sample",
      simulate(buildSimulationInput(createSampleDocument(), SAMPLE_PLAN_ID, { trace: "off" })),
    ],
    [
      "UK sample",
      simulate(buildSimulationInput(createUkSampleDocument(), UK_SAMPLE_PLAN_ID, { trace: "off" })),
    ],
    ["shortfall", scenarios().SHORTFALL_DEPLETED!],
  ];

  it.each(cases)(
    "%s: cash in = cash out, accounts and net worth reconcile, in both bases",
    (_n, r) => {
      for (const p of r.periods) {
        for (const basis of ["nominal", "real"] as const) {
          const x = reconcileYear(r, p.index, { basis });
          expect(x.balanced, `${p.year} ${basis}`).toBe(true);
          expect(Math.abs(x.cash.difference)).toBeLessThanOrEqual(x.tolerance);
          if (p.index > 0) expect(x.netWorth).not.toBeNull();
        }
      }
    },
  );

  it("shows the unfunded part of a shortfall year as an inflow, so the table still balances", () => {
    const r = scenarios().SHORTFALL_DEPLETED!;
    const y = r.periods.find((p) => p.totals.shortfall > 0)!;
    const x = reconcileYear(r, y.index);
    const unfunded = x.cash.inflows.find((i) => i.kind === "shortfall")!;
    expect(unfunded.amount).toBeCloseTo(y.totals.shortfall, 6);
    expect(x.balanced).toBe(true);
  });

  it("refuses lean projections (they carry no ledger)", () => {
    const r = simulate(
      sim({
        accounts: [acct("c", "cash", 10_000)],
        plan: { expenses: [expense("e", 1_000)] },
        options: { lean: true },
      }),
    );
    expect(() => reconcileYear(r, 0)).toThrow(/full/);
  });
});
