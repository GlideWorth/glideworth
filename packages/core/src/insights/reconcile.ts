/**
 * "This adds up": an exact reconciliation of one simulated year, for a UI table.
 *
 *   - cash:      every movement through the household cash pool (ledger entries into and out of
 *                'pool'): money in = money out, exactly (shortfall shows up as an inflow from
 *                'Unfunded').
 *   - accounts:  per account, opening + contributions + transfers in + growth + reinvested dividends
 *                - fees - withdrawals - transfers out = closing.
 *   - netWorth:  previous year's closing net worth + change in accounts + change in real-asset
 *                values - change in loans - change in debts = this year's net worth (from year 2).
 *
 * Every `difference` is closing minus the sum of its parts and is ~0 for a consistent projection.
 *
 * Amounts are nominal, or today's money with `basis: 'real'` using the app-wide convention of
 * `toBasis` (ARCHITECTURE §3): flows (cash in and out, contributions, growth, withdrawals...) and the
 * year's opening position are valued at the price level when the year starts (`priceIndexStart`), and
 * closing balances at the year end (`priceIndex`). So every figure equals the same figure elsewhere in
 * the app. The identities then need one more term, `inflation`: the loss of purchasing power, over the
 * year, of the opening position and the year's flows (0 in nominal). `difference` is the nominal
 * difference in closing prices, so a consistent year still balances to ~0.
 */
import { deflator, type PeriodResult, type ProjectionResult } from "../engine/types.js";
import { ScenarioError } from "../errors.js";

export interface ReconcileRow {
  label: string;
  amount: number;
  /** Ledger kind (income, expense, tax, contribution, withdrawal, debt-payment, ...). */
  kind: string;
  /** The other ledger node's entity id (account, debt, asset, income...), when there is one. */
  refId?: string;
}

export interface AccountReconcileRow {
  accountId: string;
  opening: number;
  contributions: number;
  transfersIn: number;
  growth: number;
  dividendsReinvested: number;
  fees: number;
  withdrawals: number;
  transfersOut: number;
  /** Purchasing power lost over the year (today's money only; 0 in nominal). Usually negative. */
  inflation: number;
  closing: number;
  difference: number;
}

export interface YearReconciliation {
  periodIndex: number;
  year: number;
  basis: "real" | "nominal";
  cash: {
    inflows: ReconcileRow[];
    outflows: ReconcileRow[];
    totalIn: number;
    totalOut: number;
    difference: number;
  };
  accounts: { rows: AccountReconcileRow[]; total: Omit<AccountReconcileRow, "accountId"> };
  /** Null for the first year (opening real-asset values are not part of the result). */
  netWorth: {
    opening: number;
    accounts: number;
    realAssets: number;
    loans: number;
    debts: number;
    /** Purchasing power lost over the year on the opening net worth (today's money only; 0 in nominal). */
    inflation: number;
    closing: number;
    difference: number;
  } | null;
  /** True when every difference is within `tolerance` (relative to the year's money moved). */
  balanced: boolean;
  tolerance: number;
}

const POOL = "pool";

function sum<T>(xs: readonly T[], f: (x: T) => number): number {
  let s = 0;
  for (const x of xs) s += f(x);
  return s;
}

