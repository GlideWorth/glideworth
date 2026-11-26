/**
 * Multi-currency: a currency picker for accounts, assets, debts and events, and the exchange-rate
 * editor used for the household's rates (Current finances) and per-plan overrides (Assumptions).
 * Rates are `1 FROM = rate TO` with an assumed annual drift; the engine converts every foreign
 * amount to the household's base currency through a direct or inverse pair.
 */
import {
  type FxRate,
  fxPairKey,
  fxRateIssues,
  type GlideworthDocument,
  type Plan,
} from "@glideworth/core";
import { ArrowRightLeft, Plus, TriangleAlert, X } from "lucide-react";
import { Button } from "../../components/ui/button";
import { NumberInput, PercentInput } from "../../components/ui/number-input";
import { Select } from "../../components/ui/select";
import { CURRENCY_CODES } from "../../lib/countries";
import { useFormat } from "../../lib/workspace";

/** "USD · US$" options with the household currency first. */
export function currencyOptions(base: string, locale: string, extra: (string | undefined)[] = []) {
  const codes = [...new Set([base, ...extra.filter((x): x is string => !!x), ...CURRENCY_CODES])];
  return codes.map((c) => ({
    value: c,
    label: c === base ? `${c} (household)` : c,
    hint: displayName(c, locale),
  }));
}

function displayName(code: string, locale: string): string | undefined {
  try {
    return new Intl.DisplayNames([locale], { type: "currency" }).of(code);
  } catch {
    return undefined;
  }
}

/** Currency of an account / asset / debt / event; `undefined` = the household's base currency. */
export function CurrencySelect({
  value,
  base,
  onChange,
  id,
}: {
  value: string | undefined;
  base: string;
  onChange: (c: string | undefined) => void;
  id?: string;
}) {
  const f = useFormat();
  return (
    <Select
      id={id}
      value={value ?? base}
      onValueChange={(c) => onChange(c === base ? undefined : c)}
      options={currencyOptions(base, f.locale, [value])}
    />
  );
}

/** Every currency other than `base` used by the household's finances and the plans' events. */
export function foreignCurrencies(
  doc: Pick<GlideworthDocument, "household" | "finances">,
  plans: Plan[] = [],
): string[] {
  const base = doc.household.currency;
  const all = [
    ...doc.finances.accounts.map((a) => a.currency),
    ...doc.finances.realAssets.map((a) => a.currency),
    ...doc.finances.debts.map((d) => d.currency),
    ...plans.flatMap((p) => [
      ...p.income.map((e) => e.currency),
      ...p.expenses.map((e) => e.currency),
      ...p.plannedAccounts.map((a) => a.currency),
      ...p.plannedRealAssets.map((a) => a.currency),
    ]),
  ];
  return [...new Set(all.filter((c): c is string => !!c && c !== base))].sort();
}

/** Whether `rates` can convert `currency` to `base` (direct or inverse pair). */
export function hasPair(rates: readonly FxRate[], currency: string, base: string): boolean {
  return rates.some(
    (r) => (r.from === currency && r.to === base) || (r.from === base && r.to === currency),
  );
}

/** Currencies in use that none of `tables` can convert to `base`. An empty table does not cover any. */
export function missingFxCurrencies(
  inUse: readonly string[],
  base: string,
  tables: readonly (readonly FxRate[] | undefined)[],
): string[] {
  return inUse.filter((c) => !tables.some((rates) => !!rates && hasPair(rates, c, base)));
}

