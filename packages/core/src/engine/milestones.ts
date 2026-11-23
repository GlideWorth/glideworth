/**
 * DateRef resolution and milestone resolution.
 *
 * Two stages:
 *   1. resolveTimeMilestones (before the loop): milestones whose criteria are purely time-based
 *      (age, date, other time-based milestones) get an exact month.
 *   2. evaluateDynamicMilestones (end of every period): milestones with metric criteria (or that
 *      depend on such milestones) are tested on the period's END state; when satisfied they are
 *      reached in the period's last month, so events bound to them start next period.
 */
import { ScenarioError } from "../errors.js";
import type { Milestone, MilestoneCriterion } from "../schema/milestones.js";
import type { DateRef } from "../schema/time.js";
import { periodAmount } from "./amounts.js";
import {
  type EngineContext,
  type MilestoneState,
  type PeriodState,
  traceEvent,
} from "./context.js";
import { formatMonth, type MonthIndex, monthAtAge, parseMonth } from "./dates.js";
import type { PeriodTotals } from "./types.js";

export type Resolved = MonthIndex | null | "pending";

export function personBirth(ctx: Pick<EngineContext, "people">, personId: string): MonthIndex {
  const p = ctx.people.find((x) => x.id === personId);
  if (!p) throw new ScenarioError(`unknown person '${personId}'`, { personId });
  return p.birth;
}

export function dependentBirth(
  ctx: Pick<EngineContext, "household">,
  dependentId: string,
): MonthIndex {
  const d = ctx.household.dependents.find((x) => x.id === dependentId);
  if (!d) throw new ScenarioError(`unknown dependent '${dependentId}'`, { dependentId });
  return parseMonth(d.birthMonth);
}

/** Resolve a DateRef to a month index, null (never) or 'pending' (milestone not yet resolved). */
export function resolveRef(ctx: EngineContext, ref: DateRef): Resolved {
  switch (ref.kind) {
    case "never":
      return null;
    case "planStart":
      return ctx.start + ref.offsetMonths;
    case "planEnd":
      return ctx.endExclusive + ref.offsetMonths;
    case "date":
      return parseMonth(ref.date) + ref.offsetMonths;
    case "age":
      return monthAtAge(personBirth(ctx, ref.personId), ref.age) + ref.offsetMonths;
    case "dependentAge":
      return monthAtAge(dependentBirth(ctx, ref.dependentId), ref.age) + ref.offsetMonths;
    case "milestone": {
      const m = ctx.milestones.get(ref.milestoneId);
      if (!m)
        throw new ScenarioError(`unknown milestone '${ref.milestoneId}'`, {
          milestoneId: ref.milestoneId,
        });
      if (!m.def.enabled) return null;
      if (m.month === undefined) return "pending";
      return m.month === null ? null : m.month + ref.offsetMonths;
    }
  }
}

function criterionMonth(ctx: EngineContext, c: MilestoneCriterion): Resolved {
  switch (c.kind) {
    case "age":
      return monthAtAge(personBirth(ctx, c.personId), c.age);
    case "date":
      return parseMonth(c.date);
    case "milestone":
      return resolveRef(ctx, {
        kind: "milestone",
        milestoneId: c.milestoneId,
        offsetMonths: c.offsetMonths,
      });
    case "metric":
      return "pending";
  }
}

function isTimeOnly(def: Milestone, all: Map<string, MilestoneState>, seen: Set<string>): boolean {
  if (seen.has(def.id))
    throw new ScenarioError(`circular milestone reference involving '${def.id}'`, { id: def.id });
  seen.add(def.id);
  const ok = def.criteria.every((c) => {
    if (c.kind === "metric") return false;
    if (c.kind !== "milestone") return true;
    const dep = all.get(c.milestoneId);
    if (!dep)
      throw new ScenarioError(`unknown milestone '${c.milestoneId}'`, {
        milestoneId: c.milestoneId,
      });
    return isTimeOnly(dep.def, all, seen);
  });
  seen.delete(def.id);
  return ok;
}

