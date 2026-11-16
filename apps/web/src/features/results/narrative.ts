/**
 * Deterministic, evidence-backed narrative for one year, built from the period's own numbers
 * (totals, ledger, milestones, warnings). Every sentence cites figures from the result; when
 * insights.explainProjection is available its findings are shown alongside.
 */
import type { PeriodResult, ProjectionResult, ValueBasis } from "@glideworth/core";
import { conv, type EntityIndex } from "./model";

export interface NarrativeLine {
  tone: "neutral" | "positive" | "negative" | "warning";
  text: string;
}

export function ledgerByKind(p: PeriodResult, kind: string) {
  const label = new Map(p.ledgerNodes.map((n) => [n.id, n]));
  return p.ledger
    .filter((e) => e.kind === kind && e.amount > 0.005)
    .map((e) => ({
      ...e,
      fromLabel: label.get(e.from)?.label ?? e.from,
      toLabel: label.get(e.to)?.label ?? e.to,
      fromRef: label.get(e.from)?.refId,
      toRef: label.get(e.to)?.refId,
    }));
}

export function yearNarrative(
  result: ProjectionResult,
  i: number,
  basis: ValueBasis,
  index: EntityIndex,
  money: (v: number) => string,
  pct: (v: number) => string,
): NarrativeLine[] {
  const p = result.periods[i];
  if (!p) return [];
  const prev = i > 0 ? result.periods[i - 1] : undefined;
  // Everything below except net worth is money that moved during the year (a flow).
  const m = (v: number) => money(conv(p, v, basis, "flow"));
  const out: NarrativeLine[] = [];
  const T = p.totals;
  const name = (ref: string | undefined, fallback: string) =>
    (ref && (index.accounts.get(ref)?.name ?? index.assets.get(ref) ?? index.debts.get(ref))) ||
    fallback;

  out.push({
    tone: "neutral",
    // "Spent" is the headline Spending figure shown beside this text; the rest of the outgoings
    // (loan principal, property costs outside the spending definition) are named separately so
    // the sentence agrees with the stats above it.
    text: `${p.months < 12 ? `In the ${p.months} months of ${p.year}` : `In ${p.year}`} the household received ${m(T.income)} of income and spent ${m(T.spending)}${
      T.expenses - T.spending > 0.5
        ? `, plus ${m(T.expenses - T.spending)} of loan repayments and other outgoings`
        : ""
    }; taxes were ${m(T.taxes)}${T.income > 0 ? ` (an effective rate of ${pct(p.taxes.effectiveRate)})` : ""}.`,
  });

  const contrib = ledgerByKind(p, "contribution");
  if (T.contributions > 0.5) {
    const top = [...contrib].sort((a, b) => b.amount - a.amount).slice(0, 3);
    out.push({
      tone: "positive",
      text: `${m(T.contributions)} was saved${T.savingsRate !== null ? ` (savings rate ${pct(T.savingsRate)}${(T.oneOffInflows ?? 0) > 0.5 ? `, counting only the ${m(T.savedFromIncome ?? 0)} saved out of ${m(T.afterTaxIncome ?? 0)} after-tax income, not ${m(T.oneOffInflows ?? 0)} of one-off money` : ""})` : ""}${top.length ? `: ${top.map((e) => `${m(e.amount)} into ${name(e.toRef, e.toLabel)}`).join(", ")}` : ""}.`,
    });
  }
  const wd = ledgerByKind(p, "withdrawal");
  if (T.withdrawals > 0.5) {
    const top = [...wd].sort((a, b) => b.amount - a.amount).slice(0, 3);
    out.push({
      tone: "neutral",
      text: `To cover the gap, ${m(T.withdrawals)} was withdrawn${top.length ? ` — ${top.map((e) => `${m(e.amount)} from ${name(e.fromRef, e.fromLabel)}`).join(", ")}` : ""}${T.withdrawalRate !== null ? `, a withdrawal rate of ${pct(T.withdrawalRate)} of the portfolio` : ""}.`,
    });
  }
  for (const id of p.milestonesReached) {
    const ms = result.milestones.find((x) => x.milestoneId === id);
    if (ms) out.push({ tone: "positive", text: `Milestone reached: ${ms.name}.` });
  }
  if (T.shortfall > 0.5) {
    const cut = p.expenses.filter((e) => e.requested - e.funded > 0.5);
    out.push({
      tone: "negative",
      text: `${m(T.shortfall)} of planned spending could not be funded${
        cut.length
          ? ` (${cut
              .map((e) => e.label)
              .slice(0, 3)
              .join(", ")} were cut)`
          : ""
      }. Liquid accounts were exhausted or locked.`,
    });
  }
  for (const w of result.warnings
    .filter((x) => x.periodIndex === i && x.severity !== "info")
    .slice(0, 3))
    out.push({ tone: "warning", text: w.message });
  if (prev) {
    const d =
      conv(p, T.netWorth, basis, "stock") - conv(prev, prev.totals.netWorth, basis, "stock");
    const growth = p.accounts.reduce((s, a) => s + a.growth + a.dividends - a.fees, 0);
    out.push({
      tone: d >= 0 ? "positive" : "negative",
      text: `Net worth ${d >= 0 ? "rose" : "fell"} by ${money(Math.abs(d))}${basis === "real" ? " in today's money" : ""}; investments ${growth >= 0 ? "earned" : "lost"} ${m(Math.abs(growth))} after fees. Stocks returned ${pct(p.market.stocks)} and inflation was ${pct(p.market.inflation)}.`,
    });
  }
  return out;
}
