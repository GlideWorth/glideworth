/** The engine's tax.strategy phase and the new flat/custom tax options. */
import { describe, expect, it } from "vitest";
import { simulate, US_FEDERAL_YEARS } from "../src/index.js";
import type { TaxStrategy } from "../src/schema/strategies.js";

type TaxStrategyInput = import("zod").input<typeof TaxStrategy>;

import { account, acct, always, expectInvariants, period, sim } from "./engine-helpers.js";

const living = (amount: number) => ({
  id: "living",
  type: "living" as const,
  name: "Living",
  owner: "me",
  amount: { value: amount },
  frequency: "yearly" as const,
  range: always,
});
const isaFirst = {
  order: [
    { kind: "category" as const, category: "cash" as const },
    { kind: "category" as const, category: "tax-free" as const },
    { kind: "category" as const, category: "tax-deferred" as const },
  ],
};

describe("tax.strategy: UK gap years", () => {
  const ukRetiree = (taxStrategy?: TaxStrategyInput) =>
    simulate(
      sim({
        location: { country: "GB" },
        births: ["1966-01"],
        accounts: [acct("sipp", "uk-sipp", 300_000), acct("isa", "uk-isa", 200_000)],
        plan: {
          tax: { mode: "estimate" },
          drawdown: isaFirst,
          expenses: [living(20_000)],
          ...(taxStrategy ? { taxStrategy: taxStrategy as never } : {}),
        },
        years: 2,
      }),
    );

  it("without a strategy an ISA-first order leaves the personal allowance unused", () => {
    const r = ukRetiree();
    expect(account(r, 2027, "sipp").withdrawals).toBe(0);
    expect(period(r, 2027).taxes.total).toBeCloseTo(0, 6);
  });

  it("fills the personal allowance from the pension (UFPLS: 25% tax-free), tax-free", () => {
    const r = ukRetiree({
      enabled: true,
      target: { kind: "bracket", rate: 0 },
      modules: { rothConversions: false, gainHarvesting: false },
    });
    const p = period(r, 2027);
    // 12,570 taxable = 75% of the withdrawal.
    expect(account(r, 2027, "sipp").withdrawals).toBeCloseTo(12_570 / 0.75, -1);
    expect(p.taxes.total).toBeCloseTo(0, 0);
    expect(r.trace.some((t) => t.code === "TAX_SHIELDED_WITHDRAWAL")).toBe(true);
    expectInvariants(r);
  });

  it("fills the basic-rate band and moves the extra into the ISA, capped by the ISA allowance", () => {
    const r = ukRetiree({
      enabled: true,
      target: { kind: "bracket", rate: 0.2 },
      modules: { gainHarvesting: false },
    });
    const p = period(r, 2027);
    expect(account(r, 2027, "isa").transfersIn).toBeCloseTo(20_000, 6);
    expect(p.taxes.facts["tax.ordinaryBracketRate"]).toBeLessThanOrEqual(0.2);
    expect(r.trace.some((t) => t.code === "TAX_STRATEGY_PENSION_TO_ISA")).toBe(true);
    expectInvariants(r);
  });

  it("harvests gains up to the CGT annual exempt amount", () => {
    const r = simulate(
      sim({
        location: { country: "GB" },
        accounts: [acct("c", "cash", 50_000), acct("gia", "uk-gia", 50_000, { costBasis: 20_000 })],
        plan: {
          tax: { mode: "estimate" },
          taxStrategy: {
            enabled: true,
            target: { kind: "bracket", rate: 0.2 },
            modules: { rothConversions: false, withdrawalShielding: false },
          },
        },
        years: 1,
      }),
    );
    expect(account(r, 2027, "gia").costBasis).toBeCloseTo(23_000, 0);
    expect(period(r, 2027).taxes.total).toBeCloseTo(0, 6);
  });
});

