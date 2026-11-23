/**
 * Flows: the ordered savings waterfall run on each period's surplus (inside the settle fixpoint).
 *
 *   - Order in Plan.flows = priority. "Fund with income" flows take at most what is left;
 *     "Always fund" (mandatory) flows take their full amount and may push the pool negative, which
 *     the drawdown then covers from accounts.
 *   - Contribution limits: per owner and limit group per period (jurisdiction, custom, or the
 *     built-in fallback table), prorated by active months.
 *   - Employer match: tier by tier from the first percent of pay up, each tier's matchRate x the
 *     employee contribution falling in its band (bandShareOfPay x pay), paid by the employer (not
 *     from the pool). The match is on the intended employee contribution, or with
 *     reduceIfUnderfunded on the amount actually funded (so a short year loses the upper tiers
 *     first). Roth-designated matches are taxable wages. A fixed employer contribution (an amount
 *     per frequency) is paid while the employee has pay from the income, whatever they contribute.
 *   - HSA: employer money shares the owner's annual limit (IRC 223(b)(4)(B)). A fixed employer
 *     contribution comes off the limit first; the employee then contributes at most what leaves
 *     room for the match their contribution earns, so employee + employer never exceed the limit.
 *   - Backdoor Roth: non-deductible IRA contribution converted the same day (tax-neutral; no
 *     pro-rata). Mega-backdoor Roth: after-tax space = 415(c) limit - deferrals - employer match.
 *   - fundFromAccountIds: the contribution is withdrawn from those accounts (ordered) instead of
 *     consuming surplus; any remainder comes from the surplus.
 *   - Cash targets with routeExcessOnward move balance above the target back into the waterfall.
 *   - Transfers move money between accounts (or out of the household) regardless of surplus;
 *     'auto' tax handling detects Roth conversions (tax-deferred -> tax-free, taxable as ordinary
 *     income, penalty-free), rollovers between like accounts (tax-free) and otherwise taxes the
 *     source like a withdrawal.
 */
import type { Flow } from "../schema/flows.js";
import {
  accountNode,
  crystallisePcls,
  deposit,
  isOpen,
  isWithdrawable,
  withdraw,
} from "./accounts.js";
import { activeMonths, nominalAtPeriod, resolveWindow } from "./amounts.js";
import {
  type AccountState,
  addLedger,
  addNode,
  type EngineContext,
  fmt,
  ownerAge,
  type PeriodState,
  POOL,
  traceEvent,
  warnOnce,
} from "./context.js";
import { parseMonth } from "./dates.js";
import { fxAt } from "./indices.js";
import { annualLimit, limitGroupOf, lisaCap, us415c } from "./limits.js";
import { nonResidentContributionCap } from "./crossborder.js";
import { rulesFor } from "./rules.js";
import { ownerCutoff } from "./survivor.js";

const PER_YEAR = {
  once: 1,
  weekly: 52,
  biweekly: 26,
  semimonthly: 24,
  monthly: 12,
  quarterly: 4,
  semiannually: 2,
  yearly: 1,
} as const;

function amountPerPeriod(
  ps: PeriodState,
  months: number,
  amount: { value: number; basis: "real" | "nominal" },
  frequency: keyof typeof PER_YEAR,
): number {
  if (frequency === "once") return nominalAtPeriod(ps, amount);
  return (nominalAtPeriod(ps, amount) * PER_YEAR[frequency] * months) / 12;
}

/** Run all flows on `available` surplus; returns what is left (may be negative). */
export function runFlows(ctx: EngineContext, ps: PeriodState, available: number): number {
  let remaining = available;
  for (const f of ctx.plan.flows) {
    if (!f.enabled) continue;
    const w = resolveWindow(ctx, f.range);
    if (f.kind === "contribution" && f.tapFund && w.start !== null && w.end <= ps.bounds.start)
      remaining += tapFund(ctx, ps, f);
    const cutoff = ownerCutoff(ctx, f.owner);
    const months = activeMonths({ start: w.start, end: Math.min(w.end, cutoff) }, ps);
    if (months <= 0) continue;
    if (f.kind === "contribution") remaining = contribute(ctx, ps, f, months, remaining);
    else if (f.kind === "debtPaydown") remaining = paydown(ctx, ps, f, months, remaining);
    else transfer(ctx, ps, f, months);
  }
  return remaining;
}

