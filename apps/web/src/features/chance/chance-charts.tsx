/** Chance-of-success visuals: fan chart, failure histogram, milestone timing, sequence risk, trials. */

import type {
  MonteCarloResult,
  MonteCarloSettings,
  ProjectionResult,
  ValueBasis,
} from "@glideworth/core";
import { useMemo } from "react";
import { mix, outcomeColor, slotColor } from "../../components/charts/palette";
import { SeriesChart } from "../../components/charts/series-chart";
import { EmptyState } from "../../components/charts/states";
import { tooltipRow } from "../../components/charts/tokens";
import { Table, TBody, TD, TH, THead, TR } from "../../components/ui/table";
import { cn } from "../../lib/cn";
import { formatMonth } from "../../lib/format";
import { conv, measureOf, unconv } from "../../lib/money";
import { useResolvedTheme } from "../../lib/theme";
import { useFormat } from "../../lib/workspace";

export type FanMetric =
  | "netWorth"
  | "liquidNetWorth"
  | "portfolio"
  | "spending"
  | "income"
  | "taxes"
  | "withdrawalRate";
export const FAN_LABEL: Record<FanMetric, string> = {
  netWorth: "Net worth",
  liquidNetWorth: "Liquid net worth",
  portfolio: "Portfolio",
  spending: "Spending",
  income: "Income",
  taxes: "Taxes",
  withdrawalRate: "Withdrawal rate",
};

export function availableMetrics(mc: MonteCarloResult): FanMetric[] {
  return (Object.keys(FAN_LABEL) as FanMetric[]).filter((m) =>
    mc.percentiles.some((p) => p.metric === m),
  );
}

function band(series: MonteCarloResult["percentiles"][number] | undefined, p: number): number[] {
  if (!series) return [];
  const exact = series.bands.find((b) => Math.abs(b.p - p) < 1e-6);
  if (exact) return exact.values;
  const sorted = [...series.bands].sort((a, b) => Math.abs(a.p - p) - Math.abs(b.p - p));
  return sorted[0]?.values ?? [];
}

export function FanChart({
  mc,
  det,
  metric,
  basis,
  height = 340,
  highlight,
}: {
  mc: MonteCarloResult;
  det: ProjectionResult | undefined;
  metric: FanMetric;
  basis: ValueBasis;
  height?: number;
  highlight?: { name: string; values: number[] } | null;
}) {
  const f = useFormat();
  const real = mc.percentiles.find((p) => p.metric === metric);
  const nominal = mc.percentilesNominal?.find((p) => p.metric === metric);
  const ratio = metric === "withdrawalRate";
  const years = real?.years ?? mc.years ?? [];
  const detPeriods = years.map((y) => det?.periods.find((p) => p.year === y));
  const series = basis === "nominal" && nominal ? nominal : real;
  const scale = (vals: number[]) =>
    basis === "nominal" && !nominal && !ratio
      ? vals.map((v, i) => {
          const p = detPeriods[i];
          return p ? unconv(p, v, "real", measureOf(metric)) : v;
        })
      : vals;
  const p5 = scale(band(series, 0.05));
  const p25 = scale(band(series, 0.25));
  const p50 = scale(band(series, 0.5));
  const p75 = scale(band(series, 0.75));
  const p95 = scale(band(series, 0.95));
  const detVals = det
    ? years.map((y) => {
        const p = det.periods.find((x) => x.year === y);
        if (!p) return null;
        const v =
          metric === "withdrawalRate"
            ? (p.totals.withdrawalRate ?? 0)
            : (p.totals[metric as Exclude<FanMetric, "withdrawalRate">] as number);
        return ratio ? v : conv(p, v, basis, measureOf(metric));
      })
    : [];
  if (!series) return <EmptyState title="No percentile data for this metric" />;
  const fmt = (v: number) => (ratio ? f.percent(v) : f.money(v));
  return (
    <SeriesChart
      labels={years.map(String)}
      format={ratio ? "percent" : "money"}
      locale={f.locale}
      currency={f.currency}
      height={height}
      ariaLabel={`Fan chart of ${FAN_LABEL[metric]} percentiles across trials`}
      tooltipExtra={(i) =>
        [
          tooltipRow(null, "95th percentile", fmt(p95[i] ?? 0)),
          tooltipRow(null, "75th", fmt(p75[i] ?? 0)),
          tooltipRow(null, "Median", fmt(p50[i] ?? 0), true),
          tooltipRow(null, "25th", fmt(p25[i] ?? 0)),
          tooltipRow(null, "5th percentile", fmt(p5[i] ?? 0)),
          detVals[i] !== null && detVals[i] !== undefined
            ? tooltipRow(null, "Plan assumptions", fmt(detVals[i]!))
            : "",
          highlight ? tooltipRow(null, highlight.name, fmt(highlight.values[i] ?? 0), true) : "",
        ].join("")
      }
      series={[
        {
          name: "base",
          color: "transparent",
          type: "area",
          stack: "fan",
          values: p5,
          silent: true,
          transparent: true,
        },
        {
          name: "5–25th",
          color: (t) => mix(slotColor(t.theme, 0), t.surface, 0.78),
          type: "area",
          stack: "fan",
          values: p25.map((v, i) => v - (p5[i] ?? 0)),
          silent: true,
          width: 0,
        },
        {
          name: "25–75th",
          color: (t) => mix(slotColor(t.theme, 0), t.surface, 0.5),
          type: "area",
          stack: "fan",
          values: p75.map((v, i) => v - (p25[i] ?? 0)),
          silent: true,
          width: 0,
        },
        {
          name: "75–95th",
          color: (t) => mix(slotColor(t.theme, 0), t.surface, 0.78),
          type: "area",
          stack: "fan",
          values: p95.map((v, i) => v - (p75[i] ?? 0)),
          silent: true,
          width: 0,
        },
        { name: "Median", color: (t) => slotColor(t.theme, 0), values: p50, width: 2.25, z: 5 },
        ...(det
          ? [
              {
                name: "Plan assumptions",
                color: (t: { ink: string }) => t.ink,
                values: detVals,
                dashed: true,
                width: 1.5,
                z: 6,
              },
            ]
          : []),
        ...(highlight
          ? [
              {
                name: highlight.name,
                color: (t: { ochre: string }) => t.ochre,
                values: highlight.values,
                width: 2,
                z: 7,
              },
            ]
          : []),
      ]}
      legend={false}
    />
  );
}

