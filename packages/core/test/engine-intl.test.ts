/**
 * Engine wiring for the DE / NL / FR / ES / IL / IE / NZ presets: statutory rules whatever the tax
 * mode (NATIONAL_JURISDICTION_BY_COUNTRY), locked pension wrappers, PEA / assurance-vie income
 * sheltering, NL box 3 wealth split, state-pension hooks and country defaults.
 */
import { describe, expect, it } from "vitest";
import {
  buildSimulationInput,
  createDefaultTaxRegistry,
  defaultsForCountry,
  deRegelaltersgrenze,
  frLegalRetirementAge,
  pickYear,
  planDefaultsForHousehold,
  reconcileYear,
  simulate,
  UK_TAX_YEARS,
  ukStatePensionAge,
} from "../src/index.js";
import {
  createDeSampleDocument,
  createNlSampleDocument,
  DE_SAMPLE_PLAN_ID,
  NL_SAMPLE_PLAN_ID,
} from "../src/samples/index.js";
import { account, acct, always, expectInvariants, flatTax, period, sim } from "./engine-helpers.js";

const COUNTRIES = ["DE", "NL", "FR", "ES", "IL", "IE", "NZ"] as const;

describe("statutory rules apply in flat mode for every supported country", () => {
  it('contribution limits: DE Riester 2,100 and IE 25% of earnings cap a flat-mode "max" flow', () => {
    const run = (country: string, type: "de-riester" | "ie-pension", birth: string) =>
      simulate(
        sim({
          location: { country },
          births: [birth],
          start: "2026-01",
          years: 1,
          accounts: [acct("cash", "savings", 0), acct("pen", type, 0)],
          plan: {
            tax: flatTax(0.2),
            income: [
              {
                id: "sal",
                type: "salary",
                name: "Salary",
                owner: "me",
                amount: { value: 50_000, basis: "real" },
                frequency: "yearly",
                range: always,
              },
            ],
            flows: [
              {
                kind: "contribution",
                id: "f",
                name: "Pension",
                owner: "me",
                accountId: "pen",
                range: always,
                method: { kind: "max" },
                limit: { kind: "jurisdiction" },
              },
            ],
            leftover: { kind: "save", accountId: "cash" },
          },
        }),
      );
    expect(account(run("DE", "de-riester", "1986-01"), 2026, "pen").contributions).toBeCloseTo(
      2_100,
      6,
    );
    // Ireland at 45: 25% x 50,000
    expect(account(run("IE", "ie-pension", "1981-01"), 2026, "pen").contributions).toBeCloseTo(
      12_500,
      6,
    );
  });

  it.each([
    ["DE", "de-bav", "1980-01", 62],
    ["NL", "nl-pension", "1980-01", 67.25],
    ["FR", "fr-per", "1980-01", 64],
    ["IL", "il-pension", "1980-01", 67],
    ["IE", "ie-pension", "1980-01", 60],
    ["NZ", "nz-kiwisaver", "1980-01", 65],
  ] as const)("%s: %s is locked until %s in flat mode, then drawn", (country, type, birth, age) => {
    const r = simulate(
      sim({
        location: { country },
        births: [birth],
        start: "2035-01",
        years: 35,
        accounts: [acct("pen", type, 400_000)],
        plan: {
          tax: flatTax(0.2),
          expenses: [
            {
              id: "e",
              type: "living",
              name: "Living",
              owner: "me",
              amount: { value: 10_000, basis: "real" },
              frequency: "yearly",
              range: always,
            },
          ],
        },
      }),
    );
    expectInvariants(r);
    const accessYear = 1980 + Math.ceil(age);
    for (const p of r.periods) {
      const w = p.accounts.find((a) => a.accountId === "pen")!.withdrawals;
      if (p.year < 1980 + Math.floor(age)) expect(w, `${country} ${p.year}`).toBe(0);
      if (p.year > accessYear) expect(w, `${country} ${p.year}`).toBeGreaterThan(0);
    }
    // Before the access age the spending is unfunded (no early access to a locked wrapper).
    expect(period(r, 2036).totals.shortfall).toBeGreaterThan(0);
  });

  it("ES plans and keren hishtalmut have no age lock", () => {
    for (const [country, type] of [
      ["ES", "es-plan-pensiones"],
      ["IL", "il-keren-hishtalmut"],
    ] as const) {
      const r = simulate(
        sim({
          location: { country },
          start: "2027-01",
          years: 2,
          accounts: [acct("pen", type, 50_000)],
          plan: {
            tax: flatTax(0.2),
            expenses: [
              {
                id: "e",
                type: "living",
                name: "Living",
                owner: "me",
                amount: { value: 10_000, basis: "real" },
                frequency: "yearly",
                range: always,
              },
            ],
          },
        }),
      );
      expect(account(r, 2027, "pen").withdrawals).toBeGreaterThan(0);
    }
  });
});

