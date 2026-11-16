/**
 * Cross-border tax model: data contracts. Everything here is plain data so the API and the web can
 * show "how this is taxed and why" from the same tables the engine uses.
 */
import type { AccountType } from "../../schema/accounts.js";

/** What kind of income an item is, for source-country and treaty rules. */
export const INCOME_CATEGORIES = [
  "employment",
  "self-employment",
  "rental",
  "private-pension",
  "pension-lump-sum",
  "state-pension",
  "government-pension",
  "interest",
  "dividends",
  "gains-property",
  "gains-securities",
  "other",
] as const;
export type IncomeCategory = (typeof INCOME_CATEGORIES)[number];

export interface Source {
  url: string;
  /** Tax year or date of the guidance. */
  year: string;
  note?: string;
}

/** How a country taxes NON-residents on one category of income sourced there. */
export interface SourceRule {
  taxed: boolean;
  /**
   * 'resident-rates': the country's own national calculation on the sourced items (with the
   * non-resident personal allowance rule); 'flat': `rate` on the taxable amount (final withholding).
   */
  method?: "resident-rates" | "flat";
  rate?: number;
  note: string;
}

/** What happens to a tax-advantaged wrapper of this country when its holder is non-resident. */
export interface WrapperRule {
  accountTypes: readonly AccountType[];
  /** Income and gains inside stay free of THIS country's tax. */
  keepsShelter: boolean;
  /**
   * New contributions while non-resident: 'allowed'; 'none' (blocked from the first tax year of
   * non-residence); 'relief-capped' (allowed up to `capGross` a year for `yearsAfterDeparture`
   * tax years after leaving, then none).
   */
  contributions: "allowed" | "none" | "relief-capped";
  capGross?: number;
  yearsAfterDeparture?: number;
  note: string;
}

export interface DepartureRule {
  kind: "deemed-disposal";
  /** What is taxed: Glideworth applies it to taxable (non-registered) investment accounts. */
  scope: string;
  /** The individual may elect to defer (CA T1244 security; AU choose to disregard). */
  deferrable: boolean;
  note: string;
  sources: readonly Source[];
}

export interface NonResidentRules {
  country: string;
  label: string;
  /** 'high': implemented in detail from official guidance; 'basic': sound general rules. */
  depth: "high" | "basic";
  rules: Record<IncomeCategory, SourceRule>;
  /** Who keeps the personal allowance / tax-free threshold while non-resident. */
  personalAllowance: {
    kind: "all" | "citizens" | "none";
    citizens?: readonly string[];
    note: string;
  };
  /** Pension lump sums that are tax-free at home stay tax-free for non-residents. */
  pensionLumpSumTaxFree: boolean;
  /**
   * UK-style limit: tax on these categories is limited to tax deducted at source (none), if that
   * gives less tax than the full calculation (which keeps the personal allowance).
   */
  disregardedIncome?: { categories: readonly IncomeCategory[]; note: string };
  /** Non-resident tax on property gains only on the gain since a rebasing date. */
  propertyGains?: {
    rebasing: { residential: string; commercial: string };
    timeApportionment: boolean;
    note: string;
  };
  wrappers: readonly WrapperRule[];
  departure?: DepartureRule;
  /** Cost basis of investments steps up to market value when someone becomes resident. */
  arrivalRebasing?: { note: string; sources: readonly Source[] };
  /** Gains realised during a short absence are taxed on return (UK: 5 years). */
  temporaryNonResidence?: {
    maxYears: number;
    priorResidentYears: number;
    ofYears: number;
    note: string;
    sources: readonly Source[];
  };
  /** Country taxes its citizens wherever they live (US). */
  citizenshipTaxation?: {
    foreignEarnedIncomeExclusion: { year: number; amount: number }[];
    note: string;
    sources: readonly Source[];
  };
  simplifications: readonly string[];
  sources: readonly Source[];
}

/** Treaty allocation of taxing rights for one category. */
export type TreatyAllocation =
  /** Only the residence country may tax; the source country exempts it. */
  | "residence"
  /** Only the source (paying / situs) country may tax; the residence country exempts it. */
  | "source"
  /** Both may tax; the residence country gives a credit for the source country's tax. */
  | "shared"
  /** Government pensions: only the paying country, unless the person is a national and resident of the other. */
  | "source-unless-national-resident";

export interface TreatyRule {
  allocation: TreatyAllocation;
  /** Cap on the source country's rate (dividends, interest, pensions) where the treaty sets one. */
  maxSourceRate?: number;
  note?: string;
}

export interface Treaty {
  /** Alphabetical pair of ISO alpha-2 codes. */
  pair: readonly [string, string];
  name: string;
  depth: "high" | "basic";
  rules: Partial<Record<IncomeCategory, TreatyRule>>;
  /** Relief method of each side (credit for every pair Glideworth knows). */
  method: "credit";
  notes: readonly string[];
  sources: readonly Source[];
}

/** How a residence country treats a FOREIGN tax-advantaged wrapper. */
export interface WrapperRecognition {
  residence: string;
  accountCountry: string;
  accountTypes?: readonly AccountType[];
  /** Income/gains inside are treated as sheltered (the wrapper's own treatment applies). */
  recognised: boolean;
  /** A pension's tax-free lump sum stays tax-free in the residence country. */
  lumpSumTaxFree?: boolean;
  note: string;
  sources?: readonly Source[];
}
