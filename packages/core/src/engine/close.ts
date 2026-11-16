/**
 * period.close: allocate any unfunded shortfall (discretionary and the discretionary share of
 * hybrid lines first, then the rest of hybrid, then essential), write expense ledger entries,
 * compute totals (with the Spending metric definition), evaluate metric milestones on the end
 * state, update the flexible-spending performance index and emit the period result.
 */
import { accountNode, deposit, isLiquid, isOpen, isWithdrawable } from "./accounts.js";
import {
  addLedger,
  addNode,
  type EngineContext,
  fmt,
  type PeriodState,
  POOL,
  traceEvent,
} from "./context.js";
import { formatMonth } from "./dates.js";
import { leftoverTarget } from "./flows.js";
import { fxAt } from "./indices.js";
import { evaluateDynamicMilestones } from "./milestones.js";
import { updatePerformance } from "./strategy.js";
import type { ExpenseLine, PeriodTotals } from "./types.js";

const UK_PENSIONS = new Set(["uk-sipp", "uk-workplace-pension", "uk-pension"]);

export function allocateShortfall(ctx: EngineContext, ps: PeriodState): void {
  let gap = ps.shortfall;
  const share = (e: ExpenseLine) => {
    if (e.spendingType !== "hybrid") return 0;
    const ev = ctx.expenseEvents.find((x) => x.id === e.sourceId);
    return ev?.discretionaryShare ?? 0.5;
  };
  // Remaining fundable amount per tier for each line.
  const tiers: ((e: ExpenseLine) => number)[] = [
    (e) =>
      e.spendingType === "discretionary" || e.spendingType === "not-spending"
        ? e.funded
        : e.spendingType === "hybrid"
          ? Math.min(e.funded, e.requested * share(e))
          : 0,
    (e) => (e.spendingType === "hybrid" ? e.funded : 0),
    (e) => (e.spendingType === "essential" ? e.funded : 0),
  ];
  for (const tier of tiers) {
    if (gap <= 0) break;
    const amounts = ps.expenseLines.map(tier);
    const pool = amounts.reduce((s, x) => s + x, 0);
    if (pool <= 0) continue;
    const cut = Math.min(gap, pool);
    ps.expenseLines.forEach((e, i) => {
      const t = amounts[i]!;
      if (t > 0) e.funded -= (t / pool) * cut;
    });
    gap -= cut;
  }
}

/**
 * Expense ledger entries carry the REQUESTED amount: any unfunded part arrives in the pool from
 * the 'Unfunded' (shortfall) node, so the pool always balances and a Sankey shows which spending
 * the shortfall hit via `ExpenseLine.funded`.
 */
function expenseLedger(ctx: EngineContext, ps: PeriodState): void {
  if (ctx.options.lean) return;
  for (const e of ps.expenseLines) {
    if (e.sourceKind === "debt-payment" || e.sourceKind === "loan-payment") {
      const id = e.sourceId.split(":")[1]!;
      const node = addNode(ps, { id: `debt:${id}`, kind: "debt", label: e.label, refId: id });
      addLedger(ctx, ps, {
        from: POOL,
        to: node,
        amount: e.requested,
        kind: "debt-payment",
        causeId: e.sourceId,
      });
    } else if (e.sourceKind === "asset-purchase") {
      const id = e.sourceId.split(":")[1]!;
      const node = addNode(ps, { id: `asset:${id}`, kind: "asset", label: e.label, refId: id });
      addLedger(ctx, ps, {
        from: POOL,
        to: node,
        amount: e.requested,
        kind: "purchase",
        causeId: e.sourceId,
      });
    } else {
      const node = addNode(ps, {
        id: `expense:${e.sourceId}`,
        kind: "expense",
        label: e.label,
        refId: e.sourceId,
      });
      addLedger(ctx, ps, {
        from: POOL,
        to: node,
        amount: e.requested,
        kind: "expense",
        causeId: e.sourceId,
      });
    }
  }
}

