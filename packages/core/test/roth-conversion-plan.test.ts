/**
 * Roth conversion plan (solvers/roth-conversion-plan.ts).
 *
 * Expected rooms come from the official tables already in tax/data/us-federal.ts, not from the
 * planner's own output:
 *   - 2027 brackets and standard deduction: Rev. Proc. 2026-35 sections 3.01 and 3.15
 *     (https://www.irs.gov/pub/irs-drop/rp-26-35.pdf, as cited in US_FEDERAL_2027).
 *     Single: the 22% bracket starts at $52,025 of taxable income; standard deduction $16,600, so
 *     ordinary income up to $68,625 stays in the 12% bracket. Married filing jointly: 22% starts at
 *     $104,050, 24% at $218,250; standard deduction $33,200.
 *   - 2027 IRMAA: CMS fact sheet of 17 November 2026 (US_IRMAA_2027): no surcharge for a single
 *     filer with MAGI of $112,000 or less.
 *   - 2027 ACA: 2026 HHS poverty guideline $15,960 for one person (US_ACA_2027) and the 400% cliff
 *     (Rev. Proc. 2025-25 / Form 8962 instructions, US_ACA_2026): ACA MAGI up to $63,840.
 * The tests read those figures from the tables so a corrected table moves the expectation with it.
 */
import { describe, expect, it } from "vitest";
import {
  applyPlanPatch,
  planRothConversions,
  type RothConversionPlan,
  SimulationInput,
  simulate,
  US_ACA_YEARS,
  US_FEDERAL_YEARS,
  US_IRMAA_YEARS,
} from "../src/index.js";
import { acct, always, period, sim } from "./engine-helpers.js";

const Y27 = US_FEDERAL_YEARS.find((y) => y.year === 2027)!;
const bracketStart = (status: "single" | "married-joint", rate: number) =>
  Y27.brackets[status].find(([, r]) => r === rate)![0];
/** Ordinary income that fills the single 12% bracket in 2027: $52,025 + $16,600 = $68,625. */
const SINGLE_TOP_12 = bracketStart("single", 0.22) + Y27.standardDeduction.single;
const IRMAA_SINGLE_27 = US_IRMAA_YEARS.find((y) => y.year === 2027)!.single[0]![0];
const ACA_27 = US_ACA_YEARS.find((y) => y.year === 2027)!;
const ACA_LIMIT_1 = ACA_27.fpl.first * ACA_27.cliff;

const pension = (amount: number, owner = "me") => ({
  id: `pension-${owner}`,
  type: "pension" as const,
  name: "Pension",
  owner,
  amount: { value: amount, basis: "nominal" as const },
  frequency: "yearly" as const,
  range: always,
});

interface Opts {
  otherIncome?: number;
  years?: number;
  ira?: number;
  birth?: string;
  aca?: boolean;
  heirRate?: number;
  taxStrategy?: unknown;
}

function single(o: Opts = {}) {
  const input = SimulationInput.parse(
    sim({
      location: { country: "US", region: "TX" },
      births: [o.birth ?? "1966-01"],
      years: o.years ?? 1,
      accounts: [
        acct("c", "cash", 400_000),
        acct("ira", "traditional-ira", o.ira ?? 500_000),
        acct("roth", "roth-ira", 0),
      ],
      plan: {
        tax: {
          mode: "estimate",
          filingStatus: "single",
          ...(o.heirRate !== undefined
            ? {
                estate: {
                  heirTaxDeferredRate: o.heirRate,
                  heirCapitalGainsRate: 0,
                  liquidationCostRate: 0,
                  adminCostRate: 0,
                  charitableShare: 0,
                  stepUpBasis: true,
                },
              }
            : {}),
        } as never,
        drawdown: { order: [{ kind: "category", category: "cash" }] },
        income: o.otherIncome ? [pension(o.otherIncome)] : [],
        expenses: o.aca
          ? [
              {
                id: "aca",
                type: "healthcare",
                name: "ACA",
                owner: "me",
                amount: { value: 500 },
                frequency: "monthly",
                range: always,
                healthcare: { kind: "aca", benchmarkPremium: { value: 600 } },
              } as never,
            ]
          : [],
        ...(o.taxStrategy ? { taxStrategy: o.taxStrategy as never } : {}),
      },
    }),
  );
  input.household.currency = "USD";
  input.household.locale = "en-US";
  return input;
}

const row = (r: RothConversionPlan, year = 2027, personId = "me") => {
  const x = r.schedule.find((s) => s.year === year && s.personId === personId);
  if (!x) throw new Error(`no schedule row ${year} ${personId}`);
  return x;
};

/** Apply the plan's patch and run it: the year the user would get. */
function applied(input: SimulationInput, r: RothConversionPlan) {
  const plan = applyPlanPatch(input.plan, r.patch);
  return simulate({ ...input, plan, options: { trace: "summary" } });
}

