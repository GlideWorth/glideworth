/**
 * The main projection chart: six modes, bar / area / line, today's or future money, a year or
 * per-person age axis, a timeline lane with milestone flags and life-event markers, zoom +
 * brush (slider and wheel/pinch), a full-breakdown tooltip, and click-anywhere-in-a-year to
 * drill down.
 */

import type { Plan, ProjectionResult, ValueBasis } from "@glideworth/core";
import { useCallback, useEffect, useRef } from "react";
import type { ChartKind, ProjectionMode } from "../../components/charts/chart-prefs";
import { Chart, type ChartInstance } from "../../components/charts/echarts";
import {
  axisStyle,
  baseOption,
  type ChartTokens,
  tooltipHeader,
  tooltipRow,
} from "../../components/charts/tokens";
import { formatMoney } from "../../lib/format";
import { total } from "../../lib/money";
import { isPartialPeriod, periodLabel, periodShortLabel, periodSpan } from "../../lib/period";
import {
  agesLabel,
  type EntityIndex,
  MODE_LABEL,
  modeSeries,
  periodAge,
  type TimelineEvent,
  timelineEvents,
} from "./model";

const FLAG = "path://M2,0 L2,24 L4,24 L4,13 L18,13 L14,7.5 L18,2 L4,2 L4,0 Z";

export interface ZoomRange {
  start: number;
  end: number;
}

