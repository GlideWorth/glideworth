/**
 * Cross-border helpers for the web: when a household's items span countries (so the UI shows tax
 * by country and the simplifications), and a stable chart colour per country. The household lives
 * at its location for the whole plan. Pure functions; the tax rules live in @glideworth/core.
 */
import {
  ACCOUNT_TYPE_INFO,
  type GlideworthDocument,
  type Household,
  type Plan,
  type ProjectionResult,
} from "@glideworth/core";

/** A US citizen or green-card holder living outside the US. */
export function usPersonAbroad(household: Household): boolean {
  return (
    household.location.country !== "US" &&
    household.people.some((p) => p.usGreenCard || p.citizenships?.includes("US"))
  );
}

/** Countries of the household's accounts, assets, debts and the plan's income (with the household's). */
export function itemCountries(
  doc: Pick<GlideworthDocument, "household" | "finances">,
  plan?: Plan,
): string[] {
  const base = doc.household.location.country;
  const out = new Set<string>([base]);
  for (const a of doc.finances.accounts)
    if (!a.archived) out.add(a.jurisdiction ?? ACCOUNT_TYPE_INFO[a.type].country ?? base);
  for (const r of doc.finances.realAssets) if (!r.archived) out.add(r.country ?? base);
  for (const d of doc.finances.debts) if (!d.archived) out.add(d.country ?? base);
  for (const e of plan?.income ?? []) if (e.enabled && e.country) out.add(e.country);
  return [...out];
}

/**
 * Whether cross-border UI is relevant: an item in another country, a US person abroad, or a result
 * that carries tax by country. A single-country household sees none of it.
 */
export function isCrossBorder(
  doc: Pick<GlideworthDocument, "household" | "finances">,
  plan?: Plan,
  result?: ProjectionResult | null,
): boolean {
  if (result?.periods.some((p) => p.taxes.byCountry !== undefined)) return true;
  if (usPersonAbroad(doc.household)) return true;
  return itemCountries(doc, plan).length > 1;
}

/** Chart slot per country (palette.ts `slotColor`), stable across pages; the household's is Spruce. */
export function countrySlot(country: string, home: string): number {
  if (country === home) return 0;
  let h = 0;
  for (const c of country) h = (h * 31 + c.charCodeAt(0)) % 997;
  return 1 + (h % 7);
}
