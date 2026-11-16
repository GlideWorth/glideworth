/**
 * Tax analytics for the UI (not the Monte Carlo hot path): per-year breakdown by tax kind and
 * jurisdiction, effective rate, marginal rate per income type (add one unit of that income type,
 * re-run the whole stack — knock-on effects such as allowance tapers, benefit taxation and IRMAA
 * cliffs are included), marginal-rate progression and bracket fill.
 */
import type { TaxLine } from "../engine/types.js";
import type {
  BracketFill,
  ResolvedTaxCharacter,
  TaxJurisdiction,
  TaxYearInput,
  TaxYearOutput,
} from "./types.js";

export type AnalyticsIncomeType =
  | "wage"
  | "self-employment"
  | "ordinary"
  | "pension"
  | "interest"
  | "dividends"
  | "capital-gains"
  | "rental"
  | "social-security";

const CHARACTER: Record<AnalyticsIncomeType, ResolvedTaxCharacter> = {
  wage: "wage",
  "self-employment": "self-employment",
  ordinary: "ordinary",
  pension: "pension",
  interest: "interest",
  dividends: "qualified-dividend",
  "capital-gains": "capital-gains-long",
  rental: "rental",
  "social-security": "social-security",
};

export const ANALYTICS_INCOME_TYPES = Object.keys(CHARACTER) as AnalyticsIncomeType[];

export interface TaxYearAnalysis {
  total: number;
  byKind: Partial<Record<TaxLine["kind"], number>>;
  byJurisdiction: Record<string, number>;
  grossIncome: number;
  taxableIncome: number;
  /** total / grossIncome (includes payroll taxes, like the incumbent). */
  effectiveRate: number;
  /** Sum of each level's reported marginal rate on ordinary income. */
  marginalRate: number;
  /** Marginal rate per income type: Δtax / Δincome for one more unit (whole stack). */
  marginalByType: Record<AnalyticsIncomeType, number>;
  brackets: BracketFill[];
  outputs: TaxYearOutput[];
}

export function runTaxStack(
  stack: TaxJurisdiction[],
  input: TaxYearInput,
  explain = false,
): TaxYearOutput[] {
  const outs: TaxYearOutput[] = [];
  for (const j of stack)
    outs.push(explain && j.explainYear ? j.explainYear(input, outs) : j.computeYear(input, outs));
  return outs;
}

export function stackTotal(outs: TaxYearOutput[]): number {
  let s = 0;
  for (const o of outs) for (const l of o.lines) s += l.amount;
  return s;
}

/** Input with `amount` more of an income character for `owner` (default: first living person). */
export function withExtraIncome(
  input: TaxYearInput,
  character: ResolvedTaxCharacter,
  amount: number,
  owner?: string,
): TaxYearInput {
  if (amount === 0) return input;
  const who = owner ?? input.people.find((p) => p.alive)?.id ?? input.people[0]?.id ?? "joint";
  return {
    ...input,
    income: [
      ...input.income,
      { sourceId: "__extra__", owner: who, character, amount, exemptIn: [] },
    ],
  };
}

export function marginalRateFor(
  stack: TaxJurisdiction[],
  input: TaxYearInput,
  type: AnalyticsIncomeType,
  opts: { owner?: string; delta?: number; baseTotal?: number } = {},
): number {
  const delta = opts.delta ?? 1;
  const base = opts.baseTotal ?? stackTotal(runTaxStack(stack, input));
  const bumped = stackTotal(
    runTaxStack(stack, withExtraIncome(input, CHARACTER[type], delta, opts.owner)),
  );
  return (bumped - base) / delta;
}

export function analyzeTaxYear(
  stack: TaxJurisdiction[],
  input: TaxYearInput,
  opts: { owner?: string; delta?: number; types?: AnalyticsIncomeType[] } = {},
): TaxYearAnalysis {
  const outputs = runTaxStack(stack, input, true);
  const total = stackTotal(outputs);
  const byKind: TaxYearAnalysis["byKind"] = {};
  const byJurisdiction: Record<string, number> = {};
  for (const o of outputs)
    for (const l of o.lines) {
      byKind[l.kind] = (byKind[l.kind] ?? 0) + l.amount;
      byJurisdiction[l.jurisdictionId] = (byJurisdiction[l.jurisdictionId] ?? 0) + l.amount;
    }
  const grossIncome = outputs.reduce((m, o) => Math.max(m, o.grossIncome), 0);
  const taxableIncome = outputs.reduce((m, o) => Math.max(m, o.taxableIncome), 0);
  const marginalByType = {} as Record<AnalyticsIncomeType, number>;
  for (const t of opts.types ?? ANALYTICS_INCOME_TYPES)
    marginalByType[t] = marginalRateFor(stack, input, t, {
      ...(opts.owner ? { owner: opts.owner } : {}),
      ...(opts.delta ? { delta: opts.delta } : {}),
      baseTotal: total,
    });
  return {
    total,
    byKind,
    byJurisdiction,
    grossIncome,
    taxableIncome,
    effectiveRate: grossIncome > 0 ? total / grossIncome : 0,
    marginalRate: outputs.reduce((s, o) => s + o.marginalRate, 0),
    marginalByType,
    brackets: outputs.flatMap((o) => o.brackets ?? []),
    outputs,
  };
}

/**
 * Marginal-rate progression: the marginal rate on each additional `step` of one income type, up
 * to `upTo` extra income (the incumbent's "Progression" view). Each point is the average rate on
 * that step.
 */
export function marginalProgression(
  stack: TaxJurisdiction[],
  input: TaxYearInput,
  type: AnalyticsIncomeType,
  upTo: number,
  step: number,
  owner?: string,
): { extra: number; marginalRate: number }[] {
  const out: { extra: number; marginalRate: number }[] = [];
  let prev = stackTotal(runTaxStack(stack, input));
  for (let x = step; x <= upTo + 1e-9; x += step) {
    const t = stackTotal(runTaxStack(stack, withExtraIncome(input, CHARACTER[type], x, owner)));
    out.push({ extra: x, marginalRate: (t - prev) / step });
    prev = t;
  }
  return out;
}