/**
 * Workplace plans whose contributions make their owner an active participant for the traditional
 * IRA deduction phase-out: 401(a) plans (401(k), solo 401(k), 401(a)), 403(b), plans of the United
 * States (TSP), SEPs and SIMPLE IRAs. An eligible 457(b) plan is not one (IRC 219(g)(5), last
 * sentence). A defined contribution plan covers the year in which amounts are contributed or
 * allocated to the account (Pub. 590-A, "Defined contribution plan"). 26 U.S.C. 219(g)(5),
 * https://www.govinfo.gov/content/pkg/USCODE-2024-title26/html/USCODE-2024-title26-subtitleA-chap1-subchapB-partVII-sec219.htm
 * and https://www.irs.gov/publications/p590a (both read 2026-11-23).
 */
const US_ACTIVE_PARTICIPANT_PLANS: ReadonlySet<string> = new Set([
  "401k",
  "roth-401k",
  "403b",
  "roth-403b",
  "tsp",
  "roth-tsp",
  "solo-401k",
  "401a",
  "sep-ira",
  "simple-ira",
]);

/** Key in `limitUsed` marking an owner as an active participant this period (IRC 219(g)). */
export const activeParticipantKey = (owner: string) => `${owner}|us-active-participant`;

function markCoverage(ps: PeriodState, a: AccountState, amount: number): void {
  if (amount > 0 && US_ACTIVE_PARTICIPANT_PLANS.has(a.def.type))
    useLimit(ps, activeParticipantKey(a.owner), amount);
}

function useLimit(ps: PeriodState, key: string, amount: number): void {
  ps.limitUsed.set(key, (ps.limitUsed.get(key) ?? 0) + amount);
}

