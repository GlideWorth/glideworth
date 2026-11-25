/**
 * Hand-written SVG charts (no chart library: the widget ships as one small file). Every chart is scrubbable with
 * a pointer, touch or the arrow keys, and carries an aria-label summary.
 */
import {
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

const DEFAULT_WIDTH = 340;

function useWidth<T extends HTMLElement>(): [RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => {
      const next = Math.round(element.getBoundingClientRect().width);
      if (next > 0) setWidth(next);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

/** Three to five round tick values; the first is at or below `min`, the last at or above `max`. */
function niceTicks(min: number, max: number, target = 3): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0];
  if (max - min < 1e-9) return [min];
  const rough = (max - min) / target;
  const power = 10 ** Math.floor(Math.log10(rough));
  const step = ([1, 2, 2.5, 5, 10].find((m) => m * power >= rough) ?? 10) * power;
  const ticks: number[] = [];
  // Extend to whole steps on both sides, so the top and bottom of the plot are labelled.
  const last = Math.ceil(max / step - 1e-9) * step;
  for (let v = Math.floor(min / step + 1e-9) * step; v <= last + step * 1e-6; v += step)
    ticks.push(Math.abs(v) < step * 1e-6 ? 0 : v);
  return ticks;
}

/** Which data index a pointer at clientX is over. */
function indexAt(
  event: PointerEvent<HTMLDivElement>,
  count: number,
  left: number,
  right: number,
  width: number,
): number {
  const rect = event.currentTarget.getBoundingClientRect();
  const scale = rect.width > 0 ? width / rect.width : 1;
  const x = (event.clientX - rect.left) * scale;
  const t = (x - left) / Math.max(1, width - left - right);
  return Math.max(0, Math.min(count - 1, Math.round(t * (count - 1))));
}

function useScrub(count: number, onSelect: (index: number) => void, selected: number | null) {
  const dragging = useRef(false);
  return {
    onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
      const current = selected ?? count - 1;
      const keys: Record<string, number> = {
        ArrowLeft: Math.max(0, current - 1),
        ArrowRight: Math.min(count - 1, current + 1),
        Home: 0,
        End: count - 1,
      };
      const next = keys[event.key];
      if (next === undefined) return;
      event.preventDefault();
      onSelect(next);
    },
    start(event: PointerEvent<HTMLDivElement>, pick: (e: PointerEvent<HTMLDivElement>) => number) {
      dragging.current = true;
      event.currentTarget.setPointerCapture?.(event.pointerId);
      onSelect(pick(event));
    },
    move(event: PointerEvent<HTMLDivElement>, pick: (e: PointerEvent<HTMLDivElement>) => number) {
      if (dragging.current || event.pointerType === "mouse") onSelect(pick(event));
    },
    end() {
      dragging.current = false;
    },
  };
}

/**
 * The interactive layer over a chart: a slider over the years (pointer, touch, arrow keys). The SVG under it
 * stays a labelled image.
 */
function Scrubber(props: {
  years: readonly number[];
  selected: number | null;
  scrub: ReturnType<typeof useScrub>;
  pick(event: PointerEvent<HTMLDivElement>): number;
  valueText?: (index: number) => string;
}) {
  const { years, selected, scrub, pick } = props;
  const index = selected ?? years.length - 1;
  return (
    <div
      className="scrub"
      role="slider"
      tabIndex={0}
      aria-label="Year"
      aria-valuemin={years[0]}
      aria-valuemax={years[years.length - 1]}
      aria-valuenow={years[index]}
      aria-valuetext={props.valueText ? props.valueText(index) : String(years[index])}
      onKeyDown={scrub.onKeyDown}
      onPointerDown={(e) => scrub.start(e, pick)}
      onPointerMove={(e) => scrub.move(e, pick)}
      onPointerUp={scrub.end}
      onPointerCancel={scrub.end}
    />
  );
}

interface Series {
  key: string;
  label: string;
  values: readonly number[];
  color: string;
  dashed?: boolean;
}

interface YearMark {
  year: number;
  label: string;
}

