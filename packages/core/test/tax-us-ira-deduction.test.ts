/**
 * Traditional IRA deduction phase-out (IRC 219(g)). Sources (read 2026-11-23):
 * - 26 U.S.C. 219(g)(1)-(3), (5), (7), (8), United States Code 2024 edition:
 *   https://www.govinfo.gov/content/pkg/USCODE-2024-title26/html/USCODE-2024-title26-subtitleA-chap1-subchapB-partVII-sec219.htm
 *   The reduction is limit x (MAGI - applicable dollar amount) / $20,000 on a joint return or
 *   $10,000 otherwise and for a spouse who is not covered, rounded down to $10; a limit is not
 *   reduced below $200 unless it is reduced to zero.
 * - IR-2025-111 (2026 ranges): single covered $81,000-$91,000, joint covered $129,000-$149,000,
 *   not covered with a covered spouse $242,000-$252,000, separate covered $0-$10,000; IRA limit
 *   $7,500 plus $1,100 at 50.
 *   https://www.irs.gov/newsroom/401k-limit-increases-to-24500-for-2026-ira-limit-increases-to-7500
 * - IR-2026-136 (2027 ranges): $83,000-$93,000, $133,000-$153,000, $250,000-$260,000.
 *   https://www.irs.gov/newsroom/401k-limit-increases-to-25500-for-2027-ira-limit-remains-7500
 * - Pub. 590-A (2025), Worksheet 1-2 line 4 (deductible limit rounded UP to $10, at least $200,
 *   the same result as the statute's reduction rounded down) and "What's New for 2026" (the joint
 *   range also applies to a qualifying surviving spouse, the single range to a head of household):
 *   https://www.irs.gov/publications/p590a
 * Expected values are worked from those rules by hand; synthetic households only.
 */
import { describe, expect, it } from "vitest";
import { simulate } from "../src/index.js";
import type { FlowInput } from "../src/schema/flows.js";
import { usFederalJurisdiction } from "../src/tax/jurisdictions/us-federal.js";
import {
  account,
  acct,
  always,
  between,
  expectInvariants,
  from,
  period,
  sim,
} from "./engine-helpers.js";
import { taxInput } from "./tax-helpers.js";

type Status =
  | "single"
  | "married-joint"
  | "married-separate"
  | "head-of-household"
  | "qualifying-surviving-spouse";

/**
 * Federal outcome for one traditional IRA contribution by p1 with MAGI `magi` (wages only, so
 * MAGI = wages). `p1Covered` / `p2Covered`: active participants; p2 exists on married returns.
 */
function deductible(o: {
  magi: number;
  contribution?: number;
  status?: Status;
  p1Covered?: boolean;
  p2Covered?: boolean;
  age?: number;
  year?: number;
  priceIndex?: number;
}) {
  const status = o.status ?? "single";
  const married = status === "married-joint" || status === "married-separate";
  const contribution = o.contribution ?? 7_500;
  const out = usFederalJurisdiction.computeYear(
    taxInput({
      country: "US",
      year: o.year ?? 2026,
      priceIndex: o.priceIndex ?? 1,
      config: { filingStatus: status },
      people: [
        { age: o.age ?? 40, activeParticipant: !!o.p1Covered },
        ...(married ? [{ age: 40, activeParticipant: !!o.p2Covered }] : []),
      ],
      income: [{ character: "wage", amount: o.magi }],
      deductions: [{ accountType: "traditional-ira", amount: contribution }],
    }),
    [],
  );
  return { deduction: o.magi - out.facts["agi"]!, facts: out.facts };
}