export function FxRatesEditor({
  rates,
  base,
  inUse,
  onChange,
  inheritFrom,
  coveredBy,
  disabled,
}: {
  rates: FxRate[];
  base: string;
  /** Foreign currencies the household uses (missing pairs are flagged). */
  inUse: string[];
  onChange: (rates: FxRate[]) => void;
  /** Plan overrides: the household's rates, shown for reference. */
  inheritFrom?: FxRate[];
  /**
   * Another table that already converts these currencies (the plan's rates, on the household
   * editor). A currency covered here is not "missing": the projection can already simulate it.
   */
  coveredBy?: readonly FxRate[];
  disabled?: boolean;
}) {
  const f = useFormat();
  const missing = missingFxCurrencies(inUse, base, [rates, inheritFrom, coveredBy]);
  const set = (i: number, patch: Partial<FxRate>) =>
    onChange(rates.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  // The same check the server applies to every write of the table (core `fxRateIssues`).
  const issues = new Map(fxRateIssues(rates).map((x) => [x.index, x.message]));
  const add = (from?: string) => {
    const taken = new Set(rates.map((r) => fxPairKey(r.from, r.to)));
    const c =
      from ??
      inUse.find((x) => !hasPair(rates, x, base)) ??
      CURRENCY_CODES.find((x) => x !== base && !taken.has(fxPairKey(x, base))) ??
      "USD";
    const inherited = inheritFrom?.find((r) => r.from === c && r.to === base);
    onChange([
      ...rates,
      { from: c, to: base, rate: inherited?.rate ?? 1, annualDrift: inherited?.annualDrift ?? 0 },
    ]);
  };
  const opts = currencyOptions(
    base,
    f.locale,
    rates.flatMap((r) => [r.from, r.to]),
  );
  return (
    <div className="flex flex-col gap-3">
      {missing.length ? (
        <div className="flex items-start gap-2 rounded-md bg-ochre-soft px-3 py-2 text-[12.5px] text-ochre">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
          <span>
            {missing.join(", ")} {missing.length === 1 ? "is" : "are"} used but has no exchange rate
            to {base}: plans that use {missing.length === 1 ? "it" : "them"} cannot be simulated.{" "}
            {disabled ? null : (
              <button
                type="button"
                className="font-semibold underline"
                onClick={() => add(missing[0])}
              >
                Add {missing[0]} → {base}
              </button>
            )}
          </span>
        </div>
      ) : null}
      {rates.length === 0 ? (
        <p className="text-[12.5px] text-ink-3">
          {inheritFrom
            ? "This plan uses the household’s exchange rates. Add a pair here to override it for this plan only (for example “sterling falls 2% a year”)."
            : "No exchange rates yet. Add one for each currency you hold besides your household currency."}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {rates.map((r, i) => (
            <li
              // oxlint-disable-next-line react/no-array-index-key -- pairs have no ids; order is stable while editing
              key={i}
              className="grid items-end gap-2 rounded-lg border border-border p-2.5 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto]"
            >
              <div className="flex flex-col gap-1 text-[12px] font-medium text-ink-2">
                1 unit of
                <Select
                  aria-label="From currency"
                  value={r.from}
                  onValueChange={(from) => set(i, { from })}
                  options={opts}
                />
              </div>
              <ArrowRightLeft className="mb-2 hidden size-3.5 text-ink-3 sm:block" aria-hidden />
              <div className="flex flex-col gap-1 text-[12px] font-medium text-ink-2">
                equals, in
                <Select
                  aria-label="To currency"
                  value={r.to}
                  onValueChange={(to) => set(i, { to })}
                  options={opts}
                />
              </div>
              <div className="flex flex-col gap-1 text-[12px] font-medium text-ink-2">
                Rate
                <NumberInput
                  aria-label={`${r.from} to ${r.to} rate`}
                  decimals={4}
                  value={r.rate}
                  onValueChange={(v) => v !== null && v > 0 && set(i, { rate: v })}
                />
              </div>
              <div className="flex flex-col gap-1 text-[12px] font-medium text-ink-2">
                Drift a year
                <PercentInput
                  aria-label={`${r.from} annual drift`}
                  value={r.annualDrift}
                  onValueChange={(v) => set(i, { annualDrift: v ?? 0 })}
                />
              </div>
              <Button
                size="icon"
                variant="ghost"
                aria-label={`Remove ${r.from} to ${r.to}`}
                onClick={() => onChange(rates.filter((_, j) => j !== i))}
              >
                <X />
              </Button>
              <p className="text-[11.5px] text-ink-3 sm:col-span-6">
                1 {r.from} = {f.number(r.rate, 4)} {r.to}
                {r.annualDrift
                  ? `; ${r.from} ${r.annualDrift > 0 ? "gains" : "loses"} ${f.percent(Math.abs(r.annualDrift))} a year against ${r.to}`
                  : "; held constant"}
              </p>
              {issues.has(i) ? (
                <p role="alert" className="text-[11.5px] font-medium text-negative sm:col-span-6">
                  {issues.get(i)} (not saved until fixed).
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {disabled ? null : (
        <Button size="sm" variant="secondary" className="self-start" onClick={() => add()}>
          <Plus /> Add exchange rate
        </Button>
      )}
    </div>
  );
}
