import { describe, expect, it } from "vitest";
import {
  applyPlanPatch,
  attributeDifference,
  auditAssumptions,
  buildSimulationInput,
  careerBreakScenario,
  childScenario,
  diffPlans,
  downsizingScenario,
  earlyRetirementScenario,
  explainDifference,
  explainProjection,
  explainYear,
  explainYears,
  type Finding,
  inheritanceScenario,
  jobLossScenario,
  longTermCareScenario,
  marketCrashScenario,
  type SimulationInput,
  simulate,
  survivorScenario,
  survivorScenarios,
} from "../src/index.js";
import { createSampleDocument } from "../src/samples/index.js";
import { always, expense, makeInput } from "./solvers-helpers.js";

const codes = (fs: Finding[]) => fs.map((f) => f.code);

describe("explainProjection", () => {
  const failing = makeInput({
    accounts: [
      { id: "c", name: "Current account", type: "cash", owner: "me", balance: 20_000 },
      { id: "isa", name: "ISA", type: "uk-isa", owner: "me", balance: 30_000 },
      {
        id: "sipp",
        name: "SIPP",
        type: "uk-sipp",
        owner: "me",
        balance: 100_000,
        behaviour: { withdrawals: { kind: "from", ref: { kind: "age", personId: "me", age: 57 } } },
      },
    ],
    plan: {
      expenses: [
        expense("liv", 18_000, { name: "Living costs" }),
        expense("car", 4_000, { name: "Car", type: "transportation" }),
      ],
    },
    years: 12,
  });
  const r = simulate(failing);

  it("explains a failure: first shortfall year, what ran out, what was locked, drivers and a fix", () => {
    expect(r.summary.success).toBe(false);
    const e = explainProjection(failing, r);
    expect(e.headline).toMatch(/runs short from 2029/);
    const fail = e.findings.find((f) => f.code === "PLAN_FAILS")!;
    expect(fail.severity).toBe("critical");
    expect(fail.periodIndex).toBe(2);
    expect(fail.evidence.some((x) => x.source === "trace" && x.code === "SHORTFALL")).toBe(true);
    expect(fail.evidence.some((x) => x.source === "ledger" && x.kind === "shortfall")).toBe(true);
    expect(codes(e.findings)).toContain("ACCOUNT_EXHAUSTED");
    const exhausted = e.findings
      .filter((f) => f.code === "ACCOUNT_EXHAUSTED")
      .flatMap((f) => f.refs);
    expect(exhausted).toEqual(expect.arrayContaining(["c", "isa"]));
    const locked = e.findings.find((f) => f.code === "FUNDS_LOCKED")!;
    expect(locked.refs).toEqual(["sipp"]);
    expect(locked.message).toMatch(/becomes available in 2037/);
    const drivers = e.findings.find((f) => f.code === "SHORTFALL_DRIVERS")!;
    expect(drivers.message).toMatch(
      /^The largest demands that year were Living costs £18,000, Car £4,000/,
    );
    const fix = e.findings.find((f) => f.code === "SMALLEST_FIX_ESTIMATE")!;
    expect(fix.fix!.patch.map((p) => p.path)).toEqual([
      "/expenses/[id=liv]/amount/value",
      "/expenses/[id=car]/amount/value",
    ]);
    // Every finding cites evidence.
    for (const f of e.findings) expect(f.evidence.length).toBeGreaterThan(0);
  });

  it('answers "why did money come from X" from the trace', () => {
    const e = explainProjection(failing, r, "Why did money come from the ISA?");
    const w = e.findings.find((f) => f.code === "WITHDRAWAL_SOURCE")!;
    expect(w.refs).toEqual(["isa"]);
    expect(w.message).toMatch(/number \d+ in your drawdown order/);
    expect(w.message).toMatch(/Current account/);
    expect(w.evidence.every((x) => x.source === "trace" && x.code === "WITHDRAWAL")).toBe(true);
  });

  it("explains unreached metric milestones with the closest approach", () => {
    const input = makeInput({
      accounts: [{ id: "c", name: "Cash", type: "cash", owner: "me", balance: 10_000 }],
      plan: {
        income: [
          {
            id: "sal",
            type: "salary",
            name: "Salary",
            owner: "me",
            amount: { value: 10_000 },
            frequency: "yearly",
            range: always,
          },
        ],
        milestones: [
          {
            id: "fi",
            name: "Millionaire",
            kind: "financial-independence",
            criteria: [
              {
                kind: "metric",
                metric: { kind: "netWorth" },
                comparator: ">=",
                threshold: { kind: "amount", amount: { value: 1_000_000 } },
              },
            ],
          },
        ],
      },
      years: 5,
    });
    const e = explainProjection(input, simulate(input));
    expect(e.headline).toMatch(/^The plan works/);
    const ms = e.findings.find((f) => f.code === "MILESTONE_NEVER_REACHED")!;
    expect(ms.message).toBe(
      "Millionaire needs netWorth of £1,000,000; the closest the plan gets is £60,000 in 2031 (6% of the target, today's money).",
    );
  });

  it('builds per-year "where did the money go" narratives from the ledger', () => {
    const input = makeInput({
      accounts: [
        { id: "c", name: "Cash", type: "cash", owner: "me", balance: 1_000 },
        { id: "isa", name: "ISA", type: "uk-isa", owner: "me", balance: 0 },
      ],
      plan: {
        tax: { mode: "flat", flat: { ordinary: 0.2, capitalGains: 0, dividends: 0, local: 0 } },
        income: [
          {
            id: "sal",
            type: "salary",
            name: "Salary",
            owner: "me",
            amount: { value: 50_000 },
            frequency: "yearly",
            range: always,
          },
        ],
        expenses: [expense("liv", 25_000, { name: "Living" })],
        flows: [
          {
            kind: "contribution",
            id: "f-isa",
            name: "ISA",
            owner: "me",
            accountId: "isa",
            range: always,
            method: { kind: "amount", amount: { value: 10_000 }, frequency: "yearly" },
          },
        ],
      },
      years: 2,
    });
    const r = simulate(input);
    const y = explainYear(input, r, 0);
    expect(y.year).toBe(2027);
    expect(y.inflows).toEqual([{ label: "Salary", amount: 50_000, kind: "income", refId: "sal" }]);
    expect(y.outflows.find((o) => o.kind === "tax")!.amount).toBeCloseTo(10_000, 6);
    expect(y.contributions.find((c) => c.label === "ISA")!.amount).toBeCloseTo(10_000, 6);
    expect(y.sentences[0]).toBe(
      "In 2027 (Sam 47) £50,000 came in (today's money): Salary £50,000.",
    );
    expect(y.sentences[1]).toBe("£35,000 went out: Living £25,000, Taxes £10,000.");
    expect(y.evidence.every((e) => e.source === "ledger" || e.source === "trace")).toBe(true);
    expect(explainYears(input, r)).toHaveLength(2);
    expect(
      explainYear(input, r, 1).sentences.some((s) =>
        s.startsWith("Net worth rose from £16,000 to £31,000"),
      ),
    ).toBe(true);
  });
});

