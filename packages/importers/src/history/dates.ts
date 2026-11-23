/**
 * Date cells of a balance-history file. A cell is first read on its own (`readDateCell`); all-numeric dates
 * such as `03/04/2024` stay unresolved until the whole column has been seen (`resolveDateFormat`), and a column
 * that fits both month-first and day-first is reported as ambiguous instead of guessed.
 */

export type HistoryDateFormat = "auto" | "YMD" | "MDY" | "DMY";
/** Which day a month-only (`Jan 2024`, `2024-01`) or year-only (`2024`) date stands for. */
export type PeriodDay = "end" | "start";

export type DateRead =
  | { kind: "blank" }
  | { kind: "invalid" }
  /** A full date that needs no format choice (ISO, a month name, an Excel serial). */
  | { kind: "exact"; iso: string; how: "iso" | "named" | "serial" }
  /** Month and year only. */
  | { kind: "month"; year: number; month: number }
  /** Year only (an annual tracker). */
  | { kind: "year"; year: number }
  /** `a/b/yyyy`: month-first or day-first, decided for the column. */
  | { kind: "numeric"; a: number; b: number; year: number };

const MONTHS: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function isoDate(y: number, m: number, d: number): string | undefined {
  if (!Number.isInteger(y) || y < 1900 || y > 2200 || m < 1 || m > 12 || d < 1) return undefined;
  if (d > daysInMonth(y, m)) return undefined;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function year4(raw: string): number {
  const y = Number(raw.replace("'", ""));
  if (raw.replace("'", "").length > 2) return y;
  return y < 70 ? 2000 + y : 1900 + y;
}

/** Excel's 1900 date system: serial 1 is 1900-01-01 and serial 60 is the fictitious 1900-02-29. */
export function excelSerialToIso(serial: number): string | undefined {
  const whole = Math.floor(serial);
  if (whole < 1) return undefined;
  const ms = Date.UTC(1899, 11, 30) + whole * 864e5;
  const d = new Date(ms);
  return isoDate(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

/** Excel serials between 1954 and 2119 (`20000`-`80000`): only read as dates where a date is expected. */
const SERIAL = /^(\d{5})(?:\.\d+)?$/;

/** Read one date cell. `allowSerial` lets 5-digit numbers through as Excel serial dates. */
export function readDateCell(raw: string, allowSerial = true): DateRead {
  const s = raw.trim().replace(/\s+/g, " ");
  if (s === "") return { kind: "blank" };
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T ]\d{1,2}:\d{2}.*)?$/.exec(s);
  if (m) {
    const iso = isoDate(Number(m[1]), Number(m[2]), Number(m[3]));
    return iso ? { kind: "exact", iso, how: "iso" } : { kind: "invalid" };
  }
  m = /^(\d{4})[-/.](\d{1,2})$/.exec(s) ?? null;
  if (m) return month(Number(m[1]), Number(m[2]));
  m = /^(\d{1,2})[-/.](\d{4})$/.exec(s);
  if (m) return month(Number(m[2]), Number(m[1]));
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})(?:[T ]\d{1,2}:\d{2}.*)?$/.exec(s);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const y = year4(m[3]!);
    if (a < 1 || b < 1 || a > 31 || b > 31 || (a > 12 && b > 12)) return { kind: "invalid" };
    return { kind: "numeric", a, b, year: y };
  }
  // "15 Jan 2024", "15-Jan-24", "1st March 2024"
  m = /^(\d{1,2})(?:st|nd|rd|th)?[ \-/.]([A-Za-z]{3,9})\.?[ \-/.,]+(\d{4}|'?\d{2})$/.exec(s);
  if (m) return named(year4(m[3]!), m[2]!, Number(m[1]));
  // "Jan 15, 2024", "January 15 2024"
  m = /^([A-Za-z]{3,9})\.? (\d{1,2})(?:st|nd|rd|th)?,? (\d{4})$/.exec(s);
  if (m) return named(Number(m[3]), m[1]!, Number(m[2]));
  // "Jan 2024", "January 2024", "Jan-24", "Jan '24", "jan/2024"
  m = /^([A-Za-z]{3,9})\.?[ \-/,]*('?\d{2}|\d{4})$/.exec(s);
  if (m) {
    const mon = MONTHS[m[1]!.toLowerCase()];
    return mon ? month(year4(m[2]!), mon) : { kind: "invalid" };
  }
  // "2024 Jan", "2024-January"
  m = /^(\d{4})[ \-/]([A-Za-z]{3,9})\.?$/.exec(s);
  if (m) {
    const mon = MONTHS[m[2]!.toLowerCase()];
    return mon ? month(Number(m[1]), mon) : { kind: "invalid" };
  }
  m = /^(19\d{2}|2[01]\d{2})$/.exec(s);
  if (m) return { kind: "year", year: Number(m[1]) };
  m = SERIAL.exec(s);
  if (m && allowSerial) {
    const n = Number(m[1]);
    if (n >= 20000 && n <= 80000) {
      const iso = excelSerialToIso(n);
      if (iso) return { kind: "exact", iso, how: "serial" };
    }
  }
  return { kind: "invalid" };
}

function month(year: number, mon: number): DateRead {
  return mon >= 1 && mon <= 12 && year >= 1900 && year <= 2200
    ? { kind: "month", year, month: mon }
    : { kind: "invalid" };
}

function named(year: number, monthName: string, day: number): DateRead {
  const mon = MONTHS[monthName.toLowerCase()];
  const iso = mon ? isoDate(year, mon, day) : undefined;
  return iso ? { kind: "exact", iso, how: "named" } : { kind: "invalid" };
}

/** True when the cell reads as a date without leaning on Excel serials (used to find the date column). */
export function looksLikeDate(raw: string): boolean {
  const r = readDateCell(raw, false);
  return r.kind !== "blank" && r.kind !== "invalid" && r.kind !== "year";
}

export interface DateFormatResolution {
  /** The format applied to all-numeric dates, or null when there are none or it is still undecided. */
  format: "MDY" | "DMY" | "YMD" | null;
  /** Numeric dates fit both month-first and day-first and the user has not chosen. Blocks the import. */
  ambiguous: boolean;
  /** Some dates only fit month-first and others only day-first. */
  conflict: boolean;
  /** Under `auto`: what the cells decided (one reading was impossible for some date). */
  detected: "MDY" | "DMY" | null;
  /**
   * For an ambiguous column: the reading under which the dates run in order at an even spacing. Shown to the
   * user as a suggestion; it is never applied without a choice.
   */
  suggestion?: "MDY" | "DMY";
  /** How many all-numeric dates the column has. */
  numeric: number;
}

/** Decide month-first vs day-first for a column of reads. An explicit choice always wins. */
export function resolveDateFormat(
  reads: readonly DateRead[],
  choice: HistoryDateFormat = "auto",
): DateFormatResolution {
  const nums = reads.filter(
    (r): r is Extract<DateRead, { kind: "numeric" }> => r.kind === "numeric",
  );
  let onlyMdy = 0;
  let onlyDmy = 0;
  for (const r of nums) {
    const mdy = isoDate(r.year, r.a, r.b);
    const dmy = isoDate(r.year, r.b, r.a);
    if (mdy && !dmy) onlyMdy++;
    else if (dmy && !mdy) onlyDmy++;
  }
  const conflict = onlyMdy > 0 && onlyDmy > 0;
  const detected: "MDY" | "DMY" | null = conflict
    ? null
    : onlyMdy > 0
      ? "MDY"
      : onlyDmy > 0
        ? "DMY"
        : null;
  const base = { conflict, detected, numeric: nums.length };
  if (choice !== "auto") return { ...base, format: choice, ambiguous: false };
  if (nums.length === 0) return { ...base, format: null, ambiguous: false };
  if (detected) return { ...base, format: detected, ambiguous: false };
  if (conflict) return { ...base, format: null, ambiguous: false };
  const suggestion = suggestReading(nums);
  return { ...base, format: null, ambiguous: true, ...(suggestion ? { suggestion } : {}) };
}

/** The reading (if exactly one) under which the dates are sorted and evenly spaced. */
function suggestReading(
  nums: readonly Extract<DateRead, { kind: "numeric" }>[],
): "MDY" | "DMY" | undefined {
  if (nums.length < 3) return undefined;
  const regular = (f: "MDY" | "DMY") => {
    const t = nums.map((r) =>
      Date.parse(
        `${f === "MDY" ? isoDate(r.year, r.a, r.b) : isoDate(r.year, r.b, r.a)}T00:00:00Z`,
      ),
    );
    const gaps = t.slice(1).map((x, i) => x - t[i]!);
    if (gaps.some((g) => !Number.isFinite(g))) return false;
    const up = gaps.every((g) => g > 0);
    const down = gaps.every((g) => g < 0);
    if (!up && !down) return false;
    const days = gaps.map((g) => Math.abs(g) / 864e5);
    const lo = Math.min(...days);
    const hi = Math.max(...days);
    // Weekly or longer evenly spaced, monthly (28-31 days), quarterly (89-92) or yearly (365-366) steps.
    return (
      (lo >= 6 && hi - lo <= 3) ||
      (lo >= 28 && hi <= 31) ||
      (lo >= 89 && hi <= 92) ||
      (lo >= 365 && hi <= 366)
    );
  };
  const m = regular("MDY");
  const d = regular("DMY");
  return m && !d ? "MDY" : d && !m ? "DMY" : undefined;
}

export interface DateFinish {
  iso?: string;
  severity?: "error" | "warning" | "info";
  code?: string;
  message?: string;
}

/**
 * Turn one read into an ISO date under the column's format. Errors: unreadable, ambiguous, impossible under
 * the chosen format, in the future. A month or year whose end is after `today` is dated `today`.
 */
export function finishDate(
  read: DateRead,
  format: DateFormatResolution,
  periodDay: PeriodDay,
  today: string,
): DateFinish {
  let iso: string | undefined;
  let clampable = false;
  switch (read.kind) {
    case "blank":
      return { severity: "error", code: "history.date.missing", message: "no date" };
    case "invalid":
      return {
        severity: "error",
        code: "history.date.invalid",
        message: "not a date this importer can read",
      };
    case "exact":
      iso = read.iso;
      break;
    case "month":
      iso =
        periodDay === "start"
          ? isoDate(read.year, read.month, 1)
          : isoDate(read.year, read.month, daysInMonth(read.year, read.month));
      clampable = true;
      break;
    case "year":
      iso = periodDay === "start" ? isoDate(read.year, 1, 1) : isoDate(read.year, 12, 31);
      clampable = true;
      break;
    case "numeric": {
      if (format.ambiguous || format.format === null)
        return {
          severity: "error",
          code: format.conflict ? "history.date.conflict" : "history.date.ambiguous",
          message: format.conflict
            ? "some dates only work month-first and others only day-first; choose the date format"
            : "could be month-first or day-first; choose the date format",
        };
      if (format.format === "YMD")
        return {
          severity: "error",
          code: "history.date.format",
          message: "is not a year-first date",
        };
      iso =
        format.format === "MDY"
          ? isoDate(read.year, read.a, read.b)
          : isoDate(read.year, read.b, read.a);
      if (!iso)
        return {
          severity: "error",
          code: "history.date.format",
          message: `is not a valid ${format.format === "MDY" ? "month/day/year" : "day/month/year"} date`,
        };
      break;
    }
  }
  if (!iso) return { severity: "error", code: "history.date.invalid", message: "not a valid date" };
  if (iso > today) {
    if (clampable && (periodDay === "end" ? startOf(read) <= today : false))
      return {
        iso: today,
        severity: "info",
        code: "history.date.period-today",
        message: "the period has not ended yet; dated today",
      };
    return { severity: "error", code: "history.date.future", message: "is in the future" };
  }
  if (read.kind === "exact" && read.how === "serial")
    return {
      iso,
      severity: "info",
      code: "history.date.serial",
      message: `read as a spreadsheet serial date (${iso})`,
    };
  return { iso };
}

function startOf(read: DateRead): string {
  if (read.kind === "month") return isoDate(read.year, read.month, 1) ?? "9999";
  if (read.kind === "year") return isoDate(read.year, 1, 1) ?? "9999";
  return "9999";
}