function contribute(
  ctx: EngineContext,
  ps: PeriodState,
  f: Extract<Flow, { kind: "contribution" }>,
  months: number,
  remaining: number,
): number {
  const refs = [f.id, f.accountId];
  const a = ctx.accountById.get(f.accountId)!;
  if (!isOpen(ctx, a, ps)) return remaining;
  const frac = months / 12;

  // Cash target routing excess onward.
  if (f.strategy.kind === "target" && f.routeExcessOnward) {
    const target = nominalAtPeriod(ps, f.strategy.target);
    const excess = a.balance - target;
    if (excess > 1e-9) {
      const r = withdraw(ctx, ps, a, excess, { purpose: "flow-funding", causeId: f.id });
      remaining += r.gross;
      traceEvent(
        ctx,
        ps,
        "flows",
        "EXCESS_ROUTED",
        () => `${fmt(r.gross)} above the ${a.def.name} target routed onward`,
        refs,
        {
          amount: r.gross,
        },
      );
      return remaining;
    }
  }

  // Limits.
  let limit = Number.POSITIVE_INFINITY;
  let limitKey: string | null = null;
  if (f.limit.kind === "custom") limit = nominalAtPeriod(ps, f.limit.amount) * frac;
  else if (f.limit.kind === "jurisdiction" || f.route !== "standard") {
    const lg = annualLimit(ctx, ps, a);
    if (lg) {
      limitKey = `${a.owner}|${lg.group}`;
      limit = Math.max(0, lg.annual * frac - (ps.limitUsed.get(limitKey) ?? 0));
      if (a.def.type === "uk-lisa") {
        const lisaKey = `${a.owner}|uk-lisa`;
        limit = Math.min(
          limit,
          Math.max(0, lisaCap(ctx, ps, a) * frac - (ps.limitUsed.get(lisaKey) ?? 0)),
        );
      }
    }
  }
  // Sub-limits inside the allowance (UK: a cash ISA limit, when the plan sets one).
  const sub = subLimitCap(ctx, ps, a, months);
  if (sub) limit = Math.min(limit, Math.max(0, sub.cap - (ps.limitUsed.get(sub.key) ?? 0)));
  // Wrappers non-residents may not fund (ISA, TFSA...) or only up to a relief cap (UK pensions),
  // whatever the flow's own limit setting: a legal bar, not an allowance choice.
  if (ps.crossBorder) {
    const cap = nonResidentContributionCap(ctx, ps, a, Number.POSITIVE_INFINITY);
    if (Number.isFinite(cap)) {
      const used = ps.limitUsed.get(`${a.owner}|${limitGroupOf(a.def.type)}`) ?? 0;
      const capped = Math.max(0, cap * frac - used);
      if (capped < limit)
        traceEvent(
          ctx,
          ps,
          "flows",
          "NON_RESIDENT_WRAPPER",
          () =>
            `${a.def.name}: contributions capped at ${fmt(capped)} while its owner lives abroad`,
          [f.id, a.def.id],
          { cap: capped },
        );
      limit = Math.min(limit, capped);
    }
  }
  let pay = 0;
  if (f.employer || f.method.kind === "percentOfIncome") {
    const incomeId =
      f.employer?.incomeId ?? (f.method.kind === "percentOfIncome" ? f.method.incomeId : "");
    for (const l of ps.incomeLines) if (l.sourceId === incomeId) pay += l.amount;
  }
  if (f.route === "mega-backdoor-roth") {
    // After-tax space under the 415(c) total-additions limit.
    const space =
      us415c(ps.bounds.year, ps.piStart) * frac -
      (ps.limitUsed.get(`${a.owner}|us-401k`) ?? 0) -
      (ps.limitUsed.get(`${a.owner}|employer`) ?? 0) -
      (ps.limitUsed.get(`${a.owner}|after-tax`) ?? 0);
    limit = Math.max(0, space);
    limitKey = `${a.owner}|after-tax`;
  }
  const hsa = limitGroupOf(a.def.type) === "hsa";
  let employerFixed = 0;
  if (f.employer?.fixed && pay > 0) {
    employerFixed = amountPerPeriod(
      ps,
      months,
      f.employer.fixed.amount,
      f.employer.fixed.frequency,
    );
    if (hsa && Number.isFinite(limit)) {
      if (employerFixed > limit + 1e-9)
        traceEvent(
          ctx,
          ps,
          "flows",
          "CONTRIBUTION_LIMITED",
          () => `"${f.name}" employer contribution capped at the HSA limit (${fmt(limit)})`,
          refs,
          { desired: employerFixed, limit },
        );
      employerFixed = Math.min(employerFixed, Math.max(0, limit));
      limit = Math.max(0, limit - employerFixed);
    }
  }
  // Room for the employee's own HSA contribution once the match it earns is counted too.
  if (hsa && f.employer && pay > 0 && Number.isFinite(limit))
    limit = employeeRoomWithMatch(f.employer.tiers, pay, limit);

  let desired: number;
  switch (f.method.kind) {
    case "max":
      desired = Number.isFinite(limit) ? limit : Math.max(0, remaining);
      break;
    case "percentOfRemaining":
      desired = Math.max(0, remaining) * f.method.share;
      break;
    case "amount":
      desired = amountPerPeriod(ps, months, f.method.amount, f.method.frequency);
      break;
    case "percentOfIncome":
      desired = pay * f.method.share;
      break;
  }
  if (f.strategy.kind === "target")
    desired = Math.min(desired, Math.max(0, nominalAtPeriod(ps, f.strategy.target) - a.balance));
  const intended = Math.max(0, Math.min(desired, limit));
  if (desired > limit + 1e-9 && Number.isFinite(limit))
    traceEvent(
      ctx,
      ps,
      "flows",
      "CONTRIBUTION_LIMITED",
      () => `"${f.name}" capped at its contribution limit (${fmt(limit)})`,
      refs,
      {
        desired,
        limit,
      },
    );

  // Funding: specific accounts first, then the surplus (or anything, if mandatory).
  let funded = 0;
  for (const id of f.fundFromAccountIds) {
    if (funded >= intended - 1e-9) break;
    const src = ctx.accountById.get(id);
    if (!src || src === a || !isOpen(ctx, src, ps) || !isWithdrawable(ctx, src, ps)) continue;
    const r = withdraw(ctx, ps, src, intended - funded, {
      purpose: "flow-funding",
      to: accountNode(ps, a),
      causeId: f.id,
      asTransfer: true,
    });
    funded += r.gross;
  }
  const fromSurplus = Math.max(
    0,
    Math.min(intended - funded, f.mandatory ? Number.POSITIVE_INFINITY : Math.max(0, remaining)),
  );
  const amount = funded + fromSurplus;
  remaining -= fromSurplus;
  if (amount > 0) {
    deposit(a, amount);
    if (funded > 0) {
      a.p.contributions -= funded;
      a.p.transfersIn += funded;
    }
    if (limitKey) useLimit(ps, limitKey, amount);
    if (a.def.type === "uk-lisa") {
      useLimit(ps, `${a.owner}|uk-lisa`, amount);
      lisaBonus(ctx, ps, a, amount);
    }
    if (sub) useLimit(ps, sub.key, amount);
    if (!limitKey) useLimit(ps, `${a.owner}|${limitGroupOf(a.def.type)}`, amount);
    markCoverage(ps, a, amount);
    const deductible =
      f.route === "standard" &&
      (f.taxDeductible ??
        (a.info.taxTreatment === "tax-deferred" || a.info.taxTreatment === "hsa"));
    if (deductible)
      ps.taxDeductions.push({
        sourceId: f.id,
        kind: "pre-tax-contribution",
        amount,
        itemized: false,
        levels: ["federal", "state", "local"],
        owner: a.owner,
        accountId: a.def.id,
        accountType: a.def.type,
        ...(f.pensionScheme ? { pensionScheme: f.pensionScheme } : {}),
      });
    if (fromSurplus > 0)
      addLedger(ctx, ps, {
        from: POOL,
        to: accountNode(ps, a),
        amount: fromSurplus,
        kind: "contribution",
        causeId: f.id,
      });
    traceEvent(
      ctx,
      ps,
      "flows",
      f.route === "backdoor-roth"
        ? "BACKDOOR_ROTH"
        : f.route === "mega-backdoor-roth"
          ? "MEGA_BACKDOOR_ROTH"
          : "CONTRIBUTION",
      () => `Contributed ${fmt(amount)} to ${a.def.name} via "${f.name}"`,
      refs,
      {
        amount,
        mandatory: f.mandatory,
        fromAccounts: funded,
        limit: Number.isFinite(limit) ? limit : null,
      },
    );
  }
  if (f.employer && pay > 0) {
    if (employerFixed > 0) employerDeposit(ctx, ps, f, a, employerFixed, "fixed");
    const match = tieredMatch(
      f.employer.tiers,
      f.employer.reduceIfUnderfunded ? amount : intended,
      pay,
    );
    if (match > 0) {
      employerDeposit(ctx, ps, f, a, match, "match");
      traceEvent(
        ctx,
        ps,
        "flows",
        "EMPLOYER_MATCH",
        () => `Employer matched ${fmt(match)} into ${a.def.name}`,
        [f.id, a.def.id],
        { match, employee: amount, intended },
      );
    }
  }
  return remaining;
}

