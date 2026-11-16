/**
 * tax.strategy phase (Plan.taxStrategy): use cheap tax room each year before the cash-flow settle.
 * Headroom comes from the tax module's hooks (src/tax/strategy.ts), which re-run the period's
 * jurisdiction stack on the income known at this point (income events, dividends, RMDs...).
 *
 * In order, while the target (bracket rate, IRMAA tier, ACA FPL multiple or an income level) holds:
 *   1. withdrawal shielding: fund this year's expected deficit from tax-deferred accounts (pensions,
 *      IRAs) instead of tax-free / taxable ones, up to the headroom. UK gap years: pension income
 *      inside the personal allowance / basic-rate band before State Pension starts.
 *   2. conversions: move more tax-deferred money into a tax-free account up to the remaining
 *      headroom. US: a Roth conversion (taxable, penalty-free). UK: a taxable pension withdrawal
 *      (UFPLS 25% tax-free) re-invested in an ISA, capped by the ISA allowance left this year.
 *   3. gain harvesting: realise long-term gains in taxable accounts while they are taxed at no more
 *      than `constraints.capitalGainsBracket` (default 0%: the US 0% band, the UK CGT annual exempt
 *      amount). The basis steps up; no cash moves.
 * Constraints: preserveAca caps income at 400% FPL while ACA coverage is active; avoidNiit keeps
 * MAGI under the NIIT threshold for harvesting.
 */
import { US_FIXED } from "../tax/data/us-federal.js";
import { gainHarvestHeadroom, incomeHeadroom, type TaxTarget } from "../tax/strategy.js";
import type { TaxJurisdiction } from "../tax/types.js";
import {
  accountNode,
  crystallisePcls,
  deposit,
  isOpen,
  isWithdrawable,
  withdraw,
} from "./accounts.js";
import { nominalAtPeriod, resolveWindow } from "./amounts.js";
import {
  type AccountState,
  type EngineContext,
  fmt,
  type PeriodState,
  traceEvent,
} from "./context.js";
import { annualLimit } from "./limits.js";
import { buildTaxInput } from "./settle.js";

const PENSION_TYPES = new Set(["uk-sipp", "uk-workplace-pension", "uk-pension"]);

function taxFreeShareOf(a: AccountState): number {
  const b = a.behaviour;
  if (b.ukDrawdownMethod === "pcls") return 0;
  if (b.taxFreeWithdrawalShare !== undefined) return b.taxFreeWithdrawalShare;
  return PENSION_TYPES.has(a.def.type) ? 0.25 : 0;
}

function active(ctx: EngineContext, ps: PeriodState): boolean {
  const ts = ctx.plan.taxStrategy;
  if (!ts?.enabled) return false;
  if (!ts.range) return true;
  const w = resolveWindow(ctx, ts.range);
  return w.start !== null && w.start < ps.bounds.end && w.end > ps.bounds.start;
}

function targetOf(ctx: EngineContext, ps: PeriodState): TaxTarget {
  const t = ctx.plan.taxStrategy!.target;
  if (t.kind === "income")
    return { kind: "income", amount: nominalAtPeriod(ps, t.amount) * (ps.bounds.months / 12) };
  return t;
}

/** Ordinary-income headroom for `owner` under the target and the constraints. */
function headroom(
  ctx: EngineContext,
  ps: PeriodState,
  stack: TaxJurisdiction[],
  owner: string,
): number {
  const ts = ctx.plan.taxStrategy!;
  const input = buildTaxInput(ctx, ps);
  const who = ctx.people.some((p) => p.id === owner) ? owner : undefined;
  const opts = who ? { owner: who } : {};
  let room = incomeHeadroom(stack, input, targetOf(ctx, ps), opts);
  if (ts.constraints.preserveAca && ps.aca)
    room = Math.min(
      room,
      incomeHeadroom(stack, input, { kind: "aca-fpl-multiple", multiple: 4 }, opts),
    );
  return room;
}

