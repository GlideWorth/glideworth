/**
 * Locale-aware numeric inputs. Values are plain numbers (major units / decimal fractions);
 * display uses Intl for the active locale and currency. Editing shows the raw number, blur
 * re-formats. No hard-coded currency symbols.
 *
 * Money inputs (`CurrencyInput`, `AmountInput`) honour "Hide amounts": while amounts are hidden the
 * field shows the mask until it is focused, shows the real value while it is being edited, and
 * masks again on blur. Screen readers hear "amount hidden" instead of the dots.
 */
import type { Amount, ValueBasis } from "@glideworth/core";
import { type ComponentProps, useEffect, useId, useState } from "react";
import { cn } from "../../lib/cn";
import {
  AMOUNT_MASK,
  AMOUNT_MASK_SPOKEN,
  currencySymbol,
  formatNumber,
  parseLocaleNumber,
} from "../../lib/format";
import { useFormat } from "../../lib/workspace";
import { inputBase } from "./input";

type BaseProps = Omit<ComponentProps<"input">, "value" | "onChange" | "prefix"> & {
  value: number | null;
  onValueChange: (v: number | null) => void;
  decimals?: number;
  prefix?: string;
  suffix?: string;
  locale?: string;
  /** A money amount: masked while amounts are hidden, except while the field has focus. */
  sensitive?: boolean;
};

export function NumberInput({
  value,
  onValueChange,
  decimals = 2,
  prefix,
  suffix,
  locale,
  sensitive = false,
  className,
  ...rest
}: BaseProps) {
  const fmt = useFormat();
  const masked = sensitive && fmt.hidden;
  const loc = locale ?? fmt.locale;
  const display = (v: number | null) => (v === null ? "" : formatNumber(v, loc, decimals));
  const [text, setText] = useState(display(value));
  const [focused, setFocused] = useState(false);
  const maskNoteId = useId();
  const showMask = masked && !focused && value !== null;
  const describedBy =
    [rest["aria-describedby"], showMask ? maskNoteId : null].filter(Boolean).join(" ") || undefined;
  useEffect(() => {
    if (!focused) setText(display(value));
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- re-sync display only when value/focus/locale change
  }, [value, focused, loc]);
  return (
    <div
      className={cn(
        inputBase,
        "flex items-center gap-1.5 px-2 focus-within:border-focus focus-within:ring-2 focus-within:ring-focus/20",
        className,
      )}
    >
      {prefix ? <span className="text-ink-3 text-[12px] select-none">{prefix}</span> : null}
      <input
        inputMode="decimal"
        className="num min-w-0 flex-1 self-stretch bg-transparent text-right outline-none"
        value={showMask ? AMOUNT_MASK : text}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          const n = parseLocaleNumber(text, loc);
          onValueChange(n);
          setText(display(n));
        }}
        onChange={(e) => {
          setText(e.target.value);
          const n = parseLocaleNumber(e.target.value, loc);
          if (n !== null) onValueChange(n);
        }}
        {...rest}
        aria-describedby={describedBy}
      />
      {showMask ? (
        <span id={maskNoteId} className="sr-only">
          {AMOUNT_MASK_SPOKEN}
        </span>
      ) : null}
      {suffix ? <span className="text-ink-3 text-[12px] select-none">{suffix}</span> : null}
    </div>
  );
}

/** Money input; `currency` overrides the household currency (foreign accounts, assets, events). */
export function CurrencyInput({
  currency,
  ...props
}: Omit<BaseProps, "prefix"> & { currency?: string | undefined }) {
  const fmt = useFormat();
  return (
    <NumberInput
      decimals={2}
      sensitive
      prefix={currencySymbol({ locale: fmt.locale, currency: currency ?? fmt.currency })}
      {...props}
    />
  );
}

/** Edits a decimal fraction (0.07) displayed as a percentage (7). */
export function PercentInput({ value, onValueChange, decimals = 2, ...rest }: BaseProps) {
  return (
    <NumberInput
      {...rest}
      decimals={decimals}
      suffix="%"
      value={value === null ? null : Math.round(value * 100 * 1e6) / 1e6}
      onValueChange={(v) => onValueChange(v === null ? null : v / 100)}
    />
  );
}

/** Money + basis (today's money vs future/nominal) — the canonical way to enter an Amount. */
export function AmountInput({
  value,
  onChange,
  id,
  currency,
}: {
  value: Amount;
  onChange: (a: Amount) => void;
  id?: string;
  /** Currency of the amount when it is not the household's. */
  currency?: string | undefined;
}) {
  const toggle = (basis: ValueBasis) => onChange({ ...value, basis });
  return (
    <div className="flex items-center gap-1.5">
      <CurrencyInput
        id={id}
        currency={currency}
        value={value.value}
        onValueChange={(v) => onChange({ ...value, value: v ?? 0 })}
        className="flex-1"
      />
      <fieldset
        className="m-0 flex h-8 pointer-coarse:h-11 min-w-0 overflow-hidden rounded-md border border-border p-0 text-[11px]"
        aria-label="Value basis"
      >
        {(["real", "nominal"] as const).map((b) => (
          <button
            key={b}
            type="button"
            onClick={() => toggle(b)}
            aria-pressed={value.basis === b}
            title={b === "real" ? "Today's money (inflation-adjusted)" : "Future (nominal) money"}
            className={cn(
              "px-2 transition-colors",
              value.basis === b
                ? "bg-accent-soft text-accent font-semibold"
                : "text-ink-3 hover:bg-surface-2",
            )}
          >
            {b === "real" ? "Today" : "Future"}
          </button>
        ))}
      </fieldset>
    </div>
  );
}