export function FailureHistogram({
  mc,
  onPick,
}: {
  mc: MonteCarloResult;
  onPick?: (year: number) => void;
}) {
  const f = useFormat();
  const data = useMemo(() => {
    if (mc.failureYearHistogram) return mc.failureYearHistogram;
    const m = new Map<number, number>();
    for (const t of mc.trialSummaries) {
      const y = t.failureYear ?? t.firstShortfallYear;
      if (y !== null && y !== undefined) m.set(y, (m.get(y) ?? 0) + 1);
    }
    return [...m.entries()].sort((a, b) => a[0] - b[0]).map(([year, count]) => ({ year, count }));
  }, [mc]);
  const years = mc.years ?? mc.percentiles[0]?.years ?? [];
  if (!data.length)
    return (
      <EmptyState title="No trial failed">
        Every trial funded every year under this success definition.
      </EmptyState>
    );
  const counts = years.map((y) => data.find((d) => d.year === y)?.count ?? 0);
  return (
    <SeriesChart
      labels={years.map(String)}
      format="number"
      locale={f.locale}
      height={220}
      ariaLabel="Histogram of the year each failed trial first ran short"
      onClickIndex={onPick ? (i) => onPick(years[i]!) : undefined}
      tooltipExtra={(i) =>
        tooltipRow(
          null,
          "Share of all trials",
          f.percent((counts[i] ?? 0) / Math.max(1, mc.trials)),
        )
      }
      series={[{ name: "Failed trials", color: (t) => t.negative, type: "bar", values: counts }]}
    />
  );
}