/** Combine criteria truth values at month `m`. Metric results are passed in (null = no metrics). */
function holdsAt(
  ctx: EngineContext,
  def: Milestone,
  m: MonthIndex,
  metric: (c: MilestoneCriterion) => boolean,
): boolean {
  const vals = def.criteria.map((c) => {
    if (c.kind === "metric") return metric(c);
    const x = criterionMonth(ctx, c);
    if (x === "pending") return false;
    if (c.when === "before") return x === null || m < x;
    return x !== null && m >= x;
  });
  return def.combinator === "all" ? vals.every(Boolean) : vals.some(Boolean);
}

/** Earliest month >= start where a time-only milestone holds, or null. */
function earliestTimeMonth(ctx: EngineContext, def: Milestone): MonthIndex | null {
  const candidates = new Set<number>([ctx.start]);
  for (const c of def.criteria) {
    const x = criterionMonth(ctx, c);
    if (typeof x === "number" && x > ctx.start) candidates.add(x);
  }
  const sorted = [...candidates].sort((a, b) => a - b);
  for (const m of sorted) if (holdsAt(ctx, def, m, () => false)) return m;
  return null;
}

export function initMilestones(ctx: EngineContext, milestones: Milestone[]): void {
  for (const def of milestones)
    ctx.milestones.set(def.id, { def, month: undefined, via: null, dynamic: false });
  for (const st of ctx.milestones.values()) {
    if (!st.def.enabled) {
      st.month = null;
      continue;
    }
    st.dynamic = !isTimeOnly(st.def, ctx.milestones, new Set());
  }
  // Resolve time-only milestones in dependency order (fixpoint; cycles were rejected above).
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const st of ctx.milestones.values()) {
      if (st.month !== undefined || st.dynamic) continue;
      const depsReady = st.def.criteria.every(
        (c) => c.kind !== "milestone" || ctx.milestones.get(c.milestoneId)?.month !== undefined,
      );
      if (!depsReady) continue;
      st.month = earliestTimeMonth(ctx, st.def);
      st.via = st.month === null ? null : "time";
      progressed = true;
    }
  }
}

function metricValue(
  ctx: EngineContext,
  c: Extract<MilestoneCriterion, { kind: "metric" }>,
  t: PeriodTotals,
): number {
  const m = c.metric;
  switch (m.kind) {
    case "netWorth":
      return t.netWorth;
    case "liquidNetWorth":
      return t.liquidNetWorth;
    case "portfolio":
      return t.portfolio;
    case "cash":
      return t.cash;
    case "accountBalance":
      return ctx.accounts.find((a) => a.def.id === m.accountId)?.balance ?? 0;
    case "totalDebt":
      return t.liabilities;
    case "debtBalance":
      return ctx.debts.find((d) => d.def.id === m.debtId)?.balance ?? 0;
    case "loanBalance":
      return ctx.assets.find((a) => a.def.id === m.assetId)?.loanBalance ?? 0;
    case "passiveIncome":
      return t.passiveIncome;
    case "income":
      return t.income;
    case "spending":
      return t.spending;
    case "expenses":
      return t.expenses;
  }
}

function threshold(
  ctx: EngineContext,
  c: Extract<MilestoneCriterion, { kind: "metric" }>,
  t: PeriodTotals,
  ps: PeriodState,
): number {
  const th = c.threshold;
  if (th.kind === "amount")
    return th.amount.basis === "real" ? th.amount.value * ps.piEnd : th.amount.value;
  if (th.measurement === "average")
    return th.multiple * averageProjected(ctx, ps, th.of, th.averageYears);
  const base =
    th.of === "spending"
      ? t.spending
      : th.of === "expenses"
        ? t.expenses
        : ps.expenseLines
            .filter((e) => e.spendingType === "essential")
            .reduce((s, e) => s + e.requested, 0);
  // Partial periods: annualise the base so "25x annual spending" means annual.
  return th.multiple * base * (12 / ps.bounds.months);
}

/**
 * 'average' measurement: mean annual spending over the REMAINING plan (this period to the end, or
 * the next `averageYears` years when set),
 * projected from the plan's expense events in today's money and expressed in this period's money,
 * plus non-event outflows (real-asset running costs, loan and debt payments; see
 * `nonEventOutflowsReal`). Projection uses requested amounts (no shortfall or flex cuts) and
 * treats events bound to not-yet-reached milestones as not started / still running.
 */
