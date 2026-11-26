/**
 * Drawing from several accounts in the same year.
 *
 * Part 1 pins what the engine did before blended drawdown entries existed (still true: these
 * settings are unchanged). Part 2 covers the two new opt-in drawdown-order entries:
 * `proportional` (several accounts together, by balance) and `fillToCeiling` (pre-tax accounts up
 * to a taxable-income ceiling, per person where the tax system taxes individuals).
 *
 * Figures come from the tax tables, which cite their sources:
 *   - UK personal allowance £12,570 and basic-rate band £37,700 (`UK_TAX_YEARS`; gov.uk "Income Tax
 *     rates and Personal Allowances", https://www.gov.uk/income-tax-rates, read 2026-11-19 per the
 *     table). A UFPLS pension withdrawal is 25% tax-free and 75% taxable
 *     (https://www.gov.uk/tax-on-pension/tax-free, read 2026-11-26), so the allowance holds a gross
 *     withdrawal of 12,570 / 0.75 = 16,760.
 *   - US 2027 married-filing-jointly 12% bracket ends at $104,050 of taxable income
 *     (`US_FEDERAL_YEARS`, Rev. Proc. 2026-35 section 3.01 as cited in the table).
 */
import { describe, expect, it } from "vitest";
import { SimulationInput } from "../src/engine/types.js";
import { buildSimulationInput, ScenarioError, simulate, US_FEDERAL_YEARS } from "../src/index.js";
import { explainYear } from "../src/insights/explain.js";
import { UK_TAX_YEARS } from "../src/tax/data/uk.js";
import {
  createSampleDocument,
  createUkSampleDocument,
  SAMPLE_PLAN_ID,
  UK_SAMPLE_PLAN_ID,
} from "../src/samples/index.js";
import { migrateDocument, SCHEMA_VERSION } from "../src/schema/document.js";
import type { DrawdownEntry, DrawdownSettings } from "../src/schema/strategies.js";
import {
  account,
  acct,
  always,
  expectInvariants,
  period,
  sim,
  ZERO_TAX,
} from "./engine-helpers.js";

type Entry = import("zod").input<typeof DrawdownEntry>;
type DrawdownSettingsInput = import("zod").input<typeof DrawdownSettings>;

const living = (amount: number) => ({
  id: "living",
  type: "living" as const,
  name: "Living",
  owner: "joint",
  amount: { value: amount },
  frequency: "yearly" as const,
  range: always,
});

const UK = UK_TAX_YEARS.find((y) => y.startYear === 2027)!;
const PA = UK.income.personalAllowance; // 12,570
const UFPLS_TAXABLE = 0.75;
const PA_GROSS = PA / UFPLS_TAXABLE; // 16,760

const US_2027 = US_FEDERAL_YEARS.find((y) => y.year === 2027)!;
const TOP_OF_12_MFJ = US_2027.brackets["married-joint"].find(([, rate]) => rate === 0.22)![0];

const fill = (rate: number, accountIds: string[] = []): Entry => ({
  kind: "fillToCeiling",
  ceiling: { kind: "bracket", rate },
  accountIds,
});
const cat = (category: "cash" | "taxable" | "tax-deferred" | "tax-free"): Entry => ({
  kind: "category",
  category,
});
const rules = (r: ReturnType<typeof simulate>, year: number) =>
  period(r, year).ledger.filter((l) => l.rule);

// --- A retired US couple (61 and 61: past 59½, before Medicare and RMDs), married filing jointly.
const usCouple = (
  spending: number,
  drawdown: DrawdownSettingsInput = {},
  births = ["1966-01", "1966-01"],
) =>
  simulate(
    sim({
      location: { country: "US", region: "TX" },
      births,
      accounts: [
        acct("tx", "taxable", 300_000, { owner: "joint", costBasis: 300_000 }),
        acct("iraA", "traditional-ira", 600_000, { owner: "a" }),
        acct("iraB", "traditional-ira", 150_000, { owner: "b" }),
        acct("rothA", "roth-ira", 200_000, { owner: "a", contributionBasis: 200_000 }),
      ],
      plan: {
        tax: { mode: "estimate", filingStatus: "married-joint" },
        expenses: [living(spending)],
        drawdown,
      },
      years: 1,
    }),
  );

