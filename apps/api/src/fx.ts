/**
 * FX helpers. Foreign-currency accounts, assets and debts are converted to the household's base currency with
 * `CurrentFinances.fxRates` (rate as of `asOf`; the engine applies any drift). A pair may be given in either
 * direction.
 */
import type { CurrentFinances, FxRate } from "@glideworth/core";

/** Base-currency units per 1 unit of `currency`, or null when no direct or inverse pair exists. */
export function fxRateTo(
  rates: readonly FxRate[] | undefined,
  currency: string | undefined,
  base: string,
): number | null {
  if (!currency || currency === base) return 1;
  const direct = rates?.find((r) => r.from === currency && r.to === base);
  if (direct) return direct.rate;
  const inverse = rates?.find((r) => r.from === base && r.to === currency);
  return inverse ? 1 / inverse.rate : null;
}

/**
 * A converter into the base currency. A missing pair converts at 1 (the engine refuses such a plan with a
 * clear error; totals for display should not fail because of it): `missing` lists the currencies affected.
 */
export function baseConverter(finances: Pick<CurrentFinances, "fxRates">, base: string) {
  const missing = new Set<string>();
  const convert = (amount: number, currency: string | undefined): number => {
    const r = fxRateTo(finances.fxRates, currency, base);
    if (r === null) {
      if (currency) missing.add(currency);
      return amount;
    }
    return amount * r;
  };
  return { convert, missing };
}
