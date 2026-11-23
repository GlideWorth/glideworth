/**
 * Resolve DateRefs to calendar months for the editor (timeline bars, "≈ Mar 2041" hints).
 * Uses the live projection's milestone resolutions when available; otherwise resolves time-only
 * milestones locally (metric milestones are unknown until simulated).
 */
import type {
  DateRef,
  Dependent,
  GlideworthDocument,
  Milestone,
  Person,
  Plan,
  ProjectionResult,
} from "@glideworth/core";
import { monthFromIndex, monthIndex } from "./finance-math";

export interface TimeContext {
  start: number;
  /** Exclusive end (the month after the last simulated month). */
  end: number;
  people: Person[];
  dependents: Dependent[];
  milestones: Milestone[];
  milestoneMonth: Record<string, number | null>;
}

export function timeContext(
  doc: GlideworthDocument,
  plan: Plan,
  result?: ProjectionResult | null,
): TimeContext {
  const asOf =
    plan.startingConditions.kind === "snapshot"
      ? plan.startingConditions.finances.asOf
      : doc.finances.asOf;
  const start = monthIndex(asOf);
  const people = doc.household.people;
  const milestoneMonth: Record<string, number | null> = {};
  if (result && result.meta.planId === plan.id) {
    for (const m of result.milestones)
      milestoneMonth[m.milestoneId] = m.month ? monthIndex(m.month) : null;
  }
  const ctx: TimeContext = {
    start,
    end: start + 12 * 60,
    people,
    dependents: doc.household.dependents,
    milestones: plan.milestones,
    milestoneMonth,
  };
  for (const m of plan.milestones)
    if (!(m.id in milestoneMonth))
      milestoneMonth[m.id] = resolveMilestoneLocally(m, ctx, new Set());
  if (result && result.meta.planId === plan.id) ctx.end = monthIndex(result.meta.endMonth) + 1;
  else {
    const le = plan.milestones
      .filter((m) => m.kind === "life-expectancy" && m.enabled)
      .map((m) => milestoneMonth[m.id])
      .filter((x): x is number => x != null);
    if (le.length) ctx.end = Math.max(...le) + 12;
  }
  return ctx;
}

function resolveMilestoneLocally(m: Milestone, ctx: TimeContext, seen: Set<string>): number | null {
  if (!m.enabled) return null;
  if (seen.has(m.id)) return null;
  seen.add(m.id);
  const months: (number | null)[] = m.criteria.map((c) => {
    if (c.kind === "metric") return null;
    if (c.when === "before") return ctx.start;
    if (c.kind === "age") {
      const p = ctx.people.find((x) => x.id === c.personId);
      return p ? monthIndex(p.birthMonth) + Math.round(c.age * 12) : null;
    }
    if (c.kind === "date") return monthIndex(c.date);
    const other = ctx.milestones.find((x) => x.id === c.milestoneId);
    const base = other
      ? (ctx.milestoneMonth[other.id] ?? resolveMilestoneLocally(other, ctx, seen))
      : null;
    return base === null ? null : base + c.offsetMonths;
  });
  const known = months.filter((x): x is number => x !== null);
  if (m.combinator === "any") return known.length ? Math.max(ctx.start, Math.min(...known)) : null;
  return known.length === months.length && known.length ? Math.max(ctx.start, ...known) : null;
}

/** Month index of a DateRef, or null for "never" / unresolvable. */
export function resolveRef(ref: DateRef, ctx: TimeContext): number | null {
  const off = "offsetMonths" in ref ? ref.offsetMonths : 0;
  switch (ref.kind) {
    case "planStart":
      return ctx.start + off;
    case "planEnd":
      return ctx.end + off;
    case "never":
      return null;
    case "date":
      return monthIndex(ref.date) + off;
    case "age": {
      const p = ctx.people.find((x) => x.id === ref.personId);
      return p ? monthIndex(p.birthMonth) + Math.round(ref.age * 12) + off : null;
    }
    case "dependentAge": {
      const d = ctx.dependents.find((x) => x.id === ref.dependentId);
      return d ? monthIndex(d.birthMonth) + Math.round(ref.age * 12) + off : null;
    }
    case "milestone": {
      const m = ctx.milestoneMonth[ref.milestoneId];
      return m == null ? null : m + off;
    }
  }
}

export function formatMonthIndex(i: number, locale: string): string {
  const [y, m] = monthFromIndex(i).split("-").map(Number);
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(Date.UTC(y!, m! - 1, 1));
}

/** "Mar 2041 · Avery 57, Jordan 54" */
export function describeMonth(i: number, ctx: TimeContext, locale: string): string {
  const ages = ctx.people
    .map((p) => `${p.name} ${Math.floor((i - monthIndex(p.birthMonth)) / 12)}`)
    .join(", ");
  return `${formatMonthIndex(i, locale)} · ${ages}`;
}