// --- A UK couple (61 and 60) with a SIPP and an ISA each.
const ukCouple = (
  spending: number,
  plan: Record<string, unknown> = {},
  balances = { sippA: 500_000, sippB: 100_000 },
) =>
  simulate(
    sim({
      location: { country: "GB" },
      births: ["1966-01", "1967-01"],
      accounts: [
        acct("sippA", "uk-sipp", balances.sippA, { owner: "a" }),
        acct("sippB", "uk-sipp", balances.sippB, { owner: "b" }),
        acct("isaA", "uk-isa", 100_000, { owner: "a" }),
        acct("isaB", "uk-isa", 100_000, { owner: "b" }),
      ],
      plan: { tax: { mode: "estimate" }, expenses: [living(spending)], ...plan },
      years: 1,
    }),
  );

describe("before blended entries: what the existing settings do (pinned)", () => {
  it("US: the default order pays a year from one account", () => {
    const r = usCouple(90_000);
    expect(account(r, 2027, "tx").withdrawals).toBeCloseTo(90_000, 6);
    for (const id of ["iraA", "iraB", "rothA"]) expect(account(r, 2027, id).withdrawals).toBe(0);
  });

  it("US: 'proportional' and 'split by owner' work only inside one category", () => {
    const r = usCouple(90_000, { withinCategory: "proportional", splitByOwner: true });
    expect(account(r, 2027, "tx").withdrawals).toBeCloseTo(90_000, 6);
    expect(account(r, 2027, "rothA").withdrawals).toBe(0);
    // Two single-account entries are still drawn one after the other.
    const listed = usCouple(90_000, {
      withinCategory: "proportional",
      order: [
        { kind: "account", accountId: "tx" },
        { kind: "account", accountId: "rothA" },
      ],
    });
    expect(account(listed, 2027, "tx").withdrawals).toBeCloseTo(90_000, 6);
    expect(account(listed, 2027, "rothA").withdrawals).toBe(0);
  });

  it("UK: the default order drains one partner's pension and leaves the other's untouched", () => {
    const r = ukCouple(45_000);
    expect(account(r, 2027, "sippA").withdrawals).toBeGreaterThan(45_000);
    expect(account(r, 2027, "sippB").withdrawals).toBe(0);
    expect(period(r, 2027).taxes.facts["uk.adjustedNetIncome.b"]).toBe(0);
  });

  it("UK: 'split by owner' splits by balance (5:1), not by allowance", () => {
    const r = ukCouple(45_000, {
      drawdown: { withinCategory: "proportional", splitByOwner: true },
    });
    const a = account(r, 2027, "sippA").withdrawals;
    const b = account(r, 2027, "sippB").withdrawals;
    expect(a / b).toBeCloseTo(5, 6);
    expect(b * UFPLS_TAXABLE).toBeLessThan(PA); // B's allowance is partly unused while A pays 20%
  });

  it("UK: the tax strategy's withdrawal shielding fills one account at a time, not the lowest band first", () => {
    const r = ukCouple(45_000, {
      drawdown: { order: [cat("tax-free")] },
      taxStrategy: {
        enabled: true,
        target: { kind: "bracket", rate: 0.2 },
        modules: { rothConversions: false, gainHarvesting: false },
      },
    });
    // All of the need came from A's pension within A's basic-rate band; B's allowance is unused.
    expect(account(r, 2027, "sippA").withdrawals).toBeCloseTo(45_000, 0);
    expect(account(r, 2027, "sippB").withdrawals).toBe(0);
    expect(period(r, 2027).taxes.total).toBeGreaterThan(0);
  });
});

describe("drawdown entry: proportional across chosen accounts", () => {
  it("draws a taxable account and a Roth together, in proportion to balances, and says so in the ledger", () => {
    const r = simulate(
      sim({
        accounts: [acct("tx", "taxable", 30_000), acct("roth", "roth-ira", 10_000)],
        plan: {
          expenses: [living(20_000)],
          drawdown: { order: [{ kind: "proportional", accountIds: ["tx", "roth"] }] },
        },
        years: 1,
      }),
    );
    expect(account(r, 2027, "tx").withdrawals).toBeCloseTo(15_000, 6);
    expect(account(r, 2027, "roth").withdrawals).toBeCloseTo(5_000, 6);
    const lines = rules(r, 2027);
    expect(lines).toHaveLength(2);
    for (const l of lines) expect(l.rule).toEqual({ kind: "proportional", entry: 1 });
    expectInvariants(r);
  });

  it("moves on to the next entry when the chosen accounts run out", () => {
    const r = simulate(
      sim({
        accounts: [
          acct("c", "cash", 50_000),
          acct("tx", "taxable", 3_000),
          acct("roth", "roth-ira", 1_000),
        ],
        plan: {
          tax: ZERO_TAX,
          expenses: [living(10_000)],
          drawdown: { order: [{ kind: "proportional", accountIds: ["tx", "roth"] }, cat("cash")] },
        },
        years: 1,
      }),
    );
    expect(account(r, 2027, "tx").withdrawals).toBeCloseTo(3_000, 6);
    expect(account(r, 2027, "roth").withdrawals).toBeCloseTo(1_000, 6);
    expect(account(r, 2027, "c").withdrawals).toBeCloseTo(6_000, 6);
  });
});

