/**
 * Real assets and debts.
 *
 * Per asset and period (in order): planned purchase (down payment from accounts or the pool,
 * financed remainder becomes a loan) -> ownership costs (property tax with reassessment caps,
 * maintenance, insurance, improvements, HOA; rented share is 'not-spending', personal share counts
 * as spending) -> rental income (vacancy, management, estimated deductions) -> loan amortisation
 * (offset accounts reduce interest; payments stop at the term end with a balloon payoff) ->
 * scheduled sale (broker fee, gain reduction, loan payoff, proceeds to the pool or accounts) ->
 * appreciation over the owned months -> recurrence (next purchase after `yearsBetween`).
 *
 * Auto-liquidation (`liquidateIfNeeded`) happens in drawdown order (see drawdown.ts) through
 * `sellAsset`.
 */
import type { AssetCost } from "../schema/assets-debts.js";
import { accountNode, deposit } from "./accounts.js";
import { changedValue, nominalAtPeriod } from "./amounts.js";
import {
  type ActiveLoan,
  type AssetState,
  addLedger,
  addNode,
  type EngineContext,
  fmt,
  type PeriodState,
  POOL,
  priceIndexAt,
  traceEvent,
  warnOnce,
} from "./context.js";
import type { MonthIndex } from "./dates.js";
import { fxAt } from "./indices.js";
import { resolveRef } from "./milestones.js";
import { countryRules, householdRules } from "./rules.js";
import type { ExpenseLine } from "./types.js";

export function monthlyRate(
  apr: number,
  method: "simple" | "compound",
  compounding: "daily" | "monthly" | "annually",
): number {
  if (method === "simple" || compounding === "monthly") return apr / 12;
  if (compounding === "daily") return (1 + apr / 365) ** (365 / 12) - 1;
  return (1 + apr) ** (1 / 12) - 1;
}

/**
 * Amortise monthly. `paying(k)` says whether month k (0-based within the run) has a payment;
 * `offset` reduces the balance that accrues interest. Returns new balance, interest and payments.
 */
export function amortise(
  balance: number,
  rate: number,
  payment: number,
  months: number,
  paying: (k: number) => boolean,
  offset = 0,
) {
  let bal = balance;
  let interest = 0;
  let paid = 0;
  for (let k = 0; k < months && bal > 1e-9; k++) {
    const i = Math.max(0, bal - offset) * rate;
    interest += i;
    bal += i;
    if (paying(k)) {
      const pay = Math.min(payment, bal);
      bal -= pay;
      paid += pay;
    }
  }
  return { balance: bal, interest, paid };
}

/** Months-per-year proration of a recurring asset cost on value `base`. */
export function assetCost(
  cost: AssetCost | undefined,
  base: number,
  ps: PeriodState,
  months: number,
  /** Base-currency units per unit of the asset's currency (foreign-currency assets). */
  fx = 1,
): number {
  if (!cost) return 0;
  switch (cost.kind) {
    case "none":
      return 0;
    case "percentOfValue":
      return (base * cost.rate * months) / 12;
    case "amountPerYear":
      return (nominalAtPeriod(ps, cost.amount) * fx * months) / 12;
    case "amountPerMonth":
      return nominalAtPeriod(ps, cost.amount) * fx * months;
  }
}

/** FX factor for an asset's own-currency amounts this period (1 in the base currency). */
const assetFx = (ctx: EngineContext, ps: PeriodState, r: AssetState) =>
  fxAt(ctx, r.currency, ps.bounds.start);

export function pushRequiredExpense(ps: PeriodState, line: ExpenseLine): void {
  if (!(line.requested > 0)) return;
  ps.expenseLines.push(line);
  ps.poolRequired += line.requested;
}

function offsetBalance(ctx: EngineContext, ...loanIds: (string | undefined)[]): number {
  let s = 0;
  for (const a of ctx.accounts) {
    const id = a.behaviour.offsetForLoanId;
    if (id !== undefined && loanIds.includes(id)) s += Math.max(0, a.p.opening);
  }
  return s;
}

