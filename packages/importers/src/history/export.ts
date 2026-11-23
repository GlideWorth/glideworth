/** Export balance history (and an empty template) in the layout the importer reads back. */
import type { ProgressSnapshot } from "@glideworth/core";
import { toCsv } from "../csv/parse.js";
import { snapshotValues } from "./plan.js";
import type { HistoryLayout } from "./sheet.js";
import { type HistoryTarget, historyKeyLabel } from "./targets.js";

export interface HistoryExportOptions {
  /** Target keys to include, in this order (default: every target with a value in the history). */
  keys?: readonly string[];
  /** `rows` (default): one row per date. `columns`: one column per date. */
  layout?: Exclude<HistoryLayout, "long">;
  delimiter?: "," | "\t" | ";";
  /** Add net worth, assets and liabilities columns (default true). */
  totals?: boolean;
  /** Add the snapshot notes (rows layout only; default true). */
  notes?: boolean;
}

/** One row per date: the user's own snapshot wins over the automatic one; values fall back to the others. */
function byDate(snaps: readonly ProgressSnapshot[]) {
  const groups = new Map<string, ProgressSnapshot[]>();
  for (const s of snaps) {
    const g = groups.get(s.date) ?? [];
    g.push(s);
    groups.set(s.date, g);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, list]) => {
      const ordered = [...list].sort((a, b) => {
        const ua = a.source === "auto" ? 1 : 0;
        const ub = b.source === "auto" ? 1 : 0;
        return ua - ub || (b.createdAt ?? "").localeCompare(a.createdAt ?? "");
      });
      const values = new Map<string, number>();
      for (const s of [...ordered].reverse())
        for (const [k, v] of snapshotValues(s)) values.set(k, v);
      return { date, primary: ordered[0]!, values };
    });
}

export function exportBalanceHistory(
  snapshots: readonly ProgressSnapshot[],
  targets: readonly HistoryTarget[],
  options: HistoryExportOptions = {},
): string {
  const rows = byDate(snapshots);
  const present = new Set(rows.flatMap((r) => [...r.values.keys()]));
  const keys = options.keys
    ? [...options.keys]
    : targets.filter((t) => present.has(t.key)).map((t) => t.key);
  const totals = options.totals ?? true;
  const notes = (options.notes ?? true) && (options.layout ?? "rows") === "rows";
  const header = [
    "Date",
    ...keys.map((k) => historyKeyLabel(k, targets)),
    ...(totals ? ["Net worth", "Assets", "Liabilities"] : []),
    ...(notes ? ["Note"] : []),
  ];
  const body = rows.map((r) => [
    r.date,
    ...keys.map((k) => r.values.get(k) ?? null),
    ...(totals ? [r.primary.netWorth, r.primary.assets, r.primary.liabilities] : []),
    ...(notes ? [r.primary.note ?? ""] : []),
  ]);
  const grid: (string | number | null)[][] = [header, ...body];
  return toCsv(options.layout === "columns" ? transpose(grid) : grid, options.delimiter ?? ",");
}

/** Headers only: `Date` and one column per (non-archived) target. */
export function balanceHistoryTemplate(
  targets: readonly HistoryTarget[],
  options: Pick<HistoryExportOptions, "layout" | "delimiter"> & { includeArchived?: boolean } = {},
): string {
  const list = targets.filter((t) => options.includeArchived || !t.archived);
  const grid = [["Date", ...list.map((t) => t.label)]];
  return toCsv(options.layout === "columns" ? transpose(grid) : grid, options.delimiter ?? ",");
}

function transpose<T>(grid: T[][]): (T | null)[][] {
  const width = Math.max(0, ...grid.map((r) => r.length));
  return Array.from({ length: width }, (_, j) => grid.map((r) => r[j] ?? null));
}