/** Spending metric per UserSettings.spending (via SimulationOptions.spendingDefinition). */
function spendingOf(ctx: EngineContext, ps: PeriodState): number {
  const def = ctx.options.spendingDefinition ?? {
    includeTaxes: false,
    includeMortgage: true,
    includeMortgagePrincipal: false,
    includeConsumerDebtPrincipal: false,
  };
  let s = 0;
  for (const e of ps.expenseLines) {
    if (e.spendingType === "not-spending" || e.funded <= 0) continue;
    if (e.sourceKind === "loan-payment") {
      if (!def.includeMortgage) continue;
      const r = ctx.assets.find((x) => x.def.id === e.sourceId.split(":")[1]);
      const interestShare =
        r && r.p.loanPayments > 0 ? Math.min(1, r.p.loanInterest / r.p.loanPayments) : 1;
      s += def.includeMortgagePrincipal ? e.funded : e.funded * interestShare;
    } else if (e.sourceKind === "debt-payment") {
      const d = ctx.debts.find((x) => x.def.id === e.sourceId.split(":")[1]);
      const interestShare = d && d.p.payments > 0 ? Math.min(1, d.p.interest / d.p.payments) : 1;
      s += def.includeConsumerDebtPrincipal ? e.funded : e.funded * interestShare;
    } else s += e.funded;
  }
  if (def.includeTaxes) s += ps.taxes.total;
  return s;
}

/** Income lines that are deposits by an employer or the government, not household income. */
function isTopUp(sourceId: string): boolean {
  return (
    sourceId.startsWith("employer:") ||
    sourceId.startsWith("ras:") ||
    sourceId.startsWith("lisa-bonus:")
  );
}

