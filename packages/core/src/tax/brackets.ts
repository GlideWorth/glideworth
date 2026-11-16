import type { BracketTable } from "../schema/tax.js";

/**
 * Progressive tax on `income` using a bracket table. Thresholds in a 'real' table are indexed by
 * `priceIndex`; `scale` prorates thresholds for partial periods (months / 12).
 * Returns the tax and the marginal rate at `income`.
 */
export function progressiveTax(
  income: number,
  table: BracketTable,
  priceIndex = 1,
  scale = 1,
): { tax: number; marginalRate: number } {
  if (income <= 0) return { tax: 0, marginalRate: table.brackets[0]?.rate ?? 0 };
  const index = table.basis === "real" ? priceIndex : 1;
  const rows = [...table.brackets].sort((a, b) => a.from - b.from);
  let tax = 0;
  let marginal = rows[0]?.rate ?? 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const lo = row.from * index * scale;
    const next = rows[i + 1];
    const hi = next ? next.from * index * scale : Number.POSITIVE_INFINITY;
    if (income <= lo) break;
    tax += (Math.min(income, hi) - lo) * row.rate;
    marginal = row.rate;
  }
  return { tax, marginalRate: marginal };
}