describe("drawdown entry: fill to a tax ceiling (UK, taxed per person)", () => {
  const ukSingle = (spending: number, sipp = 300_000) =>
    simulate(
      sim({
        location: { country: "GB" },
        births: ["1966-01"],
        accounts: [acct("sipp", "uk-sipp", sipp), acct("isa", "uk-isa", 100_000)],
        plan: {
          tax: { mode: "estimate" },
          expenses: [living(spending)],
          drawdown: { order: [fill(0), cat("tax-free"), cat("tax-deferred")] },
        },
        years: 1,
      }),
    );

  it("just below the personal allowance: the pension pays it all, tax-free", () => {
    const r = ukSingle(16_000);
    expect(account(r, 2027, "sipp").withdrawals).toBeCloseTo(16_000, 6);
    expect(account(r, 2027, "isa").withdrawals).toBe(0);
    expect(period(r, 2027).taxes.total).toBeCloseTo(0, 6);
  });

  it("at the personal allowance: the pension pays 16,760 (12,570 taxable), no tax", () => {
    const r = ukSingle(PA_GROSS);
    expect(account(r, 2027, "sipp").withdrawals).toBeGreaterThan(PA_GROSS - 2);
    expect(account(r, 2027, "sipp").withdrawals).toBeLessThanOrEqual(PA_GROSS + 1e-6);
    expect(account(r, 2027, "isa").withdrawals).toBeLessThan(2);
    expect(period(r, 2027).taxes.total).toBeCloseTo(0, 6);
  });

  it("just above the personal allowance: the pension stops at the allowance, the ISA pays the rest", () => {
    const r = ukSingle(17_000);
    const p = period(r, 2027);
    const sipp = account(r, 2027, "sipp").withdrawals;
    expect(sipp).toBeGreaterThan(PA_GROSS - 2);
    expect(sipp).toBeLessThanOrEqual(PA_GROSS + 1e-6);
    expect(account(r, 2027, "isa").withdrawals).toBeCloseTo(17_000 - sipp, 6);
    expect(p.taxes.facts["uk.adjustedNetIncome.me"]).toBeLessThanOrEqual(PA);
    expect(p.taxes.total).toBeCloseTo(0, 6);
    const lines = rules(r, 2027);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines[0]!.rule).toMatchObject({
      kind: "fill-to-ceiling",
      entry: 1,
      owner: "me",
      ceiling: "tax-free allowance (0% band)",
      bandRate: 0,
    });
    expect(lines[0]!.rule!.room).toBeCloseTo(PA, -1);
    expectInvariants(r);
  });

  it("a pension smaller than the allowance is used up and the next entry pays the rest", () => {
    const r = ukSingle(20_000, 5_000);
    expect(account(r, 2027, "sipp").withdrawals).toBeCloseTo(5_000, 6);
    expect(account(r, 2027, "isa").withdrawals).toBeCloseTo(15_000, 6);
  });

  it("a couple with unequal pensions: each partner's own allowance, the smaller pension runs out", () => {
    const r = ukCouple(
      30_000,
      { drawdown: { order: [fill(0), cat("tax-free")] } },
      { sippA: 300_000, sippB: 5_000 },
    );
    const p = period(r, 2027);
    const a = account(r, 2027, "sippA").withdrawals;
    expect(a).toBeGreaterThan(PA_GROSS - 2);
    expect(a).toBeLessThanOrEqual(PA_GROSS + 1e-6);
    expect(account(r, 2027, "sippB").withdrawals).toBeCloseTo(5_000, 6);
    expect(account(r, 2027, "isaA").withdrawals + account(r, 2027, "isaB").withdrawals).toBeCloseTo(
      30_000 - a - 5_000,
      6,
    );
    expect(p.taxes.total).toBeCloseTo(0, 6);
    const owners = new Set(rules(r, 2027).map((l) => l.rule!.owner));
    expect(owners).toEqual(new Set(["a", "b"]));
  });

  it("to the basic-rate band: fills the partner's allowance before anyone pays 20%", () => {
    const r = ukCouple(45_000, { drawdown: { order: [fill(0.2), cat("tax-free")] } });
    const p = period(r, 2027);
    const b = account(r, 2027, "sippB").withdrawals;
    const a = account(r, 2027, "sippA").withdrawals;
    // B's pension fills B's personal allowance; A's pension pays the rest inside A's bands.
    expect(b).toBeGreaterThan(PA_GROSS - 2);
    expect(b).toBeLessThanOrEqual(PA_GROSS + 1e-6);
    expect(p.taxes.facts["tax.ordinaryBracketRate.a"]).toBe(0.2);
    expect(p.taxes.facts["tax.ordinaryBracketRate.b"]).toBe(0);
    // Tax is 20% of A's taxable pension above A's own allowance.
    expect(p.taxes.total).toBeCloseTo(0.2 * (a * UFPLS_TAXABLE - PA), 0);
    expect(account(r, 2027, "isaA").withdrawals + account(r, 2027, "isaB").withdrawals).toBe(0);
    expectInvariants(r);
  });

  it("to the basic-rate band: stops at its top and the next entry pays the rest", () => {
    const top = PA + UK.income.basicRateBand; // 50,270 of taxable income
    const r = simulate(
      sim({
        location: { country: "GB" },
        births: ["1966-01"],
        accounts: [acct("sipp", "uk-sipp", 500_000), acct("isa", "uk-isa", 200_000)],
        plan: {
          tax: { mode: "estimate" },
          expenses: [living(80_000)],
          drawdown: { order: [fill(0.2), cat("tax-free")] },
        },
        years: 1,
      }),
    );
    const p = period(r, 2027);
    expect(p.taxes.facts["uk.adjustedNetIncome.me"]).toBeLessThanOrEqual(top);
    expect(p.taxes.facts["uk.adjustedNetIncome.me"]).toBeGreaterThan(top - 2);
    expect(p.taxes.facts["tax.ordinaryBracketRate.me"]).toBe(0.2);
    expect(account(r, 2027, "isa").withdrawals).toBeGreaterThan(0);
  });
});

