/** Small value mappers shared by the entity mappers: basis, owner, frequency, change-over-time... */
import { table, isObj, num, type Obj, pctClean, stableJson, str } from "../util/read.js";
import { approximated, infoNote, invalid, type PlContext } from "./context.js";
import { resolveRef } from "./dates.js";

export type Basis = "real" | "nominal";

/**
 * Optional per-entity currency (`currency` on accounts, assets, debts and events). Returns the ISO
 * code when it differs from the household currency (the engine converts it with the FX table), or
 * undefined for the household currency, a missing field or an invalid code (reported).
 */
export function currencyOf(ctx: PlContext, raw: unknown, path: string): string | undefined {
  const c = str(raw);
  if (!c) return undefined;
  const up = c.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(up)) {
    invalid(ctx, path, `currency '${c}' is not an ISO 4217 code; the household currency is used`);
    return undefined;
  }
  if (up !== ctx.currency) ctx.foreignCurrencies?.add(up);
  return up === ctx.currency ? undefined : up;
}

/** 'today$' -> real; '$' -> nominal; missing -> real (the source default). */
export function basisOf(ctx: PlContext, tag: unknown, path: string): Basis {
  if (tag === undefined || tag === "today$" || tag === "real") return "real";
  if (tag === "$" || tag === "nominal" || tag === "future$") return "nominal";
  if (tag === "%") return "real";
  invalid(ctx, path, `unknown amount type '${String(tag)}'; treated as today's money (real)`);
  return "real";
}

export function amountOf(
  ctx: PlContext,
  value: unknown,
  tag: unknown,
  path: string,
): { value: number; basis: Basis } {
  return { value: num(value) ?? 0, basis: basisOf(ctx, tag, path) };
}

/** me -> primary person, spouse -> partner, joint -> 'joint'. */
export function ownerOf(ctx: PlContext, v: unknown, path: string): string {
  if (v === undefined || v === "me") return ctx.primaryId;
  if (v === "joint") return "joint";
  if (v === "spouse") {
    if (ctx.partnerId) return ctx.partnerId;
    invalid(
      ctx,
      path,
      "owner 'spouse' but the export has no partner; assigned to the primary person",
    );
    return ctx.primaryId;
  }
  invalid(ctx, path, `unknown owner '${String(v)}'; assigned to the primary person`);
  return ctx.primaryId;
}

const FREQUENCIES = new Set([
  "once",
  "weekly",
  "biweekly",
  "semimonthly",
  "monthly",
  "quarterly",
  "semiannually",
  "yearly",
]);
const FREQUENCY_ALIASES: Record<string, string> = table({
  annually: "yearly",
  annual: "yearly",
  year: "yearly",
  month: "monthly",
  "one-time": "once",
  onetime: "once",
  "bi-weekly": "biweekly",
  "semi-monthly": "semimonthly",
  "semi-annually": "semiannually",
});

