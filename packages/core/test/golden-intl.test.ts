/**
 * End-to-end goldens for the seven national presets added in workstream (b2): DE, NL, FR, ES, IL,
 * IE, NZ. Each is an employee who accumulates into the local pension wrapper, retires at the
 * wrapper's access age and draws it down alongside a state pension.
 *
 * Year one is hand-checked against the tax module's own tested vectors (test/tax-*.test.ts): the
 * engine must hand the plug-in exactly the inputs of that vector (salary, pre-tax pension
 * contribution, age, no dependants), so the year-one lines equal the published working. Every
 * year must reconcile (`reconcileYear`: cash in = cash out, per-account roll-forward, net-worth
 * bridge).
 */
import { describe, expect, it } from "vitest";
import type { ProjectionResult, SimulationInputInput } from "../src/engine/types.js";
import { reconcileYear, simulate } from "../src/index.js";
import type { AccountInput } from "../src/schema/accounts.js";
import { FR_YEARS } from "../src/tax/data/fr.js";
import { frImpot } from "../src/tax/jurisdictions/fr.js";

interface Golden {
  country: string;
  region?: string;
  currency: string;
  start: string;
  birth: string;
  fiscalStartMonth?: number;
  salary: number;
  pension: { id: string; type: AccountInput["type"]; balance: number; contribution: number };
  extraAccounts?: AccountInput[];
  retireAge: number;
  accessAge: number;
  statePension: { monthly: number; age: number };
  living: number;
}

const ME = "me";

function golden(g: Golden): SimulationInputInput {
  const retire = { kind: "milestone" as const, milestoneId: "retire" };
  return {
    household: {
      id: "h",
      name: "Golden",
      planningMode: "individual",
      people: [{ id: ME, name: "Me", role: "primary", birthMonth: g.birth }],
      location: { country: g.country, ...(g.region ? { region: g.region } : {}) },
      currency: g.currency,
      locale: "en-GB",
    },
    finances: {
      asOf: g.start,
      accounts: [
        { id: "cash", name: "Cash", type: "savings", owner: ME, balance: 20_000 },
        {
          id: g.pension.id,
          name: "Pension",
          type: g.pension.type,
          owner: ME,
          balance: g.pension.balance,
        },
        ...(g.extraAccounts ?? []),
      ],
    },
    plan: {
      id: "p",
      householdId: "h",
      name: "Golden",
      milestones: [
        {
          id: "retire",
          name: "Retirement",
          kind: "retirement",
          personId: ME,
          criteria: [{ kind: "age", personId: ME, age: g.retireAge }],
        },
        {
          id: "le",
          name: "Life expectancy",
          kind: "life-expectancy",
          personId: ME,
          criteria: [{ kind: "age", personId: ME, age: 85 }],
        },
      ],
      income: [
        {
          id: "salary",
          type: "salary",
          name: "Salary",
          owner: ME,
          amount: { value: g.salary, basis: "real" },
          frequency: "yearly",
          range: { start: { kind: "planStart" }, end: retire },
        },
        {
          id: "state-pension",
          type: "state-pension",
          name: "State pension",
          owner: ME,
          amount: { value: g.statePension.monthly, basis: "real" },
          frequency: "monthly",
          range: {
            start: { kind: "age", personId: ME, age: g.statePension.age },
            end: { kind: "planEnd" },
          },
        },
      ],
      expenses: [
        {
          id: "living",
          type: "living",
          name: "Living",
          owner: ME,
          amount: { value: g.living, basis: "real" },
          frequency: "monthly",
          range: { start: { kind: "planStart" }, end: { kind: "planEnd" } },
        },
      ],
      flows: [
        {
          kind: "contribution",
          id: "fl-pension",
          name: "Pension contribution",
          owner: ME,
          accountId: g.pension.id,
          range: { start: { kind: "planStart" }, end: retire },
          method: {
            kind: "amount",
            amount: { value: g.pension.contribution, basis: "real" },
            frequency: "yearly",
          },
          limit: { kind: "jurisdiction" },
          mandatory: true,
        },
      ],
      // Surplus pay is spent, so retirement is funded by the pension wrapper and the state pension.
      leftover: { kind: "spend" },
      drawdown: {
        order: [
          { kind: "category", category: "cash" },
          { kind: "category", category: "tax-deferred" },
          { kind: "category", category: "tax-free" },
          { kind: "category", category: "taxable" },
        ],
        cashBuffer: { value: 5_000, basis: "real" },
      },
      tax: { mode: "estimate" },
      assumptions: {
        inflation: { kind: "fixed", rate: 0.02 },
        stockReturn: { kind: "fixed", rate: 0.04 },
        dividendYield: { kind: "fixed", rate: 0.02 },
        bondAllocation: { kind: "none" },
        cashReturn: { kind: "fixed", rate: 0 },
        ...(g.fiscalStartMonth
          ? { yearAlignment: { kind: "fiscal" as const, startMonth: g.fiscalStartMonth } }
          : {}),
      },
    },
    options: { trace: "summary" },
  };
}

