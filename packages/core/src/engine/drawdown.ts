/**
 * Drawdown: cover a cash-flow deficit from accounts (and liquidatable real assets) in drawdown
 * order. Taxes on withdrawals are handled by the settle fixpoint (gross-up by iteration).
 *
 *   - Order: accounts flagged "excess cash" first, then the plan's entries (category / account /
 *     real asset), then anything unmatched in default category order, then liquidatable real assets.
 *   - Within a category: 'ordered' (list order) or 'proportional' to withdrawable balance.
 *   - splitByOwner (couples): each category's withdrawal is split between owners in proportion to
 *     their available balance in that category.
 *   - Cash buffer: cash accounts are only drawn down to the buffer on the first pass; the buffer
 *     is used only after every other source is exhausted.
 *   - UK PCLS: the first time a PCLS pension is drawn, 25% (capped) comes out tax-free first.
 *   - Real assets with `liquidateIfNeeded` (or listed explicitly) are sold whole; proceeds beyond
 *     the need are saved to the leftover account.
 *   - Withdrawals respect liquidity gates (`isWithdrawable`).
 */
import { DEFAULT_DRAWDOWN_ORDER } from "../schema/strategies.js";
import {
  accountNode,
  crystallisePcls,
  deposit,
  isOpen,
  isWithdrawable,
  withdraw,
  withdrawable,
} from "./accounts.js";
import { nominalAtPeriod } from "./amounts.js";
import {
  type AccountState,
  type AssetState,
  addLedger,
  type EngineContext,
  type PeriodState,
  POOL,
} from "./context.js";
import { leftoverTarget } from "./flows.js";
import { sellAsset } from "./realAssets.js";

export type DrawdownGroup =
  | { kind: "accounts"; accounts: AccountState[]; label: string }
  | { kind: "asset"; asset: AssetState };

/** Static drawdown order (accounts/assets do not change identity during a run). */
export function buildDrawdownGroups(ctx: EngineContext): DrawdownGroup[] {
  const out: DrawdownGroup[] = [];
  const used = new Set<AccountState>();
  const usedAssets = new Set<AssetState>();
  const s = ctx.plan.drawdown;
  const pushAccounts = (accounts: AccountState[], label: string) => {
    const fresh = accounts.filter((a) => !used.has(a));
    for (const a of fresh) used.add(a);
    if (fresh.length > 0) out.push({ kind: "accounts", accounts: fresh, label });
  };
  const pushAsset = (r: AssetState | undefined) => {
    if (!r || usedAssets.has(r)) return;
    usedAssets.add(r);
    out.push({ kind: "asset", asset: r });
  };
  pushAccounts(
    ctx.accounts.filter((a) => a.behaviour.isExcessCash),
    "excess-cash",
  );
  const entries = [...s.order];
  if (!entries.some((e) => e.kind === "category" && e.category === "real-assets"))
    entries.push({ kind: "category", category: "real-assets" });
  for (const e of entries) {
    if (e.kind === "account")
      pushAccounts(
        ctx.accounts.filter((a) => a.def.id === e.accountId),
        e.accountId,
      );
    else if (e.kind === "realAsset") pushAsset(ctx.assets.find((r) => r.def.id === e.assetId));
    else if (e.category === "real-assets") {
      // Unmatched accounts go before the real assets.
      for (const d of DEFAULT_DRAWDOWN_ORDER)
        if (d.kind === "category" && d.category !== "real-assets")
          pushAccounts(
            ctx.accounts.filter((a) => a.category === d.category),
            d.category,
          );
      for (const r of ctx.assets) if (r.behaviour.liquidateIfNeeded) pushAsset(r);
    } else
      pushAccounts(
        ctx.accounts.filter((a) => a.category === e.category),
        e.category,
      );
  }
  pushAccounts(ctx.accounts, "other");
  return out;
}

/** Save cash that arrived in the pool beyond the need (liquidation, PCLS lump sum). */
function stash(ctx: EngineContext, ps: PeriodState, amount: number): void {
  if (amount <= 1e-12) return;
  const t = leftoverTarget(ctx, ps);
  if (!t) return;
  deposit(t, amount);
  addLedger(ctx, ps, { from: POOL, to: accountNode(ps, t), amount, kind: "leftover" });
}

