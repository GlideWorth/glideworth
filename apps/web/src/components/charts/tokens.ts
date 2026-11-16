/** Reads design tokens (CSS variables) so charts match the active theme exactly. */
import { prefersReducedMotion, useChartPrefs } from "./chart-prefs";
import { SERIES, STONE, type ThemeName } from "./palette";

export interface ChartTokens {
  theme: ThemeName;
  /** Validated categorical slots for this theme (see palette.ts). */
  palette: string[];
  stone: string;
  ink: string;
  ink2: string;
  ink3: string;
  grid: string;
  border: string;
  surface: string;
  surface2: string;
  bg: string;
  accent: string;
  negative: string;
  positive: string;
  warning: string;
  ochre: string;
  fontSans: string;
  reducedMotion: boolean;
  patterns: boolean;
}

export function readChartTokens(el: Element = document.documentElement): ChartTokens {
  const cs = getComputedStyle(el);
  const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  const theme: ThemeName = (el as HTMLElement).dataset?.theme === "dark" ? "dark" : "light";
  return {
    theme,
    palette: [...SERIES[theme]],
    stone: STONE[theme],
    ink: v("--ink", "#1c2320"),
    ink2: v("--ink-2", "#48514c"),
    ink3: v("--ink-3", "#7a817b"),
    grid: v("--chart-grid", "#e4e0d6"),
    border: v("--border", "#e0dbcf"),
    surface: v("--surface", "#fbfaf6"),
    surface2: v("--surface-2", "#eeebe3"),
    bg: v("--bg", "#f3f1eb"),
    accent: v("--accent", "#2c5a4d"),
    negative: v("--negative", "#b0452e"),
    positive: v("--positive", "#3a7650"),
    warning: v("--warning", "#a97a1c"),
    ochre: v("--ochre", "#b0742a"),
    fontSans: '"Inter Variable", ui-sans-serif, system-ui, sans-serif',
    reducedMotion: prefersReducedMotion(),
    patterns: useChartPrefs.getState().patterns,
  };
}

/** Option fragments shared by every Glideworth chart. */
export function baseOption(t: ChartTokens) {
  return {
    color: t.palette,
    backgroundColor: "transparent",
    textStyle: { fontFamily: t.fontSans, color: t.ink2, fontSize: 11.5 },
    animation: !t.reducedMotion,
    animationDuration: 380,
    animationDurationUpdate: 260,
    animationEasing: "cubicOut" as const,
    aria: { enabled: true, decal: { show: t.patterns } },
    grid: { left: 8, right: 12, top: 28, bottom: 8, containLabel: true },
    tooltip: {
      trigger: "axis" as const,
      confine: true,
      backgroundColor: t.surface,
      borderColor: t.border,
      borderWidth: 1,
      padding: [8, 10],
      textStyle: { color: t.ink, fontSize: 12, fontFamily: t.fontSans },
      extraCssText:
        "box-shadow: var(--shadow-pop); border-radius: 8px; font-variant-numeric: tabular-nums; max-width: 340px;",
      axisPointer: { type: "shadow" as const, shadowStyle: { color: `${t.ink3}14` } },
    },
    legend: {
      top: 0,
      left: 0,
      type: "scroll" as const,
      icon: "roundRect",
      itemWidth: 10,
      itemHeight: 10,
      itemGap: 14,
      textStyle: { color: t.ink2, fontSize: 11.5 },
      pageIconColor: t.ink2,
      pageTextStyle: { color: t.ink3 },
    },
  };
}

export function axisStyle(t: ChartTokens) {
  return {
    axisLine: { lineStyle: { color: t.border } },
    axisTick: { show: false },
    axisLabel: { color: t.ink3, fontSize: 11 },
    splitLine: { lineStyle: { color: t.grid } },
  };
}

/** HTML for one tooltip row: swatch, label, right-aligned value (text stays in ink tokens). */
export function tooltipRow(
  color: string | null,
  label: string,
  value: string,
  strong = false,
): string {
  const sw = color
    ? `<span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${color};margin-right:6px"></span>`
    : '<span style="display:inline-block;width:14px"></span>';
  return `<div style="display:flex;justify-content:space-between;gap:16px;line-height:1.55;${strong ? "font-weight:600" : ""}"><span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${sw}${escapeHtml(label)}</span><span>${value}</span></div>`;
}

export function tooltipHeader(title: string, sub?: string): string {
  return `<div style="font-weight:600;margin-bottom:4px">${escapeHtml(title)}${sub ? `<span style="font-weight:400;opacity:.65;margin-left:6px">${escapeHtml(sub)}</span>` : ""}</div>`;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
