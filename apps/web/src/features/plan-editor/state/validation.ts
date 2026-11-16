/**
 * Schema-driven validation. Every form validates its value with the SAME Zod schema the engine
 * and API use, then reads messages by dotted path ("amount.value", "range.end.age").
 */
import { useMemo } from "react";
import type { z } from "zod";

export interface Issues {
  /** First message for a path, e.g. get('name') or get('loan.interest.apr'). */
  get: (path: string) => string | undefined;
  /** Any message at or below a path prefix. */
  under: (prefix: string) => string | undefined;
  count: number;
  all: { path: string; message: string }[];
}

interface RawIssue {
  code?: string;
  path: PropertyKey[];
  message: string;
  minimum?: number | bigint;
  maximum?: number | bigint;
  origin?: string;
  expected?: string;
}

export function humanizeIssue(i: RawIssue): string {
  if (i.code === "too_small") {
    if (i.origin === "string" && Number(i.minimum) <= 1) return "Required";
    if (i.origin === "array")
      return Number(i.minimum) <= 1 ? "Add at least one" : `Add at least ${i.minimum}`;
    if (i.origin === "number") return `Must be at least ${formatBound(i.minimum, i.path)}`;
  }
  if (i.code === "too_big") {
    if (i.origin === "string") return `Too long (max ${i.maximum} characters)`;
    if (i.origin === "number") return `Must be at most ${formatBound(i.maximum, i.path)}`;
  }
  if (i.code === "invalid_type") return i.expected === "number" ? "Enter a number" : "Required";
  if (i.code === "invalid_format" || i.message.startsWith("expected YYYY-MM"))
    return "Pick a month";
  return i.message.charAt(0).toUpperCase() + i.message.slice(1);
}

/** Rates are fractions: show their bounds as percentages. */
function formatBound(b: number | bigint | undefined, path: PropertyKey[]): string {
  const last = String(path[path.length - 1] ?? "");
  const n = Number(b);
  if (/rate|share|apr|plus|cut|drawdown|yield|matchShare/i.test(last) && Math.abs(n) <= 10)
    return `${Math.round(n * 100)}%`;
  return String(n);
}

export function collectIssues(result: {
  success: boolean;
  error?: { issues: RawIssue[] };
}): Issues {
  const all =
    result.success || !result.error
      ? []
      : result.error.issues.map((i) => ({
          path: i.path.map(String).join("."),
          message: humanizeIssue(i),
        }));
  const map = new Map<string, string>();
  for (const i of all) if (!map.has(i.path)) map.set(i.path, i.message);
  return {
    all,
    count: all.length,
    get: (p) => map.get(p),
    under: (prefix) =>
      all.find((i) => i.path === prefix || i.path.startsWith(`${prefix}.`))?.message,
  };
}

export function validate<S extends z.ZodType>(schema: S, value: unknown): Issues {
  return collectIssues(schema.safeParse(value) as never);
}

export function useIssues<S extends z.ZodType>(schema: S, value: unknown): Issues {
  return useMemo(() => validate(schema, value), [schema, value]);
}

/** Narrow issues to a sub-tree, so nested editors can use relative paths. */
export function scopeIssues(issues: Issues, prefix: string): Issues {
  const all = issues.all
    .filter((i) => i.path === prefix || i.path.startsWith(`${prefix}.`))
    .map((i) => ({ path: i.path.slice(prefix.length + 1), message: i.message }));
  return {
    all,
    count: all.length,
    get: (p) => all.find((i) => i.path === p)?.message,
    under: (pre) => all.find((i) => i.path === pre || i.path.startsWith(`${pre}.`))?.message,
  };
}

export const NO_ISSUES: Issues = {
  all: [],
  count: 0,
  get: () => undefined,
  under: () => undefined,
};
