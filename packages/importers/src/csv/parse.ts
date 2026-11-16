/** RFC 4180 CSV tokenizer with delimiter sniffing. Pure; no I/O. */

export type Delimiter = "," | ";" | "\t" | "|";

export interface ParsedCsv {
  delimiter: Delimiter;
  /** Raw rows including the header row. Blank lines are dropped. */
  rows: string[][];
}

const CANDIDATES: Delimiter[] = [",", ";", "\t", "|"];

/** Count of unquoted delimiters per line over the first lines, scored for consistency. */
export function sniffDelimiter(text: string): Delimiter {
  const lines = text
    .split(/\r\n|\n|\r/)
    .filter((l) => l.trim() !== "")
    .slice(0, 20);
  let best: Delimiter = ",";
  let bestScore = -1;
  for (const d of CANDIDATES) {
    const counts = lines.map((l) => countUnquoted(l, d));
    const nonZero = counts.filter((c) => c > 0);
    if (nonZero.length === 0) continue;
    const modal = mode(nonZero);
    const consistent = counts.filter((c) => c === modal).length;
    const score = consistent * 100 + modal;
    if (score > bestScore) {
      best = d;
      bestScore = score;
    }
  }
  return best;
}

function countUnquoted(line: string, d: string): number {
  let inQuotes = false;
  let n = 0;
  for (const ch of line) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === d && !inQuotes) n += 1;
  }
  return n;
}

function mode(xs: number[]): number {
  const m = new Map<number, number>();
  for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
  let best = xs[0] ?? 0;
  let bestN = 0;
  for (const [k, v] of m) {
    if (v > bestN) {
      best = k;
      bestN = v;
    }
  }
  return best;
}

export function parseCsv(text: string, delimiter?: Delimiter): ParsedCsv {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const d = delimiter ?? sniffDelimiter(src);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const pushField = (): void => {
    row.push(field);
    field = "";
  };
  const pushRow = (): void => {
    pushField();
    if (row.some((f) => f.trim() !== "")) rows.push(row);
    row = [];
  };
  while (i < src.length) {
    const ch = src[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"' && field === "") {
      inQuotes = true;
      i += 1;
    } else if (ch === d) {
      pushField();
      i += 1;
    } else if (ch === "\r") {
      pushRow();
      i += src[i + 1] === "\n" ? 2 : 1;
    } else if (ch === "\n") {
      pushRow();
      i += 1;
    } else {
      field += ch;
      i += 1;
    }
  }
  if (field !== "" || row.length > 0) pushRow();
  return { delimiter: d, rows };
}

/** Serialise rows to CSV (RFC 4180 quoting, CRLF-free `\n` newlines). */
export function toCsv(
  rows: (string | number | boolean | null | undefined)[][],
  delimiter: Delimiter = ",",
): string {
  const esc = (v: string | number | boolean | null | undefined): string => {
    if (v === null || v === undefined) return "";
    let s = typeof v === "number" ? (Number.isFinite(v) ? String(v) : "") : String(v);
    // Neutralise spreadsheet formula injection for text cells.
    if (typeof v === "string" && /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
    return s.includes(delimiter) || s.includes('"') || s.includes("\n") || s.includes("\r")
      ? `"${s.replace(/"/g, '""')}"`
      : s;
  };
  return `${rows.map((r) => r.map(esc).join(delimiter)).join("\n")}\n`;
}
