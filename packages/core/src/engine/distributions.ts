/**
 * Forced distributions, taken before the cash-flow settle so the cash covers expenses first
 * (expenses therefore "reduce" the requirement) and any surplus goes through Flows/leftover:
 *   - US RMDs (SECURE 2.0 start ages, Uniform Lifetime Table; prior year-end balance = the
 *     period's opening balance; first-period `alreadyTakenThisYear` reduces the requirement);
 *   - inherited IRAs: 10-year rule (annual RMDs when the original owner had reached their
 *     required beginning age, full divestment in year 10) and stretch (single life expectancy);
 *   - Canada RRIF minimums and Australian super minimum drawdowns;
 *   - custom distribution schedules;
 *   - 72(t) SEPP (RMD, fixed amortisation, fixed annuitisation approximated by amortisation,
 *     custom), penalty-free until the later of 5 years and age 59.5;
 *   - qualified charitable distributions (QCD) count toward the requirement.
 * A jurisdiction implementing `requiredDistribution` overrides the built-in tables.
 */

import { seppAnnuityFactor } from "../tax/data/us-federal.js";
import { isOpen, withdraw } from "./accounts.js";
import { nominalAtPeriod } from "./amounts.js";
import {
  type AccountState,
  type EngineContext,
  fmt,
  ownerAge,
  ownerPerson,
  type PeriodState,
  priceIndexAt,
  traceEvent,
} from "./context.js";
import { ageAt, monthAtAge, parseMonth, yearOf } from "./dates.js";
import { resolveRef } from "./milestones.js";
import { rulesFor } from "./rules.js";
import { resolvePoints, valueAt } from "./schedule.js";
import {
  auMinimumDrawdown,
  rrifMinimumFactor,
  singleLifeExpectancy,
  uniformLifetimeDivisor,
  usRmdStartAge,
} from "./tables.js";

function jurisdictionRmd(
  ctx: EngineContext,
  ps: PeriodState,
  a: AccountState,
  rule: string,
  age: number,
  birthYear: number,
): number | null {
  for (const j of rulesFor(ctx, a, ps)) {
    if (!j.requiredDistribution) continue;
    return j.requiredDistribution({
      accountType: a.def.type,
      rule,
      year: ps.bounds.year,
      ownerAge: age,
      priorYearEndBalance: a.p.opening,
      ownerBirthYear: birthYear,
    });
  }
  return null;
}

/** Account types with statutory minimum distributions, and the rule that applies to them. */
const STATUTORY_RULE: Partial<
  Record<string, "us-rmd" | "ca-rrif-minimum" | "au-minimum-drawdown">
> = {
  "traditional-ira": "us-rmd",
  "sep-ira": "us-rmd",
  "simple-ira": "us-rmd",
  "401k": "us-rmd",
  "403b": "us-rmd",
  "457b": "us-rmd",
  "401a": "us-rmd",
  "solo-401k": "us-rmd",
  tsp: "us-rmd",
  "ca-rrif": "ca-rrif-minimum",
  "au-super-pension": "au-minimum-drawdown",
};

/**
 * The distribution rule in force: the account's own, else the statutory minimum for its type (US
 * RMDs on traditional accounts, RRIF and AU pension minimums), which applies whether or not the
 * plan mentions it. Inherited IRAs follow the 10-year rule by default.
 */
function effectiveRule(a: AccountState): AccountState["behaviour"]["distributions"] {
  const d = a.behaviour.distributions;
  if (d.kind !== "none") return d;
  if (a.def.type === "inherited-ira" && a.def.inherited)
    return { kind: "required", rule: "us-inherited-10-year", alreadyTakenThisYear: 0 };
  const rule = STATUTORY_RULE[a.def.type];
  return rule ? { kind: "required", rule, alreadyTakenThisYear: 0 } : d;
}

/** Annual required amount for an account this period (before proration). */
function requiredAnnual(ctx: EngineContext, ps: PeriodState, a: AccountState): number {
  const d = effectiveRule(a);
  if (d.kind === "none") return 0;
  const person = ownerPerson(ctx, a.owner);
  const birthYear = yearOf(person.birth);
  // Age at the end of the calendar year (RMD convention) and at the period start.
  const ageEoy = ps.bounds.year - birthYear;
  const ageStart = ageAt(person.birth, ps.bounds.start);
  const bal = a.p.opening;
  if (bal <= 0) return 0;
  if (d.kind === "custom") {
    const v = valueAt(resolvePoints(ctx, d.points), ps.bounds.start, "step");
    if (v === null) return 0;
    return d.basis === "real" ? v * priceIndexAt(ctx, ps.bounds.start) : v;
  }
  // Statutory tables live with the jurisdiction (US Uniform Lifetime, RRIF factors, AU minimums);
  // inherited-account rules stay in the engine.
  const fromJurisdiction =
    d.rule === "us-rmd" || d.rule === "ca-rrif-minimum" || d.rule === "au-minimum-drawdown"
      ? jurisdictionRmd(ctx, ps, a, d.rule, ageEoy, birthYear)
      : null;
  if (fromJurisdiction !== null) return fromJurisdiction;
  switch (d.rule) {
    case "us-rmd":
      return ageEoy >= usRmdStartAge(birthYear) ? bal / uniformLifetimeDivisor(ageEoy) : 0;
    case "us-inherited-10-year":
    case "us-inherited-stretch": {
      const inh = a.def.inherited;
      if (!inh) return 0;
      const deathYear = yearOf(parseMonth(inh.originalOwnerDeathMonth));
      const firstYear = deathYear + 1;
      if (ps.bounds.year < firstYear) return 0;
      const benAgeFirst = firstYear - birthYear;
      const divisor = Math.max(1, singleLifeExpectancy(benAgeFirst) - (ps.bounds.year - firstYear));
      if (d.rule === "us-inherited-stretch") return divisor <= 1 ? bal : bal / divisor;
      if (ps.bounds.year >= deathYear + 10) return bal;
      const ownerBirthYear = yearOf(parseMonth(inh.originalOwnerBirthMonth));
      const ownerStarted = deathYear - ownerBirthYear >= usRmdStartAge(ownerBirthYear);
      return ownerStarted ? bal / divisor : 0;
    }
    case "ca-rrif-minimum":
      return bal * rrifMinimumFactor(ageStart);
    case "au-minimum-drawdown":
      return bal * auMinimumDrawdown(ageStart);
  }
}