describe("IRC 219(g): joint return, contributor covered (2026: $129,000-$149,000)", () => {
  const d = (magi: number, age = 40) =>
    deductible({ magi, status: "married-joint", p1Covered: true, age }).deduction;
  it("full deduction just below, at and just above the start of the range", () => {
    expect(d(128_999)).toBe(7_500);
    expect(d(129_000)).toBe(7_500);
    // $1 over: reduction 7,500 x 1 / 20,000 = 0.375, rounded down to $0.
    expect(d(129_001)).toBe(7_500);
    // $10 over: 3.75 -> $0; $27 over: 10.125 -> $10.
    expect(d(129_027)).toBe(7_490);
  });
  it("linear in the range, with the statutory rounding", () => {
    expect(d(139_000)).toBe(3_750);
    // Pub. 590-A Worksheet 1-2: 7,500 x (149,000 - 135,123) / 20,000 = 5,203.875 -> $5,210.
    expect(d(135_123)).toBe(5_210);
    // 50 or older: limit $8,600 -> 8,600 x 10,000 / 20,000 = 4,300.
    expect(d(139_000, 52)).toBe(4_300);
  });
  it("$200 floor just below the end, nothing at and above it", () => {
    // 7,500 x 19,999 / 20,000 = 7,499.625 -> 7,490 reduction -> $10 left -> raised to $200.
    expect(d(148_999)).toBe(200);
    expect(d(149_000)).toBe(0);
    expect(d(149_001)).toBe(0);
  });
  it("a contribution below the reduced limit stays fully deductible", () => {
    const r = deductible({
      magi: 139_000,
      contribution: 3_000,
      status: "married-joint",
      p1Covered: true,
    });
    expect(r.deduction).toBe(3_000);
    expect(r.facts["us.iraNondeductible"]).toBeUndefined();
  });
  it("reports the nondeductible part per owner", () => {
    const r = deductible({ magi: 139_000, status: "married-joint", p1Covered: true });
    expect(r.facts["us.iraNondeductible"]).toBe(3_750);
    expect(r.facts["us.iraNondeductible.p1"]).toBe(3_750);
    expect(r.facts["us.iraMagi"]).toBe(139_000);
  });
});

describe("IRC 219(g)(7): not covered, spouse covered (2026: $242,000-$252,000)", () => {
  const d = (magi: number) =>
    deductible({ magi, status: "married-joint", p2Covered: true }).deduction;
  it("full deduction just below, at and just above $242,000", () => {
    expect(d(241_999)).toBe(7_500);
    expect(d(242_000)).toBe(7_500);
    expect(d(242_001)).toBe(7_500);
  });
  it("over a $10,000 range", () => {
    expect(d(247_000)).toBe(3_750);
    // 7,500 x 9,999 / 10,000 = 7,499.25 -> 7,490 -> $10 -> $200 floor.
    expect(d(251_999)).toBe(200);
    expect(d(252_000)).toBe(0);
    expect(d(252_001)).toBe(0);
  });
  it("the covered spouse keeps the active-participant range", () => {
    expect(
      deductible({ magi: 200_000, status: "married-joint", p1Covered: true, p2Covered: true })
        .deduction,
    ).toBe(0);
  });
  it("no phase-out when neither spouse is covered", () => {
    expect(deductible({ magi: 500_000, status: "married-joint" }).deduction).toBe(7_500);
  });
});

describe("IRC 219(g): other filing statuses (2026)", () => {
  const single = (magi: number, status: Status = "single") =>
    deductible({ magi, status, p1Covered: true }).deduction;
  it("single covered: $81,000-$91,000", () => {
    expect(single(80_999)).toBe(7_500);
    expect(single(81_000)).toBe(7_500);
    expect(single(81_001)).toBe(7_500);
    expect(single(86_000)).toBe(3_750);
    expect(single(90_999)).toBe(200);
    expect(single(91_000)).toBe(0);
    expect(single(91_001)).toBe(0);
  });
  it("single, not covered: no phase-out", () => {
    expect(deductible({ magi: 300_000 }).deduction).toBe(7_500);
  });
  it("head of household uses the single range; qualifying surviving spouse the joint range", () => {
    expect(single(86_000, "head-of-household")).toBe(3_750);
    expect(single(139_000, "qualifying-surviving-spouse")).toBe(3_750);
  });
  it("married filing separately: $0-$10,000, covered or with a covered spouse", () => {
    expect(single(5_000, "married-separate")).toBe(3_750);
    expect(single(10_000, "married-separate")).toBe(0);
    expect(deductible({ magi: 5_000, status: "married-separate", p2Covered: true }).deduction).toBe(
      3_750,
    );
  });
});

