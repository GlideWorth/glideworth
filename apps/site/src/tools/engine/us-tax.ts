/**
 * Shared code of the US tax calculators (retirement tax, Roth conversion, ACA premium tax credit).
 * One tax year is computed by the engine's own US federal plug-in (`usFederalJurisdiction`) on a
 * `TaxYearInput` built here, through core's tax analytics (`analyzeTaxYear`, `incomeHeadroom`,
 * `incrementalTax`, `marginalProgression`). Every rate, bracket and threshold comes from core's
 * `US_FEDERAL_YEARS`, `US_FIXED` and `US_ACA_YEARS`, which cite the IRS and HHS sources; nothing is
 * typed in here.
 *
 * Shared choices, stated on every page:
 *  - Federal income tax only: no state or local tax, no payroll tax.
 *  - Medicare IRMAA surcharges are switched off ('us.irmaa': false): the plug-in estimates them from
 *    the MAGI of two years earlier, which a one-year calculator does not have.
 *  - Amounts are the year's own (nominal) dollars, and the year's published table applies as is.
 */
import {
  analyzeTaxYear,
  type FilingStatus,
  incomeHeadroom,
  incrementalTax,
  marginalProgression,
  pickYear,
  type ResolvedTaxCharacter,
  runTaxStack,
  type TaxIncomeItem,
  type TaxJurisdiction,
  type TaxWithdrawalItem,
  type TaxYearInput,
  TaxConfig,
  US_ACA_YEARS,
  US_FEDERAL_YEARS,
  type UsFederalYear,
  usFederalJurisdiction,
} from "@glideworth/core";

export const US_STACK: TaxJurisdiction[] = [usFederalJurisdiction];
export const YOU = "you";
export const SPOUSE = "spouse";

/** Filing statuses in the order the calculators offer them, with plain labels. */
export const FILING_LABELS: Record<FilingStatus, string> = {
  single: "Single",
  "married-joint": "Married filing jointly",
  "married-separate": "Married filing separately",
  "head-of-household": "Head of household",
  "qualifying-surviving-spouse": "Qualifying surviving spouse",
};

export function federalYear(year: number): UsFederalYear {
  return pickYear(US_FEDERAL_YEARS, year);
}

export type UsAcaYear = (typeof US_ACA_YEARS)[number];

export function acaYear(year: number): UsAcaYear {
  return pickYear(US_ACA_YEARS, year);
}

export interface UsYearOptions {
  year: number;
  status: FilingStatus;
  /** Age of each person at the end of the year: one person, or two on a joint return. */
  ages: number[];
  income?: { id: string; character: ResolvedTaxCharacter; amount: number }[];
  /** Taxable withdrawals from a traditional IRA or 401(k) (ordinary income, no early penalty). */
  deferredWithdrawals?: number;
  aca?: TaxYearInput["aca"];
}

/** One tax year for the federal plug-in. Zero amounts are dropped. */
export function usTaxInput(o: UsYearOptions): TaxYearInput {
  const joint = o.status === "married-joint" && o.ages.length > 1;
  const people = (joint ? o.ages.slice(0, 2) : o.ages.slice(0, 1)).map((age, i) => ({
    id: i === 0 ? YOU : SPOUSE,
    role: i === 0 ? ("primary" as const) : ("partner" as const),
    age,
    alive: true,
  }));
  const income: TaxIncomeItem[] = (o.income ?? [])
    .filter((x) => x.amount > 0)
    .map((x) => ({
      sourceId: x.id,
      owner: YOU,
      character: x.character,
      amount: x.amount,
      exemptIn: [],
    }));
  const w = o.deferredWithdrawals ?? 0;
  const withdrawals: TaxWithdrawalItem[] =
    w > 0
      ? [
          {
            accountId: "ira",
            accountType: "traditional-ira",
            treatment: "tax-deferred",
            owner: YOU,
            amount: w,
            taxableAmount: w,
            character: "ordinary",
            penaltyRate: 0,
            ownerAge: o.ages[0] ?? 65,
          },
        ]
      : [];
  return {
    year: o.year,
    periodIndex: 0,
    months: 12,
    filingStatus: o.status,
    location: { country: "US" },
    people,
    dependents: [],
    priceIndex: 1,
    income,
    withdrawals,
    deductions: [],
    config: TaxConfig.parse({
      mode: "estimate",
      jurisdictions: ["us-federal"],
      filingStatus: o.status,
      lawToggles: { "us.irmaa": false },
    }),
    history: [],
    ...(o.aca ? { aca: o.aca } : {}),
  };
}

export function analyse(input: TaxYearInput) {
  const a = analyzeTaxYear(US_STACK, input, { types: ["ordinary"] });
  const facts: Record<string, number> = {};
  for (const out of a.outputs) Object.assign(facts, out.facts);
  return { ...a, facts };
}

/** The plug-in's facts for one year (no explanation, no marginal rates): the cheap path. */
export function federalFacts(input: TaxYearInput): Record<string, number> {
  const facts: Record<string, number> = {};
  for (const out of runTaxStack(US_STACK, input)) Object.assign(facts, out.facts);
  return facts;
}

/** Extra ordinary income (a conversion) that keeps the ordinary bracket at or below `rate`. */
export function bracketHeadroom(input: TaxYearInput, rate: number): number {
  return incomeHeadroom(US_STACK, input, { kind: "bracket", rate }, { tolerance: 0.5 });
}

/** Federal tax added by `amount` more ordinary income (a conversion) this year. */
export function extraTax(input: TaxYearInput, amount: number): number {
  return amount > 0 ? incrementalTax(US_STACK, input, amount, "ordinary") : 0;
}

/** Tax rate on each further step of ordinary income, up to `upTo`. */
export function progression(input: TaxYearInput, upTo: number, step: number) {
  return marginalProgression(US_STACK, input, "ordinary", upTo, step);
}

/** The year's ordinary bracket rates for a filing status (from core's table). */
export function bracketRates(year: number, status: FilingStatus): number[] {
  return federalYear(year).brackets[status].map(([, r]) => r);
}

/** Lower threshold of each ordinary bracket and the rate, plus the upper threshold (Infinity at the top). */
export function bracketRows(
  year: number,
  status: FilingStatus,
): { from: number; to: number; rate: number }[] {
  const rows = federalYear(year).brackets[status];
  return rows.map(([from, rate], i) => ({
    from,
    to: rows[i + 1]?.[0] ?? Number.POSITIVE_INFINITY,
    rate,
  }));
}

/** "12%" from 0.12 (whole percents as published). */
export function ratePct(r: number): string {
  return `${Number((r * 100).toFixed(2))}%`;
}

/** Plain list of the core sources for a year's tables, for the method text. */
export function sourceNotes(year: number): string[] {
  return federalYear(year)
    .sources.map((s) => s.note ?? s.url)
    .filter((n) => !/HTML of/.test(n));
}