describe("drawdown entry: fill to a tax ceiling (US, taxed jointly)", () => {
  it("fills the 12% bracket from the IRAs, then draws the taxable account and the Roth together", () => {
    const r = usCouple(200_000, {
      order: [fill(0.12), { kind: "proportional", accountIds: ["tx", "rothA"] }],
    });
    const p = period(r, 2027);
    expect(p.taxes.facts["us.ordinaryTaxableIncome"]).toBeLessThanOrEqual(TOP_OF_12_MFJ);
    expect(p.taxes.facts["us.ordinaryTaxableIncome"]).toBeGreaterThan(TOP_OF_12_MFJ - 2);
    expect(p.taxes.facts["tax.ordinaryBracketRate"]).toBe(0.12);
    // One household room: the larger IRA is drawn first and no owner is recorded.
    expect(account(r, 2027, "iraA").withdrawals).toBeGreaterThan(0);
    expect(account(r, 2027, "iraB").withdrawals).toBe(0);
    const fills = rules(r, 2027).filter((l) => l.rule!.kind === "fill-to-ceiling");
    expect(fills.length).toBeGreaterThan(0);
    for (const l of fills) {
      expect(l.rule!.owner).toBeUndefined();
      expect(l.rule!.ceiling).toBe("top of the 12% band");
    }
    // The rest: taxable and Roth in proportion to their balances (300k : 200k).
    const tx = account(r, 2027, "tx").withdrawals;
    const roth = account(r, 2027, "rothA").withdrawals;
    expect(tx).toBeGreaterThan(0);
    expect(tx / roth).toBeCloseTo(1.5, 6);
    expectInvariants(r);
  });

  it("when spending is below the ceiling, the IRA pays it all and the ceiling is not reached", () => {
    const r = usCouple(60_000, { order: [fill(0.12), cat("taxable")] });
    expect(account(r, 2027, "tx").withdrawals).toBe(0);
    expect(period(r, 2027).taxes.facts["us.ordinaryTaxableIncome"]).toBeLessThan(TOP_OF_12_MFJ);
  });

  it("required minimum distributions already above the ceiling: the entry draws nothing", () => {
    // Born 1950: 77 in 2027, so RMDs apply. A 0% ceiling (the standard deduction) is already
    // exceeded by the RMD, so the fill entry adds nothing and the taxable account pays the rest.
    const r = simulate(
      sim({
        location: { country: "US", region: "TX" },
        births: ["1950-01", "1950-01"],
        accounts: [
          acct("tx", "taxable", 500_000, { owner: "joint", costBasis: 500_000 }),
          acct("iraA", "traditional-ira", 2_000_000, { owner: "a" }),
        ],
        plan: {
          tax: { mode: "estimate", filingStatus: "married-joint" },
          expenses: [living(150_000)],
          drawdown: { order: [fill(0), cat("taxable")] },
        },
        years: 1,
      }),
    );
    const p = period(r, 2027);
    expect(account(r, 2027, "iraA").withdrawals).toBeGreaterThan(0); // the RMD
    expect(p.taxes.facts["tax.ordinaryBracketRate"]).toBeGreaterThan(0);
    expect(rules(r, 2027)).toHaveLength(0);
    expect(r.trace.some((t) => t.code === "DRAWDOWN_FILL")).toBe(false);
    expect(account(r, 2027, "tx").withdrawals).toBeGreaterThan(0);
  });
});