describe("IRC 219(g): 2027 and later years", () => {
  it("2027 ranges (IR-2026-136)", () => {
    const j = (magi: number) =>
      deductible({ magi, year: 2027, status: "married-joint", p1Covered: true }).deduction;
    expect(j(133_000)).toBe(7_500);
    expect(j(143_000)).toBe(3_750);
    expect(j(153_000)).toBe(0);
    const s = (magi: number) =>
      deductible({ magi, year: 2027, status: "married-joint", p2Covered: true }).deduction;
    expect(s(250_000)).toBe(7_500);
    expect(s(255_000)).toBe(3_750);
    expect(s(260_000)).toBe(0);
    const one = (magi: number) => deductible({ magi, year: 2027, p1Covered: true }).deduction;
    expect(one(83_000)).toBe(7_500);
    expect(one(88_000)).toBe(3_750);
    expect(one(93_000)).toBe(0);
  });
  it("after 2027 the start and the limit are indexed like the other US thresholds", () => {
    // No history: the 2027 table is indexed with the plan's price index (us-index.ts). Start
    // 133,000 x 1.1 = 146,300; limit 7,500 x 1.1 = 8,250; range $20,000 (statutory).
    const r = deductible({
      magi: 156_300,
      year: 2030,
      priceIndex: 1.1,
      contribution: 8_250,
      status: "married-joint",
      p1Covered: true,
    });
    // Reduction 8,250 x 10,000 / 20,000 = 4,125, rounded down to 4,120.
    expect(r.deduction).toBeCloseTo(4_130, 6);
  });
});

describe("IRC 219(g)(3)(A): MAGI with Social Security", () => {
  it("taxable benefits are figured before the IRA deduction (Pub. 590-A Appendix B)", () => {
    // Joint, wages 140,000, benefits 20,000: 85% = 17,000 taxable before the IRA deduction, so
    // MAGI = 157,000, above $149,000: nothing deductible.
    const out = usFederalJurisdiction.computeYear(
      taxInput({
        country: "US",
        config: { filingStatus: "married-joint" },
        people: [{ age: 66, activeParticipant: true }, { age: 66 }],
        income: [
          { character: "wage", amount: 140_000 },
          { character: "social-security", amount: 20_000 },
        ],
        deductions: [{ accountType: "traditional-ira", amount: 8_600 }],
      }),
      [],
    );
    expect(out.facts["us.iraMagi"]).toBe(157_000);
    expect(out.facts["us.iraNondeductible"]).toBe(8_600);
    expect(out.facts["agi"]).toBe(157_000);
  });
});

// ---------------------------------------------------------------- through the engine

const salary = (value: number, owner: string) => ({
  id: `sal-${owner}`,
  type: "salary" as const,
  name: "Salary",
  owner,
  amount: { value },
  frequency: "yearly" as const,
  range: always,
});
const flow = (
  accountId: string,
  owner: string,
  method: object,
  range: object = always,
): FlowInput =>
  ({
    kind: "contribution",
    id: `f-${accountId}`,
    name: accountId,
    owner,
    range,
    accountId,
    method,
    limit: { kind: "jurisdiction" },
  }) as FlowInput;
const yearly = (value: number) => ({ kind: "amount", amount: { value }, frequency: "yearly" });

function couple(pay: number, accounts: ReturnType<typeof acct>[], flows: FlowInput[], years = 1) {
  return simulate(
    sim({
      start: "2026-01",
      years,
      births: ["1974-01", "1975-01"],
      location: { country: "US", region: "TX" },
      accounts: [acct("c", "cash", 0, { owner: "a" }), ...accounts],
      plan: {
        tax: { mode: "estimate", filingStatus: "married-joint" },
        income: [salary(pay, "a")],
        flows,
      },
    }),
  );
}

