/**
 * Country scope: which account and income types belong to a household in a given country. The one
 * place that decides it, so the web pickers, the API and MCP agree that a US household is offered a
 * 401(k) and a Roth IRA but not an ISA, and a UK household the reverse.
 *
 * A type belongs to a country when it is that country's own wrapper or benefit, or when it is
 * generic (works anywhere). Foreign types stay valid everywhere: an account abroad
 * (`Account.jurisdiction`) or a foreign pension keeps its type. This module only scopes what is
 * offered by default. Pure: no clock, no I/O.
 */
import { ACCOUNT_TYPE_INFO } from "../schema/account-types.js";
import { ACCOUNT_TYPES, type AccountType } from "../schema/accounts.js";
import type { IncomeType } from "../schema/events.js";

/** The country an account type belongs to ('US' for a 401(k)), or null for a generic type. */
export function accountTypeCountry(type: AccountType): string | null {
  return ACCOUNT_TYPE_INFO[type].country ?? null;
}

/** Whether an account type belongs to a household in `country` (its own types and generic ones). */
export function isAccountTypeForCountry(type: AccountType, country: string): boolean {
  const c = accountTypeCountry(type);
  return c === null || c === country.toUpperCase();
}

/**
 * The account types for a household in `country`: that country's own types plus the generic ones,
 * in `ACCOUNT_TYPES` order. 'XX' or a country with no types of its own gets the generic types only.
 */
export function accountTypesForCountry(country: string): AccountType[] {
  return ACCOUNT_TYPES.filter((t) => isAccountTypeForCountry(t, country));
}

/**
 * Countries each income type belongs to; null = generic (any country). Every income type is listed,
 * so a new one fails to compile until it is placed. `state-pension` covers the countries whose
 * government pension Glideworth models as a State Pension (`defaultsForCountry(c).statePension`),
 * plus AU, AE and 'XX', whose defaults have no state pension but where the type is still offered
 * (the pickers offered it there before this module existed).
 */
const INCOME_TYPE_COUNTRIES: Record<IncomeType, readonly string[] | null> = {
  salary: null,
  hourly: null,
  "self-employment": null,
  bonus: null,
  rsu: null,
  inheritance: null,
  windfall: null,
  "social-security": ["US"],
  pension: null,
  annuity: null,
  "state-pension": ["GB", "IE", "AU", "NZ", "DE", "NL", "FR", "ES", "IL", "AE", "XX"],
  "ca-cpp": ["CA"],
  "ca-oas": ["CA"],
  "ca-gis": ["CA"],
  other: null,
};

/** Every income type, in schema order. */
const INCOME_TYPE_LIST = Object.keys(INCOME_TYPE_COUNTRIES) as IncomeType[];

/** The countries an income type belongs to, or null when it is generic. */
export function incomeTypeCountries(type: IncomeType): readonly string[] | null {
  return INCOME_TYPE_COUNTRIES[type];
}

/** Whether an income type belongs to a household in `country` (its own benefits and generic types). */
export function isIncomeTypeForCountry(type: IncomeType, country: string): boolean {
  const cs = INCOME_TYPE_COUNTRIES[type];
  return cs === null || cs.includes(country.toUpperCase());
}

/** The income types for a household in `country`: its own benefits plus the generic types. */
export function incomeTypesForCountry(country: string): IncomeType[] {
  return INCOME_TYPE_LIST.filter((t) => isIncomeTypeForCountry(t, country));
}
