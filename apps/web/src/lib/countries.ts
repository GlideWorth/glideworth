/**
 * Countries Glideworth supports, their regions, and what a household in each gets by default. The
 * defaults themselves come from core (`defaultsForCountry`, `planDefaultsForHousehold`), so the
 * web, the API, samples and importers can never disagree about a country's tax stack, tax year,
 * market history or currency. This module only adds labels and region lists for pickers.
 */
import {
  ACCOUNT_TYPE_INFO,
  ACCOUNT_TYPES,
  type AccountType,
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

/** Plan fields to spread into a new plan for this household (tax, tax-year alignment, inflation, dataset). */
export function planSettingsFor(h: Pick<Household, "location" | "people">) {
  return planDefaultsForHousehold(h);
}

// ------------------------------------------------------------------------------- account types

/** Countries that own account types, in label order (types without a country are generic). */
const TYPE_COUNTRY_LABEL: Record<string, string> = Object.fromEntries(
  COUNTRY_LIST.map((c) => [c.code, c.label]),
);

/**
 * Account types grouped for a picker: the household's country first, then every other country,
 * then the generic types that work anywhere.
 */
export function groupedAccountTypes(
  householdCountry: string,
): { group: string; country: string | null; types: AccountType[] }[] {
  const groups = new Map<string, AccountType[]>();
  for (const t of ACCOUNT_TYPES) {
    const c = ACCOUNT_TYPE_INFO[t].country ?? "";
    groups.set(c, [...(groups.get(c) ?? []), t]);
  }
  const generic = groups.get("") ?? [];
  groups.delete("");
  const order = [...groups.keys()].sort((a, b) => {
    if (a === householdCountry) return -1;
    if (b === householdCountry) return 1;
    return (TYPE_COUNTRY_LABEL[a] ?? a).localeCompare(TYPE_COUNTRY_LABEL[b] ?? b);
  });
  return [
    ...order.map((c) => ({ group: TYPE_COUNTRY_LABEL[c] ?? c, country: c, types: groups.get(c)! })),
    { group: "Any country", country: null, types: generic },
  ];
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

/** Label for a location ("Dubai, United Arab Emirates" / "United Kingdom"). */
export function locationLabel(loc: { country: string; region?: string | undefined }): string {
  const info = countryInfo(loc.country);
  const region = loc.region
    ? (info?.regions?.find((r) => r.value === loc.region)?.label ?? loc.region)
    : null;
  return region ? `${region}, ${info?.label ?? loc.country}` : (info?.label ?? loc.country);
}
