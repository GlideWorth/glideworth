/**
 * Which published US table applies in a plan year, and the factor that indexes its dollar amounts.
 *
 * - legislated (default): the latest table published for a year at or before the plan year, as
 *   published; later years index it with the plan's price index since the start of the table's
 *   year (read from the period history; the plan start when the table predates the plan).
 * - indexed: the table of the plan's first year, indexed with the plan's price index, so that
 *   thresholds keep their real value from the plan start.
 * - frozen: the latest published table, never indexed.
 */
import { pickYear, thresholdPolicy } from "../common.js";
import type { TaxYearInput } from "../types.js";

export function usTable<T extends { startYear: number }>(
  rows: readonly T[],
  input: Pick<TaxYearInput, "year" | "priceIndex" | "history" | "config">,
): { row: T; factor: number } {
  const policy = thresholdPolicy(input as TaxYearInput);
  if (policy === "indexed") {
    const firstYear = input.history[0]?.["tax.year"] ?? input.year;
    return { row: pickYear(rows, firstYear), factor: input.priceIndex };
  }
  const row = pickYear(rows, input.year);
  if (policy === "frozen" || input.year <= row.startYear) return { row, factor: 1 };
  // Price index at the start of the table's year: the history is ordered, newest last.
  const h = input.history;
  for (let i = h.length - 1; i >= 0; i--) {
    const y = h[i]!["tax.year"];
    if (y === undefined || y < row.startYear) break;
    if (y === row.startYear) {
      const anchor = h[i]!["tax.priceIndex"];
      if (anchor !== undefined && anchor > 0) return { row, factor: input.priceIndex / anchor };
    }
  }
  return { row, factor: input.priceIndex };
}