function debtNode(ps: PeriodState, id: string, label: string): string {
  return addNode(ps, { id: `debt:${id}`, kind: "debt", label, refId: id });
}

function assetNode(ps: PeriodState, r: AssetState): string {
  return addNode(ps, {
    id: `asset:${r.def.id}`,
    kind: "asset",
    label: r.def.name,
    refId: r.def.id,
  });
}

/** Value under the appreciation rule between months a and b, clamped by `appreciationLimit`. */
function appreciate(
  ctx: EngineContext,
  r: AssetState,
  value: number,
  a: MonthIndex,
  b: MonthIndex,
): number {
  const v = appreciateRaw(ctx, r, value, a, b);
  const lim = r.behaviour.appreciationLimit;
  if (!lim || b <= a) return v;
  const pi = lim.basis === "real" ? priceIndexAt(ctx, b) : 1;
  let out = v;
  if (lim.max !== undefined) out = Math.min(out, lim.max * pi);
  if (lim.min !== undefined) out = Math.max(out, lim.min * pi);
  return out;
}

function appreciateRaw(
  ctx: EngineContext,
  r: AssetState,
  value: number,
  a: MonthIndex,
  b: MonthIndex,
): number {
  if (b <= a || value === 0) return value;
  const ch = r.behaviour.appreciation;
  if (ch.kind === "schedule" && ch.valueKind === "amount")
    return changedValue(ctx, { value, basis: "real" }, ch, ctx.start, b);
  const one = { value: 1, basis: "nominal" as const };
  return (
    (value * changedValue(ctx, one, ch, ctx.start, b)) / changedValue(ctx, one, ch, ctx.start, a)
  );
}

function assessedValue(ctx: EngineContext, r: AssetState, ps: PeriodState): number {
  const pt = r.behaviour.propertyTax!;
  if (pt.assessedValue.kind === "specific") return pt.assessedValue.amount;
  let kind = pt.reassessment.kind;
  let cap =
    pt.reassessment.kind === "capped" || pt.reassessment.kind === "ratcheting"
      ? pt.reassessment.maxGrowth
      : 0;
  if (kind === "auto") {
    // California Proposition 13: assessed value grows at most 2% a year from the base.
    if (ctx.location.country === "US" && ctx.location.region === "CA") {
      kind = "capped";
      cap = 0.02;
    } else kind = "default";
  }
  const market = r.value;
  if (kind === "default" || r.assessed === null) {
    r.assessed = market;
    return market;
  }
  const grown = r.assessed * (1 + cap) ** (ps.bounds.months / 12);
  if (kind === "ratcheting") {
    // Follows market drops, then regrows from there at most `cap` a year.
    r.assessed = Math.min(market, grown);
    return r.assessed;
  }
  // capped (Prop 13): the base grows at most `cap` a year; assessed = min(market, base).
  r.assessed = grown;
  return Math.min(market, grown);
}

/**
 * Sell an owned asset at month `m` (value already as of the sale). Proceeds net of the broker fee
 * and loan payoff go to `to` (default the pool) unless the sale settings route them to accounts.
 * Returns the net cash delivered to the pool.
 */
