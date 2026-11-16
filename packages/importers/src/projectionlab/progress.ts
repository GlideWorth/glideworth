/** progress.data[] -> ProgressSnapshot[]. */
import { arr, num, type Obj, obj } from "../util/read.js";
import { approximated, invalid, type PlContext } from "./context.js";

const MS_PER_DAY = 86_400_000;

/**
 * Epoch ms -> local calendar date. The source stamps local midnight, which in UTC lands on the
 * previous evening (or the same morning); rounding to the nearest UTC midnight recovers the
 * intended day for any timezone within +/-12h.
 */
export function msToIsoDate(ms: number): string {
  const days = Math.round(ms / MS_PER_DAY);
  return new Date(days * MS_PER_DAY).toISOString().slice(0, 10);
}

export function mapProgress(ctx: PlContext, raw: unknown, householdId: string): Obj[] {
  const out: Obj[] = [];
  const used = new Set<string>();
  arr(obj(raw).data).forEach((p, i) => {
    const path = `$.progress.data[${i}]`;
    const src = obj(p);
    const ms = num(src.date);
    if (ms === undefined) {
      invalid(ctx, `${path}.date`, "progress point without a date; dropped");
      return;
    }
    const date = msToIsoDate(ms);
    const debt = num(src.debt);
    const loans = num(src.loans);
    // The source's `assets` is PHYSICAL assets only (property, valuables): its net worth is
    // savings + taxable + tax-deferred + tax-free + crypto + assets - debt - loans.
    const physical = num(src.assets);
    const liabilities = (debt ?? 0) + (loans ?? 0);
    const byCategory: Obj = {};
    let financial = 0;
    let anyCategory = false;
    const cat = (key: string, v: unknown): void => {
      const n = num(v);
      if (n === undefined) return;
      byCategory[key] = n;
      if (key !== "debt" && key !== "loans" && key !== "real-assets") financial += n;
      anyCategory = true;
    };
    cat("cash", src.savings);
    cat("taxable", src.taxable);
    cat("tax-deferred", src.taxDeferred);
    cat("tax-free", src.taxFree);
    cat("crypto", src.crypto);
    cat("real-assets", src.assets);
    cat("debt", src.debt);
    cat("loans", src.loans);
    let netWorth = num(src.netWorth);
    if (netWorth === undefined) {
      if (!anyCategory) {
        invalid(ctx, path, "progress point has neither net worth nor balances; dropped");
        return;
      }
      netWorth = financial + (physical ?? 0) - liabilities;
      approximated(
        ctx,
        `${path}.netWorth`,
        "net worth missing; derived as the sum of the balances minus debts and loans",
        "pl.progress-networth",
      );
    }
    const assets = anyCategory ? financial + (physical ?? 0) : netWorth + liabilities;
    if (anyCategory && Math.abs(assets - liabilities - netWorth) > 1)
      approximated(
        ctx,
        `${path}.netWorth`,
        "the recorded net worth differs from the sum of the recorded balances; the recorded net worth is kept",
        "pl.progress-mismatch",
      );
    let id = `progress-${date}`;
    let n = 2;
    while (used.has(id)) id = `progress-${date}-${n++}`;
    used.add(id);
    out.push({
      id,
      householdId,
      date,
      source: "import",
      netWorth,
      assets,
      liabilities,
      byCategory,
    });
  });
  out.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  return out;
}
