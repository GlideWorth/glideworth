/**
 * Generic time-series chart (bars / lines / areas) used by most analysis views. The x-axis is
 * categories, one slot per point, unless `xValues` gives a coordinate per point — then it is a
 * linear scale. One y axis only (never dual-axis): money OR percent OR plain numbers.
 */
import { useCallback, useRef } from "react";
import { formatMoney, formatNumber, formatPercent } from "../../lib/format";
import { Chart, type ChartInstance } from "./echarts";
import { axisStyle, baseOption, type ChartTokens, tooltipHeader, tooltipRow } from "./tokens";

export interface TimeSeries {
  name: string;
  /** A colour, or a function of tokens (so semantic colours follow the theme). */
  color: string | ((t: ChartTokens) => string);
  values: (number | null)[];
  type?: "bar" | "line" | "area";
  stack?: string;
  dashed?: boolean;
  width?: number;
  hatch?: boolean;
  /** Hide from tooltip (bands, helpers). */
  silent?: boolean;
  /** For band areas: draw between this series (stacked) — use with stack + transparent base. */
  transparent?: boolean;
  z?: number;
  symbol?: boolean;
}

export interface SeriesChartProps {
  labels: string[];
  series: TimeSeries[];
  format: "money" | "percent" | "number";
  locale: string;
  currency?: string;
  height?: number;
  ariaLabel: string;
  onClickIndex?: (i: number) => void;
  /**
   * Numeric x coordinate for each label and series value. Plots on a linear axis instead of
   * one equal-width category per point, so unevenly spaced samples (a solver search clustering
   * on the answer) keep their real spacing. Ticks are the axis's own evenly spaced values.
   */
  xValues?: number[];
  /** Tick text for a linear x-axis. Defaults to the number itself. */
  formatX?: (value: number) => string;
  /** Vertical markers at label indexes. */
  markers?: { index: number; label: string; tone?: "accent" | "ochre" | "negative" | "ink" }[];
  /** Horizontal reference lines. */
  refLines?: { value: number; label: string }[];
  /** Extra tooltip lines per index. */
  tooltipExtra?: (i: number) => string;
  tooltipTitle?: (i: number) => string;
  legend?: boolean;
  zoom?: boolean;
  yMin?: number;
  yMax?: number;
  stepX?: boolean;
}

