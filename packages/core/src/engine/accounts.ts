/**
 * Account helpers: open/withdrawable/liquid gates, access ages (incl. UK normal minimum pension
 * age), bond allocation (glide paths, overrides, asset location), deposits and withdrawals with
 * their tax classification.
 *
 * Withdrawal tax handling (ARCHITECTURE §4.2):
 *   - taxable / crypto: realise gains pro rata to cost basis (capital-gains-long).
 *   - tax-deferred: ordinary income minus any tax-free share. UK pensions default to UFPLS (25% of
 *     each withdrawal tax-free); PCLS crystallises a 25% lump sum on first access. Both are capped
 *     by the UK lump-sum allowance per person.
 *   - tax-free: contribution basis first; earnings are taxable and penalised only when early.
 *   - cash, HSA, education: qualified use (no tax).
 *   - Early-withdrawal penalties apply to the taxable/earnings part when the account's
 *     earlyWithdrawal toggle is on and the owner is under the qualified age. A UK LISA early
 *     withdrawal pays the 25% government charge on the whole amount.
 */
import type { AccountBehaviour } from "../schema/accounts.js";
import { pickYear } from "../tax/common.js";
import { UK_PENSION_ACCESS, UK_TAX_YEARS, ukNormalMinimumPensionAge } from "../tax/data/uk.js";
import { US_FIXED } from "../tax/data/us-federal.js";
import type { ResolvedTaxCharacter } from "../tax/types.js";
import {
  type AccountState,
  addLedger,
  addNode,
  type EngineContext,
  fmt,
  ownerAge,
  ownerPerson,
  type PeriodState,
  POOL,
  traceEvent,
  warnOnce,
} from "./context.js";
import { type MonthIndex, monthAtAge, monthOfYear, parseMonth, yearOf } from "./dates.js";
import { resolveRef } from "./milestones.js";
import { rulesFor } from "./rules.js";
import { scheduleAt } from "./schedule.js";
import type { LedgerEntry } from "./types.js";
import { moneyWarning } from "./warnings.js";

/** UK lump-sum allowance (tax-free pension cash per person, frozen in nominal terms; UK tax data). */
export const UK_LUMP_SUM_ALLOWANCE = pickYear(UK_TAX_YEARS, 2026).pensions.lumpSumAllowance;
const UK_PENSION_TYPES = new Set(["uk-sipp", "uk-workplace-pension", "uk-pension"]);

export function isUkPension(a: AccountState): boolean {
  return UK_PENSION_TYPES.has(a.def.type);
}

export function isOpen(ctx: EngineContext, a: AccountState, ps: PeriodState): boolean {
  if (a.opensRef) {
    const m = resolveRef(ctx, a.opensRef);
    if (typeof m !== "number") return false;
    a.opensAt = m;
    a.opensRef = null;
  }
  if (a.opensAt === null) return true;
  return a.opensAt < ps.bounds.end;
}

/**
 * UK normal minimum pension age: 55, rising to 57 from 6 April 2028. Returns the FIRST month of
 * access (55 for anyone who turns 55 before April 2028). Whether the pension is open at a given
 * month is `ukPensionOpenAt`: someone who turns 55 before April 2028 but is under 57 then loses
 * access again from April 2028 until 57 (protected pension ages are not modelled).
 */
export function ukPensionAccessMonth(birth: MonthIndex): MonthIndex {
  return monthAtAge(birth, ukNormalMinimumPensionAge(yearOf(birth), monthOfYear(birth) + 1));
}

const UK_NMPA_RISES_AT =
  UK_PENSION_ACCESS.laterFromYear * 12 + (UK_PENSION_ACCESS.laterFromMonth - 1);

/** True when a UK pension may be accessed at `at` under the normal minimum pension age then in force. */
export function ukPensionOpenAt(birth: MonthIndex, at: MonthIndex): boolean {
  const age = at < UK_NMPA_RISES_AT ? UK_PENSION_ACCESS.age : UK_PENSION_ACCESS.laterAge;
  return at >= monthAtAge(birth, age);
}

/**
 * Locked pension wrapper without a modelled early-access penalty (UK pensions, DE bAV / Riester /
 * Rürup, NL pension, FR PER, IL / IE pensions, KiwiSaver): statutory access rules apply and the
 * account cannot be drawn before its access age.
 */
