/**
 * spending.strategy phase: textbook withdrawal strategies (Withdrawal Strategy mode) and flexible
 * spending (drawdown-from-all-time-high rules). The rule maths are workstream (d)'s pure functions
 * (`solvers/withdrawal-rules.ts`); this module supplies their state and applies the result.
 *
 * Withdrawal Strategy mode (from `start`):
 *   - the strategy computes an annual amount W from the portfolio (all open accounts' opening
 *     balances) and its own state;
 *   - plan expense EVENTS are replaced by one 'Withdrawal strategy spending' line; scheduled debt
 *     and loan payments and real-asset costs remain and come out of the same budget;
 *   - budget = W ('reduce-withdrawals': other income reduces what is withdrawn) or W + income
 *     ('increase-spending');
 *   - unless `treatAsSpending`, taxes are paid out of the budget (W is a gross withdrawal).
 *
 * Flexible spending: performance is a market-only index of the non-cash portfolio (growth +
 * dividends - fees over opening balances; contributions/withdrawals excluded). At each period
 * start the drawdown from the all-time high selects a cut (step or linear between rule points)
 * applied to discretionary spending (and the discretionary share of hybrid lines), or to all
 * expense-event spending for scope 'all' (never debt payments, loan payments or asset costs).
 */
import { computeWithdrawal, flexSpendingCut } from "../solvers/withdrawal-rules.js";
import { isOpen, planBondShare } from "./accounts.js";
import { activeMonths, resolveWindow } from "./amounts.js";
import {
  type EngineContext,
  fmt,
  type PeriodState,
  type StrategyState,
  traceEvent,
  unsupported,
} from "./context.js";
import { resolveRef } from "./milestones.js";
import type { ExpenseLine } from "./types.js";

export function freshStrategyState(): StrategyState {
  return {
    yearIndex: 0,
    initialPortfolio: 0,
    startPriceIndex: 1,
    previous: null,
    lastCpi: 1,
    lastReturn: 0,
    yearsSinceRaise: null,
    ratchetBase: null,
  };
}

function portfolioValue(ctx: EngineContext, ps: PeriodState): number {
  let p = 0;
  for (const a of ctx.accounts) if (isOpen(ctx, a, ps)) p += Math.max(0, a.p.opening);
  return p;
}

function applyWithdrawalStrategy(ctx: EngineContext, ps: PeriodState): void {
  const ws = ctx.plan.withdrawalStrategy;
  if (!ws?.enabled) return;
  const s = resolveRef(ctx, ws.start);
  if (typeof s !== "number" || s >= ps.bounds.end) return;
  const months = activeMonths({ start: s, end: Number.POSITIVE_INFINITY }, ps);
  const st = ctx.strategy;
  const portfolio = portfolioValue(ctx, ps);
  if (st.yearIndex === 0) {
    st.initialPortfolio = portfolio;
    st.startPriceIndex = ps.piStart;
    st.lastCpi = ps.piStart;
  }
  // Rule maths are workstream (d)'s pure functions (solvers/withdrawal-rules.ts).
  const decision = computeWithdrawal(ws, {
    yearIndex: st.yearIndex,
    portfolio,
    initialPortfolio: st.initialPortfolio,
    previousWithdrawal: st.previous,
    lastYearInflation: ps.piStart / st.lastCpi - 1,
    lastYearReturn: st.lastReturn,
    priceIndex: ps.piStart,
    startPriceIndex: st.startPriceIndex,
    remainingYears: Math.max(1, (ctx.endExclusive - ps.bounds.start) / 12),
    stockShare: 1 - planBondShare(ctx, ps.bounds.start),
    yearsSinceRaise: st.yearsSinceRaise,
    ratchetBase: st.ratchetBase,
  });
  const annual = decision.amount;
  st.yearIndex += 1;
  st.previous = annual;
  st.lastCpi = ps.piStart;
  st.yearsSinceRaise = decision.yearsSinceRaise;
  st.ratchetBase = decision.ratchetBase;
  const amount = (annual * months) / 12;
  // Replace expense events with the strategy budget.
  const removed = new Set<ExpenseLine>();
  for (const l of ps.expenseLines)
    if (l.sourceKind === "expense") {
      removed.add(l);
      ps.poolRequired -= l.requested;
    }
  ps.expenseLines = ps.expenseLines.filter((l) => !removed.has(l));
  ps.targeted = ps.targeted.filter((t) => !removed.has(t.line));
  const income = ps.incomeLines
    .filter((l) => l.sourceKind !== "asset-sale")
    .reduce((x, l) => x + l.amount, 0);
  const budget = amount + (ws.incomeHandling === "increase-spending" ? income : 0);
  const line: ExpenseLine = {
    sourceId: "withdrawal-strategy",
    sourceKind: "expense",
    label: "Withdrawal strategy spending",
    category: "withdrawal-strategy",
    owner: "joint",
    requested: 0,
    funded: 0,
    spendingType: "essential",
  };
  ps.expenseLines.push(line);
  ps.strategy = { line, budget, taxesFromBudget: !ws.treatAsSpending };
  traceEvent(
    ctx,
    ps,
    "strategy",
    "STRATEGY_AMOUNT",
    () =>
      `${ws.rule.kind}: ${fmt(amount)} this period (budget ${fmt(budget)}). ${decision.explanation}`,
    [],
    {
      rule: ws.rule.kind,
      action: decision.action,
      amount,
      budget,
      annual,
    },
  );
}