describe("Roth conversion plan: bracket ceiling", () => {
  it("with no other income converts exactly to the top of the 12% bracket", async () => {
    const input = single();
    const r = await planRothConversions(input, { targets: [{ bracketRate: 0.12 }] });
    const y = row(r);
    expect(y.amount).toBe(SINGLE_TOP_12);
    expect(y.binding).toBe("bracket");
    expect(y.roomLeft).toBe(0);
    // Tax on $52,025 of taxable income, single 2027: 10% x 12,800 + 12% x 39,225 = 5,987.
    expect(y.taxOnConversion).toBeCloseTo(0.1 * 12_800 + 0.12 * (52_025 - 12_800), 0);
    expect(y.reason).toContain("the top of the 12% bracket");
  });

  it("just below: other income + conversion lands exactly on the bracket top", async () => {
    const input = single({ otherIncome: SINGLE_TOP_12 - 1_000 });
    const r = await planRothConversions(input, { targets: [{ bracketRate: 0.12 }] });
    const y = row(r);
    expect(y.otherIncome.agi).toBe(SINGLE_TOP_12 - 1_000);
    expect(y.amount).toBe(1_000);
    const p = period(applied(input, r), 2027);
    expect(p.taxes.facts.agi).toBe(SINGLE_TOP_12);
    expect(p.taxes.facts["tax.ordinaryBracketRate"]).toBe(0.12);
    // One dollar more would have crossed into 22%.
    const over = applyPlanPatch(input.plan, [
      ...r.patch.slice(0, -1),
      {
        op: "add",
        path: "/flows/-",
        value: {
          ...(r.patch.at(-1) as { value: Record<string, unknown> }).value,
          amount: { kind: "amount", amount: { value: 1_001, basis: "nominal" }, frequency: "once" },
        },
      } as never,
    ]);
    const p2 = period(simulate({ ...input, plan: over }), 2027);
    expect(p2.taxes.facts["tax.ordinaryBracketRate"]).toBe(0.22);
  });

  it("at the ceiling: no conversion, with the reason", async () => {
    const r = await planRothConversions(single({ otherIncome: SINGLE_TOP_12 }), {
      targets: [{ bracketRate: 0.12 }],
    });
    const y = row(r);
    expect(y.amount).toBe(0);
    expect(y.binding).toBe("already-above-ceiling");
    expect(y.reason).toMatch(/already at or above the top of the 12% bracket/);
    expect(r.patch).toEqual([]);
  });

  it("just above: other income already exceeds the ceiling, conversion is zero", async () => {
    const r = await planRothConversions(single({ otherIncome: SINGLE_TOP_12 + 1 }), {
      targets: [{ bracketRate: 0.12 }],
    });
    expect(row(r).amount).toBe(0);
    expect(row(r).binding).toBe("already-above-ceiling");
    expect(r.outcomes.map((o) => o.id)).toEqual(["none"]);
  });

  it("is capped by what is left in the traditional account", async () => {
    const r = await planRothConversions(single({ ira: 10_000 }), {
      targets: [{ bracketRate: 0.12 }],
    });
    expect(row(r).amount).toBe(10_000);
    expect(row(r).binding).toBe("balance");
  });
});

describe("Roth conversion plan: IRMAA ceiling (someone 63 or older)", () => {
  const at65 = (other: number) => single({ birth: "1962-01", otherIncome: other });
  const req = { targets: [{ bracketRate: 0.32 }], irmaaTier: 1 };

  it("just below: converts up to the first IRMAA threshold", async () => {
    const input = at65(IRMAA_SINGLE_27 - 1_000);
    const r = await planRothConversions(input, req);
    expect(row(r).amount).toBe(1_000);
    expect(row(r).binding).toBe("irmaa");
    expect(period(applied(input, r), 2027).taxes.facts.magi).toBe(IRMAA_SINGLE_27);
  });

  it("at the threshold: no room", async () => {
    const r = await planRothConversions(at65(IRMAA_SINGLE_27), req);
    expect(row(r).amount).toBe(0);
    expect(row(r).binding).toBe("already-above-ceiling");
    expect(row(r).reason).toContain("IRMAA");
  });

  it("just above: no room", async () => {
    const r = await planRothConversions(at65(IRMAA_SINGLE_27 + 1), req);
    expect(row(r).amount).toBe(0);
  });

  it("does not apply to someone under 63", async () => {
    const r = await planRothConversions(
      single({ birth: "1977-01", otherIncome: IRMAA_SINGLE_27 }),
      req,
    );
    expect(row(r).ceilings.map((c) => c.kind)).toEqual(["bracket"]);
    expect(row(r).amount).toBeGreaterThan(0);
  });
});

describe("Roth conversion plan: ACA ceiling (marketplace years)", () => {
  const onAca = (other: number) => single({ birth: "1977-01", aca: true, otherIncome: other });
  const req = { targets: [{ bracketRate: 0.22 }] };

  it("just below: converts up to the premium tax credit limit", async () => {
    const input = onAca(ACA_LIMIT_1 - 1_000);
    const r = await planRothConversions(input, req);
    expect(row(r).amount).toBe(1_000);
    expect(row(r).binding).toBe("aca");
    const f = period(applied(input, r), 2027).taxes.facts;
    expect(f["us.acaMagi"] ?? f.agi).toBe(ACA_LIMIT_1);
  });

  it("at the limit: no room", async () => {
    const r = await planRothConversions(onAca(ACA_LIMIT_1), req);
    expect(row(r).amount).toBe(0);
    expect(row(r).reason).toContain("ACA");
  });

  it("just above: no room", async () => {
    const r = await planRothConversions(onAca(ACA_LIMIT_1 + 1), req);
    expect(row(r).amount).toBe(0);
  });

  it("can be switched off", async () => {
    const r = await planRothConversions(onAca(ACA_LIMIT_1), { ...req, aca: false });
    expect(row(r).ceilings.map((c) => c.kind)).toEqual(["bracket"]);
    expect(row(r).amount).toBeGreaterThan(0);
  });
});

