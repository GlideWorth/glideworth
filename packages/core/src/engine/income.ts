/**
 * Income phase: every income event type -> income lines, tax items and routing (cash pool or
 * accounts). Covers part-time, recurrence, defined-benefit pensions, RSU vesting, US Social
 * Security estimate mode (claim age, earnings test, spousal, survivor), UK State Pension with an
 * optional triple lock, government-benefit COLA modifier and survivor continuation.
 */
import type { IncomeEvent } from "../schema/events.js";
import { FREQUENCY_PER_YEAR } from "../schema/primitives.js";
import type { Change } from "../schema/time.js";
import { ukStatePensionUprated } from "../tax/crossborder/uk.js";
import { aeGratuity } from "../tax/data/ae.js";
import { ukStatePensionAge } from "../tax/data/uk.js";
import { defaultCharacterForIncomeType } from "../tax/jurisdictions/flat.js";
import type { ResolvedTaxCharacter } from "../tax/types.js";
import { accountNode, deposit } from "./accounts.js";
import {
  changedValue,
  eventValueAt,
  nominalAtPeriod,
  type PeriodAmountArgs,
  periodAmount,
  resolveWindow,
  type Window,
} from "./amounts.js";
import {
  addLedger,
  addNode,
  type EngineContext,
  fmt,
  ownerPerson,
  type PeriodState,
  POOL,
  priceIndexAt,
  resolvedCharacter,
  traceEvent,
} from "./context.js";
import {
  type MonthIndex,
  monthAtAge,
  monthOfYear,
  overlapMonths,
  parseMonth,
  yearOf,
} from "./dates.js";
import { fxAt, isForeign } from "./indices.js";
import { annualLimit } from "./limits.js";
import { lastDeparture, residenceAt } from "./residency.js";
import { countryRules } from "./rules.js";
import { resolvePoints } from "./schedule.js";
import { deathMonthOf, ownerCutoff, survivorOf } from "./survivor.js";
import { SS_EARNINGS_TEST, ssClaimFactor, ssFullRetirementAge, ssSpousalFactor } from "./tables.js";
import type { IncomeLine } from "./types.js";

const GOV_BENEFITS = new Set(["social-security", "state-pension", "ca-cpp", "ca-oas", "ca-gis"]);

function incomeDefaultCharacter(ps: PeriodState, e: IncomeEvent): ResolvedTaxCharacter {
  for (const j of ps.stack)
    if (j.defaultCharacter && j.status === "implemented") return j.defaultCharacter(e.type);
  return defaultCharacterForIncomeType(e.type);
}

function sourceKindOf(e: IncomeEvent): IncomeLine["sourceKind"] {
  if (GOV_BENEFITS.has(e.type)) return "benefit";
  if (e.type === "pension" || e.type === "annuity") return "pension";
  return "income";
}