function applyFlexSpending(ctx: EngineContext, ps: PeriodState): void {
  const fx = ctx.plan.flexSpending;
  if (!fx.enabled) return;
  if (fx.window) {
    const w = resolveWindow(ctx, fx.window);
    if (activeMonths(w, ps) <= 0) return;
  }
  const d = ctx.perf.ath > 0 ? 1 - ctx.perf.index / ctx.perf.ath : 0;
  const cut = flexSpendingCut(fx, d);
  if (cut <= 0) return;
  const shares = new Map<string, number>();
  for (const e of ctx.expenseEvents)
    if (e.spendingType === "hybrid") shares.set(e.id, e.discretionaryShare ?? 0.5);
  let total = 0;
  for (const l of ps.expenseLines) {
    if (l.sourceKind !== "expense") continue;
    let affected = 0;
    if (fx.scope === "all") affected = l.spendingType === "not-spending" ? 0 : 1;
    else if (l.spendingType === "discretionary") affected = 1;
    else if (l.spendingType === "hybrid") affected = shares.get(l.sourceId) ?? 0.5;
    if (affected <= 0) continue;
    const reduction = l.requested * cut * affected;
    l.requested -= reduction;
    l.funded = l.requested;
    l.flexCut = cut * affected;
    ps.poolRequired -= reduction;
    total += reduction;
  }
  if (ps.strategy && fx.scope === "all") ps.strategy.budget *= 1 - cut;
  traceEvent(
    ctx,
    ps,
    "strategy",
    "FLEX_CUT",
    () =>
      `Portfolio ${(d * 100).toFixed(1)}% below its high: spending cut ${(cut * 100).toFixed(1)}% (${fmt(total)})`,
    [],
    {
      drawdown: d,
      cut,
      total,
    },
  );
}

/**
 * Risk-based guardrails applied year by year (Plan.riskGuardrails with a `withdrawalRateBand`
 * from `evaluateGuardrails`): from `start`, the withdrawal rate is planned spending (after the
 * multiplier carried from earlier years) over the investable portfolio at the period start. Above
 * `cutAbove` the spending in scope is cut by `adjustmentStep`; below `raiseBelow` it is raised; the
 * multiplier carries into later years, so a cut lowers withdrawals and lifts later balances.
 * `floor` keeps total spending from going below a minimum (today's money).
 */
