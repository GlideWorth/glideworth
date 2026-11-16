/** Shared CSV preparation: parse, pick a preset, detect columns, resolve locale and formats. */
import type { CsvKind, CsvLocale, ImportIssue } from "../types.js";
import {
  type ColumnMapping,
  type CsvPreset,
  type DetectedColumns,
  detectColumns,
  type Field,
  matchPresets,
  norm,
  presetById,
} from "./columns.js";
import {
  type DateFormat,
  detectDateFormat,
  detectDecimalSeparator,
  type NumberLocale,
  parseDate,
  parseNumber,
} from "./locale.js";
import { type Delimiter, parseCsv } from "./parse.js";

export interface CsvOptions {
  /** `auto` (default): from the preset, else sniffed from the data (dates fall back to en-GB). */
  locale?: CsvLocale | "auto";
  /** A preset id, `auto` (default: match by headers) or `none`. */
  preset?: string;
  /** Explicit column overrides: logical field -> header text. Always wins over presets and detection. */
  columns?: ColumnMapping;
  delimiter?: Delimiter;
  decimalSeparator?: "." | ",";
  dateFormat?: DateFormat | "auto";
  /** `YYYY-MM-DD` used for rows that carry no date. */
  defaultDate?: string;
}

export interface CsvAnalysis {
  kind: CsvKind;
  delimiter: Delimiter;
  headers: string[];
  rowCount: number;
  preset?: { id: string; name: string };
  /** Other presets that also matched, for a "did you mean" UI. */
  presetCandidates: { id: string; name: string }[];
  locale: CsvLocale | "auto";
  dateFormat: DateFormat;
  /** All numeric dates fit both day-first and month-first; the locale default was used. */
  ambiguousDates: boolean;
  decimalSeparator: "." | ",";
  columns: ColumnMapping;
  confidence: DetectedColumns["confidence"];
  unmapped: string[];
  /** First data rows, for the preview table. */
  sample: string[][];
  /** Required fields still unmapped (the import cannot proceed until the user maps them). */
  missing: Field[];
  issues: ImportIssue[];
}

export interface Prepared {
  analysis: CsvAnalysis;
  rows: string[][];
  /** Field -> column index. */
  idx: Partial<Record<Field, number>>;
  preset?: CsvPreset;
  cell(row: string[], field: Field): string;
  num(row: string[], field: Field): number | undefined;
  date(row: string[], field: Field): string | undefined;
}

const REQUIRED: Record<CsvKind, (m: ColumnMapping) => Field[]> = {
  "account-balances": (m) => [
    ...(m.account ? [] : (["account"] as Field[])),
    ...(m.balance ? [] : (["balance"] as Field[])),
  ],
  "progress-snapshots": (m) => [
    ...(m.date ? [] : (["date"] as Field[])),
    ...(m.netWorth || (m.assets && (m.liabilities || m.debt || m.loans))
      ? []
      : (["netWorth"] as Field[])),
  ],
  transactions: (m) => [
    ...(m.date ? [] : (["date"] as Field[])),
    ...(m.amount || m.debit || m.credit ? [] : (["amount"] as Field[])),
  ],
};

