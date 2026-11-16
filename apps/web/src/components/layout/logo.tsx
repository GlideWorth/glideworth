/**
 * The Glideworth logo: an origami bird (the mark) and the wordmark as outlines. The geometry is read from the
 * masters in /brand (mark.svg, logo.svg), the single source shared with the marketing site
 * (apps/site/src/components/Logo.astro). The facets use the app's accent token, so the mark follows the theme
 * (deep green on light, pale green on dark); the wing-tip facet keeps the brand sand.
 */
import logoSvg from "../../../../../brand/logo.svg?raw";
import markSvg from "../../../../../brand/mark.svg?raw";

const pathData = (svg: string) => [...svg.matchAll(/ d="([^"]+)"/g)].map((m) => m[1] ?? "");
const [FACETS = "", WING = ""] = pathData(markSvg);
const WORD = pathData(logoSvg)[2] ?? "";
const viewBox = (svg: string) => /viewBox="([^"]+)"/.exec(svg)?.[1] ?? "0 0 149 153.7";

const SAND = "#d9c7a7";

export function GlideworthMark({ className = "size-7" }: { className?: string }) {
  return (
    <svg viewBox={viewBox(markSvg)} className={className} aria-hidden="true" focusable="false">
      <path d={FACETS} fill="var(--accent)" />
      <path d={WING} fill={SAND} />
    </svg>
  );
}

export function Wordmark({ className = "h-8 w-auto" }: { className?: string }) {
  return (
    <svg viewBox={viewBox(logoSvg)} className={className} role="img" aria-label="Glideworth">
      <path d={FACETS} fill="var(--accent)" />
      <path d={WING} fill={SAND} />
      <path d={WORD} fill="var(--accent)" fillRule="evenodd" />
    </svg>
  );
}