/** Book one income amount: line, tax item, routing and ledger. */
export function bookIncome(
  ctx: EngineContext,
  ps: PeriodState,
  args: {
    sourceId: string;
    refId: string;
    label: string;
    owner: string;
    amount: number;
    character: ResolvedTaxCharacter;
    sourceKind: IncomeLine["sourceKind"];
    exemptIn?: string[];
    accountIds?: string[];
    withholding?: IncomeEvent["tax"]["withholding"];
    /** Income event type (tax plug-ins identify government benefits, OAS...). */
    incomeType?: string;
    /** Fill the listed accounts in order up to their contribution limits; overflow to the pool. */
    preventOverflow?: boolean;
  },
): void {
  const { amount } = args;
  if (!(amount > 0)) return;
  ps.incomeLines.push({
    sourceId: args.sourceId,
    sourceKind: args.sourceKind,
    label: args.label,
    owner: args.owner,
    amount,
    taxCharacter: args.character,
  });
  if (args.character !== "tax-free") {
    ps.taxIncome.push({
      sourceId: args.sourceId,
      owner: args.owner,
      character: args.character,
      amount,
      exemptIn: args.exemptIn ?? [],
      ...(args.incomeType ? { incomeType: args.incomeType } : {}),
    });
    if (args.withholding) ps.withholding.set(args.sourceId, args.withholding);
  }
  const node = addNode(ps, {
    id: `income:${args.sourceId}`,
    kind: "income",
    label: args.label,
    refId: args.refId,
  });
  const targets = (args.accountIds ?? []).map((id) => ctx.accountById.get(id)!).filter(Boolean);
  if (targets.length > 0 && args.preventOverflow) {
    let left = amount;
    for (const t of targets) {
      if (left <= 1e-9) break;
      const lg = annualLimit(ctx, ps, t);
      const key = lg ? `${t.owner}|${lg.group}` : null;
      const room = lg
        ? Math.max(0, (lg.annual * ps.bounds.months) / 12 - (ps.limitUsed.get(key!) ?? 0))
        : left;
      const put = Math.min(left, room);
      if (put <= 0) continue;
      deposit(t, put);
      if (key) ps.limitUsed.set(key, (ps.limitUsed.get(key) ?? 0) + put);
      addLedger(ctx, ps, {
        from: node,
        to: accountNode(ps, t),
        amount: put,
        kind: "income",
        causeId: args.refId,
      });
      left -= put;
    }
    if (left > 1e-9) {
      ps.poolInflow += left;
      addLedger(ctx, ps, {
        from: node,
        to: POOL,
        amount: left,
        kind: "income",
        causeId: args.refId,
      });
      traceEvent(
        ctx,
        ps,
        "income",
        "ROUTING_OVERFLOW",
        () => `${args.label}: ${fmt(left)} exceeded the accounts' limits and went to cash flow`,
        [args.refId],
        { overflow: left },
      );
    }
  } else if (targets.length > 0) {
    for (const t of targets) {
      deposit(t, amount / targets.length);
      addLedger(ctx, ps, {
        from: node,
        to: accountNode(ps, t),
        amount: amount / targets.length,
        kind: "income",
        causeId: args.refId,
      });
    }
  } else {
    ps.poolInflow += amount;
    addLedger(ctx, ps, { from: node, to: POOL, amount, kind: "income", causeId: args.refId });
  }
}

function changeFor(ctx: EngineContext, e: IncomeEvent): Change {
  const mod = ctx.plan.assumptions.benefitColaModifier;
  if (mod !== 0 && GOV_BENEFITS.has(e.type) && e.change.kind === "inflation")
    return { kind: "inflation", plus: e.change.plus + mod };
  return e.change;
}

function partTimeShare(
  ctx: EngineContext,
  e: IncomeEvent,
): ((m: MonthIndex) => number) | undefined {
  if (!e.partTime) return undefined;
  const pt = resolveWindow(ctx, e.partTime.range);
  const share = e.partTime.share;
  return (m) => (pt.start !== null && m >= pt.start && m < pt.end ? share : 1);
}

/** Amount of an event in this period, split into the owner's part and the survivor's part. */
function eventAmounts(
  ctx: EngineContext,
  ps: PeriodState,
  e: IncomeEvent,
  overrides: Partial<PeriodAmountArgs> = {},
) {
  const pt = partTimeShare(ctx, e);
  const base: PeriodAmountArgs = {
    amount:
      e.type === "hourly"
        ? { value: e.amount.value * e.hoursPerWeek, basis: e.amount.basis }
        : e.amount,
    frequency: e.type === "hourly" ? "weekly" : e.frequency,
    range: e.range,
    change: changeFor(ctx, e),
    growFromToday: e.growFromToday,
    refs: [e.id],
    changeLimit: e.changeLimit,
    recurrence: e.recurrence,
    inflationCategory: e.inflationCategory,
    currency: e.currency,
    ...(pt ? { monthShare: pt } : {}),
    ...overrides,
  };
  if (e.type === "state-pension") {
    const uplift = statePensionDeferralUplift(ctx, e);
    if (uplift > 0) base.amount = { ...base.amount, value: base.amount.value * (1 + uplift) };
  }
  if (e.type === "state-pension" && e.tripleLock && !overrides.uprate) {
    const tl = e.tripleLock;
    base.uprate = (i) => {
      const inf = ctx.market[i]!.inflation;
      return Math.max(inf, inf + tl.earningsPremium, tl.floor);
    };
  }
  const cutoff = ownerCutoff(ctx, e.owner);
  if (e.type === "state-pension" && ps.crossBorder) {
    const frozen = statePensionFreeze(ctx, ps, e, base);
    if (frozen !== 1)
      base.monthShare = (
        (prior) => (m: MonthIndex) =>
          frozen * (prior?.(m) ?? 1)
      )(base.monthShare);
  }
  const own = periodAmount(ctx, ps, { ...base, cutoff });
  let survivor = 0;
  if (e.survivorShare && Number.isFinite(cutoff) && cutoff < ps.bounds.end) {
    const share = e.survivorShare;
    const prior = base.monthShare;
    survivor = periodAmount(ctx, ps, {
      ...base,
      monthShare: (m) => (m >= cutoff ? share * (prior?.(m) ?? 1) : 0),
    });
  }
  return { own, survivor, cutoff };
}

