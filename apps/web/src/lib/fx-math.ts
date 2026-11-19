/**
 * Today's value of a foreign-currency amount in the household's base currency, with the rates as
 * entered (`CurrentFinances.fxRates`, as of `asOf`): a direct pair, or the inverse of one. The engine
 * does the same at the plan start; this is for the "now" figures on Current finances and the
 * dashboard. A missing pair converts to nothing here — never 1:1 — and is flagged beside the total.
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

/** `amount` (in `currency`) in base currency, or null when no pair converts it. */
export function toBase(
  amount: number,
  currency: string | undefined,
  base: string,
  rates: readonly FxRate[] = [],
): number | null {
  const rate = fxRateToBase(currency, base, rates);
  return rate === null ? null : amount * rate;
}

export interface UnconvertedHolding {
  currency: string;
  /** Net amount left out of the base-currency total, in `currency` (debts and loans are negative). */
  amount: number;
}

/** Foreign holdings with no rate to `base`. These are omitted from net worth rather than added at face value. */
export function unconvertedHoldings(
  fin: {
    accounts: readonly {
      balance: number;
      currency?: string | undefined;
      archived?: boolean | undefined;
    }[];
    realAssets: readonly {
      currentValue: number;
      currency?: string | undefined;
      archived?: boolean | undefined;
      loan?: { balance: number } | undefined;
    }[];
    debts: readonly {
      balance: number;
      currency?: string | undefined;
      archived?: boolean | undefined;
    }[];
    fxRates?: readonly FxRate[] | undefined;
  },
  base: string,
): UnconvertedHolding[] {
  const rates = fin.fxRates ?? [];
  const by = new Map<string, number>();
  const add = (currency: string | undefined, amount: number) => {
    if (!currency || currency === base || fxRateToBase(currency, base, rates) !== null) return;
    by.set(currency, (by.get(currency) ?? 0) + amount);
  };
  for (const a of fin.accounts) if (!a.archived) add(a.currency, a.balance);
  for (const r of fin.realAssets) {
    if (r.archived) continue;
    add(r.currency, r.currentValue);
    if (r.loan) add(r.currency, -r.loan.balance);
  }
  for (const d of fin.debts) if (!d.archived) add(d.currency, -d.balance);
  return [...by]
    .filter(([, amount]) => Math.abs(amount) > 1e-9)
    .map(([currency, amount]) => ({ currency, amount }))
    .sort((a, b) => a.currency.localeCompare(b.currency));
}

/** The sentence shown under a net-worth total that left `holdings` out. */
export function unconvertedSentence(
  holdings: readonly UnconvertedHolding[],
  base: string,
  format: (amount: number, currency: string) => string,
): string | null {
  if (!holdings.length) return null;
  const parts = holdings.map((h) => {
    const text = format(Math.abs(h.amount), h.currency);
    return h.amount < 0 ? `−${text}` : text;
  });
  const codes = holdings.map((h) => h.currency).join(" and ");
  const be = holdings.length === 1 ? "is" : "are";
  const verb = holdings.length === 1 ? "has" : "have";
  return `${parts.join(" and ")} ${be} not included: ${codes} ${verb} no exchange rate to ${base}.`;
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
  // A missing pair contributes 0 to the total. Callers flag those holdings separately.
  const k = (c: string | undefined) => fxRateToBase(c, base, rates) ?? 0;
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
