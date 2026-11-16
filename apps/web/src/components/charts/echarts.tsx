/**
 * Thin, typed ECharts wrapper: resize-aware, re-themed whenever the app theme or the chart
 * "patterns" preference changes. ECharts itself is loaded on demand (echarts-runtime.ts), so it
 * never lands in the initial bundle. Feature charts build options with baseOption().
 */
import type { ECharts, EChartsCoreOption } from "echarts/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { useResolvedTheme } from "../../lib/theme";
import { usePrefs } from "../../stores/prefs";
import { prefersReducedMotion, useChartPrefs } from "./chart-prefs";
import { type ChartTokens, readChartTokens } from "./tokens";

let runtime: Promise<typeof import("./echarts-runtime")> | null = null;
const loadRuntime = () => {
  runtime ??= import("./echarts-runtime");
  return runtime;
};

export type ChartOption = EChartsCoreOption;
export type ChartInstance = ECharts;
export interface ChartClick {
  dataIndex: number;
  seriesName?: string;
  seriesIndex?: number;
  name?: string;
  value?: unknown;
  data?: unknown;
  componentType?: string;
}

export function Chart({
  build,
  height = 320,
  className,
  onClick,
  onEvents,
  onReady,
  ariaLabel,
  merge = false,
}: {
  /** Build the option from theme tokens; called again when the theme changes. */
  build: (tokens: ChartTokens) => ChartOption;
  height?: number;
  className?: string;
  onClick?: (params: ChartClick) => void;
  /** Extra ECharts events (e.g. 'datazoom', 'legendselectchanged'). */
  onEvents?: Record<string, (params: unknown, chart: ChartInstance) => void>;
  onReady?: (chart: ChartInstance) => void;
  ariaLabel: string;
  /** Merge updates instead of replacing (keeps zoom state when only data changes). */
  merge?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const chart = useRef<ECharts | null>(null);
  const [ready, setReady] = useState(0);
  const theme = useResolvedTheme();
  const patterns = useChartPrefs((s) => s.patterns);
  const animation = usePrefs((s) => s.chartAnimation);
  const smooth = usePrefs((s) => s.smoothCurves);
  const option = useMemo(
    () =>
      applyChartPrefs(build(readChartTokens()), {
        animate: animation && !prefersReducedMotion(),
        smooth,
      }),
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- theme/patterns/prefs change must re-read tokens
    [build, theme, patterns, animation, smooth],
  );

  useEffect(() => {
    let disposed = false;
    let cleanup = () => {};
    loadRuntime().then(({ init }) => {
      if (disposed || !ref.current) return;
      const c = init(ref.current, undefined, { renderer: "canvas" });
      chart.current = c;
      const ro = new ResizeObserver(() => c.resize());
      ro.observe(ref.current);
      onReady?.(c);
      setReady((n) => n + 1);
      cleanup = () => {
        ro.disconnect();
        c.dispose();
        chart.current = null;
      };
    });
    return () => {
      disposed = true;
      cleanup();
    };
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- init once; onReady is read at mount
  }, []);

  useEffect(() => {
    chart.current?.setOption(
      option,
      merge ? { lazyUpdate: true } : { notMerge: true, lazyUpdate: true },
    );
  }, [option, merge, ready]);

  useEffect(() => {
    const c = chart.current;
    if (!c || !onClick) return;
    const handler = (p: unknown) => onClick(p as ChartClick);
    c.on("click", handler);
    return () => {
      c.off("click", handler);
    };
  }, [onClick, ready]);

  useEffect(() => {
    const c = chart.current;
    if (!c || !onEvents) return;
    const bound = Object.entries(onEvents).map(([name, fn]) => {
      const h = (p: unknown) => fn(p, c);
      c.on(name, h);
      return [name, h] as const;
    });
    return () => {
      for (const [name, h] of bound) c.off(name, h);
    };
  }, [onEvents, ready]);

  return (
    <div
      ref={ref}
      role="img"
      aria-label={ariaLabel}
      className={className}
      style={{ height, width: "100%" }}
    />
  );
}

/**
 * App-wide chart preferences (Settings → Appearance) applied on top of every chart's own option:
 * animation off (or reduced motion) and smoothed line curves. Series that set `smooth` explicitly
 * keep their choice.
 */
export function applyChartPrefs(
  option: ChartOption,
  prefs: { animate: boolean; smooth: boolean },
): ChartOption {
  const o = option as Record<string, unknown>;
  let out: Record<string, unknown> = o;
  if (!prefs.animate) out = { ...out, animation: false };
  if (prefs.smooth && Array.isArray(o.series))
    out = {
      ...out,
      series: (o.series as Record<string, unknown>[]).map((s) =>
        s && s.type === "line" && s.smooth === undefined ? { ...s, smooth: 0.25 } : s,
      ),
    };
  return out as ChartOption;
}
