/**
 * Tiered employer match (GlideWorth/glideworth#9): an ordered list of { matchRate, bandShareOfPay }
 * evaluated from the first percent of pay up, with and without "reduce employer money if I can't
 * fund mine", and the schema 2 -> 3 migration of single-pair matches to one tier.
 */
import { describe, expect, it } from "vitest";
import { simulate } from "../src/engine/simulate.js";
import { applyPlanPatch } from "../src/insights/patch.js";
import { buildSimulationInput } from "../src/scenario.js";
import { createUkSampleDocument, UK_SAMPLE_PLAN_ID } from "../src/samples/index.js";
import { migrateDocument, migratePlan, SCHEMA_VERSION } from "../src/schema/document.js";
import { EmployerMatch } from "../src/schema/flows.js";
import { account, acct, always, expectInvariants, sim } from "./engine-helpers.js";

type Tier = { matchRate: number; bandShareOfPay: number };
type Json = Record<string, unknown>;

const PAY = 100_000;
const salary = {
  id: "sal",
  type: "salary" as const,
  name: "Salary",
  owner: "me",
  amount: { value: PAY },
  frequency: "yearly" as const,
  range: always,
};

/** Employer money paid into the 401(k) in the first year for a deferral of `share` of pay. */
function employerMoney(
  tiers: Tier[],
  share: number,
  opts: { spend?: number; reduceIfUnderfunded?: boolean } = {},
) {
  const r = simulate(
    sim({
      accounts: [acct("c", "cash", 0), acct("k", "401k", 0)],
      plan: {
        income: [salary],
        ...(opts.spend
          ? {
              expenses: [
                {
                  id: "e",
                  type: "living" as const,
                  name: "Living",
                  owner: "me",
                  amount: { value: opts.spend },
                  frequency: "yearly" as const,
                  range: always,
                },
              ],
            }
          : {}),
        flows: [
          {
            kind: "contribution",
            id: "f-k",
            name: "401(k)",
            owner: "me",
            range: always,
            accountId: "k",
            method: { kind: "percentOfIncome", incomeId: "sal", share },
            employer: {
              incomeId: "sal",
              tiers,
              reduceIfUnderfunded: opts.reduceIfUnderfunded ?? false,
            },
          },
        ],
      },
      years: 1,
    }),
  );
  expectInvariants(r);
  const match = r.trace.find((t) => t.code === "EMPLOYER_MATCH");
  const k = account(r, 2027, "k");
  return { match: (match?.data?.match as number) ?? 0, total: k.contributions };
}

describe("tiered employer match", () => {
  // Issue #9 synthetic vector: 150% of the first 4% of pay, 50% of the next 2%, $100,000 pay.
  // Hand check: 2% -> 1.5 x 2,000; 4% -> 1.5 x 4,000; 5% -> 6,000 + 0.5 x 1,000;
  // 6% -> 6,000 + 0.5 x 2,000; above 6% nothing more.
  const frontLoaded = [
    { matchRate: 1.5, bandShareOfPay: 0.04 },
    { matchRate: 0.5, bandShareOfPay: 0.02 },
  ];
  it.each([
    [0.02, 3_000],
    [0.04, 6_000],
    [0.05, 6_500],
    [0.06, 7_000],
    [0.08, 7_000],
  ])("150%% of the first 4%% + 50%% of the next 2%%: deferral %d -> match %d", (share, match) => {
    const r = employerMoney(frontLoaded, share);
    expect(r.match).toBeCloseTo(match, 6);
    expect(r.total).toBeCloseTo(share * PAY + match, 6);
  });

  it("safe-harbor basic match (26 CFR 1.401(k)-3(c)(2)): 5% deferral -> 4% of pay", () => {
    // 100% of deferrals up to 3% of pay + 50% of deferrals between 3% and 5% of pay:
    // 3,000 + 0.5 x 2,000 = 4,000 on $100,000.
    const basic = [
      { matchRate: 1, bandShareOfPay: 0.03 },
      { matchRate: 0.5, bandShareOfPay: 0.02 },
    ];
    expect(employerMoney(basic, 0.05).match).toBeCloseTo(4_000, 6);
    expect(employerMoney(basic, 0.02).match).toBeCloseTo(2_000, 6);
    expect(employerMoney(basic, 0.1).match).toBeCloseTo(4_000, 6);
  });

  it("QACA match (26 CFR 1.401(k)-3(k)(2)): 6% deferral -> 3.5% of pay", () => {
    // 100% up to 1% of pay + 50% of deferrals between 1% and 6%: 1,000 + 0.5 x 5,000 = 3,500.
    const qaca = [
      { matchRate: 1, bandShareOfPay: 0.01 },
      { matchRate: 0.5, bandShareOfPay: 0.05 },
    ];
    expect(employerMoney(qaca, 0.06).match).toBeCloseTo(3_500, 6);
  });

  it("reduce-if-underfunded matches what was funded, from the first tier up", () => {
    // 6% intended (6,000) but only 3,000 of surplus after 97,000 of spending.
    const reduced = employerMoney(frontLoaded, 0.06, { spend: 97_000, reduceIfUnderfunded: true });
    expect(reduced.match).toBeCloseTo(1.5 * 3_000, 6);
    expect(reduced.total).toBeCloseTo(3_000 + 4_500, 6);
    // Without the option the match follows the intended 6%.
    const full = employerMoney(frontLoaded, 0.06, { spend: 97_000 });
    expect(full.match).toBeCloseTo(7_000, 6);
  });

  it("a single tier is the old single-pair match", () => {
    // matchShare 0.5 up to 6% of pay at an 8% deferral: 0.5 x min(8,000, 6,000).
    expect(employerMoney([{ matchRate: 0.5, bandShareOfPay: 0.06 }], 0.08).match).toBeCloseTo(
      3_000,
      6,
    );
  });

  it("the schema allows match rates above 100% but not bands beyond all of pay", () => {
    expect(EmployerMatch.safeParse({ incomeId: "sal", tiers: frontLoaded }).success).toBe(true);
    expect(EmployerMatch.safeParse({ incomeId: "sal", tiers: [] }).success).toBe(false);
    expect(
      EmployerMatch.safeParse({
        incomeId: "sal",
        tiers: [
          { matchRate: 1, bandShareOfPay: 0.6 },
          { matchRate: 0.5, bandShareOfPay: 0.5 },
        ],
      }).success,
    ).toBe(false);
  });
});

