/**
 * The live projection beside the editor: net worth over time for the draft (solid) against the
 * last saved version (dashed), with the three numbers people watch while editing.
 */

import type { Plan, ProjectionResult, ValueBasis } from "@glideworth/core";
import { Link } from "@tanstack/react-router";
import { AlertTriangle, ArrowRight, Loader2 } from "lucide-react";
import { type ReactNode, useCallback, useState } from "react";
import { Chart } from "../../../components/charts/echarts";
import { axisStyle, baseOption, type ChartTokens } from "../../../components/charts/tokens";
import { cn } from "../../../lib/cn";
import { formatMoney } from "../../../lib/format";
import { total } from "../../../lib/money";
import { useFormat } from "../../../lib/workspace";
import { useUi } from "../../../stores/ui";
import { DismissDatasetNotice, isDatasetReplaced } from "../../results/dataset-notice";
import { editPlan } from "../state/doc-store";
import { type KeyMetrics, keyMetrics, usePreview } from "./use-live-projection";

function Delta({
  now,
  was,
  money,
}: {
  now: number | null | undefined;
  was: number | null | undefined;
  money: (v: number) => string;
}) {
  if (now == null || was == null) return null;
  const d = now - was;
  if (Math.abs(d) < 0.5) return <span className="text-ink-3">no change</span>;
  return (
    <span className={cn("num font-medium", d > 0 ? "text-positive" : "text-negative")}>
      {d > 0 ? "+" : "−"}
      {money(Math.abs(d))}
    </span>
  );
}

function Metric({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="min-w-0 rounded-lg border border-border bg-surface-2/40 px-3 py-2">
      <div className="eyebrow truncate">{label}</div>
      <div className="display num mt-0.5 truncate text-[19px] leading-tight font-semibold">
        {value}
      </div>
      <div className="mt-0.5 truncate text-[11.5px] text-ink-3">{sub}</div>
    </div>
  );
}

export function PreviewMetrics({
  plan,
  compact = false,
}: {
  plan: Plan | undefined;
  compact?: boolean;
}) {
  const { result, baseline } = usePreview();
  const basis = useUi((s) => s.basis);
  const f = useFormat();
  const now = keyMetrics(result, plan, basis);
  const was = keyMetrics(baseline, plan, basis);
  const money = (v: number) => f.money(v, true);
  const shortfall = (m: KeyMetrics | null) => (m ? (m.firstShortfallYear ?? null) : undefined);
  return (
    <div
      className={cn(
        "grid gap-2",
        compact
          ? "grid-cols-1 min-[520px]:grid-cols-3"
          : "grid-cols-1 sm:grid-cols-3 xl:grid-cols-1 2xl:grid-cols-3",
      )}
    >
      <Metric
        label="At retirement"
        value={now?.atRetirement ? money(now.atRetirement.value) : "—"}
        sub={
          now?.atRetirement ? (
            <>
              {now.atRetirement.year} ·{" "}
              <Delta now={now.atRetirement.value} was={was?.atRetirement?.value} money={money} />
            </>
          ) : (
            "No retirement milestone reached"
          )
        }
      />
      <Metric
        label="Final net worth"
        value={now?.final ? money(now.final.value) : "—"}
        sub={
          now?.final ? (
            <>
              {now.final.year} ·{" "}
              <Delta now={now.final.value} was={was?.final?.value} money={money} />
            </>
          ) : null
        }
      />
      <Metric
        label="First shortfall"
        value={
          now ? (
            now.firstShortfallYear ? (
              <span className="text-negative">{now.firstShortfallYear}</span>
            ) : (
              <span className="text-positive">None</span>
            )
          ) : (
            "—"
          )
        }
        sub={
          now && was && shortfall(now) !== shortfall(was)
            ? `was ${shortfall(was) ?? "none"}`
            : now?.firstShortfallYear
              ? `${money(now.totalShortfall)} unfunded in total`
              : "Every year fully funded"
        }
      />
    </div>
  );
}

