/**
 * Cross-border helpers for the web: when a plan spans countries (so the UI shows residency, tax by
 * country and the simplifications), each person's residence segments on the timeline, and colours
 * per country. Pure functions; the tax rules themselves live in @glideworth/core.
 */
import {
  ACCOUNT_TYPE_INFO,
  type GlideworthDocument,
  type Household,
  type Location,
  type Plan,
  type ProjectionResult,
  type ResidencyChange,
} from "@glideworth/core";
import { resolveRef, type TimeContext } from "../plan-editor/state/resolve";

/** Moves in the plan: dated residency entries or relocation milestone effects. */
export function hasMoves(plan: Pick<Plan, "residency" | "milestones">): boolean {
  return (
    (plan.residency?.length ?? 0) > 0 ||
    plan.milestones.some((m) => m.enabled && m.effects.some((e) => e.kind === "relocate"))
  );
}

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
 * Whether cross-border UI is relevant: a move, an item in another country, a US person abroad, or a
 * result that carries tax by country. A never-moved, single-country household sees none of it.
 */
export function isCrossBorder(
  doc: Pick<GlideworthDocument, "household" | "finances">,
  plan?: Plan,
  result?: ProjectionResult | null,
): boolean {
  if (result?.periods.some((p) => p.taxes.byCountry !== undefined)) return true;
  if (plan && hasMoves(plan)) return true;
  if (usPersonAbroad(doc.household)) return true;
  return itemCountries(doc, plan).length > 1;
}

export interface ResidenceSegment {
  personId: string;
  /** Inclusive start month index (or the timeline start). */
  from: number;
  /** Exclusive end month index. */
  to: number;
  location: Location;
  source: "household" | "residency" | "milestone";
  refId?: string;
}

/**
 * Each person's residence over [tctx.start, tctx.end): the household location, then dated entries
 * and relocation milestones in month order (milestones resolved through the time context).
 */
export function residenceSegments(
  plan: Pick<Plan, "residency" | "milestones">,
  household: Pick<Household, "people" | "location">,
  tctx: TimeContext,
): ResidenceSegment[] {
  const out: ResidenceSegment[] = [];
  for (const p of household.people) {
    const moves: {
      at: number;
      location: Location;
      source: "residency" | "milestone";
      refId: string;
    }[] = [];
    for (const r of plan.residency ?? []) {
      if (r.personId && r.personId !== p.id) continue;
      const at = resolveRef(r.from, tctx);
      if (at !== null) moves.push({ at, location: r.location, source: "residency", refId: r.id });
    }
    for (const m of plan.milestones) {
      if (!m.enabled) continue;
      for (const e of m.effects) {
        if (e.kind !== "relocate" || (e.personId && e.personId !== p.id)) continue;
        const at = tctx.milestoneMonth[m.id];
        if (at != null) moves.push({ at, location: e.location, source: "milestone", refId: m.id });
      }
    }
    moves.sort((a, b) => a.at - b.at);
    let cur: ResidenceSegment = {
      personId: p.id,
      from: tctx.start,
      to: tctx.end,
      location: household.location,
      source: "household",
    };
    for (const mv of moves) {
      const at = Math.max(tctx.start, mv.at);
      if (at >= tctx.end) break;
      if (at > cur.from) out.push({ ...cur, to: at });
      cur = {
        personId: p.id,
        from: at,
        to: tctx.end,
        location: mv.location,
        source: mv.source,
        refId: mv.refId,
      };
    }
    out.push(cur);
  }
  return out;
}

/** Stable chart colour per country (household country first). */
export function countryColor(country: string, home: string): string {
  if (country === home) return "var(--chart-1)";
  let h = 0;
  for (const c of country) h = (h * 31 + c.charCodeAt(0)) % 997;
  return `var(--chart-${(h % 5) + 2})`;
}

/** A new dated residency entry (everyone, or one person). */
export function newResidencyEntry(
  id: string,
  month: string,
  location: Location,
  personId?: string,
): ResidencyChange {
  return {
    id,
    ...(personId ? { personId } : {}),
    from: { kind: "date", date: month, offsetMonths: 0 },
    location,
  };
}

/** A country other than `home` to suggest for a new move (keeps the default generic). */
export function suggestedDestination(home: string, options: { code: string }[]): string {
  return options.find((c) => c.code !== home && c.code !== "XX")?.code ?? home;
}

/** Chart slot per country (palette.ts `slotColor`), stable across pages; the household's is Spruce. */
export function countrySlot(country: string, home: string): number {
  if (country === home) return 0;
  let h = 0;
  for (const c of country) h = (h * 31 + c.charCodeAt(0)) % 997;
  return 1 + (h % 7);
}