/**
 * Contribution sub-limit for `a` this period (prorated to the months it applies), from the account
 * country's rules (UK: the cash ISA limit inside the ISA allowance), or null when none applies.
 */
function subLimitCap(
  ctx: EngineContext,
  ps: PeriodState,
  a: AccountState,
  months: number,
): { key: string; cap: number } | null {
  for (const j of rulesFor(ctx, a, ps)) {
    if (!j.contributionSubLimit) continue;
    const sub = j.contributionSubLimit({
      accountType: a.def.type,
      ...(a.def.ukIsaType ? { subtype: a.def.ukIsaType } : {}),
      year: ps.bounds.year,
      ownerAge: ownerAge(ctx, a.owner, ps.bounds.start),
      config: ps.tax,
    });
    if (!sub) continue;
    const from = parseMonth(sub.from);
    const applies = Math.min(months, Math.max(0, ps.bounds.end - Math.max(from, ps.bounds.start)));
    if (applies <= 0) return null;
    return { key: `${a.owner}|${sub.key}`, cap: (sub.annual * applies) / 12 };
  }
  return null;
}

function lisaBonus(ctx: EngineContext, ps: PeriodState, a: AccountState, amount: number): void {
  const bonus = amount * 0.25;
  if (bonus <= 0) return;
  a.balance += bonus;
  a.p.contributions += bonus;
  const node = addNode(ps, {
    id: "external:lisa-bonus",
    kind: "external",
    label: "LISA government bonus",
  });
  ps.incomeLines.push({
    sourceId: `lisa-bonus:${a.def.id}`,
    sourceKind: "income",
    label: "LISA government bonus",
    owner: a.owner,
    amount: bonus,
    taxCharacter: "tax-free",
  });
  addLedger(ctx, ps, {
    from: node,
    to: accountNode(ps, a),
    amount: bonus,
    kind: "income",
    causeId: a.def.id,
  });
}