export function PreviewChart({ height = 220, plan }: { height?: number; plan: Plan | undefined }) {
  const { result, baseline } = usePreview();
  const basis = useUi((s) => s.basis);
  const f = useFormat();
  const build = useCallback(
    (t: ChartTokens) => buildOption(t, result, baseline, basis, f.locale, f.currency, plan),
    [result, baseline, basis, f.locale, f.currency, plan],
  );
  if (!result)
    return <div style={{ height }} className="animate-pulse rounded-lg bg-surface-2/60" />;
  return (
    <Chart
      build={build}
      height={height}
      ariaLabel={`Net worth projection ${basis === "real" ? "in today's money" : "in future money"}, current draft versus last saved`}
    />
  );
}

function buildOption(
  t: ChartTokens,
  result: ProjectionResult | null,
  baseline: ProjectionResult | null,
  basis: ValueBasis,
  locale: string,
  currency: string,
  plan: Plan | undefined,
) {
  const periods = result?.periods ?? [];
  const years = periods.map((p) => p.year);
  const byYear = new Map(baseline?.periods.map((p) => [p.year, total(p, "netWorth", basis)]));
  const ax = axisStyle(t);
  const retireIds = new Set(
    plan?.milestones.filter((m) => m.kind === "retirement").map((m) => m.id),
  );
  const marks = (result?.milestones ?? []).filter(
    (m) =>
      m.status === "reached" &&
      m.periodIndex !== null &&
      m.periodIndex > 0 &&
      (retireIds.has(m.milestoneId) ||
        plan?.milestones.find((x) => x.id === m.milestoneId)?.showOnChart),
  );
  const differs =
    baseline &&
    periods.some((p) => Math.abs((byYear.get(p.year) ?? 0) - total(p, "netWorth", basis)) > 1);
  return {
    ...baseOption(t),
    animationDuration: 260,
    grid: { left: 4, right: 8, top: 14, bottom: 4, containLabel: true },
    legend: { show: false },
    tooltip: {
      ...baseOption(t).tooltip,
      axisPointer: { type: "line", lineStyle: { color: t.border } },
      valueFormatter: (v: unknown) =>
        typeof v === "number" ? formatMoney(v, { locale, currency }) : "—",
    },
    xAxis: {
      type: "category",
      data: years.map(String),
      boundaryGap: false,
      ...ax,
      splitLine: { show: false },
      axisLabel: {
        ...ax.axisLabel,
        interval: Math.max(0, Math.ceil(years.length / 6) - 1),
        hideOverlap: true,
      },
    },
    yAxis: {
      type: "value",
      ...ax,
      splitNumber: 3,
      axisLabel: {
        ...ax.axisLabel,
        formatter: (v: number) => formatMoney(v, { locale, currency, compact: true }),
      },
    },
    series: [
      {
        name: "Draft",
        type: "line",
        symbol: "none",
        smooth: 0.2,
        lineStyle: { width: 2, color: t.accent },
        itemStyle: { color: t.accent },
        areaStyle: {
          color: {
            type: "linear",
            x: 0,
            y: 0,
            x2: 0,
            y2: 1,
            colorStops: [
              { offset: 0, color: `${t.accent}33` },
              { offset: 1, color: `${t.accent}00` },
            ],
          },
        },
        data: periods.map((p) => total(p, "netWorth", basis)),
        markLine: {
          symbol: "none",
          silent: true,
          lineStyle: { color: t.ochre, type: "dashed", width: 1 },
          label: { color: t.ink3, fontSize: 10, position: "insideEndTop", formatter: "{b}" },
          data: marks.map((m) => ({
            name: m.name,
            xAxis: String(periods[m.periodIndex!]!.year),
            label: { show: retireIds.has(m.milestoneId) },
          })),
        },
      },
      ...(differs
        ? [
            {
              name: "Last saved",
              type: "line",
              symbol: "none",
              smooth: 0.2,
              lineStyle: { width: 1.25, color: t.ink3, type: "dashed" },
              itemStyle: { color: t.ink3 },
              data: periods.map((p) => byYear.get(p.year) ?? null),
            },
          ]
        : []),
      {
        name: "Shortfall",
        type: "scatter",
        symbolSize: 6,
        itemStyle: { color: t.negative },
        tooltip: { show: false },
        data: periods.map((p) => (p.totals.shortfall > 0.5 ? total(p, "netWorth", basis) : null)),
      },
    ],
  };
}