export function sellAsset(
  ctx: EngineContext,
  ps: PeriodState,
  r: AssetState,
  reason: "scheduled" | "liquidation" | "recurrence",
): number {
  const sale = r.behaviour.sale;
  const fee = r.value * (sale?.brokerFeeRate ?? 0.06);
  const net = r.value - fee - r.loanBalance;
  const gain = r.value - fee - r.costBasis;
  const node = assetNode(ps, r);
  if (gain > 0) {
    let taxable = gain * (1 - (sale?.gainReduction ?? 0));
    const excluded = r.behaviour.usage === "primary-residence" ? mainHomeExclusion(ctx, ps, r) : 0;
    if (excluded > 0) {
      const used = Math.min(taxable, excluded);
      taxable -= used;
      traceEvent(
        ctx,
        ps,
        "realAssets",
        "HOME_SALE_EXCLUSION",
        () => `${fmt(used)} of the gain on ${r.def.name} is exempt (main residence)`,
        [r.def.id],
        { excluded: used },
      );
    }
    if (taxable > 0)
      ps.taxIncome.push({
        sourceId: `asset-sale:${r.def.id}`,
        owner: r.owner,
        character: "capital-gains-long",
        amount: taxable,
        exemptIn: [],
        ...(ctx.residency?.active
          ? {
              sale: {
                assetId: r.def.id,
                month: ps.bounds.start,
                proceeds: r.value - fee,
                costBasis: r.costBasis,
                gain,
              },
            }
          : {}),
      });
  }
  if (r.loanBalance > 0) {
    // Loan payoff out of the sale price (asset -> loan, not through the pool).
    addLedger(ctx, ps, {
      from: node,
      to: debtNode(ps, r.def.id, `${r.def.name} loan`),
      amount: Math.min(r.loanBalance, r.value - fee),
      kind: "debt-payment",
      causeId: r.def.id,
    });
  }
  let toPool = 0;
  const targets =
    reason !== "liquidation" && sale?.proceedsTo.kind === "accounts"
      ? sale.proceedsTo.accountIds.map((id) => ctx.accountById.get(id)!).filter(Boolean)
      : [];
  if (net > 0) {
    if (targets.length > 0) {
      for (const t of targets) {
        deposit(t, net / targets.length);
        addLedger(ctx, ps, {
          from: node,
          to: accountNode(ps, t),
          amount: net / targets.length,
          kind: "sale",
          causeId: r.def.id,
        });
      }
    } else {
      toPool = net;
      ps.incomeLines.push({
        sourceId: `asset-sale:${r.def.id}`,
        sourceKind: "asset-sale",
        label: `${r.def.name} sale`,
        owner: r.owner,
        amount: net,
        taxCharacter: "tax-free",
      });
      addLedger(ctx, ps, { from: node, to: POOL, amount: net, kind: "sale", causeId: r.def.id });
    }
  } else if (net < 0) {
    // Underwater: the remaining loan must be paid from the pool.
    pushRequiredExpense(ps, {
      sourceId: `loan:${r.def.id}:payoff`,
      sourceKind: "loan-payment",
      label: `${r.def.name} loan payoff`,
      category: "debt",
      owner: r.owner,
      requested: -net,
      funded: -net,
      spendingType: "not-spending",
    });
  }
  r.p.saleProceeds += net;
  traceEvent(
    ctx,
    ps,
    "realAssets",
    reason === "liquidation" ? "ASSET_LIQUIDATED" : "ASSET_SOLD",
    () =>
      `Sold ${r.def.name} for ${fmt(r.value)} (fee ${fmt(fee)}, loan ${fmt(r.loanBalance)}, net ${fmt(net)})`,
    [r.def.id],
    { value: r.value, fee, loan: r.loanBalance, net, gain, reason },
  );
  r.owned = false;
  r.value = 0;
  r.loanBalance = 0;
  r.assessed = null;
  return toPool;
}

/** Main-home gain exclusion from the household's tax rules (US §121, UK private residence relief). */
function mainHomeExclusion(ctx: EngineContext, ps: PeriodState, r: AssetState): number {
  // Cross-border plans: the relief of the country the home is in (a move abroad does not change it).
  const rules = ps.crossBorder
    ? countryRules(ctx, r.def.country ?? ctx.household.location.country)
    : householdRules(ctx, ps);
  for (const j of rules) {
    if (!j.homeSaleExclusion) continue;
    const v = j.homeSaleExclusion({
      filingStatus: ps.tax.filingStatus,
      year: ps.bounds.year,
      priceIndex: ps.piStart,
      monthsOwned: r.acquiredAt === null ? null : ps.bounds.start - r.acquiredAt,
    });
    if (v !== null) return v;
  }
  return 0;
}

