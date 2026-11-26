/**
 * "Why did my number change?" (insights/result-change.ts). The inputs have zero returns, inflation and tax,
 * so every expected figure is plain arithmetic: end net worth = starting cash - years left x spending.
 */
import { describe, expect, it } from "vitest";
import {
  applyPlanPatch,
  attributeResultChange,
  expectedFinances,
  type HeadlineValues,
  RESULT_CHANGE_ORDER,
  type ResultChange,
  type ResultCheckpoint,
  resultFingerprints,
  simulate,
  type SimulationInput,
} from "../src/index.js";
import { expense, fakeMonteCarlo, makeInput } from "./solvers-helpers.js";

/** £200,000 cash, £5,000 a year of spending, 2027-01 to 2047-01: ends with £100,000. */
const base = (): SimulationInput =>
  makeInput({
    accounts: [{ id: "cash", name: "Cash", type: "cash", owner: "me", balance: 200_000 }],
    plan: { expenses: [expense("living", 5_000)] },
    years: 20,
  });

const point = (i: SimulationInput, stored?: Partial<HeadlineValues>, fp = {}): ResultCheckpoint => {
  const r = simulate({ ...i, options: { ...i.options, trace: "off" } });
  return {
    household: i.household,
    finances: i.finances,
    plan: i.plan,
    ...(stored
      ? {
          stored: {
            values: {
              successRate: null,
              fiYear: null,
              endNetWorthReal: r.summary.endNetWorthReal,
              ...stored,
            },
            fingerprints: { ...resultFingerprints(), ...fp },
          },
        }
      : {}),
  };
};

const withCash = (
  i: SimulationInput,
  balance: number,
  asOf = i.finances.asOf,
): SimulationInput => ({
  ...i,
  finances: { ...i.finances, asOf, accounts: [{ ...i.finances.accounts[0]!, balance }] },
});

const nw = (r: ResultChange) => r.metrics.find((m) => m.metric === "endNetWorthReal")!;
const part = (r: ResultChange, cause: string) => nw(r).parts.find((p) => p.cause === cause)!.delta!;
const sumParts = (r: ResultChange, metric = "endNetWorthReal") => {
  const m = r.metrics.find((x) => x.metric === metric)!;
  return m.parts.reduce((s, p) => s + (p.delta ?? 0), 0) + (m.unexplained ?? 0);
};