export { UK_STATE_PENSION_DEFERRAL } from "../tax/data/uk.js";

/**
 * UK State Pension paid abroad: uprated only in the EEA, Switzerland, Gibraltar and countries with a
 * social security agreement that provides for it (not Canada or New Zealand). Elsewhere it stays at
 * the rate first paid abroad (the rate when the owner left, or the first payment if later); back to
 * the current rate on return. Returns the multiplier on this period's (uprated) amount.
 */
function statePensionFreeze(
  ctx: EngineContext,
  ps: PeriodState,
  e: Extract<IncomeEvent, { type: "state-pension" }>,
  args: PeriodAmountArgs,
): number {
  if (ctx.plan.tax.crossBorder?.freezeStatePensionAbroad === false) return 1;
  if ((e.country ?? ctx.household.location.country) !== "GB") return 1;
  const owner = ownerPerson(ctx, e.owner).id;
  const here = residenceAt(ctx, owner, ps.bounds.start).country;
  if (ukStatePensionUprated(here)) return 1;
  const w = resolveWindow(ctx, e.range);
  if (w.start === null) return 1;
  const left = lastDeparture(ctx, owner, "GB", ps.bounds.start) ?? ctx.start;
  const frozenAt = Math.max(left, w.start, ctx.start);
  if (frozenAt >= ps.bounds.start) return 1;
  const now = eventValueAt(ctx, { ...args, currency: undefined }, ps.bounds.start);
  const then = eventValueAt(ctx, { ...args, currency: undefined }, frozenAt);
  if (!(now > 0)) return 1;
  const f = Math.min(1, then / now);
  if (f < 1)
    traceEvent(
      ctx,
      ps,
      "income",
      "STATE_PENSION_FROZEN",
      () =>
        `${e.name} is not uprated while living in ${here}: paid at ${(f * 100).toFixed(1)}% of the current rate`,
      [e.id],
      { country: here, factor: f },
      "full",
    );
  return f;
}

const deferralSeen = new WeakSet<object>();

/**
 * State pension deferral uplift as a fraction (0.058 = +5.8%), from the country plug-in's hooks
 * (`statePensionAge` + `statePensionDeferralUplift`): UK new State Pension +1% per 9 weeks (at least
 * 9 weeks), German statutory pension +0.5% a month. Applies to state-pension events in the event's
 * country (else the household's) unless `deferral.kind` is 'none'; 'rate' uses the given yearly
 * uplift pro rata from the country's state-pension age (the UK's when the country has none).
 * A pension that starts at (or before) the plan start is already in payment: no uplift is added.
 */