/** A full-height labelled line: the retirement year, or the year the plan (or the bad case) runs short. */
export interface Guide extends YearMark {
  tone: "neutral" | "alert";
}

const CHAR_W = 5.9;
const ROW_H = 13;
const textWidth = (text: string) => text.length * CHAR_W + 6;

/** Width of the left gutter that holds the y-axis labels, so they never sit under the data. */
function gutterFor(ticks: readonly number[], formatAxis: (v: number) => string): number {
  // Labels end 5px left of the plot (YAxis), so the gutter holds the widest label plus that gap and 2px spare.
  return Math.ceil(Math.max(24, ...ticks.map((t) => textWidth(formatAxis(t))))) + 7;
}

interface PlacedLabel {
  x: number;
  left: number;
  right: number;
  row: number;
  guide: Guide;
}

/**
 * Lays guide labels out along the top in rows, so none overlap: each label takes the first row where it fits,
 * clamped inside the plot.
 */
function placeLabels(
  guides: readonly Guide[],
  xOf: (year: number) => number | null,
  minX: number,
  maxX: number,
) {
  const placed: PlacedLabel[] = [];
  const ordered = [...guides].sort((a, b) => a.year - b.year);
  for (const guide of ordered) {
    const gx = xOf(guide.year);
    if (gx === null) continue;
    const w = textWidth(guide.label);
    const left = Math.max(minX, Math.min(maxX - w, gx - w / 2));
    let row = 0;
    while (placed.some((p) => p.row === row && left < p.right + 6 && left + w > p.left - 6)) row++;
    placed.push({ x: gx, left, right: left + w, row, guide });
  }
  return placed;
}

function XAxisLabels(props: {
  count: number;
  x(i: number): number;
  years: readonly number[];
  y: number;
  innerW: number;
}) {
  const { count: n, x, years } = props;
  const slots = Math.max(1, Math.min(4, Math.floor(props.innerW / 80)));
  const xLabels = new Set<number>([0, n - 1]);
  for (let s = 1; s < slots; s++) xLabels.add(Math.round((s / slots) * (n - 1)));
  return (
    <>
      {[...xLabels].map((i) => (
        <text
          key={`x${i}`}
          x={x(i)}
          y={props.y}
          textAnchor={i === 0 ? "start" : i === n - 1 ? "end" : "middle"}
          className="axis-label"
        >
          {years[i]}
        </text>
      ))}
    </>
  );
}

function YAxis(props: {
  ticks: readonly number[];
  y(v: number): number;
  gutter: number;
  right: number;
  formatAxis(v: number): string;
}) {
  return (
    <>
      {props.ticks.map((t) => (
        <g key={t}>
          <line
            x1={props.gutter}
            x2={props.right}
            y1={props.y(t)}
            y2={props.y(t)}
            className={t === 0 ? "zero-line" : "grid-line"}
          />
          <text x={props.gutter - 5} y={props.y(t) + 3.5} textAnchor="end" className="axis-label">
            {props.formatAxis(t)}
          </text>
        </g>
      ))}
    </>
  );
}

interface TimeChartProps {
  years: readonly number[];
  lines: readonly Series[];
  band?: { lo: readonly number[]; hi: readonly number[] } | null;
  /** Full-height labelled lines (retirement, runs short). */
  guides?: readonly Guide[];
  /** Other milestones: small ticks on the x axis, named in the readout. */
  ticks?: readonly YearMark[];
  selected: number | null;
  onSelect(index: number): void;
  formatAxis(value: number): string;
  height?: number;
  label: string;
  /** Dims the chart while a new result loads. */
  dim?: boolean;
  /** What a screen reader hears for the year under the scrubber. */
  valueText?: (index: number) => string;
}

const PAD = { top: 8, right: 8, bottom: 22 };