export function prepare(text: string, kind: CsvKind, options: CsvOptions = {}): Prepared {
  const issues: ImportIssue[] = [];
  const parsed = parseCsv(text, options.delimiter);
  const [headerRow, ...rows] = parsed.rows;
  const headers = (headerRow ?? []).map((h) => h.trim());
  if (!headerRow) {
    issues.push({
      severity: "error",
      category: "invalid",
      sourcePath: "csv:header",
      message: "file is empty",
      code: "csv.empty",
    });
  }

  // Preset
  const candidates = matchPresets(headers, kind);
  let preset: CsvPreset | undefined;
  if (options.preset && options.preset !== "auto" && options.preset !== "none") {
    preset = presetById(options.preset);
    if (!preset)
      issues.push({
        severity: "warning",
        category: "invalid",
        sourcePath: "csv:preset",
        message: `unknown preset '${options.preset}'`,
        code: "csv.preset",
      });
    else if (preset.kind !== kind)
      issues.push({
        severity: "warning",
        category: "invalid",
        sourcePath: "csv:preset",
        message: `preset '${preset.id}' is for ${preset.kind}`,
        code: "csv.preset",
      });
  } else if (options.preset !== "none") preset = candidates[0];

  // Columns: preset columns (resolved case-insensitively against the real headers) < detection < overrides
  const normToHeader = new Map(headers.map((h) => [norm(h), h]));
  const fromPreset: ColumnMapping = {};
  if (preset) {
    for (const [f, h] of Object.entries(preset.columns) as [Field, string][]) {
      const actual = normToHeader.get(norm(h));
      if (actual) fromPreset[f] = actual;
    }
  }
  const resolvedOverrides: ColumnMapping = { ...fromPreset };
  for (const [f, h] of Object.entries(options.columns ?? {}) as [Field, string][]) {
    const actual = normToHeader.get(norm(h));
    if (actual) resolvedOverrides[f] = actual;
    else
      issues.push({
        severity: "warning",
        category: "invalid",
        sourcePath: "csv:columns",
        message: `mapped column '${h}' for ${f} is not in the file`,
        code: "csv.column",
      });
  }
  const detected = detectColumns(headers, rows, kind, resolvedOverrides);
  const mapping = detected.mapping;
  const idx: Partial<Record<Field, number>> = {};
  for (const [f, h] of Object.entries(mapping) as [Field, string][]) {
    const i = headers.indexOf(h);
    if (i >= 0) idx[f] = i;
  }

  // Locale & formats
  const locale = options.locale ?? preset?.locale ?? "auto";
  const numericLocale: NumberLocale = locale;
  const moneyFields: Field[] = [
    "balance",
    "amount",
    "debit",
    "credit",
    "netWorth",
    "assets",
    "liabilities",
    "cash",
    "taxable",
    "taxDeferred",
    "taxFree",
    "crypto",
    "debt",
    "loans",
  ];
  const moneyValues: string[] = [];
  for (const f of moneyFields) {
    const i = idx[f];
    if (i !== undefined) for (const r of rows.slice(0, 200)) moneyValues.push(r[i] ?? "");
  }
  const decimalSeparator =
    options.decimalSeparator ??
    (locale === "auto" ? detectDecimalSeparator(moneyValues) : undefined) ??
    ".";
  let dateFormat: DateFormat;
  let ambiguousDates = false;
  const dateIdx = idx.date;
  if (options.dateFormat && options.dateFormat !== "auto") dateFormat = options.dateFormat;
  else if (preset?.dateFormat) dateFormat = preset.dateFormat;
  else {
    const det = detectDateFormat(
      dateIdx !== undefined ? rows.map((r) => r[dateIdx] ?? "") : [],
      locale === "en-US" ? "en-US" : "en-GB",
    );
    dateFormat = det.format;
    ambiguousDates = det.ambiguous;
  }
  if (ambiguousDates) {
    issues.push({
      severity: "info",
      category: "defaulted",
      sourcePath: "csv:dates",
      message: `all dates are valid as both day-first and month-first; read as ${dateFormat}`,
      code: "csv.ambiguous-dates",
    });
  }

  const missing = REQUIRED[kind](mapping);
  const analysis: CsvAnalysis = {
    kind,
    delimiter: parsed.delimiter,
    headers,
    rowCount: rows.length,
    preset: preset ? { id: preset.id, name: preset.name } : undefined,
    presetCandidates: candidates.map((p) => ({ id: p.id, name: p.name })),
    locale,
    dateFormat,
    ambiguousDates,
    decimalSeparator,
    columns: mapping,
    confidence: detected.confidence,
    unmapped: detected.unmapped,
    sample: rows.slice(0, 5),
    missing,
    issues,
  };
  const numOpts = {
    locale: numericLocale,
    decimalSeparator: locale === "auto" ? decimalSeparator : options.decimalSeparator,
  };
  const cell = (row: string[], f: Field): string => {
    const i = idx[f];
    return i === undefined ? "" : (row[i] ?? "").trim();
  };
  return {
    analysis,
    rows,
    idx,
    preset,
    cell,
    num: (row, f) => {
      const c = cell(row, f);
      return c === "" ? undefined : parseNumber(c, numOpts);
    },
    date: (row, f) => {
      const c = cell(row, f);
      return c === ""
        ? undefined
        : parseDate(c, { format: dateFormat, locale: locale === "en-US" ? "en-US" : "en-GB" });
    },
  };
}

export function rowIssue(
  line: number,
  severity: ImportIssue["severity"],
  message: string,
  code: string,
  category: ImportIssue["category"] = "invalid",
): ImportIssue {
  return { severity, category, sourcePath: `csv:row:${line}`, message, code };
}

export function missingFieldsIssue(analysis: CsvAnalysis): ImportIssue | undefined {
  if (analysis.missing.length === 0) return undefined;
  return {
    severity: "error",
    category: "invalid",
    sourcePath: "csv:columns",
    message: `could not find a column for: ${analysis.missing.join(", ")}. Map them with \`columns\`.`,
    code: "csv.missing-columns",
  };
}