describe("validation and explanations", () => {
  it("rejects a fill entry naming an account that is not pre-tax, and unknown accounts", () => {
    const run = (order: Entry[]) =>
      simulate(
        sim({
          accounts: [acct("isa", "uk-isa", 1_000), acct("sipp", "uk-sipp", 1_000)],
          plan: { drawdown: { order } },
          years: 1,
        }),
      );
    expect(() => run([fill(0, ["isa"])])).toThrow(ScenarioError);
    expect(() => run([fill(0, ["nope"])])).toThrow(ScenarioError);
    expect(() => run([{ kind: "proportional", accountIds: ["isa", "nope"] }])).toThrow(
      ScenarioError,
    );
    expect(() => run([fill(0, ["sipp"])])).not.toThrow();
  });

  it("the year narrative names the rule behind each withdrawal", () => {
    const input = SimulationInput.parse(
      sim({
        location: { country: "GB" },
        births: ["1966-01"],
        accounts: [acct("sipp", "uk-sipp", 300_000), acct("isa", "uk-isa", 100_000)],
        plan: {
          tax: { mode: "estimate" },
          expenses: [living(17_000)],
          drawdown: { order: [fill(0), cat("tax-free")] },
        },
        years: 1,
      }),
    );
    const r = simulate(input);
    const n = explainYear(input, r, 0);
    expect(n.withdrawals.some((w) => w.label.includes("fills Me's 0% band"))).toBe(true);
  });
});

describe("existing plans are unchanged", () => {
  it("plans without blended entries carry no drawdown rule in the ledger or trace", () => {
    for (const [doc, id] of [
      [createSampleDocument(), SAMPLE_PLAN_ID],
      [createUkSampleDocument(), UK_SAMPLE_PLAN_ID],
    ] as const) {
      const r = simulate(buildSimulationInput(doc, id));
      for (const p of r.periods) for (const l of p.ledger) expect(l).not.toHaveProperty("rule");
      expect(r.trace.some((t) => t.code === "DRAWDOWN_FILL")).toBe(false);
    }
  });
});

describe("schema 6 -> 7: blended drawdown entries", () => {
  it("is the current version; a v6 document loads unchanged; a v7 one may use the new entries", () => {
    expect(SCHEMA_VERSION).toBe(7);
    const v6 = { ...structuredClone(createUkSampleDocument()), schemaVersion: 6 };
    const migrated = migrateDocument(structuredClone(v6));
    expect(migrated).toEqual(migrateDocument({ ...structuredClone(v6), schemaVersion: 7 }));
    const v7 = structuredClone(v6) as unknown as {
      schemaVersion: number;
      plans: { id: string; drawdown: { order: unknown[] } }[];
    };
    v7.schemaVersion = 7;
    const plan = v7.plans.find((p) => p.id === UK_SAMPLE_PLAN_ID)!;
    plan.drawdown.order = [{ kind: "fillToCeiling", ceiling: { kind: "bracket", rate: 0.2 } }];
    const loaded = migrateDocument(v7);
    expect(loaded.plans.find((p) => p.id === UK_SAMPLE_PLAN_ID)!.drawdown.order[0]).toEqual({
      kind: "fillToCeiling",
      ceiling: { kind: "bracket", rate: 0.2 },
      accountIds: [],
    });
    expect(() => migrateDocument({ ...v7, schemaVersion: 8 })).toThrow(/newer than supported/);
  });
});