export function statePensionDeferralUplift(
  ctx: EngineContext,
  e: Extract<IncomeEvent, { type: "state-pension" }>,
): number {
  const d = e.deferral ?? { kind: "auto" as const };
  if (d.kind === "none") return 0;
  const rules = countryRules(ctx, e.country ?? ctx.household.location.country);
  const uplifter = rules.find((j) => j.statePensionDeferralUplift && j.statePensionAge);
  if (d.kind === "auto" && !uplifter) return 0;
  const w = resolveWindow(ctx, e.range);
  // A pension already in payment at the plan start is entered at the amount being received.
  if (w.start === null || w.start <= ctx.start) return 0;
  const person = ownerPerson(ctx, e.owner);
  const q = { birthYear: yearOf(person.birth), birthMonth: monthOfYear(person.birth) + 1 };
  const spa =
    rules.map((j) => j.statePensionAge?.(q) ?? null).find((x) => x !== null) ??
    ukStatePensionAge(q.birthYear, q.birthMonth);
  const months = w.start - monthAtAge(person.birth, spa);
  if (months <= 0) return 0;
  const uplift =
    d.kind === "rate"
      ? (d.ratePerYear * months) / 12
      : uplifter!.statePensionDeferralUplift!({ ...q, monthsDeferred: months });
  if (uplift > 0 && !deferralSeen.has(ctx.trace) && ctx.options.trace !== "off") {
    deferralSeen.add(ctx.trace);
    traceEvent(
      ctx,
      null,
      "income",
      "STATE_PENSION_DEFERRED",
      () =>
        `${e.name} starts ${months} months after state pension age: +${(uplift * 100).toFixed(1)}% deferral uplift`,
      [e.id],
      { months, uplift },
    );
  }
  return uplift;
}

export function runIncome(ctx: EngineContext, ps: PeriodState): void {
  // Social Security last: the earnings test needs this period's wages.
  const ordered = [
    ...ctx.plan.income.filter((e) => !(e.type === "social-security" && e.mode === "estimate")),
    ...ctx.plan.income.filter((e) => e.type === "social-security" && e.mode === "estimate"),
  ];
  for (const e of ordered) {
    if (!e.enabled) continue;
    if (e.type === "social-security" && e.mode === "estimate" && e.estimate) {
      socialSecurityEstimate(ctx, ps, e);
      continue;
    }
    if (e.type === "rsu" && e.vesting.length > 0) {
      rsuVesting(ctx, ps, e);
      continue;
    }
    const character = resolvedCharacter(e.tax.character, incomeDefaultCharacter(ps, e));
    const { own, survivor, cutoff } = eventAmounts(ctx, ps, e);
    const routing = e.sendTo.kind === "accounts" ? e.sendTo.accountIds : undefined;
    const common = {
      refId: e.id,
      label: e.name,
      character,
      sourceKind: sourceKindOf(e),
      exemptIn: e.tax.exemptIn,
      withholding: e.tax.withholding,
      incomeType: e.type,
      ...(routing ? { accountIds: routing } : {}),
      ...(e.sendTo.kind === "accounts" && e.sendTo.preventOverflow
        ? { preventOverflow: true }
        : {}),
    };
    const before = ps.incomeLines.length;
    bookIncome(ctx, ps, { ...common, sourceId: e.id, owner: e.owner, amount: own });
    if (survivor > 0) {
      const to = survivorOf(ctx, e.owner) ?? "joint";
      bookIncome(ctx, ps, {
        ...common,
        sourceId: `${e.id}:survivor`,
        owner: to,
        amount: survivor,
        label: `${e.name} (survivor)`,
      });
    }
    if (isForeign(ctx, e.currency)) {
      // Original-currency detail at the period's opening rate (amounts are valued then).
      const rate = fxAt(ctx, e.currency, ps.bounds.start);
      for (let k = before; k < ps.incomeLines.length; k++) {
        const l = ps.incomeLines[k]!;
        l.currency = e.currency;
        l.amountOriginal = l.amount / rate;
      }
    }
    if ((e.type === "salary" || e.type === "hourly") && e.pension)
      definedBenefit(ctx, ps, e, own, cutoff);
    if (e.type === "salary" && e.endOfService) endOfServiceGratuity(ctx, ps, e, cutoff);
  }
  survivorBenefits(ctx, ps);
}

