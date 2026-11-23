/**
 * cashflow.settle: fixpoint over
 *   [pay-from-account lines -> net cash flow -> flows (surplus) or drawdown (deficit) -> taxes]
 * until the cash paid for taxes converges (|delta| < 1e-7).
 *
 * Tax settlement:
 *   - 'same-period' (default): the full liability is paid in the period (withheld = total).
 *   - 'next-period': only withholding is paid in the period; the difference (liability -
 *     withheld) is paid (or refunded) in the next period. Withholding: income with 'fixed'
 *     withholding at its rate, 'auto' income at its share of the liability, 'none' nothing;
 *     account withdrawals at the plan's withholding rates (tax-deferred on the gross amount,
 *     taxable on the realised gain). The final period trues up immediately.
 */
import type { TaxYearInput, TaxYearOutput } from "../tax/types.js";
import { accountNode, deposit, timingGrowth } from "./accounts.js";
import {
  type AccountPeriodAcc,
  addLedger,
  addNode,
  type DebtState,
  type EngineContext,
  type PeriodState,
  POOL,
  traceEvent,
  warnOnce,
} from "./context.js";
import { closeCrossBorderPeriod, type CrossBorderResult, crossBorderTaxes } from "./crossborder.js";
import { monthOfYear, yearOf } from "./dates.js";
import { drawdown, payTargeted } from "./drawdown.js";
import { activeParticipantKey, leftover, runFlows } from "./flows.js";
import type { TaxLine } from "./types.js";

interface Snapshot {
  accounts: {
    balance: number;
    costBasis: number | null;
    contributionBasis: number | null;
    iraBasis: number;
    pclsTaken: boolean;
    p: AccountPeriodAcc;
  }[];
  debts: { balance: number; p: DebtState["p"] }[];
  assets: {
    value: number;
    loanBalance: number;
    owned: boolean;
    done: boolean;
    acquiredAt: number | null;
    costBasis: number;
    assessed: number | null;
    p: {
      ownershipCosts: number;
      loanPayments: number;
      loanInterest: number;
      rentalIncome: number;
      purchasePrice: number;
      saleProceeds: number;
    };
  }[];
  lengths: number[];
  nodes: number;
  poolInflow: number;
  poolRequired: number;
  lsaUsed: Map<string, number>;
  flexiblyAccessed: Set<string>;
  warnedOnce: Set<string>;
  limitUsed: Map<string, number>;
  qualified: { healthcare: number; education: number };
}

function snapshot(ctx: EngineContext, ps: PeriodState): Snapshot {
  return {
    accounts: ctx.accounts.map((a) => ({
      balance: a.balance,
      costBasis: a.costBasis,
      contributionBasis: a.contributionBasis,
      iraBasis: a.iraBasis,
      pclsTaken: a.pclsTaken,
      p: { ...a.p },
    })),
    debts: ctx.debts.map((d) => ({ balance: d.balance, p: { ...d.p } })),
    assets: ctx.assets.map((r) => ({
      value: r.value,
      loanBalance: r.loanBalance,
      owned: r.owned,
      done: r.done,
      acquiredAt: r.acquiredAt,
      costBasis: r.costBasis,
      assessed: r.assessed,
      p: { ...r.p },
    })),
    lengths: [
      ps.taxWithdrawals.length,
      ps.taxDeductions.length,
      ps.taxIncome.length,
      ps.incomeLines.length,
      ps.expenseLines.length,
      ps.engineTaxLines.length,
      ps.ledger.length,
      ctx.trace.length,
      ctx.warnings.length,
    ],
    nodes: ps.ledgerNodes.size,
    poolInflow: ps.poolInflow,
    poolRequired: ps.poolRequired,
    lsaUsed: new Map(ctx.lsaUsed),
    flexiblyAccessed: new Set(ctx.flexiblyAccessed),
    warnedOnce: new Set(ctx.warnedOnce),
    limitUsed: new Map(ps.limitUsed),
    qualified: { ...ps.qualified },
  };
}