/** The synthetic UK sample written the schema-2 way: single-pair employer matches. */
function v2Document(): Json {
  const doc = JSON.parse(JSON.stringify(createUkSampleDocument())) as Json;
  doc.schemaVersion = 2;
  for (const plan of doc.plans as Json[])
    for (const f of plan.flows as Json[]) {
      const e = f.employer as Json | undefined;
      if (!e) continue;
      const [tier, ...rest] = e.tiers as Tier[];
      expect(rest).toEqual([]);
      delete e.tiers;
      e.matchShare = tier!.matchRate;
      e.upToShareOfPay = tier!.bandShareOfPay;
    }
  return doc;
}

describe("schema 2 -> 3: employer match tiers", () => {
  it("is the current version", () => {
    expect(SCHEMA_VERSION).toBe(3);
  });

  it("migrates single-pair matches to one tier, with identical projections", () => {
    const raw = v2Document();
    const flow = ((raw.plans as Json[])[0]!.flows as Json[]).find((f) => f.employer)!;
    expect(flow.employer).toMatchObject({ matchShare: 1, upToShareOfPay: 0.05 });
    const migrated = migrateDocument(raw);
    expect(migrated.schemaVersion).toBe(3);
    const current = createUkSampleDocument();
    expect(migrated.plans).toEqual(current.plans);
    const before = simulate(buildSimulationInput(current, UK_SAMPLE_PLAN_ID));
    const after = simulate(buildSimulationInput(migrated, UK_SAMPLE_PLAN_ID));
    expect(after.periods).toEqual(before.periods);
    expect(after.summary).toEqual(before.summary);
  });

  it("migratePlan upgrades a stored v2 plan body; a missing upToShareOfPay meant all of pay", () => {
    const plan = (v2Document().plans as Json[])[0]!;
    const flow = (plan.flows as Json[]).find((f) => f.employer)!;
    delete (flow.employer as Json).upToShareOfPay;
    const migrated = migratePlan(plan, 2);
    expect(migrated.flows.find((f) => f.id === flow.id)).toMatchObject({
      employer: { tiers: [{ matchRate: 1, bandShareOfPay: 1 }] },
    });
  });

  it("rewrites branch patches that set the old fields or add flows with them", () => {
    const raw = v2Document();
    const main = (raw.plans as Json[])[0]!;
    const flow = (main.flows as Json[]).find((f) => f.employer)!;
    const newFlow = { ...flow, id: "added", employer: { incomeId: "uk-salary", matchShare: 0.5 } };
    const at = `/flows/[id=${flow.id as string}]/employer`;
    const branch: Json = {
      ...main,
      id: "branch",
      name: "Branch",
      isMain: false,
      lineage: {
        parentPlanId: main.id,
        parentVersion: null,
        patch: [
          { op: "replace", path: `${at}/matchShare`, value: 0.75 },
          { op: "remove", path: `${at}/upToShareOfPay` },
          { op: "add", path: "/flows/-", value: newFlow },
          { op: "replace", path: "/name", value: "Branch" },
        ],
      },
    };
    raw.plans = [main, branch];
    const doc = migrateDocument(raw);
    const patch = (doc.plans[1]!.lineage as { patch: Json[] }).patch;
    expect(patch.slice(0, 2)).toEqual([
      { op: "replace", path: `${at}/tiers/0/matchRate`, value: 0.75 },
      { op: "replace", path: `${at}/tiers/0/bandShareOfPay`, value: 1 },
    ]);
    expect((patch[2]!.value as Json).employer).toEqual({
      incomeId: "uk-salary",
      tiers: [{ matchRate: 0.5, bandShareOfPay: 1 }],
    });
    const applied = applyPlanPatch(doc.plans[0]!, patch as never);
    expect(applied.flows.find((f) => f.id === flow.id)).toMatchObject({
      employer: { tiers: [{ matchRate: 0.75, bandShareOfPay: 1 }] },
    });
  });
});