describe("Roth conversion plan: a couple with different targets", () => {
  const couple = () => {
    const input = SimulationInput.parse(
      sim({
        location: { country: "US", region: "TX" },
        births: ["1966-01", "1967-01"],
        years: 1,
        accounts: [
          acct("c", "cash", 400_000, { owner: "joint" }),
          acct("ira-a", "traditional-ira", 500_000, { owner: "a" }),
          acct("ira-b", "traditional-ira", 500_000, { owner: "b" }),
          acct("roth-a", "roth-ira", 0, { owner: "a" }),
        ],
        plan: {
          tax: { mode: "estimate", filingStatus: "married-joint" },
          drawdown: { order: [{ kind: "category", category: "cash" }] },
        },
      }),
    );
    input.household.currency = "USD";
    return input;
  };
  const top12 = bracketStart("married-joint", 0.22) + Y27.standardDeduction["married-joint"];
  const top22 = bracketStart("married-joint", 0.24) + Y27.standardDeduction["married-joint"];

  it("the lower ceiling converts first; the higher one fills on top of it", async () => {
    const input = couple();
    const r = await planRothConversions(input, {
      targets: [
        { personId: "a", bracketRate: 0.22 },
        { personId: "b", bracketRate: 0.12 },
      ],
    });
    expect(row(r, 2027, "b").amount).toBe(top12);
    expect(row(r, 2027, "a").amount).toBe(top22 - top12);
    const p = period(applied(input, r), 2027);
    expect(p.taxes.facts.agi).toBe(top22);
    expect(p.taxes.facts["tax.ordinaryBracketRate"]).toBe(0.22);
    // B has no Roth IRA: the change set opens one for the conversions.
    expect(r.patch.some((op) => op.path === "/plannedAccounts/-")).toBe(true);
  });
});

describe("Roth conversion plan: choosing and comparing", () => {
  it("says plainly when no conversions is the better answer", async () => {
    // Heirs pay no tax on what is left in the IRA and the plan is short: converting only adds tax.
    const r = await planRothConversions(single({ years: 3, heirRate: 0 }));
    expect(r.status).toBe("ok");
    expect(r.verdict).toBe("no-conversions");
    expect(r.patch).toEqual([]);
    expect(r.summary).toMatch(/making no conversions looks best/);
    expect(r.outcomes[0]!.id).toBe("none");
  });

  it("proposes a schedule when it raises after-tax wealth, and is reproducible", async () => {
    const input = single({ years: 4, heirRate: 0.37, ira: 400_000 });
    const a = await planRothConversions(input, { maxEvaluations: 40 });
    const b = await planRothConversions(input, { maxEvaluations: 40 });
    expect(b).toEqual(a);
    expect(a.verdict).toBe("convert");
    const none = a.outcomes.find((o) => o.id === "none")!;
    const proposed = a.outcomes.find((o) => o.id === "proposed")!;
    expect(proposed.afterTaxEndWealthReal).toBeGreaterThan(none.afterTaxEndWealthReal);
    // Applying the change set gives the scheduled conversions.
    const res = applied(input, a);
    for (const s of a.schedule.filter((x) => x.amount > 0)) {
      const idx = res.periods.findIndex((p) => p.year === s.year);
      const conv = res.trace
        .filter((t) => t.code === "ROTH_CONVERSION" && t.periodIndex === idx)
        .reduce((sum, t) => sum + Number(t.data?.amount ?? 0), 0);
      expect(conv).toBeCloseTo(s.amount, 0);
    }
  });

  it("compares with the plan's current tax strategy and switches its conversions off", async () => {
    const input = single({
      years: 3,
      heirRate: 0.37,
      taxStrategy: { enabled: true, target: { kind: "bracket", rate: 0.24 } },
    });
    const r = await planRothConversions(input, { targets: [{ bracketRate: 0.12 }] });
    expect(r.outcomes.map((o) => o.id)).toEqual(["none", "current", "proposed"]);
    expect(r.outcomes[1]!.totalConvertedReal).toBeGreaterThan(r.outcomes[2]!.totalConvertedReal);
    expect(r.patch[0]).toEqual({
      op: "replace",
      path: "/taxStrategy/modules/rothConversions",
      value: false,
    });
  });

  it("is US-only", async () => {
    const input = single();
    input.household.location = { country: "GB" };
    const r = await planRothConversions(input);
    expect(r.status).toBe("unsupported");
    expect(r.patch).toEqual([]);
  });
});