describe("explainDifference / attributeDifference", () => {
  const doc = createSampleDocument();
  const base = buildSimulationInput(doc, "plan-main");

  it("attributes the outcome change to individual edits (one-at-a-time replay)", async () => {
    const input = makeInput({
      accounts: [{ id: "c", name: "Cash", type: "cash", owner: "me", balance: 100_000 }],
      plan: { expenses: [expense("liv", 5_000), expense("fun", 1_000, { type: "travel" })] },
      years: 10,
    });
    const other = applyPlanPatch(input.plan, [
      { op: "replace", path: "/expenses/[id=liv]/amount/value", value: 6_000 },
      { op: "remove", path: "/expenses/[id=fun]" },
      { op: "replace", path: "/assumptions/cashReturn", value: { kind: "fixed", rate: 0 } },
    ]);
    const attr = await attributeDifference(input, other);
    // liv +1000/yr * 10 = -10,000; fun removed +10,000; total 0.
    expect(attr.total).toBeCloseTo(0, 6);
    const liv = attr.contributions.find((c) => c.key === "/expenses/[id=liv]")!;
    const fun = attr.contributions.find((c) => c.key === "/expenses/[id=fun]")!;
    expect(liv.delta!).toBeCloseTo(-10_000, 6);
    expect(fun.delta!).toBeCloseTo(10_000, 6);
    expect(fun.description).toBe("Removed expense: fun");
    expect(attr.interaction).toBeCloseTo(0, 6);
    const ex = explainDifference(
      simulate(input),
      simulate({ ...input, plan: other }),
      diffPlans(input.plan, other),
      attr,
    );
    expect(ex.findings.filter((f) => f.code === "CHANGE_IMPACT")).toHaveLength(2);
    expect(ex.findings.find((f) => f.code === "CHANGE_IMPACT")!.evidence[0]!.source).toBe("replay");
  });

  it("measures interaction when edits reinforce each other", async () => {
    const input = makeInput({
      accounts: [{ id: "c", name: "Cash", type: "cash", owner: "me", balance: 100_000 }],
      plan: {
        expenses: [expense("liv", 5_000)],
        assumptions: { cashReturn: { kind: "fixed", rate: 0.05 } },
      },
      years: 10,
    });
    const other = applyPlanPatch(input.plan, [
      { op: "replace", path: "/assumptions/cashReturn", value: { kind: "fixed", rate: 0.1 } },
      { op: "replace", path: "/expenses/[id=liv]/amount/value", value: 1_000 },
    ]);
    const attr = await attributeDifference(input, other);
    const sum = attr.contributions.reduce((s, c) => s + c.delta!, 0);
    expect(sum + attr.interaction).toBeCloseTo(attr.total, 6);
    expect(Math.abs(attr.interaction)).toBeGreaterThan(1);
  });

  it("explains the sample branch: retiring at 52 instead of 57", () => {
    const early = buildSimulationInput(doc, "plan-early");
    const ra = simulate(base);
    const rb = simulate(early);
    const d = diffPlans(base.plan, early.plan, { currency: "USD" });
    const ex = explainDifference(ra, rb, d, undefined, { locale: "en-US" });
    expect(ex.headline).toMatch(/^Ending net worth (rises|falls) by \$/);
    expect(codes(ex.findings)).toContain("RETIREMENT_MOVED");
    expect(
      ex.findings.some(
        (f) => f.code === "PLAN_CHANGE" && f.message === "Retirement moved from age 57 to 52",
      ),
    ).toBe(true);
    expect(codes(ex.findings)).toContain("PATHS_DIVERGE");
  });
});