/**
 * Employer match on `employee` contributions out of `pay`: each tier matches the part of the
 * contribution that falls in its band of pay, starting from the first tier.
 */
function tieredMatch(
  tiers: readonly { matchRate: number; bandShareOfPay: number }[],
  employee: number,
  pay: number,
): number {
  let left = Math.max(0, employee);
  let match = 0;
  for (const t of tiers) {
    if (left <= 0) break;
    const inBand = Math.min(left, t.bandShareOfPay * pay);
    match += t.matchRate * inBand;
    left -= inBand;
  }
  return match;
}

/**
 * The largest employee contribution that, with the match it earns, fits in `room`: walks the tiers
 * from the first, each unit of contribution in a tier costing 1 + its match rate.
 */
function employeeRoomWithMatch(
  tiers: readonly { matchRate: number; bandShareOfPay: number }[],
  pay: number,
  room: number,
): number {
  let left = Math.max(0, room);
  let employee = 0;
  for (const t of tiers) {
    const band = t.bandShareOfPay * pay;
    const cost = band * (1 + t.matchRate);
    if (left <= cost) return employee + left / (1 + t.matchRate);
    employee += band;
    left -= cost;
  }
  return employee + left;
}

/**
 * Employer money paid into `a` (a match, or a fixed contribution): not from the household's
 * cash, never an employee deduction, and counted in the owner's employer total (415(c)) and, for
 * an HSA, in the owner's HSA limit.
 */
function employerDeposit(
  ctx: EngineContext,
  ps: PeriodState,
  f: Extract<Flow, { kind: "contribution" }>,
  a: AccountState,
  amount: number,
  kind: "match" | "fixed",
): void {
  const e = f.employer!;
  a.balance += amount;
  a.p.contributions += amount;
  if (a.costBasis !== null) a.costBasis += amount;
  ps.limitUsed.set(`${a.owner}|employer`, (ps.limitUsed.get(`${a.owner}|employer`) ?? 0) + amount);
  if (limitGroupOf(a.def.type) === "hsa") useLimit(ps, `${a.owner}|hsa`, amount);
  markCoverage(ps, a, amount);
  const sourceId = kind === "match" ? `employer:${f.id}` : `employer:${f.id}:fixed`;
  const label = `${f.name} employer ${kind === "match" ? "match" : "contribution"}`;
  // Employer contributions count toward pension allowances (UK annual allowance) but never toward
  // the employee's income or deductions.
  if (a.info.taxTreatment === "tax-deferred")
    ps.taxDeductions.push({
      sourceId,
      kind: "pre-tax-contribution",
      amount,
      itemized: false,
      levels: ["federal", "state", "local"],
      owner: a.owner,
      accountId: a.def.id,
      accountType: a.def.type,
      employer: true,
    });
  ps.incomeLines.push({
    sourceId,
    sourceKind: "income",
    label,
    owner: a.owner,
    amount,
    taxCharacter: e.designation === "roth" ? "wage" : "tax-free",
  });
  if (e.designation === "roth") {
    ps.taxIncome.push({
      sourceId,
      owner: a.owner,
      character: "wage",
      amount,
      exemptIn: [],
      incomeType: "employer-match",
    });
    if (a.contributionBasis !== null) a.contributionBasis += amount;
  }
  const node = addNode(ps, {
    id: `income:${sourceId}`,
    kind: "income",
    label,
    refId: f.id,
  });
  addLedger(ctx, ps, {
    from: node,
    to: accountNode(ps, a),
    amount,
    kind: "contribution",
    causeId: f.id,
  });
  if (kind === "fixed")
    traceEvent(
      ctx,
      ps,
      "flows",
      "EMPLOYER_CONTRIBUTION",
      () => `Employer paid ${fmt(amount)} into ${a.def.name}`,
      [f.id, a.def.id],
      { amount },
    );
}