export function TimeChart(props: TimeChartProps) {
  const { years, lines, band, guides = [], selected, onSelect, formatAxis } = props;
  const minor = props.ticks ?? [];
  const [wrapRef, width] = useWidth<HTMLDivElement>();
  const scrub = useScrub(years.length, onSelect, selected);
  const n = years.length;
  if (n < 2) return null;

  const all = [...lines.flatMap((l) => l.values), ...(band ? [...band.lo, ...band.hi] : [])].filter(
    Number.isFinite,
  );
  const rawMin = Math.min(0, ...all);
  const rawMax = Math.max(0, ...all);
  const ticks = niceTicks(rawMin, rawMax === rawMin ? rawMin + 1 : rawMax);
  const yMin = Math.min(rawMin, ticks[0] ?? 0);
  const yMax = Math.max(rawMax, ticks[ticks.length - 1] ?? 1) || 1;
  const gutter = gutterFor(ticks, formatAxis);
  const right = width - PAD.right;
  const innerW = right - gutter;
  const x = (i: number) => gutter + (i / (n - 1)) * innerW;
  const xOfYear = (year: number) => {
    const i = years.indexOf(year);
    return i < 0 ? null : x(i);
  };
  const labels = placeLabels(guides, xOfYear, gutter, right);
  const rows = labels.length ? Math.max(...labels.map((l) => l.row)) + 1 : 0;
  const top = PAD.top + rows * ROW_H;
  const height = (props.height ?? 176) + rows * ROW_H;
  const bottom = height - PAD.bottom;
  const y = (v: number) => top + (1 - (v - yMin) / (yMax - yMin || 1)) * (bottom - top);
  const path = (values: readonly number[]) =>
    values.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
  const area = band
    ? `${path(band.hi)}${band.lo
        .map((v, i) => [i, v] as const)
        .reverse()
        .map(([i, v]) => `L${x(i).toFixed(1)},${y(v).toFixed(1)}`)
        .join("")}Z`
    : null;
  const pick = (event: PointerEvent<HTMLDivElement>) => indexAt(event, n, gutter, PAD.right, width);

  return (
    <div ref={wrapRef} className={`chart${props.dim ? " is-dim" : ""}`}>
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={props.label}
      >
        <YAxis ticks={ticks} y={y} gutter={gutter} right={right} formatAxis={formatAxis} />
        {area ? <path d={area} className="band" /> : null}
        {labels.map((l) => (
          <line
            key={`g${l.guide.year}${l.guide.label}`}
            x1={l.x}
            x2={l.x}
            y1={PAD.top + l.row * ROW_H + 12}
            y2={bottom}
            className={l.guide.tone === "alert" ? "alert-line" : "marker-line"}
          />
        ))}
        {labels.map((l) => (
          <text
            key={`t${l.guide.year}${l.guide.label}`}
            x={l.left + 3}
            y={PAD.top + l.row * ROW_H + 9}
            className={l.guide.tone === "alert" ? "marker-label is-alert" : "marker-label"}
          >
            {l.guide.label}
          </text>
        ))}
        {lines.map((l) => (
          <path
            key={l.key}
            d={path(l.values)}
            className="series"
            stroke={l.color}
            strokeDasharray={l.dashed ? "5 4" : undefined}
          />
        ))}
        {minor.map((m) => {
          const mx = xOfYear(m.year);
          return mx === null ? null : (
            <line
              key={`t${m.year}${m.label}`}
              x1={mx}
              x2={mx}
              y1={bottom - 5}
              y2={bottom + 2}
              className="tick-mark"
            />
          );
        })}
        <XAxisLabels count={n} x={x} years={years} y={height - 6} innerW={innerW} />
        {selected !== null && selected < n ? (
          <g className="cursor">
            <line x1={x(selected)} x2={x(selected)} y1={top} y2={bottom} className="cursor-line" />
            {band ? (
              <>
                <circle
                  cx={x(selected)}
                  cy={y(band.hi[selected] ?? 0)}
                  r={2.5}
                  className="band-dot"
                />
                <circle
                  cx={x(selected)}
                  cy={y(band.lo[selected] ?? 0)}
                  r={2.5}
                  className="band-dot"
                />
              </>
            ) : null}
            {lines.map((l) => (
              <circle
                key={l.key}
                cx={x(selected)}
                cy={y(l.values[selected] ?? 0)}
                r={4}
                fill={l.color}
                className="cursor-dot"
              />
            ))}
          </g>
        ) : null}
      </svg>
      <Scrubber
        years={years}
        selected={selected}
        scrub={scrub}
        pick={pick}
        valueText={props.valueText}
      />
    </div>
  );
}