function restore(ctx: EngineContext, ps: PeriodState, s: Snapshot): void {
  ctx.accounts.forEach((a, i) => {
    const x = s.accounts[i]!;
    a.balance = x.balance;
    a.costBasis = x.costBasis;
    a.contributionBasis = x.contributionBasis;
    a.iraBasis = x.iraBasis;
    a.pclsTaken = x.pclsTaken;
    a.p = { ...x.p };
  });
  ctx.debts.forEach((d, i) => {
    const x = s.debts[i]!;
    d.balance = x.balance;
    d.p = { ...x.p };
  });
  ctx.assets.forEach((r, i) => {
    const x = s.assets[i]!;
    r.value = x.value;
    r.loanBalance = x.loanBalance;
    r.owned = x.owned;
    r.done = x.done;
    r.acquiredAt = x.acquiredAt;
    r.costBasis = x.costBasis;
    r.assessed = x.assessed;
    r.p = { ...x.p };
  });
  const [tw, td, ti, il, el, et, lg, tr, wn] = s.lengths as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  ps.taxWithdrawals.length = tw;
  ps.taxDeductions.length = td;
  ps.taxIncome.length = ti;
  ps.incomeLines.length = il;
  ps.expenseLines.length = el;
  ps.engineTaxLines.length = et;
  ps.ledger.length = lg;
  ctx.trace.length = tr;
  ctx.warnings.length = wn;
  if (ps.ledgerNodes.size > s.nodes) {
    let k = 0;
    for (const key of [...ps.ledgerNodes.keys()]) if (k++ >= s.nodes) ps.ledgerNodes.delete(key);
  }
  ps.poolInflow = s.poolInflow;
  ps.poolRequired = s.poolRequired;
  ctx.lsaUsed = new Map(s.lsaUsed);
  ctx.flexiblyAccessed = new Set(s.flexiblyAccessed);
  ctx.warnedOnce = new Set(s.warnedOnce);
  ps.limitUsed = new Map(s.limitUsed);
  ps.qualified = { ...s.qualified };
  ps.shortfall = 0;
}

function parseMonthSafe(m: string): number {
  const [y, mo] = m.split("-");
  return Number(y) * 12 + Number(mo) - 1;
}

/** Securities bought / sold this period in taxable (brokerage, crypto) accounts. */
function securitiesTraded(ctx: EngineContext): { purchases: number; sales: number } {
  let purchases = 0;
  let sales = 0;
  for (const a of ctx.accounts) {
    if (a.info.taxTreatment !== "taxable" || a.category === "cash") continue;
    purchases += a.p.contributions + a.p.transfersIn + a.p.dividendsReinvested;
    sales += a.p.withdrawals + a.p.transfersOut;
  }
  return { purchases, sales };
}

/** The TaxYearInput for the period's current state (inside the settle fixpoint). */
export function buildTaxInput(ctx: EngineContext, ps: PeriodState): TaxYearInput {
  const input: TaxYearInput = {
    year: ps.bounds.year,
    periodIndex: ps.bounds.index,
    months: ps.bounds.months,
    filingStatus: ps.tax.filingStatus,
    location: ps.location,
    people: ctx.people.map((p) => ({
      id: p.id,
      role: p.role,
      age: ps.ages[p.id] ?? 0,
      alive: ps.alive[p.id] ?? true,
      birthYear: yearOf(p.birth),
      birthMonth: monthOfYear(p.birth) + 1,
      ...((ps.limitUsed.get(activeParticipantKey(p.id)) ?? 0) > 0
        ? { activeParticipant: true }
        : {}),
    })),
    dependents: ctx.household.dependents.map((d) => ({
      id: d.id,
      age: (ps.bounds.start - parseMonthSafe(d.birthMonth)) / 12,
    })),
    priceIndex: ps.piStart,
    income: ps.taxIncome,
    withdrawals: ps.taxWithdrawals,
    deductions: ps.taxDeductions,
    config: ps.tax,
    history: ctx.taxHistory,
    transactions: securitiesTraded(ctx),
    ...(ps.wealth ? { wealth: ps.wealth } : {}),
    ...(ps.aca ? { aca: ps.aca } : {}),
  };
  return input;
}

