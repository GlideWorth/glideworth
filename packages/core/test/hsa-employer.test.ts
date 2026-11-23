/**
 * Fixed employer contributions and the combined HSA limit (GlideWorth/glideworth#8).
 *
 * Limits (in the US tax data, packages/core/src/tax/data/us-federal.ts):
 *   - 2026: $4,400 self-only, $8,750 family. Rev. Proc. 2025-19 section 2.01(1),
 *     https://www.irs.gov/pub/irs-drop/rp-25-19.pdf (read 2026-11-22).
 *   - 2027: $4,500 self-only, $9,000 family. Rev. Proc. 2026-24 section 3.01(1),
 *     https://www.irs.gov/pub/irs-drop/rp-26-24.pdf (read 2026-11-22).
 *   - $1,000 more from age 55 (IRC 223(b)(3)); IRS Publication 969, "Additional contribution",
 *     https://www.irs.gov/publications/p969 (read 2026-11-22).
 * Employer contributions that are excluded from income reduce what anyone else may contribute
 * (IRC 223(b)(4)(B); Publication 969, "Employer contributions": "You must reduce the amount you or
 * any other person can contribute to your HSA by the amount of any contributions made by your
 * employer that are excludable from your income"), and are not included in income.
 */
import { describe, expect, it } from "vitest";
import { simulate } from "../src/engine/simulate.js";
import type { ProjectionResult } from "../src/engine/types.js";
import { migrateDocument, SCHEMA_VERSION } from "../src/schema/document.js";
import { EmployerMatch, type FlowInput } from "../src/schema/flows.js";
import { createSampleDocument } from "../src/samples/index.js";
import {
  account,
  acct,
  always,
  between,
  expectInvariants,
  flatTax,
  period,
  sim,
} from "./engine-helpers.js";

const PAY = 100_000;
const salary = (range: typeof always | ReturnType<typeof between> = always) => ({
  id: "sal",
  type: "salary" as const,
  name: "Salary",
  owner: "me",
  amount: { value: PAY },
  frequency: "yearly" as const,
  range,
});

const employeeMax = (employer: object, accountId = "h"): FlowInput =>
  ({
    kind: "contribution",
    id: "f",
    name: "HSA",
    owner: "me",
    range: always,
    accountId,
    method: { kind: "max" },
    limit: { kind: "jurisdiction" },
    employer: { incomeId: "sal", ...employer },
  }) as FlowInput;

function run(opts: {
  employer: object;
  coverage?: "self" | "family";
  birth?: string;
  start?: string;
  years?: number;
  inflation?: number;
  salaryRange?: typeof always | ReturnType<typeof between>;
  accountType?: "hsa" | "401k";
}): ProjectionResult {
  const r = simulate(
    sim({
      start: opts.start ?? "2026-01",
      years: opts.years ?? 1,
      births: [opts.birth ?? "1970-01"],
      inflation: opts.inflation ?? 0,
      location: { country: "US" },
      accounts: [
        acct("c", "cash", 0),
        acct("h", opts.accountType ?? "hsa", 0, {
          behaviour: { hsaCoverage: opts.coverage ?? "family" },
        } as never),
      ],
      plan: {
        tax: flatTax(0.2),
        income: [salary(opts.salaryRange)],
        flows: [employeeMax(opts.employer)],
      },
    }),
  );
  expectInvariants(r);
  return r;
}

/** Employer money paid in `year`: the fixed contribution and the match, from the trace. */
function employer(r: ProjectionResult, year: number) {
  const idx = period(r, year).index;
  const sum = (code: string, key: string) =>
    r.trace
      .filter((t) => t.periodIndex === idx && t.code === code)
      .reduce((s, t) => s + ((t.data?.[key] as number) ?? 0), 0);
  return { fixed: sum("EMPLOYER_CONTRIBUTION", "amount"), match: sum("EMPLOYER_MATCH", "match") };
}

const quarterly250 = {
  fixed: { amount: { value: 250, basis: "nominal" }, frequency: "quarterly" },
};

