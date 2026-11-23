/** Value cells of a balance-history file: blank (no value) is kept apart from 0 (a zero balance). */
import { detectDecimalSeparator, parseNumber } from "../csv/locale.js";

export type DecimalChoice = "auto" | "." | ",";

export type AmountRead =
  | { kind: "blank" }
  | { kind: "invalid"; reason: "error-marker" | "unreadable" }
  | { kind: "value"; value: number; dash?: boolean };

/** Spreadsheet error values and placeholders that mean "no number here", not zero. */
const ERROR_MARKER = /^(#[A-Z/0!?]+[!?]?|n\/?a|nan|null|none|undefined)$/i;
/** Accounting formats show zero as a dash: `-`, `$ -`, `£-`, `- €`. */
const DASH_ZERO = /^[\s$£€¥₹]*[-–—][\s$£€¥₹]*$/;

export function readAmount(raw: string, decimal: "." | ","): AmountRead {
  const s = raw.trim();
  if (s === "") return { kind: "blank" };
  if (DASH_ZERO.test(s)) return { kind: "value", value: 0, dash: true };
  if (ERROR_MARKER.test(s)) return { kind: "invalid", reason: "error-marker" };
  // A trailing percent sign means the cell is not a balance.
  if (/%\s*$/.test(s)) return { kind: "invalid", reason: "unreadable" };
  const n = parseNumber(s, { decimalSeparator: decimal });
  return n === undefined || !Number.isFinite(n)
    ? { kind: "invalid", reason: "unreadable" }
    : { kind: "value", value: n };
}

export interface DecimalResolution {
  decimal: "." | ",";
  /** No cell decided the separator and some cells read differently under the other one (`1,234`, `1.234`). */
  ambiguous: boolean;
  detected: "." | "," | undefined;
}

/** Choose the decimal separator for the whole file. An explicit choice always wins. */
export function resolveDecimal(
  values: readonly string[],
  choice: DecimalChoice = "auto",
): DecimalResolution {
  const detected = detectDecimalSeparator(values.filter((v) => v.trim() !== ""));
  if (choice !== "auto") return { decimal: choice, ambiguous: false, detected };
  if (detected) return { decimal: detected, ambiguous: false, detected };
  const ambiguous = values.some((v) => /^[^\d]*\d{1,3}[.,]\d{3}[^\d]*$/.test(v.trim()));
  return { decimal: ".", ambiguous, detected };
}