function statutoryLocked(a: AccountState): boolean {
  return (
    (a.info.lockedUntilAccessAge === true || isUkPension(a)) && !a.behaviour.earlyWithdrawal.enabled
  );
}

/** True when a locked pension may be accessed at `at` (UK: the normal minimum pension age then in force). */
function lockedOpenAt(ctx: EngineContext, a: AccountState, at: MonthIndex): boolean {
  const birth = ownerPerson(ctx, a.owner).birth;
  if (isUkPension(a)) return ukPensionOpenAt(birth, at);
  const age = accessAge(ctx, a);
  return age === null || at >= monthAtAge(birth, age);
}

/**
 * Statutory access age for an account from its country's tax plug-in (UK normal minimum pension
 * age, US 59.5 / HSA 65, AU preservation age), else the account type's default.
 */
export function accessAge(ctx: EngineContext, a: AccountState): number | null {
  const p = ownerPerson(ctx, a.owner);
  for (const j of rulesFor(ctx, a)) {
    if (!j.pensionAccessAge) continue;
    const v = j.pensionAccessAge({
      accountType: a.def.type,
      birthYear: yearOf(p.birth),
      birthMonth: monthOfYear(p.birth) + 1,
    });
    if (v !== null) return v;
  }
  if (isUkPension(a)) return ukNormalMinimumPensionAge(yearOf(p.birth), monthOfYear(p.birth) + 1);
  return a.info.qualifiedAge ?? null;
}

/** Month from which an account is penalty-free / accessible by age (null = no age rule). */
export function qualifiedMonth(ctx: EngineContext, a: AccountState): MonthIndex | null {
  const p = ownerPerson(ctx, a.owner);
  if (a.behaviour.earlyWithdrawal.enabled)
    return monthAtAge(p.birth, a.behaviour.earlyWithdrawal.qualifiedAge);
  const age = accessAge(ctx, a);
  return age ? monthAtAge(p.birth, age) : null;
}

export function isWithdrawable(ctx: EngineContext, a: AccountState, ps: PeriodState): boolean {
  const rule = a.behaviour.withdrawals;
  const at = ps.bounds.start;
  switch (rule.kind) {
    case "always":
      // Locked pensions cannot be accessed before their access age (UK normal minimum pension age,
      // DE 62, NL AOW age, ...) unless the plan explicitly models an early-access penalty.
      if (statutoryLocked(a)) return lockedOpenAt(ctx, a, at);
      return true;
    case "never":
      return false;
    case "afterQualifiedAge": {
      if (statutoryLocked(a)) return lockedOpenAt(ctx, a, at);
      const q = qualifiedMonth(ctx, a);
      return q === null || at >= q;
    }
    case "from": {
      const m = resolveRef(ctx, rule.ref);
      return typeof m === "number" && at >= m;
    }
    case "until": {
      const m = resolveRef(ctx, rule.ref);
      return m === null || m === "pending" || at < m;
    }
  }
}

export function isLiquid(ctx: EngineContext, a: AccountState, ps: PeriodState): boolean {
  switch (a.behaviour.liquid) {
    case "always":
      return true;
    case "never":
      return false;
    case "whenWithdrawable":
      return isWithdrawable(ctx, a, ps);
    case "afterQualifiedAge": {
      if (statutoryLocked(a)) return lockedOpenAt(ctx, a, ps.bounds.start);
      const q = qualifiedMonth(ctx, a);
      return q === null || ps.bounds.start >= q;
    }
  }
}

/** True when the owner is younger than the penalty-free age and the account models a penalty. */
export function isEarly(ctx: EngineContext, a: AccountState, at: MonthIndex): boolean {
  if (statutoryLocked(a)) return !lockedOpenAt(ctx, a, at);
  const q = qualifiedMonth(ctx, a);
  return q !== null && at < q;
}

// ------------------------------------------------------------------ bonds

