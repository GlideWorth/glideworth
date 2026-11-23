/**
 * Cell-level preview of a balance-history file under a column mapping: every date and value is read, checked
 * and flagged, and the clean values are gathered into `HistoryRow`s (one per date) ready to plan an import.
 */
import { type AmountRead, type DecimalChoice, readAmount, resolveDecimal } from "./amounts.js";
import {
  type DateFormatResolution,
  type DateRead,
  finishDate,
  type HistoryDateFormat,
  type PeriodDay,
  readDateCell,
  resolveDateFormat,
} from "./dates.js";
import type { HistorySheet } from "./sheet.js";
import { HISTORY_NOTE, type HistoryTarget, historyKeyLabel, parseHistoryKey } from "./targets.js";

/** One date's values: a number, `null` for a blank cell (no value), or no key (not in the file, or skipped). */
export interface HistoryRow {
  date: string;
  values: Record<string, number | null>;
  note?: string;
}

export interface HistoryIssue {
  severity: "error" | "warning" | "info";
  code: string;
  message: string;
  /** Cell reference (`C7`), when the issue is about one cell. */
  ref?: string;
  date?: string;
  key?: string;
}

export interface FormatOptions {
  dateFormat?: HistoryDateFormat;
  decimalSeparator?: DecimalChoice;
  /** Day a month-only or year-only date stands for (default: the last day of the period). */
  periodDay?: PeriodDay;
  /** `YYYY-MM-DD`: dates after it are errors. Passed in so the module stays free of the clock. */
  today: string;
}

export type CellStatus = "value" | "blank" | "absent" | "error" | "warning" | "skipped";

export interface PreviewCell {
  raw: string;
  ref: string;
  status: CellStatus;
  /** The value the import uses (after sign handling), `null` for blank; absent for errors and skipped cells. */
  value?: number | null;
  /** A note column's text. */
  text?: string;
  code?: string;
  message?: string;
}

export interface PreviewRecord {
  rawDate: string;
  dateRef: string;
  date: string | null;
  dateStatus: "ok" | "info" | "error";
  dateCode?: string;
  dateMessage?: string;
  cells: PreviewCell[];
}

export interface HistoryPreview {
  records: PreviewRecord[];
  /** Per series: the key used (null = skipped). */
  mapping: (string | null)[];
  dateFormat: DateFormatResolution;
  decimal: { used: "." | ","; ambiguous: boolean; detected: "." | "," | undefined };
  /** Month-only or year-only dates are present (the period-day choice matters). */
  hasPeriodDates: boolean;
  /** File-level problems. Errors here block the import; cell errors can be skipped instead. */
  issues: HistoryIssue[];
  counts: {
    dates: number;
    values: number;
    blanks: number;
    /** Cells (and dates) with an error. */
    errors: number;
    warnings: number;
    /** Rows whose date could not be read (their cells are not imported). */
    badDates: number;
  };
  /** Clean values, one row per date, oldest first. Cells with an error are left out (not cleared). */
  rows: HistoryRow[];
  /** True when nothing can be imported until the file-level errors are fixed. */
  blocked: boolean;
}

/**
 * Read and check every cell. `mapping[i]` is the key for series `i` (null to skip it).
 * Debts and loans are amounts owed: a column of negative numbers is read as positive balances; a single
 * negative cell in an otherwise positive column is flagged and read as its size.
 */
