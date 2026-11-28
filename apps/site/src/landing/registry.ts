/**
 * Every country version of the home page. The order is the order of the switcher; the United States
 * (`/`) comes first and is the default (`x-default`). Add a country by writing countries/<slug>.ts and
 * listing it here: the route, hreflang set, switcher, banner, sitemap, social image and llms.txt follow.
 *
 * Server-side only: the entries run the engine at build time. The banner script receives what it needs
 * (code, path, label) from the page's HTML instead (see components/landing/CountryBanner.astro).
 */
import { absoluteUrl } from "../config/site";
import { uk } from "./countries/uk";
import { us } from "./countries/us";
import type { VersionLink } from "./guess";
import type { LandingEntry } from "./types";

export const LANDINGS: readonly LandingEntry[] = [us, uk];

/** The entry `/` uses; also the `x-default`. */
export const DEFAULT_LANDING: LandingEntry = us;

/** Site path of an entry: "/" or "/uk/". */
export function landingPath(entry: Pick<LandingEntry, "slug">): string {
  return entry.slug ? `/${entry.slug}/` : "/";
}

/** The entries served at /<slug>/ (every one but the default). */
export function countryLandings(): readonly LandingEntry[] {
  return LANDINGS.filter((e) => e !== DEFAULT_LANDING);
}

export interface Alternate {
  hreflang: string;
  href: string;
}

/**
 * The hreflang set, the same on every version: one link per version plus `x-default` (the default
 * version). Absolute URLs, so the set is reciprocal by construction.
 */
export function hreflangAlternates(): Alternate[] {
  return [
    ...LANDINGS.map((e) => ({ hreflang: e.hreflang, href: absoluteUrl(landingPath(e)) })),
    { hreflang: "x-default", href: absoluteUrl(landingPath(DEFAULT_LANDING)) },
  ];
}

/** What the banner and the switcher need about each version. */
export function versionLinks(): VersionLink[] {
  return LANDINGS.map((e) => ({ code: e.code, path: landingPath(e), label: e.label }));
}

export function landingBySlug(slug: string): LandingEntry | undefined {
  return LANDINGS.find((e) => e.slug === slug);
}