/** Plan a purchase: down payment from accounts/pool, loan for the financed part. */
function buy(ctx: EngineContext, ps: PeriodState, r: AssetState, m: MonthIndex): void {
  const pl = r.planned!;
  const pur = pl.purchase;
  const scale = (1 + (r.behaviour.recurrence?.scalingRate ?? 0)) ** pl.cycle;
  const nominal = (amt: { value: number; basis: "real" | "nominal" }) =>
    (amt.basis === "real" ? amt.value * priceIndexAt(ctx, m) : amt.value) *
    scale *
    fxAt(ctx, r.currency, m);
  const price = nominal(pur.price);
  const market = pur.marketValue ? nominal(pur.marketValue) : price;
  const down = pur.financing
    ? Math.min(price, pur.downPayment ? nominal(pur.downPayment) : 0)
    : price;
  r.owned = true;
  r.acquiredAt = m;
  r.value = market;
  r.costBasis = price;
  r.assessed = null;
  r.loanBalance = price - down;
  r.loan = pur.financing
    ? {
        interest: pur.financing.interest,
        monthlyPayment: pur.financing.monthlyPayment,
        termEnd: pur.financing.termEnd,
      }
    : null;
  r.p.purchasePrice += price;
  const line: ExpenseLine = {
    sourceId: `purchase:${r.def.id}:${pl.cycle}`,
    sourceKind: "asset-purchase",
    label: `${r.def.name} purchase`,
    category: "asset-purchase",
    owner: r.owner,
    requested: down,
    funded: down,
    spendingType: "not-spending",
  };
  pushRequiredExpense(ps, line);
  if (pur.fundFromAccountIds.length > 0 && down > 0)
    ps.targeted.push({ line, accountIds: pur.fundFromAccountIds });
  traceEvent(
    ctx,
    ps,
    "realAssets",
    "ASSET_PURCHASED",
    () => `Bought ${r.def.name} for ${fmt(price)} (down ${fmt(down)})`,
    [r.def.id],
    {
      price,
      down,
      loan: price - down,
      cycle: pl.cycle,
    },
  );
  // Next sale for recurrence (hold period = sale.at - first purchase).
  if (pl.holdMonths !== null) pl.saleAt = m + pl.holdMonths;
}

function costLines(ctx: EngineContext, ps: PeriodState, r: AssetState, months: number): void {
  const b = r.behaviour;
  const rented = b.rental?.enabled ? b.rental.rentedShare : 0;
  const value = r.value;
  const fx = assetFx(ctx, ps, r);
  const costs: [string, number, boolean][] = [
    ["Maintenance", assetCost(b.maintenance, value, ps, months, fx), true],
    ["Insurance", assetCost(b.insurance, value, ps, months, fx), false],
    ["Improvements", assetCost(b.improvements, value, ps, months, fx), true],
    ["HOA", assetCost(b.hoa, value, ps, months, fx), false],
  ];
  if (b.propertyTax)
    costs.push([
      "Property tax",
      assetCost(b.propertyTax.cost, assessedValue(ctx, r, ps), ps, months, fx),
      true,
    ]);
  let rentalCosts = 0;
  for (const [label, amount] of costs) {
    if (!(amount > 0)) continue;
    r.p.ownershipCosts += amount;
    const slug = label.toLowerCase().replace(/\s+/g, "-");
    const parts: [number, ExpenseLine["spendingType"], string][] =
      rented > 0 && rented < 1
        ? [
            [amount * (1 - rented), "essential", ""],
            [amount * rented, "not-spending", ":rental"],
          ]
        : [[amount, rented >= 1 ? "not-spending" : "essential", ""]];
    for (const [amt, spendingType, suffix] of parts)
      pushRequiredExpense(ps, {
        sourceId: `asset-cost:${r.def.id}:${slug}${suffix}`,
        sourceKind: "asset-cost",
        label: `${r.def.name} ${label.toLowerCase()}${suffix ? " (rental share)" : ""}`,
        category: "housing",
        owner: r.owner,
        requested: amt,
        funded: amt,
        spendingType,
      });
    rentalCosts += amount * rented;
  }
  if (b.rental?.enabled) rental(ctx, ps, r, months, rentalCosts);
}