/** A debt or financed asset loan a paydown flow can pay. */
interface PaydownTarget {
  id: string;
  name: string;
  apr: number;
  balance: () => number;
  pay: (amount: number) => void;
  /** Scheduled monthly payment (nominal, base currency) once it is paid off (snowball rollover). */
  freedMonthly: () => number;
  paidOff: boolean;
}

function paydownTargets(
  ctx: EngineContext,
  ps: PeriodState,
  ids: readonly string[] | null,
): PaydownTarget[] {
  const out: PaydownTarget[] = [];
  const want = ids ? new Set(ids) : null;
  for (const d of ctx.debts) {
    if (want && !want.has(d.def.id)) continue;
    out.push({
      id: d.def.id,
      name: d.def.name,
      apr: d.def.interest.apr,
      balance: () => d.balance,
      pay: (x) => {
        d.balance -= x;
        d.p.payments += x;
        d.p.extraPayments = (d.p.extraPayments ?? 0) + x;
      },
      freedMonthly: () =>
        nominalAtPeriod(ps, d.behaviour.monthlyPaymentOverride ?? d.def.monthlyPayment) *
        fxAt(ctx, d.currency, ps.bounds.start),
      paidOff: d.p.opening <= 1e-9 && d.def.balance > 0,
    });
  }
  for (const r of ctx.assets) {
    if (want && !want.has(r.def.id)) continue;
    if (!r.loan && !r.def.loan) continue;
    const wasFinanced = (r.def.loan?.balance ?? 0) > 0 || !!r.planned?.purchase.financing;
    out.push({
      id: r.def.id,
      name: `${r.def.name} loan`,
      apr: r.loan?.interest.apr ?? r.def.loan?.interest.apr ?? 0,
      balance: () => (r.owned ? r.loanBalance : 0),
      pay: (x) => {
        r.loanBalance -= x;
        r.p.loanPayments += x;
      },
      freedMonthly: () =>
        r.loan || r.def.loan
          ? nominalAtPeriod(ps, (r.loan ?? r.def.loan)!.monthlyPayment) *
            fxAt(ctx, r.currency, ps.bounds.start)
          : 0,
      paidOff: r.owned && wasFinanced && r.loanBalance <= 1e-9,
    });
  }
  return out;
}

/** Order targets by strategy: avalanche = highest rate first, snowball = smallest balance first. */
export function orderPaydownTargets<T extends { apr: number; balance: number }>(
  targets: T[],
  strategy: "avalanche" | "snowball",
): T[] {
  return [...targets].sort((a, b) =>
    strategy === "avalanche"
      ? b.apr - a.apr || a.balance - b.balance
      : a.balance - b.balance || b.apr - a.apr,
  );
}

function paydown(
  ctx: EngineContext,
  ps: PeriodState,
  f: Extract<Flow, { kind: "debtPaydown" }>,
  months: number,
  remaining: number,
): number {
  const alloc = f.allocation;
  const ids = alloc
    ? alloc.targetIds
      ? [...new Set([f.targetId, ...alloc.targetIds])]
      : null
    : [f.targetId];
  const all = paydownTargets(ctx, ps, ids);
  const open = all.filter((t) => t.balance() > 1e-9);
  const total = open.reduce((s, t) => s + t.balance(), 0);
  if (total <= 0) return remaining;
  let desired: number;
  switch (f.method.kind) {
    case "max":
      desired = total;
      break;
    case "percentOfRemaining":
      desired = Math.max(0, remaining) * f.method.share;
      break;
    case "amount":
      desired = amountPerPeriod(ps, months, f.method.amount, f.method.frequency);
      break;
    case "percentOfBalance":
      desired = total * f.method.share;
      break;
  }
  // Snowball rollover: the scheduled payments of debts already paid off join the budget.
  let freed = 0;
  if (alloc?.rollover) for (const t of all) if (t.paidOff) freed += t.freedMonthly() * months;
  desired += freed;
  const room = f.mandatory ? Number.POSITIVE_INFINITY : Math.max(0, remaining);
  let left = Math.max(0, Math.min(desired, total, room));
  if (left <= 0) return remaining;
  const ordered = alloc
    ? orderPaydownTargets(
        open.map((t) => ({ t, apr: t.apr, balance: t.balance() })),
        alloc.strategy,
      ).map((x) => x.t)
    : open;
  let paid = 0;
  for (const t of ordered) {
    if (left <= 1e-9) break;
    const amount = Math.min(left, t.balance());
    if (amount <= 0) continue;
    t.pay(amount);
    left -= amount;
    paid += amount;
    const node = addNode(ps, { id: `debt:${t.id}`, kind: "debt", label: t.name, refId: t.id });
    addLedger(ctx, ps, { from: POOL, to: node, amount, kind: "debt-payment", causeId: f.id });
    traceEvent(
      ctx,
      ps,
      "flows",
      "EXTRA_DEBT_PAYMENT",
      () =>
        `Extra payment ${fmt(amount)} to ${t.name} via "${f.name}"${alloc ? ` (${alloc.strategy})` : ""}`,
      [f.id, t.id],
      { amount, ...(alloc ? { strategy: alloc.strategy, rollover: freed } : {}) },
    );
  }
  return remaining - paid;
}

