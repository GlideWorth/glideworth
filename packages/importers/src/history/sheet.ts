/**
 * Turn pasted cells or a CSV/TSV file into one shape: a list of dated records, each with one cell per series
 * (account column). Three layouts are understood:
 *  - `rows`:    one row per date, one column per account (the usual spreadsheet).
 *  - `columns`: one column per date, one row per account (the same sheet turned on its side).
 *  - `long`:    one row per date and account (`date, account, balance`), as many apps export.
 */
import { type Delimiter, parseCsv, sniffDelimiter } from "../csv/parse.js";
import { looksLikeDate, readDateCell } from "./dates.js";

export type HistoryLayout = "rows" | "columns" | "long";

export interface SheetOptions {
  delimiter?: Delimiter | "auto";
  layout?: HistoryLayout | "auto";
}

export interface SheetRecord {
  rawDate: string;
  /** Where the date is, spreadsheet style (`A2`). */
  dateRef: string;
  /** One raw cell per series (`""` for a blank or a cell the file does not have). */
  cells: string[];
  /** Where each cell is (`C7`), or `""` when the file has no such cell. */
  refs: string[];
}

export interface HistorySheet {
  delimiter: Delimiter;
  layout: HistoryLayout;
  /** What auto-detection chose (equal to `layout` unless the caller forced one). */
  detectedLayout: HistoryLayout;
  /** The header of the date column (or row), for display. */
  dateLabel: string;
  /** One header per series, in file order. */
  headers: string[];
  records: SheetRecord[];
  /** The file had no header row: series are named after their column. */
  headerless: boolean;
  /** The parsed grid, as rows of raw cells (blank lines dropped). */
  grid: string[][];
}

