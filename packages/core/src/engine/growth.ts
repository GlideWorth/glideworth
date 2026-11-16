/**
 * Rate resolution (fixed, schedule, deterministic historical sequences) and the account growth
 * phase: growth (stock/bond blend by allocation, cash, crypto), dividends/interest and fees on
 * OPENING balances; dividends reinvested (optionally only inside a DRIP window) or paid to the
 * cash pool; taxable dividends/interest become tax items.
 */
import type { AccountBehaviour } from "../schema/accounts.js";
import type { RateSpec } from "../schema/time.js";
import { type DividendTaxDetail, dividendTaxDetail } from "../tax/dividends.js";
import type { ResolvedTaxCharacter } from "../tax/types.js";
import { assignBondShares, isOpen } from "./accounts.js";
import { nominalAtPeriod, resolveWindow } from "./amounts.js";
import {
  addLedger,
  addNode,
  type EngineContext,
  type PeriodState,
  POOL,
  traceEvent,
  unsupported,
  warnOnce,
} from "./context.js";
import { overlapMonths } from "./dates.js";
import { fxAt } from "./indices.js";
import { scheduleAt } from "./schedule.js";

const periodFraction = (ps: PeriodState) => ps.bounds.months / 12;

/** Value of a RateSpec for period `i` (schedule evaluated at the period start month). */
export function rateSpecValue(
  ctx: EngineContext,
  spec: RateSpec,
  i: number,
  label: string,
): number {
  switch (spec.kind) {
    case "none":
      return 0;
    case "fixed":
      return spec.rate;
    case "schedule": {
      const b = ctx.periods[i]!;
      return scheduleAt(
        ctx,
        spec.points.map((p) => ({ at: p.at, value: p.rate })),
        b.start,
        spec.interpolation,
        spec.points[0]?.rate ?? 0,
      );
    }
    case "historical": {
      const ds = ctx.historical;
      const range = ds?.range(spec.series);
      if (!ds || !range) {
        unsupported(
          ctx,
          "engine.historicalDeterministic",
          "c",
          `${label}: historical dataset not supplied`,
        );
        return 0;
      }
      // A sequence that starts before the data does is shifted to the first year with data (all
      // bundled US series start in 1928), not padded by repeating that year's return.
      const startYear = Math.max(spec.startYear, range.first);
      if (startYear !== spec.startYear)
        warnOnce(ctx, `historical-start:${label}:${spec.series}:${spec.startYear}`, {
          code: "ASSUMPTION",
          severity: "warning",
          message: `${label}: the historical sequence was set to start in ${spec.startYear}, but the bundled data for ${spec.series} starts in ${range.first}, so it starts in ${range.first} instead.`,
          periodIndex: null,
          refs: [],
        });
      let year = startYear + i;
      if (year > range.last) {
        const loopStart = Math.max(range.first, Math.min(spec.loopYear ?? range.first, range.last));
        const span = range.last - loopStart + 1;
        year = loopStart + ((year - range.last - 1) % span);
      }
      return (ds.value(spec.series, Math.max(range.first, year)) ?? 0) + (spec.modifier ?? 0);
    }
  }
}

/** Tax items for stock dividends: character, CA/AU treatment and the qualified/ordinary split. */
function dividendItems(b: AccountBehaviour): (DividendTaxDetail & { share: number })[] {
  const q = b.dividends.qualifiedShare;
  const t = b.dividends.treatment;
  if ((t === "auto" || t === "qualified") && q !== undefined)
    return [
      { character: "qualified-dividend", dividendTreatment: "qualified", share: q },
      { character: "ordinary-dividend", dividendTreatment: "ordinary", share: 1 - q },
    ];
  return [{ ...dividendTaxDetail(b.dividends), share: 1 }];
}

function dividendSplit(b: AccountBehaviour): [ResolvedTaxCharacter, number][] {
  return dividendItems(b).map((d) => [d.character, d.share]);
}

/** Share of the period's dividends reinvested under the plan default (DRIP window aware). */
function planReinvestShare(ctx: EngineContext, ps: PeriodState): number {
  const d = ctx.plan.assumptions.dividendReinvestment;
  if (!d.enabled) return 0;
  if (!d.window) return 1;
  const w = resolveWindow(ctx, d.window);
  if (w.start === null) return 0;
  return overlapMonths(w.start, w.end, ps.bounds.start, ps.bounds.end) / ps.bounds.months;
}