const line = (r: ProjectionResult, i: number, re: RegExp) =>
  r.periods[i]!.taxes.lines.filter((l) => re.test(l.label)).reduce((s, l) => s + l.amount, 0);
const taxTotal = (r: ProjectionResult, i: number) =>
  r.periods[i]!.taxes.lines.reduce((s, l) => s + l.amount, 0);

/** Shape checks shared by every country: accumulate, locked until the access age, then drawn down. */
function lifecycle(r: ProjectionResult, g: Golden) {
  const [by, bm] = g.birth.split("-").map(Number) as [number, number];
  const access = by * 12 + (bm - 1) + Math.floor(g.accessAge * 12 + 1e-9);
  const retire = by * 12 + (bm - 1) + Math.floor(g.retireAge * 12 + 1e-9);
  expect(r.summary.success).toBe(true);
  for (const [i, p] of r.periods.entries()) {
    const rec = reconcileYear(r, i);
    expect(rec.balanced, `${g.country} ${p.year} does not reconcile`).toBe(true);
    const [y, m] = p.startMonth.split("-").map(Number) as [number, number];
    const start = y * 12 + (m - 1);
    const pen = p.accounts.find((a) => a.accountId === g.pension.id)!;
    if (start + p.months <= retire) expect(pen.contributions).toBeGreaterThan(0);
    if (start < access)
      expect(pen.withdrawals, `${g.country} ${p.year}: drawn before access age`).toBe(0);
  }
  const drawn = r.periods.filter((p) =>
    p.accounts.some((a) => a.accountId === g.pension.id && a.withdrawals > 0),
  );
  expect(drawn.length).toBeGreaterThan(5);
  // Growth inside the wrapper is sheltered: no yearly tax line is fed by the pension's dividends.
  for (const p of r.periods)
    expect(p.income.some((l) => l.sourceId === `dividends:${g.pension.id}`)).toBe(false);
}

const run = (g: Golden) => simulate(golden(g));

