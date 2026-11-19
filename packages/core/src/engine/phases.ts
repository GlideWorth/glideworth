/**
 * The yearly simulation pipeline. PIPELINE (bottom of file) lists the phases in execution order;
 * ARCHITECTURE.md §"Yearly pipeline" documents the same order. Each phase's logic lives in its own
 * module (growth, income, realAssets, expenses, distributions, strategy, settle, close).
 *
 * Extension seam for workstreams: replace a phase's `run` (same id, same position) or insert a
 * new phase; do not reorder existing phases without updating ARCHITECTURE.md.
 */
import { ScenarioError } from "../errors.js";
import { isWithdrawable } from "./accounts.js";
import { runClose } from "./close.js";
import { addNode, type EngineContext, type PeriodState, POOL } from "./context.js";
import { openCrossBorderPeriod } from "./crossborder.js";
import { ageAt } from "./dates.js";
import { runDistributions } from "./distributions.js";
import { runExpenses } from "./expenses.js";
import { runGrowth } from "./growth.js";
import { runIncome } from "./income.js";
import { collectTimeMilestones } from "./milestones.js";
import { runDebts, runRealAssets } from "./realAssets.js";
import { runSettle } from "./settle.js";
import { runSpendingStrategy } from "./strategy.js";
import { applyEffects, deathMonthOf } from "./survivor.js";
import { runTaxStrategy } from "./taxStrategy.js";

export { isWithdrawable };

export interface Phase {
  id: string;
  /** Workstream (area of the code base) that owns the phase. */
  owner: string;
  status: "implemented" | "partial" | "stub";
  description: string;
  run(ctx: EngineContext, ps: PeriodState): void;
}

const openPhase: Phase = {
  id: "period.open",
  owner: "a",
  status: "implemented",
  description:
    "Ages and survival; milestone effects (filing status, withholding) and deaths (survivor transfer, basis step-up); effective tax settings; reset accumulators.",
  run(ctx, ps) {
    for (const p of ctx.people) {
      ps.ages[p.id] = ageAt(p.birth, ps.bounds.start);
      const d = deathMonthOf(ctx, p.id);
      ps.alive[p.id] = d === null || d >= ps.bounds.start;
    }
    applyEffects(ctx, ps);
    ps.location = ctx.location;
    ps.tax = { ...ctx.plan.tax, filingStatus: ctx.filingStatus, withholding: ctx.withholdingRates };
    try {
      ps.stack = ctx.registry.resolveStack(ps.tax, ps.location);
    } catch (e) {
      // Cross-border plans in a country without a preset still tax the foreign items at source
      // (`crossBorderTaxes` warns that residence tax is not included).
      if (!ctx.crossBorder) throw e;
      ps.stack = [];
    }
    openCrossBorderPeriod(ctx, ps);
    for (const a of ctx.accounts) {
      a.p = {
        opening: a.balance,
        contributions: 0,
        withdrawals: 0,
        growth: 0,
        dividends: 0,
        dividendsReinvested: 0,
        fees: 0,
        transfersIn: 0,
        transfersOut: 0,
        requiredDistribution: 0,
        qcd: 0,
        rate: 0,
        timing: 0,
      };
    }
    ps.wealth = openingWealth(ctx);
    for (const d of ctx.debts) d.p = { opening: d.balance, interest: 0, payments: 0, forgiven: 0 };
    for (const r of ctx.assets)
      r.p = {
        ownershipCosts: 0,
        loanPayments: 0,
        loanInterest: 0,
        rentalIncome: 0,
        purchasePrice: 0,
        saleProceeds: 0,
      };
    addNode(ps, { id: POOL, kind: "pool", label: "Cash flow" });
  },
};

/** Real assets held as investments (box 3 "other assets") when not the main home. */
const INVESTMENT_REAL_ASSETS = new Set([
  "house",
  "rental-property",
  "commercial-property",
  "land",
  "building",
  "precious-metals",
]);