function sources(ctx: EngineContext, ps: PeriodState): AccountState[] {
  const ts = ctx.plan.taxStrategy!;
  const ids = ts.conversionSourceAccountIds;
  const list =
    ids.length > 0
      ? ids.map((id) => ctx.accountById.get(id)).filter((a): a is AccountState => !!a)
      : ctx.accounts.filter((a) => a.info.taxTreatment === "tax-deferred");
  return list.filter((a) => a.balance > 1e-9 && isOpen(ctx, a, ps) && isWithdrawable(ctx, a, ps));
}

/** UK PCLS: crystallise the tax-free lump sum on first access (cash to the pool). */
function crystallise(ctx: EngineContext, ps: PeriodState, a: AccountState): number {
  if (a.behaviour.ukDrawdownMethod !== "pcls" || a.pclsTaken) return 0;
  const lump = crystallisePcls(ctx, ps, a);
  ps.poolInflow += lump;
  return lump;
}

/** Expected cash deficit of the period before any drawdown (taxes excluded). */
function expectedDeficit(ps: PeriodState): number {
  return Math.max(0, ps.poolRequired + (ps.strategy?.budget ?? 0) - ps.poolInflow);
}

function destinationFor(
  ctx: EngineContext,
  ps: PeriodState,
  src: AccountState,
): AccountState | undefined {
  const ts = ctx.plan.taxStrategy!;
  const explicit = ts.conversionDestinationAccountId
    ? ctx.accountById.get(ts.conversionDestinationAccountId)
    : undefined;
  if (explicit) return isOpen(ctx, explicit, ps) ? explicit : undefined;
  const uk = PENSION_TYPES.has(src.def.type);
  return ctx.accounts.find(
    (a) =>
      isOpen(ctx, a, ps) &&
      a.info.taxTreatment === "tax-free" &&
      (uk ? a.def.type === "uk-isa" : !a.def.type.startsWith("uk-")) &&
      (a.owner === src.owner || a.owner === "joint"),
  );
}

/** Room left this period in the destination's contribution allowance (ISA); Infinity if uncapped. */
function allowanceLeft(
  ctx: EngineContext,
  ps: PeriodState,
  dst: AccountState,
  isConversion: boolean,
): number {
  if (isConversion) return Number.POSITIVE_INFINITY; // Roth conversions are not contributions
  const lg = annualLimit(ctx, ps, dst);
  if (!lg) return Number.POSITIVE_INFINITY;
  return Math.max(
    0,
    (lg.annual * ps.bounds.months) / 12 - (ps.limitUsed.get(`${dst.owner}|${lg.group}`) ?? 0),
  );
}