/** `0 -> A`, `25 -> Z`, `26 -> AA`. */
export function columnName(i: number): string {
  let n = i + 1;
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

const ref = (row: number, col: number) => `${columnName(col)}${row + 1}`;

/** Share of non-blank cells that read as dates. */
function dateShare(cells: readonly string[]): number {
  const filled = cells.filter((c) => c.trim() !== "");
  if (filled.length === 0) return 0;
  return filled.filter((c) => looksLikeDate(c)).length / filled.length;
}

/** Serial-date or year cells only count when nothing else in the file looks like a date. */
function looseDateShare(cells: readonly string[]): number {
  const filled = cells.filter((c) => c.trim() !== "");
  if (filled.length === 0) return 0;
  return (
    filled.filter((c) => {
      const r = readDateCell(c, true);
      return r.kind !== "blank" && r.kind !== "invalid";
    }).length / filled.length
  );
}

const isNumberish = (s: string) =>
  /^[\s(+\-−]*[$£€¥₹]?\s*[\d.,' ]*\d[\d.,' ]*\s*[)]?\s*[A-Za-z]{0,3}$/.test(s.trim());

function widen(grid: string[][]): string[][] {
  const width = Math.max(0, ...grid.map((r) => r.length));
  return grid.map((r) => (r.length < width ? [...r, ...Array(width - r.length).fill("")] : r));
}

interface Orientation {
  layout: HistoryLayout;
  /** Index of the date column (rows/long) or date row (columns). */
  dateIndex: number;
  score: number;
}

function detect(grid: string[][]): Orientation {
  const width = grid[0]?.length ?? 0;
  const body = grid.slice(1);
  const col = (j: number) => body.map((r) => r[j] ?? "");
  // Dates down a column (rows / long): try the first few columns.
  let best: Orientation = { layout: "rows", dateIndex: 0, score: 0 };
  for (let j = 0; j < Math.min(width, 4); j++) {
    const s = dateShare(col(j));
    if (s > best.score + 1e-9) best = { layout: "rows", dateIndex: j, score: s };
  }
  // Dates across the first row (columns layout).
  const across = dateShare((grid[0] ?? []).slice(1));
  if (across > best.score + 1e-9 && across >= 0.5)
    best = { layout: "columns", dateIndex: 0, score: across };
  if (best.score === 0) {
    // Nothing reads as a date without leaning on spreadsheet serials or bare years: look at column A / row 1.
    const down = looseDateShare(col(0));
    const right = looseDateShare((grid[0] ?? []).slice(1));
    if (right > down && right >= 0.5) best = { layout: "columns", dateIndex: 0, score: right };
    else best = { layout: "rows", dateIndex: 0, score: down };
  }
  if (best.layout === "rows" && isLong(grid, best.dateIndex)) best = { ...best, layout: "long" };
  return best;
}

/** Long format: dates repeat down the rows and one other column holds names, another numbers. */
function isLong(grid: string[][], dateIndex: number): boolean {
  const body = grid.slice(1);
  if (body.length < 2) return false;
  const dates = body.map((r) => (r[dateIndex] ?? "").trim()).filter(Boolean);
  const distinct = new Set(dates).size;
  if (distinct === 0 || dates.length < distinct * 1.5) return false;
  return longColumns(grid, dateIndex) !== undefined;
}

function longColumns(
  grid: string[][],
  dateIndex: number,
): { name: number; value: number } | undefined {
  const body = grid.slice(1);
  const width = grid[0]?.length ?? 0;
  let name = -1;
  let value = -1;
  for (let j = 0; j < width; j++) {
    if (j === dateIndex) continue;
    const cells = body.map((r) => (r[j] ?? "").trim()).filter(Boolean);
    if (cells.length === 0) continue;
    const numeric = cells.filter(isNumberish).length / cells.length;
    if (numeric >= 0.8 && value < 0) value = j;
    else if (numeric <= 0.2 && name < 0) name = j;
  }
  return name >= 0 && value >= 0 ? { name, value } : undefined;
}

/** Parse text into a sheet. Layout and delimiter are detected unless given. */
export function readHistorySheet(text: string, options: SheetOptions = {}): HistorySheet {
  const delimiter =
    options.delimiter && options.delimiter !== "auto" ? options.delimiter : sniffDelimiter(text);
  const grid = widen(parseCsv(text, delimiter).rows);
  const auto = detect(grid);
  const layout = options.layout && options.layout !== "auto" ? options.layout : auto.layout;
  // A forced layout keeps the detected date column when it fits, else the first one.
  const dateIndex =
    layout === auto.layout || (layout !== "columns" && auto.layout !== "columns")
      ? auto.dateIndex
      : 0;
  const base = { delimiter, layout, detectedLayout: auto.layout, grid };
  if (grid.length === 0)
    return { ...base, dateLabel: "Date", headers: [], records: [], headerless: false };
  if (layout === "columns") return byColumns(grid, base);
  if (layout === "long") {
    const cols = longColumns(grid, dateIndex);
    if (cols) return byLong(grid, dateIndex, cols, base);
  }
  return byRows(grid, dateIndex, { ...base, layout: "rows" });
}

type Base = Pick<HistorySheet, "delimiter" | "layout" | "detectedLayout" | "grid">;

function byRows(grid: string[][], dateIndex: number, base: Base): HistorySheet {
  const first = grid[0]!;
  // No header row when the first row's date cell is already a date.
  const headerless = looksLikeDate(first[dateIndex] ?? "");
  const start = headerless ? 0 : 1;
  const series = first.map((_, j) => j).filter((j) => j !== dateIndex);
  const headers = series.map((j) =>
    headerless || (first[j] ?? "").trim() === "" ? `Column ${columnName(j)}` : first[j]!.trim(),
  );
  const records: SheetRecord[] = [];
  for (let i = start; i < grid.length; i++) {
    const row = grid[i]!;
    records.push({
      rawDate: (row[dateIndex] ?? "").trim(),
      dateRef: ref(i, dateIndex),
      cells: series.map((j) => row[j] ?? ""),
      refs: series.map((j) => ref(i, j)),
    });
  }
  return {
    ...base,
    dateLabel: headerless
      ? `Column ${columnName(dateIndex)}`
      : (first[dateIndex] ?? "").trim() || "Date",
    headers,
    records,
    headerless,
  };
}

function byColumns(grid: string[][], base: Base): HistorySheet {
  const first = grid[0]!;
  const width = first.length;
  const records: SheetRecord[] = [];
  for (let j = 1; j < width; j++) {
    records.push({
      rawDate: (first[j] ?? "").trim(),
      dateRef: ref(0, j),
      cells: grid.slice(1).map((r) => r[j] ?? ""),
      refs: grid.slice(1).map((_, i) => ref(i + 1, j)),
    });
  }
  return {
    ...base,
    layout: "columns",
    dateLabel: (first[0] ?? "").trim() || "Date",
    headers: grid.slice(1).map((r, i) => (r[0] ?? "").trim() || `Row ${i + 2}`),
    records,
    headerless: false,
  };
}

function byLong(
  grid: string[][],
  dateIndex: number,
  cols: { name: number; value: number },
  base: Base,
): HistorySheet {
  const body = grid.slice(1);
  const names: string[] = [];
  const index = new Map<string, number>();
  for (const r of body) {
    const n = (r[cols.name] ?? "").trim();
    if (n && !index.has(n)) {
      index.set(n, names.length);
      names.push(n);
    }
  }
  // One record per source row with a single cell filled; records sharing a date are combined later.
  const records: SheetRecord[] = body.map((r, i) => {
    const cells = names.map(() => "");
    const refs = names.map(() => "");
    const k = index.get((r[cols.name] ?? "").trim());
    if (k !== undefined) {
      cells[k] = r[cols.value] ?? "";
      refs[k] = ref(i + 1, cols.value);
    }
    return { rawDate: (r[dateIndex] ?? "").trim(), dateRef: ref(i + 1, dateIndex), cells, refs };
  });
  return {
    ...base,
    layout: "long",
    dateLabel: (grid[0]![dateIndex] ?? "").trim() || "Date",
    headers: names,
    records,
    headerless: false,
  };
}