function computeTotals(ctx: EngineContext, ps: PeriodState): PeriodTotals {
  const byCategory: PeriodTotals["byCategory"] = {};
  const byOwner: Record<string, number> = {};
  const own = (o: string, v: number) => {
    byOwner[o] = (byOwner[o] ?? 0) + v;
  };
  let cash = 0;
  let portfolio = 0;
  let liquidAccounts = 0;
  let openingInvestable = 0;
  for (const a of ctx.accounts) {
    byCategory[a.category] = (byCategory[a.category] ?? 0) + a.balance;
    own(a.owner, a.balance);
    if (a.category === "cash") cash += a.balance;
    else {
      portfolio += a.balance;
      openingInvestable += a.p.opening;
    }
    if (isLiquid(ctx, a, ps)) liquidAccounts += a.balance;
  }
  let realAssets = 0;
  let loans = 0;
  let lnwLoans = 0;
  for (const r of ctx.assets) {
    if (!r.owned) continue;
    realAssets += r.value;
    loans += r.loanBalance;
    own(r.owner, r.value - r.loanBalance);
    if (!r.behaviour.excludeLoanFromLiquidNetWorth) lnwLoans += r.loanBalance;
  }
  if (realAssets) byCategory["real-assets"] = realAssets;
  let debts = 0;
  for (const d of ctx.debts) {
    debts += d.balance;
    own(d.owner, -d.balance);
  }
  const liabilities = debts + loans;
  const assets = cash + portfolio + realAssets;
  let income = 0;
  let passiveIncome = 0;
  // Money paid straight into accounts by an employer or the government (employer pension match,
  // UK relief-at-source top-up, LISA bonus) is part of `income` AND of `contributions` (the savings
  // rate counts it on both sides). It never enters the cash pool; `externalContributions` reports
  // it so consumers can show cash income (income - externalContributions).
  let topUps = 0;
  let oneOffIncome = 0;
  for (const l of ps.incomeLines) {
    if (l.sourceKind === "asset-sale") continue;
    if (isTopUp(l.sourceId)) topUps += l.amount;
    if (isOneOffIncome(ctx, l.sourceId)) oneOffIncome += l.amount;
    income += l.amount;
    if (l.sourceKind === "dividend" || l.sourceKind === "interest" || l.sourceKind === "rental")
      passiveIncome += l.amount;
  }
  let expenses = 0;
  for (const e of ps.expenseLines) expenses += e.requested;
  let contributions = 0;
  let withdrawals = 0;
  for (const a of ctx.accounts) {
    contributions += a.p.contributions;
    withdrawals += a.p.withdrawals;
  }
  let taxFreePensionCash = 0;
  for (const w of ps.taxWithdrawals)
    if (UK_PENSIONS.has(w.accountType)) taxFreePensionCash += w.amount - w.taxableAmount;
  // Savings rate (ARCHITECTURE §4.2): saved out of after-tax regular income. Sale proceeds (saved to
  // accounts directly or via the pool) and inheritances/windfalls are one-off inflows: saving them
  // is not saving out of income, so they are removed from the numerator, and the one-off income is
  // removed from the denominator. The ratio is clamped to [0, 1].
  let saleProceeds = 0;
  for (const r of ctx.assets) saleProceeds += Math.max(0, r.p.saleProceeds);
  const oneOffInflows = saleProceeds + oneOffIncome;
  const afterTaxIncome = income - oneOffIncome - ps.taxes.total;
  const netSaving = contributions - withdrawals - oneOffInflows;
  const savedFromIncome = afterTaxIncome > 0 ? Math.min(afterTaxIncome, Math.max(0, netSaving)) : 0;
  return {
    netWorth: assets - liabilities,
    liquidNetWorth: liquidAccounts - debts - lnwLoans,
    assets,
    liabilities,
    portfolio,
    cash,
    realAssets,
    income,
    passiveIncome,
    expenses,
    spending: spendingOf(ctx, ps),
    taxes: ps.taxes.total,
    contributions,
    withdrawals,
    savingsRate: afterTaxIncome > 0 ? savedFromIncome / afterTaxIncome : null,
    withdrawalRate: openingInvestable > 0 ? withdrawals / openingInvestable : null,
    shortfall: ps.shortfall,
    byCategory,
    netWorthByOwner: byOwner,
    taxFreePensionCash,
    externalContributions: topUps,
    savedFromIncome,
    afterTaxIncome,
    oneOffInflows,
  };
}

/**
 * Original-currency detail for a foreign-currency account, asset or debt: the given base-currency
 * values converted back at the period-end rate, plus the rate itself.
 */
function foreignDetail<K extends string>(
  ctx: EngineContext,
  ps: PeriodState,
  currency: string,
  values: Record<K, number>,
  fxGain?: number,
): Record<K, number> & { currency: string; fxRate: number; fxGain?: number } {
  const rate = fxAt(ctx, currency, ps.bounds.end);
  const out = Object.fromEntries(
    Object.entries(values).map(([k, v]) => [k, (v as number) / rate]),
  ) as Record<K, number>;
  return { ...out, currency, fxRate: rate, ...(fxGain !== undefined ? { fxGain } : {}) };
}

const ONE_OFF_INCOME_TYPES = new Set(["inheritance", "windfall"]);

/** Inheritance and windfall income events (and their survivor continuations) are one-off cash. */
function isOneOffIncome(ctx: EngineContext, sourceId: string): boolean {
  let ids = ctx.oneOffIncomeIds;
  if (!ids) {
    ids = new Set(ctx.plan.income.filter((e) => ONE_OFF_INCOME_TYPES.has(e.type)).map((e) => e.id));
    ctx.oneOffIncomeIds = ids;
  }
  if (ids.size === 0) return false;
  const base = sourceId.includes(":") ? sourceId.slice(0, sourceId.indexOf(":")) : sourceId;
  return ids.has(base);
}