export function ProjectionChart({
  result,
  basis,
  locale,
  currency,
  index,
  plan,
  mode = "netWorth",
  kind = "bar",
  axis = "year",
  height = 380,
  onSelectYear,
  selected,
  compact = false,
  legend,
  range,
  onRangeChange,
  annualise = false,
}: {
  result: ProjectionResult;
  basis: ValueBasis;
  locale: string;
  currency: string;
  index: EntityIndex;
  plan?: Plan | undefined;
  mode?: ProjectionMode;
  kind?: ChartKind;
  /** 'year' or a person id. */
  axis?: string;
  height?: number;
  onSelectYear?: (index: number) => void;
  selected?: number | null;
  compact?: boolean;
  /** Show the legend even in compact mode (print). */
  legend?: boolean;
  /** Controlled display range (period indexes, inclusive). */
  range?: ZoomRange | null;
  onRangeChange?: (r: ZoomRange) => void;
  /** Scale a partial first/last year's flows to a full year (balances are never scaled). */
  annualise?: boolean;
}) {
  const chartRef = useRef<ChartInstance | null>(null);
  const zoom = useRef<ZoomRange | null>(range ?? null);

  const build = useCallback(
    (t: ChartTokens) => {
      const P = result.periods;
      const ms = modeSeries(
        result,
        mode,
        basis,
        index,
        {
          theme: t.theme,
          surface: t.surface,
          ink: t.ink,
          negative: t.negative,
        },
        { annualise },
      );
      const money = (v: number) => formatMoney(v, { locale, currency, compact: true });
      const moneyFull = (v: number) => formatMoney(v, { locale, currency });
      const ax = axisStyle(t);
      const events = compact ? [] : timelineEvents(result, plan);
      const laneTop = 30;
      const mainTop = compact
        ? legend
          ? 30 + 18 * Math.floor(ms.series.length / 7)
          : 10
        : events.length
          ? 66
          : 34;
      const person = axis !== "year" ? index.people.find((p) => p.id === axis) : undefined;
      const xLabel = (i: number) => {
        const p = P[i];
        if (!p) return "";
        if (!person) return periodShortLabel(p);
        const age = periodAge(p, person.id);
        return age === null ? `${p.year}` : `${age}\n{yr|${p.year}}`;
      };
      const cats = P.map((_, i) => String(i));
      const z = zoom.current;
      const isStack = kind !== "line";

      const mainSeries = ms.series.map((s) => {
        const common = {
          name: s.name,
          id: s.id,
          xAxisIndex: 0,
          yAxisIndex: 0,
          emphasis: { focus: kind === "bar" ? ("none" as const) : ("series" as const) },
          data: s.values.map((v) => (Math.abs(v) < 0.005 ? 0 : v)),
          color: s.color,
        };
        if (kind === "bar")
          return {
            ...common,
            type: "bar",
            stack: "total",
            barGap: "-100%",
            barCategoryGap: P.length > 60 ? "12%" : "24%",
            itemStyle: {
              color: s.color,
              borderColor: t.surface,
              borderWidth: P.length > 40 ? 0 : 0.75,
              ...(s.hatch
                ? {
                    decal: {
                      symbol: "rect",
                      rotation: Math.PI / 4,
                      dashArrayX: [1, 0],
                      dashArrayY: [2, 3],
                      color: "rgba(255,255,255,0.35)",
                    },
                  }
                : {}),
            },
          };
        return {
          ...common,
          type: "line",
          stack: isStack ? (s.stack === "neg" ? "neg" : "pos") : undefined,
          symbol: "none",
          smooth: 0,
          lineStyle: {
            width: isStack ? 1 : 2,
            color: s.color,
            type: s.hatch && !isStack ? "dashed" : "solid",
          },
          areaStyle: isStack ? { color: s.color, opacity: s.hatch ? 0.45 : 0.82 } : undefined,
        };
      });

      const sel = selected ?? null;
      // Labelled markers (milestones, first shortfall) get their own lane when another label is
      // too close to fit beside it ("Financial independence" two years before "Retirement").
      const labelled = (e: TimelineEvent) => e.type === "milestone" || e.type === "shortfall";
      const gap = Math.max(3, Math.round(P.length * 0.12));
      const laneEnds: number[] = [];
      const labelLane = new Map<TimelineEvent, number>();
      for (const e of [...events].filter(labelled).sort((a, b) => a.periodIndex - b.periodIndex)) {
        let lane = laneEnds.findIndex((end) => e.periodIndex - end >= gap);
        if (lane < 0) lane = laneEnds.length;
        laneEnds[lane] = e.periodIndex;
        labelLane.set(e, lane);
      }
      const markers = events.map((e) => {
        const sameBefore = events.filter(
          (o) =>
            o.periodIndex === e.periodIndex &&
            !labelled(o) &&
            events.indexOf(o) < events.indexOf(e),
        ).length;
        return { e, y: labelLane.get(e) ?? sameBefore };
      });
      const maxStack = Math.max(1, ...markers.map((m) => m.y + 1));
      // 14 px per lane so stacked labels never sit on top of each other.
      const laneHeight = Math.max(26, 14 * maxStack + 6);
      const laneExtra = compact ? 0 : laneHeight - 26;
      const laneColor = (e: TimelineEvent) =>
        e.type === "milestone"
          ? t.ochre
          : e.type === "shortfall"
            ? t.negative
            : e.type === "early-withdrawal"
              ? t.warning
              : e.type === "expense"
                ? t.ink2
                : t.accent;
      const laneSymbol = (e: TimelineEvent) =>
        e.type === "milestone"
          ? FLAG
          : e.type === "income-start"
            ? "triangle"
            : e.type === "income-end"
              ? "triangle"
              : e.type === "expense"
                ? "diamond"
                : e.type === "shortfall"
                  ? "circle"
                  : "pin";

      const option = {
        ...baseOption(t),
        legend: {
          ...baseOption(t).legend,
          show: !compact || !!legend,
          ...(legend && compact ? { type: "plain" as const } : {}),
          data: [...ms.series.map((s) => s.name), ...(ms.line ? [ms.line.name] : [])],
        },
        grid: [
          {
            left: 8,
            right: 14,
            top: mainTop + laneExtra,
            bottom: compact ? 8 : 44,
            containLabel: true,
          },
          { left: 8, right: 14, top: laneTop, height: laneHeight, containLabel: true },
        ],
        tooltip: {
          ...baseOption(t).tooltip,
          trigger: "axis",
          axisPointer: {
            type: kind === "bar" ? "shadow" : "line",
            shadowStyle: { color: `${t.ink3}18` },
            lineStyle: { color: t.ink3 },
          },
          formatter: (params: unknown) => {
            const ps = (Array.isArray(params) ? params : [params]) as {
              dataIndex: number;
              seriesName: string;
              value: number;
              color: string;
              seriesType: string;
              seriesIndex: number;
            }[];
            const i = ps[0]?.dataIndex ?? 0;
            const p = P[i];
            if (!p) return "";
            const ages = agesLabel(p, index.people);
            const rows = ps
              .filter((x) => x.seriesIndex < ms.series.length && Math.abs(x.value) > 0.5)
              .sort((a, b) => b.value - a.value)
              .map((x) => tooltipRow(x.color, x.seriesName, moneyFull(x.value)));
            const line = ms.line
              ? tooltipRow(null, ms.line.name, moneyFull(ms.line.values[i] ?? 0), true)
              : "";
            const ev = events
              .filter((e) => e.periodIndex === i)
              .map((e) => `<div style="color:${laneColor(e)};font-size:11px">● ${e.label}</div>`)
              .join("");
            const status =
              p.status === "shortfall"
                ? `<div style="color:${t.negative};font-size:11px;margin-top:2px">Shortfall ${moneyFull(total(p, "shortfall", basis))}</div>`
                : "";
            const partial = isPartialPeriod(p)
              ? `<div style="color:${t.ochre};font-size:11px;margin-bottom:3px">${
                  annualise
                    ? `Partial year (${periodSpan(p)}): money moved is scaled to 12 months`
                    : `Partial year: ${periodSpan(p)} only (${p.months} months)`
                }</div>`
              : "";
            return `${tooltipHeader(periodLabel(p, { annualise }), ages)}${partial}${rows.join("")}<div style="border-top:1px solid ${t.border};margin:4px 0"></div>${line}${status}${ev}${onSelectYear ? `<div style="opacity:.55;font-size:10.5px;margin-top:4px">Click for the full year</div>` : ""}`;
          },
        },
        xAxis: [
          {
            type: "category",
            data: cats,
            gridIndex: 0,
            ...ax,
            splitLine: { show: false },
            axisLabel: {
              ...ax.axisLabel,
              formatter: (v: string) => xLabel(Number(v)),
              rich: { yr: { color: t.ink3, fontSize: 9.5, padding: [2, 0, 0, 0] } },
              hideOverlap: true,
            },
          },
          { type: "category", data: cats, gridIndex: 1, show: false },
        ],
        yAxis: [
          {
            type: "value",
            gridIndex: 0,
            ...ax,
            axisLabel: { ...ax.axisLabel, formatter: money },
            splitNumber: compact ? 3 : 5,
          },
          { type: "value", gridIndex: 1, show: false, min: -0.6, max: maxStack - 0.4 },
        ],
        dataZoom: compact
          ? []
          : [
              {
                type: "inside",
                xAxisIndex: [0, 1],
                ...(z ? { startValue: z.start, endValue: z.end } : {}),
                zoomOnMouseWheel: "shift",
                moveOnMouseWheel: false,
                moveOnMouseMove: true,
              },
              {
                type: "slider",
                xAxisIndex: [0, 1],
                height: 18,
                bottom: 6,
                ...(z ? { startValue: z.start, endValue: z.end } : {}),
                borderColor: t.border,
                backgroundColor: "transparent",
                fillerColor: `${t.accent}1f`,
                dataBackground: {
                  lineStyle: { color: t.ink3, opacity: 0.5 },
                  areaStyle: { color: t.ink3, opacity: 0.12 },
                },
                selectedDataBackground: {
                  lineStyle: { color: t.accent },
                  areaStyle: { color: t.accent, opacity: 0.2 },
                },
                handleStyle: { color: t.surface, borderColor: t.ink3 },
                moveHandleStyle: { color: t.ink3, opacity: 0.4 },
                textStyle: { color: t.ink3, fontSize: 10 },
                labelFormatter: (_v: number, s: string) => String(P[Number(s)]?.year ?? ""),
                brushSelect: true,
              },
            ],
        series: [
          ...mainSeries,
          ...(ms.line
            ? [
                {
                  name: ms.line.name,
                  type: "line",
                  xAxisIndex: 0,
                  yAxisIndex: 0,
                  smooth: 0.2,
                  symbol: "none",
                  z: 6,
                  lineStyle: { width: 2.25, color: t.ink },
                  itemStyle: { color: t.ink },
                  data: ms.line.values,
                  markLine: compact
                    ? undefined
                    : {
                        symbol: "none",
                        silent: true,
                        animation: false,
                        data: [
                          ...events
                            .filter((e) => e.type === "milestone")
                            .map((e) => ({
                              xAxis: String(e.periodIndex),
                              lineStyle: { color: t.ochre, type: "dashed", width: 1, opacity: 0.8 },
                              label: { show: false },
                            })),
                          ...(sel !== null
                            ? [
                                {
                                  xAxis: String(sel),
                                  lineStyle: { color: t.accent, type: "solid", width: 1.5 },
                                  label: { show: false },
                                },
                              ]
                            : []),
                        ],
                      },
                },
              ]
            : []),
          ...(events.length
            ? [
                {
                  name: "Timeline",
                  type: "scatter",
                  xAxisIndex: 1,
                  yAxisIndex: 1,
                  z: 10,
                  data: markers.map(({ e, y }) => ({
                    value: [String(e.periodIndex), y],
                    name: e.label,
                    symbol: laneSymbol(e),
                    symbolRotate: e.type === "income-end" ? 180 : 0,
                    symbolSize: e.type === "milestone" ? [11, 14] : 9,
                    symbolOffset: e.type === "milestone" ? [3, -2] : [0, 0],
                    itemStyle: { color: laneColor(e), borderColor: t.surface, borderWidth: 1 },
                    label: {
                      show: e.type === "milestone" || e.type === "shortfall",
                      // Near the right edge the label goes to the left of its flag, so it is not cut off.
                      position: e.periodIndex > P.length * 0.85 ? "left" : "right",
                      distance: 4,
                      color: t.ink2,
                      fontSize: 10.5,
                      formatter: e.label,
                    },
                    eventType: e.type,
                  })),
                  labelLayout: { hideOverlap: true },
                  tooltip: {
                    trigger: "item",
                    formatter: (x: { name: string; dataIndex: number }) => {
                      const ev = markers[x.dataIndex]?.e;
                      const p = ev ? P[ev.periodIndex] : undefined;
                      return `${tooltipHeader(x.name)}${p ? `<div style="opacity:.7">${p.year} · ${agesLabel(p, index.people)}</div>` : ""}`;
                    },
                  },
                },
              ]
            : []),
        ],
      };
      return option;
    },
    [
      result,
      basis,
      locale,
      currency,
      index,
      plan,
      mode,
      kind,
      axis,
      compact,
      legend,
      selected,
      onSelectYear,
      annualise,
    ],
  );

  // Programmatic range changes (presets) without rebuilding the option.
  useEffect(() => {
    if (!range || !chartRef.current) return;
    zoom.current = range;
    chartRef.current.dispatchAction({
      type: "dataZoom",
      startValue: range.start,
      endValue: range.end,
    });
  }, [range]);

  const onReady = useCallback((c: ChartInstance) => {
    chartRef.current = c;
    c.getZr().on("click", (e: { offsetX: number; offsetY: number }) => {
      const pt = [e.offsetX, e.offsetY];
      for (const gridIndex of [0, 1]) {
        if (!c.containPixel({ gridIndex }, pt)) continue;
        const [x] = c.convertFromPixel({ gridIndex }, pt) as number[];
        if (x !== undefined && Number.isFinite(x)) onSelectRef.current?.(Math.round(x));
        return;
      }
    });
  }, []);
  const onSelectRef = useRef(onSelectYear);
  onSelectRef.current = onSelectYear;
  const onRangeRef = useRef(onRangeChange);
  onRangeRef.current = onRangeChange;

  const onEvents = useRef({
    datazoom: (_: unknown, c: ChartInstance) => {
      const opt = c.getOption() as { dataZoom?: { startValue?: number; endValue?: number }[] };
      const dz = opt.dataZoom?.[0];
      if (dz?.startValue === undefined || dz.endValue === undefined) return;
      zoom.current = { start: dz.startValue, end: dz.endValue };
      onRangeRef.current?.(zoom.current);
    },
  }).current;

  return (
    <Chart
      build={build}
      height={height}
      onReady={onReady}
      onEvents={onEvents}
      ariaLabel={`${MODE_LABEL[mode]} projection by year, ${basis === "real" ? "in today's money" : "in future money"}. A table of the same data follows the chart.`}
    />
  );
}
