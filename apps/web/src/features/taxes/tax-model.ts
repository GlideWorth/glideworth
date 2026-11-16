/** Tax derivations: by kind / jurisdiction, composition, bracket fill, lifetime totals. */
import type { Plan, ProjectionResult, ValueBasis } from "@glideworth/core";
import { conv } from "../results/model";

export type TaxRegime = "uk" | "us" | "ca" | "au" | "custom" | "flat" | "other";

export function taxRegime(
  plan: Plan | undefined,
  country: string | undefined,
  result?: ProjectionResult,
): TaxRegime {
  const jur = new Set(
    result?.periods.flatMap((p) => p.taxes.lines.map((l) => l.jurisdictionId)) ?? [],
  );
  const has = (prefix: string) =>
    [...jur].some((j) => j === prefix || j.startsWith(`${prefix}-`) || j.startsWith(`${prefix}:`));
  if (plan?.tax.mode === "custom" || jur.has("custom")) return "custom";
  if (plan?.tax.mode === "flat" || jur.has("flat")) return "flat";
  if (jur.has("uk")) return "uk";
  if (has("us")) return "us";
  if (has("ca")) return "ca";
  if (jur.has("au")) return "au";
  if (country === "GB") return "uk";
  if (country === "US") return "us";
  if (country === "CA") return "ca";
  if (country === "AU") return "au";
  return "other";
}

const UK_KIND: Record<string, string> = {
  income: "Income Tax",
  payroll: "National Insurance",
  dividends: "Dividend tax",
  "capital-gains": "Capital Gains Tax",
  penalty: "Unauthorised payment charge",
};
const GENERIC_KIND: Record<string, string> = {
  income: "Income tax",
  "capital-gains": "Capital gains",
  dividends: "Dividends",
  payroll: "Payroll / social security",
  "self-employment": "Self-employment",
  niit: "Net investment income tax",
  amt: "AMT",
  irmaa: "IRMAA surcharge",
  "aca-reconciliation": "ACA reconciliation",
  penalty: "Early-withdrawal penalty",
  wealth: "Wealth tax",
  property: "Property tax",
  local: "Local tax",
  credit: "Credits",
  other: "Other",
};

export function kindLabel(kind: string, regime: TaxRegime): string {
  return (regime === "uk" ? UK_KIND[kind] : undefined) ?? GENERIC_KIND[kind] ?? kind;
}

export function taxKinds(result: ProjectionResult): string[] {
  const order = Object.keys(GENERIC_KIND);
  return [...new Set(result.periods.flatMap((p) => p.taxes.lines.map((l) => l.kind)))].sort(
    (a, b) => order.indexOf(a) - order.indexOf(b),
  );
}
export function jurisdictions(result: ProjectionResult): string[] {
  return [...new Set(result.periods.flatMap((p) => p.taxes.lines.map((l) => l.jurisdictionId)))];
}

export function byKindSeries(
  result: ProjectionResult,
  basis: ValueBasis,
  key: "kind" | "jurisdiction",
) {
  const keys = key === "kind" ? taxKinds(result) : jurisdictions(result);
  return keys.map((k) => ({
    key: k,
    values: result.periods.map((p) =>
      conv(
        p,
        p.taxes.lines
          .filter((l) => (key === "kind" ? l.kind : l.jurisdictionId) === k)
          .reduce((s, l) => s + l.amount, 0),
        basis,
        "flow",
      ),
    ),
  }));
}

export function lifetimeByLabel(result: ProjectionResult, basis: ValueBasis) {
  const m = new Map<string, { kind: string; jurisdiction: string; total: number }>();
  for (const p of result.periods)
    for (const l of p.taxes.lines) {
      const k = `${l.jurisdictionId}|${l.label}`;
      const cur = m.get(k) ?? { kind: l.kind, jurisdiction: l.jurisdictionId, total: 0 };
      cur.total += conv(p, l.amount, basis, "flow");
      m.set(k, cur);
    }
  return [...m.entries()]
    .map(([k, v]) => ({ label: k.split("|")[1]!, ...v }))
    .sort((a, b) => b.total - a.total);
}

export function weightedEffectiveRate(result: ProjectionResult): number {
  const tax = result.periods.reduce((s, p) => s + conv(p, p.taxes.total, "real", "flow"), 0);
  const inc = result.periods.reduce((s, p) => s + conv(p, p.taxes.grossIncome, "real", "flow"), 0);
  return inc > 0 ? tax / inc : 0;
}

/** Income composition by tax character (gross, before tax). */
export const CHARACTER_LABEL: Record<string, string> = {
  wage: "Employment",
  "self-employment": "Self-employment",
  ordinary: "Other taxable",
  pension: "Pensions",
  "social-security": "State benefits",
  "qualified-dividend": "Dividends",
  "ordinary-dividend": "Dividends",
  interest: "Interest",
  "capital-gains-long": "Capital gains",
  "capital-gains-short": "Capital gains",
  rental: "Rental",
  "tax-free": "Tax-free",
  auto: "Other taxable",
};
export function compositionSeries(result: ProjectionResult, basis: ValueBasis) {
  const groups = [
    ...new Set(
      result.periods.flatMap((p) =>
        p.income.map((l) => CHARACTER_LABEL[l.taxCharacter] ?? l.taxCharacter),
      ),
    ),
  ];
  const withdrawals = result.periods.map((p) =>
    conv(p, p.totals.withdrawals, basis, "withdrawals"),
  );
  return {
    groups: groups.map((g) => ({
      key: g,
      values: result.periods.map((p) =>
        conv(
          p,
          p.income
            .filter((l) => (CHARACTER_LABEL[l.taxCharacter] ?? l.taxCharacter) === g)
            .reduce((s, l) => s + l.amount, 0),
          basis,
          "flow",
        ),
      ),
    })),
    withdrawals,
  };
}