/**
 * Wealth at the period start (before any flows): net worth, liquid net worth and portfolio, plus the
 * split a savings/wealth tax needs (NL box 3):
 *   - cash: positive balances of cash accounts (savings, current accounts, deposits);
 *   - taxableInvestments: positive balances of taxable accounts (brokerage, crypto) outside pension
 *     and tax-free wrappers, plus investment real estate and precious metals that are not the main
 *     home (personal-use goods such as cars are exempt);
 *   - debts: consumer and other debts plus loans on assets other than the main home (the main-home
 *     mortgage is taxed in box 1, not box 3).
 */
function openingWealth(ctx: EngineContext): NonNullable<PeriodState["wealth"]> {
  let accounts = 0;
  let portfolio = 0;
  let cash = 0;
  let taxableInvestments = 0;
  for (const a of ctx.accounts) {
    accounts += a.balance;
    if (a.category !== "cash") portfolio += a.balance;
    const bal = Math.max(0, a.balance);
    if (a.info.taxTreatment === "cash") cash += bal;
    else if (a.info.taxTreatment === "taxable") taxableInvestments += bal;
  }
  let real = 0;
  let loans = 0;
  let otherLoans = 0;
  for (const r of ctx.assets)
    if (r.owned) {
      real += r.value;
      loans += r.loanBalance;
      const home = r.behaviour.usage === "primary-residence";
      if (!home) otherLoans += r.loanBalance;
      if (!home && INVESTMENT_REAL_ASSETS.has(r.def.type))
        taxableInvestments += Math.max(0, r.value);
    }
  let debts = 0;
  for (const d of ctx.debts) debts += d.balance;
  return {
    netWorth: accounts + real - loans - debts,
    liquidNetWorth: accounts - loans - debts,
    portfolio,
    cash,
    taxableInvestments,
    debts: Math.max(0, debts) + otherLoans,
  };
}

/** Phases in execution order. */
export const PIPELINE: readonly Phase[] = [
  openPhase,
  {
    id: "milestones.time",
    owner: "a",
    status: "implemented",
    description: "Report time-resolved milestones falling in this period.",
    run: collectTimeMilestones,
  },
  {
    id: "accounts.growth",
    owner: "a",
    status: "implemented",
    description:
      "Bond allocation (glide path, overrides, asset location); growth, dividends/interest and fees on OPENING balances (flows land at period end); DRIP window; dividend splits; taxable dividends/interest -> tax items.",
    run: runGrowth,
  },
  {
    id: "income",
    owner: "a",
    status: "implemented",
    description:
      "Income events (all types, recurrence, part-time, DB pensions, RSU vesting, Social Security estimate, state pension triple lock, survivor share) -> lines, tax items, routing.",
    run: runIncome,
  },
  {
    id: "realAssets",
    owner: "a",
    status: "implemented",
    description:
      "Purchases (financed), ownership costs, reassessment caps, rental income, loan amortisation (offset, term end), scheduled/recurring sales, appreciation.",
    run: runRealAssets,
  },
  {
    id: "debts",
    owner: "a",
    status: "implemented",
    description:
      "Interest accrual, scheduled payments (pay-from accounts, offsets), deductible interest, forgiveness.",
    run: runDebts,
  },
  {
    id: "expenses",
    owner: "a",
    status: "implemented",
    description:
      "Expense events (recurrence, pay-from accounts, Medicare, payroll deductions, charity) -> required outflows, deductions/credits.",
    run: runExpenses,
  },
  {
    id: "accounts.distributions",
    owner: "a",
    status: "implemented",
    description:
      "QCDs, RMDs, inherited 10-year/stretch, RRIF/AU minimums, custom distributions, 72(t) SEPP.",
    run: runDistributions,
  },
  {
    id: "spending.strategy",
    owner: "a",
    status: "implemented",
    description:
      "Withdrawal-strategy mode, risk-based guardrails (withdrawal-rate band from evaluateGuardrails, carried year to year) and flexible spending adjust this period's spending.",
    run: runSpendingStrategy,
  },
  {
    id: "tax.strategy",
    owner: "b",
    status: "implemented",
    description:
      "Withdrawal shielding, Roth conversions / UK pension-to-ISA moves and gain harvesting up to a bracket, IRMAA, ACA or income target (headroom from src/tax/strategy.ts).",
    run: runTaxStrategy,
  },
  {
    id: "cashflow.settle",
    owner: "a",
    status: "implemented",
    description:
      "Fixpoint over [pay-from-account lines -> net cash flow -> flows (surplus) or drawdown (deficit) -> taxes] until the cash paid for taxes converges. Same-period or next-period settlement.",
    run: runSettle,
  },
  {
    id: "period.close",
    owner: "a",
    status: "implemented",
    description:
      "Allocate unfunded shortfall (discretionary first), ledger, totals, dynamic milestones, performance index, period result.",
    run: runClose,
  },
];

