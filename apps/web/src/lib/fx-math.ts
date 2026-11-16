/**
 * Today's value of a foreign-currency amount in the household's base currency, with the rates as
 * entered (`CurrentFinances.fxRates`, as of `asOf`): a direct pair, or the inverse of one. The engine
 * does the same at the plan start; this is for the "now" figures on Current finances and the
 * dashboard. Returns null when no pair converts the currency.
 */
import type { FxRate } from "@glideworth/core";

export function fxRateToBase(
  currency: string | undefined,
  base: string,
  rates: readonly FxRate[] = [],
): number | null {
  if (!currency || currency === base) return 1;
  const direct = rates.find((r) => r.from === currency && r.to === base);
  if (direct && direct.rate > 0) return direct.rate;
  const inverse = rates.find((r) => r.from === base && r.to === currency);
  if (inverse && inverse.rate > 0) return 1 / inverse.rate;
  return null;
}

/** `amount` (in `currency`) in base currency; a missing pair counts at 1 (and is flagged elsewhere). */
export function toBase(
  amount: number,
  currency: string | undefined,
  base: string,
  rates: readonly FxRate[] = [],
): number {
  return amount * (fxRateToBase(currency, base, rates) ?? 1);
}

/** Current finances with every foreign-currency figure converted to `base` (for totals only). */
export function financesInBase<
  F extends {
    accounts: readonly {
      balance: number;
      costBasis?: number | undefined;
      currency?: string | undefined;
    }[];
    realAssets: readonly {
      currentValue: number;
      currency?: string | undefined;
      loan?: { balance: number } | undefined;
    }[];
    debts: readonly { balance: number; currency?: string | undefined }[];
    fxRates?: readonly import("@glideworth/core").FxRate[] | undefined;
  },
>(fin: F, base: string): F {
  const rates = fin.fxRates ?? [];
  const k = (c: string | undefined) => fxRateToBase(c, base, rates) ?? 1;
  if (
    ![...fin.accounts, ...fin.realAssets, ...fin.debts].some(
      (x) => x.currency && x.currency !== base,
    )
  )
    return fin;
  return {
    ...fin,
    accounts: fin.accounts.map((a) => ({
      ...a,
      balance: a.balance * k(a.currency),
      ...(a.costBasis !== undefined ? { costBasis: a.costBasis * k(a.currency) } : {}),
    })),
    realAssets: fin.realAssets.map((r) => ({
      ...r,
      currentValue: r.currentValue * k(r.currency),
      ...(r.loan ? { loan: { ...r.loan, balance: r.loan.balance * k(r.currency) } } : {}),
    })),
    debts: fin.debts.map((d) => ({ ...d, balance: d.balance * k(d.currency) })),
  };
}
