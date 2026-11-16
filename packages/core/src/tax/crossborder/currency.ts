/**
 * Currency each national tax jurisdiction computes in, and fixed currency pegs. Cross-border tax
 * converts the period's items into the jurisdiction's currency through the plan's FX table, runs
 * the plug-in, and converts the tax back to the household's base currency.
 */
import { AE_PEG_SOURCE, AED_PER_USD } from "../data/ae.js";
import type { Source } from "./types.js";

export const COUNTRY_TAX_CURRENCY: Readonly<Record<string, string>> = {
  GB: "GBP",
  US: "USD",
  CA: "CAD",
  AU: "AUD",
  DE: "EUR",
  NL: "EUR",
  FR: "EUR",
  ES: "EUR",
  IE: "EUR",
  IL: "ILS",
  NZ: "NZD",
  AE: "AED",
};

export interface CurrencyPeg {
  from: string;
  to: string;
  /** Units of `to` per unit of `from`. */
  rate: number;
  annualDrift: number;
  source: Source;
}

/**
 * Pegged currencies, as FX-table rows (`{from, to, rate, annualDrift}`) ready to add to
 * `CurrentFinances.fxRates`: drift zero against the anchor currency. The engine needs no special
 * case; a household in another base currency still needs its own pair (e.g. AED -> GBP).
 */
export const CURRENCY_PEGS: readonly CurrencyPeg[] = [
  {
    from: "AED",
    to: "USD",
    rate: 1 / AED_PER_USD,
    annualDrift: 0,
    source: { url: AE_PEG_SOURCE.url, year: "2026", note: AE_PEG_SOURCE.note ?? "" },
  },
];

/** Peg rows usable for a household in `base` currency (direct pairs only). */
export function pegFxRates(
  base: string,
): { from: string; to: string; rate: number; annualDrift: number }[] {
  return CURRENCY_PEGS.filter((p) => p.to === base || p.from === base).map((p) => ({
    from: p.from,
    to: p.to,
    rate: p.rate,
    annualDrift: p.annualDrift,
  }));
}