export function computeTaxes(
  ctx: EngineContext,
  ps: PeriodState,
): { total: number; lines: TaxLine[]; outputs: TaxYearOutput[]; crossBorder?: CrossBorderResult } {
  const input = buildTaxInput(ctx, ps);
  let outputs: TaxYearOutput[] = [];
  let lines: TaxLine[];
  let cb: CrossBorderResult | undefined;
  if (ps.crossBorder) {
    cb = crossBorderTaxes(ctx, ps, input);
    outputs = cb.outputs;
    lines = [...cb.lines];
  } else {
    for (const j of ps.stack) outputs.push(j.computeYear(input, outputs));
    lines = outputs.flatMap((o) => o.lines);
  }
  for (const l of ps.engineTaxLines) lines.push(l);
  if (ps.bounds.index === 0 && ctx.plan.tax.firstYearPriorTaxDue !== 0)
    lines.push({
      jurisdictionId: "engine",
      kind: "other",
      label: "Prior-year tax due",
      amount: ctx.plan.tax.firstYearPriorTaxDue,
    });
  let total = 0;
  for (const l of lines) total += l.amount;
  return { total, lines, outputs, ...(cb ? { crossBorder: cb } : {}) };
}

/** Tax withheld during the period for a given liability (next-period settlement mode). */
export function withheldFor(ctx: EngineContext, ps: PeriodState, liability: number): number {
  let base = 0;
  for (const i of ps.taxIncome) if (i.character !== "tax-free") base += i.amount;
  for (const w of ps.taxWithdrawals) base += w.taxableAmount;
  let withheld = 0;
  for (const i of ps.taxIncome) {
    if (i.character === "tax-free") continue;
    const mode = ps.withholding.get(i.sourceId);
    if (!mode || mode.mode === "none") continue;
    withheld +=
      mode.mode === "fixed" ? mode.rate * i.amount : base > 0 ? (liability * i.amount) / base : 0;
  }
  const rates = ps.tax.withholding;
  for (const w of ps.taxWithdrawals) {
    if (w.treatment === "tax-deferred") withheld += rates.taxDeferred * w.amount;
    else if (w.treatment === "taxable") withheld += rates.taxable * w.taxableAmount;
  }
  void ctx;
  return withheld;
}

/**
 * US traditional IRA contributions above the deduction limit (IRC 219(g)) stay in the IRA as
 * nondeductible basis. The federal plug-in reports each owner's nondeductible amount as the fact
 * `us.iraNondeductible.<owner>`; it is shared among that owner's traditional IRA contributions this
 * period pro rata.
 */
function addIraBasis(ctx: EngineContext, ps: PeriodState, facts: Record<string, number>): void {
  const byOwner = new Map<string, { accountId: string; amount: number }[]>();
  for (const d of ps.taxDeductions) {
    if (d.kind !== "pre-tax-contribution" || d.employer || d.accountType !== "traditional-ira")
      continue;
    if (!d.accountId || !(d.amount > 0)) continue;
    const list = byOwner.get(d.owner) ?? [];
    list.push({ accountId: d.accountId, amount: d.amount });
    byOwner.set(d.owner, list);
  }
  for (const [owner, items] of byOwner) {
    const nd = facts[`us.iraNondeductible.${owner}`] ?? 0;
    const total = items.reduce((s, x) => s + x.amount, 0);
    if (!(nd > 0) || !(total > 0)) continue;
    for (const x of items) {
      const a = ctx.accountById.get(x.accountId);
      if (a) a.iraBasis += (Math.min(nd, total) * x.amount) / total;
    }
    traceEvent(
      ctx,
      ps,
      "flows",
      "IRA_NONDEDUCTIBLE",
      () => `${nd.toFixed(2)} of traditional IRA contributions is not deductible (IRC 219(g))`,
      items.map((x) => x.accountId),
      { amount: nd },
    );
  }
}

/**
 * UK relief at source: the provider claims basic-rate relief from HMRC and adds it to the pension
 * (a net £80 contribution becomes £100). The UK plug-in reports the total as the fact
 * `uk.reliefAtSourceTopUp`; it is shared among the period's relief-at-source contributions pro rata.
 */