export function MilestoneTimingView({
  mc,
  startYear,
}: {
  mc: MonteCarloResult;
  startYear: number;
}) {
  const f = useFormat();
  if (!mc.milestoneTiming.length) return <EmptyState title="No milestones to time" />;
  const toYear = (m: string | null) =>
    m ? Number(m.slice(0, 4)) + (Number(m.slice(5, 7)) - 1) / 12 : null;
  const all = mc.milestoneTiming
    .flatMap((t) => t.percentiles.map((p) => toYear(p.month)))
    .filter((x): x is number => x !== null);
  const lo = Math.min(startYear, ...all);
  const hi = Math.max(lo + 1, ...all);
  const pos = (y: number) => `${((y - lo) / (hi - lo)) * 100}%`;
  return (
    <div className="flex flex-col gap-3">
      {mc.milestoneTiming.map((t) => {
        const ps = Object.fromEntries(
          t.percentiles.map((p) => [Math.round(p.p * 100), toYear(p.month)]),
        );
        const p10 = ps[10] ?? ps[5] ?? null;
        const p90 = ps[90] ?? ps[95] ?? null;
        const p25 = ps[25] ?? null;
        const p75 = ps[75] ?? null;
        const p50 = ps[50] ?? null;
        const median = t.percentiles.find((p) => Math.abs(p.p - 0.5) < 1e-6)?.month ?? null;
        const variable = p10 !== null && p90 !== null && p90 - p10 > 0.05;
        return (
          <div
            key={t.milestoneId}
            className="grid grid-cols-[minmax(110px,160px)_1fr] items-center gap-3 sm:grid-cols-[180px_1fr_150px]"
          >
            <div className="min-w-0">
              <div className="truncate font-medium">{t.name ?? t.milestoneId}</div>
              <div className="text-[11.5px] text-ink-3">
                {f.percent(t.reachedShare, 0)} of trials
              </div>
            </div>
            <div className="relative h-6" aria-hidden>
              <div className="absolute top-1/2 h-px w-full bg-border" />
              {variable && p10 !== null && p90 !== null ? (
                <div
                  className="absolute top-1/2 h-[3px] -translate-y-1/2 rounded bg-accent/30"
                  style={{ left: pos(p10), width: `calc(${pos(p90)} - ${pos(p10)})` }}
                />
              ) : null}
              {variable && p25 !== null && p75 !== null ? (
                <div
                  className="absolute top-1/2 h-[9px] -translate-y-1/2 rounded-sm bg-accent/60"
                  style={{ left: pos(p25), width: `max(3px, calc(${pos(p75)} - ${pos(p25)}))` }}
                />
              ) : null}
              {p50 !== null ? (
                <div
                  className="absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-surface bg-accent"
                  style={{ left: pos(p50) }}
                />
              ) : null}
            </div>
            <div className="col-span-2 text-[12px] text-ink-2 sm:col-span-1 sm:text-right">
              {median ? (
                <>
                  median{" "}
                  <span className="num font-medium text-ink">{formatMonth(median, f.locale)}</span>
                  {variable && p10 !== null && p90 !== null ? (
                    <div className="num text-[11px] text-ink-3">
                      80% between {Math.floor(p10)}–{Math.floor(p90)}
                    </div>
                  ) : (
                    <div className="text-[11px] text-ink-3">fixed date</div>
                  )}
                </>
              ) : (
                "never reached"
              )}
            </div>
          </div>
        );
      })}
      <div className="grid grid-cols-[minmax(110px,160px)_1fr] gap-3 text-[10.5px] text-ink-3 sm:grid-cols-[180px_1fr_150px]">
        <span />
        <div className="flex justify-between">
          <span>{Math.floor(lo)}</span>
          <span>{Math.ceil(hi)}</span>
        </div>
      </div>
      <p className="text-[11.5px] text-ink-3">
        Dot = median; thick bar = middle 50% of trials; thin bar = middle 80%.
      </p>
    </div>
  );
}

