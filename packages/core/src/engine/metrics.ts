/** Derived per-period metrics that depend on user settings (presentation-level, pure). */
import type { UserSettings } from "../schema/progress-settings.js";
import type { PeriodResult } from "./types.js";

/**
 * Effective tax rate of a period under the user's definition (UserSettings.effectiveTaxRate):
 * local and payroll taxes optionally excluded, property taxes optionally included, and the
 * denominator gross income plus the optional non-taxable inflows (`income`): tax-free income lines,
 * withdrawals from cash / taxable / tax-free accounts (principal, approximately) and asset sale
 * proceeds. Null when the denominator is zero.
 */
export function effectiveTaxRate(
  p: PeriodResult,
  def?: Partial<UserSettings["effectiveTaxRate"]>,
): number | null {
  const includeLocal = def?.includeLocal ?? true;
  const includePayroll = def?.includePayroll ?? true;
  const includeProperty = def?.includeProperty ?? false;
  let taxes = p.taxes.total;
  for (const l of p.taxes.lines) {
    const local = l.kind === "local" || l.jurisdictionId.startsWith("us-local");
    if (!includeLocal && local) taxes -= l.amount;
    else if (!includePayroll && (l.kind === "payroll" || l.kind === "self-employment"))
      taxes -= l.amount;
  }
  if (includeProperty)
    for (const e of p.expenses) if (e.sourceId.endsWith(":property-tax")) taxes += e.funded;
  let denom = p.taxes.grossIncome;
  const inc = def?.income;
  if (inc?.taxFreeDistributions)
    for (const i of p.income)
      if (i.taxCharacter === "tax-free" && i.sourceKind !== "asset-sale") denom += i.amount;
  if (inc?.nonTaxableSaleProceeds)
    for (const i of p.income) if (i.sourceKind === "asset-sale") denom += i.amount;
  if (inc?.nonTaxableCapitalWithdrawals)
    for (const a of p.accounts)
      if (
        a.category === "cash" ||
        a.category === "taxable" ||
        a.category === "tax-free" ||
        a.category === "crypto"
      )
        denom += a.withdrawals;
  return denom > 0 ? taxes / denom : null;
}