function transfer(
  ctx: EngineContext,
  ps: PeriodState,
  f: Extract<Flow, { kind: "transfer" }>,
  months: number,
): void {
  const src = ctx.accountById.get(f.fromAccountId)!;
  if (!isOpen(ctx, src, ps) || src.balance <= 0) return;
  const dst = f.to.kind === "account" ? ctx.accountById.get(f.to.accountId) : undefined;
  if (dst && !isOpen(ctx, dst, ps)) return;
  let amount: number;
  switch (f.amount.kind) {
    case "amount":
      amount = amountPerPeriod(ps, months, f.amount.amount, f.amount.frequency);
      break;
    case "percentOfBalance":
      amount = src.balance * f.amount.share;
      break;
    case "all":
      amount = src.balance;
      break;
  }
  amount = Math.min(amount, src.balance);
  if (!(amount > 0)) return;
  if (!isWithdrawable(ctx, src, ps) && !(dst && dst.info.taxTreatment === src.info.taxTreatment)) {
    warnOnce(ctx, `transfer-locked:${f.id}`, {
      code: "ASSUMPTION",
      severity: "warning",
      message: `From ${ps.bounds.year}, transfer "${f.name}" is skipped while ${src.def.name} cannot be withdrawn from (its withdrawal rule or access age).`,
      periodIndex: ps.bounds.index,
      refs: [f.id, src.def.id],
    });
    return;
  }
  const conversion =
    !!dst && src.info.taxTreatment === "tax-deferred" && dst.info.taxTreatment === "tax-free";
  const rollover =
    !!dst &&
    !conversion &&
    src.info.taxTreatment === dst.info.taxTreatment &&
    src.info.taxTreatment !== "taxable";
  // Moving holdings between ordinary taxable accounts carries the basis; a wrapper (PEA,
  // assurance-vie) on either side is a withdrawal and a fresh deposit.
  const sameTaxable =
    !!dst &&
    src.info.taxTreatment === "taxable" &&
    dst.info.taxTreatment === "taxable" &&
    !src.info.sheltersIncome &&
    !dst.info.sheltersIncome;
  const handling = f.taxHandling;
  const to = dst
    ? accountNode(ps, dst)
    : addNode(ps, {
        id: `external:${f.id}`,
        kind: "external",
        label: f.to.kind === "external" ? f.to.label || f.name : f.name,
        refId: f.id,
      });
  if (src.behaviour.ukDrawdownMethod === "pcls" && !rollover && handling !== "tax-exempt")
    crystallisePcls(ctx, ps, src, to);
  const basisBefore = src.costBasis ?? 0;
  const r = withdraw(ctx, ps, src, Math.min(amount, src.balance), {
    purpose: "transfer",
    to,
    causeId: f.id,
    asTransfer: true,
    penaltyFree: conversion,
    taxExempt: handling === "tax-exempt" || (handling === "auto" && (rollover || sameTaxable)),
    forceTaxable: handling === "taxable" || (handling === "auto" && conversion),
    isConversion: conversion,
  });
  if (dst) {
    dst.balance += r.gross;
    dst.p.transfersIn += r.gross;
    // A taxable-to-taxable transfer carries its basis; otherwise the destination's basis is the
    // amount moved (gains, if any, were realised on the way).
    const movedBasis =
      sameTaxable && src.costBasis !== null ? basisBefore - src.costBasis : r.gross;
    if (dst.costBasis !== null) dst.costBasis += movedBasis;
    if (dst.contributionBasis !== null) dst.contributionBasis += r.gross;
    // A rollover between traditional IRAs keeps the nondeductible basis.
    if (rollover && r.iraBasis && dst.def.type === "traditional-ira") dst.iraBasis += r.iraBasis;
  }
  traceEvent(
    ctx,
    ps,
    "flows",
    conversion ? "ROTH_CONVERSION" : "TRANSFER",
    () =>
      `${conversion ? "Converted" : "Transferred"} ${fmt(r.gross)} from ${src.def.name} to ${dst ? dst.def.name : f.to.kind === "external" ? f.to.label : "outside the household"}`,
    [f.id, src.def.id, ...(dst ? [dst.def.id] : [])],
    { amount: r.gross, taxable: r.taxable, conversion, rollover },
  );
}