export function runTaxStrategy(ctx: EngineContext, ps: PeriodState): void {
  if (!active(ctx, ps)) return;
  const ts = ctx.plan.taxStrategy!;
  const stack = ps.stack.filter((j) => j.status === "implemented");
  if (stack.length === 0) return;

  // 1. Withdrawal shielding: fund the expected deficit from tax-deferred accounts within the room.
  if (ts.modules.withdrawalShielding) {
    let need = expectedDeficit(ps);
    for (const a of sources(ctx, ps)) {
      if (need <= 1e-6) break;
      need -= crystallise(ctx, ps, a);
      if (need <= 1e-6) break;
      const room = headroom(ctx, ps, stack, a.owner);
      if (room <= 1) continue;
      const gross = Math.min(need, room / Math.max(1e-9, 1 - taxFreeShareOf(a)), a.balance);
      const r = withdraw(ctx, ps, a, gross, { purpose: "drawdown", position: 0, need });
      ps.poolInflow += r.gross;
      need -= r.gross;
      traceEvent(
        ctx,
        ps,
        "tax.strategy",
        "TAX_SHIELDED_WITHDRAWAL",
        () => `Drew ${fmt(r.gross)} from ${a.def.name} inside the tax target (room ${fmt(room)})`,
        [a.def.id],
        { amount: r.gross, taxable: r.taxable, headroom: room },
      );
    }
  }

  // 2. Conversions into a tax-free account with the remaining room.
  if (ts.modules.rothConversions) {
    for (const src of sources(ctx, ps)) {
      const dst = destinationFor(ctx, ps, src);
      if (!dst || dst === src) continue;
      const uk = PENSION_TYPES.has(src.def.type);
      crystallise(ctx, ps, src);
      const room = headroom(ctx, ps, stack, src.owner);
      if (room <= 1) continue;
      const cap = allowanceLeft(ctx, ps, dst, !uk);
      const gross = Math.min(room / Math.max(1e-9, 1 - taxFreeShareOf(src)), src.balance, cap);
      if (gross <= 1) continue;
      const to = accountNode(ps, dst);
      const r = withdraw(ctx, ps, src, gross, {
        purpose: "transfer",
        to,
        causeId: "tax-strategy",
        asTransfer: true,
        penaltyFree: !uk,
        ...(uk ? {} : { forceTaxable: true, isConversion: true }),
      });
      if (uk) {
        // Pension cash re-invested in the ISA counts toward the ISA allowance.
        deposit(dst, r.gross);
        dst.p.contributions -= r.gross;
        dst.p.transfersIn += r.gross;
        const lg = annualLimit(ctx, ps, dst);
        if (lg) {
          const key = `${dst.owner}|${lg.group}`;
          ps.limitUsed.set(key, (ps.limitUsed.get(key) ?? 0) + r.gross);
        }
      } else {
        dst.balance += r.gross;
        dst.p.transfersIn += r.gross;
        if (dst.contributionBasis !== null) dst.contributionBasis += r.gross;
        if (dst.costBasis !== null) dst.costBasis += r.gross;
      }
      traceEvent(
        ctx,
        ps,
        "tax.strategy",
        uk ? "TAX_STRATEGY_PENSION_TO_ISA" : "ROTH_CONVERSION",
        () =>
          `${uk ? "Moved" : "Converted"} ${fmt(r.gross)} from ${src.def.name} to ${dst.def.name} (tax room ${fmt(room)})`,
        [src.def.id, dst.def.id],
        { amount: r.gross, taxable: r.taxable, headroom: room },
      );
    }
  }

  // 3. Gain harvesting in taxable accounts.
  if (ts.modules.gainHarvesting) {
    const maxRate = ts.constraints.capitalGainsBracket ?? 0;
    for (const a of ctx.accounts) {
      if (
        a.info.taxTreatment !== "taxable" ||
        a.info.sheltersIncome ||
        a.category === "cash" ||
        a.costBasis === null
      )
        continue;
      if (!isOpen(ctx, a, ps) || a.balance <= 0) continue;
      const unrealised = a.balance - a.costBasis;
      if (unrealised <= 1) continue;
      const who = ctx.people.some((p) => p.id === a.owner) ? a.owner : undefined;
      const input = buildTaxInput(ctx, ps);
      let room = gainHarvestHeadroom(
        stack,
        input,
        maxRate,
        who ? { owner: who, max: unrealised } : { max: unrealised },
      );
      if (ts.constraints.avoidNiit && ctx.location.country === "US") {
        const thr = US_FIXED.niit.threshold[ps.tax.filingStatus] * (ps.bounds.months / 12);
        room = Math.min(
          room,
          incomeHeadroom(
            stack,
            input,
            { kind: "income", amount: thr },
            { character: "capital-gains-long", max: unrealised },
          ),
        );
      }
      const gain = Math.min(room, unrealised);
      if (gain <= 1) continue;
      a.costBasis += gain;
      ps.taxIncome.push({
        sourceId: `harvest:${a.def.id}`,
        owner: a.owner,
        character: "capital-gains-long",
        amount: gain,
        exemptIn: [],
        incomeType: "gain-harvest",
      });
      traceEvent(
        ctx,
        ps,
        "tax.strategy",
        "GAIN_HARVESTED",
        () => `Realised ${fmt(gain)} of gains in ${a.def.name} within the tax-free band`,
        [a.def.id],
        { gain },
      );
    }
  }
}
