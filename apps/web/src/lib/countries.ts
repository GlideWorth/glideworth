/**
 * Countries Glideworth supports, their regions, and what a household in each gets by default. The
 * defaults themselves come from core (`defaultsForCountry`, `planDefaultsForHousehold`), so the
 * web, the API, samples and importers can never disagree about a country's tax stack, tax year,
 * market history or currency. This module only adds labels and region lists for pickers.
 */
import {
  ACCOUNT_TYPES,
  type AccountType,
  accountTypeCountry,
  accountTypesForCountry,
  CA_PROVINCES_2026,
  COUNTRY_TAX_CURRENCY,
  type CountryDefaults,
  defaultsForCountry,
  ES_REGIONAL_SCALES,
  type Household,
  hasTaxPreset,
  planDefaultsForHousehold,
  TAX_SIMPLIFICATIONS,
  US_STATES_2026,
} from "@glideworth/core";

export interface CountryInfo {
  code: string;
  label: string;
  /** Picker label for the region field ("Nation", "State", ...), when regions matter. */
  regionLabel?: string;
  regions?: { value: string; label: string }[];
  /** Whether the region changes the tax estimate (US state tax, CA province, ES community, GB Scotland). */
  regionAffectsTax?: boolean;
}

const byName = (a: { label: string }, b: { label: string }) => a.label.localeCompare(b.label);

/** Every supported country, in picker order ('XX' = somewhere else: flat or custom tax). */
export const COUNTRY_LIST: CountryInfo[] = [
  {
    code: "GB",
    label: "United Kingdom",
    regionLabel: "Nation",
    regionAffectsTax: true,
    regions: [
      { value: "ENG", label: "England" },
      { value: "SCT", label: "Scotland (Scottish income tax)" },
      { value: "WLS", label: "Wales" },
      { value: "NIR", label: "Northern Ireland" },
    ],
  },
  {
    code: "US",
    label: "United States",
    regionLabel: "State",
    regionAffectsTax: true,
    regions: US_STATES_2026.map((s) => ({ value: s.code, label: s.name })).sort(byName),
  },
  {
    code: "CA",
    label: "Canada",
    regionLabel: "Province",
    regionAffectsTax: true,
    regions: CA_PROVINCES_2026.map((p) => ({ value: p.code, label: p.name })).sort(byName),
  },
  {
    code: "AU",
    label: "Australia",
    regionLabel: "State",
    regions: ["ACT", "NSW", "NT", "QLD", "SA", "TAS", "VIC", "WA"].map((v) => ({
      value: v,
      label: v,
    })),
  },
  { code: "DE", label: "Germany" },
  { code: "NL", label: "Netherlands" },
  { code: "FR", label: "France" },
  {
    code: "ES",
    label: "Spain",
    regionLabel: "Autonomous community",
    regionAffectsTax: true,
    regions: Object.values(ES_REGIONAL_SCALES)
      .filter((r) => r.code !== "DEFAULT")
      .map((r) => ({ value: r.code, label: r.name }))
      .sort(byName),
  },
  { code: "IL", label: "Israel" },
  { code: "IE", label: "Ireland" },
  { code: "NZ", label: "New Zealand" },
  {
    code: "AE",
    label: "United Arab Emirates",
    regionLabel: "Emirate",
    // ISO 3166-2:AE. The UAE taxes no personal income, so the emirate never changes the estimate.
    regions: [
      { value: "AZ", label: "Abu Dhabi" },
      { value: "AJ", label: "Ajman" },
      { value: "DU", label: "Dubai" },
      { value: "FU", label: "Fujairah" },
      { value: "RK", label: "Ras Al Khaimah" },
      { value: "SH", label: "Sharjah" },
      { value: "UQ", label: "Umm Al Quwain" },
    ],
  },
  { code: "XX", label: "Somewhere else (flat or custom tax)" },
];

export const countryInfo = (code: string): CountryInfo | undefined =>
  COUNTRY_LIST.find((c) => c.code === code);
export const countryLabel = (code: string): string => countryInfo(code)?.label ?? code;

/** Options for a country <Select>. */
export const COUNTRY_OPTIONS = COUNTRY_LIST.map((c) => ({
  value: c.code,
  label: c.label,
  hint:
    c.code === "XX"
      ? undefined
      : hasTaxPreset(c.code)
        ? "Tax estimate available"
        : "Flat or custom tax",
}));

/** Core's defaults for a country (tax mode and stack, tax year, dataset, currency, account types). */
export function countryDefaultsFor(code: string, region?: string): CountryDefaults {
  return defaultsForCountry(code, region ? { region } : {});
}