function rental(
  ctx: EngineContext,
  ps: PeriodState,
  r: AssetState,
  months: number,
  rentalCosts: number,
): void {
  const rs = r.behaviour.rental!;
  const inc = rs.income;
  let gross =
    inc.kind === "percentOfValue"
      ? (r.value * inc.rate * months) / 12
      : inc.kind === "amountPerYear"
        ? (nominalAtPeriod(ps, inc.amount) * assetFx(ctx, ps, r) * months) / 12
        : nominalAtPeriod(ps, inc.amount) * assetFx(ctx, ps, r) * months;
  if (inc.kind === "percentOfValue") gross *= rs.rentedShare;
  gross *= rs.occupancy;
  if (!(gross > 0)) return;
  r.p.rentalIncome += gross;
  const character = rs.taxSettings.selfEmployment ? "self-employment" : "rental";
  ps.incomeLines.push({
    sourceId: `rental:${r.def.id}`,
    sourceKind: "rental",
    label: `${r.def.name} rent`,
    owner: r.owner,
    amount: gross,
    taxCharacter: character,
  });
  ps.taxIncome.push({
    sourceId: `rental:${r.def.id}`,
    owner: r.owner,
    character,
    amount: gross,
    exemptIn: [],
    incomeType: "rental",
  });
  ps.poolInflow += gross;
  const node = addNode(ps, {
    id: `income:rental:${r.def.id}`,
    kind: "income",
    label: `${r.def.name} rent`,
    refId: r.def.id,
  });
  addLedger(ctx, ps, { from: node, to: POOL, amount: gross, kind: "income", causeId: r.def.id });
  // Management: an AssetCost on the GROSS RENT (percentOfValue = share of rent).
  const mg = rs.management;
  const management =
    mg.kind === "percentOfValue"
      ? gross * mg.rate
      : mg.kind === "none"
        ? 0
        : assetCost(mg, 0, ps, months, assetFx(ctx, ps, r));
  if (management > 0)
    pushRequiredExpense(ps, {
      sourceId: `asset-cost:${r.def.id}:management`,
      sourceKind: "asset-cost",
      label: `${r.def.name} property management`,
      category: "housing",
      owner: r.owner,
      requested: management,
      funded: management,
      spendingType: "not-spending",
    });
  if (rs.taxSettings.estimateDeductions || rs.taxSettings.taxNetIncomeOnly) {
    const life = rs.taxSettings.classification === "commercial" ? 39 : 27.5;
    const depreciation = rs.taxSettings.taxNetIncomeOnly
      ? 0
      : (rs.taxSettings.buildingValue / life) * (months / 12);
    const interest = r.p.loanInterest * rs.rentedShare;
    const amount = Math.min(gross, rentalCosts + management + interest + depreciation);
    if (amount > 0)
      ps.taxDeductions.push({
        sourceId: `rental-deductions:${r.def.id}`,
        kind: "deduction",
        amount,
        itemized: false,
        levels: ["federal", "state", "local"],
        owner: r.owner,
      });
  }
}

function loanPayments(
  ctx: EngineContext,
  ps: PeriodState,
  r: AssetState,
  from: MonthIndex,
  to: MonthIndex,
): void {
  if (!r.loan || r.loanBalance <= 0 || to <= from) return;
  const loan: ActiveLoan = r.loan;
  const term = loan.termEnd ? resolveRef(ctx, loan.termEnd) : null;
  const termAt = typeof term === "number" ? term : Number.POSITIVE_INFINITY;
  const months = to - from;
  const res = amortise(
    r.loanBalance,
    monthlyRate(loan.interest.apr, loan.interest.method, loan.interest.compounding),
    nominalAtPeriod(ps, loan.monthlyPayment) * fxAt(ctx, r.currency, from),
    months,
    (k) => from + k < termAt,
    offsetBalance(ctx, r.def.id, r.def.loan?.id, r.planned?.purchase.financing?.id),
  );
  r.loanBalance = res.balance;
  r.p.loanInterest += res.interest;
  let paid = res.paid;
  if (termAt < to && r.loanBalance > 0) {
    // Balloon: the outstanding balance is due at the end of the term.
    paid += r.loanBalance;
    traceEvent(
      ctx,
      ps,
      "realAssets",
      "LOAN_BALLOON",
      () => `${r.def.name} loan term ends; balloon ${fmt(r.loanBalance)}`,
      [r.def.id],
      {
        balloon: r.loanBalance,
      },
    );
    r.loanBalance = 0;
  }
  r.p.loanPayments += paid;
  pushRequiredExpense(ps, {
    sourceId: `loan:${r.def.id}`,
    sourceKind: "loan-payment",
    label: `${r.def.name} loan payments`,
    category: "debt",
    owner: r.owner,
    requested: paid,
    funded: paid,
    spendingType: "essential",
  });
}