function ownBondShare(ctx: EngineContext, b: AccountBehaviour, at: MonthIndex): number | null {
  const own = b.bondAllocation;
  if (own.kind === "none") return 0;
  if (own.kind === "fixed") return own.share;
  if (own.kind === "schedule")
    return clamp01(scheduleAt(ctx, own.points, at, own.interpolation, 0));
  return null;
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

/** Plan-level portfolio bond share at month `at` (fixed or glide path). */
export function planBondShare(ctx: EngineContext, at: MonthIndex): number {
  const plan = ctx.plan.assumptions.bondAllocation;
  if (plan.kind === "none") return 0;
  if (plan.kind === "fixed") return plan.share;
  return clamp01(scheduleAt(ctx, plan.points, at, plan.interpolation, plan.share));
}

/**
 * Assign each portfolio account its bond share for the period.
 *  - Accounts with their own allocation keep it (per-account override).
 *  - Inheriting accounts share the plan target. With an asset-location priority list, bonds fill
 *    the listed accounts first until the portfolio-wide target is met; otherwise ('even') every
 *    inheriting account holds the target share. 'weighted' sizes the inheriting accounts' share
 *    so the WHOLE portfolio (overrides included) meets the target.
 *  - If overrides make the target unreachable, the share is clamped and a warning is emitted.
 */
export function assignBondShares(ctx: EngineContext, ps: PeriodState): void {
  const at = ps.bounds.start;
  const target = planBondShare(ctx, at);
  const settings = ctx.plan.assumptions.bondAllocation;
  const inheriting: AccountState[] = [];
  let total = 0;
  let fixedBonds = 0;
  for (const a of ctx.accounts) {
    if (a.info.assetClass !== "portfolio") {
      a.bondShare = 0;
      continue;
    }
    const own = ownBondShare(ctx, a.behaviour, at);
    const bal = Math.max(0, a.balance);
    total += bal;
    if (own === null) inheriting.push(a);
    else {
      a.bondShare = own;
      fixedBonds += own * bal;
    }
  }
  if (inheriting.length === 0) return;
  const useLocation = settings.locationPriority.length > 0;
  if (!useLocation && settings.distribution === "even") {
    for (const a of inheriting) a.bondShare = target;
    return;
  }
  const inheritTotal = inheriting.reduce((s, a) => s + Math.max(0, a.balance), 0);
  let needed = target * total - fixedBonds;
  if (needed < -1e-9 || needed > inheritTotal + 1e-9) {
    warnOnce(ctx, "bond-location-unbalanced", {
      code: "ASSUMPTION",
      severity: "warning",
      message: `From ${ps.bounds.year}, per-account bond allocations make the portfolio-wide bond target unreachable; the closest achievable allocation is used.`,
      periodIndex: ps.bounds.index,
      refs: [],
    });
  }
  needed = Math.min(Math.max(0, needed), inheritTotal);
  if (!useLocation) {
    const share = inheritTotal > 0 ? needed / inheritTotal : target;
    for (const a of inheriting) a.bondShare = share;
    return;
  }
  const ordered = [
    ...settings.locationPriority
      .map((id) => inheriting.find((a) => a.def.id === id))
      .filter((a): a is AccountState => !!a),
    ...inheriting.filter((a) => !settings.locationPriority.includes(a.def.id)),
  ];
  for (const a of ordered) {
    const bal = Math.max(0, a.balance);
    const bonds = Math.min(bal, needed);
    a.bondShare = bal > 0 ? bonds / bal : needed > 0 ? 1 : 0;
    needed -= bonds;
  }
}

// ------------------------------------------------------------------ money in / out

export function accountNode(ps: PeriodState, a: AccountState): string {
  return addNode(ps, {
    id: `account:${a.def.id}`,
    kind: "account",
    label: a.def.name,
    refId: a.def.id,
  });
}

export function deposit(a: AccountState, amount: number, basis = true): void {
  a.balance += amount;
  a.p.contributions += amount;
  if (basis && a.costBasis !== null) a.costBasis += amount;
  if (basis && a.contributionBasis !== null) a.contributionBasis += amount;
}

export interface WithdrawOptions {
  /** Why the money moved (trace + penalty rules). */
  purpose: "drawdown" | "required" | "sepp" | "targeted" | "transfer" | "qcd" | "flow-funding";
  /** Penalty-free (SEPP, RMD, QCD...). */
  penaltyFree?: boolean;
  /** Not taxable at all (QCD, tax-exempt transfer, rollover). */
  taxExempt?: boolean;
  /** Force ordinary taxation of the full amount (transfer 'taxable'). */
  forceTaxable?: boolean;
  /** Ledger destination node (default: the cash pool). */
  to?: string;
  causeId?: string;
  /** Drawdown position for the trace. */
  position?: number;
  need?: number;
  /** Count as a transfer (transfersOut) rather than a withdrawal. */
  asTransfer?: boolean;
  /** Roth conversion (tax-deferred -> tax-free): reported to the tax plug-ins as a conversion. */
  isConversion?: boolean;
  /** Drawdown rule recorded on the ledger entry (proportional / fill-to-ceiling entries). */
  rule?: LedgerEntry["rule"];
}

const DEPLETION_CAUSE: Record<WithdrawOptions["purpose"], string> = {
  drawdown: "withdrawals to cover spending that income did not cover used up its balance",
  required: "a required or scheduled distribution took the rest of its balance",
  sepp: "substantially equal periodic payments took the rest of its balance",
  targeted: "payments set to come from this account used up its balance",
  transfer: "a transfer moved out the rest of its balance",
  qcd: "a qualified charitable distribution took the rest of its balance",
  "flow-funding": "it funded a contribution elsewhere with the rest of its balance",
};

export interface WithdrawResult {
  gross: number;
  taxable: number;
  /** US traditional IRA basis (nondeductible contributions) that left with this withdrawal. */
  iraBasis?: number;
  /** Tax-free pension cash included in gross (UK). */
  taxFreeCash: number;
}

function lsaRemaining(ctx: EngineContext, owner: string, year: number): number {
  const lsa = pickYear(UK_TAX_YEARS, year).pensions.lumpSumAllowance;
  return Math.max(0, lsa - (ctx.lsaUsed.get(owner) ?? 0));
}

const US_ROTH = new Set([
  "roth-ira",
  "roth-401k",
  "roth-403b",
  "roth-457b",
  "roth-tsp",
  "inherited-roth-ira",
]);
const US_EDUCATION = new Set(["529", "coverdell-esa"]);

/** Roth five-year clock: opened (or first planned to open) at least five years before `at`. */
function fiveYearsMet(_ctx: EngineContext, a: AccountState, at: MonthIndex): boolean {
  if (a.def.type === "inherited-roth-ira") return true;
  const opened = a.def.openedOn ? parseMonth(a.def.openedOn) : a.opensAt;
  if (opened === null || opened === undefined || !Number.isFinite(opened)) return true;
  return at - opened >= US_FIXED.rothFiveYearRule * 12;
}

/** Tax-free share of a tax-deferred withdrawal before any allowance cap. */
function taxFreeShare(a: AccountState): number {
  const b = a.behaviour;
  if (b.taxFreeWithdrawalShare !== undefined) return b.taxFreeWithdrawalShare;
  const method = b.ukDrawdownMethod ?? (isUkPension(a) ? "ufpls" : undefined);
  return method === "ufpls" ? 0.25 : 0;
}

/**
 * Gross withdrawal from an account whose taxable part is about `taxable`, following `withdraw`'s
 * rules for tax-deferred accounts (tax-free share, UK lump sum allowance, PCLS and early access).
 * IRA basis is ignored, so the estimate never draws more taxable income than asked.
 */
export function grossForTaxable(
  ctx: EngineContext,
  ps: PeriodState,
  a: AccountState,
  taxable: number,
): number {
  if (a.info.taxTreatment !== "tax-deferred") return taxable;
  const ukPension = isUkPension(a) || a.behaviour.ukDrawdownMethod !== undefined;
  if (a.behaviour.ukDrawdownMethod === "pcls" || (ukPension && isEarly(ctx, a, ps.bounds.start)))
    return taxable;
  const share = Math.min(taxFreeShare(a), 1 - 1e-9);
  if (share <= 0) return taxable;
  const gross = taxable / (1 - share);
  return ukPension ? Math.min(gross, taxable + lsaRemaining(ctx, a.owner, ps.bounds.year)) : gross;
}

/** Fraction of the period a flow is invested for under each cash-flow timing convention. */
export const TIMING_SHARE = { start: 1, mid: 0.5, end: 0 } as const;

/**
 * Return credited to (or, for a withdrawal, forgone by) one unit of this period's net flow under the
 * cash-flow timing convention: (1 + rate)^(share of the period invested) - 1. See applyCashFlowTiming.
 */
export function timingGrowth(ctx: EngineContext, ps: PeriodState, a: AccountState): number {
  const k = TIMING_SHARE[ctx.plan.assumptions.cashFlowTiming ?? "mid"];
  if (k === 0 || a.p.rate === 0) return 0;
  return (1 + a.p.rate) ** ((ps.bounds.months / 12) * k) - 1;
}

/**
 * The most that can be withdrawn from the account now, consistently with the cash-flow timing
 * convention. Growth is credited on the opening balance and flows are booked at the period end, then
 * applyCashFlowTiming charges each unit of net outflow the return it forgoes (q). The account ends
 * the period at balance + net * q, so a further withdrawal w is possible only while
 * balance - w + (net - w) * q >= 0, i.e. w <= (balance + net * q) / (1 + q). With 'start' timing and
 * no other flows that is the opening balance (a start-of-year withdrawal cannot spend the year's
 * growth); with 'mid' it is the opening balance grown for half the period. Before this cap the final
 * withdrawal of a depleting account was paid from the fully grown balance and the timing charge was
 * clamped at zero. A negative return (q < 0) is not extended beyond the current balance.
 */
export function withdrawable(ctx: EngineContext, ps: PeriodState, a: AccountState): number {
  const bal = Math.max(0, a.balance);
  const q = timingGrowth(ctx, ps, a);
  if (!(q > 0)) return bal;
  const net = a.p.contributions + a.p.transfersIn - a.p.withdrawals - a.p.transfersOut;
  return Math.max(0, Math.min(bal, (a.balance + net * q) / (1 + q)));
}

/**
 * Withdraw `amount` (capped at what the account can pay: `withdrawable`) from an account, classifying the taxable part and
 * registering tax items, ledger entries and a trace entry. Returns the gross amount.
 */
export function withdraw(
  ctx: EngineContext,
  ps: PeriodState,
  a: AccountState,
  amount: number,
  o: WithdrawOptions,
): WithdrawResult {
  const w = Math.min(amount, withdrawable(ctx, ps, a));
  if (!(w > 1e-12)) return { gross: 0, taxable: 0, taxFreeCash: 0 };
  const at = ps.bounds.start;
  const age = ownerAge(ctx, a.owner, at);
  const penaltyEnabled = a.behaviour.earlyWithdrawal.enabled && !o.penaltyFree;
  const early = isEarly(ctx, a, at) && !o.penaltyFree;
  let taxable = 0;
  let taxFreeCash = 0;
  /** Penalty set by statute regardless of the account's early-withdrawal toggle (HSA, 529). */
  let statutoryPenalty = 0;
  let character: ResolvedTaxCharacter = "ordinary";
  const ukPension = isUkPension(a) || a.behaviour.ukDrawdownMethod !== undefined;
  switch (a.info.taxTreatment) {
    case "taxable": {
      const basis = a.costBasis ?? a.balance;
      const gainShare = a.balance > 0 ? Math.max(0, 1 - basis / a.balance) : 0;
      taxable = w * gainShare;
      character = "capital-gains-long";
      if (a.costBasis !== null)
        a.costBasis = Math.max(0, a.costBasis - a.costBasis * (w / a.balance));
      break;
    }
    case "tax-deferred": {
      let free = w * taxFreeShare(a);
      // PCLS cash comes from crystallisePcls; and no pension commencement cash exists before the
      // access age (an early, penalised withdrawal is an unauthorised payment: all of it taxable).
      if (a.behaviour.ukDrawdownMethod === "pcls" || (ukPension && early && !o.penaltyFree))
        free = 0;
      if (ukPension && free > 0) {
        free = Math.min(free, lsaRemaining(ctx, a.owner, ps.bounds.year));
        ctx.lsaUsed.set(a.owner, (ctx.lsaUsed.get(a.owner) ?? 0) + free);
      }
      taxFreeCash = free;
      taxable = w - free;
      break;
    }
    case "tax-free": {
      const fromBasis = a.contributionBasis === null ? w : Math.min(w, a.contributionBasis);
      if (a.contributionBasis !== null) a.contributionBasis -= fromBasis;
      // US Roth earnings are qualified only after 59.5 AND five years since the account was opened;
      // otherwise they are taxable (and penalised when the account models the early penalty).
      const roth = US_ROTH.has(a.def.type) && !o.penaltyFree;
      const nonQualified = early || (roth && !fiveYearsMet(ctx, a, at));
      taxable = (roth && nonQualified) || (early && penaltyEnabled) ? w - fromBasis : 0;
      break;
    }
    case "hsa": {
      // Qualified medical use up to this period's healthcare spending; the rest is ordinary income,
      // plus the 20% additional tax before 65 (US HSA).
      const qualified = o.penaltyFree ? w : Math.min(w, ps.qualified.healthcare);
      ps.qualified.healthcare -= Math.min(ps.qualified.healthcare, qualified);
      if (a.def.type === "hsa") {
        taxable = w - qualified;
        if (taxable > 0 && age < US_FIXED.hsaPenaltyFreeAge)
          statutoryPenalty = US_FIXED.hsaNonQualifiedPenalty;
      }
      break;
    }
    case "education": {
      // 529 / Coverdell: qualified up to this period's education spending; the earnings share of a
      // non-qualified withdrawal is ordinary income plus a 10% additional tax.
      const qualified = o.penaltyFree ? w : Math.min(w, ps.qualified.education);
      ps.qualified.education -= Math.min(ps.qualified.education, qualified);
      const basis = a.costBasis ?? a.balance;
      const earningsShare = a.balance > 0 ? Math.max(0, 1 - basis / a.balance) : 0;
      if (a.costBasis !== null)
        a.costBasis = Math.max(0, a.costBasis - a.costBasis * (w / a.balance));
      if (US_EDUCATION.has(a.def.type)) {
        taxable = (w - qualified) * earningsShare;
        if (taxable > 0) statutoryPenalty = US_FIXED.educationNonQualifiedPenalty;
      }
      break;
    }
    default:
      taxable = 0; // cash
  }
  if (o.taxExempt) taxable = 0;
  if (o.forceTaxable) {
    taxable = w;
    character = "ordinary";
  }
  if (ukPension && taxable > 0 && a.info.taxTreatment === "tax-deferred")
    ctx.flexiblyAccessed.add(a.owner);
  // US traditional IRA basis: a pro-rata share of each distribution is the return of
  // nondeductible contributions and is not taxed (IRC 72, 408(d)(1); Form 8606).
  let basisOut = 0;
  if (a.iraBasis > 0 && a.balance > 0) {
    basisOut = Math.min(a.iraBasis, (w * a.iraBasis) / a.balance);
    a.iraBasis -= basisOut;
    if (!o.taxExempt) taxable = Math.max(0, taxable - basisOut);
  }
  a.balance -= w;
  if (o.asTransfer) a.p.transfersOut += w;
  else a.p.withdrawals += w;

  const penaltyRate =
    o.taxExempt || o.penaltyFree
      ? 0
      : statutoryPenalty > 0
        ? statutoryPenalty
        : early && penaltyEnabled
          ? a.behaviour.earlyWithdrawal.penaltyRate
          : 0;
  const lisaCharge = a.def.type === "uk-lisa" && early && !o.taxExempt;
  ps.taxWithdrawals.push({
    accountId: a.def.id,
    accountType: a.def.type,
    treatment: a.info.taxTreatment,
    owner: a.owner,
    amount: w,
    taxableAmount: taxable,
    character,
    penaltyRate: lisaCharge ? 0 : penaltyRate,
    ownerAge: age,
    ...(o.isConversion ? { isConversion: true } : {}),
    ...(o.isConversion && o.causeId ? { causeId: o.causeId } : {}),
  });
  if (lisaCharge) {
    const rate = a.behaviour.earlyWithdrawal.enabled
      ? a.behaviour.earlyWithdrawal.penaltyRate
      : 0.25;
    ps.engineTaxLines.push({
      jurisdictionId: "engine",
      kind: "penalty",
      label: `${a.def.name} early withdrawal charge`,
      amount: w * rate,
      base: w,
    });
  }
  if ((penaltyRate > 0 && taxable > 0) || lisaCharge) {
    const q = qualifiedMonth(ctx, a);
    const qAge = q === null ? null : (q - ownerPerson(ctx, a.owner).birth) / 12;
    const rate = lisaCharge
      ? a.behaviour.earlyWithdrawal.enabled
        ? a.behaviour.earlyWithdrawal.penaltyRate
        : 0.25
      : penaltyRate;
    ctx.warnings.push({
      code: "EARLY_WITHDRAWAL_PENALTY",
      severity: "warning",
      ...moneyWarning(
        ctx.household,
        `In ${ps.bounds.year}, {withdrawn} was withdrawn from ${a.def.name} at age ${age.toFixed(1)}${qAge === null ? "" : `, before its penalty-free age of ${qAge.toFixed(1)}`}, so a ${(rate * 100).toFixed(0)}% early-withdrawal penalty applies.`,
        [{ token: "withdrawn", nominal: w, measure: "flow" }],
      ),
      periodIndex: ps.bounds.index,
      refs: [a.def.id],
    });
  } else if (
    early &&
    !a.behaviour.earlyWithdrawal.enabled &&
    a.info.taxTreatment !== "taxable" &&
    !isUkPension(a) &&
    !a.info.lockedUntilAccessAge
  )
    warnOnce(ctx, `early-unpenalised:${a.def.id}`, {
      code: "ASSUMPTION",
      severity: "info",
      message: `In ${ps.bounds.year}, ${a.def.name} is drawn at age ${age.toFixed(1)}, before its qualified age, with early-withdrawal penalties switched off, so no penalty is charged.`,
      periodIndex: ps.bounds.index,
      refs: [a.def.id],
    });
  addLedger(ctx, ps, {
    from: accountNode(ps, a),
    to: o.to ?? POOL,
    amount: w,
    kind: o.asTransfer ? "transfer" : "withdrawal",
    causeId: o.causeId ?? a.def.id,
    ...(o.rule ? { rule: o.rule } : {}),
  });
  traceEvent(
    ctx,
    ps,
    o.purpose === "drawdown" ? "drawdown" : "withdrawals",
    o.purpose === "drawdown"
      ? "WITHDRAWAL"
      : `WITHDRAWAL_${o.purpose.toUpperCase().replace("-", "_")}`,
    () =>
      o.purpose === "drawdown"
        ? `Withdrew ${fmt(w)} from ${a.def.name} (drawdown position ${o.position ?? 0}, ${a.category}) to cover a shortfall of ${fmt(o.need ?? w)}`
        : `Withdrew ${fmt(w)} from ${a.def.name} (${o.purpose})`,
    [a.def.id],
    { amount: w, taxable, taxFreeCash, position: o.position, need: o.need, early, penaltyRate },
  );
  if (a.balance <= 1e-9 && a.p.opening > 0)
    warnOnce(ctx, `depleted:${a.def.id}`, {
      code: "DEPLETED",
      severity: "info",
      message: `${a.def.name} is depleted in ${ps.bounds.year}: ${DEPLETION_CAUSE[o.purpose]}.`,
      periodIndex: ps.bounds.index,
      refs: [a.def.id],
    });
  return { gross: w, taxable, taxFreeCash, ...(basisOut > 0 ? { iraBasis: basisOut } : {}) };
}

/**
 * UK PCLS: on first access, crystallise 25% of the pot (capped by the lump-sum allowance) as a
 * tax-free lump sum. Returns the lump-sum amount withdrawn (to `to`, default the pool).
 */
export function crystallisePcls(
  ctx: EngineContext,
  ps: PeriodState,
  a: AccountState,
  to?: string,
): number {
  if (a.pclsTaken || a.behaviour.ukDrawdownMethod !== "pcls" || a.balance <= 0) return 0;
  // A tax-free lump sum can only be taken from the access age (an early withdrawal the plan allows
  // with a penalty is not a PCLS); the lump sum is taken at the first access after that.
  if (isEarly(ctx, a, ps.bounds.start)) return 0;
  a.pclsTaken = true;
  const share = a.behaviour.taxFreeWithdrawalShare ?? 0.25;
  const lump = Math.min(a.balance * share, lsaRemaining(ctx, a.owner, ps.bounds.year));
  if (lump <= 0) return 0;
  ctx.lsaUsed.set(a.owner, (ctx.lsaUsed.get(a.owner) ?? 0) + lump);
  const r = withdraw(ctx, ps, a, lump, {
    purpose: "required",
    penaltyFree: true,
    taxExempt: true,
    ...(to ? { to } : {}),
  });
  traceEvent(
    ctx,
    ps,
    "withdrawals",
    "PCLS_TAKEN",
    () => `Took a tax-free lump sum of ${fmt(r.gross)} from ${a.def.name} (PCLS)`,
    [a.def.id],
    { amount: r.gross },
  );
  return r.gross;
}
