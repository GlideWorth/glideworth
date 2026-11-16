/**
 * UK rules for people who leave or arrive: State Pension uprating abroad, voluntary National
 * Insurance, the inheritance tax long-term-residence test (from 6 April 2025) and its tail after
 * leaving. Sources: gov.uk pages cited beside each table (UK_NON_RESIDENT_SOURCES).
 */
import { EEA_COUNTRIES } from "./nonresident.js";
import type { Source } from "./types.js";

/**
 * Countries where the UK State Pension is uprated every year: the EEA, Switzerland, Gibraltar and
 * countries with a social security agreement that provides for uprating (not Canada or New
 * Zealand). Everywhere else it is frozen at the rate first paid abroad, and goes back to the
 * current rate when the pensioner returns to live in the UK.
 */
export const UK_STATE_PENSION_UPRATED_COUNTRIES: readonly string[] = [
  "GB",
  ...EEA_COUNTRIES,
  "CH",
  "GI",
  "BB",
  "BM",
  "BA",
  "GG",
  "IM",
  "IL",
  "JM",
  "JE",
  "XK",
  "MU",
  "ME",
  "MK",
  "PH",
  "RS",
  "TR",
  "US",
];

export const UK_STATE_PENSION_UPRATING_SOURCES: readonly Source[] = [
  {
    url: "https://www.gov.uk/government/publications/state-pensions-annual-increases-if-you-live-abroad/countries-where-we-pay-an-annual-increase-in-the-state-pension",
    year: "2026",
    note: "Countries where the State Pension is increased each year",
  },
  {
    url: "https://www.gov.uk/state-pension-if-you-retire-abroad/rates-of-state-pension",
    year: "2026",
    note: "Increases only in the EEA, Gibraltar, Switzerland and social security agreement countries (not Canada or New Zealand)",
  },
];

export function ukStatePensionUprated(country: string): boolean {
  return UK_STATE_PENSION_UPRATED_COUNTRIES.includes(country);
}

/** Voluntary National Insurance while abroad (2026-27 rules). */
export const UK_VOLUNTARY_NI = {
  year: "2026-27",
  class3Weekly: 18.4,
  class2Weekly: 3.65,
  /** From 2026-27 Class 2 cannot be paid for time abroad. */
  class2AbroadAvailable: false,
  /** Class 3 abroad needs 10 years' continuous UK residence or 10 qualifying years. */
  minYearsResidenceOrContributions: 10,
  /** Years for the full new State Pension, and the minimum for any. */
  fullRateYears: 35,
  minimumYears: 10,
  sources: [
    {
      url: "https://www.gov.uk/voluntary-national-insurance-contributions/rates",
      year: "2026-27",
      note: "Class 3 £18.40 a week; Class 2 £3.65 a week",
    },
    {
      url: "https://www.gov.uk/voluntary-national-insurance-contributions/if-you-live-or-work-abroad",
      year: "2026-27",
      note: "From 2026-27: no Class 2 for time abroad; Class 3 needs 10 years of UK residence or 10 years of contributions",
    },
    {
      url: "https://www.gov.uk/new-state-pension/living-and-working-overseas",
      year: "2026",
    },
  ] as readonly Source[],
} as const;

// ------------------------------------------------------------------ inheritance tax

export const UK_IHT_LONG_TERM_RESIDENCE = {
  /** In scope for worldwide assets when UK resident for at least 10 of the previous 20 tax years. */
  yearsRequired: 10,
  lookbackYears: 20,
  minTail: 3,
  maxTail: 10,
  from: "2025-04",
  sources: [
    {
      url: "https://www.gov.uk/guidance/inheritance-tax-if-youre-a-long-term-uk-resident",
      year: "2025",
      note: "Long-term UK residents: 10 of the previous 20 tax years; worldwide assets in scope",
    },
    {
      url: "https://www.gov.uk/hmrc-internal-manuals/inheritance-tax-manual/ihtm47020",
      year: "2025",
      note: "Tail after leaving: 3 tax years for 10-13 years of residence, one more per extra year, at most 10",
    },
  ] as readonly Source[],
} as const;

/** Tax years a former long-term resident stays in scope after leaving, from years resident in the last 20. */
export function ukIhtTailYears(yearsResidentInLast20: number): number {
  const r = UK_IHT_LONG_TERM_RESIDENCE;
  if (yearsResidentInLast20 < r.yearsRequired) return 0;
  return Math.max(r.minTail, Math.min(r.maxTail, Math.floor(yearsResidentInLast20) - 10));
}

/**
 * Long-term UK residence for inheritance tax in tax year `taxYear` (starting 6 April `taxYear`):
 * `ukResidentYears` = the tax years (start years) the person was UK resident. Resident in at least
 * 10 of the 20 tax years before `taxYear`. Ten consecutive non-resident years reset the test.
 */
export function ukLongTermResident(ukResidentYears: ReadonlySet<number>, taxYear: number): boolean {
  let n = 0;
  for (let y = taxYear - 20; y < taxYear; y++) if (ukResidentYears.has(y)) n++;
  return n >= UK_IHT_LONG_TERM_RESIDENCE.yearsRequired;
}

/**
 * Whether worldwide (non-UK) assets are in scope of UK IHT in `taxYear` for someone whose UK
 * residence years are `ukResidentYears`: either a long-term resident now, or inside the tail after
 * leaving (counted from the first non-resident tax year).
 */
export function ukIhtWorldwideScope(
  ukResidentYears: ReadonlySet<number>,
  taxYear: number,
): { inScope: boolean; reason: string } {
  if (ukResidentYears.has(taxYear))
    return ukLongTermResident(ukResidentYears, taxYear)
      ? {
          inScope: true,
          reason: "UK resident and long-term resident (10 of the last 20 tax years)",
        }
      : { inScope: false, reason: "UK resident for fewer than 10 of the last 20 tax years" };
  // Non-resident: in scope only within the tail, which depends on the years of residence before leaving.
  let lastResident = -Infinity;
  for (const y of ukResidentYears) if (y < taxYear && y > lastResident) lastResident = y;
  if (!Number.isFinite(lastResident)) return { inScope: false, reason: "never UK resident" };
  let n = 0;
  for (let y = lastResident + 1 - 20; y <= lastResident; y++) if (ukResidentYears.has(y)) n++;
  const tail = ukIhtTailYears(n);
  if (tail > 0 && taxYear - lastResident <= tail)
    return { inScope: true, reason: `left the UK: in scope for ${tail} tax years after leaving` };
  return { inScope: false, reason: "not a long-term UK resident: only UK assets are in scope" };
}
