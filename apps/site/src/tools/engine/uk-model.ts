/**
 * The UK calculators' household: one person in the United Kingdom with the engine's UK tax estimate
 * (`tax.mode: 'estimate'`), instead of model.ts's flat-tax household in no country. Every UK figure
 * (bands, allowances, State Pension, pension ages, tax-free cash) comes from @glideworth/core:
 * `UK_TAX_YEARS`, `UK_PENSION_ACCESS`, `ukStatePensionAge`, the UK jurisdiction and the engine's
 * pension rules. Nothing here types a rate, threshold or age.
 *
 * Conventions (stated on both pages):
 *  - Today's money. The visitor gives a return after inflation and an inflation rate; the engine runs
 *    in pounds of each year (so frozen tax thresholds lose value, as the law has them) and the
 *    results are deflated back to today's money with `toBasis`.
 *  - Calendar years: plan year Y uses tax year Y/Y+1 (the engine's default alignment).
 *  - Whatever is left after spending is spent (`leftover: 'spend'`), never saved.
 */
import {
  type IncomeEventInput,
  type PeriodResult,
  pickYear,
  SimulationInput,
  simulate,
  type SimulationInputInput,
  TAX_SIMPLIFICATIONS,
  toBasis,
  UK_PENSION_ACCESS,
  UK_TAX_YEARS,
  type UkTaxYear,
  ukStatePensionAge,
} from "@glideworth/core";
import type { Timing } from "../types";
import { PERSON_ID, START_MONTH, START_YEAR } from "./model";

export type UkRegion = "ruk" | "sct";

type PlanInput = SimulationInputInput["plan"];

export interface UkModelOptions {
  /** Age at the plan start (whole years; born in January). */
  age: number;
  /** Plan length in whole years. */
  years: number;
  region: UkRegion;
  /** Inflation (fraction). Thresholds follow the engine's legislated policy against it. */
  inflation: number;
  /** Return after inflation (fraction). */
  realReturn: number;
  timing: Timing;
  accounts: SimulationInputInput["finances"]["accounts"];
  income?: PlanInput["income"];
  expenses?: PlanInput["expenses"];
  flows?: PlanInput["flows"];
}

/** The tax year of the calculators' first plan year (2026/27 for START_YEAR 2026). */
export function ukFirstTaxYear(): UkTaxYear {
  return pickYear(UK_TAX_YEARS, START_YEAR);
}

/** Birth year of a person who is `age` at the plan start (born in January). */
export function birthYear(age: number): number {
  return START_YEAR - age;
}

/** State Pension age from the engine's UK data (month-accurate; born in January). */
export function statePensionAge(age: number): number {
  return ukStatePensionAge(birthYear(age), 1);
}

/**
 * The first age from which a UK pension stays open without a break, by the engine's rule
 * (`ukPensionOpenAt`): the normal minimum pension age in force at the time, which rises on the date
 * in `UK_PENSION_ACCESS`. Someone who reaches the lower age before that date but is under the later
 * age then loses access again until the later age.
 */
export function steadyPensionAccessAge(age: number): number {
  const A = UK_PENSION_ACCESS;
  const birth = birthYear(age) * 12;
  const rises = A.laterFromYear * 12 + (A.laterFromMonth - 1);
  const open = (m: number) => m >= birth + 12 * (m < rises ? A.age : A.laterAge);
  let lastClosed = birth - 1;
  for (let m = birth; m < birth + 12 * A.laterAge; m++) if (!open(m)) lastClosed = m;
  return (lastClosed + 1 - birth) / 12;
}

/** Yearly amount of a weekly benefit, as the engine counts weeks (52 a year). */
export const WEEKS_PER_YEAR = 52;

/** The State Pension as an income event from State Pension age (already in payment if older). */
export function statePensionEvent(weekly: number, age: number): IncomeEventInput {
  const spa = statePensionAge(age);
  return {
    id: "sp",
    type: "state-pension",
    name: "State Pension",
    owner: PERSON_ID,
    country: "GB",
    amount: { value: weekly, basis: "real" },
    frequency: "weekly",
    // Rises with prices only (no triple lock); no deferral: it starts at State Pension age.
    deferral: { kind: "none" },
    range: {
      start: age >= spa ? { kind: "planStart" } : { kind: "age", personId: PERSON_ID, age: spa },
      end: { kind: "planEnd" },
    },
  };
}

export function ukInput(o: UkModelOptions): SimulationInput {
  const nominal = (1 + o.realReturn) * (1 + o.inflation) - 1;
  const input: SimulationInputInput = {
    household: {
      id: "calculator",
      name: "Calculator",
      planningMode: "individual",
      people: [
        {
          id: PERSON_ID,
          name: "You",
          role: "primary",
          birthMonth: `${birthYear(o.age)}-01`,
        },
      ],
      // The UK estimate: rest-of-UK rates in England, Scottish rates on non-savings income in Scotland.
      location: { country: "GB", region: o.region === "sct" ? "SCT" : "ENG" },
      currency: "GBP",
      locale: "en-GB",
    },
    finances: { asOf: START_MONTH, accounts: o.accounts },
    plan: {
      id: "calculator-plan",
      householdId: "calculator",
      name: "Calculator plan",
      tax: { mode: "estimate", filingStatus: "single" },
      leftover: { kind: "spend" },
      milestones: [],
      income: o.income ?? [],
      expenses: o.expenses ?? [],
      flows: o.flows ?? [],
      assumptions: {
        inflation: { kind: "fixed", rate: o.inflation },
        stockReturn: { kind: "fixed", rate: nominal },
        dividendYield: { kind: "fixed", rate: 0 },
        bondReturn: { kind: "fixed", rate: o.inflation },
        bondYield: { kind: "fixed", rate: 0 },
        cashReturn: { kind: "fixed", rate: o.inflation },
        bondAllocation: { kind: "none" },
        cashFlowTiming: o.timing,
        end: { kind: "ref", ref: { kind: "date", date: `${START_YEAR + o.years}-01` } },
      },
    },
    options: { trace: "off" },
  };
  return SimulationInput.parse(input);
}