export function frequencyOf(
  ctx: PlContext,
  v: unknown,
  path: string,
  fallback = "monthly",
): string {
  if (v === undefined) return fallback;
  const s = typeof v === "string" ? v.toLowerCase() : "";
  if (FREQUENCIES.has(s)) return s;
  const alias = FREQUENCY_ALIASES[s];
  if (alias) return alias;
  invalid(ctx, path, `unknown frequency '${String(v)}'; defaulted to ${fallback}`);
  return fallback;
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

export function nameOf(src: Obj, fallback: string): string {
  const n = (str(src.name) ?? str(src.title) ?? "").trim();
  return (n.length > 0 ? n : fallback).slice(0, 120);
}

export function appearanceOf(src: Obj): { color?: string; icon?: string } | undefined {
  const color = str(src.color);
  const icon = str(src.icon);
  if (!color && !icon) return undefined;
  const out: { color?: string; icon?: string } = {};
  if (color) out.color = color.slice(0, 40);
  if (icon) out.icon = icon.slice(0, 60);
  return out;
}

export interface ChangeResult {
  change?: Obj;
  changeLimit?: Obj;
}

/**
 * `yearlyChange` -> Change (+ ChangeLimit).
 * Percent amounts are percentages. Note: the source tags some percent fields 'today$'
 * (assets, debts), so the amount is always read as a percent here.
 */
export function changeOf(
  ctx: PlContext,
  yc: unknown,
  path: string,
  kind: "event" | "asset",
): ChangeResult {
  if (!isObj(yc)) return {};
  const type = str(yc.type);
  const amount = num(yc.amount) ?? 0;
  const rate = pctClean(amount) ?? 0;
  let change: Obj | undefined;
  let direction: "up" | "down" = "up";
  switch (type) {
    case undefined:
      return {};
    case "none":
      change = { kind: "none" };
      break;
    case "match-inflation":
    case "inflation":
      change = { kind: "inflation", plus: rate };
      break;
    case "appreciate":
    case "increase":
    case "grow":
    case "rate":
      change = { kind: "rate", rate };
      break;
    case "depreciate":
    case "decrease":
      change = { kind: "rate", rate: -rate };
      direction = "down";
      break;
    default:
      if (yc.amountType === "%") {
        change = { kind: "rate", rate };
        approximated(
          ctx,
          `${path}.type`,
          `unknown change type '${String(type)}' read as a fixed % per year`,
        );
      } else {
        change = { kind: "none" };
        approximated(
          ctx,
          `${path}.type`,
          `unknown change type '${String(type)}' treated as no change`,
        );
      }
  }
  let changeLimit: Obj | undefined;
  if (yc.limitEnabled === true && kind === "event") {
    const limit = num(yc.limit);
    if (limit !== undefined) {
      changeLimit = {
        [direction === "up" ? "max" : "min"]: limit,
        basis: yc.limitType === "$" ? "nominal" : "real",
      };
    }
  }
  return { change, changeLimit };
}

/** `repeat*` fields -> Recurrence (years between repeats, scaling, end). */
export function recurrenceOf(
  ctx: PlContext,
  src: Obj,
  path: string,
  role: "asset" | "event",
): Obj | undefined {
  if (src.repeat !== true) return undefined;
  const interval = num(src.repeatInterval);
  if (interval === undefined) {
    approximated(ctx, `${path}.repeat`, "repeat is on but no interval is given; not repeated");
    return undefined;
  }
  const type = str(src.repeatIntervalType);
  if (type !== undefined && type !== "between") {
    approximated(
      ctx,
      `${path}.repeatIntervalType`,
      `repeat interval type '${type}' read as years between occurrences (Glideworth semantics)`,
    );
  }
  const end = resolveRef(ctx, src.repeatEnd, `${path}.repeatEnd`, "end", src.owner);
  const rec: Obj = {
    yearsBetween: clamp(interval, 0, 100),
    scalingRate: pctClean(src.repeatScaler) ?? 0,
    until: end.ref,
    keepLast: false,
  };
  if (role === "event" && interval === 0)
    infoNote(ctx, `${path}.repeatInterval`, "repeats back-to-back (interval 0)");
  return rec;
}

/**
 * Plan-level behaviour override: only the top-level keys whose effective value differs from the
 * entity's own behaviour (undefined when nothing differs). The schema's behaviour patches are
 * sparse (absent keys keep the entity's value), so a minimal diff is exact.
 */
export function behaviourOverride(
  parser: { parse(input: unknown): unknown },
  baseRaw: Obj,
  planRaw: Obj,
): Obj | undefined {
  const base = parser.parse(baseRaw) as Obj;
  const plan = parser.parse({ ...baseRaw, ...planRaw }) as Obj;
  const diff: Obj = {};
  for (const k of Object.keys(plan))
    if (stableJson(plan[k]) !== stableJson(base[k])) diff[k] = plan[k];
  return Object.keys(diff).length > 0 ? diff : undefined;
}
