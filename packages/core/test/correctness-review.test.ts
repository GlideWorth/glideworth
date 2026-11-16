/**
 * Independent correctness review: adversarial tests for defects found (each one failed before its
 * fix) plus closed-form cross-checks against answers computed independently of the engine.
 * Synthetic figures only.
 */
import { describe, expect, it } from "vitest";
import { simulate } from "../src/engine/simulate.js";
import { MonteCarloSettings } from "../src/schema/montecarlo.js";
import { getMarketDataset } from "../src/stochastic/data/index.js";
import { createRng } from "../src/stochastic/rng.js";
import { sampleMarketPath } from "../src/stochastic/samplers.js";
import { ukJurisdiction } from "../src/tax/jurisdictions/uk.js";
import { account, acct, always, expectInvariants, flatTax, period, sim } from "./engine-helpers.js";
import { sumKind, sumLabel, taxInput } from "./tax-helpers.js";

const salary = (amount: number, id = "sal") => ({
  id,
  type: "salary" as const,
  name: "Salary",
  owner: "me",
  amount: { value: amount, basis: "nominal" as const },
  frequency: "yearly" as const,
  range: always,
});
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

describe("defects found in review (each failed before its fix)", () => {
  it("interest on a cash account modelled as a yield is taxed as interest (was untaxed)", () => {
    const r = simulate(
      sim({
        accounts: [
          acct("s", "savings", 100_000, {
            behaviour: { dividends: { yield: { kind: "fixed", rate: 0.05 } } },
          }),
        ],
        plan: { tax: flatTax(0.2) },
        years: 1,
      }),
    );
    // 5,000 interest x 20% = 1,000 (paid from the same savings account: cash withdrawals are
    // untaxed; under the default mid-year timing the 1,000 forgoes half a year of interest).
    expect(period(r, 2027).taxes.total).toBeCloseTo(1_000, 6);
    expect(account(r, 2027, "s").closing).toBeCloseTo(104_000 - 1_000 * (Math.sqrt(1.05) - 1), 6);
    expectInvariants(r);
  });

  it("a negative (overdrawn) balance earns no investment growth and pays no % fee (was compounded at the stock rate)", () => {
    const r = simulate(
      sim({
        accounts: [
          acct("t", "taxable", -10_000, {
            behaviour: { fees: { kind: "percentOfBalance", rate: 0.01 } },
          }),
        ],
        plan: { assumptions: { stockReturn: { kind: "fixed", rate: 0.1 } } },
        years: 1,
      }),
    );
    const a = account(r, 2027, "t");
    expect(a.growth).toBe(0);
    expect(a.fees).toBe(0);
    expect(a.closing).toBeCloseTo(-10_000, 6);
  });

  it("no tax-free pension cash before the access age when early access is modelled with a penalty (PCLS was taken at 47)", () => {
    const r = simulate(
      sim({
        location: { country: "GB" },
        start: "2027-01",
        births: ["1980-01"],
        accounts: [
          acct("sipp", "uk-sipp", 200_000, {
            behaviour: {
              ukDrawdownMethod: "pcls",
              earlyWithdrawal: { enabled: true, qualifiedAge: 57, penaltyRate: 0.55 },
            },
          }),
        ],
        plan: { expenses: [expense("e", 10_000)], tax: flatTax(0) },
        years: 11,
      }),
    );
    // Aged 47-56: every withdrawal is early -> no PCLS / UFPLS tax-free cash, a penalty applies.
    for (const p of r.periods.filter((x) => x.year < 2037))
      expect(p.totals.taxFreePensionCash ?? 0).toBe(0);
    expect(r.warnings.some((w) => w.code === "EARLY_WITHDRAWAL_PENALTY")).toBe(true);
    // At 57 (2037) the PCLS is taken once: 25% of the pot then.
    const p57 = period(r, 2037);
    const opening = account(r, 2037, "sipp").opening;
    expect(p57.totals.taxFreePensionCash).toBeCloseTo(opening * 0.25, 6);
  });

  it("an employer match is reported separately so cash income can be shown (income still includes it)", () => {
    const r = simulate(
      sim({
        accounts: [acct("k", "401k", 0), acct("c", "cash", 0)],
        plan: {
          income: [salary(50_000)],
          flows: [
            {
              kind: "contribution",
              id: "f",
              name: "401k",
              owner: "me",
              range: always,
              accountId: "k",
              method: { kind: "amount", amount: { value: 5_000, basis: "nominal" } },
              employer: { incomeId: "sal", matchShare: 1, upToShareOfPay: 0.06 },
            },
          ],
        },
        years: 1,
      }),
    );
    const t = period(r, 2027).totals;
    // Convention: income includes the match (and so does the savings rate, on both sides); the
    // match never reaches the cash pool and is reported in externalContributions.
    expect(t.income).toBeCloseTo(53_000, 6);
    expect(t.externalContributions).toBeCloseTo(3_000, 6);
    expect(t.income - t.externalContributions!).toBeCloseTo(50_000, 6);
    expect(t.contributions).toBeCloseTo(50_000 + 3_000, 6); // 5k deferral + 3k match + 45k leftover saved
    expect(t.savingsRate).toBeCloseTo(1, 6);
    // The match is still visible as an income line and in the ledger (Sankey).
    expect(period(r, 2027).income.some((l) => l.sourceId === "employer:f")).toBe(true);
    expectInvariants(r);
  });

  it("historical Monte Carlo with inflation held at the plan rate keeps each year's REAL return", () => {
    const settings = MonteCarloSettings.parse({
      method: "historical-sequential",
      dataset: "us-1928",
      vary: { inflation: false },
      trials: 1,
    });
    const base = Array.from({ length: 10 }, () => ({
      stocks: 0.05,
      bonds: 0.03,
      cash: 0.02,
      inflation: 0.02,
      dividendYield: 0.02,
      bondYield: 0.03,
      crypto: 0,
    }));
    const path = sampleMarketPath(settings, 10, createRng(1), 0, { base });
    const ds = getMarketDataset("us-1928");
    for (const p of path.periods) {
      const k = p.sourceYear! - ds.firstYear;
      const realHist = (1 + ds.series.stocks[k]!) / (1 + ds.series.inflation[k]!);
      expect(p.inflation).toBe(0.02);
      expect((1 + p.stocks) / 1.02).toBeCloseTo(realHist, 12);
    }
  });
});