export function previewHistory(
  sheet: HistorySheet,
  mapping: readonly (string | null)[],
  targets: readonly HistoryTarget[],
  options: FormatOptions,
): HistoryPreview {
  const issues: HistoryIssue[] = [];
  const byKey = new Map(targets.map((t) => [t.key, t]));
  const keys = sheet.headers.map((_, i) => mapping[i] ?? null);

  // Mapping checks: unknown keys, the same target twice.
  const seen = new Map<string, number>();
  keys.forEach((k, i) => {
    if (!k) return;
    const parsed = parseHistoryKey(k);
    if (!parsed || (parsed.type === "entity" && !byKey.has(k))) {
      issues.push({
        severity: "error",
        code: "history.mapping.unknown",
        message: `column "${sheet.headers[i]}" is mapped to an unknown target`,
        key: k,
      });
      keys[i] = null;
      return;
    }
    if (seen.has(k)) {
      issues.push({
        severity: "error",
        code: "history.mapping.duplicate",
        message: `columns "${sheet.headers[seen.get(k)!]}" and "${sheet.headers[i]}" are both mapped to ${historyKeyLabel(k, targets)}`,
        key: k,
      });
    } else seen.set(k, i);
  });
  if (!keys.some((k) => k && k !== HISTORY_NOTE))
    issues.push({
      severity: "error",
      code: "history.mapping.empty",
      message: "no column is mapped to an account, asset, debt or total",
    });
  if (sheet.records.length === 0)
    issues.push({
      severity: "error",
      code: "history.empty",
      message: "the file has no dated rows",
    });

  // Dates
  const reads: DateRead[] = sheet.records.map((r) => readDateCell(r.rawDate));
  const dateFormat = resolveDateFormat(reads, options.dateFormat ?? "auto");
  if (dateFormat.ambiguous)
    issues.push({
      severity: "error",
      code: "history.date.ambiguous",
      message: `the dates fit both month/day/year and day/month/year; choose the date format${dateFormat.suggestion ? ` (they run in order as ${dateFormat.suggestion === "MDY" ? "month/day/year" : "day/month/year"})` : ""}`,
    });
  else if (dateFormat.conflict && (options.dateFormat ?? "auto") === "auto")
    issues.push({
      severity: "error",
      code: "history.date.conflict",
      message: "some dates only work month-first and others only day-first; choose the date format",
    });
  const periodDay = options.periodDay ?? "end";
  const hasPeriodDates = reads.some((r) => r.kind === "month" || r.kind === "year");

  // Numbers: one separator for the file, from the mapped value cells.
  const valueCells: string[] = [];
  for (const r of sheet.records)
    r.cells.forEach((c, i) => {
      const k = keys[i];
      if (k && k !== HISTORY_NOTE) valueCells.push(c);
    });
  const dec = resolveDecimal(valueCells, options.decimalSeparator ?? "auto");
  if (dec.ambiguous)
    issues.push({
      severity: "warning",
      code: "history.number.ambiguous",
      message: `numbers such as "1,234" or "1.234" could use either separator; read with "${dec.decimal}" as the decimal point. Choose the number format if that is wrong`,
    });

  const finished = reads.map((r) => finishDate(r, dateFormat, periodDay, options.today));

  // Liability columns made only of negative numbers are flipped as a whole.
  const flip = keys.map((k, i) => {
    const t = k ? byKey.get(k) : undefined;
    if (!t || t.side !== "liability") return false;
    let neg = 0;
    let pos = 0;
    for (const [ri, r] of sheet.records.entries()) {
      if (!finished[ri]!.iso) continue;
      const a = readAmount(r.cells[i] ?? "", dec.decimal);
      if (a.kind === "value" && a.value < 0) neg++;
      else if (a.kind === "value" && a.value > 0) pos++;
    }
    return neg > 0 && pos === 0;
  });
  flip.forEach((f, i) => {
    if (f)
      issues.push({
        severity: "info",
        code: "history.value.liability-sign",
        message: `"${sheet.headers[i]}" holds negative numbers; read as amounts owed`,
        key: keys[i]!,
      });
  });

  const counts = { dates: 0, values: 0, blanks: 0, errors: 0, warnings: 0, badDates: 0 };
  const records: PreviewRecord[] = sheet.records.map((rec, ri) => {
    const d = finished[ri]!;
    const dateOk = d.iso !== undefined;
    if (!dateOk) {
      counts.errors++;
      counts.badDates++;
    }
    const cells = rec.cells.map((raw, ci): PreviewCell => {
      const ref = rec.refs[ci] ?? "";
      const k = keys[ci];
      if (!k) return { raw, ref, status: "skipped" };
      if (k === HISTORY_NOTE) {
        const text = raw.trim();
        return text
          ? { raw, ref, status: "value", text: text.slice(0, 500) }
          : { raw, ref, status: "blank" };
      }
      if (!dateOk) return { raw, ref, status: "skipped" };
      const t = byKey.get(k);
      const read: AmountRead = readAmount(raw, dec.decimal);
      if (read.kind === "blank") {
        if (!ref) return { raw, ref, status: "absent", value: null };
        counts.blanks++;
        return { raw, ref, status: "blank", value: null };
      }
      if (read.kind === "invalid") {
        counts.errors++;
        return {
          raw,
          ref,
          status: "error",
          code: "history.value.invalid",
          message:
            read.reason === "error-marker"
              ? "a spreadsheet error or placeholder, not a balance"
              : "not a number this importer can read",
        };
      }
      let value = read.value;
      let warning: { code: string; message: string } | undefined;
      if (read.dash) warning = { code: "history.value.dash", message: "a dash, read as 0" };
      if (t?.side === "liability" && value < 0) {
        value = -value;
        if (!flip[ci])
          warning = {
            code: "history.value.liability-sign",
            message: "negative; read as an amount owed",
          };
      } else if (t?.kind === "asset" && value < 0) {
        counts.errors++;
        return {
          raw,
          ref,
          status: "error",
          code: "history.value.negative",
          message: "an asset's value cannot be negative",
        };
      } else if ((k === "assets" || k === "liabilities") && value < 0) {
        counts.errors++;
        return {
          raw,
          ref,
          status: "error",
          code: "history.value.negative",
          message: `${k === "assets" ? "total assets" : "total liabilities"} cannot be negative`,
        };
      }
      counts.values++;
      if (warning) {
        counts.warnings++;
        return { raw, ref, status: "warning", value, ...warning };
      }
      return { raw, ref, status: "value", value };
    });
    return {
      rawDate: rec.rawDate,
      dateRef: rec.dateRef,
      date: d.iso ?? null,
      dateStatus: !dateOk ? "error" : d.severity === "info" ? "info" : "ok",
      ...(d.code ? { dateCode: d.code } : {}),
      ...(d.message ? { dateMessage: d.message } : {}),
      cells,
    };
  });

  // Combine records that share a date. A value fills a blank; two different values are a conflict.
  const rows = new Map<string, HistoryRow>();
  const origin = new Map<string, { rec: number; cell: number }>();
  const conflicted = new Set<string>();
  records.forEach((rec, ri) => {
    if (!rec.date) return;
    let row = rows.get(rec.date);
    if (!row) {
      row = { date: rec.date, values: {} };
      rows.set(rec.date, row);
    }
    rec.cells.forEach((cell, ci) => {
      const k = keys[ci];
      if (!k) return;
      if (k === HISTORY_NOTE) {
        if (cell.text) row.note = row.note ? `${row.note}; ${cell.text}`.slice(0, 500) : cell.text;
        return;
      }
      if (cell.status === "error" || cell.value === undefined) return;
      const id = `${rec.date}\u0000${k}`;
      const prev = origin.get(id);
      if (!prev) {
        origin.set(id, { rec: ri, cell: ci });
        row.values[k] = cell.value;
        return;
      }
      const prevValue = row.values[k];
      if (cell.value === null) return;
      if (prevValue === null || prevValue === undefined) {
        origin.set(id, { rec: ri, cell: ci });
        row.values[k] = cell.value;
        return;
      }
      if (Math.abs(prevValue - cell.value) < 0.005) return;
      // Conflict: flag both cells and import neither.
      const other = records[prev.rec]!.cells[prev.cell]!;
      for (const [c, against] of [
        [cell, other.ref],
        [other, cell.ref],
      ] as const) {
        if (c.status !== "error") {
          if (c.status === "warning") counts.warnings--;
          counts.values--;
          counts.errors++;
        }
        c.status = "error";
        c.code = "history.value.conflict";
        c.message = `the same date has a different value${against ? ` in ${against}` : ""}`;
        delete c.value;
      }
      delete row.values[k];
      origin.set(id, { rec: ri, cell: ci });
      conflicted.add(id);
    });
  });
  // A third value for a conflicted cell must not bring it back.
  for (const id of conflicted) {
    const [date, k] = id.split("\u0000") as [string, string];
    const row = rows.get(date);
    if (row) delete row.values[k];
  }
  counts.dates = rows.size;
  return {
    records,
    mapping: keys,
    dateFormat,
    decimal: { used: dec.decimal, ambiguous: dec.ambiguous, detected: dec.detected },
    hasPeriodDates,
    issues,
    counts,
    rows: [...rows.values()].sort((a, b) => a.date.localeCompare(b.date)),
    blocked: issues.some((i) => i.severity === "error"),
  };
}
