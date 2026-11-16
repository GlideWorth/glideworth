/**
 * Tax analytics from core's real jurisdiction stack (UK, US, Canada, Australia, flat and custom).
 *
 * The engine does not hand back the exact `TaxYearInput` it used, so we rebuild it for a period from
 * the period result (income lines, account withdrawals, contributions) and run core's analytics
 * (`analyzeTaxYear`, `marginalRateFor`, `marginalProgression`) over the plan's resolved stack. The
 * rebuilt input is an approximation; `reconstructionDrift` compares its total to the engine's own so
 * the UI can say how close it is.
 */
import {
  ACCOUNT_TYPE_INFO,
  type AnalyticsIncomeType,
  analyzeTaxYear,
  createDefaultTaxRegistry,
  deflator,
  type GlideworthDocument,
  marginalProgression,
  marginalRateFor,
  type PeriodResult,
  type Plan,
  type ProjectionResult,
  type ResolvedTaxCharacter,
  runTaxStack,
  stackTotal,
  type TaxJurisdiction,
  type TaxYearAnalysis,
  type TaxYearInput,
} from "@glideworth/core";

const registry = createDefaultTaxRegistry();

export type TaxStackResult = { ok: true; stack: TaxJurisdiction[] } | { ok: false; reason: string };

/** The plan's jurisdiction stack, or why there is none (unsupported country, stub). */
export function resolveTaxStack(doc: GlideworthDocument, plan: Plan): TaxStackResult {
  try {
    const stack = registry.resolveStack(plan.tax, doc.household.location);
    const stub = stack.find((j) => j.status === "stub");
    if (stub) return { ok: false, reason: `${stub.label} is not implemented yet.` };
    return { ok: true, stack };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

const CHARACTERS: ResolvedTaxCharacter[] = [
  "wage",
  "self-employment",
  "ordinary",
  "pension",
  "social-security",
  "qualified-dividend",
  "ordinary-dividend",
  "interest",
  "capital-gains-long",
  "capital-gains-short",
  "rental",
  "tax-free",
];
const resolveCharacter = (c: string): ResolvedTaxCharacter =>
  (CHARACTERS as string[]).includes(c) ? (c as ResolvedTaxCharacter) : "ordinary";

/** Start-of-period price index (core's flow deflator; derived for results cached before it existed). */
const piStart = (p: PeriodResult): number => deflator(p, "flow");

export function reconstructTaxInput(
  doc: GlideworthDocument,
  plan: Plan,
  result: ProjectionResult,
  periodIndex: number,
): TaxYearInput {
  const p = result.periods[periodIndex]!;
  const prev = result.periods[periodIndex - 1];
  const accountDef = new Map(doc.finances.accounts.map((a) => [a.id, a]));
  const income: TaxYearInput["income"] = p.income
    .filter((l) => l.amount > 0)
    .map((l) => ({
      sourceId: l.sourceId,
      owner: l.owner,
      character: resolveCharacter(l.taxCharacter),
      amount: l.amount,
      exemptIn: [],
      ...(l.sourceKind === "benefit" ? { incomeType: "benefit" } : {}),
    }));
  const withdrawals: TaxYearInput["withdrawals"] = [];
  const ukPensionDrawn = p.accounts
    .filter(
      (a) =>
        accountDef.get(a.accountId)?.type.startsWith("uk-") &&
        ACCOUNT_TYPE_INFO[accountDef.get(a.accountId)!.type].taxTreatment === "tax-deferred",
    )
    .reduce((sum, a) => sum + a.withdrawals, 0);
  for (const a of p.accounts) {
    if (a.withdrawals <= 0) continue;
    const def = accountDef.get(a.accountId);
    if (!def) continue;
    const info = ACCOUNT_TYPE_INFO[def.type];
    const opening = Math.max(a.opening, 1e-9);
    const basis = a.costBasis ?? opening;
    let taxable = 0;
    let character: ResolvedTaxCharacter = "ordinary";
    if (info.taxTreatment === "taxable") {
      taxable = a.withdrawals * Math.max(0, 1 - basis / opening);
      character = "capital-gains-long";
    } else if (info.taxTreatment === "tax-deferred") {
      const free =
        def.type.startsWith("uk-") && ukPensionDrawn > 0
          ? (p.totals.taxFreePensionCash ?? 0) * (a.withdrawals / ukPensionDrawn)
          : 0;
      taxable = Math.max(0, a.withdrawals - Math.min(free, a.withdrawals));
    }
    withdrawals.push({
      accountId: a.accountId,
      accountType: def.type,
      treatment: info.taxTreatment,
      owner: a.owner ?? def.owner,
      amount: a.withdrawals,
      taxableAmount: taxable,
      character,
      penaltyRate: 0,
      ownerAge: p.ages[a.owner ?? def.owner] ?? p.ages[doc.household.people[0]?.id ?? ""] ?? 0,
    });
  }
  const dependents = doc.household.dependents.map((d) => {
    const [y, m] = d.birthMonth.split("-").map(Number);
    return { id: d.id, age: p.year - (y ?? p.year) - ((m ?? 1) - 1) / 12 };
  });
  return {
    year: p.year,
    periodIndex,
    months: p.months,
    filingStatus: plan.tax.filingStatus,
    location: doc.household.location,
    people: doc.household.people.map((x) => ({
      id: x.id,
      role: x.role,
      age: p.ages[x.id] ?? 0,
      alive: p.alive[x.id] ?? true,
    })),
    dependents,
    priceIndex: piStart(p),
    income,
    withdrawals,
    deductions: [],
    config: plan.tax,
    history: prev
      ? [
          {
            magi: prev.taxes.facts.magi ?? 0,
            agi: prev.taxes.facts.agi ?? 0,
          },
        ]
      : [],
  };
}

/** Relative difference between the rebuilt stack total and the engine's own tax total for the year. */
export function reconstructionDrift(
  stack: TaxJurisdiction[],
  input: TaxYearInput,
  p: PeriodResult,
): number {
  const engine = p.taxes.lines
    .filter((l) =>
      stack.some((j) => j.id === l.jurisdictionId || l.jurisdictionId.startsWith(`${j.id}:`)),
    )
    .reduce((s, l) => s + l.amount, 0);
  const rebuilt = stackTotal(runTaxStack(stack, input));
  const scale = Math.max(Math.abs(engine), 1_000);
  return (rebuilt - engine) / scale;
}

export interface YearAnalytics {
  analysis: TaxYearAnalysis;
  input: TaxYearInput;
  drift: number;
}

export function analyseYear(
  doc: GlideworthDocument,
  plan: Plan,
  result: ProjectionResult,
  stack: TaxJurisdiction[],
  index: number,
): YearAnalytics {
  const input = reconstructTaxInput(doc, plan, result, index);
  const analysis = analyzeTaxYear(stack, input);
  return { analysis, input, drift: reconstructionDrift(stack, input, result.periods[index]!) };
}

export const MARGINAL_TYPES: { id: AnalyticsIncomeType; label: string }[] = [
  { id: "wage", label: "Employment" },
  { id: "self-employment", label: "Self-employment" },
  { id: "ordinary", label: "Other ordinary income" },
  { id: "pension", label: "Pension income" },
  { id: "interest", label: "Interest" },
  { id: "dividends", label: "Dividends" },
  { id: "capital-gains", label: "Capital gains" },
  { id: "rental", label: "Rental income" },
  { id: "social-security", label: "State benefits" },
];

/** Marginal rate over time for one income type (re-runs the whole stack with one more unit). */
export function marginalOverTime(
  doc: GlideworthDocument,
  plan: Plan,
  result: ProjectionResult,
  stack: TaxJurisdiction[],
  type: AnalyticsIncomeType,
): number[] {
  return result.periods.map((_, i) => {
    const input = reconstructTaxInput(doc, plan, result, i);
    if (!input.people.some((x) => x.alive)) return 0;
    return marginalRateFor(stack, input, type, { delta: 100 });
  });
}

/** Marginal rate on each additional step of income (core's marginalProgression), for the chart. */
export function progressionFor(
  stack: TaxJurisdiction[],
  input: TaxYearInput,
  type: AnalyticsIncomeType,
  upTo: number,
  step: number,
): { extra: number; marginalRate: number }[] {
  return marginalProgression(stack, input, type, upTo, step);
}

export interface TaxSource {
  jurisdiction: string;
  label: string;
  years: string[];
  links: { url: string; note?: string }[];
}

/** Tax-data year(s) and official sources per jurisdiction in the stack. */
export function taxSources(stack: TaxJurisdiction[]): TaxSource[] {
  return stack.map((j) => {
    const srcs = j.sources ?? [];
    const years = [...new Set(srcs.map((s) => s.taxYear))];
    const seen = new Set<string>();
    const links: TaxSource["links"] = [];
    for (const s of srcs) {
      if (seen.has(s.url)) continue;
      seen.add(s.url);
      links.push({ url: s.url, ...(s.note ? { note: s.note } : {}) });
    }
    return { jurisdiction: j.id, label: j.label, years, links };
  });
}