describe("auditAssumptions", () => {
  const clean = (): SimulationInput =>
    makeInput({
      country: "GB",
      accounts: [
        { id: "cash", name: "Easy access", type: "savings", owner: "me", balance: 20_000 },
        { id: "isa", name: "ISA", type: "uk-isa", owner: "me", balance: 100_000 },
      ],
      plan: {
        milestones: [
          {
            id: "ret",
            name: "Retirement",
            kind: "retirement",
            personId: "me",
            criteria: [{ kind: "age", personId: "me", age: 60 }],
          },
          {
            id: "le",
            name: "Life expectancy",
            kind: "life-expectancy",
            personId: "me",
            criteria: [{ kind: "age", personId: "me", age: 95 }],
          },
        ],
        income: [
          {
            id: "sal",
            type: "salary",
            name: "Salary",
            owner: "me",
            amount: { value: 50_000 },
            frequency: "yearly",
            range: { start: { kind: "planStart" }, end: { kind: "milestone", milestoneId: "ret" } },
          },
          {
            id: "sp",
            type: "state-pension",
            name: "State Pension",
            owner: "me",
            amount: { value: 230 },
            frequency: "weekly",
            range: { start: { kind: "age", personId: "me", age: 68 }, end: { kind: "planEnd" } },
          },
        ],
        expenses: [
          expense("liv", 2_000, { name: "Living", frequency: "monthly" }),
          expense("care", 6_000, {
            name: "Care",
            type: "healthcare",
            range: { start: { kind: "age", personId: "me", age: 80 }, end: { kind: "planEnd" } },
          }),
        ],
        flows: [
          {
            kind: "contribution",
            id: "f-isa",
            name: "ISA saving",
            owner: "me",
            accountId: "isa",
            range: { start: { kind: "planStart" }, end: { kind: "milestone", milestoneId: "ret" } },
            method: { kind: "amount", amount: { value: 1_000 }, frequency: "monthly" },
          },
        ],
        assumptions: {
          inflation: { kind: "fixed", rate: 0.025 },
          stockReturn: { kind: "fixed", rate: 0.06 },
          dividendYield: { kind: "fixed", rate: 0.015 },
          cashReturn: { kind: "fixed", rate: 0.025 },
          end: { kind: "lastLifeExpectancy" },
        },
      },
    });

  it("is silent on a sensible plan", () => {
    expect(auditAssumptions(clean())).toEqual([]);
  });

  const mutate = (ops: Parameters<typeof applyPlanPatch>[1]) => {
    const i = clean();
    return { ...i, plan: applyPlanPatch(i.plan, ops) };
  };

  const cases: [string, Parameters<typeof applyPlanPatch>[1], string, Finding["severity"]][] = [
    [
      "returns above norms",
      [{ op: "replace", path: "/assumptions/stockReturn", value: { kind: "fixed", rate: 0.11 } }],
      "RETURNS_HIGH",
      "critical",
    ],
    [
      "inflation below target",
      [{ op: "replace", path: "/assumptions/inflation", value: { kind: "fixed", rate: 0.01 } }],
      "INFLATION_LOW",
      "warning",
    ],
    [
      "no late-life care",
      [{ op: "remove", path: "/expenses/[id=care]" }],
      "LATE_LIFE_CARE_MISSING",
      "warning",
    ],
    [
      "expenses ending at retirement",
      [
        {
          op: "replace",
          path: "/expenses/[id=liv]/range/end",
          value: { kind: "milestone", milestoneId: "ret" },
        },
      ],
      "EXPENSES_END_AT_RETIREMENT",
      "warning",
    ],
    [
      "missing State Pension",
      [{ op: "remove", path: "/income/[id=sp]" }],
      "STATE_PENSION_MISSING",
      "warning",
    ],
    [
      "short life expectancy",
      [{ op: "replace", path: "/milestones/[id=le]/criteria/0/age", value: 82 }],
      "LIFE_EXPECTANCY_SHORT",
      "warning",
    ],
    [
      "ISA over allowance",
      [{ op: "replace", path: "/flows/[id=f-isa]/method/amount/value", value: 2_500 }],
      "CONTRIBUTION_ABOVE_ALLOWANCE",
      "warning",
    ],
    [
      "yearly living cost that looks monthly",
      [{ op: "replace", path: "/expenses/[id=liv]/frequency", value: "yearly" }],
      "FREQUENCY_SUSPICIOUS",
      "info",
    ],
    [
      "essential cost not inflating",
      [{ op: "replace", path: "/expenses/[id=liv]/change", value: { kind: "none" } }],
      "EXPENSE_NOT_INFLATING",
      "info",
    ],
  ];
  for (const [name, ops, code, severity] of cases)
    it(`fires exactly ${code} for ${name}, with an applicable fix`, () => {
      const input = mutate(ops);
      const fs = auditAssumptions(input);
      expect(codes(fs)).toEqual([code]);
      expect(fs[0]!.severity).toBe(severity);
      expect(fs[0]!.message.length).toBeGreaterThan(20);
      if (fs[0]!.fix) {
        const fixed = { ...input, plan: applyPlanPatch(input.plan, fs[0]!.fix.patch) };
        expect(codes(auditAssumptions(fixed))).not.toContain(code);
      }
    });

  it("flags a thin emergency fund and housing double counting", () => {
    const i = clean();
    const withHome: SimulationInput = {
      ...i,
      finances: {
        ...i.finances,
        accounts: i.finances.accounts.map((a) => (a.id === "cash" ? { ...a, balance: 1_000 } : a)),
        realAssets: [
          {
            id: "home",
            name: "Home",
            type: "house",
            owner: "me",
            currentValue: 400_000,
            archived: false,
            loan: {
              id: "mort",
              balance: 150_000,
              interest: { apr: 0.04, method: "compound", compounding: "monthly" },
              monthlyPayment: { value: 900, basis: "nominal" },
            },
            behaviour: {
              ...i.finances.realAssets[0]?.behaviour,
              usage: "primary-residence",
              appreciation: { kind: "inflation", plus: 0 },
              maintenance: { kind: "none" },
              insurance: { kind: "none" },
              improvements: { kind: "none" },
              hoa: { kind: "none" },
              liquidateIfNeeded: false,
              excludeLoanFromLiquidNetWorth: false,
            },
          },
        ],
      },
      plan: applyPlanPatch(i.plan, [
        {
          op: "add",
          path: "/expenses/-",
          value: expense("mortgage", 900, {
            name: "Mortgage",
            type: "housing",
            frequency: "monthly",
          }),
        },
      ]),
    };
    const fs = auditAssumptions(withHome);
    expect(codes(fs)).toEqual(
      expect.arrayContaining([
        "HOUSING_DOUBLE_COUNTED",
        "EMERGENCY_BUFFER_LOW",
        "CONCENTRATION_PROPERTY",
      ]),
    );
    const dbl = fs.find((f) => f.code === "HOUSING_DOUBLE_COUNTED")!;
    expect(dbl.fix!.patch).toEqual([
      { op: "replace", path: "/expenses/[id=mortgage]/enabled", value: false },
    ]);
    const buf = fs.find((f) => f.code === "EMERGENCY_BUFFER_LOW")!;
    expect(buf.fix!.patch[0]).toMatchObject({ op: "add", path: "/flows/0" });
    expect(() => applyPlanPatch(withHome.plan, buf.fix!.patch)).not.toThrow();
  });

  it("runs result-based checks when given a projection", () => {
    const input = makeInput({
      accounts: [{ id: "c", name: "Cash", type: "cash", owner: "me", balance: 100_000 }],
      plan: {
        expenses: [
          expense("liv", 10_000),
          expense("kids", 10_000, {
            name: "School fees",
            range: { start: { kind: "planStart" }, end: { kind: "date", date: "2030-01" } },
          }),
        ],
      },
      years: 6,
    });
    const fs = auditAssumptions(input, { result: simulate(input) });
    const drop = fs.find((f) => f.code === "SPENDING_DROP")!;
    expect(drop.message).toMatch(/in 2030, when "School fees" stops/);
    expect(drop.refs).toEqual(["kids"]);
  });
});