/**
 * Capital gains on rebalancing (Assumptions.rebalancingGains). When a taxable account's bond share
 * changes between periods (a glide path or a per-account schedule), moving between stocks and bonds
 * sells `|change| x opening balance` of holdings and realises gains pro rata to the account's
 * unrealised gain; the sale proceeds are re-invested, so the cost basis rises by the gain realised.
 */
function rebalancingGains(ctx: EngineContext, ps: PeriodState): void {
  const on = ctx.plan.assumptions.rebalancingGains === true;
  for (const a of ctx.accounts) {
    const prev = a.prevBondShare;
    a.prevBondShare = a.bondShare;
    if (!on || prev === undefined || prev === null) continue;
    // Switches inside a sheltered wrapper (PEA, assurance-vie) realise nothing.
    if (
      a.info.taxTreatment !== "taxable" ||
      a.info.sheltersIncome ||
      a.info.assetClass !== "portfolio" ||
      a.costBasis === null
    )
      continue;
    const opening = Math.max(0, a.p.opening);
    const change = Math.abs(a.bondShare - prev);
    if (!(change > 1e-9) || !(opening > 0)) continue;
    const unrealised = opening - a.costBasis;
    if (!(unrealised > 0)) continue;
    const sold = change * opening;
    const gain = sold * (unrealised / opening);
    a.costBasis += gain;
    ps.taxIncome.push({
      sourceId: `rebalance:${a.def.id}`,
      owner: a.owner,
      character: "capital-gains-long",
      amount: gain,
      exemptIn: [],
      incomeType: "rebalance",
    });
    traceEvent(
      ctx,
      ps,
      "growth",
      "REBALANCE_GAIN",
      () =>
        `${a.def.name}: bond share ${(prev * 100).toFixed(1)}% -> ${(a.bondShare * 100).toFixed(1)}%; rebalancing sells ${sold.toFixed(2)} and realises a ${gain.toFixed(2)} gain`,
      [a.def.id],
      { sold, gain, from: prev, to: a.bondShare },
    );
  }
}

