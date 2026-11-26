/**
 * Cross-border form pieces shared by the plan and finance editors: an item's country (defaulting
 * to the household's or the account type's), and the currency / exchange-rate prompt when a
 * country implies another currency.
 */
import type { FxRate } from "@glideworth/core";
import { ArrowRightLeft, Globe2 } from "lucide-react";
import { useState } from "react";
import { Button } from "../../components/ui/button";
import { NumberInput } from "../../components/ui/number-input";
import { Select } from "../../components/ui/select";
import { COUNTRY_LIST, countryLabel, currencyOfCountry } from "../../lib/countries";
import { hasPair } from "../currency/fx";
import { updateFinances, useDraftDoc, useNowFxRates } from "../finances/use-finances";
import { FormField } from "../plan-editor/components/form";

const COUNTRY_SELECT = COUNTRY_LIST.filter((c) => c.code !== "XX").map((c) => ({
  value: c.code,
  label: c.label,
}));

const SAME = "__same";

/**
 * Country of an account, property, debt or income. `inherited` is what applies when unset (the
 * household's country, or the account type's). It says where the item is, which decides whether
 * that country taxes it as a non-resident's.
 */
export function ItemCountryField({
  value,
  inherited,
  inheritedWhy,
  onChange,
  label = "Country",
  help,
}: {
  value: string | undefined;
  inherited: string;
  inheritedWhy: string;
  onChange: (c: string | undefined) => void;
  label?: string;
  help?: string;
}) {
  return (
    <FormField
      label={label}
      help={
        help ??
        "Where it is. If that is not where you live, that country may tax its income or gains too, with credit for that tax where you live."
      }
    >
      {(id) => (
        <Select
          id={id}
          value={value ?? SAME}
          onValueChange={(v) => onChange(v === SAME || v === inherited ? undefined : v)}
          options={[
            { value: SAME, label: `${countryLabel(inherited)} (${inheritedWhy})` },
            ...COUNTRY_SELECT.filter((c) => c.value !== inherited),
          ]}
        />
      )}
    </FormField>
  );
}

/**
 * When an item's country normally uses another currency than the item is entered in, offer to
 * switch; when the item's currency has no rate to the household's, ask for one inline.
 */
export function CurrencyPrompt({
  country,
  currency,
  onUseCurrency,
  what = "This",
}: {
  country: string;
  /** The item's currency (undefined = household currency). */
  currency: string | undefined;
  onUseCurrency: (c: string) => void;
  what?: string;
}) {
  const doc = useDraftDoc();
  const rates = useNowFxRates();
  if (!doc) return null;
  const base = doc.household.currency;
  const local = currencyOfCountry(country);
  const cur = currency ?? base;
  const suggest =
    local && local !== cur && country !== doc.household.location.country ? local : null;
  const needsRate = cur !== base && !hasPair(rates, cur, base);
  if (!suggest && !needsRate) return null;
  return (
    <div className="flex flex-col gap-2 rounded-md border border-border bg-surface-2 px-3 py-2 text-[12.5px]">
      {suggest ? (
        <div className="flex flex-wrap items-center gap-2">
          <Globe2 className="size-3.5 shrink-0 text-ink-3" />
          <span className="min-w-0 flex-1 text-ink-2">
            {what} is in {countryLabel(country)}, where amounts are usually in {suggest}. Values
            stay in {cur} unless you switch.
          </span>
          <Button size="sm" variant="secondary" onClick={() => onUseCurrency(suggest)}>
            Use {suggest}
          </Button>
        </div>
      ) : null}
      {needsRate ? <FxRateInline currency={cur} base={base} /> : null}
    </div>
  );
}

/** "1 AED = [ ] GBP" saved straight into the household's exchange-rate table. */
export function FxRateInline({ currency, base }: { currency: string; base: string }) {
  const [rate, setRate] = useState<number | null>(null);
  const save = () => {
    if (!rate || rate <= 0) return;
    updateFinances(
      (fin) => ({
        ...fin,
        fxRates: [
          ...(fin.fxRates ?? []).filter(
            (r: FxRate) =>
              !(r.from === currency && r.to === base) && !(r.from === base && r.to === currency),
          ),
          { from: currency, to: base, rate, annualDrift: 0 },
        ],
      }),
      `Add ${currency} exchange rate`,
    );
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      <ArrowRightLeft className="size-3.5 shrink-0 text-ochre" />
      <span className="text-ink-2">
        No {currency} → {base} exchange rate yet; plans using it cannot be simulated.
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="num text-ink-3">1 {currency} =</span>
        <NumberInput
          aria-label={`${base} per ${currency}`}
          className="w-[110px]"
          decimals={4}
          value={rate}
          onValueChange={setRate}
          suffix={base}
        />
        <Button size="sm" variant="secondary" onClick={save} disabled={!rate || rate <= 0}>
          Save rate
        </Button>
      </span>
      <span className="text-[11.5px] text-ink-3">
        Use today's rate; change it any time under Finances → Exchange rates.
      </span>
    </div>
  );
}
