/** Compare: metrics per plan, and an accounting attribution of the end-net-worth difference. */

import type { ProjectionResult } from "@glideworth/core";
import { conv, total } from "../../lib/money";

export interface CompareMetrics {
  endNetWorthReal: number;
  peakNetWorthReal: number;
  retirementYear: number | null;
  fiYear: number | null;
  firstShortfallYear: number | null;
  totalShortfallReal: number;
  lifetimeTaxesReal: number;
  lifetimeSpendingReal: number;
  avgSavingsRate: number | null;
  firstWithdrawalRate: number | null;
}

export function compareMetrics(r: ProjectionResult): CompareMetrics {
  const fi = r.milestones.find(
    (m) => /financial|fi\b|ms-fi/i.test(m.milestoneId) || /financial independence/i.test(m.name),
  );
  const sr = r.periods
    .map((p) => p.totals.savingsRate)
    .filter((x): x is number => x !== null && Number.isFinite(x));
  const ri = r.periods.findIndex((p) => p.year === r.summary.retirementYear);
  const wr =
    ri >= 0
      ? r.periods
          .slice(ri)
          .map((p) => p.totals.withdrawalRate)
          .find((x) => x !== null && x > 0)
      : null;
  return {
    endNetWorthReal: r.summary.endNetWorthReal,
    peakNetWorthReal: Math.max(...r.periods.map((p) => total(p, "netWorth", "real"))),
    retirementYear: r.summary.retirementYear,
    fiYear: fi?.month ? Number(fi.month.slice(0, 4)) : null,
    firstShortfallYear: r.summary.firstShortfallYear,
    totalShortfallReal: r.periods.reduce((s, p) => s + total(p, "shortfall", "real"), 0),
    lifetimeTaxesReal: r.summary.lifetimeTaxesReal,
    lifetimeSpendingReal: r.periods.reduce((s, p) => s + total(p, "spending", "real"), 0),
    avgSavingsRate: sr.length ? sr.reduce((s, x) => s + x, 0) / sr.length : null,
    firstWithdrawalRate: wr ?? null,
  };
}

export interface AttributionPart {
  label: string;
  value: number;
}

/**
 * Accounting attribution of the difference in final net worth (today's money): every unit is
 * income in, minus spending, minus taxes, plus investment returns, plus property and debt
 * changes. Each part is (other − base) summed over the plan in today's money; the residual is
 * shown as "Timing & other" so the parts always add up to the total difference.
 */
export function attributeDifference(
  base: ProjectionResult,
  other: ProjectionResult,
): { total: number; parts: AttributionPart[] } {
  const sum = (r: ProjectionResult, pick: (p: ProjectionResult["periods"][number]) => number) =>
    r.periods.reduce((s, p) => s + conv(p, pick(p), "real", "flow"), 0);
  const growth = (p: ProjectionResult["periods"][number]) =>
    p.accounts.reduce((s, a) => s + a.growth + a.dividends - a.fees, 0);
  const parts: AttributionPart[] = [
    {
      label: "Income",
      value: sum(other, (p) => p.totals.income) - sum(base, (p) => p.totals.income),
    },
    {
      label: "Spending",
      value: -(sum(other, (p) => p.totals.expenses) - sum(base, (p) => p.totals.expenses)),
    },
    {
      label: "Taxes",
      value: -(sum(other, (p) => p.totals.taxes) - sum(base, (p) => p.totals.taxes)),
    },
    { label: "Investment returns", value: sum(other, growth) - sum(base, growth) },
  ];
  const total = other.summary.endNetWorthReal - base.summary.endNetWorthReal;
  const explained = parts.reduce((s, p) => s + p.value, 0);
  parts.push({ label: "Timing, property & other", value: total - explained });
  return { total, parts: parts.filter((p) => Math.abs(p.value) > 0.5) };
}