interface StackKind {
  key: string;
  label: string;
  values: readonly number[];
  color: string;
}

interface StackedBarsProps {
  years: readonly number[];
  kinds: readonly StackKind[];
  marker?: YearMark | null;
  selected: number | null;
  onSelect(index: number): void;
  formatAxis(value: number): string;
  height?: number;
  label: string;
  valueText?: (index: number) => string;
}

export function StackedBars(props: StackedBarsProps) {
  const { years, kinds, marker, selected, onSelect, formatAxis } = props;
  const [wrapRef, width] = useWidth<HTMLDivElement>();
  const scrub = useScrub(years.length, onSelect, selected);
  const n = years.length;
  if (n < 1) return null;
  const totals = years.map((_, i) => kinds.reduce((s, k) => s + Math.max(0, k.values[i] ?? 0), 0));
  const ticks = niceTicks(0, Math.max(1, ...totals));
  const yMax = Math.max(1, ...totals, ticks[ticks.length - 1] ?? 1);
  const gutter = gutterFor(ticks, formatAxis);
  const right = width - PAD.right;
  const innerW = right - gutter;
  const top = PAD.top + (marker ? ROW_H : 0);
  const height = (props.height ?? 168) + (marker ? ROW_H : 0);
  const bottom = height - PAD.bottom;
  const slot = innerW / n;
  const gap = slot > 6 ? Math.min(3, slot * 0.2) : 0.5;
  const barW = Math.max(1, slot - gap);
  const xs = (i: number) => gutter + i * slot + gap / 2;
  const y = (v: number) => top + (1 - v / yMax) * (bottom - top);
  const pick = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const scale = rect.width > 0 ? width / rect.width : 1;
    const px = (event.clientX - rect.left) * scale - gutter;
    return Math.max(0, Math.min(n - 1, Math.floor(px / slot)));
  };
  const markerX =
    marker && years.indexOf(marker.year) >= 0 ? xs(years.indexOf(marker.year)) - gap / 2 : null;
  const labels =
    marker && markerX !== null
      ? placeLabels([{ ...marker, tone: "neutral" }], () => markerX, gutter, right)
      : [];

  return (
    <div ref={wrapRef} className="chart">
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={props.label}
      >
        <YAxis ticks={ticks} y={y} gutter={gutter} right={right} formatAxis={formatAxis} />
        {years.map((year, i) => {
          let base = 0;
          return (
            <g key={year} opacity={selected === null || selected === i ? 1 : 0.55}>
              {kinds.map((k) => {
                const v = Math.max(0, k.values[i] ?? 0);
                const barTop = y(base + v);
                const h = y(base) - barTop;
                base += v;
                return h > 0 ? (
                  <rect key={k.key} x={xs(i)} y={barTop} width={barW} height={h} fill={k.color} />
                ) : null;
              })}
            </g>
          );
        })}
        {labels.map((l) => (
          <g key="marker">
            <line x1={l.x} x2={l.x} y1={PAD.top + 12} y2={bottom} className="marker-line" />
            <text x={l.left + 3} y={PAD.top + 9} className="marker-label">
              {l.guide.label}
            </text>
          </g>
        ))}
        <XAxisLabels
          count={n}
          x={(i) => xs(i) + barW / 2}
          years={years}
          y={height - 6}
          innerW={innerW}
        />
        {selected !== null && selected < n ? (
          <rect
            x={xs(selected) - 1}
            y={y(totals[selected] ?? 0) - 1}
            width={barW + 2}
            height={y(0) - y(totals[selected] ?? 0) + 1}
            className="bar-focus"
          />
        ) : null}
      </svg>
      <Scrubber
        years={years}
        selected={selected}
        scrub={scrub}
        pick={pick}
        valueText={props.valueText}
      />
    </div>
  );
}