function applyRiskGuardrails(ctx: EngineContext, ps: PeriodState): void {
  const g = ctx.plan.riskGuardrails;
  if (!g?.enabled) return;
  if (!g.withdrawalRateBand) {
    unsupported(
      ctx,
      "solvers.riskGuardrails",
      "d",
      "run evaluateGuardrails to derive the withdrawal-rate band",
    );
    return;
  }
  const s = resolveRef(ctx, g.start);
  if (typeof s !== "number" || s >= ps.bounds.end) return;
  const shares = new Map<string, number>();
  for (const e of ctx.expenseEvents)
    if (e.spendingType === "hybrid") shares.set(e.id, e.discretionaryShare ?? 0.5);
  const scopeShare = (l: ExpenseLine): number => {
    if (l.sourceKind !== "expense" || l.spendingType === "not-spending") return 0;
    if (g.scope === "all") return 1;
    if (l.spendingType === "discretionary") return 1;
    if (l.spendingType === "hybrid") return shares.get(l.sourceId) ?? 0.5;
    return 0;
  };
  let scoped = 0;
  let fixed = 0;
  for (const l of ps.expenseLines) {
    if (l.sourceKind !== "expense" || l.spendingType === "not-spending") continue;
    const k = scopeShare(l);
    scoped += l.requested * k;
    fixed += l.requested * (1 - k);
  }
  let portfolio = 0;
  for (const a of ctx.accounts)
    if (a.category !== "cash" && isOpen(ctx, a, ps)) portfolio += Math.max(0, a.p.opening);
  const annualise = 12 / ps.bounds.months;
  const before = ctx.guardrailMultiplier;
  const wr =
    portfolio > 0 ? ((fixed + scoped * before) * annualise) / portfolio : Number.POSITIVE_INFINITY;
  let action: "hold" | "cut" | "raise" = "hold";
  let mult = before;
  if (ps.bounds.start > s) {
    if (wr > g.withdrawalRateBand.cutAbove) {
      mult = before * (1 - g.adjustmentStep);
      action = "cut";
    } else if (wr < g.withdrawalRateBand.raiseBelow) {
      mult = before * (1 + g.adjustmentStep);
      action = "raise";
    }
  }
  if (g.floor && scoped > 0) {
    const floor =
      (g.floor.basis === "real" ? g.floor.value * ps.piStart : g.floor.value) / annualise;
    mult = Math.max(mult, Math.min(1, Math.max(0, (floor - fixed) / scoped)));
  }
  ctx.guardrailMultiplier = mult;
  if (mult !== 1)
    for (const l of ps.expenseLines) {
      const k = scopeShare(l);
      if (k <= 0) continue;
      const delta = l.requested * k * (mult - 1);
      l.requested += delta;
      l.funded = l.requested;
      ps.poolRequired += delta;
    }
  if (action !== "hold")
    traceEvent(
      ctx,
      ps,
      "strategy",
      action === "cut" ? "GUARDRAIL_CUT" : "GUARDRAIL_RAISE",
      () =>
        `Withdrawal rate ${(wr * 100).toFixed(2)}%: spending in scope ${action === "cut" ? "cut" : "raised"} to ${(mult * 100).toFixed(1)}% of plan`,
      [],
      { withdrawalRate: wr, multiplier: mult, action },
    );
}

export function runSpendingStrategy(ctx: EngineContext, ps: PeriodState): void {
  applyWithdrawalStrategy(ctx, ps);
  applyRiskGuardrails(ctx, ps);
  applyFlexSpending(ctx, ps);
}

/** Update the market-only performance index at period close. */
export function updatePerformance(ctx: EngineContext): void {
  let opening = 0;
  let earned = 0;
  for (const a of ctx.accounts) {
    if (a.info.assetClass === "cash" || a.p.opening <= 0) continue;
    opening += a.p.opening;
    earned += a.p.growth - a.p.timing + a.p.dividends - a.p.fees;
  }
  const r = opening > 0 ? earned / opening : 0;
  ctx.perf.index *= 1 + r;
  ctx.perf.ath = Math.max(ctx.perf.ath, ctx.perf.index);
  ctx.strategy.lastReturn = r;
}