describe("golden DE: bAV (Entgeltumwandlung) -> retire at 62 -> drawdown + gesetzliche Rente", () => {
  const g: Golden = {
    country: "DE",
    currency: "EUR",
    start: "2026-01",
    birth: "1986-01",
    salary: 50_000,
    pension: { id: "bav", type: "de-bav", balance: 60_000, contribution: 3_000 },
    retireAge: 62,
    accessAge: 62,
    statePension: { monthly: 1_800, age: 67 },
    living: 1_500,
  };
  const r = run(g);

  it('year one equals the tax-de vector "bAV 3,000": ESt 6,058.11, RV 4,371, KV 4,112.50, PV 1,128', () => {
    // SV wage 50,000 - 3,000 = 47,000: RV 9.3% = 4,371; AV 1.3% = 611; KV 8.75% = 4,112.50;
    // PV 2.4% = 1,128; zvE 36,287 -> ESt 6,058.11; no Soli below the Freigrenze.
    expect(line(r, 0, /^Einkommensteuer/)).toBeCloseTo(6_058.11, 2);
    expect(line(r, 0, /Rentenversicherung/)).toBeCloseTo(4_371, 6);
    expect(line(r, 0, /Arbeitslosenversicherung/)).toBeCloseTo(611, 6);
    expect(line(r, 0, /Krankenversicherung/)).toBeCloseTo(4_112.5, 6);
    expect(line(r, 0, /Pflegeversicherung/)).toBeCloseTo(1_128, 6);
    expect(line(r, 0, /Solidarit/)).toBe(0);
    expect(r.periods[0]!.taxes.facts["de.zvE.me"]).toBeCloseTo(36_287, 6);
  });

  it("accumulates, stays locked until 62, then draws the bAV; reconciles every year", () => {
    lifecycle(r, g);
    // bAV payouts are fully taxable pension income (no Besteuerungsanteil).
    const i = r.periods.findIndex((p) =>
      p.accounts.some((a) => a.accountId === "bav" && a.withdrawals > 0),
    );
    expect(line(r, i, /^Einkommensteuer/) + line(r, i, /Krankenversicherung/)).toBeGreaterThan(0);
  });
});

describe("golden NL: pension -> retire at the AOW age -> drawdown + AOW", () => {
  const g: Golden = {
    country: "NL",
    currency: "EUR",
    start: "2026-01",
    birth: "1986-01",
    salary: 50_000,
    pension: { id: "pensioen", type: "nl-pension", balance: 80_000, contribution: 5_000 },
    retireAge: 67.25,
    accessAge: 67.25,
    statePension: { monthly: 1_400, age: 67.25 },
    living: 2_000,
  };
  const r = run(g);

  it('year one equals the tax-nl vector "50,000 with 5,000 to a pension": 8,386.29', () => {
    // box 1 on 45,000 = 16,198.22; AHK 2,138.41 + arbeidskorting 5,673.52; box 3: 20,000 of
    // savings is below the heffingsvrij vermogen, the pension is not box 3 wealth -> no box 3 tax.
    expect(r.periods[0]!.taxes.facts["nl.box1.me"]).toBeCloseTo(45_000, 6);
    expect(line(r, 0, /^Box 1/)).toBeCloseTo(16_198.2177, 4);
    expect(line(r, 0, /Heffingskortingen/)).toBeCloseTo(-(2_138.40928 + 5_673.5225), 4);
    expect(line(r, 0, /^Box 3/)).toBe(0);
    expect(taxTotal(r, 0)).toBeCloseTo(8_386.28592, 4);
  });

  it("box 3 sees savings and taxable investments only (pension excluded) once they pass the allowance", () => {
    const later = r.periods.find((p) => (p.taxes.facts["nl.box3.grondslag"] ?? 0) > 0);
    // The cash pile grows from leftovers; the pension (hundreds of thousands) is never box 3 wealth.
    if (later) {
      const cash = later.accounts.find((a) => a.accountId === "cash")!;
      expect(later.taxes.facts["nl.box3.grondslag"]!).toBeLessThan(cash.opening);
    }
  });

  it("accumulates, stays locked until the AOW age, then draws; reconciles every year", () =>
    lifecycle(r, g));
});

