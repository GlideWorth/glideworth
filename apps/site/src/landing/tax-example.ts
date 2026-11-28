/**
 * One plan year's tax lines, worked out by the real engine at build time, for the tax visual of a country
 * landing page. Nothing here is typed in: the lines, their labels and the amounts all come from
 * `simulate()` on a synthetic sample document from @glideworth/core/samples, so the figures move with the
 * engine and its cited tax tables. Server-side only (frontmatter and tests); never import it from a script.
 */
import {
  buildSimulationInput,
  type GlideworthDocument,
  simulate,
  type TaxLine,
} from "@glideworth/core";

export interface ExampleYear {
  /** Calendar year the plan year starts in (2037 for the UK tax year 2037/38). */
  year: number;
  /** "2037/38" for a plan aligned to a tax year that starts after January, else "2037". */
  label: string;
  lines: { label: string; kind: TaxLine["kind"]; amount: number }[];
  /** Sum of the rounded lines. */
  total: number;
}

/** "2037/38" or "2037". */
export function taxYearLabel(year: number, splitYear: boolean): string {
  return splitYear ? `${year}/${String((year + 1) % 100).padStart(2, "0")}` : String(year);
}

/**
 * The full plan year with the most tax lines (the richest example), ties going to the larger total.
 * Amounts are rounded to whole units of the plan's currency, in that year's (future) money.
 */
export function richestTaxYear(doc: GlideworthDocument, planId: string): ExampleYear {
  const plan = doc.plans.find((p) => p.id === planId);
  if (!plan) throw new Error(`No plan ${planId} in the sample document`);
  const alignment = plan.assumptions.yearAlignment;
  const splitYear = alignment?.kind === "fiscal" && alignment.startMonth > 1;
  const result = simulate(buildSimulationInput(doc, planId));
  let best: (typeof result.periods)[number] | undefined;
  for (const p of result.periods) {
    if (p.months !== 12 || p.taxes.lines.length === 0) continue;
    if (
      !best ||
      p.taxes.lines.length > best.taxes.lines.length ||
      (p.taxes.lines.length === best.taxes.lines.length && p.taxes.total > best.taxes.total)
    )
      best = p;
  }
  if (!best) throw new Error(`The sample plan ${planId} has no full year with tax`);
  const lines = best.taxes.lines.map((l) => ({
    label: l.label,
    kind: l.kind,
    amount: Math.round(l.amount),
  }));
  return {
    year: best.year,
    label: taxYearLabel(best.year, splitYear),
    lines,
    total: lines.reduce((s, l) => s + l.amount, 0),
  };
}

/** "£15,086", "−£2,734": the minus sign, then the symbol, then the grouped whole amount. */
export function formatMoney(amount: number, money: { symbol: string; locale: string }): string {
  return `${amount < 0 ? "−" : ""}${money.symbol}${Math.abs(amount).toLocaleString(money.locale)}`;
}
