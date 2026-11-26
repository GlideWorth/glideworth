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
 *   - Blended entries (opt-in): a `proportional` entry draws its accounts together in proportion
 *     to their withdrawable balances; a `fillToCeiling` entry draws pre-tax accounts only while
 *     taxable income stays within a ceiling taken from the tax tables (a bracket rate) or set by the
 *     user (an income), then passes the rest of the need on. Both record the rule on the ledger.
 */
import {
  DEFAULT_DRAWDOWN_ORDER,
  type DrawdownCeiling,
  describeDrawdownCeiling,
} from "../schema/strategies.js";
import { runTaxStack, withExtraIncome } from "../tax/analytics.js";
import { incomeHeadroom, type TaxTarget, targetSatisfied } from "../tax/strategy.js";
import type { TaxJurisdiction, TaxYearInput } from "../tax/types.js";
import {
  accountNode,
  crystallisePcls,
  deposit,
  grossForTaxable,
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
  fmt,
  type PeriodState,
  POOL,
  traceEvent,
  warnOnce,
} from "./context.js";
import { leftoverTarget } from "./flows.js";
import { sellAsset } from "./realAssets.js";
import type { LedgerEntry } from "./types.js";
import { buildTaxInput } from "./settle.js";

export type DrawdownGroup =
  | {
      kind: "accounts";
      accounts: AccountState[];
      label: string;
      /** Set for a `proportional` entry: its 1-based position in the plan's order. */
      proportionalEntry?: number;
    }
  | { kind: "asset"; asset: AssetState }
  | { kind: "fill"; accounts: AccountState[]; ceiling: DrawdownCeiling; entry: number };