function retirementMonth(ctx: EngineContext, owner: string): number | null {
  for (const st of ctx.milestones.values())
    if (
      st.def.kind === "retirement" &&
      (!st.def.personId || st.def.personId === owner) &&
      typeof st.month === "number"
    )
      return st.month;
  return null;
}

/** 72(t) annual payment for this period (null when SEPP is inactive). */
function seppAnnual(ctx: EngineContext, ps: PeriodState, a: AccountState): number | null {
  const s = a.behaviour.sepp;
  if (s.method === "none") return null;
  if (!a.sepp) {
    const r = s.start ? resolveRef(ctx, s.start) : retirementMonth(ctx, a.owner);
    if (typeof r !== "number") return null;
    const person = ownerPerson(ctx, a.owner);
    const end = Math.max(r + 60, monthAtAge(person.birth, 59.5));
    a.sepp = { start: r, end, annual: null };
  }
  const st = a.sepp;
  if (st.start >= ps.bounds.end || st.end <= ps.bounds.start) return null;
  const age = ownerAge(ctx, a.owner, Math.max(ps.bounds.start, st.start));
  switch (s.method) {
    case "rmd":
      return a.p.opening / singleLifeExpectancy(age);
    case "fixed-amortization": {
      if (st.annual === null) {
        const r = s.interestRate ?? 0.05;
        const n = singleLifeExpectancy(age);
        st.annual = r === 0 ? a.p.opening / n : (a.p.opening * r) / (1 - (1 + r) ** -n);
      }
      return st.annual;
    }
    case "fixed-annuitization": {
      // Notice 2022-6: balance / annuity factor from the §1.401(a)(9)-9(e) mortality rates at the
      // age attained in the first distribution year.
      if (st.annual === null) {
        const person = ownerPerson(ctx, a.owner);
        const attained = yearOf(Math.max(ps.bounds.start, st.start)) - yearOf(person.birth);
        st.annual = a.p.opening / seppAnnuityFactor(attained, s.interestRate ?? 0.05);
      }
      return st.annual;
    }
    case "custom":
      return s.customAmount ? nominalAtPeriod(ps, s.customAmount) : 0;
  }
}

export function runDistributions(ctx: EngineContext, ps: PeriodState): void {
  // QCDs first: they come straight out of the IRA, are excluded from income and count toward RMDs.
  for (let k = ps.targeted.length - 1; k >= 0; k--) {
    const t = ps.targeted[k]!;
    if (!t.qcd) continue;
    const a = ctx.accountById.get(t.accountIds[0]!);
    if (!a) continue;
    const r = withdraw(ctx, ps, a, t.line.requested, {
      purpose: "qcd",
      penaltyFree: true,
      taxExempt: true,
      causeId: t.line.sourceId,
    });
    a.p.qcd += r.gross;
    ps.poolInflow += r.gross;
    ps.targeted.splice(k, 1);
  }
  for (const a of ctx.accounts) {
    if (!isOpen(ctx, a, ps) || a.balance <= 0) continue;
    const frac = ps.bounds.months / 12;
    let required = requiredAnnual(ctx, ps, a);
    const d = a.behaviour.distributions;
    if (required > 0) {
      required *= frac;
      if (ps.bounds.index === 0 && d.kind === "required" && d.alreadyTakenThisYear > 0)
        required = Math.max(0, required / frac - d.alreadyTakenThisYear);
    }
    const sepp = seppAnnual(ctx, ps, a);
    let seppAmount = 0;
    if (sepp !== null) {
      const st = a.sepp!;
      const months = Math.min(ps.bounds.end, st.end) - Math.max(ps.bounds.start, st.start);
      seppAmount = (sepp * Math.max(0, months)) / 12;
    }
    const need = Math.max(required, seppAmount) - a.p.qcd;
    if (need <= 1e-9) continue;
    const r = withdraw(ctx, ps, a, need, {
      purpose: seppAmount >= required ? "sepp" : "required",
      penaltyFree: true,
    });
    a.p.requiredDistribution += r.gross;
    ps.poolInflow += r.gross;
    traceEvent(
      ctx,
      ps,
      "distributions",
      seppAmount >= required ? "SEPP_DISTRIBUTION" : "REQUIRED_DISTRIBUTION",
      () =>
        `${a.def.name}: required distribution of ${fmt(r.gross)}${a.p.qcd > 0 ? ` (after ${fmt(a.p.qcd)} QCD)` : ""}`,
      [a.def.id],
      { amount: r.gross, required, sepp: seppAmount, qcd: a.p.qcd },
    );
  }
}
