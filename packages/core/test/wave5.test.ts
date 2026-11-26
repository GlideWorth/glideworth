/** Final internal QA findings ("Web wave 4"): W4-4, W4-5, W4-6. */
import { describe, expect, it } from "vitest";
import {
  ACCOUNT_TYPE_INFO,
  buildSimulationInput,
  createDefaultTaxRegistry,
  defaultsForCountry,
  fxRateIssues,
  mergeFxRates,
  reconcileYear,
  simulate,
  TAX_SIMPLIFICATIONS,
  toBasis,
  totalsMeasure,
} from "../src/index.js";
import { createUkSampleDocument, UK_SAMPLE_PLAN_ID } from "../src/samples/index.js";
import { acct, sim } from "./engine-helpers.js";

describe("W4-4: known simplifications for the UK, US, Canada and Australia", () => {
  const registry = createDefaultTaxRegistry();
  it.each([
    ["uk"],
    ["us-federal"],
    ["us-payroll"],
    ["us-state:CA"],
    ["us-local:nyc"],
    ["ca-federal"],
    ["ca-province:ON"],
    ["au"],
  ])("%s lists what it leaves out, on the plug-in and in TAX_SIMPLIFICATIONS", (id) => {
    const j = registry.get(id);
    expect(j.simplifications?.length ?? 0).toBeGreaterThan(1);
    expect(TAX_SIMPLIFICATIONS[id.split(":")[0]!]!.length).toBeGreaterThan(1);
    for (const s of j.simplifications!) expect(s).toMatch(/\.$/);
  });
  it("a state or province with a noted approximation adds it to the list", () => {
    const general = TAX_SIMPLIFICATIONS["us-state"]!.length;
    const withApprox = ["AL", "AR", "CT", "GA", "MD", "MN", "VT", "WI", "NJ", "NM", "NC", "OH"]
      .map((s) => registry.get(`us-state:${s}`).simplifications!.length)
      .filter((n) => n > general);
    expect(withApprox.length).toBeGreaterThan(0);
  });
  it("Canada and Australia exempt the gain on a main home (as the UK and US do)", () => {
    for (const id of ["ca-federal", "au", "uk"])
      expect(
        registry.get(id).homeSaleExclusion?.({
          filingStatus: "single",
          year: 2026,
          priceIndex: 1,
          monthsOwned: 60,
        }),
      ).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("W4-5: country defaults suggest the country’s own account types", () => {
  it.each(["DE", "NL", "FR", "ES", "IL", "IE", "NZ", "GB", "US", "CA", "AU"])("%s", (c) => {
    const d = defaultsForCountry(c);
    const own = Object.entries(ACCOUNT_TYPE_INFO)
      .filter(([, i]) => i.country === c)
      .map(([t]) => t);
    const suggested = [
      d.accountTypes.taxFree,
      d.accountTypes.personalPension,
      d.accountTypes.workplacePension,
    ];
    // No generic wrapper is suggested where the country has its own, and each suggestion exists.
    for (const t of suggested) if (t) expect(ACCOUNT_TYPE_INFO[t], t).toBeDefined();
    expect(suggested.some((t) => t?.startsWith("generic-"))).toBe(false);
    expect(suggested.some((t) => t && own.includes(t))).toBe(true);
    expect(d.suggestedRetirementAge).toBeGreaterThanOrEqual(55);
    // Australia's Age Pension is means-tested and has no default.
    if (c !== "AU") expect(d.statePension?.startAge ?? 0).toBeGreaterThanOrEqual(60);
  });
  it("a country without a preset still gets generic wrappers", () => {
    expect(defaultsForCountry("PT").accountTypes.taxFree).toBe("generic-tax-free");
  });
});

describe("W4-6: the year reconciliation uses the same flow/stock convention as toBasis", () => {
  const r = simulate(
    buildSimulationInput(createUkSampleDocument(), UK_SAMPLE_PLAN_ID, { trace: "off" }),
  );
  it("cash out and closing balances equal the figures shown everywhere else, and every year balances", () => {
    for (const p of r.periods) {
      const x = reconcileYear(r, p.index, { basis: "real" });
      expect(x.balanced, String(p.year)).toBe(true);
      // Spending in the cash table = Spending in today's money elsewhere (flows at start-of-year prices).
      const spendNominal = x.cash.outflows
        .filter((o) => o.kind === "expense")
        .reduce((s, o) => s + o.amount, 0);
      const nominal = reconcileYear(r, p.index);
      const spendN = nominal.cash.outflows
        .filter((o) => o.kind === "expense")
        .reduce((s, o) => s + o.amount, 0);
      expect(spendNominal).toBeCloseTo(toBasis(spendN, p, "real", "flow"), 6);
      expect(x.cash.totalOut).toBeCloseTo(toBasis(nominal.cash.totalOut, p, "real", "flow"), 6);
      // Closing balances and net worth are stocks (year-end prices).
      expect(x.accounts.total.closing).toBeCloseTo(
        toBasis(nominal.accounts.total.closing, p, "real", totalsMeasure("netWorth") ?? "stock"),
        6,
      );
      if (x.netWorth) {
        expect(x.netWorth.closing).toBeCloseTo(toBasis(p.totals.netWorth, p, "real", "stock"), 6);
        // The opening is last year's closing exactly as last year showed it.
        const prev = r.periods[p.index - 1]!;
        expect(x.netWorth.opening).toBeCloseTo(
          toBasis(prev.totals.netWorth, prev, "real", "stock"),
          6,
        );
        expect(x.netWorth.inflation).toBeLessThanOrEqual(0);
      }
      expect(nominal.accounts.total.inflation).toBe(0);
    }
  });
});

describe("FX tables: one pair per currency pair, in either direction", () => {
  const run = (planRates?: { from: string; to: string; rate: number }[]) =>
    simulate(
      sim({
        accounts: [acct("usd", "savings", 1_000, { currency: "USD" })],
        finances: { fxRates: [{ from: "USD", to: "GBP", rate: 0.8, annualDrift: 0 }] },
        ...(planRates ? { plan: { assumptions: { fxRates: planRates } } } : {}),
      } as never),
    );
  const openingInBase = (r: ReturnType<typeof simulate>) => r.periods[0]!.accounts[0]!.opening;
  it("a plan override in the inverse direction replaces the household pair", () => {
    expect(openingInBase(run())).toBeCloseTo(800, 6);
    expect(openingInBase(run([{ from: "GBP", to: "USD", rate: 2 }]))).toBeCloseTo(500, 6);
  });
  it("mergeFxRates lets a plan pair replace the household pair in either direction", () => {
    const household = [{ from: "USD", to: "GBP", rate: 0.8, annualDrift: 0 }];
    expect(mergeFxRates(household, undefined)).toEqual(household);
    expect(mergeFxRates(undefined, household)).toEqual(household);
    expect(mergeFxRates(household, [{ from: "GBP", to: "USD", rate: 2, annualDrift: 0 }])).toEqual([
      { from: "GBP", to: "USD", rate: 2, annualDrift: 0 },
    ]);
    expect(
      mergeFxRates(household, [{ from: "EUR", to: "GBP", rate: 0.85, annualDrift: 0 }]),
    ).toEqual([household[0], { from: "EUR", to: "GBP", rate: 0.85, annualDrift: 0 }]);
  });
  it("fxRateIssues flags same-currency rows and a pair given twice in either direction", () => {
    expect(fxRateIssues([{ from: "GBP", to: "USD" }])).toEqual([]);
    expect(fxRateIssues([{ from: "GBP", to: "GBP" }])[0]!.index).toBe(0);
    const dup = fxRateIssues([
      { from: "GBP", to: "USD" },
      { from: "USD", to: "GBP" },
    ]);
    expect(dup).toHaveLength(1);
    expect(dup[0]!.index).toBe(1);
  });
});