export function PreviewPanel({ plan, className }: { plan: Plan | undefined; className?: string }) {
  const { running, ms, error, invalid, result } = usePreview();
  const [showWarnings, setShowWarnings] = useState(false);
  const basis = useUi((s) => s.basis);
  const warnings = (result?.warnings ?? []).filter((w) => w.code !== "SHORTFALL");
  return (
    <section aria-label="Live projection" className={cn("flex flex-col gap-3", className)}>
      <div className="flex items-center justify-between gap-2">
        <div>
          <div className="eyebrow">Live projection</div>
          <div className="text-[11.5px] text-ink-3">
            {basis === "real" ? "Today's money" : "Future money"} · draft vs last saved
          </div>
        </div>
        <div className="flex items-center gap-1.5 text-[11.5px] text-ink-3" aria-live="polite">
          {invalid ? (
            <span className="text-warning">Paused: fix highlighted fields</span>
          ) : running ? (
            <>
              <Loader2 className="size-3 animate-spin" /> Simulating
            </>
          ) : ms !== null ? (
            <span className="num">Updated · {Math.max(1, Math.round(ms))} ms</span>
          ) : null}
        </div>
      </div>
      {error ? (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-lg border border-negative/30 bg-negative-soft px-3 py-2 text-[12px] text-negative"
        >
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}
      <PreviewChart plan={plan} />
      <div className="flex items-center gap-3 text-[11px] text-ink-3">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-0.5 w-3.5 rounded bg-accent" /> Draft
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-0 w-3.5 border-t border-dashed border-ink-3" /> Last saved
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="size-1.5 rounded-full bg-negative" /> Shortfall
        </span>
      </div>
      <PreviewMetrics plan={plan} />
      {warnings.length ? (
        <div className="rounded-lg border border-border">
          <button
            type="button"
            className="flex w-full items-center justify-between px-3 py-2 text-left text-[12px] pointer-coarse:min-h-11 text-ink-2 hover:bg-surface-2/60"
            aria-expanded={showWarnings}
            onClick={() => setShowWarnings((v) => !v)}
          >
            <span className="inline-flex items-center gap-1.5">
              <AlertTriangle className="size-3.5 text-warning" />
              {warnings.length} {warnings.length === 1 ? "note" : "notes"} from the engine
            </span>
            <span className="text-ink-3">{showWarnings ? "Hide" : "Show"}</span>
          </button>
          {showWarnings ? (
            <ul className="max-h-48 overflow-y-auto border-t border-border px-3 py-2 text-[11.5px] text-ink-2">
              {warnings.slice(0, 30).map((w, i) => (
                // oxlint-disable-next-line react/no-array-index-key -- warnings have no ids
                <li key={i} className="py-0.5">
                  {w.message}
                  {plan && isDatasetReplaced(w) ? (
                    <DismissDatasetNotice
                      plan={plan}
                      className="ml-2"
                      save={(next) =>
                        editPlan(
                          plan.id,
                          (p) => ({ ...p, monteCarlo: next.monteCarlo }),
                          "Dismiss the replaced-dataset notice",
                        )
                      }
                    />
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      <Link
        to="/results"
        className="inline-flex items-center gap-1 self-start text-[12px] font-medium text-accent hover:underline"
      >
        Full results <ArrowRight className="size-3.5" />
      </Link>
    </section>
  );
}