/**
 * An asset purchase the period could not fully fund does not happen: the asset is not recorded as
 * bought (it is retried next period), its purchase, running-cost and loan lines are dropped, the
 * part of them that WAS funded goes back to savings and the shortfall shrinks accordingly.
 */
function cancelUnfundedPurchases(ctx: EngineContext, ps: PeriodState): void {
  const failed = ps.expenseLines.filter(
    (e) => e.sourceKind === "asset-purchase" && e.funded < e.requested - 0.005,
  );
  if (failed.length === 0) return;
  for (const line of failed) {
    const id = line.sourceId.split(":")[1]!;
    const r = ctx.assets.find((x) => x.def.id === id);
    if (!r?.planned) continue;
    const mine = (e: ExpenseLine) =>
      e === line || e.sourceId.startsWith(`asset-cost:${id}:`) || e.sourceId === `loan:${id}`;
    let refund = 0;
    let unfunded = 0;
    ps.expenseLines = ps.expenseLines.filter((e) => {
      if (!mine(e)) return true;
      refund += e.funded;
      unfunded += e.requested - e.funded;
      return false;
    });
    r.p.purchasePrice = Math.max(0, r.p.purchasePrice - (r.costBasis ?? 0));
    r.owned = false;
    r.value = 0;
    r.loanBalance = 0;
    r.loan = null;
    r.acquiredAt = null;
    r.assessed = null;
    r.p.ownershipCosts = 0;
    r.p.loanPayments = 0;
    r.p.loanInterest = 0;
    r.planned.nextPurchase = ps.bounds.end;
    r.planned.saleAt = null;
    ps.shortfall = Math.max(0, ps.shortfall - unfunded);
    const target = leftoverTarget(ctx, ps);
    if (refund > 0 && target) {
      deposit(target, refund);
      addLedger(ctx, ps, {
        from: POOL,
        to: accountNode(ps, target),
        amount: refund,
        kind: "leftover",
      });
    }
    ctx.warnings.push({
      code: "ASSUMPTION",
      severity: "warning",
      message: `${r.def.name} could not be fully funded in ${ps.bounds.year}; the purchase is postponed.`,
      periodIndex: ps.bounds.index,
      refs: [id],
    });
    traceEvent(
      ctx,
      ps,
      "close",
      "PURCHASE_POSTPONED",
      () => `${r.def.name} purchase postponed: unfunded ${fmt(unfunded)}`,
      [id],
      { unfunded, refund },
    );
  }
  // Keep the pool balanced: the shortfall entry shrinks with the cancelled lines.
  const entry = ps.ledger.find((l) => l.from === "shortfall");
  if (entry) entry.amount = ps.shortfall;
  if (ps.shortfall <= 1e-12) {
    ps.ledger = ps.ledger.filter((l) => l.from !== "shortfall");
    ps.ledgerNodes.delete("shortfall");
  }
}