describe("golden FR: PER + PEA + assurance-vie -> retire at 64 -> drawdown", () => {
  const g: Golden = {
    country: "FR",
    currency: "EUR",
    start: "2026-01",
    birth: "1986-01",
    salary: 45_000,
    pension: { id: "per", type: "fr-per", balance: 70_000, contribution: 2_000 },
    extraAccounts: [
      { id: "pea", name: "PEA", type: "fr-pea", owner: ME, balance: 30_000, costBasis: 25_000 },
      { id: "av", name: "Assurance-vie", type: "fr-assurance-vie", owner: ME, balance: 20_000 },
    ],
    retireAge: 64,
    accessAge: 64,
    statePension: { monthly: 1_600, age: 64 },
    living: 2_000,
  };
  const r = run(g);

  it('year one equals the tax-fr "median 45,000" vector less the 2,000 PER deduction at 30%', () => {
    // revenu 33,213.65 - 2,000 = 31,213.65, still in the 30% band: impôt 3,068.08 - 600 = 2,468.08.
    const d = FR_YEARS[0]!;
    expect(r.periods[0]!.taxes.facts["fr.revenuImposable.me"]).toBeCloseTo(31_213.645, 6);
    expect(line(r, 0, /^Impôt sur le revenu/)).toBeCloseTo(3_068.0835 - 600, 4);
    expect(line(r, 0, /^Impôt sur le revenu/)).toBeCloseTo(
      frImpot(d, 31_213.645, 1, false).brut,
      6,
    );
    // PEA and assurance-vie dividends are capitalised: no PFU or prélèvements sociaux in year one.
    expect(line(r, 0, /PFU|Prélèvements sociaux/)).toBe(0);
    for (const id of ["pea", "av"]) {
      const a = r.periods[0]!.accounts.find((x) => x.accountId === id)!;
      expect(a.dividendsReinvested).toBeGreaterThan(0);
    }
  });

  it("accumulates, keeps the PER locked until 64, then draws; reconciles every year", () =>
    lifecycle(r, g));
});

describe("golden ES: plan de pensiones (Madrid) -> retire at 65 -> drawdown + pensión", () => {
  const g: Golden = {
    country: "ES",
    region: "MD",
    currency: "EUR",
    start: "2026-01",
    birth: "1986-01",
    salary: 30_000,
    // Asks for 3,000: the jurisdiction limit (1,500) caps it.
    pension: { id: "plan", type: "es-plan-pensiones", balance: 60_000, contribution: 3_000 },
    retireAge: 65,
    accessAge: 65,
    statePension: { monthly: 1_300, age: 67 },
    living: 1_400,
  };
  const r = run(g);

  it('year one equals the tax-es "pension plan limited to 1,500" vector: base 24,550', () => {
    // base 26,050 - 1,500; state 2,463 - 15% x 1,500 = 2,238; Madrid 2,169.58 - 12.8% x 1,500.
    expect(r.periods[0]!.accounts.find((a) => a.accountId === "plan")!.contributions).toBeCloseTo(
      1_500,
      6,
    );
    expect(r.periods[0]!.taxes.facts["es.baseGeneral.me"]).toBeCloseTo(24_550, 6);
    expect(line(r, 0, /cuota estatal/)).toBeCloseTo(2_238, 6);
    expect(line(r, 0, /Comunidad de Madrid/)).toBeCloseTo(2_169.58393 - 192, 4);
    expect(line(r, 0, /Seguridad Social/)).toBeCloseTo(0.065 * 30_000, 6);
  });

  it("accumulates and draws the plan after retirement; reconciles every year", () =>
    lifecycle(r, g));
});

describe("golden IL: pension fund -> retire at 67 -> drawdown + old-age pension", () => {
  const g: Golden = {
    country: "IL",
    currency: "ILS",
    start: "2026-01",
    birth: "1986-01",
    salary: 150_000,
    pension: { id: "keren", type: "il-pension", balance: 300_000, contribution: 9_000 },
    retireAge: 67,
    accessAge: 67,
    statePension: { monthly: 2_000, age: 67 },
    living: 6_500,
  };
  const r = run(g);

  it("year one equals the tax-il vectors: 19,392 less credit points 6,534 and 35% x 7,896 (the 9,000 contribution is capped at 658 a month); NI 10,952.56", () => {
    expect(line(r, 0, /^Income tax/)).toBeCloseTo(19_392, 6);
    expect(line(r, 0, /Credit points/)).toBeCloseTo(-(2.25 * 2_904 + 0.35 * 7_896), 6);
    expect(taxTotal(r, 0)).toBeCloseTo(19_392 - 6_534 - 2_763.6 + 10_952.556, 6);
  });

  it("accumulates, locked until 67, then draws; reconciles every year", () => lifecycle(r, g));
});