describe("PEA and assurance-vie capitalise their income", () => {
  const r = simulate(
    sim({
      location: { country: "FR" },
      start: "2027-01",
      years: 2,
      accounts: [
        acct("pea", "fr-pea", 100_000, { costBasis: 100_000 }),
        acct("cto", "taxable", 100_000, { costBasis: 100_000 }),
      ],
      plan: {
        tax: { mode: "estimate" },
        assumptions: { dividendYield: { kind: "fixed", rate: 0.03 } },
        // Paid out where the account allows it: the PEA keeps its dividends anyway.
        accountSettings: {
          pea: { dividends: { yield: { kind: "inherit" }, treatment: "auto", reinvest: false } },
          cto: { dividends: { yield: { kind: "inherit" }, treatment: "auto", reinvest: false } },
        },
      },
    }),
  );

  it("PEA dividends are reinvested, untaxed and do not raise the cost basis", () => {
    const pea = account(r, 2027, "pea");
    expect(pea.dividends).toBeCloseTo(3_000, 6);
    expect(pea.dividendsReinvested).toBeCloseTo(3_000, 6);
    expect(pea.closing - pea.growth - pea.contributions).toBeCloseTo(103_000, 6);
    expect(period(r, 2027).income.some((l) => l.sourceId === "dividends:pea")).toBe(false);
    // The ordinary securities account pays its 3,000 out and the PFU taxes it: 12.8% + 18.6%.
    const p = period(r, 2027);
    const capitalLines = p.taxes.lines.filter((l) =>
      /PFU|Prélèvements sociaux \(capital\)/.test(l.label),
    );
    expect(capitalLines.reduce((s, l) => s + l.amount, 0)).toBeCloseTo(3_000 * (0.128 + 0.186), 6);
    for (let i = 0; i < r.periods.length; i++) expect(reconcileYear(r, i).balanced).toBe(true);
  });

  it("a PEA withdrawal realises the capitalised income as a gain (18.6% social levies after 5 years)", () => {
    const w = simulate(
      sim({
        location: { country: "FR" },
        start: "2027-01",
        years: 2,
        accounts: [acct("pea", "fr-pea", 100_000, { costBasis: 80_000 })],
        plan: {
          tax: { mode: "estimate" },
          expenses: [
            {
              id: "e",
              type: "living",
              name: "Living",
              owner: "me",
              amount: { value: 10_000, basis: "real" },
              frequency: "yearly",
              range: always,
            },
          ],
        },
      }),
    );
    const p = period(w, 2027);
    const drawn = account(w, 2027, "pea").withdrawals;
    const peaSocial = p.taxes.lines.filter((l) => /Prélèvements sociaux \(PEA\)/.test(l.label));
    expect(peaSocial.reduce((s, l) => s + l.amount, 0)).toBeCloseTo(0.186 * drawn * 0.2, 6);
  });
});

describe("NL box 3 sees savings, taxable investments and debts (not pensions or the main home)", () => {
  it("the tax input wealth split drives box 3", () => {
    const r = simulate(
      sim({
        location: { country: "NL" },
        start: "2027-01",
        years: 1,
        accounts: [
          acct("spaar", "savings", 100_000),
          acct("beleg", "taxable", 200_000),
          acct("pensioen", "nl-pension", 500_000),
        ],
        finances: {
          debts: [
            {
              id: "loan",
              name: "Personal loan",
              type: "personal-loan",
              owner: "me",
              balance: 10_000,
              interest: { apr: 0, method: "simple", compounding: "monthly" },
              monthlyPayment: { value: 0, basis: "nominal" },
            },
          ],
          realAssets: [
            {
              id: "home",
              name: "Home",
              type: "house",
              owner: "me",
              currentValue: 400_000,
              loan: {
                id: "mortgage",
                balance: 300_000,
                interest: { apr: 0, method: "simple", compounding: "monthly" },
                monthlyPayment: { value: 0, basis: "nominal" },
              },
              behaviour: { usage: "primary-residence" },
            },
          ],
        },
        plan: { tax: { mode: "estimate" } },
      }),
    );
    // grondslag = 100,000 + 200,000 - (10,000 - schuldendrempel 3,800) - heffingsvrij 59,357
    const f = period(r, 2027).taxes.facts;
    expect(f["nl.box3.grondslag"]).toBeCloseTo(100_000 + 200_000 - (10_000 - 3_800) - 59_357, 6);
  });
});