/**
 * US Social Security survivor benefit for benefits entered as amounts (estimate mode handles it
 * itself): after a death, a survivor aged 60+ receives the larger of their own benefit and the
 * deceased's, so they get the difference as a survivor benefit. Events with an explicit
 * `survivorShare` follow that share instead.
 */
function survivorBenefits(ctx: EngineContext, ps: PeriodState): void {
  for (const e of ctx.plan.income) {
    if (
      !e.enabled ||
      e.type !== "social-security" ||
      e.mode !== "amount" ||
      e.survivorShare !== undefined
    )
      continue;
    const cutoff = ownerCutoff(ctx, e.owner);
    if (!Number.isFinite(cutoff) || cutoff >= ps.bounds.end) continue;
    const survivorId = ctx.people.find((p) => p.id !== e.owner)?.id;
    if (!survivorId) continue;
    const sp = ctx.people.find((p) => p.id === survivorId)!;
    const from = Math.max(cutoff, monthAtAge(sp.birth, 60));
    const after = (m: MonthIndex) => (m >= from ? 1 : 0);
    const deceased = eventAmounts(
      ctx,
      ps,
      { ...e, survivorShare: 1 },
      { monthShare: after },
    ).survivor;
    if (!(deceased > 0)) continue;
    let own = 0;
    for (const x of ctx.plan.income)
      if (x.enabled && x.type === "social-security" && x.owner === survivorId)
        own += eventAmounts(ctx, ps, x, { monthShare: after }).own;
    const benefit = deceased - own;
    if (!(benefit > 0)) continue;
    const character = resolvedCharacter(e.tax.character, incomeDefaultCharacter(ps, e));
    bookIncome(ctx, ps, {
      sourceId: `${e.id}:survivor-benefit`,
      refId: e.id,
      label: `${e.name} (survivor benefit)`,
      owner: survivorId,
      amount: benefit,
      character,
      sourceKind: "benefit",
      exemptIn: e.tax.exemptIn,
      incomeType: "social-security",
    });
    traceEvent(
      ctx,
      ps,
      "income",
      "SURVIVOR_BENEFIT",
      () => `${sp.name} receives ${fmt(benefit)} survivor benefit from ${e.name}`,
      [e.id, survivorId],
      { benefit },
    );
  }
}

// ------------------------------------------------------------------ end-of-service gratuity

/**
 * UAE end-of-service gratuity (Federal Decree-Law 33 of 2021, Art. 51; tax/data/ae.ts): a deferred
 * lump sum paid in the month the salary's range ends (its exclusive end), from the last monthly
 * basic wage (`basicShare` of the salary) and the years of continuous service. Not paid when the
 * employment outlives the plan or the owner dies first.
 */
function endOfServiceGratuity(
  ctx: EngineContext,
  ps: PeriodState,
  e: Extract<IncomeEvent, { type: "salary" }>,
  cutoff: number,
): void {
  const eos = e.endOfService!;
  const w = resolveWindow(ctx, e.range);
  if (w.start === null || !Number.isFinite(w.end)) return;
  const pay = w.end;
  if (pay < ps.bounds.start || pay >= ps.bounds.end || pay > cutoff) return;
  const serviceStart = eos.serviceStart ? parseMonth(eos.serviceStart) : w.start;
  const years = (pay - serviceStart) / 12;
  const args: PeriodAmountArgs = {
    amount: e.amount,
    frequency: e.frequency,
    range: e.range,
    window: w,
    change: changeFor(ctx, e),
    growFromToday: e.growFromToday,
    refs: [e.id],
    changeLimit: e.changeLimit,
    inflationCategory: e.inflationCategory,
    currency: e.currency,
  };
  const perUnit = eventValueAt(ctx, args, pay - 1);
  const monthly = (perUnit * (e.frequency === "once" ? 0 : FREQUENCY_PER_YEAR[e.frequency])) / 12;
  const amount = aeGratuity(years, monthly * eos.basicShare);
  if (!(amount > 0)) return;
  bookIncome(ctx, ps, {
    sourceId: `${e.id}:gratuity`,
    refId: e.id,
    label: `${e.name} end-of-service gratuity`,
    owner: e.owner,
    amount,
    character: "wage",
    sourceKind: "income",
    incomeType: "end-of-service-gratuity",
    ...(e.sendTo.kind === "accounts" ? { accountIds: e.sendTo.accountIds } : {}),
  });
  traceEvent(
    ctx,
    ps,
    "income",
    "END_OF_SERVICE_GRATUITY",
    () =>
      `${e.name}: end-of-service gratuity ${fmt(amount)} after ${years.toFixed(2)} years of service`,
    [e.id],
    { years, monthlyBasic: monthly * eos.basicShare, amount },
  );
}