function depositReliefAtSource(ctx: EngineContext, ps: PeriodState, topUp: number): void {
  const defaultScheme = ps.tax.uk?.defaultPensionScheme;
  const items = ps.taxDeductions.filter((d) => {
    if (d.kind !== "pre-tax-contribution" || d.employer || !d.accountId || d.amount <= 0)
      return false;
    const scheme =
      d.pensionScheme ??
      defaultScheme ??
      (d.accountType === "uk-sipp" || d.accountType === "uk-pension"
        ? "relief-at-source"
        : "net-pay");
    return scheme === "relief-at-source" && d.accountType?.startsWith("uk-");
  });
  const total = items.reduce((x, d) => x + d.amount, 0);
  if (!(total > 0)) return;
  const node = addNode(ps, {
    id: "external:uk-ras",
    kind: "external",
    label: "Pension tax relief (HMRC)",
  });
  for (const d of items) {
    const a = ctx.accountById.get(d.accountId!);
    if (!a) continue;
    const amount = (topUp * d.amount) / total;
    deposit(a, amount);
    ps.incomeLines.push({
      sourceId: `ras:${d.sourceId}`,
      sourceKind: "income",
      label: `${a.def.name} tax relief top-up`,
      owner: a.owner,
      amount,
      taxCharacter: "tax-free",
    });
    addLedger(ctx, ps, {
      from: node,
      to: accountNode(ps, a),
      amount,
      kind: "income",
      causeId: d.sourceId,
    });
  }
  traceEvent(
    ctx,
    ps,
    "flows",
    "RELIEF_AT_SOURCE",
    () => `Pension providers added ${topUp.toFixed(2)} of basic-rate relief`,
    [],
    {
      amount: topUp,
    },
  );
}

/**
 * Cash-flow timing convention (Assumptions.cashFlowTiming, default 'mid'). Growth is computed on
 * opening balances and flows are booked at the period end; this adjusts each account's growth for
 * the share of the period its net flow (contributions + transfers in - withdrawals - transfers
 * out) was actually invested: a withdrawal under 'mid' forgoes half a year of the account's
 * return, under 'start' the whole year (FIRECalc convention), under 'end' none. Withdrawals are
 * capped by `withdrawable` so the adjusted balance cannot go below zero; the clamp below only
 * absorbs floating-point residue (an account the cap emptied ends at exactly zero, not at 1e-12,
 * which would otherwise count as "not depleted").
 */
export function applyCashFlowTiming(ctx: EngineContext, ps: PeriodState): void {
  for (const a of ctx.accounts) {
    const q = timingGrowth(ctx, ps, a);
    if (q === 0) continue;
    const net = a.p.contributions + a.p.transfersIn - a.p.withdrawals - a.p.transfersOut;
    if (Math.abs(net) < 1e-9) continue;
    let adj = net * q;
    if (a.balance + adj < 1e-6) adj = -Math.max(0, a.balance);
    a.balance += adj;
    a.p.growth += adj;
    a.p.timing += adj;
  }
}

