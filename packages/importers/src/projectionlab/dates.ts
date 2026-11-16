/**
 * Date references and time ranges.
 *
 * Source: `{type:'keyword'|'date'|'year'|'milestone'|'age', value, modifier:'include'|'exclude'}`.
 *   keyword now | beforeCurrentYear -> planStart;  endOfPlan -> planEnd;  never -> never
 *   date / year (YYYY-MM-DD, ms timestamp, or a bare year)        -> {kind:'date'} at month precision
 *   milestone (id)                                                -> {kind:'milestone'}
 *   age                                                           -> {kind:'age'} (primary unless owner says spouse)
 * Range ends: modifier 'include' -> endInclusive; 'exclude' -> exclusive end.
 * Range starts: modifier 'exclude' on a date/milestone shifts the start by +1 month.
 */
import type { DateRefInput, MonthDate } from "@glideworth/core";
import { isObj, num, str } from "../util/read.js";
import { infoNote, invalid, type PlContext } from "./context.js";

export type RefInput = DateRefInput;

export interface TimeRangeInput {
  start: RefInput;
  end: RefInput;
  endInclusive: boolean;
}

/** `YYYY-MM-DD...`, `YYYY-MM`, a 4-digit year, or epoch milliseconds -> `YYYY-MM`. */
export function toMonth(v: unknown): MonthDate | undefined {
  if (typeof v === "number" && Number.isFinite(v)) {
    if (v >= 1000 && v <= 3000) return `${Math.trunc(v)}-01`;
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return undefined;
    return `${String(d.getUTCFullYear()).padStart(4, "0")}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  }
  if (typeof v === "string") {
    const m = /^(\d{4})-(\d{2})(?:-\d{2})?(?:[T ].*)?$/.exec(v.trim());
    if (m && Number(m[2]) >= 1 && Number(m[2]) <= 12) return `${m[1]}-${m[2]}`;
    if (/^\d{4}$/.test(v.trim())) return `${v.trim()}-01`;
    const t = Date.parse(v);
    if (!Number.isNaN(t)) return toMonth(t);
  }
  return undefined;
}

export function shiftMonths(month: MonthDate, delta: number): MonthDate {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const idx = y * 12 + (m - 1) + delta;
  const ny = Math.floor(idx / 12);
  return `${String(ny).padStart(4, "0")}-${String((idx % 12) + 1).padStart(2, "0")}`;
}

export function personIdFor(ctx: PlContext, who: unknown): string {
  if (who === "spouse" && ctx.partnerId) return ctx.partnerId;
  return ctx.primaryId;
}

export interface ResolvedRef {
  ref: RefInput;
  /** The reference points at a concrete moment (date/milestone/age) where include/exclude matters. */
  pointLike: boolean;
  modifier: "include" | "exclude";
}

export function resolveRef(
  ctx: PlContext,
  v: unknown,
  path: string,
  role: "start" | "end",
  fallbackOwner?: unknown,
): ResolvedRef {
  const fallback: RefInput =
    role === "start"
      ? { kind: "planStart", offsetMonths: 0 }
      : { kind: "planEnd", offsetMonths: 0 };
  if (!isObj(v)) {
    if (v !== undefined) invalid(ctx, path, "date reference is not an object; defaulted");
    return { ref: fallback, pointLike: false, modifier: "include" };
  }
  const type = str(v.type);
  const value = v.value;
  const modifier = v.modifier === "exclude" ? "exclude" : "include";
  switch (type) {
    case "keyword": {
      switch (value) {
        case "now":
        case "beforeCurrentYear":
        case "startOfPlan":
          return { ref: { kind: "planStart", offsetMonths: 0 }, pointLike: false, modifier };
        case "endOfPlan":
          return { ref: { kind: "planEnd", offsetMonths: 0 }, pointLike: false, modifier };
        case "never":
          return { ref: { kind: "never" }, pointLike: false, modifier };
        default:
          invalid(
            ctx,
            path,
            `unknown date keyword '${String(value)}'; defaulted to ${fallback.kind}`,
          );
          return { ref: fallback, pointLike: false, modifier };
      }
    }
    case "date":
    case "year": {
      const month = toMonth(value);
      if (!month) {
        invalid(ctx, path, `unparseable ${type} value; defaulted to ${fallback.kind}`);
        return { ref: fallback, pointLike: false, modifier };
      }
      return { ref: { kind: "date", date: month, offsetMonths: 0 }, pointLike: true, modifier };
    }
    case "milestone": {
      const id = str(value);
      const scope = ctx.plan;
      if (!id || !scope?.knownMilestones.has(id)) {
        invalid(
          ctx,
          path,
          "references a milestone that is not defined in this plan; treated as never",
        );
        return { ref: { kind: "never" }, pointLike: false, modifier };
      }
      return {
        ref: {
          kind: "milestone",
          milestoneId: scope.milestoneIds.get(id, "milestone"),
          offsetMonths: 0,
        },
        pointLike: true,
        modifier,
      };
    }
    case "age": {
      const age = num(value);
      if (age === undefined) {
        invalid(ctx, path, "age reference without a numeric value; defaulted");
        return { ref: fallback, pointLike: false, modifier };
      }
      const who = v.person ?? v.owner ?? fallbackOwner;
      return {
        ref: { kind: "age", personId: personIdFor(ctx, who), age, offsetMonths: 0 },
        pointLike: true,
        modifier,
      };
    }
    default:
      invalid(
        ctx,
        path,
        `unknown date reference type '${String(type)}'; defaulted to ${fallback.kind}`,
      );
      return { ref: fallback, pointLike: false, modifier };
  }
}

function withOffset(ref: RefInput, delta: number): RefInput {
  if (delta === 0) return ref;
  if ("offsetMonths" in ref)
    return { ...ref, offsetMonths: (ref.offsetMonths ?? 0) + delta } as RefInput;
  return ref;
}

/**
 * Build a TimeRange from source start/end references.
 * `once` events fire in the start month, so the range collapses to that month.
 */
export function resolveRange(
  ctx: PlContext,
  src: { start: unknown; end: unknown; frequency?: unknown; owner?: unknown },
  path: string,
): TimeRangeInput {
  const s = resolveRef(ctx, src.start, `${path}.start`, "start", src.owner);
  const e = resolveRef(ctx, src.end, `${path}.end`, "end", src.owner);
  let start = s.ref;
  if (src.frequency === "once") {
    // The start modifier is meaningless for a single occurrence: it fires in the start month.
    return { start, end: start, endInclusive: true };
  }
  if (s.pointLike && s.modifier === "exclude") {
    start = withOffset(start, 1);
    infoNote(
      ctx,
      `${path}.start`,
      "start 'exclude' shifted by one month (Glideworth starts are inclusive)",
      "pl.start-exclude",
    );
  }
  const open = e.ref.kind === "never" || e.ref.kind === "planEnd";
  return { start, end: e.ref, endInclusive: !open && e.modifier === "include" };
}