/** Validate cross references once before simulating (dangling ids are ScenarioErrors). */
export function validateReferences(ctx: EngineContext): void {
  const accountIds = new Set(ctx.accounts.map((a) => a.def.id));
  const liabilityIds = new Set([
    ...ctx.debts.map((d) => d.def.id),
    ...ctx.assets.map((r) => r.def.id),
  ]);
  const incomeIds = new Set(ctx.plan.income.map((i) => i.id));
  const need = (ok: boolean, msg: string, id: string) => {
    if (!ok) throw new ScenarioError(msg, { id });
  };
  const accounts = (ids: string[], what: string, id: string) => {
    for (const x of ids)
      need(accountIds.has(x), `${what} '${id}' references unknown account '${x}'`, id);
  };
  for (const f of ctx.plan.flows) {
    if (f.kind === "contribution") {
      need(
        accountIds.has(f.accountId),
        `flow '${f.id}' targets unknown account '${f.accountId}'`,
        f.id,
      );
      if (f.method.kind === "percentOfIncome")
        need(incomeIds.has(f.method.incomeId), `flow '${f.id}' references unknown income`, f.id);
      if (f.employer)
        need(
          incomeIds.has(f.employer.incomeId),
          `flow '${f.id}' employer match references unknown income`,
          f.id,
        );
      accounts(f.fundFromAccountIds, "flow", f.id);
    }
    if (f.kind === "debtPaydown") {
      need(
        liabilityIds.has(f.targetId),
        `flow '${f.id}' targets unknown debt/asset '${f.targetId}'`,
        f.id,
      );
      for (const t of f.allocation?.targetIds ?? [])
        need(
          liabilityIds.has(t),
          `flow '${f.id}' payoff strategy targets unknown debt/asset '${t}'`,
          f.id,
        );
    }
    if (f.kind === "transfer") {
      need(accountIds.has(f.fromAccountId), `flow '${f.id}' transfers from unknown account`, f.id);
      if (f.to.kind === "account")
        need(accountIds.has(f.to.accountId), `flow '${f.id}' transfers to unknown account`, f.id);
    }
  }
  for (const e of ctx.plan.income) {
    if (e.sendTo.kind === "accounts") accounts(e.sendTo.accountIds, "income", e.id);
    if (e.type === "rsu" && e.destinationAccountId)
      accounts([e.destinationAccountId], "income", e.id);
  }
  for (const e of ctx.plan.expenses) {
    if (e.payFrom.kind === "accounts") accounts(e.payFrom.accountIds, "expense", e.id);
    if (e.type === "charity" && e.charity?.qcdFromAccountId)
      accounts([e.charity.qcdFromAccountId], "expense", e.id);
  }
  for (const d of ctx.debts)
    if (d.behaviour.payFrom.kind === "accounts")
      accounts(d.behaviour.payFrom.accountIds, "debt", d.def.id);
  for (const r of ctx.assets) {
    if (r.behaviour.sale?.proceedsTo.kind === "accounts")
      accounts(r.behaviour.sale.proceedsTo.accountIds, "asset", r.def.id);
    if (r.planned) accounts(r.planned.purchase.fundFromAccountIds, "asset", r.def.id);
  }
  if (ctx.plan.leftover.kind === "save" && ctx.plan.leftover.accountId)
    need(
      accountIds.has(ctx.plan.leftover.accountId),
      "leftover policy targets unknown account",
      ctx.plan.leftover.accountId,
    );
  for (const id of Object.keys(ctx.plan.accountSettings))
    need(accountIds.has(id), `accountSettings for unknown account '${id}'`, id);
}