describe("IRC 219(g) in a projection (US federal, Texas, MFJ, 2026)", () => {
  it("covered spouse above the range: the IRA is funded but not deducted", () => {
    // A (52) earns $200,000, defers $10,000 to a 401(k) (covered) and puts $8,600 in a
    // traditional IRA. MAGI 190,000 > 149,000: no deduction. Before this change AGI was 181,400.
    const r = couple(
      200_000,
      [acct("k", "401k", 0, { owner: "a" }), acct("ia", "traditional-ira", 0, { owner: "a" })],
      [flow("k", "a", yearly(10_000)), flow("ia", "a", { kind: "max" })],
    );
    expect(account(r, 2026, "ia").contributions).toBeCloseTo(8_600, 6);
    expect(period(r, 2026).taxes.facts["agi"]).toBeCloseTo(190_000, 6);
    expect(period(r, 2026).taxes.facts["us.iraNondeductible.a"]).toBeCloseTo(8_600, 6);
    expectInvariants(r);
  });

  it("a 457(b) alone does not make its owner an active participant (219(g)(5))", () => {
    const r = couple(
      200_000,
      [acct("g", "457b", 0, { owner: "a" }), acct("ia", "traditional-ira", 0, { owner: "a" })],
      [flow("g", "a", yearly(10_000)), flow("ia", "a", { kind: "max" })],
    );
    expect(period(r, 2026).taxes.facts["agi"]).toBeCloseTo(181_400, 6);
  });

  it("an employer contribution alone makes its owner covered", () => {
    // A defers nothing; the employer pays a fixed $3,000 into the 401(k).
    const r = couple(
      200_000,
      [acct("k", "401k", 0, { owner: "a" }), acct("ia", "traditional-ira", 0, { owner: "a" })],
      [
        {
          ...flow("k", "a", yearly(0)),
          employer: {
            incomeId: "sal-a",
            tiers: [],
            fixed: { amount: { value: 3_000 }, frequency: "yearly" },
          },
        } as FlowInput,
        flow("ia", "a", { kind: "max" }),
      ],
    );
    expect(account(r, 2026, "k").contributions).toBeCloseTo(3_000, 6);
    expect(period(r, 2026).taxes.facts["agi"]).toBeCloseTo(200_000, 6);
  });

  it("the issue's household: B (not covered) keeps the full deduction at $150,000", () => {
    // GlideWorth/glideworth#10: A (52) earns $150,000 and is covered (Roth 401(k) $5,000, so
    // MAGI stays $150,000) and funds a Roth IRA; B (51) earns nothing, is not covered and funds a
    // traditional IRA. $150,000 < $242,000: B deducts all $8,600 (219(g)(7)).
    const r = couple(
      150_000,
      [
        acct("rk", "roth-401k", 0, { owner: "a" }),
        acct("ra", "roth-ira", 0, { owner: "a" }),
        acct("ib", "traditional-ira", 0, { owner: "b" }),
      ],
      [
        flow("rk", "a", yearly(5_000)),
        flow("ra", "a", { kind: "max" }),
        flow("ib", "b", { kind: "max" }),
      ],
    );
    expect(account(r, 2026, "ra").contributions).toBeCloseTo(8_600, 6);
    expect(account(r, 2026, "ib").contributions).toBeCloseTo(8_600, 6);
    expect(period(r, 2026).taxes.facts["agi"]).toBeCloseTo(141_400, 6);
    expect(period(r, 2026).taxes.facts["us.iraNondeductible"]).toBeUndefined();
  });

  it("the same household at $247,000: B's deduction is halved (219(g)(7) range)", () => {
    // MAGI 247,000: 8,600 x 5,000 / 10,000 = 4,300 reduction -> B deducts 4,300.
    const r = couple(
      247_000,
      [
        acct("rk", "roth-401k", 0, { owner: "a" }),
        acct("ib", "traditional-ira", 0, { owner: "b" }),
      ],
      [flow("rk", "a", yearly(5_000)), flow("ib", "b", { kind: "max" })],
    );
    expect(period(r, 2026).taxes.facts["agi"]).toBeCloseTo(247_000 - 4_300, 6);
    expect(period(r, 2026).taxes.facts["us.iraNondeductible.b"]).toBeCloseTo(4_300, 6);
  });

  it("nondeductible contributions become basis: a later conversion of them is not taxed", () => {
    // 2026: $8,600 nondeductible (as above). 2027: the IRA stops and is converted to a Roth IRA.
    // Zero returns, so the whole balance is basis and the conversion adds nothing to AGI
    // (IRC 72, 408(d)(1); Form 8606). Without basis tracking 2027 AGI would be 198,600.
    const r = couple(
      200_000,
      [
        acct("k", "401k", 0, { owner: "a" }),
        acct("ia", "traditional-ira", 0, { owner: "a" }),
        acct("ra", "roth-ira", 0, { owner: "a" }),
      ],
      [
        flow("k", "a", yearly(10_000)),
        flow("ia", "a", { kind: "max" }, between("2026-01", "2027-01")),
        {
          kind: "transfer",
          id: "conv",
          name: "Conversion",
          owner: "a",
          range: from("2027-01"),
          fromAccountId: "ia",
          to: { kind: "account", accountId: "ra" },
          amount: { kind: "all" },
        } as FlowInput,
      ],
      2,
    );
    expect(account(r, 2027, "ra").transfersIn).toBeCloseTo(8_600, 6);
    expect(period(r, 2027).taxes.facts["agi"]).toBeCloseTo(190_000, 6);
    expectInvariants(r);
  });
});