describe("closed-form cross-checks", () => {
  const C = 10_000;
  const R = 0.05;
  const N = 10;
  const annuity = (timing: "start" | "mid" | "end") =>
    simulate(
      sim({
        accounts: [acct("t", "taxable", 0, { costBasis: 0 })],
        plan: {
          income: [salary(C)],
          flows: [
            {
              kind: "contribution",
              id: "f",
              name: "Invest",
              owner: "me",
              range: always,
              accountId: "t",
              method: {
                kind: "amount",
                amount: { value: C, basis: "nominal" },
                frequency: "yearly",
              },
            },
          ],
          assumptions: { stockReturn: { kind: "fixed", rate: R }, cashFlowTiming: timing },
        },
        years: N,
      }),
    );
  const fvOrdinary = (C * ((1 + R) ** N - 1)) / R;

  // 'mid' / 'start' failed before the fix: an account opening EMPTY got no timing credit in its
  // first year (its rate was never set because growth skipped zero opening balances).
  it.each([
    ["end", 1],
    ["mid", Math.sqrt(1 + R)],
    ["start", 1 + R],
  ] as const)(
    "future value of a %s-of-year annuity = C((1+r)^n - 1)/r x timing factor",
    (timing, factor) => {
      const r = annuity(timing);
      expect(account(r, 2027 + N - 1, "t").closing).toBeCloseTo(fvOrdinary * factor, 6);
    },
  );

  it("loan amortisation: the standard payment repays the balance exactly at the term, then stops", () => {
    const P = 100_000;
    const i = 0.06 / 12;
    const n = 120;
    const pmt = (P * i) / (1 - (1 + i) ** -n);
    const r = simulate(
      sim({
        accounts: [acct("c", "cash", 1_000_000)],
        finances: {
          debts: [
            {
              id: "d",
              name: "Loan",
              type: "personal-loan",
              owner: "me",
              balance: P,
              interest: { apr: 0.06, method: "compound", compounding: "monthly" },
              monthlyPayment: { value: pmt, basis: "nominal" },
            },
          ],
        },
        years: 11,
      }),
    );
    const d = (y: number) => period(r, y).debts[0]!;
    // Balance after 12 payments (closed form).
    const b12 = P * (1 + i) ** 12 - (pmt * ((1 + i) ** 12 - 1)) / i;
    expect(d(2027).closing).toBeCloseTo(b12, 6);
    expect(d(2027).interest).toBeCloseTo(12 * pmt - (P - b12), 6);
    expect(d(2036).closing).toBeLessThan(1e-6);
    const paid = r.periods.reduce((s, p) => s + p.debts[0]!.payments, 0);
    expect(paid).toBeCloseTo(n * pmt, 4);
    expect(d(2037).payments).toBe(0);
  });

  it("constant real withdrawals: first shortfall year = floor(n*), n* = ln(S(1+g)/(S(1+g) - W g)) / ln(1+g)", () => {
    const W = 1_000_000;
    const S = 80_000;
    const nominal = 0.07;
    const inflation = 0.03;
    const g = (1 + nominal) / (1 + inflation) - 1;
    const nStar = Math.log((S * (1 + g)) / (S * (1 + g) - W * g)) / Math.log(1 + g);
    const r = simulate(
      sim({
        accounts: [acct("t", "taxable", W, { costBasis: W })],
        plan: {
          expenses: [expense("e", S, { change: { kind: "inflation", plus: 0 } })],
          assumptions: { stockReturn: { kind: "fixed", rate: nominal }, cashFlowTiming: "start" },
        },
        inflation,
        years: 25,
      }),
    );
    expect(r.summary.firstShortfallYear).toBe(2027 + Math.floor(nStar));
    // Real balance the year before the shortfall matches the closed form.
    const k = Math.floor(nStar);
    const realBefore = W * (1 + g) ** k - (S * (1 + g) * ((1 + g) ** k - 1)) / g;
    const before = period(r, 2027 + k - 1);
    expect(account(r, 2027 + k - 1, "t").closing / before.priceIndex).toBeCloseTo(realBefore, 4);
  });
});