// ------------------------------------------------------------------ defined-benefit pension

function definedBenefit(
  ctx: EngineContext,
  ps: PeriodState,
  e: Extract<IncomeEvent, { type: "salary" | "hourly" }>,
  pay: number,
  cutoff: number,
): void {
  const db = e.pension!;
  // Working months this period (for annualising pay).
  const w = resolveWindow(ctx, e.range);
  const months =
    w.start === null
      ? 0
      : overlapMonths(w.start, Math.min(w.end, cutoff), ps.bounds.start, ps.bounds.end);
  if (months > 0 && pay > 0) {
    const annual = (pay * 12) / months;
    const h = ctx.payHistory.get(e.id) ?? { payMonths: 0, months: 0, finalAnnual: 0 };
    h.payMonths += annual * months;
    h.months += months;
    h.finalAnnual = annual;
    ctx.payHistory.set(e.id, h);
    const c =
      db.employeeContribution.kind === "percentOfPay"
        ? db.employeeContribution.rate * pay
        : (nominalAtPeriod(ps, db.employeeContribution.amount) * months) / 12;
    if (c > 0) {
      ps.poolRequired += c;
      const node = addNode(ps, {
        id: `external:db:${e.id}`,
        kind: "external",
        label: `${e.name} pension scheme`,
        refId: e.id,
      });
      addLedger(ctx, ps, { from: POOL, to: node, amount: c, kind: "contribution", causeId: e.id });
      if (db.contributionsReduceTaxableIncome)
        ps.taxDeductions.push({
          sourceId: `${e.id}:db-contribution`,
          kind: "pre-tax-contribution",
          amount: c,
          itemized: false,
          levels: ["federal", "state", "local"],
          owner: e.owner,
        });
    }
  }
  const pw = resolveWindow(ctx, db.payouts);
  if (pw.start === null) return;
  const lo = Math.max(pw.start, ps.bounds.start);
  const hi = Math.min(pw.end, ps.bounds.end);
  if (hi <= lo) return;
  let fixed = ctx.dbPayout.get(e.id);
  if (!fixed) {
    const h = ctx.payHistory.get(e.id);
    const start = Math.max(pw.start, ctx.start);
    let annual = 0;
    if (db.payout.kind === "percentOfFinalPay") annual = db.payout.rate * (h?.finalAnnual ?? 0);
    else if (db.payout.kind === "percentOfCareerAverage")
      annual = db.payout.rate * (h && h.months > 0 ? h.payMonths / h.months : 0);
    else
      annual = changedValue(
        ctx,
        db.payout.amount,
        { kind: "none" },
        e.growFromToday ? ctx.start : start,
        start,
      );
    fixed = { annual, start };
    ctx.dbPayout.set(e.id, fixed);
    traceEvent(
      ctx,
      ps,
      "income",
      "DB_PENSION_START",
      () => `${e.name} pension starts at ${fmt(annual)} a year`,
      [e.id],
      {
        annual,
        kind: db.payout.kind,
      },
    );
  }
  const f = fixed;
  const args: PeriodAmountArgs = {
    amount: { value: f.annual, basis: "nominal" },
    frequency: "yearly",
    range: db.payouts,
    window: pw,
    change: db.payoutChange,
    growFromToday: false,
    refs: [e.id],
  };
  const own = periodAmount(ctx, ps, { ...args, cutoff });
  const character: ResolvedTaxCharacter = db.payoutsTaxFree ? "tax-free" : "pension";
  bookIncome(ctx, ps, {
    sourceId: `${e.id}:pension`,
    refId: e.id,
    label: `${e.name} pension`,
    owner: e.owner,
    amount: own,
    character,
    sourceKind: "pension",
    incomeType: "pension",
  });
  if (db.survivorShare && Number.isFinite(cutoff) && cutoff < ps.bounds.end) {
    const share = db.survivorShare;
    const amt = periodAmount(ctx, ps, { ...args, monthShare: (m) => (m >= cutoff ? share : 0) });
    bookIncome(ctx, ps, {
      sourceId: `${e.id}:pension:survivor`,
      refId: e.id,
      label: `${e.name} pension (survivor)`,
      owner: survivorOf(ctx, e.owner) ?? "joint",
      amount: amt,
      character,
      sourceKind: "pension",
      incomeType: "pension",
    });
  }
}