/**
 * Tap a sinking fund: after the contribution flow's range ends, its account pays `rate` x its
 * opening balance into the cash pool each period (prorated for partial periods).
 */
function tapFund(
  ctx: EngineContext,
  ps: PeriodState,
  f: Extract<Flow, { kind: "contribution" }>,
): number {
  const a = ctx.accountById.get(f.accountId);
  if (!a || !f.tapFund || !isOpen(ctx, a, ps) || !isWithdrawable(ctx, a, ps)) return 0;
  const want = Math.max(0, a.p.opening) * f.tapFund.rate * (ps.bounds.months / 12);
  if (!(want > 0)) return 0;
  const r = withdraw(ctx, ps, a, want, { purpose: "flow-funding", causeId: f.id });
  traceEvent(
    ctx,
    ps,
    "flows",
    "FUND_TAPPED",
    () => `Tapped ${fmt(r.gross)} from ${a.def.name} ("${f.name}")`,
    [f.id, a.def.id],
    { amount: r.gross, rate: f.tapFund.rate },
  );
  return r.gross;
}

/** Account that receives saved leftover cash (and stray cash such as PCLS lump sums). */
export function leftoverTarget(ctx: EngineContext, ps: PeriodState): AccountState | undefined {
  const policy = ctx.plan.leftover;
  const explicit =
    policy.kind === "save" && policy.accountId ? ctx.accountById.get(policy.accountId) : undefined;
  return (
    (explicit && isOpen(ctx, explicit, ps) ? explicit : undefined) ??
    ctx.accounts.find((a) => a.category === "cash" && isOpen(ctx, a, ps)) ??
    ctx.accounts.find((a) => isOpen(ctx, a, ps))
  );
}

export function leftover(ctx: EngineContext, ps: PeriodState, amount: number): void {
  if (amount <= 1e-12) return;
  if (ctx.plan.leftover.kind === "save") {
    const target = leftoverTarget(ctx, ps);
    if (target) {
      deposit(target, amount);
      addLedger(ctx, ps, { from: POOL, to: accountNode(ps, target), amount, kind: "leftover" });
      traceEvent(
        ctx,
        ps,
        "flows",
        "LEFTOVER_SAVED",
        () => `Saved leftover ${fmt(amount)} to ${target.def.name}`,
        [target.def.id],
        { amount },
        "full",
      );
      return;
    }
    warnOnce(ctx, "no-leftover-account", {
      code: "ASSUMPTION",
      severity: "info",
      message: `From ${ps.bounds.year}, there is no open account to save leftover cash into, so the surplus is counted as spending.`,
      periodIndex: ps.bounds.index,
      refs: [],
    });
  }
  ps.expenseLines.push({
    sourceId: "leftover",
    sourceKind: "leftover-spending",
    label: "Discretionary spending (leftover)",
    category: "leftover",
    owner: "joint",
    requested: amount,
    funded: amount,
    spendingType: "discretionary",
  });
}