const averageCache = new WeakMap<EngineContext, Map<string, number>>();

function averageProjected(
  ctx: EngineContext,
  ps: PeriodState,
  of: "spending" | "expenses" | "essentialSpending",
  averageYears?: number,
): number {
  let cache = averageCache.get(ctx);
  if (!cache) {
    cache = new Map();
    averageCache.set(ctx, cache);
  }
  const key = `${ps.bounds.index}|${of}|${averageYears ?? ""}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  let sumReal = 0;
  let years = 0;
  // With `averageYears`, only the window of that many years from this period counts.
  const stopMonth = averageYears ? ps.bounds.start + averageYears * 12 : Number.POSITIVE_INFINITY;
  for (let j = ps.bounds.index; j < ctx.periods.length; j++) {
    const b = ctx.periods[j]!;
    if (b.start >= stopMonth) break;
    const fake = { bounds: b, piStart: ctx.piStart[j]! } as PeriodState;
    let total = 0;
    for (const e of ctx.expenseEvents) {
      if (!e.enabled || e.type === "tax-deduction") continue;
      if (of === "spending" && e.spendingType === "not-spending") continue;
      if (of === "essentialSpending" && e.spendingType !== "essential") continue;
      total += periodAmount(ctx, fake, {
        amount: e.amount,
        frequency: e.frequency,
        range: e.range,
        change: e.change,
        growFromToday: e.growFromToday,
        refs: [e.id],
        changeLimit: e.changeLimit,
        recurrence: e.recurrence,
      });
    }
    sumReal += total / ctx.piStart[j]!;
    years += b.months / 12;
  }
  sumReal += nonEventOutflowsReal(ctx, ps, of, stopMonth);
  const v = years > 0 ? (sumReal / years) * ps.piStart : 0;
  cache.set(key, v);
  return v;
}

/**
 * Outflows with no expense event behind them (real-asset running costs, mortgage and debt
 * payments) count in the `expenses` / `spending` metrics, so the projected average must count them
 * too, otherwise "33x average expenses" quietly means "33x average expenses excluding housing".
 * They cannot be projected from events, so this period's realised level is carried forward in
 * today's money over the averaging window; loan and debt payments stop once the balance
 * outstanding at period end would be repaid. One-offs (purchases, leftover spending) are excluded.
 * Returns the window total in today's money (same units as `sumReal`).
 */
function nonEventOutflowsReal(
  ctx: EngineContext,
  ps: PeriodState,
  of: "spending" | "expenses" | "essentialSpending",
  stopMonth: number,
): number {
  const def = ctx.options.spendingDefinition ?? {
    includeMortgage: true,
    includeMortgagePrincipal: false,
    includeConsumerDebtPrincipal: false,
  };
  let recurring = 0;
  let loans = 0;
  let loansCounted = 0;
  for (const e of ps.expenseLines) {
    const kind = e.sourceKind;
    if (kind === "expense" || kind === "asset-purchase" || kind === "leftover-spending") continue;
    if (of !== "expenses" && e.spendingType === "not-spending") continue;
    if (of === "essentialSpending" && e.spendingType !== "essential") continue;
    if (kind === "loan-payment" || kind === "debt-payment") {
      let share = 1;
      if (of !== "expenses") {
        const id = e.sourceId.split(":")[1];
        if (kind === "loan-payment") {
          const r = ctx.assets.find((x) => x.def.id === id);
          const interest =
            r && r.p.loanPayments > 0 ? Math.min(1, r.p.loanInterest / r.p.loanPayments) : 1;
          share = !def.includeMortgage ? 0 : def.includeMortgagePrincipal ? 1 : interest;
        } else {
          const d = ctx.debts.find((x) => x.def.id === id);
          const interest = d && d.p.payments > 0 ? Math.min(1, d.p.interest / d.p.payments) : 1;
          share = def.includeConsumerDebtPrincipal ? 1 : interest;
        }
      }
      loans += e.requested;
      loansCounted += e.requested * share;
    } else recurring += e.requested;
  }
  if (recurring === 0 && loansCounted === 0) return 0;
  const annualise = 12 / ps.bounds.months;
  const recurringReal = (recurring * annualise) / ps.piStart;
  const loansReal = (loans * annualise) / ps.piStart;
  const loansCountedReal = (loansCounted * annualise) / ps.piStart;
  let outstanding = 0;
  for (const r of ctx.assets) if (r.owned) outstanding += r.loanBalance;
  for (const d of ctx.debts) outstanding += d.balance;
  // Years of payments left at this period's level (in today's money; ignores interest, so an
  // upper bound on the payoff speed, which keeps the estimate conservative on the low side).
  let loanYearsLeft = loansReal > 0 ? outstanding / ps.piEnd / loansReal : 0;
  // This period: realised values.
  let total = (recurring + loansCounted) / ps.piStart;
  for (let j = ps.bounds.index + 1; j < ctx.periods.length; j++) {
    const b = ctx.periods[j]!;
    if (b.start >= stopMonth) break;
    const yrs = b.months / 12;
    total += recurringReal * yrs;
    const loanYrs = Math.min(yrs, Math.max(0, loanYearsLeft));
    total += loansCountedReal * loanYrs;
    loanYearsLeft -= yrs;
  }
  return total;
}

function compare(a: number, op: string, b: number): boolean {
  switch (op) {
    case ">=":
      return a >= b;
    case ">":
      return a > b;
    case "<=":
      return a <= b;
    case "<":
      return a < b;
    default:
      return Math.abs(a - b) < 0.005;
  }
}

/** Mark time-resolved milestones whose month falls in this period as reached (for reporting). */
export function collectTimeMilestones(ctx: EngineContext, ps: PeriodState): void {
  for (const st of ctx.milestones.values()) {
    if (st.dynamic || typeof st.month !== "number") continue;
    const inPeriod =
      (st.month >= ps.bounds.start && st.month < ps.bounds.end) ||
      (ps.bounds.index === 0 && st.month < ps.bounds.start);
    if (inPeriod) ps.milestonesReached.push(st.def.id);
  }
}

export function evaluateDynamicMilestones(
  ctx: EngineContext,
  ps: PeriodState,
  totals: PeriodTotals,
): void {
  const at = ps.bounds.end - 1;
  let changed = true;
  // Loop so that a dynamic milestone depending on another reached this period resolves too.
  while (changed) {
    changed = false;
    for (const st of ctx.milestones.values()) {
      if (!st.dynamic || st.month !== undefined) continue;
      // OR milestones: a time branch that holds inside this period fires at its exact month.
      if (st.def.combinator === "any") {
        const months = [ps.bounds.start];
        for (const c of st.def.criteria) {
          if (c.kind === "metric") continue;
          const x = criterionMonth(ctx, c);
          if (typeof x === "number" && x > ps.bounds.start && x < ps.bounds.end) months.push(x);
        }
        months.sort((a, b) => a - b);
        const hit = months.find((m) => holdsAt(ctx, st.def, m, () => false));
        if (hit !== undefined) {
          st.month = Math.max(hit, ctx.start);
          st.via = "time";
          ps.milestonesReached.push(st.def.id);
          traceEvent(
            ctx,
            ps,
            "milestones",
            "MILESTONE_REACHED",
            `${st.def.name} reached in ${formatMonth(st.month)}`,
            [st.def.id],
          );
          changed = true;
          continue;
        }
      }
      const ok = holdsAt(ctx, st.def, at, (c) =>
        c.kind === "metric"
          ? compare(metricValue(ctx, c, totals), c.comparator, threshold(ctx, c, totals, ps))
          : false,
      );
      if (ok) {
        st.month = at;
        st.via = st.def.criteria.some((c) => c.kind !== "metric") ? "mixed" : "metric";
        ps.milestonesReached.push(st.def.id);
        traceEvent(
          ctx,
          ps,
          "milestones",
          "MILESTONE_REACHED",
          `${st.def.name} reached in ${formatMonth(at)}`,
          [st.def.id],
        );
        changed = true;
      }
    }
  }
}

export function finalizeMilestones(ctx: EngineContext): void {
  for (const st of ctx.milestones.values()) if (st.month === undefined) st.month = null;
}