describe("areas reviewed and found sound (pinned)", () => {
  const uk = (o: Parameters<typeof taxInput>[0]) => ukJurisdiction.computeYear(taxInput(o), []);
  const ni = (o: ReturnType<typeof uk>) => sumLabel(o, /National Insurance/);
  const incomeTax = (o: ReturnType<typeof uk>) => sumKind(o, "income", "dividends", "credit");

  it("NI is charged on earnings only: none on pension, rental, interest, dividends or pension withdrawals", () => {
    const o = uk({
      income: [
        { character: "pension", amount: 30_000 },
        { character: "rental", amount: 10_000 },
        { character: "interest", amount: 5_000 },
        { character: "qualified-dividend", amount: 5_000 },
      ],
      withdrawals: [{ amount: 20_000, taxableAmount: 15_000 }],
    });
    expect(ni(o)).toBe(0);
  });

  it("salary sacrifice reduces income tax and NI; relief at source extends the band and restores the PA", () => {
    // £60k with £10k sacrificed: tax and NI on £50k.
    const s = uk({
      income: [{ character: "wage", amount: 60_000 }],
      deductions: [
        { amount: 10_000, pensionScheme: "salary-sacrifice", accountType: "uk-workplace-pension" },
      ],
    });
    expect(incomeTax(s)).toBeCloseTo((50_000 - 12_570) * 0.2, 6);
    expect(ni(s)).toBeCloseTo((50_000 - 12_570) * 0.08, 6);
    // £110k with £8k net RAS (£10k gross): adjusted net income £100k -> full PA; basic band +£10k.
    const r = uk({
      income: [{ character: "wage", amount: 110_000 }],
      deductions: [{ amount: 8_000, pensionScheme: "relief-at-source", accountType: "uk-sipp" }],
    });
    expect(r.facts["uk.personalAllowance.p1"]).toBeCloseTo(12_570, 6);
    expect(incomeTax(r)).toBeCloseTo(47_700 * 0.2 + (110_000 - 12_570 - 47_700) * 0.4, 6);
    // NI is not reduced by a relief-at-source contribution.
    expect(ni(r)).toBeCloseTo(37_700 * 0.08 + (110_000 - 50_270) * 0.02, 6);
  });

  it("couples keep separate allowances; joint income splits evenly", () => {
    const two = uk({
      people: [{ id: "a" }, { id: "b" }],
      income: [
        { owner: "a", character: "wage", amount: 20_000 },
        { owner: "b", character: "wage", amount: 20_000 },
        { owner: "joint", character: "interest", amount: 2_000 },
      ],
    });
    // Each: (20,000 - 12,570) x 20% = 1,486; joint interest 1,000 each is within each PSA.
    expect(incomeTax(two)).toBeCloseTo(2 * 1_486, 6);
  });

  it("UFPLS: 25% of a pension withdrawal is tax-free and the rest is taxed as income (no NI)", () => {
    const o = uk({ withdrawals: [{ amount: 40_000, taxableAmount: 30_000 }] });
    expect(incomeTax(o)).toBeCloseTo((30_000 - 12_570) * 0.2, 6);
    expect(ni(o)).toBe(0);
  });

  it("GIA withdrawals realise gains pro rata to cost basis and the basis falls in proportion", () => {
    const r = simulate(
      sim({
        location: { country: "GB" },
        accounts: [acct("gia", "uk-gia", 100_000, { costBasis: 50_000 })],
        plan: { expenses: [expense("e", 20_000)], tax: flatTax(0, 0) },
        years: 1,
      }),
    );
    const a = account(r, 2027, "gia");
    expect(a.withdrawals).toBeCloseTo(20_000, 6);
    expect(a.costBasis).toBeCloseTo(40_000, 6);
  });

  it("the ISA allowance is shared with the LISA (one £20,000 allowance per person)", () => {
    const r = simulate(
      sim({
        location: { country: "GB" },
        births: ["1995-01"],
        accounts: [acct("lisa", "uk-lisa", 0), acct("isa", "uk-isa", 0), acct("c", "cash", 0)],
        plan: {
          income: [salary(100_000)],
          flows: [
            {
              kind: "contribution",
              id: "l",
              name: "LISA",
              owner: "me",
              range: always,
              accountId: "lisa",
              method: { kind: "max" },
              limit: { kind: "jurisdiction" },
            },
            {
              kind: "contribution",
              id: "i",
              name: "ISA",
              owner: "me",
              range: always,
              accountId: "isa",
              method: { kind: "max" },
              limit: { kind: "jurisdiction" },
            },
          ],
          tax: flatTax(0),
        },
        years: 1,
      }),
    );
    expect(account(r, 2027, "lisa").contributions).toBeCloseTo(4_000 * 1.25, 6); // + 25% bonus
    expect(account(r, 2027, "isa").contributions).toBeCloseTo(16_000, 6);
  });

  it("a mortgage payment is one expense line (loan payment), not also a housing expense", () => {
    const r = simulate(
      sim({
        accounts: [acct("c", "cash", 100_000)],
        finances: {
          realAssets: [
            {
              id: "h",
              name: "Home",
              type: "house",
              owner: "me",
              currentValue: 300_000,
              loan: {
                id: "l",
                balance: 100_000,
                interest: { apr: 0 },
                monthlyPayment: { value: 1_000, basis: "nominal" },
              },
              behaviour: { appreciation: { kind: "none" } },
            },
          ],
        },
        years: 1,
      }),
    );
    const p = period(r, 2027);
    expect(p.totals.expenses).toBeCloseTo(12_000, 6);
    expect(p.expenses.filter((e) => e.sourceKind === "loan-payment")).toHaveLength(1);
  });

  it("a real (today's money) expense with inflation change is inflated once", () => {
    const r = simulate(
      sim({
        accounts: [acct("c", "cash", 1_000_000)],
        plan: { expenses: [expense("e", 10_000, { change: { kind: "inflation", plus: 0 } })] },
        inflation: 0.03,
        years: 3,
      }),
    );
    expect(period(r, 2029).totals.expenses).toBeCloseTo(10_000 * 1.03 ** 2, 6);
  });
});