/** A yearly real amount from `from` to `to` years after the plan start (to = null: plan end). */
export function yearly(
  id: string,
  name: string,
  amount: number,
  from: number,
  to: number | null,
): NonNullable<PlanInput["expenses"]>[number] {
  return {
    id,
    type: "living",
    name,
    owner: PERSON_ID,
    amount: { value: amount, basis: "real" },
    frequency: "yearly",
    range: {
      start: { kind: "planStart", offsetMonths: Math.round(from * 12) },
      end:
        to === null
          ? { kind: "planEnd" }
          : { kind: "planStart", offsetMonths: Math.round(to * 12) },
    },
  };
}

// ------------------------------------------------------------------------------------ formatting

/** An age with months ("67 and 3 months"), for State Pension and pension access ages. */
export function fmtAge(a: number): string {
  const y = Math.floor(a + 1e-9);
  const mo = Math.round((a - y) * 12);
  if (mo === 0) return String(y);
  if (mo === 12) return String(y + 1);
  return `${y} and ${mo} month${mo === 1 ? "" : "s"}`;
}

/** A weekly amount in pounds and pence (£241.30). */
export function weekly(x: number): string {
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: "GBP",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(x);
}

// ------------------------------------------------------------------------------- reading results

export const real = (p: PeriodResult, v: number) => toBasis(v, p, "real", "flow");
export const realStock = (p: PeriodResult, v: number) => toBasis(v, p, "real", "stock");

export function accountOf(p: PeriodResult, id: string) {
  return p.accounts.find((a) => a.accountId === id);
}

export function incomeOf(p: PeriodResult, id: string): number {
  return p.income.filter((i) => i.sourceId === id).reduce((s, i) => s + i.amount, 0);
}

export function expenseOf(p: PeriodResult, id: string): { requested: number; funded: number } {
  const lines = p.expenses.filter((e) => e.sourceId === id);
  return {
    requested: lines.reduce((s, e) => s + e.requested, 0),
    funded: lines.reduce((s, e) => s + e.funded, 0),
  };
}

let taxFreeShare: number | undefined;

/**
 * The tax-free share of a UFPLS withdrawal as the engine applies it (the engine's default; it is not
 * part of the sourced tax data, so the pages print this measured value instead of typing a figure).
 */
export function ukTaxFreeShare(): number {
  if (taxFreeShare === undefined) {
    const r = simulate(
      ukInput({
        age: 70,
        years: 1,
        region: "ruk",
        inflation: 0,
        realReturn: 0,
        timing: "start",
        accounts: [
          {
            id: "pot",
            name: "Pension",
            type: "uk-sipp",
            owner: PERSON_ID,
            balance: 100_000,
            behaviour: { ukDrawdownMethod: "ufpls" },
          },
        ],
        expenses: [yearly("need", "Need", 10_000, 0, null)],
      }),
    );
    const p = r.periods[0]!;
    taxFreeShare = (p.totals.taxFreePensionCash ?? 0) / (accountOf(p, "pot")?.withdrawals ?? 1);
  }
  return taxFreeShare;
}

// --------------------------------------------------------------------------- what the model leaves out

/**
 * The UK model's stated simplifications that bear on pension drawdown and saving (from core's
 * `TAX_SIMPLIFICATIONS.uk`, matched by their opening words; a test fails if one disappears).
 */
export const UK_SIMPLIFICATION_KEYS = {
  taxYears: "Tax years ",
  calendar: "Plans on calendar years",
  pta: "Pension Tax Allowance",
  annualAllowance: "Pension annual allowance",
  taxFreeCash: "Tax-free pension cash",
  scotland: "Scottish taxpayers",
  benefits: "Means-tested benefits",
} as const;

export function ukSimplification(key: keyof typeof UK_SIMPLIFICATION_KEYS): string {
  const start = UK_SIMPLIFICATION_KEYS[key];
  return (TAX_SIMPLIFICATIONS.uk ?? []).find((s) => s.startsWith(start)) ?? "";
}

/** The model's own description of how thresholds move, for the method list. */
export function thresholdText(inflation: number): string {
  return inflation > 0
    ? `The engine runs in pounds of each year with ${(inflation * 100).toFixed(1)}% inflation, so tax thresholds frozen by law stay fixed in pounds until the freeze ends and then rise with prices (the engine’s legislated threshold policy). Every figure shown is converted back to today’s money.`
    : "With 0% inflation, tax thresholds keep their value in today’s money.";
}