export function SequenceRiskView({ mc }: { mc: MonteCarloResult }) {
  const f = useFormat();
  const sr = mc.sequenceRisk;
  if (!sr?.buckets.length)
    return (
      <EmptyState title="Sequence-of-returns breakdown not available">
        This run did not report early-return buckets.
      </EmptyState>
    );
  return (
    <div className="flex flex-col gap-2">
      <SeriesChart
        labels={sr.buckets.map((b, i) =>
          i === 0
            ? "Worst fifth"
            : i === sr.buckets.length - 1
              ? "Best fifth"
              : `${f.percent(b.fromReturn, 0)}…${f.percent(b.toReturn, 0)}`,
        )}
        format="percent"
        locale={f.locale}
        height={220}
        yMin={0}
        yMax={1}
        ariaLabel="Success rate by the real return of the first years of retirement"
        tooltipExtra={(i) => {
          const b = sr.buckets[i]!;
          return [
            tooltipRow(
              null,
              "Early real return",
              `${f.percent(b.fromReturn)} to ${f.percent(b.toReturn)}`,
            ),
            tooltipRow(null, "Trials", String(b.trials)),
            tooltipRow(null, "Median end net worth", f.money(b.medianEndNetWorthReal, true)),
          ].join("");
        }}
        series={[
          {
            name: "Success rate",
            color: (t) => slotColor(t.theme, 2),
            type: "bar",
            values: sr.buckets.map((b) => b.successRate),
          },
        ]}
      />
      <p className="text-[12px] text-ink-2">
        Trials grouped by the annualised real return of the first {sr.years} years from{" "}
        {sr.anchor === "retirement" ? "retirement" : "the plan start"}.
        {sr.rankCorrelation !== null && sr.rankCorrelation !== undefined
          ? ` Rank correlation with success: ${sr.rankCorrelation.toFixed(2)} — ${sr.rankCorrelation > 0.4 ? "the order of returns matters a lot for this plan" : sr.rankCorrelation > 0.2 ? "the order of returns matters somewhat for this plan" : "this plan is fairly robust to the order of returns"}.`
          : ""}
      </p>
    </div>
  );
}

export function TrialTable({
  mc,
  settings,
  filter,
  selected,
  onSelect,
}: {
  mc: MonteCarloResult;
  settings: MonteCarloSettings;
  filter: string | null;
  selected: number | null;
  onSelect: (trial: number) => void;
}) {
  const f = useFormat();
  const theme = useResolvedTheme();
  const cats = settings.outcomeCategories;
  const rows = useMemo(
    () =>
      [...mc.trialSummaries]
        .filter((t) => !filter || t.outcomeCategoryId === filter)
        .sort(
          (a, b) =>
            Number(a.success) - Number(b.success) ||
            (a.failureYear ?? a.firstShortfallYear ?? 0) -
              (b.failureYear ?? b.firstShortfallYear ?? 0) ||
            a.endNetWorthReal - b.endNetWorthReal,
        ),
    [mc, filter],
  );
  const historical = mc.method.startsWith("historical") || mc.method === "block-bootstrap";
  return (
    <div className="max-h-[360px] overflow-y-auto">
      <Table>
        <THead>
          <TR>
            <TH>Trial</TH>
            <TH>{historical ? "Start year" : "Seed"}</TH>
            <TH>Outcome</TH>
            <TH numeric>End net worth</TH>
            <TH numeric>Failed in</TH>
            <TH numeric>Early return</TH>
          </TR>
        </THead>
        <TBody>
          {rows.slice(0, 400).map((t) => {
            const i = cats.findIndex((c) => c.id === t.outcomeCategoryId);
            const cat = cats[i];
            return (
              <TR
                key={t.trial}
                className={cn("cursor-pointer", selected === t.trial && "bg-accent-soft/60")}
                onClick={() => onSelect(t.trial)}
              >
                <TD className="num">#{t.trial + 1}</TD>
                <TD className="num text-ink-2">
                  {historical ? (t.startYear ?? "—") : (t.seed ?? "—")}
                </TD>
                <TD>
                  <span className="inline-flex items-center gap-1.5">
                    <span
                      className="size-2 rounded-[2px]"
                      style={{
                        background: outcomeColor(
                          theme,
                          t.outcomeCategoryId,
                          cat?.kind ?? "success",
                          i,
                        ),
                      }}
                    />
                    {cat?.name ?? t.outcomeCategoryId}
                  </span>
                </TD>
                <TD numeric>{f.money(t.endNetWorthReal, true)}</TD>
                <TD numeric className={t.success ? "text-ink-3" : "text-negative"}>
                  {t.success ? "—" : (t.failureYear ?? t.firstShortfallYear ?? "—")}
                </TD>
                <TD numeric className="text-ink-2">
                  {t.earlyRealReturn !== null && t.earlyRealReturn !== undefined
                    ? f.percent(t.earlyRealReturn)
                    : "—"}
                </TD>
              </TR>
            );
          })}
        </TBody>
      </Table>
      {rows.length > 400 ? (
        <div className="px-3 py-2 text-[11.5px] text-ink-3">
          Showing 400 of {rows.length} trials.
        </div>
      ) : null}
    </div>
  );
}