export function drawdown(ctx: EngineContext, ps: PeriodState, need: number): number {
  let remaining = need;
  const s = ctx.plan.drawdown;
  const buffer = s.cashBuffer ? nominalAtPeriod(ps, s.cashBuffer) : 0;
  let cashUsable = Number.POSITIVE_INFINITY;
  if (buffer > 0) {
    let cash = 0;
    for (const a of ctx.accounts)
      if (a.category === "cash" && isOpen(ctx, a, ps)) cash += Math.max(0, a.balance);
    cashUsable = Math.max(0, cash - buffer);
  }
  let position = 0;

  const available = (a: AccountState, capCash: boolean) => {
    const bal = withdrawable(ctx, ps, a);
    return capCash && a.category === "cash" ? Math.min(bal, cashUsable) : bal;
  };

  const take = (accounts: AccountState[], amount: number, capCash: boolean): number => {
    let got = 0;
    if (s.withinCategory === "proportional") {
      const avail = accounts.map((a) => available(a, capCash));
      const total = avail.reduce((x, y) => x + y, 0);
      if (total <= 0) return 0;
      const want = Math.min(amount, total);
      accounts.forEach((a, i) => {
        const w = (want * avail[i]!) / total;
        const r = withdraw(ctx, ps, a, w, { purpose: "drawdown", position, need });
        if (capCash && a.category === "cash") cashUsable -= r.gross;
        got += r.gross;
      });
      return got;
    }
    for (const a of accounts) {
      if (got >= amount - 1e-9) break;
      const w = Math.min(amount - got, available(a, capCash));
      if (w <= 0) continue;
      const r = withdraw(ctx, ps, a, w, { purpose: "drawdown", position, need });
      if (capCash && a.category === "cash") cashUsable -= r.gross;
      got += r.gross;
    }
    return got;
  };

  const pass = (capCash: boolean, onlyCash: boolean) => {
    for (const g of ctx.drawdownGroups) {
      if (remaining <= 1e-9) return;
      position += 1;
      if (g.kind === "asset") {
        if (onlyCash || !g.asset.owned) continue;
        const cash = sellAsset(ctx, ps, g.asset, "liquidation");
        g.asset.done = true;
        remaining -= cash;
        if (remaining < 0) {
          stash(ctx, ps, -remaining);
          remaining = 0;
        }
        continue;
      }
      const accounts = g.accounts.filter(
        (a) =>
          (!onlyCash || a.category === "cash") &&
          isOpen(ctx, a, ps) &&
          a.balance > 0 &&
          isWithdrawable(ctx, a, ps),
      );
      if (accounts.length === 0) continue;
      for (const a of accounts) {
        if (a.behaviour.ukDrawdownMethod !== "pcls" || a.pclsTaken) continue;
        remaining -= crystallisePcls(ctx, ps, a);
        if (remaining < 0) {
          stash(ctx, ps, -remaining);
          remaining = 0;
          return;
        }
      }
      if (s.splitByOwner && ctx.people.length > 1) {
        const owners = [...new Set(accounts.map((a) => a.owner))];
        const avail = owners.map((o) =>
          accounts.filter((a) => a.owner === o).reduce((x, a) => x + available(a, capCash), 0),
        );
        const total = avail.reduce((x, y) => x + y, 0);
        if (total <= 0) continue;
        const want = Math.min(remaining, total);
        let got = 0;
        owners.forEach((o, i) => {
          got += take(
            accounts.filter((a) => a.owner === o),
            (want * avail[i]!) / total,
            capCash,
          );
        });
        remaining -= got;
      } else remaining -= take(accounts, remaining, capCash);
    }
  };

  pass(buffer > 0, false);
  if (remaining > 1e-9 && buffer > 0) pass(false, true);
  return Math.max(0, remaining);
}

/**
 * Pay lines marked "pay from specific accounts" (expenses, debts, purchases) from those accounts
 * first: ordered by the global drawdown hierarchy, list order within the same account rank. The
 * cash enters the pool, where the line is paid as usual. Returns the cash raised.
 */
export function payTargeted(ctx: EngineContext, ps: PeriodState): number {
  let raised = 0;
  for (const t of ps.targeted) {
    let need = t.line.requested;
    const accounts = t.accountIds
      .map((id, i) => ({ a: ctx.accountById.get(id)!, i }))
      .filter((x) => x.a)
      .sort((x, y) => {
        const cx = ctx.drawdownCategoryRank.get(x.a.category) ?? 99;
        const cy = ctx.drawdownCategoryRank.get(y.a.category) ?? 99;
        return cx !== cy ? cx - cy : x.i - y.i;
      });
    for (const { a } of accounts) {
      if (need <= 1e-9) break;
      if (!isOpen(ctx, a, ps) || a.balance <= 0 || !isWithdrawable(ctx, a, ps)) continue;
      if (a.behaviour.ukDrawdownMethod === "pcls" && !a.pclsTaken) {
        const lump = crystallisePcls(ctx, ps, a);
        raised += lump;
        need -= lump;
        if (need <= 0) {
          need = 0;
          break;
        }
      }
      const r = withdraw(ctx, ps, a, need, { purpose: "targeted", causeId: t.line.sourceId });
      raised += r.gross;
      need -= r.gross;
    }
  }
  return raised;
}
