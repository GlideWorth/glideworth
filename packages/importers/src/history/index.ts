/**
 * Balance-history import: per-account balances over time from a spreadsheet (pasted cells, CSV or TSV).
 * read the sheet -> match columns -> preview every cell -> plan merge/replace against saved snapshots.
 */
import type { Delimiter } from "../csv/parse.js";
import type { DecimalChoice } from "./amounts.js";
import type { HistoryDateFormat, PeriodDay } from "./dates.js";
import { type ColumnMatch, matchHistoryColumns } from "./match.js";
import { type HistoryPreview, previewHistory } from "./preview.js";
import { type HistoryLayout, type HistorySheet, readHistorySheet } from "./sheet.js";
import type { HistoryTarget } from "./targets.js";

export * from "./amounts.js";
export * from "./dates.js";
export * from "./export.js";
export * from "./match.js";
export * from "./plan.js";
export * from "./preview.js";
export * from "./sheet.js";
export * from "./targets.js";

export interface ParseHistoryOptions {
  targets: readonly HistoryTarget[];
  /** `YYYY-MM-DD`. */
  today: string;
  delimiter?: Delimiter | "auto";
  layout?: HistoryLayout | "auto";
  dateFormat?: HistoryDateFormat;
  decimalSeparator?: DecimalChoice;
  periodDay?: PeriodDay;
  /** Header text -> target key, or `skip`. Overrides the automatic match for those columns. */
  columns?: Record<string, string>;
}

export interface ParsedHistory {
  sheet: HistorySheet;
  matches: ColumnMatch[];
  preview: HistoryPreview;
}

/** Read, match and preview in one call (the API and MCP text path). */
export function parseBalanceHistory(text: string, options: ParseHistoryOptions): ParsedHistory {
  const sheet = readHistorySheet(text, {
    ...(options.delimiter ? { delimiter: options.delimiter } : {}),
    ...(options.layout ? { layout: options.layout } : {}),
  });
  const matches = matchHistoryColumns(sheet.headers, options.targets);
  const overrides = new Map(
    Object.entries(options.columns ?? {}).map(([h, k]) => [h.trim().toLowerCase(), k]),
  );
  const mapping = matches.map((m) => {
    const o = overrides.get(m.header.trim().toLowerCase());
    if (o === undefined) return m.key;
    return o === "skip" ? null : o;
  });
  const preview = previewHistory(sheet, mapping, options.targets, {
    today: options.today,
    ...(options.dateFormat ? { dateFormat: options.dateFormat } : {}),
    ...(options.decimalSeparator ? { decimalSeparator: options.decimalSeparator } : {}),
    ...(options.periodDay ? { periodDay: options.periodDay } : {}),
  });
  return { sheet, matches, preview };
}