export function runClose(ctx: EngineContext, ps: PeriodState): void {
  allocateShortfall(ctx, ps);
  cancelUnfundedPurchases(ctx, ps);
  expenseLedger(ctx, ps);
  if (ps.shortfall > 0.005) {
    let locked = 0;
    for (const a of ctx.accounts)
      if (a.balance > 0 && (!isOpen(ctx, a, ps) || !isWithdrawable(ctx, a, ps)))
        locked += a.balance;
    ctx.warnings.push({
      code: "SHORTFALL",
      severity: "error",
      message: `In ${ps.bounds.year}, ${fmt(ps.shortfall)} of expenses could not be funded: income and every account that could be drawn on were used up${locked > 0.005 ? ` (${fmt(locked)} more is held in accounts that cannot be withdrawn from yet)` : ""}.`,
      periodIndex: ps.bounds.index,
      refs: [],
    });
    traceEvent(
      ctx,
      ps,
      "close",
      "SHORTFALL",
      () => `Unfunded ${fmt(ps.shortfall)} after exhausting withdrawable accounts`,
      [],
      {
        shortfall: ps.shortfall,
      },
    );
  }
  for (const a of ctx.accounts)
    if (a.balance < -1e-6)
      ctx.warnings.push({
        code: "NEGATIVE_BALANCE",
        severity: "warning",
        message: `${a.def.name} has a negative balance (${fmt(a.balance)}) at the end of ${ps.bounds.year}: more was taken out than it held.`,
        periodIndex: ps.bounds.index,
        refs: [a.def.id],
      });
  const totals = computeTotals(ctx, ps);
  evaluateDynamicMilestones(ctx, ps, totals);
  updatePerformance(ctx);
  ctx.taxHistory.push(ps.taxes.facts);
  const lean = ctx.options.lean;
  ctx.results.push({
    index: ps.bounds.index,
    year: ps.bounds.year,
    startMonth: formatMonth(ps.bounds.start),
    months: ps.bounds.months,
    ages: ps.ages,
    alive: ps.alive,
    market: ps.market,
    priceIndex: ps.piEnd,
    priceIndexStart: ps.piStart,
    ...(ctx.categories && ctx.categories.size > 0
      ? {
          categoryPriceIndexStart: Object.fromEntries(
            [...ctx.categories].map(([id, c]) => [id, c.piStart[ps.bounds.index]!]),
          ),
        }
      : {}),
    accounts: lean
      ? []
      : ctx.accounts.map((a) => ({
          accountId: a.def.id,
          category: a.category,
          opening: a.p.opening,
          contributions: a.p.contributions,
          withdrawals: a.p.withdrawals,
          growth: a.p.growth,
          dividends: a.p.dividends,
          fees: a.p.fees,
          transfersIn: a.p.transfersIn,
          transfersOut: a.p.transfersOut,
          closing: a.balance,
          costBasis: a.costBasis,
          contributionBasis: a.contributionBasis,
          withdrawable: isWithdrawable(ctx, a, ps),
          liquid: isLiquid(ctx, a, ps),
          owner: a.owner,
          dividendsReinvested: a.p.dividendsReinvested,
          requiredDistribution: a.p.requiredDistribution + a.p.qcd,
          bondShare: a.bondShare,
          open: isOpen(ctx, a, ps),
          ...(a.currency
            ? foreignDetail(ctx, ps, a.currency, { closingOriginal: a.balance }, a.p.fx)
            : {}),
        })),
    realAssets: lean
      ? []
      : ctx.assets.map((r) => ({
          assetId: r.def.id,
          value: r.owned ? r.value : 0,
          loanBalance: r.owned ? r.loanBalance : 0,
          equity: r.owned ? r.value - r.loanBalance : 0,
          owned: r.owned,
          ownershipCosts: r.p.ownershipCosts,
          loanPayments: r.p.loanPayments,
          loanInterest: r.p.loanInterest,
          rentalIncome: r.p.rentalIncome,
          purchasePrice: r.p.purchasePrice,
          saleProceeds: r.p.saleProceeds,
          owner: r.owner,
          ...(r.currency
            ? foreignDetail(ctx, ps, r.currency, {
                valueOriginal: r.owned ? r.value : 0,
                loanBalanceOriginal: r.owned ? r.loanBalance : 0,
              })
            : {}),
        })),
    debts: lean
      ? []
      : ctx.debts.map((d) => ({
          debtId: d.def.id,
          ...d.p,
          closing: d.balance,
          ...(d.currency ? foreignDetail(ctx, ps, d.currency, { closingOriginal: d.balance }) : {}),
        })),
    income: lean ? [] : ps.incomeLines,
    expenses: lean ? [] : ps.expenseLines,
    taxes: ps.taxes,
    ledgerNodes: lean ? [] : [...ps.ledgerNodes.values()],
    ledger: ps.ledger,
    milestonesReached: ps.milestonesReached,
    totals,
    status: ps.shortfall > 0.005 ? "shortfall" : "ok",
  });
}
