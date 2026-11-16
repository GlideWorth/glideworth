/**
 * Charts as inline SVG strings, drawn by our own code (no charting library). The same function runs at
 * build time (the static page shows real numbers) and in the browser after each calculation.
 *
 * Accessibility: the SVG is role="img" with a <title>; the caller adds a written summary, a legend in
 * HTML and the numbers as a table (render.ts). Series differ by line style (solid, dashed, dotted) and
 * bands by depth, so nothing depends on colour alone. Colours come from the site's chart tokens through
 * CSS classes, so both themes work.
 */
import { esc, moneyCompact } from "./format";
import type { ChartSpec } from "./types";

const W = 560;
const H = 300;
const PAD = { l: 62, r: 16, t: 16, b: 40 };

function niceCeil(v: number): number {
  if (!(v > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

function ticks(min: number, max: number, count: number): number[] {
  const out: number[] = [];
  for (let i = 0; i <= count; i++) out.push(min + ((max - min) * i) / count);
  return out;
}

/** About six whole-number x ticks on round steps. */
function xTicks(x0: number, x1: number): number[] {
  const span = Math.max(1, x1 - x0);
  const step = [1, 2, 5, 10, 20, 25, 50].find((s) => span / s <= 7) ?? 100;
  const out: number[] = [];
  for (let v = Math.ceil(x0 / step) * step; v <= x1 + 1e-9; v += step) out.push(v);
  if (out.length === 0) out.push(x0);
  return out;
}

const f1 = (n: number) => (Math.round(n * 10) / 10).toString();

function yTick(v: number, spec: ChartSpec): string {
  if (spec.yUnit === "years") return String(Math.round(v));
  if (spec.yUnit === "percent") return `${Math.round(v * 100)}%`;
  return moneyCompact(v, spec.currency);
}

export function chartSvg(spec: ChartSpec): string {
  const xs = spec.x;
  const x0 = xs[0] ?? 0;
  const x1 = xs[xs.length - 1] ?? x0 + 1;
  const all: number[] = [];
  for (const s of spec.series)
    for (const v of s.values) if (v !== null && Number.isFinite(v)) all.push(v);
  for (const b of spec.bands ?? [])
    for (const v of [...b.lower, ...b.upper]) if (Number.isFinite(v)) all.push(v);
  for (const h of spec.hLines ?? []) if (Number.isFinite(h.y)) all.push(h.y);
  const dataMax = all.length ? Math.max(...all) : 1;
  const dataMin = all.length ? Math.min(...all) : 0;
  const yMax =
    spec.yUnit === "percent"
      ? Math.max(spec.yMax ?? 0, niceCeil(dataMax), 0.01)
      : niceCeil(Math.max(spec.yMax ?? 0, dataMax, 1e-9));
  const yMin = dataMin < 0 ? -niceCeil(-dataMin) : 0;
  const iw = W - PAD.l - PAD.r;
  const ih = H - PAD.t - PAD.b;
  const bar = spec.kind === "bar";
  const slot = bar ? iw / Math.max(1, xs.length) : 0;
  const sx = (v: number) =>
    bar ? PAD.l + slot * (xs.indexOf(v) + 0.5) : PAD.l + ((v - x0) / Math.max(1e-9, x1 - x0)) * iw;
  const sy = (v: number) =>
    PAD.t + ih - ((Math.min(Math.max(v, yMin), yMax) - yMin) / (yMax - yMin)) * ih;

  const parts: string[] = [];
  parts.push(
    `<svg class="tc-svg" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="${esc(spec.id)}-title" aria-describedby="${esc(spec.id)}-summary" focusable="false">`,
    `<title id="${esc(spec.id)}-title">${esc(spec.title)}</title>`,
  );

  // Grid and y axis.
  for (const t of ticks(yMin, yMax, 4)) {
    const y = f1(sy(t));
    parts.push(
      `<line class="tc-grid" x1="${PAD.l}" x2="${W - PAD.r}" y1="${y}" y2="${y}"/>`,
      `<text class="tc-tick" x="${PAD.l - 8}" y="${y}" text-anchor="end" dominant-baseline="middle">${esc(yTick(t, spec))}</text>`,
    );
  }
  // X axis ticks (bars: every few categories).
  const xt = bar
    ? xs.filter((_, i) => i % Math.max(1, Math.ceil(xs.length / 7)) === 0)
    : xTicks(Math.ceil(x0), Math.floor(x1));
  for (const t of xt) {
    const x = f1(sx(t));
    parts.push(
      `<line class="tc-axis" x1="${x}" x2="${x}" y1="${PAD.t + ih}" y2="${PAD.t + ih + 5}"/>`,
      `<text class="tc-tick" x="${x}" y="${PAD.t + ih + 20}" text-anchor="middle">${esc(String(t))}</text>`,
    );
  }
  parts.push(
    `<line class="tc-axis" x1="${PAD.l}" x2="${W - PAD.r}" y1="${f1(sy(Math.max(0, yMin)))}" y2="${f1(sy(Math.max(0, yMin)))}"/>`,
    `<text class="tc-label" x="${PAD.l + iw / 2}" y="${H - 4}" text-anchor="middle">${esc(spec.xLabel)}</text>`,
  );

  // Bands (outer first), then series.
  for (const b of [...(spec.bands ?? [])].sort((a, c) =>
    a.level === c.level ? 0 : a.level === "outer" ? -1 : 1,
  )) {
    const top = xs
      .map((x, i) => `${i ? "L" : "M"}${f1(sx(x))} ${f1(sy(b.upper[i] ?? 0))}`)
      .join(" ");
    const bottom = [...xs]
      .map((x, i) => ({ x, i }))
      .reverse()
      .map(({ x, i }) => `L${f1(sx(x))} ${f1(sy(b.lower[i] ?? 0))}`)
      .join(" ");
    parts.push(`<path class="tc-band tc-band-${b.level} tone-${b.tone}" d="${top} ${bottom} Z"/>`);
  }
  for (const s of spec.series) {
    if (bar) {
      s.values.forEach((v, i) => {
        if (v === null || !Number.isFinite(v)) return;
        const x = PAD.l + slot * i + slot * 0.12;
        const y = sy(v);
        parts.push(
          `<rect class="tc-bar tone-${s.tone}" x="${f1(x)}" y="${f1(y)}" width="${f1(slot * 0.76)}" height="${f1(Math.max(0, sy(0) - y))}"/>`,
        );
      });
      continue;
    }
    let d = "";
    let pen = false;
    s.values.forEach((v, i) => {
      const x = xs[i];
      if (v === null || !Number.isFinite(v) || x === undefined) {
        pen = false;
        return;
      }
      d += `${pen ? "L" : "M"}${f1(sx(x))} ${f1(sy(v))} `;
      pen = true;
    });
    if (d) parts.push(`<path class="tc-line tc-${s.style} tone-${s.tone}" d="${d.trim()}"/>`);
  }

  // Reference lines with short labels.
  for (const h of spec.hLines ?? []) {
    const y = f1(sy(h.y));
    parts.push(
      `<line class="tc-ref" x1="${PAD.l}" x2="${W - PAD.r}" y1="${y}" y2="${y}"/>`,
      `<text class="tc-ref-label" x="${W - PAD.r - 4}" y="${f1(sy(h.y) - 6)}" text-anchor="end">${esc(h.label)}</text>`,
    );
  }
  for (const m of spec.markers ?? []) {
    if (m.x < x0 || m.x > x1) continue;
    const x = f1(sx(m.x));
    const anchor = sx(m.x) > PAD.l + iw * 0.7 ? "end" : "start";
    parts.push(
      `<line class="tc-marker" x1="${x}" x2="${x}" y1="${PAD.t}" y2="${PAD.t + ih}"/>`,
      `<text class="tc-ref-label" x="${f1(sx(m.x) + (anchor === "end" ? -5 : 5))}" y="${PAD.t + 12}" text-anchor="${anchor}">${esc(m.label)}</text>`,
    );
  }
  parts.push("</svg>");
  return parts.join("");
}

/** A short sample of a series' line style for the HTML legend. */
export function legendSwatch(
  kind: "line" | "band" | "bar",
  style: string,
  tone: number,
  level?: string,
): string {
  if (kind === "line")
    return `<svg class="tc-swatch" viewBox="0 0 28 10" aria-hidden="true" focusable="false"><path class="tc-line tc-${style} tone-${tone}" d="M1 5 L27 5"/></svg>`;
  return `<svg class="tc-swatch" viewBox="0 0 28 10" aria-hidden="true" focusable="false"><rect class="${kind === "bar" ? "tc-bar" : `tc-band tc-band-${level ?? "outer"}`} tone-${tone}" x="1" y="1" width="26" height="8"/></svg>`;
}
