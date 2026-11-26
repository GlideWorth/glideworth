/**
 * Warnings that quote money carry the nominal amount, and the sentence is filled in the basis
 * the caller asks for. A real expense reads back as the amount entered once deflated.
 */
import { describe, expect, it } from "vitest";
import { deflator } from "../src/engine/types.js";
import { simulate } from "../src/engine/simulate.js";
import { warningText } from "../src/engine/warnings.js";
import { explainProjection } from "../src/insights/explain.js";
import { acct, always, sim } from "./engine-helpers.js";
import { expense as solverExpense, makeInput } from "./solvers-helpers.js";

const expense = (id: string, amount: number) => ({
  id,
  type: "living" as const,
  name: id,
  owner: "me",
  amount: { value: amount, basis: "real" as const },
  frequency: "yearly" as const,
  range: always,
});

describe("warning amounts", () => {
  const result = simulate(
    sim({
      accounts: [acct("c", "cash", 0)],
      plan: { expenses: [expense("rent", 10_000)] },
      inflation: 0.1,
      years: 3,
    }),
  );
  const warning = result.warnings.find((w) => w.code === "SHORTFALL" && w.periodIndex === 2)!;

  it("keeps the nominal shortfall, a readable message and a placeholder template", () => {
    expect(warning.amounts).toEqual([
      { token: "shortfall", nominal: expect.any(Number), measure: "flow" },
    ]);
    expect(warning.template).toContain("{shortfall}");
    // The message reads on its own: currency, separators, no placeholder and no raw decimals.
    expect(warning.message).toMatch(/^In \d{4}, £[\d,]+ of expenses could not be funded/);
    expect(warning.message).not.toMatch(/\{|\d+\.\d{2}/);
    const nominal = warning.amounts![0]!.nominal;
    const period = result.periods[2]!;
    // 10% inflation for two years: a £10,000 real expense is 10,000 × 1.1² nominal.
    expect(nominal).toBeCloseTo(10_000 * 1.1 ** 2, 0);
    expect(deflator(period, "flow")).toBeCloseTo(1.1 ** 2, 6);
  });

  it("renders today's money and future money from the same nominal amount", () => {
    const period = result.periods[2]!;
    const nominal = warning.amounts![0]!.nominal;
    const show = (basis: "real" | "nominal") =>
      warningText(warning, { basis, period, format: (v) => v.toFixed(2) });
    expect(show("nominal")).toContain(nominal.toFixed(2));
    expect(show("real")).toContain((nominal / deflator(period, "flow")).toFixed(2));
    expect(show("real")).not.toContain("{shortfall}");
    expect(show("real")).not.toBe(show("nominal"));
  });

  it("quotes a withdrawal and a negative balance the same way", () => {
    const early = simulate(
      sim({
        accounts: [
          acct("ira", "traditional-ira", 100_000, {
            behaviour: { earlyWithdrawal: { enabled: true, qualifiedAge: 59.5, penaltyRate: 0.1 } },
          }),
        ],
        plan: { expenses: [expense("e", 10_000)] },
        years: 1,
      }),
    );
    const penalty = early.warnings.find((w) => w.code === "EARLY_WITHDRAWAL_PENALTY")!;
    expect(penalty.amounts).toEqual([
      { token: "withdrawn", nominal: expect.any(Number), measure: "flow" },
    ]);
    expect(penalty.template).toContain("{withdrawn}");
    expect(penalty.message).not.toMatch(/\{withdrawn\}|\d+\.\d{2}/);

    const negative = simulate(sim({ accounts: [acct("t", "taxable", -1_000)], years: 1 }));
    const balance = negative.warnings.find((w) => w.code === "NEGATIVE_BALANCE")!;
    expect(balance.amounts?.[0]).toMatchObject({ token: "balance", measure: "stock" });
    expect(balance.amounts?.[0]!.nominal).toBeLessThan(0);
    expect(balance.template).toContain("{balance}");
    expect(balance.message).toMatch(/negative balance \(-£1,0\d\d\)/);
  });

  it("never shows a placeholder where a warning is quoted as evidence", () => {
    const input = makeInput({
      accounts: [
        {
          id: "ira",
          name: "IRA",
          type: "traditional-ira",
          owner: "me",
          balance: 100_000,
          behaviour: { earlyWithdrawal: { enabled: true, qualifiedAge: 59.5, penaltyRate: 0.1 } },
        },
      ],
      plan: { expenses: [solverExpense("e", 10_000)] },
      years: 1,
    });
    const explained = explainProjection(input, simulate(input));
    const penalty = explained.findings.find((f) => f.code === "EARLY_WITHDRAWAL_PENALTY")!;
    expect(penalty.evidence.length).toBeGreaterThan(0);
    expect(
      JSON.stringify(penalty.evidence.map((e) => (e as { message?: string }).message)),
    ).not.toMatch(/\{withdrawn\}/);
  });
});