describe("scenario templates and survivor scenarios", () => {
  const doc = createSampleDocument();
  const input = buildSimulationInput(doc, "plan-main");

  it("every template yields a valid plan patch", () => {
    const templates = [
      jobLossScenario(input, { incomeId: "inc-avery-salary", start: "2028-01", months: 9 }),
      careerBreakScenario(input, { personId: "p-jordan", start: "2029-01", months: 12 }),
      earlyRetirementScenario(input, { years: 3 }),
      downsizingScenario(input, { month: "2045-01", equityReleased: 150_000 }),
      childScenario(input, { birthMonth: "2028-06", annualCost: 12_000, childcareAnnual: 15_000 }),
      inheritanceScenario(input, { month: "2035-01", amount: 100_000 }),
      longTermCareScenario(input, {
        personId: "p-avery",
        fromAge: 85,
        annualCost: 60_000,
        years: 3,
      }),
      marketCrashScenario(input, { year: 2030, drop: 0.35 }),
    ];
    for (const t of templates) {
      expect(t.patch.length).toBeGreaterThan(0);
      const plan = applyPlanPatch(input.plan, t.patch);
      expect(diffPlans(input.plan, plan).changes.length).toBeGreaterThan(0);
    }
    const early = applyPlanPatch(input.plan, earlyRetirementScenario(input, { years: 3 }).patch);
    expect(
      simulate({ ...input, plan: early }).milestones.find((m) => m.milestoneId === "ms-retire")!
        .month,
    ).toBe("2038-03");
    const inherit = simulate({
      ...input,
      plan: applyPlanPatch(
        input.plan,
        inheritanceScenario(input, { month: "2035-01", amount: 100_000 }).patch,
      ),
    });
    expect(inherit.summary.endNetWorthReal).toBeGreaterThan(
      simulate(input).summary.endNetWorthReal,
    );
  });

  it('generates "what if partner dies at X" branches for each partner', () => {
    const all = survivorScenarios(input, { ages: [70, 80] });
    expect(all.map((s) => s.id)).toEqual([
      "survivor-p-avery-70",
      "survivor-p-avery-80",
      "survivor-p-jordan-70",
      "survivor-p-jordan-80",
    ]);
    const s = survivorScenario(input, { personId: "p-jordan", age: 75 });
    const plan = applyPlanPatch(input.plan, s.patch);
    const le = plan.milestones.find((m) => m.id === "ms-le-jordan")!;
    expect(le.criteria).toEqual([{ kind: "age", personId: "p-jordan", age: 75, when: "at" }]);
    expect(le.effects).toEqual([{ kind: "death", personId: "p-jordan" }]);
    // The engine stops the deceased's own income at death; ranges are left alone so survivor
    // shares can continue past it.
    for (const inc of plan.income.filter((i) => i.owner === "p-jordan"))
      expect(inc.range).toEqual(input.plan.income.find((x) => x.id === inc.id)!.range);
    expect(s.notes.join(" ")).toMatch(/Survivor benefits applied/);
    const r = simulate({ ...input, plan });
    expect(r.trace.some((t) => t.code === "SURVIVOR_TRANSFER")).toBe(true);
  });
});
