/**
 * Warnings that quote money keep two forms of the sentence. `message` is complete and readable on its
 * own (the nominal amount in the household currency), so any caller that prints it shows a real figure.
 * `template` names each amount as a `{token}` (`SimWarning.amounts`), so a screen can fill it in its own
 * currency format and money basis with `warningText`.
 */
import type { Household } from "../schema/household.js";
import type { ValueBasis } from "../schema/primitives.js";
import { type DeflatablePeriod, type SimWarning, type WarningAmount, toBasis } from "./types.js";

const formatters = new Map<string, Intl.NumberFormat>();

/** Whole units in the household currency; cached, because a Monte Carlo run writes many warnings. */
function nominalMoney(value: number, household: Pick<Household, "currency" | "locale">): string {
  const key = `${household.locale}|${household.currency}`;
  let nf = formatters.get(key);
  if (!nf) {
    try {
      nf = new Intl.NumberFormat(household.locale, {
        style: "currency",
        currency: household.currency,
        maximumFractionDigits: 0,
      });
    } catch {
      nf = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 0 });
    }
    formatters.set(key, nf);
  }
  return nf.format(value);
}

function fill(
  template: string,
  amounts: readonly WarningAmount[],
  format: (a: WarningAmount) => string,
) {
  let text = template;
  for (const amount of amounts) text = text.replaceAll(`{${amount.token}}`, format(amount));
  return text;
}

/** The money fields of a warning: a readable nominal `message`, plus `template` and `amounts`. */
export function moneyWarning(
  household: Pick<Household, "currency" | "locale">,
  template: string,
  amounts: WarningAmount[],
): Pick<SimWarning, "message" | "template" | "amounts"> {
  return {
    message: fill(template, amounts, (a) => nominalMoney(a.nominal, household)),
    template,
    amounts,
  };
}

export function warningText(
  warning: Pick<SimWarning, "message" | "template" | "amounts">,
  opts: {
    basis: ValueBasis;
    /** The warning's period, when it has one. Without it the nominal amount is shown as-is. */
    period?: DeflatablePeriod | null;
    format: (value: number) => string;
  },
): string {
  if (!warning.template || !warning.amounts?.length) return warning.message;
  return fill(warning.template, warning.amounts, (amount) =>
    opts.format(
      opts.period
        ? toBasis(amount.nominal, opts.period, opts.basis, amount.measure)
        : amount.nominal,
    ),
  );
}