/** Reconcile one year of a full (non-lean) projection. */
export function reconcileYear(
  result: ProjectionResult,
  periodIndex: number,
  opts: { basis?: "real" | "nominal"; tolerance?: number } = {},
): YearReconciliation {
  const p: PeriodResult | undefined = result.periods[periodIndex];
  if (!p) throw new ScenarioError(`no period ${periodIndex}`, { periodIndex });
  if (p.ledger.length === 0 && p.totals.income + p.totals.expenses + p.totals.taxes > 0)
    throw new ScenarioError("reconcileYear needs a full (non-lean) projection", { periodIndex });
  const basis = opts.basis ?? "nominal";
  const real = basis === "real";
  /** Flows and the opening position: start-of-year prices. */
  const kStart = real ? 1 / deflator(p, "flow") : 1;
  /** Closing balances and changes in them: end-of-year prices. */
  const kEnd = real ? 1 / deflator(p, "stock") : 1;
  const v = (x: number) => x * kStart;
  const ve = (x: number) => x * kEnd;
  /** Purchasing power of a start-of-year amount lost by the year end. */
  const lost = (nominalAtStart: number) => nominalAtStart * (kEnd - kStart);

  // ---- cash pool, grouped by (kind, other node)
  const nodes = new Map(p.ledgerNodes.map((n) => [n.id, n]));
  const group = (dir: "in" | "out"): ReconcileRow[] => {
    const rows = new Map<string, ReconcileRow>();
    for (const e of p.ledger) {
      const other = dir === "in" ? (e.to === POOL ? e.from : null) : e.from === POOL ? e.to : null;
      if (other === null || other === POOL) continue;
      const key = `${e.kind}|${other}`;
      const node = nodes.get(other);
      const row = rows.get(key);
      if (row) row.amount += v(e.amount);
      else
        rows.set(key, {
          label: node?.label ?? other,
          amount: v(e.amount),
          kind: e.kind,
          ...(node?.refId ? { refId: node.refId } : {}),
        });
    }
    return [...rows.values()].sort((a, b) => b.amount - a.amount);
  };
  const inflows = group("in");
  const outflows = group("out");
  const totalIn = sum(inflows, (r) => r.amount);
  const totalOut = sum(outflows, (r) => r.amount);

  // ---- accounts
  const rows: AccountReconcileRow[] = p.accounts.map((a) => {
    const reinvested = a.dividendsReinvested ?? 0;
    const parts =
      a.opening +
      a.contributions +
      a.transfersIn +
      a.growth +
      reinvested -
      a.fees -
      a.withdrawals -
      a.transfersOut;
    return {
      accountId: a.accountId,
      opening: v(a.opening),
      contributions: v(a.contributions),
      transfersIn: v(a.transfersIn),
      growth: v(a.growth),
      dividendsReinvested: v(reinvested),
      fees: v(a.fees),
      withdrawals: v(a.withdrawals),
      transfersOut: v(a.transfersOut),
      inflation: lost(parts),
      closing: ve(a.closing),
      difference: ve(a.closing - parts),
    };
  });
  const col = (f: (r: AccountReconcileRow) => number) => sum(rows, f);
  const total = {
    opening: col((r) => r.opening),
    contributions: col((r) => r.contributions),
    transfersIn: col((r) => r.transfersIn),
    growth: col((r) => r.growth),
    dividendsReinvested: col((r) => r.dividendsReinvested),
    fees: col((r) => r.fees),
    withdrawals: col((r) => r.withdrawals),
    transfersOut: col((r) => r.transfersOut),
    inflation: col((r) => r.inflation),
    closing: col((r) => r.closing),
    difference: col((r) => r.difference),
  };

  // ---- net worth bridge (needs the previous year's closing state)
  const prev = periodIndex > 0 ? result.periods[periodIndex - 1]! : null;
  let netWorth: YearReconciliation["netWorth"] = null;
  if (prev) {
    const owned = (x: PeriodResult) => x.realAssets.filter((r) => r.owned);
    const accountsNow = sum(p.accounts, (a) => a.closing);
    const accountsBefore = sum(prev.accounts, (a) => a.closing);
    const assetsNow = sum(owned(p), (r) => r.value);
    const assetsBefore = sum(owned(prev), (r) => r.value);
    const loansNow = sum(owned(p), (r) => r.loanBalance);
    const loansBefore = sum(owned(prev), (r) => r.loanBalance);
    const debtsNow = sum(p.debts, (d) => d.closing);
    const debtsBefore = sum(prev.debts, (d) => d.closing);
    // The opening net worth is last year's closing, valued at this year's start prices (as last year
    // showed it); the changes are valued at the year end, with the opening's lost purchasing power.
    const opening = prev.totals.netWorth;
    const parts =
      opening +
      (accountsNow - accountsBefore) +
      (assetsNow - assetsBefore) -
      (loansNow - loansBefore) -
      (debtsNow - debtsBefore);
    const nw = {
      opening: v(opening),
      accounts: ve(accountsNow - accountsBefore),
      realAssets: ve(assetsNow - assetsBefore),
      loans: ve(loansNow - loansBefore),
      debts: ve(debtsNow - debtsBefore),
      inflation: lost(opening),
      closing: ve(p.totals.netWorth),
      difference: ve(p.totals.netWorth - parts),
    };
    netWorth = nw;
  }

  const scale = Math.max(
    1,
    totalIn,
    total.opening,
    total.closing,
    Math.abs(netWorth?.closing ?? 0),
  );
  const tolerance = opts.tolerance ?? 1e-6 * scale;
  const balanced =
    Math.abs(totalIn - totalOut) <= tolerance &&
    rows.every((r) => Math.abs(r.difference) <= tolerance) &&
    (netWorth === null || Math.abs(netWorth.difference) <= tolerance);
  return {
    periodIndex,
    year: p.year,
    basis,
    cash: { inflows, outflows, totalIn, totalOut, difference: totalIn - totalOut },
    accounts: { rows, total },
    netWorth,
    balanced,
    tolerance,
  };
}
