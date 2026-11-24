/**
 * Required minimum distribution (RMD) calculator: the RMD for one year from the prior year-end balance,
 * the age RMDs start for a birth year, and a projection of later RMDs at a steady return.
 *
 * Every rule comes from @glideworth/core's US federal data: `usRmdStartAge` (SECURE 2.0 start age by
 * birth year), `UNIFORM_LIFETIME` (IRS Uniform Lifetime table, Treas. Reg. §1.401(a)(9)-9(c)) and
 * `usRequiredDistribution` (prior year-end balance ÷ the factor at the age reached in the year).
 *
 * Engine use: `simulate` of one traditional IRA owned by one person born in January of the birth year,
 * from January of the distribution year, with inflation 0 (today's money). The engine takes the RMD
 * itself every year (its statutory rule for traditional accounts); the distributions are spent, so they
 * leave the account. The year-by-year formula beside it uses `usRequiredDistribution` directly.
 */
import {
  SimulationInput,
  type SimulationInputInput,
  UNIFORM_LIFETIME,
  usRequiredDistribution,
  usRmdStartAge,
} from "@glideworth/core";
import { money, pct, pctInput } from "../format";
import { num, rate, str } from "../state";
import type { ChartSpec, Timing, Values, ViewModel } from "../types";
import { run } from "./common";
import { timingText } from "./model";

const CUR = "USD";
const IRA_ID = "ira";
/** The projection runs to this age (at least ten years, never past the end of the table). */
const PROJECT_TO_AGE = 100;
const TABLE_END = 120;

export interface RmdRow {
  year: number;
  /** Age reached in the year (the age the factor is read at). */
  age: number;
  /** Uniform Lifetime factor used, or null in a year with no RMD. */
  factor: number | null;
  /** Balance at the end of the year before (the RMD is based on it). */
  prior: number;
  rmd: number;
  /** Balance at the end of the year, after the RMD and growth. */
  closing: number;
}

/** The start age as people write it: 70.5 is "70½". */
export function ageText(a: number): string {
  return Number.isInteger(a) ? String(a) : `${Math.floor(a)}½`;
}

/** First calendar year with an RMD: the year the age reached is at least the start age. */
export function firstRmdYear(born: number): number {
  return born + Math.ceil(usRmdStartAge(born));
}

export function horizon(born: number, year: number): number {
  const age = year - born;
  const endAge = Math.min(TABLE_END, Math.max(age + 10, PROJECT_TO_AGE));
  return Math.max(1, endAge - age);
}

/** Uniform Lifetime factor at an age, or null if the table has none. */
export function factorAt(age: number): number | null {
  return UNIFORM_LIFETIME[Math.min(TABLE_END, Math.floor(age))] ?? null;
}

export function buildRmdInput(v: Values): SimulationInput {
  const born = num(v, "born");
  const year = num(v, "year");
  const input: SimulationInputInput = {
    household: {
      id: "calculator",
      name: "Calculator",
      planningMode: "individual",
      people: [{ id: "you", name: "You", role: "primary", birthMonth: `${born}-01` }],
      // No country preset: the engine's own statutory RMD rule (the same core table) applies, no tax.
      location: { country: "XX" },
      currency: CUR,
      locale: "en-US",
    },
    finances: {
      asOf: `${year}-01`,
      accounts: [
        {
          id: IRA_ID,
          name: "Traditional IRA",
          type: "traditional-ira",
          owner: "you",
          balance: Math.max(0, num(v, "balance")),
        },
      ],
    },
    plan: {
      id: "calculator-plan",
      householdId: "calculator",
      name: "Calculator plan",
      tax: { mode: "flat", flat: { ordinary: 0, capitalGains: 0, dividends: 0, local: 0 } },
      // Distributions are spent, so they leave the account as they would in real life.
      leftover: { kind: "spend" },
      milestones: [],
      income: [],
      expenses: [],
      assumptions: {
        inflation: { kind: "fixed", rate: 0 },
        stockReturn: { kind: "fixed", rate: rate(v, "ret") },
        dividendYield: { kind: "fixed", rate: 0 },
        bondReturn: { kind: "fixed", rate: 0 },
        bondYield: { kind: "fixed", rate: 0 },
        cashReturn: { kind: "fixed", rate: 0 },
        bondAllocation: { kind: "none" },
        cashFlowTiming: str(v, "timing") as Timing,
        end: { kind: "ref", ref: { kind: "date", date: `${year + horizon(born, year)}-01` } },
      },
    },
    options: { trace: "off" },
  };
  return SimulationInput.parse(input);
}