// ------------------------------------------------------------------ RSU vesting

function rsuVesting(
  ctx: EngineContext,
  ps: PeriodState,
  e: Extract<IncomeEvent, { type: "rsu" }>,
): void {
  const cutoff = ownerCutoff(ctx, e.owner);
  let total = 0;
  for (const p of resolvePoints(ctx, e.vesting)) {
    if (p.month < ps.bounds.start || p.month >= ps.bounds.end || p.month >= cutoff) continue;
    total += e.amount.basis === "real" ? p.value * priceIndexAt(ctx, p.month) : p.value;
  }
  if (total <= 0) return;
  const character = resolvedCharacter(e.tax.character, incomeDefaultCharacter(ps, e));
  const dest =
    e.destinationAccountId ?? (e.sendTo.kind === "accounts" ? e.sendTo.accountIds[0] : undefined);
  bookIncome(ctx, ps, {
    sourceId: e.id,
    refId: e.id,
    label: e.name,
    owner: e.owner,
    amount: total,
    character,
    sourceKind: "income",
    exemptIn: e.tax.exemptIn,
    withholding: e.tax.withholding,
    incomeType: "rsu",
    ...(dest ? { accountIds: [dest] } : {}),
  });
  traceEvent(ctx, ps, "income", "RSU_VEST", () => `${e.name}: ${fmt(total)} vested`, [e.id], {
    amount: total,
  });
}

// ------------------------------------------------------------------ Social Security estimate

interface SsProfile {
  personId: string;
  pia: number;
  ownMonthly: number;
  claimMonth: MonthIndex;
  fraMonth: MonthIndex;
  monthsEarly: number;
  est: NonNullable<Extract<IncomeEvent, { type: "social-security" }>["estimate"]>;
  event: Extract<IncomeEvent, { type: "social-security" }>;
}

function ssProfile(
  ctx: EngineContext,
  e: Extract<IncomeEvent, { type: "social-security" }>,
): SsProfile | null {
  const est = e.estimate;
  if (!est) return null;
  const person = ownerPerson(ctx, e.owner);
  const birthYear = yearOf(person.birth);
  const fra = est.fullRetirementAge ?? ssFullRetirementAge(birthYear);
  const monthsEarly = Math.round((fra - est.claimAge) * 12);
  return {
    personId: person.id,
    pia: est.pia,
    ownMonthly: est.pia * ssClaimFactor(monthsEarly) * est.expectedShare,
    claimMonth: monthAtAge(person.birth, est.claimAge),
    fraMonth: monthAtAge(person.birth, fra),
    monthsEarly,
    est,
    event: e,
  };
}