describe("golden IE: pension (age-related relief) -> retire at 60 -> drawdown + State Pension", () => {
  const g: Golden = {
    country: "IE",
    currency: "EUR",
    start: "2026-01",
    birth: "1981-01",
    salary: 50_000,
    // Asks for 20,000: relief (and the engine's limit) is 25% of earnings at 45 = 12,500.
    pension: { id: "prsa", type: "ie-pension", balance: 150_000, contribution: 20_000 },
    retireAge: 60,
    accessAge: 60,
    statePension: { monthly: 1_250, age: 66 },
    living: 1_800,
  };
  const r = run(g);

  it('year one equals the tax-ie "pension relief at 45" vector: income tax 7,500; USC 1,032.82', () => {
    const PRSI = (0.042 * 9 + 0.0435 * 3) / 12;
    expect(r.periods[0]!.accounts.find((a) => a.accountId === "prsa")!.contributions).toBeCloseTo(
      12_500,
      6,
    );
    expect(line(r, 0, /^Income tax/)).toBeCloseTo(7_500, 6);
    expect(line(r, 0, /Tax credits/)).toBeCloseTo(-4_000, 6);
    expect(line(r, 0, /Universal Social Charge/)).toBeCloseTo(1_032.82, 6);
    expect(line(r, 0, /PRSI/)).toBeCloseTo(PRSI * 50_000, 6);
  });

  it("accumulates, locked until 60, then draws; reconciles every year", () => lifecycle(r, g));
});

describe("golden NZ: KiwiSaver -> retire at 65 -> tax-free drawdown + NZ Super (April tax year)", () => {
  const g: Golden = {
    country: "NZ",
    currency: "NZD",
    start: "2026-04",
    fiscalStartMonth: 4,
    birth: "1986-04",
    salary: 65_000,
    pension: { id: "kiwisaver", type: "nz-kiwisaver", balance: 40_000, contribution: 1_950 },
    retireAge: 65,
    accessAge: 65,
    statePension: { monthly: 2_000, age: 65 },
    living: 2_600,
  };
  const r = run(g);

  it('year one (2026-27) equals the tax-nz "median 65,000" vector: 11,720.50 + ACC 1.75%', () => {
    // KiwiSaver contributions come from taxed pay: no deduction.
    expect(r.periods[0]!.year).toBe(2026);
    expect(r.periods[0]!.months).toBe(12);
    expect(line(r, 0, /^Income tax/)).toBeCloseTo(11_720.5, 6);
    expect(line(r, 0, /ACC/)).toBeCloseTo(0.0175 * 65_000, 6);
  });

  it("KiwiSaver is locked until 65 and drawn tax-free; reconciles every year", () => {
    lifecycle(r, g);
    // In a drawdown year the taxable income is NZ Super alone.
    const i = r.periods.findIndex(
      (p, k) =>
        k > 0 &&
        p.accounts.some((a) => a.accountId === "kiwisaver" && a.withdrawals > 0) &&
        p.months === 12,
    );
    const p = r.periods[i]!;
    const superIncome = p.income
      .filter((l) => l.sourceId === "state-pension")
      .reduce((s, l) => s + l.amount, 0);
    expect(line(r, i, /^Income tax/)).toBeGreaterThan(0);
    expect(p.taxes.taxableIncome).toBeCloseTo(superIncome, 6);
  });
});