/** The engine's projection: each year's RMD and balances, in today's money. */
export function engineRmds(v: Values): RmdRow[] {
  const born = num(v, "born");
  const year = num(v, "year");
  const res = run(buildRmdInput(v));
  return res.periods.map((p, i) => {
    const a = p.accounts.find((x) => x.accountId === IRA_ID);
    const rmd = a?.requiredDistribution ?? 0;
    const age = year + i - born;
    return {
      year: year + i,
      age,
      factor: rmd > 0 ? factorAt(age) : null,
      prior: a?.opening ?? 0,
      rmd,
      closing: a?.closing ?? 0,
    };
  });
}

/**
 * The same projection by hand: each year's RMD from `usRequiredDistribution`, then the balance grows
 * by r with the RMD credited with the share k of the year's return set by the timing (1 at the start,
 * ½ in the middle, 0 at the end): B' = B × (1 + r) − RMD × (1 + r)^k.
 */
export function formulaRmds(v: Values): RmdRow[] {
  const born = num(v, "born");
  const year = num(v, "year");
  const r = rate(v, "ret");
  const timing = str(v, "timing") as Timing;
  const k = timing === "start" ? 1 : timing === "mid" ? 0.5 : 0;
  let b = Math.max(0, num(v, "balance"));
  const rows: RmdRow[] = [];
  for (let i = 0; i < horizon(born, year); i++) {
    const age = year + i - born;
    const rmd = usRequiredDistribution({
      accountType: "traditional-ira",
      rule: "us-rmd",
      year: year + i,
      ownerAge: age,
      priorYearEndBalance: b,
      ownerBirthYear: born,
    });
    const closing = Math.max(0, b * (1 + r) - rmd * (1 + r) ** k);
    rows.push({
      year: year + i,
      age,
      factor: rmd > 0 ? factorAt(age) : null,
      prior: b,
      rmd,
      closing,
    });
    b = closing;
  }
  return rows;
}