describe("fixed employer HSA contribution and the combined limit", () => {
  it("issue #8: 2026 family coverage at 55+, $250 a quarter from the employer, employee up to the limit", () => {
    const r = run({ employer: quarterly250 });
    // Limit 8,750 + 1,000 catch-up = 9,750; the employer pays 4 x 250 = 1,000, the employee 8,750.
    expect(employer(r, 2026)).toEqual({ fixed: 1_000, match: 0 });
    expect(account(r, 2026, "h").contributions).toBeCloseTo(9_750, 6);
    // Only the employee's 8,750 is a deduction: 20% x (100,000 - 8,750).
    expect(period(r, 2026).totals.taxes).toBeCloseTo(0.2 * (PAY - 8_750), 6);
    // The employer's 1,000 is not cash income of the household.
    expect(account(r, 2026, "c").closing).toBeCloseTo(PAY - 8_750 - 0.2 * (PAY - 8_750), 6);
  });

  it("2027 limits: family 9,000 + 1,000 catch-up, less the employer's 1,000", () => {
    const r = run({ employer: quarterly250, start: "2027-01" });
    expect(account(r, 2027, "h").contributions).toBeCloseTo(10_000, 6);
    expect(employer(r, 2027).fixed).toBeCloseTo(1_000, 6);
  });

  it("employer money that uses up the headroom leaves the employee nothing, and is capped at the limit", () => {
    // Self-only, age 36 in 2026: limit 4,400 (no catch-up). Employer 400 a month = 4,800.
    const r = run({
      coverage: "self",
      birth: "1990-01",
      employer: { fixed: { amount: { value: 400, basis: "nominal" }, frequency: "monthly" } },
    });
    expect(employer(r, 2026).fixed).toBeCloseTo(4_400, 6);
    expect(account(r, 2026, "h").contributions).toBeCloseTo(4_400, 6);
    expect(period(r, 2026).totals.taxes).toBeCloseTo(0.2 * PAY, 6);
    expect(r.trace.some((t) => t.code === "CONTRIBUTION_LIMITED")).toBe(true);
  });

  it("partial headroom: employer 3,000 leaves the employee 1,400 of a 4,400 limit", () => {
    const r = run({
      coverage: "self",
      birth: "1990-01",
      employer: { fixed: { amount: { value: 3_000, basis: "nominal" }, frequency: "yearly" } },
    });
    expect(account(r, 2026, "h").contributions).toBeCloseTo(4_400, 6);
    expect(period(r, 2026).totals.taxes).toBeCloseTo(0.2 * (PAY - 1_400), 6);
  });

  it("an HSA match counts toward the limit: the employee leaves room for the match", () => {
    // Self-only 4,400; the employer matches 100% of the first 1% of pay (up to 1,000).
    // Employee e + min(e, 1,000) <= 4,400 -> e = 3,400, match 1,000.
    const r = run({
      coverage: "self",
      birth: "1990-01",
      employer: { tiers: [{ matchRate: 1, bandShareOfPay: 0.01 }] },
    });
    expect(employer(r, 2026).match).toBeCloseTo(1_000, 6);
    expect(account(r, 2026, "h").contributions).toBeCloseTo(4_400, 6);
    expect(period(r, 2026).totals.taxes).toBeCloseTo(0.2 * (PAY - 3_400), 6);
  });

  it("a fixed amount in today's money grows with inflation; a nominal one does not", () => {
    const fixed = (basis: "real" | "nominal") =>
      run({
        coverage: "self",
        birth: "1990-01",
        years: 3,
        inflation: 0.03,
        employer: { fixed: { amount: { value: 1_000, basis }, frequency: "yearly" } },
      });
    const real = fixed("real");
    const nominal = fixed("nominal");
    expect(employer(real, 2026).fixed).toBeCloseTo(1_000, 6);
    expect(employer(real, 2028).fixed).toBeCloseTo(1_000 * 1.03 ** 2, 6);
    expect(employer(nominal, 2028).fixed).toBeCloseTo(1_000, 6);
  });

  it("is paid only in years with pay from the income", () => {
    const r = run({
      coverage: "self",
      birth: "1990-01",
      years: 2,
      salaryRange: between("2026-01", "2027-01"),
      employer: { fixed: { amount: { value: 1_000, basis: "nominal" }, frequency: "yearly" } },
    });
    expect(employer(r, 2026).fixed).toBeCloseTo(1_000, 6);
    expect(employer(r, 2027).fixed).toBe(0);
  });

  it("outside an HSA a fixed employer contribution does not use the employee's deferral limit", () => {
    // 401(k): 2026 elective deferral limit 24,500 (existing US data); employer adds 3,000 on top.
    const r = run({
      birth: "1990-01",
      accountType: "401k",
      employer: { fixed: { amount: { value: 3_000, basis: "nominal" }, frequency: "yearly" } },
    });
    expect(account(r, 2026, "h").contributions).toBeCloseTo(24_500 + 3_000, 6);
  });

  it("the schema needs a match tier or a fixed amount, and no one-off frequency", () => {
    expect(EmployerMatch.safeParse({ incomeId: "sal", ...quarterly250 }).success).toBe(true);
    expect(EmployerMatch.safeParse({ incomeId: "sal" }).success).toBe(false);
    expect(
      EmployerMatch.safeParse({
        incomeId: "sal",
        fixed: { amount: { value: 1_000 }, frequency: "once" },
      }).success,
    ).toBe(false);
  });
});

describe("schema 3 -> 4", () => {
  it("has a version 3 -> 4 step", () => {
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(4);
  });

  it("a version 3 document loads unchanged", () => {
    const current = createSampleDocument();
    const v3 = { ...JSON.parse(JSON.stringify(current)), schemaVersion: 3 };
    expect(migrateDocument(v3)).toEqual(current);
  });
});
