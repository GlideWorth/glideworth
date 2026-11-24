/**
 * What changing household country would do, before anything is written.
 * Currency and number format follow the country only when the household still uses that country's
 * defaults, and only after the user confirms. A country whose tax depends on a region with no
 * default (a US state) must be chosen; it is not left blank.
 */
import type { Household } from "@glideworth/core";
import { countryDefaultsFor, countryInfo, countryLabel } from "../../lib/countries";
import { countryDefaults } from "../plan-editor/state/defaults";

export interface CountryChange {
  country: string;
  countryName: string;
  /** Set when currency still matches the old country and the new country's currency differs. */
  currencyFrom: string | null;
  currencyTo: string | null;
  localeFrom: string | null;
  localeTo: string | null;
  regionLabel: string | null;
  /** Empty when there is nothing to pick (no regions, or a default we can apply). */
  regions: { value: string; label: string }[];
  /** The country's default region, applied when the user is not asked to pick. */
  region: string | undefined;
  regionAffectsTax: boolean;
  needsConfirm: boolean;
}

export function describeCountryChange(household: Household, country: string): CountryChange {
  const before = countryDefaults(household.location.country);
  const after = countryDefaults(country);
  const info = countryInfo(country);
  const currencyFollows =
    household.currency === before.currency && after.currency !== household.currency;
  const localeFollows = household.locale === before.locale && after.locale !== household.locale;
  const regions = info?.regions ?? [];
  const defaultRegion = countryDefaultsFor(country).defaultRegion ?? undefined;
  const mustPick = regions.length > 0 && !defaultRegion;
  return {
    country,
    countryName: info?.label ?? countryLabel(country),
    currencyFrom: currencyFollows ? household.currency : null,
    currencyTo: currencyFollows ? after.currency : null,
    localeFrom: localeFollows ? household.locale : null,
    localeTo: localeFollows ? after.locale : null,
    regionLabel: mustPick ? (info?.regionLabel ?? "Region") : null,
    regions: mustPick ? regions : [],
    region: defaultRegion,
    regionAffectsTax: info?.regionAffectsTax === true,
    needsConfirm: currencyFollows || localeFollows || mustPick,
  };
}
