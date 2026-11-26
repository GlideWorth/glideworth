/**
 * Hooks for the `tax.strategy` phase (Roth conversions, withdrawal shielding, gain harvesting)
 * and the beam-search optimiser. Each answers "how much more of X can this year absorb before
 * crossing the target?" by re-running the jurisdiction stack (monotone search: exponential
 * bracketing then bisection to `tolerance`). Pure; no engine state.
 *
 * Targets mirror TaxStrategy.target (schema/strategies.ts), with `income.amount` already
 * converted to nominal money by the caller:
 *   bracket           statutory ordinary bracket rate (fact 'tax.ordinaryBracketRate'; 0 = stay
 *                     within the allowance / standard deduction)
 *   irmaa-tier        keep MAGI at or below the tier's threshold (tier 1 = no surcharge)
 *   aca-fpl-multiple  keep ACA MAGI at or below multiple x FPL(household size)
 *   income            keep AGI (or taxable income when there is no AGI) at or below amount
 */
import { runTaxStack, stackTotal, withExtraIncome } from "./analytics.js";
import { US_ACA_YEARS, US_IRMAA_YEARS } from "./data/us-federal.js";
import {
  acaHouseholdSize,
  federalPovertyLine,
  irmaaThresholds,
} from "./jurisdictions/us-federal.js";
import { usTable } from "./jurisdictions/us-index.js";
import type {
  ResolvedTaxCharacter,
  TaxJurisdiction,
  TaxYearInput,
  TaxYearOutput,
} from "./types.js";

export type TaxTarget =
  | { kind: "bracket"; rate: number }
  | { kind: "irmaa-tier"; tier: number }
  | { kind: "aca-fpl-multiple"; multiple: number }
  | { kind: "income"; amount: number };

export interface HeadroomOptions {
  /** Character of the added income: 'ordinary' (conversion / tax-deferred withdrawal) by default. */
  character?: ResolvedTaxCharacter;
  owner?: string;
  /** Upper bound searched (default 10m). */
  max?: number;
  /** Precision in currency units (default 1). */
  tolerance?: number;
}

function merged(outs: TaxYearOutput[]): Record<string, number> {
  const f: Record<string, number> = {};
  for (const o of outs) Object.assign(f, o.facts);
  return f;
}

export function largestSatisfying(pred: (x: number) => boolean, max: number, tol: number): number {
  if (!pred(0)) return 0;
  let lo = 0;
  let hi = 1_000;
  while (hi < max && pred(hi)) {
    lo = hi;
    hi *= 2;
  }
  if (hi >= max) {
    if (pred(max)) return max;
    hi = max;
  }
  while (hi - lo > tol) {
    const mid = (lo + hi) / 2;
    if (pred(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

export function targetSatisfied(
  input: TaxYearInput,
  outs: TaxYearOutput[],
  target: TaxTarget,
  owner?: string,
): boolean {
  const f = merged(outs);
  switch (target.kind) {
    case "bracket": {
      const r =
        (owner ? f[`tax.ordinaryBracketRate.${owner}`] : undefined) ??
        f["tax.ordinaryBracketRate"] ??
        0;
      return r <= target.rate + 1e-12;
    }
    case "irmaa-tier": {
      const t = usTable(US_IRMAA_YEARS, input);
      const thr = irmaaThresholds(input.filingStatus, t.factor, t.row);
      const limit =
        thr[Math.max(0, Math.min(thr.length - 1, target.tier - 1))] ?? Number.POSITIVE_INFINITY;
      return (f.magi ?? 0) <= limit;
    }
    case "aca-fpl-multiple": {
      const size = acaHouseholdSize(input);
      const aca = usTable(US_ACA_YEARS, input);
      const fpl = federalPovertyLine(size, aca.factor, aca.row);
      return (f["us.acaMagi"] ?? f.agi ?? 0) <= target.multiple * fpl;
    }
    case "income": {
      // Individually taxed jurisdictions (UK) report income per person.
      const own = owner !== undefined ? f[`uk.adjustedNetIncome.${owner}`] : undefined;
      return (
        (own ?? f.agi ?? outs.reduce((m, o) => Math.max(m, o.taxableIncome), 0)) <= target.amount
      );
    }
  }
}

/**
 * Extra income (default: ordinary, e.g. a Roth conversion or tax-deferred withdrawal) that fits
 * under the target this year. 0 when the year is already past the target.
 */
export function incomeHeadroom(
  stack: TaxJurisdiction[],
  input: TaxYearInput,
  target: TaxTarget,
  opts: HeadroomOptions = {},
): number {
  const character = opts.character ?? "ordinary";
  const pred = (x: number) =>
    targetSatisfied(
      input,
      runTaxStack(stack, withExtraIncome(input, character, x, opts.owner)),
      target,
      opts.owner,
    );
  return largestSatisfying(pred, opts.max ?? 10_000_000, opts.tolerance ?? 1);
}

/**
 * Long-term gains that can be realised while the extra tax stays at or below `maxRate` of the
 * gain (0 = the US 0% LTCG bracket / the UK annual exempt amount).
 */
export function gainHarvestHeadroom(
  stack: TaxJurisdiction[],
  input: TaxYearInput,
  maxRate = 0,
  opts: Omit<HeadroomOptions, "character"> = {},
): number {
  const base = stackTotal(runTaxStack(stack, input));
  const pred = (x: number) =>
    stackTotal(runTaxStack(stack, withExtraIncome(input, "capital-gains-long", x, opts.owner))) -
      base <=
    maxRate * x + 1e-6;
  return largestSatisfying(pred, opts.max ?? 10_000_000, opts.tolerance ?? 1);
}

/** Tax cost of adding `amount` of a character this year (e.g. the cost of a proposed conversion). */
export function incrementalTax(
  stack: TaxJurisdiction[],
  input: TaxYearInput,
  amount: number,
  character: ResolvedTaxCharacter = "ordinary",
  owner?: string,
): number {
  const base = stackTotal(runTaxStack(stack, input));
  return stackTotal(runTaxStack(stack, withExtraIncome(input, character, amount, owner))) - base;
}