export function runGrowth(ctx: EngineContext, ps: PeriodState): void {
  assignBondShares(ctx, ps);
  rebalancingGains(ctx, ps);
  const planReinvest = planReinvestShare(ctx, ps);
  const fr = periodFraction(ps);
  const i = ps.bounds.index;
  for (const a of ctx.accounts) {
    // Empty accounts still get their rate: the cash-flow timing convention credits this period's
    // contributions with part of it (an account opened empty this year used to earn nothing).
    if (!isOpen(ctx, a, ps)) continue;
    const b = a.behaviour;
    const m = ctx.options.market && b.monteCarlo === "fixed" ? ps.baseMarket : ps.market;
    const share = a.bondShare;
    const offset = b.offsetForLoanId !== undefined;

    let stockRate =
      a.info.assetClass === "cash" ? m.cash : a.info.assetClass === "crypto" ? m.crypto : m.stocks;
    if (b.growth.kind !== "inherit")
      stockRate = rateSpecValue(ctx, b.growth, i, `${a.def.name} growth`);
    const annualGrowth =
      offset || b.growth.kind === "none" ? 0 : (1 - share) * stockRate + share * m.bonds;

    let annualYield = 0;
    /** Bond-fund distributions (bond yield) as a share of the account's dividends. */
    let bondIncomeShare = 0;
    const y = b.dividends.yield;
    if (y.kind === "inherit") {
      if (a.info.assetClass === "portfolio") {
        const bondPart = share * m.bondYield;
        annualYield = (1 - share) * m.dividendYield + bondPart;
        bondIncomeShare = annualYield > 0 ? Math.max(0, Math.min(1, bondPart / annualYield)) : 0;
      }
    } else annualYield = rateSpecValue(ctx, y, i, `${a.def.name} dividend yield`);
    if (offset) annualYield = 0;
    a.p.rate = annualGrowth + annualYield;

    // A negative balance (an overdrawn account) earns no investment return, pays no yield and is
    // charged no %-of-balance fee: compounding it at the portfolio rate would grow the debt at the
    // stock return, and a % fee on it would be a credit.
    const opening = Math.max(0, a.p.opening);
    const growth = opening * ((1 + annualGrowth) ** fr - 1);
    const dividends = Math.max(0, opening * annualYield * fr);
    let fees = 0;
    const f = b.fees;
    if (f.kind === "percentOfBalance") fees = opening * f.rate * fr;
    else if (f.kind === "percentOfEarnings") fees = Math.max(0, growth + dividends) * f.rate;
    else if (f.kind === "amount") fees = nominalAtPeriod(ps, f.amount) * fr;

    // Wrappers that capitalise income (PEA, assurance-vie) always reinvest inside the wrapper.
    const sheltered = a.info.sheltersIncome === true;
    const reinvestShare = sheltered
      ? 1
      : b.dividends.reinvest === "inherit"
        ? planReinvest
        : b.dividends.reinvest
          ? 1
          : 0;
    const reinvested = dividends * reinvestShare;
    const paidOut = dividends - reinvested;
    fees = Math.min(fees, Math.max(0, opening + growth + reinvested));

    // Foreign-currency accounts: the period's FX move revalues the opening holding (in base money);
    // reported inside `growth` (and as `fxGain`) so balances still reconcile. Cost basis stays at
    // the historical base-currency cost, so FX gains are taxable gains when sold.
    let fxGain = 0;
    if (a.currency) {
      const f = fxAt(ctx, a.currency, ps.bounds.end) / fxAt(ctx, a.currency, ps.bounds.start);
      fxGain = Math.max(0, a.p.opening + growth + reinvested - fees) * (f - 1);
    }
    a.p.growth = growth + fxGain;
    a.p.fx = fxGain;
    a.p.dividends = dividends;
    a.p.dividendsReinvested = reinvested;
    a.p.fees = fees;
    a.balance += growth + fxGain + reinvested - fees;
    // Reinvested taxed income raises the cost basis; capitalised wrapper income does not (it is part
    // of the gain taxed on withdrawal).
    if (reinvested > 0 && a.costBasis !== null && !sheltered) a.costBasis += reinvested;

    const taxable = a.info.taxTreatment === "taxable" && !sheltered;
    // Cash accounts whose interest is modelled as a yield (a savings rate entered as a "dividend"
    // rate) earn taxable interest, exactly like interest modelled as growth below.
    const cashYield = a.info.taxTreatment === "cash";
    if (paidOut > 0) {
      ps.poolInflow += paidOut;
      ps.incomeLines.push({
        sourceId: `dividends:${a.def.id}`,
        sourceKind: "dividend",
        label: `${a.def.name} dividends`,
        owner: a.owner,
        amount: paidOut,
        taxCharacter: taxable ? dividendSplit(b)[0]![0] : cashYield ? "interest" : "tax-free",
      });
      const node = addNode(ps, {
        id: `income:dividends:${a.def.id}`,
        kind: "income",
        label: `${a.def.name} dividends`,
        refId: a.def.id,
      });
      addLedger(ctx, ps, {
        from: node,
        to: POOL,
        amount: paidOut,
        kind: "income",
        causeId: a.def.id,
      });
    }
    if (taxable && dividends > 0) {
      const stock = dividends * (1 - bondIncomeShare);
      for (const d of dividendItems(b))
        if (d.share > 0 && d.character !== "tax-free")
          ps.taxIncome.push({
            sourceId: `dividends:${a.def.id}`,
            owner: a.owner,
            character: d.character,
            amount: stock * d.share,
            exemptIn: [],
            incomeType: "dividend",
            ...(d.dividendTreatment ? { dividendTreatment: d.dividendTreatment } : {}),
            ...(d.frankedShare !== undefined ? { frankedShare: d.frankedShare } : {}),
          });
      // Bond fund distributions are interest for tax (US ordinary dividends, UK savings income).
      if (
        bondIncomeShare > 0 &&
        b.dividends.treatment !== "tax-free" &&
        b.dividends.treatment !== "municipal"
      )
        ps.taxIncome.push({
          sourceId: `dividends:${a.def.id}`,
          owner: a.owner,
          character: "interest",
          amount: dividends * bondIncomeShare,
          exemptIn: [],
          incomeType: "bond-dividend",
        });
    }
    if (cashYield && growth + dividends > 0)
      ps.taxIncome.push({
        sourceId: `interest:${a.def.id}`,
        owner: a.owner,
        character: "interest",
        amount: Math.max(0, growth) + dividends,
        exemptIn: [],
        incomeType: "interest",
      });
  }
}