export function runRealAssets(ctx: EngineContext, ps: PeriodState): void {
  const { start, end } = ps.bounds;
  for (const r of ctx.assets) {
    const pl = r.planned;
    const rec = pl ? r.behaviour.recurrence : undefined;
    const untilRef = rec ? resolveRef(ctx, rec.until) : null;
    const until = typeof untilRef === "number" ? untilRef : Number.POSITIVE_INFINITY;
    const gap = rec ? Math.round(rec.yearsBetween * 12) : 0;
    let cursor = start;
    for (let guard = 0; cursor < end && guard < 24; guard++) {
      // Purchase (planned assets and recurrence).
      if (!r.owned) {
        if (r.done || !pl) break;
        if (pl.cycle === 0 && pl.nextPurchase === null) {
          const at = resolveRef(ctx, pl.purchase.at);
          if (typeof at === "number") pl.nextPurchase = Math.max(at, ctx.start);
          else if (at === null) r.done = true;
        }
        if (pl.nextPurchase === null || pl.nextPurchase >= end) break;
        if (pl.cycle > 0 && pl.nextPurchase >= until) {
          r.done = true;
          break;
        }
        cursor = Math.max(cursor, pl.nextPurchase);
        buy(ctx, ps, r, cursor);
        pl.nextPurchase = null;
      }
      // Scheduled sale?
      let saleAt: number | null = null;
      if (pl && rec) {
        saleAt = pl.saleAt;
        const isLast = saleAt === null || saleAt + gap >= until;
        if (!rec.keepLast && Number.isFinite(until) && (saleAt === null || until < saleAt))
          saleAt = until;
        if (rec.keepLast && isLast) saleAt = null;
      } else if (r.behaviour.sale) {
        const s = resolveRef(ctx, r.behaviour.sale.at);
        if (typeof s === "number") saleAt = Math.max(s, cursor);
      }
      const sellNow = saleAt !== null && saleAt < end;
      const ownedTo = sellNow ? Math.max(cursor, saleAt!) : end;
      if (ownedTo > cursor) costLines(ctx, ps, r, ownedTo - cursor);
      loanPayments(ctx, ps, r, cursor, ownedTo);
      r.value = appreciate(ctx, r, r.value, cursor, ownedTo);
      cursor = ownedTo;
      if (!sellNow) break;
      // A tenancy that is not cancelled on sale keeps paying rent to the end of the period.
      if (r.behaviour.rental?.enabled && r.behaviour.rental.cancelOnSale === false && end > ownedTo)
        rental(ctx, ps, r, end - ownedTo, 0);
      ps.poolInflow += sellAsset(ctx, ps, r, rec ? "recurrence" : "scheduled");
      if (pl && rec) {
        pl.cycle += 1;
        pl.saleAt = null;
        const next = ownedTo + gap;
        if (next >= until) r.done = true;
        else pl.nextPurchase = next;
      } else r.done = true;
    }
    // Foreign-currency assets: revalue the value and the loan by the period's FX move.
    if (r.currency && r.owned) {
      const f = fxAt(ctx, r.currency, end) / fxAt(ctx, r.currency, start);
      r.value *= f;
      r.loanBalance *= f;
    }
  }
}

// ------------------------------------------------------------------ debts