describe("state pension hooks", () => {
  const reg = createDefaultTaxRegistry();
  it("statutory ages: UK SPA, DE Regelaltersgrenze, NL AOW age", () => {
    expect(reg.get("uk").statePensionAge!({ birthYear: 1980, birthMonth: 1 })).toBe(68);
    expect(ukStatePensionAge("1970-06")).toBe(ukStatePensionAge(1970, 6));
    expect(deRegelaltersgrenze(1950)).toBeCloseTo(65 + 4 / 12, 12);
    expect(deRegelaltersgrenze(1960)).toBeCloseTo(66 + 4 / 12, 12);
    expect(deRegelaltersgrenze(1970)).toBe(67);
    expect(reg.get("nl").statePensionAge!({ birthYear: 1990, birthMonth: 1 })).toBe(67.25);
    expect(pickYear(UK_TAX_YEARS, 2026).startYear).toBe(2026);
  });

  it("a German Rente started two years after the Regelaltersgrenze is 12% higher (0.5% a month)", () => {
    const make = (age: number) =>
      simulate(
        sim({
          location: { country: "DE" },
          births: ["1970-01"],
          start: "2030-01",
          years: 12,
          plan: {
            tax: flatTax(0),
            income: [
              {
                id: "rente",
                type: "state-pension",
                name: "Rente",
                owner: "me",
                amount: { value: 1_000, basis: "real" },
                frequency: "monthly",
                range: { start: { kind: "age", personId: "me", age }, end: { kind: "planEnd" } },
              },
            ],
          },
        }),
      );
    const onTime = period(make(67), 2040).income.find((l) => l.sourceId === "rente")!.amount;
    const deferred = period(make(69), 2040).income.find((l) => l.sourceId === "rente")!.amount;
    expect(deferred / onTime).toBeCloseTo(1.12, 9);
  });
});

describe("country defaults for the new presets", () => {
  it.each(COUNTRIES)(
    "%s: own estimate stack, currency, tax year, wrappers and state pension",
    (c) => {
      const d = defaultsForCountry(c, { birthMonth: "1980-05" });
      expect(d.tax.mode).toBe("estimate");
      expect(d.tax.jurisdictions).toEqual([c.toLowerCase()]);
      expect(d.currency).toBe(c === "IL" ? "ILS" : c === "NZ" ? "NZD" : "EUR");
      expect(d.statePension?.incomeType).toBe("state-pension");
      expect(d.statePension!.startAge).toBeGreaterThanOrEqual(64);
      expect(d.accountTypes.workplacePension).toMatch(new RegExp(`^${c.toLowerCase()}-`));
      const plan = planDefaultsForHousehold({
        location: { country: c },
        people: [
          { role: "primary", birthMonth: "1980-05" },
          { role: "partner", birthMonth: "1982-01" },
        ],
      });
      expect(plan.tax?.mode).toBe("estimate");
      expect(plan.tax?.filingStatus).toBe(
        ["DE", "FR", "IE"].includes(c) ? "married-joint" : "single",
      );
      expect(plan.assumptions?.yearAlignment).toEqual(
        c === "NZ" ? { kind: "fiscal", startMonth: 4 } : { kind: "calendar" },
      );
    },
  );

  it("cohort ages: DE 66y4m for 1960, NL 67y3m, FR 64 from 1968, ES 67", () => {
    expect(defaultsForCountry("DE", { birthMonth: "1960-05" }).statePension!.startAge).toBeCloseTo(
      66 + 4 / 12,
      9,
    );
    expect(defaultsForCountry("NL", { birthMonth: "1970-05" }).statePension!.startAge).toBe(67.25);
    expect(frLegalRetirementAge(1963)).toBe(62.75);
    expect(defaultsForCountry("FR", { birthMonth: "1975-05" }).statePension!.startAge).toBe(64);
    expect(defaultsForCountry("ES").statePension!.startAge).toBe(67);
    expect(defaultsForCountry("DE").statePension!.deferralUplift).toBe(true);
  });
});

describe("DE and NL samples", () => {
  it.each([
    [createDeSampleDocument, DE_SAMPLE_PLAN_ID, "de"],
    [createNlSampleDocument, NL_SAMPLE_PLAN_ID, "nl"],
  ] as const)(
    "%#: runs in estimate mode, fully funded, reconciling every year",
    (make, planId, stack) => {
      const doc = make();
      const r = simulate(buildSimulationInput(doc, planId));
      expect(r.summary.success).toBe(true);
      expect(r.periods[0]!.taxes.lines.every((l) => l.jurisdictionId === stack)).toBe(true);
      for (let i = 0; i < r.periods.length; i++) expect(reconcileYear(r, i).balanced).toBe(true);
    },
  );
});

describe("72(t) fixed annuitisation uses the IRS mortality rates", () => {
  it("the §1.401(a)(9)-9(e) rates reproduce the 2022 Single Life Table (truncated to 0.1)", async () => {
    const { IRS_MORTALITY_RATES, seppAnnuityFactor } = await import("../src/index.js");
    expect(IRS_MORTALITY_RATES).toHaveLength(121);
    const le = (x: number) => {
      let l = 1;
      let s = 0;
      for (let t = x; t < 400; t++) {
        l *= 1 - IRS_MORTALITY_RATES[Math.min(120, t)]!;
        s += l;
      }
      return Math.floor((s + 0.5) * 10 + 1e-9) / 10;
    };
    expect([le(50), le(60), le(70), le(80)]).toEqual([36.2, 27.1, 18.8, 11.2]);
    // Annuity due of 1 a year for life from 50 at 5%.
    expect(seppAnnuityFactor(50, 0.05)).toBeCloseTo(16.8615, 3);
    expect(seppAnnuityFactor(50, 0)).toBeCloseTo(le(50) + 0.5, 0);
  });
});