export async function runRmd(v: Values): Promise<ViewModel> {
  const born = num(v, "born");
  const year = num(v, "year");
  const balance = num(v, "balance");
  const r = rate(v, "ret");
  const timing = str(v, "timing") as Timing;
  const m = (x: number) => money(x, CUR);

  const start = usRmdStartAge(born);
  const first = firstRmdYear(born);
  const rows = engineRmds(v);
  const formula = formulaRmds(v);
  const now = rows[0]!;
  const age = now.age;
  const endAge = rows[rows.length - 1]!.age;
  const firstRow = rows.find((x) => x.rmd > 0);
  const next10 = rows.slice(0, 10).reduce((s, x) => s + x.rmd, 0);
  const total = rows.reduce((s, x) => s + x.rmd, 0);
  const formulaTotal = formula.reduce((s, x) => s + x.rmd, 0);
  const tenOn = rows[Math.min(10, rows.length - 1)]!;
  const tenOnFormula = formula[Math.min(10, formula.length - 1)]!;

  const headline =
    balance <= 0
      ? `With no balance there is nothing to distribute. For people born in ${born}, RMDs start at ${ageText(start)}, so your first RMD year is ${first}.`
      : now.rmd > 0
        ? `Your ${year} required minimum distribution is ${m(now.rmd)}: ${m(balance)} divided by ${now.factor}, the Uniform Lifetime factor at age ${age}.`
        : `No RMD is due for ${year}: you reach ${age} that year, and for people born in ${born} RMDs start at ${ageText(start)}. Your first RMD year is ${first}.`;

  const ages = rows.map((x) => x.age);
  const table = {
    caption: "Projected RMDs and balances by year",
    columns: ["Year", "Age", "Factor", "Balance at start", "RMD", "Balance at end"],
    rows: rows.map((x) => [
      String(x.year),
      String(x.age),
      x.factor === null ? "–" : x.factor.toFixed(1),
      m(x.prior),
      m(x.rmd),
      m(x.closing),
    ]),
  };
  const rmdChart: ChartSpec = {
    id: "rmd-chart",
    kind: "bar",
    title: "Required minimum distribution each year, by age",
    summary: firstRow
      ? `RMDs start at ${firstRow.age} with ${m(firstRow.rmd)}${firstRow.year === year ? "" : ` in ${firstRow.year}`} and come to ${m(total)} by age ${endAge}, at a steady ${pctInput(r * 100)} after inflation. The largest is ${m(Math.max(...rows.map((x) => x.rmd)))}.`
      : `No RMD falls due by age ${endAge}.`,
    xLabel: "Age",
    yLabel: "Today’s money",
    x: ages,
    series: [
      { label: "RMD (today’s money)", values: rows.map((x) => x.rmd), tone: 1, style: "solid" },
    ],
    currency: CUR,
    table,
  };
  const balanceChart: ChartSpec = {
    id: "rmd-balance",
    kind: "line",
    title: "Account balance at the end of each year",
    summary: `The balance goes from ${m(balance)} to ${m(rows[rows.length - 1]!.closing)} at age ${endAge}, after taking every RMD and growing ${pctInput(r * 100)} a year after inflation.`,
    xLabel: "Age",
    yLabel: "Today’s money",
    x: [age - 1, ...ages],
    series: [
      {
        label: "Balance after RMDs",
        values: [balance, ...rows.map((x) => x.closing)],
        tone: 2,
        style: "solid",
      },
    ],
    markers:
      first > year && first - born <= endAge
        ? [{ x: first - born, label: `RMDs start at ${first - born}` }]
        : [],
    currency: CUR,
    table: {
      caption: "Balance at the end of each year of age",
      columns: ["Age", "Balance"],
      rows: [[String(age - 1), m(balance)], ...rows.map((x) => [String(x.age), m(x.closing)])],
    },
  };

  return {
    tool: "rmd",
    headline,
    announce: now.rmd > 0 ? `RMD for ${year}: ${m(now.rmd)}.` : `No RMD is due for ${year}.`,
    figures: [
      {
        label: `RMD for ${year}`,
        value: m(now.rmd),
        detail:
          now.rmd > 0 && balance > 0
            ? `${pct(now.rmd / balance)} of the balance`
            : `You reach ${age} in ${year}`,
      },
      {
        label: "Uniform Lifetime factor",
        value: now.factor === null ? "–" : now.factor.toFixed(1),
        detail: now.factor === null ? "No RMD this year" : `At age ${age}`,
      },
      {
        label: "RMDs start at age",
        value: ageText(start),
        detail: `Born in ${born}; first RMD year ${first}`,
      },
      {
        label: "RMDs over the next 10 years",
        value: m(next10),
        detail: `Today’s money, at ${pctInput(r * 100)} after inflation`,
      },
    ],
    charts: [rmdChart, balanceChart],
    comparison: {
      title: "Formula and engine side by side",
      rows: [
        { label: `RMD for ${year}`, formula: m(formula[0]!.rmd), engine: m(now.rmd) },
        {
          label: `RMD in ${tenOn.year} (age ${tenOn.age})`,
          formula: m(tenOnFormula.rmd),
          engine: m(tenOn.rmd),
        },
        { label: `All RMDs to age ${endAge}`, formula: m(formulaTotal), engine: m(total) },
      ],
      note: "Formula: RMD = balance at the end of the year before ÷ the Uniform Lifetime factor at the age you reach in the year, from Glideworth’s US data (usRequiredDistribution), then B′ = B × (1 + r) − RMD × (1 + r)^k with k = 1, ½ or 0 for money moving at the start, middle or end of the year. The engine takes the same RMD inside its yearly projection of a traditional IRA, so the two agree to the cent.",
    },
    method: [
      `Start age: usRmdStartAge() for a ${born} birth year (${ageText(start)}). Factors: the IRS Uniform Lifetime table in Glideworth’s US data, read at the age you reach in each year.`,
      `Projection: the engine’s simulate() of one traditional IRA from January ${year} to age ${endAge}, growing ${pctInput(r * 100)} a year after inflation, taking exactly the RMD each year and nothing else. Later RMDs are in today’s money.`,
      timingText(timing),
      "No tax is worked out: an RMD is the amount you must take out, whatever tax it then bears.",
    ],
    warnings:
      age > TABLE_END - 1
        ? ["The Uniform Lifetime table ends at 120, so the projection is one year long."]
        : [],
  };
}