/**
 * Whether a new household in this country must pick a region: the tax estimate depends on it and
 * there is no default, so without one the plan would quietly use flat rates (a US state).
 */
export function regionRequired(code: string): boolean {
  const info = countryInfo(code);
  const core = countryDefaultsFor(code);
  return (
    !!info?.regions?.length &&
    info.regionAffectsTax === true &&
    !core.defaultRegion &&
    core.tax.mode !== "estimate"
  );
}

/**
 * Account types for the empty accounts list's quick-add buttons: cash, then the country's own
 * typical type for each role (core's `accountTypes`), without gaps or repeats.
 */
export function quickAccountTypes(code: string): AccountType[] {
  const t = countryDefaultsFor(code).accountTypes;
  const types = ["cash", t.cash, t.taxFree, t.personalPension, t.workplacePension, t.taxable];
  return [...new Set(types.filter((x): x is AccountType => x !== null))];
}

/** Plan fields to spread into a new plan for this household (tax, tax-year alignment, inflation, dataset). */
export function planSettingsFor(h: Pick<Household, "location" | "people">) {
  return planDefaultsForHousehold(h);
}

// ------------------------------------------------------------------------------- account types

/** Labels for the countries that own account types (types without a country are generic). */
const TYPE_COUNTRY_LABEL: Record<string, string> = Object.fromEntries(
  COUNTRY_LIST.map((c) => [c.code, c.label]),
);

export interface AccountTypeGroup {
  group: string;
  /** The country whose own types these are; null for the generic types that work anywhere. */
  country: string | null;
  types: AccountType[];
}

const groupLabel = (country: string | null) =>
  country === null ? "Any country" : (TYPE_COUNTRY_LABEL[country] ?? country);

/** One country's own account types (null: the generic ones), in `ACCOUNT_TYPES` order. */
export function accountTypeGroupOf(country: string | null): AccountTypeGroup {
  return {
    group: groupLabel(country),
    country,
    types: ACCOUNT_TYPES.filter((t) => accountTypeCountry(t) === country),
  };
}

/**
 * Account types grouped for pickers. `home` is what a household in `householdCountry` is offered
 * (core's `accountTypesForCountry`): its own country's types, then the generic types. `foreign` is
 * every other country's types, by country name: the explicit "other countries" path to an account
 * abroad, shown only in the add-account menus.
 */
export function groupedAccountTypes(householdCountry: string): {
  home: AccountTypeGroup[];
  foreign: AccountTypeGroup[];
} {
  const offered = accountTypesForCountry(householdCountry);
  const home = [
    { country: householdCountry, types: offered.filter((t) => accountTypeCountry(t) !== null) },
    { country: null, types: offered.filter((t) => accountTypeCountry(t) === null) },
  ]
    .filter((g) => g.types.length > 0)
    .map((g) => ({ group: groupLabel(g.country), ...g }));
  const others = new Set<string>();
  for (const t of ACCOUNT_TYPES) {
    const c = accountTypeCountry(t);
    if (c !== null && !offered.includes(t)) others.add(c);
  }
  const foreign = [...others]
    .map(accountTypeGroupOf)
    .sort((a, b) => a.group.localeCompare(b.group));
  return { home, foreign };
}

// ------------------------------------------------------------------------------ simplifications

/** "What this estimate leaves out" for a jurisdiction id ('es:MD' → Spain's list). */
export function simplificationsFor(jurisdictionId: string): readonly string[] {
  const base = jurisdictionId.split(":")[0]!;
  return TAX_SIMPLIFICATIONS[base] ?? TAX_SIMPLIFICATIONS[jurisdictionId] ?? [];
}

/** Display currencies offered in pickers (any ISO code is accepted by the schema). */
export const CURRENCY_CODES = [
  "GBP",
  "USD",
  "EUR",
  "CAD",
  "AUD",
  "NZD",
  "ILS",
  "CHF",
  "SEK",
  "NOK",
  "DKK",
  "JPY",
  "SGD",
  "HKD",
  "INR",
  "ZAR",
  "AED",
];

/**
 * The currency money in a country is normally held in (the tax currency for countries with a
 * cross-border table, else the country preset's currency; undefined for 'XX').
 */
export function currencyOfCountry(code: string): string | undefined {
  if (code === "XX") return undefined;
  return COUNTRY_TAX_CURRENCY[code] ?? defaultsForCountry(code).currency;
}