describe("tax.strategy: US Roth conversions", () => {
  it("converts up to the top of the 12% bracket", () => {
    const r = simulate(
      sim({
        location: { country: "US", region: "TX" },
        births: ["1966-01"],
        accounts: [
          acct("c", "cash", 100_000),
          acct("ira", "traditional-ira", 500_000),
          acct("roth", "roth-ira", 0),
        ],
        plan: {
          tax: { mode: "estimate" },
          expenses: [living(30_000)],
          taxStrategy: {
            enabled: true,
            target: { kind: "bracket", rate: 0.12 },
            modules: { withdrawalShielding: false, gainHarvesting: false },
          },
        },
        years: 1,
      }),
    );
    const p = period(r, 2027);
    const d = US_FEDERAL_YEARS[0]!;
    const top12 = d.brackets.single.find(([, rate]) => rate === 0.22)![0];
    expect(account(r, 2027, "roth").transfersIn).toBeGreaterThan(0);
    expect(p.taxes.facts["us.ordinaryTaxableIncome"]).toBeCloseTo(top12, -1);
    expect(p.taxes.facts["tax.ordinaryBracketRate"]).toBe(0.12);
    expect(r.trace.some((t) => t.code === "ROTH_CONVERSION")).toBe(true);
    expectInvariants(r);
  });
});

describe("flat and custom tax options", () => {
  it("flat: modifier shifts rates; bond dividends follow their treatment; employer items are not deductions", () => {
    const run = (flat: Record<string, unknown>) =>
      simulate(
        sim({
          accounts: [acct("c", "cash", 0), acct("t", "taxable", 100_000)],
          plan: {
            tax: {
              mode: "flat",
              flat: { ordinary: 0.2, capitalGains: 0.1, dividends: 0.1, local: 0, ...flat },
            },
            assumptions: {
              bondYield: { kind: "fixed", rate: 0.04 },
              bondAllocation: { kind: "fixed", share: 1 },
            },
            income: [{ ...living(10_000), type: "other", name: "Other" }],
          },
          years: 1,
        }),
      ).periods[0]!.taxes.total;
    // 10k other income + 4k bond income, both ordinary at 20% by default.
    expect(run({})).toBeCloseTo(14_000 * 0.2, 6);
    expect(run({ modifier: { ordinary: 0.05 } })).toBeCloseTo(14_000 * 0.25, 6);
    expect(run({ bondDividends: { treatment: "dividends" } })).toBeCloseTo(
      10_000 * 0.2 + 4_000 * 0.1,
      6,
    );
    expect(run({ bondDividends: { treatment: "rate", rate: 0.3 } })).toBeCloseTo(
      10_000 * 0.2 + 4_000 * 0.3,
      6,
    );
  });

  it("custom: dividend allowance, stacked gains, bond dividend table and extra taxes", () => {
    const table = (rows: [number, number][]) => ({
      brackets: rows.map(([from, rate]) => ({ from, rate })),
      basis: "nominal" as const,
    });
    const r = simulate(
      sim({
        accounts: [acct("c", "cash", 0), acct("t", "taxable", 200_000, { costBasis: 100_000 })],
        plan: {
          tax: {
            mode: "custom",
            custom: {
              ordinary: table([
                [0, 0.1],
                [50_000, 0.3],
              ]),
              capitalGains: table([
                [0, 0],
                [40_000, 0.2],
              ]),
              capitalGainsOffset: "income",
              dividends: table([[0, 0.15]]),
              dividendAllowance: 1_000,
              bondDividends: table([[0, 0.05]]),
              extraTaxes: [
                { name: "Solidarity surcharge", table: table([[0, 0.01]]), base: "ordinary" },
              ],
            },
          },
          assumptions: {
            dividendYield: { kind: "fixed", rate: 0.02 },
            bondYield: { kind: "fixed", rate: 0.04 },
            bondAllocation: { kind: "fixed", share: 0.5 },
          },
          income: [{ ...living(45_000), type: "other", name: "Other" }],
          expenses: [living(40_000)],
        },
        years: 1,
      }),
    );
    const lines = r.periods[0]!.taxes.lines;
    const by = (label: string) => lines.find((l) => l.label === label)?.amount ?? 0;
    // Dividends: 200k x 50% x 2% = 2k, 1k allowance -> 1k x 15%.
    expect(by("Dividend tax")).toBeCloseTo(150, 6);
    // Bond income: 200k x 50% x 4% = 4k at 5%.
    expect(by("Bond dividend tax")).toBeCloseTo(200, 6);
    expect(by("Income tax")).toBeCloseTo(45_000 * 0.1, 6);
    expect(by("Solidarity surcharge")).toBeCloseTo(45_000 * 0.01, 6);
  });
});