/** Y of a category point (a number) or a linear point (`[x, y]`). */
function yValue(v: unknown): number | null {
  const raw = Array.isArray(v) ? v[v.length - 1] : v;
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

export function SeriesChart(props: SeriesChartProps) {
  const {
    labels,
    series,
    format,
    locale,
    currency = "USD",
    height = 280,
    ariaLabel,
    onClickIndex,
    xValues,
    formatX,
    markers,
    refLines,
    tooltipExtra,
    tooltipTitle,
    legend = true,
    zoom = false,
    yMin,
    yMax,
  } = props;
  const build = useCallback(
    (t: ChartTokens) => {
      const fmt = (v: number, compact = true) =>
        format === "money"
          ? formatMoney(v, { locale, currency, compact })
          : format === "percent"
            ? formatPercent(v, locale, compact ? 0 : 1)
            : formatNumber(v, locale, compact ? 0 : 1);
      const ax = axisStyle(t);
      const col = (s: TimeSeries) => (typeof s.color === "function" ? s.color(t) : s.color);
      const tone = (x?: string) =>
        x === "accent" ? t.accent : x === "negative" ? t.negative : x === "ink" ? t.ink : t.ochre;
      const hasBar = series.some((s) => (s.type ?? "line") === "bar");
      return {
        ...baseOption(t),
        legend: {
          ...baseOption(t).legend,
          show: legend && series.filter((s) => !s.silent).length > 1,
          data: series.filter((s) => !s.silent).map((s) => s.name),
        },
        grid: {
          ...baseOption(t).grid,
          top: legend && series.filter((s) => !s.silent).length > 1 ? 34 : 14,
          bottom: zoom ? 40 : 8,
        },
        tooltip: {
          ...baseOption(t).tooltip,
          axisPointer: hasBar
            ? { type: "shadow", shadowStyle: { color: `${t.ink3}18` } }
            : { type: "line", lineStyle: { color: t.ink3 } },
          formatter: (params: unknown) => {
            const ps = (Array.isArray(params) ? params : [params]) as {
              dataIndex: number;
              seriesIndex: number;
              value: number | null;
              color: string;
            }[];
            const i = ps[0]?.dataIndex ?? 0;
            const rows = ps
              .filter((p) => !series[p.seriesIndex]?.silent && yValue(p.value) !== null)
              .map((p) =>
                tooltipRow(
                  col(series[p.seriesIndex]!),
                  series[p.seriesIndex]!.name,
                  fmt(yValue(p.value)!, false),
                ),
              );
            return `${tooltipHeader(tooltipTitle ? tooltipTitle(i) : (labels[i] ?? ""))}${rows.join("")}${tooltipExtra ? tooltipExtra(i) : ""}`;
          },
        },
        xAxis: xValues
          ? {
              type: "value",
              ...ax,
              // Pin the scale to the samples. A category axis would give every sample the same
              // width and a tick per sample, repeating labels where the search clusters.
              min: (v: { min: number; max: number }) => (v.max === v.min ? v.min - 1 : v.min),
              max: (v: { min: number; max: number }) => (v.max === v.min ? v.max + 1 : v.max),
              splitLine: { show: false },
              axisLabel: {
                ...ax.axisLabel,
                hideOverlap: true,
                formatter: (v: number) => (formatX ? formatX(v) : String(v)),
              },
            }
          : {
              type: "category",
              data: labels,
              boundaryGap: hasBar,
              ...ax,
              splitLine: { show: false },
              axisLabel: { ...ax.axisLabel, hideOverlap: true },
            },
        yAxis: {
          type: "value",
          ...ax,
          ...(yMin !== undefined ? { min: yMin } : {}),
          ...(yMax !== undefined ? { max: yMax } : {}),
          axisLabel: { ...ax.axisLabel, formatter: (v: number) => fmt(v) },
        },
        dataZoom: zoom
          ? [
              { type: "inside", zoomOnMouseWheel: "shift", moveOnMouseWheel: false },
              {
                type: "slider",
                height: 16,
                bottom: 6,
                borderColor: t.border,
                fillerColor: `${t.accent}1f`,
                textStyle: { color: t.ink3, fontSize: 10 },
                handleStyle: { color: t.surface, borderColor: t.ink3 },
              },
            ]
          : [],
        series: series.map((s, si) => {
          const c = col(s);
          const type = s.type ?? "line";
          const base = {
            name: s.name,
            data: xValues ? s.values.map((y, i) => [xValues[i], y]) : s.values,
            z: s.z ?? 2,
            silent: s.silent ?? false,
            emphasis: { focus: s.silent ? "none" : "series" },
            ...(si === 0 && (markers?.length || refLines?.length)
              ? {
                  markLine: {
                    symbol: "none",
                    silent: true,
                    animation: false,
                    data: [
                      ...(markers ?? []).map((m) => ({
                        xAxis: xValues ? xValues[m.index] : labels[m.index],
                        lineStyle: { color: tone(m.tone), type: "dashed", width: 1 },
                        label: {
                          formatter: m.label,
                          color: t.ink2,
                          fontSize: 10.5,
                          position: "insideEndTop",
                        },
                      })),
                      ...(refLines ?? []).map((r) => ({
                        yAxis: r.value,
                        lineStyle: { color: t.ink3, type: "dotted", width: 1 },
                        label: {
                          formatter: r.label,
                          color: t.ink3,
                          fontSize: 10.5,
                          position: "insideEndTop",
                        },
                      })),
                    ],
                  },
                }
              : {}),
          };
          if (type === "bar")
            return {
              ...base,
              type: "bar",
              stack: s.stack,
              barCategoryGap: labels.length > 60 ? "12%" : "26%",
              itemStyle: {
                color: c,
                borderColor: t.surface,
                borderWidth: labels.length > 40 ? 0 : 0.75,
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
            ...base,
            type: "line",
            stack: s.stack,
            step: props.stepX ? "middle" : undefined,
            symbol: s.symbol ? "circle" : "none",
            symbolSize: 6,
            showSymbol: !!s.symbol,
            // Endpoint symbols sit on the axis min/max; don't clip them.
            clip: xValues ? false : undefined,
            connectNulls: false,
            lineStyle: {
              width: s.transparent ? 0 : (s.width ?? 2),
              color: c,
              type: s.dashed ? "dashed" : "solid",
            },
            itemStyle: { color: c },
            areaStyle:
              type === "area"
                ? {
                    color: s.transparent ? "transparent" : c,
                    opacity: s.transparent ? 0 : s.stack ? 0.85 : 0.18,
                  }
                : undefined,
          };
        }),
      };
    },
    [
      labels,
      series,
      format,
      locale,
      currency,
      xValues,
      formatX,
      markers,
      refLines,
      tooltipExtra,
      tooltipTitle,
      legend,
      zoom,
      yMin,
      yMax,
      props.stepX,
    ],
  );
  const clickRef = useRef(onClickIndex);
  clickRef.current = onClickIndex;
  const xValuesRef = useRef(xValues);
  xValuesRef.current = xValues;
  const onReady = useCallback((c: ChartInstance) => {
    c.getZr().on("click", (e: { offsetX: number; offsetY: number }) => {
      const pt = [e.offsetX, e.offsetY];
      if (!c.containPixel({ gridIndex: 0 }, pt)) return;
      const [x] = c.convertFromPixel({ gridIndex: 0 }, pt) as number[];
      if (x === undefined || !Number.isFinite(x)) return;
      const xs = xValuesRef.current;
      if (!xs?.length) {
        clickRef.current?.(Math.round(x));
        return;
      }
      let best = 0;
      let bestD = Infinity;
      for (let i = 0; i < xs.length; i++) {
        const d = Math.abs(xs[i]! - x);
        if (d < bestD) {
          best = i;
          bestD = d;
        }
      }
      clickRef.current?.(best);
    });
  }, []);
  return <Chart build={build} height={height} ariaLabel={ariaLabel} onReady={onReady} />;
}