export function runSettle(ctx: EngineContext, ps: PeriodState): void {
  const nextMode = ps.tax.settlement === "next-period";
  const isLast = ps.bounds.index === ctx.periods.length - 1;
  const prior = nextMode ? ctx.pendingSettlement : 0;
  const snap = snapshot(ctx, ps);
  let cashGuess = 0;
  let result: ReturnType<typeof computeTaxes> = {
    total: 0,
    lines: [] as TaxLine[],
    outputs: [] as TaxYearOutput[],
  };
  let withheld = 0;
  let converged = false;
  for (let iter = 0; iter < 100; iter++) {
    restore(ctx, ps, snap);
    const raised = payTargeted(ctx, ps);
    if (ps.strategy) {
      const st = ps.strategy;
      const req = Math.max(0, st.budget - ps.poolRequired - (st.taxesFromBudget ? cashGuess : 0));
      st.line.requested = req;
      st.line.funded = req;
    }
    const required = ps.poolRequired + (ps.strategy?.line.requested ?? 0);
    const net = ps.poolInflow + raised - required - cashGuess;
    const afterFlows = runFlows(ctx, ps, net);
    if (afterFlows >= 0) leftover(ctx, ps, afterFlows);
    else ps.shortfall = drawdown(ctx, ps, -afterFlows);
    result = computeTaxes(ctx, ps);
    withheld = nextMode ? withheldFor(ctx, ps, result.total) : result.total;
    const cash = nextMode
      ? withheld + prior + (isLast ? result.total - withheld : 0)
      : result.total;
    if (Math.abs(cash - cashGuess) < 1e-7) {
      converged = true;
      cashGuess = cash;
      break;
    }
    cashGuess = cash;
  }
  if (!converged)
    warnOnce(ctx, `no-converge:${ps.bounds.index}`, {
      code: "ASSUMPTION",
      severity: "warning",
      message: `In ${ps.bounds.year}, the tax and withdrawal calculation did not settle within 100 iterations; that year's figures are approximate.`,
      periodIndex: ps.bounds.index,
      refs: [],
    });
  const cb = result.crossBorder;
  const gross = cb
    ? cb.grossIncome
    : result.outputs.reduce((s, o) => Math.max(s, o.grossIncome), 0);
  const taxable = cb
    ? cb.taxableIncome
    : result.outputs.reduce((s, o) => Math.max(s, o.taxableIncome), 0);
  const facts: Record<string, number> = {};
  if (cb) Object.assign(facts, cb.facts);
  else for (const o of result.outputs) for (const [k, v] of Object.entries(o.facts)) facts[k] = v;
  const topUp = facts["uk.reliefAtSourceTopUp"] ?? 0;
  if (topUp > 1e-9) depositReliefAtSource(ctx, ps, topUp);
  if ((facts["us.iraNondeductible"] ?? 0) > 1e-9) addIraBasis(ctx, ps, facts);
  applyCashFlowTiming(ctx, ps);
  const settlement = nextMode ? prior + (isLast ? result.total - withheld : 0) : 0;
  ctx.pendingSettlement = nextMode && !isLast ? result.total - withheld : 0;
  ps.taxes = {
    total: result.total,
    lines: result.lines,
    grossIncome: gross,
    taxableIncome: taxable,
    effectiveRate: gross > 0 ? result.total / gross : 0,
    marginalRate: cb
      ? crossBorderTaxes(ctx, ps, buildTaxInput(ctx, ps), { extra: 1 }).total - cb.total
      : result.outputs.reduce((s, o) => s + o.marginalRate, 0),
    withheld,
    settlement,
    facts,
    ...(cb ? { byCountry: cb.byCountry } : {}),
  };
  if (cb) closeCrossBorderPeriod(ctx);
  if (cb && ctx.options.trace === "full" && !ctx.options.lean) {
    ps.taxes.brackets =
      crossBorderTaxes(ctx, ps, buildTaxInput(ctx, ps), { explain: true }).brackets ?? [];
  } else if (ctx.options.trace === "full" && !ctx.options.lean) {
    // Bracket fill for the drill-down (explainYear is slower; never in the Monte Carlo hot path).
    const input = buildTaxInput(ctx, ps);
    const outs: TaxYearOutput[] = [];
    for (const j of ps.stack)
      outs.push(j.explainYear ? j.explainYear(input, outs) : j.computeYear(input, outs));
    ps.taxes.brackets = outs.flatMap((o) => o.brackets ?? []);
  }
  // Ledger: cash actually paid to (or refunded by) the tax authorities this period.
  const cashLines: { id: string; label: string; amount: number }[] = [];
  if (nextMode) {
    cashLines.push({ id: "withheld", label: "Taxes withheld", amount: withheld });
    cashLines.push({ id: "settlement", label: "Tax settlement", amount: settlement });
  } else {
    const byJur = new Map<string, number>();
    for (const l of result.lines)
      byJur.set(l.jurisdictionId, (byJur.get(l.jurisdictionId) ?? 0) + l.amount);
    for (const [j, amt] of byJur)
      cashLines.push({ id: j, label: j === "flat" ? "Taxes" : `Taxes (${j})`, amount: amt });
  }
  for (const c of cashLines) {
    if (Math.abs(c.amount) <= 1e-12) continue;
    const node = addNode(ps, { id: `tax:${c.id}`, kind: "tax", label: c.label, refId: c.id });
    if (c.amount > 0) addLedger(ctx, ps, { from: POOL, to: node, amount: c.amount, kind: "tax" });
    else addLedger(ctx, ps, { from: node, to: POOL, amount: -c.amount, kind: "tax" });
  }
  if (ps.shortfall > 0) {
    const node = addNode(ps, { id: "shortfall", kind: "shortfall", label: "Unfunded" });
    addLedger(ctx, ps, { from: node, to: POOL, amount: ps.shortfall, kind: "shortfall" });
  }
}