/** Static drawdown order (accounts/assets do not change identity during a run). */
export function buildDrawdownGroups(ctx: EngineContext): DrawdownGroup[] {
  const out: DrawdownGroup[] = [];
  const used = new Set<AccountState>();
  const usedAssets = new Set<AssetState>();
  const s = ctx.plan.drawdown;
  const pushAccounts = (accounts: AccountState[], label: string, proportionalEntry?: number) => {
    const fresh = accounts.filter((a) => !used.has(a));
    for (const a of fresh) used.add(a);
    if (fresh.length > 0)
      out.push({
        kind: "accounts",
        accounts: fresh,
        label,
        ...(proportionalEntry !== undefined ? { proportionalEntry } : {}),
      });
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
  for (const [i, e] of entries.entries()) {
    if (e.kind === "proportional")
      pushAccounts(
        e.accountIds.map((id) => ctx.accountById.get(id)).filter((a): a is AccountState => !!a),
        "proportional",
        i + 1,
      );
    else if (e.kind === "fillToCeiling") {
      // The accounts stay available to later entries (what the ceiling leaves is drawn there).
      const accounts =
        e.accountIds.length > 0
          ? e.accountIds.map((id) => ctx.accountById.get(id)).filter((a): a is AccountState => !!a)
          : ctx.accounts.filter((a) => a.info.taxTreatment === "tax-deferred");
      if (accounts.length > 0)
        out.push({ kind: "fill", accounts, ceiling: e.ceiling, entry: i + 1 });
    } else if (e.kind === "account")
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

  const take = (
    accounts: AccountState[],
    amount: number,
    capCash: boolean,
    rule?: LedgerEntry["rule"],
  ): number => {
    let got = 0;
    if (s.withinCategory === "proportional" || rule) {
      const avail = accounts.map((a) => available(a, capCash));
      const total = avail.reduce((x, y) => x + y, 0);
      if (total <= 0) return 0;
      const want = Math.min(amount, total);
      accounts.forEach((a, i) => {
        const w = (want * avail[i]!) / total;
        const r = withdraw(ctx, ps, a, w, {
          purpose: "drawdown",
          position,
          need,
          ...(rule ? { rule } : {}),
        });
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
      if (g.kind === "fill" && onlyCash) continue;
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
      if (g.kind === "fill") {
        remaining -= fillToCeiling(ctx, ps, g, accounts, remaining, (a) => available(a, false), {
          position,
          need,
        });
        continue;
      }
      if (g.proportionalEntry !== undefined) {
        remaining -= take(accounts, remaining, capCash, {
          kind: "proportional",
          entry: g.proportionalEntry,
        });
        continue;
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
 * Tax measurements of `fillToCeiling`, per period, keyed by the tax input they were taken on. The
 * settle fixpoint re-runs the drawdown several times a period from the same starting state, so the
 * same measurements recur; caching them keeps the entry affordable in Monte Carlo runs.
 */
const fillMemo = new WeakMap<PeriodState, Map<string, number>>();

function taxInputKey(input: TaxYearInput): string {
  let k = "";
  for (const i of input.income) k += `${i.owner}:${i.character}:${i.amount};`;
  k += "|";
  for (const w of input.withdrawals)
    k += `${w.owner}:${w.character}:${w.taxableAmount}:${w.amount};`;
  k += "|";
  for (const d of input.deductions) k += `${d.owner}:${d.amount};`;
  return `${k}|${input.transactions?.purchases}:${input.transactions?.sales}|${input.people.map((x) => (x.activeParticipant ? 1 : 0)).join("")}`;
}

/**
 * A `fillToCeiling` entry: draw from the entry's pre-tax accounts while taxable income stays within
 * the ceiling. Lowest marginal rate first: each round finds, for every owner with money left, the
 * marginal rate of their next unit of ordinary income and the room left in that band (never past the
 * ceiling); the owner with the lowest rate (then the larger balance) draws up to that room, split
 * across their accounts in proportion to balance, grossed up for tax-free parts (UK 25% UFPLS).
 * Room is measured by re-running the tax stack on the period's income so far (src/tax/strategy.ts
 * `incomeHeadroom`), per person where the tax system reports per-person bracket facts (individual
 * taxation) and for the household otherwise. Returns the cash raised.
 */
function fillToCeiling(
  ctx: EngineContext,
  ps: PeriodState,
  g: Extract<DrawdownGroup, { kind: "fill" }>,
  accounts: AccountState[],
  wanted: number,
  available: (a: AccountState) => number,
  at: { position: number; need: number },
): number {
  const stack: TaxJurisdiction[] = ps.stack.filter((j) => j.status === "implemented");
  const words = describeDrawdownCeiling(g.ceiling);
  if (stack.length === 0) {
    warnOnce(ctx, `fill-no-tax:${g.entry}`, {
      code: "ASSUMPTION",
      severity: "warning",
      message: `Drawdown entry ${g.entry} (fill to the ${words}) needs a tax estimate for your country; with none available it draws nothing and the next entry pays.`,
      periodIndex: ps.bounds.index,
      refs: g.accounts.map((a) => a.def.id),
    });
    return 0;
  }
  const ceiling: TaxTarget =
    g.ceiling.kind === "bracket"
      ? { kind: "bracket", rate: g.ceiling.rate }
      : {
          kind: "income",
          amount: nominalAtPeriod(ps, g.ceiling.amount) * (ps.bounds.months / 12),
        };
  let memo = fillMemo.get(ps);
  if (!memo) fillMemo.set(ps, (memo = new Map()));
  const cached = (key: string, compute: () => number): number => {
    let v = memo.get(key);
    if (v === undefined) memo.set(key, (v = compute()));
    return v;
  };
  const RATE_MISSING = -1;
  /** Marginal ordinary bracket rate of one more unit of income (RATE_MISSING if not reported). */
  const rateOf = (input: TaxYearInput, key: string, who: string | undefined) =>
    cached(`rate|${who ?? ""}|${key}`, () => {
      const f: Record<string, number> = {};
      for (const o of runTaxStack(stack, withExtraIncome(input, "ordinary", 1, who)))
        Object.assign(f, o.facts);
      if (who === undefined && !ctx.people.every((p) => `tax.ordinaryBracketRate.${p.id}` in f))
        memo.set(`joint|${key}`, 1);
      return (
        (who ? f[`tax.ordinaryBracketRate.${who}`] : undefined) ??
        f["tax.ordinaryBracketRate"] ??
        RATE_MISSING
      );
    });
  const fits = (input: TaxYearInput, who: string | undefined, t: TaxTarget, x: number) =>
    targetSatisfied(input, runTaxStack(stack, withExtraIncome(input, "ordinary", x, who)), t, who);
  /** Room under target `t`; a `hint` (the room left after the last draw) is checked with two runs. */
  const roomOf = (
    input: TaxYearInput,
    key: string,
    who: string | undefined,
    t: TaxTarget,
    hint?: number,
  ) =>
    cached(`room|${who ?? ""}|${JSON.stringify(t)}|${key}`, () =>
      hint !== undefined && hint >= 1 && fits(input, who, t, hint) && !fits(input, who, t, hint + 1)
        ? hint
        : incomeHeadroom(stack, input, t, who ? { owner: who } : {}),
    );
  const hints = new Map<string, number>();

  const first = buildTaxInput(ctx, ps);
  const firstKey = taxInputKey(first);
  if (g.ceiling.kind === "bracket" && rateOf(first, firstKey, undefined) === RATE_MISSING) {
    warnOnce(ctx, `fill-no-bracket:${g.entry}`, {
      code: "ASSUMPTION",
      severity: "warning",
      message: `Drawdown entry ${g.entry} (fill to the ${words}): this tax system does not report tax bands, so the entry draws nothing; use an income ceiling instead.`,
      periodIndex: ps.bounds.index,
      refs: g.accounts.map((a) => a.def.id),
    });
    return 0;
  }
  // Individual taxation: every person has their own bracket fact.
  const individual = !memo.has(`joint|${firstKey}`);
  const people = new Set(ctx.people.map((p) => p.id));
  const owners = [...new Set(accounts.map((a) => a.owner))];
  const done = new Set<string>();
  let got = 0;
  for (let round = 0; round < 40 && wanted - got > 1e-6; round++) {
    const input = round === 0 ? first : buildTaxInput(ctx, ps);
    const key = round === 0 ? firstKey : taxInputKey(input);
    let best: {
      owner: string;
      who: string | undefined;
      accs: AccountState[];
      balance: number;
      rate: number;
      room: number;
    } | null = null;
    for (const owner of owners) {
      if (done.has(owner)) continue;
      const accs = accounts.filter((a) => a.owner === owner && available(a) > 1e-9);
      const balance = accs.reduce((x, a) => x + available(a), 0);
      const who = individual && people.has(owner) ? owner : undefined;
      const rate = balance > 1e-9 ? Math.max(0, rateOf(input, key, who)) : 0;
      // Past a bracket ceiling already: nothing more fits for this owner.
      if (balance <= 1e-9 || (ceiling.kind === "bracket" && rate > ceiling.rate + 1e-12)) {
        done.add(owner);
        continue;
      }
      // The room left in the owner's current band, never past the ceiling.
      const band: TaxTarget = { kind: "bracket", rate };
      let room = roomOf(input, key, who, band, hints.get(`${who ?? ""}|${rate}`));
      hints.set(`${who ?? ""}|${rate}`, room);
      if (ceiling.kind === "income") {
        const left = roomOf(input, key, who, ceiling, hints.get(`${who ?? ""}|ceiling`));
        hints.set(`${who ?? ""}|ceiling`, left);
        room = Math.min(room, left);
      }
      if (room < 1) {
        done.add(owner);
        continue;
      }
      if (
        !best ||
        rate < best.rate - 1e-12 ||
        (Math.abs(rate - best.rate) <= 1e-12 && balance > best.balance + 1e-9)
      )
        best = { owner, who, accs, balance, rate, room };
    }
    if (!best) break;
    const b = best;
    // Gross up so the taxable part of the draw fills the room (tax-free parts use none of it).
    let taxableShare = 0;
    for (const a of b.accs)
      taxableShare += (available(a) / b.balance) * (b.room / grossForTaxable(ctx, ps, a, b.room));
    const amount = Math.min(wanted - got, b.room / Math.max(taxableShare, 1e-6), b.balance);
    const rule: LedgerEntry["rule"] = {
      kind: "fill-to-ceiling",
      entry: g.entry,
      ...(b.who ? { owner: b.who } : {}),
      ceiling: words,
      bandRate: b.rate,
      room: b.room,
    };
    let gross = 0;
    let taxable = 0;
    for (const a of b.accs) {
      const r = withdraw(ctx, ps, a, (amount * available(a)) / b.balance, {
        purpose: "drawdown",
        position: at.position,
        need: at.need,
        rule,
      });
      gross += r.gross;
      taxable += r.taxable;
    }
    if (gross <= 1e-9) {
      done.add(b.owner);
      continue;
    }
    got += gross;
    // The room left for the next round, if nothing else moves: checked, not trusted.
    for (const k of [`${b.who ?? ""}|${b.rate}`, `${b.who ?? ""}|ceiling`]) {
      const h = hints.get(k);
      if (h !== undefined) hints.set(k, h - taxable);
    }
    traceEvent(
      ctx,
      ps,
      "drawdown",
      "DRAWDOWN_FILL",
      () =>
        `Drew ${fmt(gross)} from ${b.accs.map((a) => a.def.name).join(", ")} (${fmt(taxable)} taxable) to fill ${b.who ? `${b.who}'s` : "the household's"} ${+(b.rate * 100).toFixed(2)}% band toward the ${words}; room before ${fmt(b.room)} (drawdown entry ${g.entry})`,
      b.accs.map((a) => a.def.id),
      { amount: gross, taxable, room: b.room, bandRate: b.rate, entry: g.entry, owner: b.who },
    );
  }
  return got;
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