/** Real (today's money) monthly benefit for `self` in month m. */
function ssMonthly(
  ctx: EngineContext,
  self: SsProfile,
  spouse: SsProfile | null,
  m: MonthIndex,
): number {
  let own = m >= self.claimMonth ? self.ownMonthly : 0;
  if (spouse && self.est.spousal && spouse.est.spousal) {
    const start = Math.max(self.claimMonth, spouse.claimMonth);
    const spouseDeath = deathMonthOf(ctx, spouse.personId);
    if (m >= start && (spouseDeath === null || m <= spouseDeath)) {
      const excess = Math.max(0, 0.5 * spouse.pia - self.pia) * ssSpousalFactor(self.monthsEarly);
      own += excess * self.est.expectedShare;
    }
  }
  if (spouse && self.est.survivor) {
    const d = deathMonthOf(ctx, spouse.personId);
    const selfPerson = ctx.people.find((p) => p.id === self.personId)!;
    if (d !== null && m > d && m >= monthAtAge(selfPerson.birth, 60)) {
      const claimedByDeath = spouse.claimMonth <= d;
      const deceased = claimedByDeath
        ? Math.max(spouse.ownMonthly, 0.825 * spouse.pia)
        : spouse.pia;
      own = Math.max(own, deceased * self.est.expectedShare);
    }
  }
  return own;
}

function socialSecurityEstimate(
  ctx: EngineContext,
  ps: PeriodState,
  e: Extract<IncomeEvent, { type: "social-security" }>,
): void {
  const self = ssProfile(ctx, e);
  if (!self) return;
  const spouseEvent = ctx.plan.income.find(
    (x): x is Extract<IncomeEvent, { type: "social-security" }> =>
      x.enabled &&
      x.type === "social-security" &&
      x.mode === "estimate" &&
      !!x.estimate &&
      x.owner !== e.owner &&
      ctx.people.some((p) => p.id === x.owner),
  );
  const spouse = spouseEvent ? ssProfile(ctx, spouseEvent) : null;
  const w: Window = resolveWindow(ctx, e.range);
  if (w.start === null) return;
  const cutoff = ownerCutoff(ctx, e.owner);
  const lo = Math.max(ps.bounds.start, w.start);
  const hi = Math.min(ps.bounds.end, w.end, cutoff);
  if (hi <= lo) return;
  let realSum = 0;
  let realBeforeFra = 0;
  for (let m = lo; m < hi; m++) {
    const v = ssMonthly(ctx, self, spouse, m);
    realSum += v;
    if (m < self.fraMonth) realBeforeFra += v;
  }
  if (realSum <= 0) return;
  // COLA: the benefit (today's money at the plan start) follows the change rule from the plan start.
  const factor = changedValue(ctx, { value: 1, basis: "real" }, changeFor(ctx, e), ctx.start, lo);
  let gross = realSum * factor;
  // Earnings test on benefits paid before full retirement age.
  if (realBeforeFra > 0) {
    let earnings = 0;
    for (const i of ps.taxIncome)
      if (i.owner === e.owner && (i.character === "wage" || i.character === "self-employment"))
        earnings += i.amount;
    const fraYear = yearOf(self.fraMonth) === ps.bounds.year;
    const exempt =
      (fraYear ? SS_EARNINGS_TEST.fraYear : SS_EARNINGS_TEST.underFra) *
      ps.piStart *
      (ps.bounds.months / 12);
    const share = fraYear
      ? Math.min(1, Math.max(0, self.fraMonth - ps.bounds.start) / ps.bounds.months)
      : 1;
    const excess = Math.max(0, earnings * share - exempt);
    const withheld = Math.min(realBeforeFra * factor, excess / (fraYear ? 3 : 2));
    if (withheld > 0) {
      gross -= withheld;
      traceEvent(
        ctx,
        ps,
        "income",
        "SS_EARNINGS_TEST",
        () => `${e.name}: ${fmt(withheld)} withheld by the earnings test`,
        [e.id],
        {
          withheld,
          earnings,
        },
      );
    }
  }
  const character = resolvedCharacter(e.tax.character, incomeDefaultCharacter(ps, e));
  bookIncome(ctx, ps, {
    sourceId: e.id,
    refId: e.id,
    label: e.name,
    owner: e.owner,
    amount: gross,
    character,
    sourceKind: "benefit",
    exemptIn: e.tax.exemptIn,
    withholding: e.tax.withholding,
    incomeType: "social-security",
    ...(e.sendTo.kind === "accounts" ? { accountIds: e.sendTo.accountIds } : {}),
  });
}