export function runDebts(ctx: EngineContext, ps: PeriodState): void {
  for (const d of ctx.debts) {
    if (d.balance <= 0) continue;
    const b = d.behaviour;
    const refs = [d.def.id];
    const startRef = resolveRef(ctx, b.paymentsStart);
    const startAt = typeof startRef === "number" ? startRef : Number.POSITIVE_INFINITY;
    const endRef = b.paymentsEnd ? resolveRef(ctx, b.paymentsEnd) : null;
    const endAt = typeof endRef === "number" ? endRef : Number.POSITIVE_INFINITY;
    let drift = 0;
    if (b.balanceChange) {
      // Balance drift on top of interest (indexation, PL debt yearlyChange), clamped.
      const c = b.balanceChange;
      let next = d.balance * (1 + c.rate) ** (ps.bounds.months / 12);
      if (c.max !== undefined) next = Math.min(next, c.max);
      if (c.min !== undefined) next = Math.max(next, c.min);
      drift = Math.max(0, next) - d.balance;
      d.balance += drift;
    }
    const payment =
      nominalAtPeriod(ps, b.monthlyPaymentOverride ?? d.def.monthlyPayment) *
      fxAt(ctx, d.currency, ps.bounds.start);
    const res = amortise(
      d.balance,
      monthlyRate(d.def.interest.apr, d.def.interest.method, d.def.interest.compounding),
      payment,
      ps.bounds.months,
      (k) => ps.bounds.start + k >= startAt && ps.bounds.start + k < endAt,
      offsetBalance(ctx, d.def.id),
    );
    d.balance = res.balance;
    // Foreign-currency debts: the period's FX move changes the balance in base money; reported with
    // interest (like balance drift) so opening + interest - payments = closing holds.
    if (d.currency && d.balance > 0) {
      const f = fxAt(ctx, d.currency, ps.bounds.end) / fxAt(ctx, d.currency, ps.bounds.start);
      drift += d.balance * (f - 1);
      d.balance *= f;
    }
    // Balance drift is reported with interest so opening + interest - payments = closing holds.
    d.p.interest = res.interest + drift;
    d.p.payments = res.paid;
    if (b.interestTaxDeductible && res.interest > 0)
      ps.taxDeductions.push({
        sourceId: `debt-interest:${d.def.id}`,
        kind: "deduction",
        amount: res.interest,
        itemized: d.def.type !== "student-loan",
        levels: ["federal", "state", "local"],
        owner: d.owner,
      });
    if (b.forgiveness) {
      const f = resolveRef(ctx, b.forgiveness.at);
      if (typeof f === "number" && f < ps.bounds.end && d.balance > 0) {
        if (b.forgiveness.taxable)
          ps.taxIncome.push({
            sourceId: `debt-forgiven:${d.def.id}`,
            owner: d.owner,
            character: "ordinary",
            amount: d.balance,
            exemptIn: [],
          });
        d.p.forgiven = d.balance;
        traceEvent(
          ctx,
          ps,
          "debts",
          "DEBT_FORGIVEN",
          () => `${d.def.name} forgiven (${fmt(d.balance)})`,
          refs,
          {
            amount: d.balance,
            taxable: b.forgiveness.taxable,
          },
        );
        d.balance = 0;
      }
    }
    const line: ExpenseLine = {
      sourceId: `debt:${d.def.id}`,
      sourceKind: "debt-payment",
      label: `${d.def.name} payments`,
      category: "debt",
      owner: d.owner,
      requested: res.paid,
      funded: res.paid,
      spendingType: "essential",
    };
    pushRequiredExpense(ps, line);
    if (b.payFrom.kind === "accounts" && res.paid > 0)
      ps.targeted.push({ line, accountIds: b.payFrom.accountIds });
    if (d.balance <= 1e-9 && d.p.opening > 0)
      warnOnce(ctx, `debt-paid:${d.def.id}`, {
        code: "ASSUMPTION",
        severity: "info",
        message: `${d.def.name} is paid off in ${ps.bounds.year}.`,
        periodIndex: ps.bounds.index,
        refs,
      });
  }
}
