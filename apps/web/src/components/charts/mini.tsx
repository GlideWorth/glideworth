/**
 * Lightweight SVG charts that do not need ECharts (sparklines, the success gauge, inline bars).
 * They are cheap enough for dashboards and print.
 */
import { useId } from "react";

export function Sparkline({
  values,
  width = 120,
  height = 32,
  className,
  ariaLabel,
  color = "var(--accent)",
  fill = true,
}: {
  values: number[];
  width?: number;
  height?: number;
  className?: string;
  ariaLabel: string;
  color?: string;
  fill?: boolean;
}) {
  const id = useId();
  if (values.length < 2)
    return (
      <svg width={width} height={height} className={className} role="img" aria-label={ariaLabel} />
    );
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pts = values.map((v, i) => {
    const x = (i / (values.length - 1)) * (width - 4) + 2;
    const y = height - 3 - ((v - min) / span) * (height - 6);
    return [x, y] as const;
  });
  const d = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join("");
  const last = pts.at(-1)!;
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={className}
      role="img"
      aria-label={ariaLabel}
    >
      {fill ? (
        <>
          <defs>
            <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0" stopColor={color} stopOpacity="0.22" />
              <stop offset="1" stopColor={color} stopOpacity="0" />
            </linearGradient>
          </defs>
          <path
            d={`${d}L${last[0]},${height}L${pts[0]![0]},${height}Z`}
            fill={`url(#${CSS.escape(id)})`}
          />
        </>
      ) : null}
      <path d={d} fill="none" stroke={color} strokeWidth={1.75} strokeLinejoin="round" />
      <circle cx={last[0]} cy={last[1]} r={2.5} fill={color} />
    </svg>
  );
}

/**
 * Success gauge: a 240° arc with the outcome bands drawn as a thin outer ring and the success
 * rate as the inner arc. Label and value are text (never colour-alone).
 */
export function SuccessGauge({
  rate,
  label,
  sub,
  bands,
  size = 200,
  color,
}: {
  rate: number;
  label: string;
  sub?: string;
  bands: { share: number; color: string; name: string }[];
  size?: number;
  color: string;
}) {
  const r = size / 2 - 14;
  const cx = size / 2;
  const cy = size / 2;
  const start = 150;
  const sweep = 240;
  const arc = (from: number, to: number, radius: number) => {
    const a0 = ((start + from * sweep) * Math.PI) / 180;
    const a1 = ((start + to * sweep) * Math.PI) / 180;
    const large = (to - from) * sweep > 180 ? 1 : 0;
    return `M${cx + radius * Math.cos(a0)},${cy + radius * Math.sin(a0)} A${radius},${radius} 0 ${large} 1 ${cx + radius * Math.cos(a1)},${cy + radius * Math.sin(a1)}`;
  };
  let acc = 0;
  const pct = Math.max(0, Math.min(1, rate));
  return (
    <svg
      width={size}
      height={size * 0.82}
      viewBox={`0 0 ${size} ${size * 0.82}`}
      role="img"
      aria-label={`${label}: ${sub ?? ""}`}
    >
      <path
        d={arc(0, 1, r)}
        fill="none"
        stroke="var(--surface-3)"
        strokeWidth={12}
        strokeLinecap="round"
      />
      {pct > 0.002 ? (
        <path
          d={arc(0, pct, r)}
          fill="none"
          stroke={color}
          strokeWidth={12}
          strokeLinecap="round"
        />
      ) : null}
      {bands.map((b) => {
        const from = acc;
        acc += b.share;
        if (b.share <= 0.001) return null;
        return (
          <path
            key={b.name}
            d={arc(from, Math.min(1, acc), r + 11)}
            fill="none"
            stroke={b.color}
            strokeWidth={4}
          >
            <title>{`${b.name}: ${(b.share * 100).toFixed(1)}%`}</title>
          </path>
        );
      })}
      <text
        x={cx}
        y={cy + 4}
        textAnchor="middle"
        className="display num"
        style={{ fontSize: size * 0.2, fontWeight: 600, fill: "var(--ink)" }}
      >
        {label}
      </text>
      {sub ? (
        <text
          x={cx}
          y={cy + size * 0.15}
          textAnchor="middle"
          style={{ fontSize: 12, fill: "var(--ink-2)" }}
        >
          {sub}
        </text>
      ) : null}
    </svg>
  );
}

/** Horizontal share bar (e.g. outcome categories, tax composition). */
export function ShareBar({
  parts,
  height = 10,
  ariaLabel,
}: {
  parts: { value: number; color: string; label: string }[];
  height?: number;
  ariaLabel: string;
}) {
  const total = parts.reduce((s, p) => s + Math.max(0, p.value), 0) || 1;
  return (
    <div
      role="img"
      aria-label={ariaLabel}
      className="flex w-full gap-[2px] overflow-hidden rounded-full"
      style={{ height }}
    >
      {parts
        .filter((p) => p.value > 0)
        .map((p) => (
          <div
            key={p.label}
            title={`${p.label}: ${((p.value / total) * 100).toFixed(1)}%`}
            style={{ width: `${(p.value / total) * 100}%`, background: p.color }}
          />
        ))}
    </div>
  );
}
