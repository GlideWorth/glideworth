/**
 * Brand artwork and colours as data, for places that cannot use the Logo component: social images (satori).
 * The artwork comes from /brand, the single source for the mark and logo.
 */
import logoSvg from "../../../../brand/logo.svg?raw";
import markSvg from "../../../../brand/mark.svg?raw";

export const brandColors = {
  paper: "#f5f2ea",
  paper2: "#efebe1",
  line: "#e0d9ca",
  ink: "#18201c",
  ink2: "#434c47",
  ink3: "#5a615b",
  accent: "#2a5a4c",
  accentSoft: "#dde7df",
  ochre: "#87570f",
} as const;

/** The approved artwork, read from the masters in /brand (green on a light background). */
export const MARK_SVG = markSvg;
export const LOGO_SVG = logoSvg;

/** Aspect ratios (width / height) of the artwork, from each master's viewBox. */
export function aspect(svg: string): number {
  const m = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(svg);
  return Number(m?.[1]) / Number(m?.[2]);
}

export function svgDataUri(svg: string): string {
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}