describe("attributeResultChange", () => {
  it("says so when nothing changed", async () => {
    const i = base();
    const r = await attributeResultChange(point(i, {}), point(i));
    expect(r.noChange).toBe(true);
    expect(nw(r).before).toBeCloseTo(100_000, 6);
    expect(nw(r).total).toBeCloseTo(0, 6);
    for (const p of nw(r).parts) expect(p.delta).toBeCloseTo(0, 6);
    expect(nw(r).unexplained).toBeCloseTo(0, 6);
    expect(r.summary[0]).toMatch(/^Nothing changed/);
    expect(r.order).toEqual(["glideworth", "time", "balances", "household", "plan"]);
    expect(r.method).toMatch(/order/);
    expect(r.notes.join(" ")).toMatch(/estimates/i);
  });

  it("names a plan edit and sizes it: £1,000 more a year for 20 years is -£20,000", async () => {
    const i = base();
    const after = {
      ...i,
      plan: applyPlanPatch(i.plan, [
        { op: "replace", path: "/expenses/[id=living]/amount/value", value: 6_000 },
      ]),
    };
    const r = await attributeResultChange(point(i, {}), point(after));
    expect(r.noChange).toBe(false);
    expect(nw(r).total).toBeCloseTo(-20_000, 6);
    expect(part(r, "plan")).toBeCloseTo(-20_000, 6);
    for (const c of ["glideworth", "time", "balances", "household"])
      expect(part(r, c)).toBeCloseTo(0, 6);
    const plan = nw(r).parts.find((p) => p.cause === "plan")!;
    expect(plan.edits).toHaveLength(1);
    expect(plan.edits![0]!.key).toBe("/expenses/[id=living]");
    expect(plan.edits![0]!.delta).toBeCloseTo(-20_000, 6);
    expect(plan.interaction).toBeCloseTo(0, 6);
    expect(r.steps.find((s) => s.cause === "plan")!.details.join(" ")).toMatch(/living/);
    expect(r.steps.filter((s) => s.changed).map((s) => s.cause)).toEqual(["plan"]);
  });

  it("sizes updated balances alone: £10,000 more cash is +£10,000 at the end", async () => {
    const i = base();
    const r = await attributeResultChange(point(i, {}), point(withCash(i, 210_000)));
    expect(nw(r).total).toBeCloseTo(10_000, 6);
    expect(part(r, "balances")).toBeCloseTo(10_000, 6);
    expect(part(r, "time")).toBeCloseTo(0, 6);
    expect(part(r, "plan")).toBeCloseTo(0, 6);
    expect(r.steps.find((s) => s.cause === "balances")!.details).toEqual([
      "1 account value updated",
    ]);
  });

  it("the passage of time alone moves nothing when balances are exactly what the plan expected", async () => {
    const i = base();
    // A year on, the plan expected 200,000 - 5,000 = 195,000.
    const r = await attributeResultChange(point(i, {}), point(withCash(i, 195_000, "2028-01")));
    expect(nw(r).total).toBeCloseTo(0, 6);
    expect(part(r, "time")).toBeCloseTo(0, 6);
    expect(part(r, "balances")).toBeCloseTo(0, 6);
    const time = r.steps.find((s) => s.cause === "time")!;
    expect(time.changed).toBe(true);
    expect(time.details[0]).toBe("Start moved from 2027-01 to 2028-01 (12 months)");
  });

  it("splits a year gone by from balances below plan: actual 190,000 against an expected 195,000", async () => {
    const i = base();
    const r = await attributeResultChange(point(i, {}), point(withCash(i, 190_000, "2028-01")));
    expect(nw(r).total).toBeCloseTo(-5_000, 6);
    expect(part(r, "time")).toBeCloseTo(0, 6);
    expect(part(r, "balances")).toBeCloseTo(-5_000, 6);
  });

  it("interpolates the expected balance within the year", () => {
    const i = base();
    const r = simulate({ ...i, options: { ...i.options, trace: "off" } });
    // Half-way through 2027 the plan expected 200,000 - 2,500.
    const f = expectedFinances(i.finances, r, "2027-07");
    expect(f.asOf).toBe("2027-07");
    expect(f.accounts[0]!.balance).toBeCloseTo(197_500, 6);
    expect(expectedFinances(i.finances, r, "2027-01").accounts[0]!.balance).toBe(200_000);
  });

  it("measures household changes as their own step", async () => {
    const i = base();
    const after = {
      ...i,
      household: { ...i.household, people: [{ ...i.household.people[0]!, name: "Sam B" }] },
    };
    const r = await attributeResultChange(point(i, {}), point(after));
    const step = r.steps.find((s) => s.cause === "household")!;
    expect(step.changed).toBe(true);
    expect(step.details).toEqual(["Changed: people"]);
    expect(part(r, "household")).toBeCloseTo(0, 6);
    expect(r.noChange).toBe(false);
  });

  it("puts an engine version change on Glideworth's side and names it", async () => {
    const i = base();
    // The check-in stored 101,234 under engine 0.0.1; today's engine gives 100,000 for the same inputs.
    const r = await attributeResultChange(
      point(i, { endNetWorthReal: 101_234 }, { engineVersion: "0.0.1" }),
      point(i),
    );
    expect(nw(r).total).toBeCloseTo(-1_234, 6);
    expect(part(r, "glideworth")).toBeCloseTo(-1_234, 6);
    expect(nw(r).unexplained).toBeCloseTo(0, 6);
    const gw = r.steps.find((s) => s.cause === "glideworth")!;
    expect(gw.changed).toBe(true);
    expect(gw.details[0]).toMatch(/^Engine version 0\.0\.1 → /);
    expect(r.noChange).toBe(false);
  });

  it("names updated tax tables and market history", async () => {
    const i = base();
    const r = await attributeResultChange(
      point(i, { endNetWorthReal: 99_000 }, { taxTables: "00000000", marketData: "00000000" }),
      point(i),
    );
    expect(part(r, "glideworth")).toBeCloseTo(1_000, 6);
    expect(r.steps.find((s) => s.cause === "glideworth")!.details).toEqual([
      "Tax tables updated",
      "Market history updated",
    ]);
  });

  it("shows a difference with no fingerprint change as unexplained, not as Glideworth's side", async () => {
    const i = base();
    const r = await attributeResultChange(point(i, { endNetWorthReal: 100_500 }), point(i));
    expect(nw(r).total).toBeCloseTo(-500, 6);
    expect(part(r, "glideworth")).toBe(0);
    expect(nw(r).unexplained).toBeCloseTo(-500, 6);
    expect(r.summary.join(" ")).toMatch(/unexplained/);
  });

  it("several causes together: the parts add up to the total", async () => {
    const i = base();
    const after = withCash(
      {
        ...i,
        plan: applyPlanPatch(i.plan, [
          { op: "replace", path: "/expenses/[id=living]/amount/value", value: 4_000 },
          { op: "add", path: "/expenses/-", value: expense("travel", 2_000) },
        ]),
      },
      185_000,
      "2028-01",
    );
    const r = await attributeResultChange(
      point(i, { endNetWorthReal: 100_100 }, { engineVersion: "0.0.1" }),
      point(after),
    );
    // Now: 185,000 - 19 x 6,000 = 71,000. Before (stored): 100,100.
    expect(nw(r).after).toBeCloseTo(71_000, 6);
    expect(nw(r).total).toBeCloseTo(-29_100, 6);
    expect(part(r, "glideworth")).toBeCloseTo(-100, 6);
    expect(part(r, "time")).toBeCloseTo(0, 6);
    expect(part(r, "balances")).toBeCloseTo(-10_000, 6); // 185,000 against an expected 195,000
    expect(part(r, "plan")).toBeCloseTo(-19_000, 6); // 19 years x 1,000 more
    expect(sumParts(r)).toBeCloseTo(nw(r).total!, 6);
    const plan = nw(r).parts.find((p) => p.cause === "plan")!;
    const byKey = Object.fromEntries(plan.edits!.map((e) => [e.key, e.delta]));
    expect(byKey["/expenses/[id=living]"]).toBeCloseTo(19_000, 6);
    expect(byKey["/expenses/[id=travel]"]).toBeCloseTo(-38_000, 6);
    expect(plan.interaction).toBeCloseTo(0, 6);
    expect(r.summary[0]).toMatch(/^Net worth at the end of the plan: /);
  });

  it("splits the chance of success with the same trials and seed for every step", async () => {
    const i = base();
    const calls: { seed: number | null }[] = [];
    const evaluate = fakeMonteCarlo({ trials: 40, calls });
    const lean = {
      ...i,
      plan: applyPlanPatch(i.plan, [
        { op: "replace", path: "/expenses/[id=living]/amount/value", value: 9_500 },
      ]),
    };
    const after = withCash(
      {
        ...lean,
        plan: applyPlanPatch(lean.plan, [
          { op: "replace", path: "/expenses/[id=living]/amount/value", value: 10_500 },
        ]),
      },
      205_000,
    );
    const before = point(lean, { successRate: 0.5 }, { marketData: "00000000" });
    const r = await attributeResultChange(
      before,
      point(after),
      { monteCarlo: { trials: 40, seed: 7 } },
      { evaluate },
    );
    expect(new Set(calls.map((c) => c.seed))).toEqual(new Set([7]));
    const sr = r.metrics.find((m) => m.metric === "successRate")!;
    expect(sr.before).toBe(0.5);
    expect(sr.total).not.toBeNull();
    expect(sumParts(r, "successRate")).toBeCloseTo(sr.total!, 9);
    const plan = sr.parts.find((p) => p.cause === "plan")!;
    expect(plan.edits![0]!.delta).toBeNull();
    expect(r.metrics.map((m) => m.metric)).toEqual(["successRate", "fiYear", "endNetWorthReal"]);
  });

  it("from one stored check-in to a later one, both ends count Glideworth's side", async () => {
    const i = base();
    const later = withCash(i, 205_000);
    const r = await attributeResultChange(
      point(i, { endNetWorthReal: 100_000 }),
      point(later, { endNetWorthReal: 104_000 }, { engineVersion: "0.0.1" }),
    );
    // Today's engine gives 105,000 for the later inputs; the later check-in stored 104,000 under 0.0.1.
    expect(nw(r).total).toBeCloseTo(4_000, 6);
    expect(part(r, "balances")).toBeCloseTo(5_000, 6);
    expect(part(r, "glideworth")).toBeCloseTo(-1_000, 6);
    expect(sumParts(r)).toBeCloseTo(4_000, 6);
  });

  it("the documented order is the one applied", () => {
    expect(RESULT_CHANGE_ORDER).toEqual(["glideworth", "time", "balances", "household", "plan"]);
  });
});
