/**
 * Milestone effects and survivor transitions (Glideworth differentiator: survivor scenarios).
 *
 * Timing: an effect of a milestone reached in month M applies from the first period starting at
 * or after M (a tax year keeps its status in the year a change happens, e.g. joint filing in the
 * year of death). Effects of milestones reached at the plan start apply immediately.
 *
 * Death (explicit `death` effect, or a person's life-expectancy milestone in a couple):
 *   - the person is alive through the death month; their income, expenses and flows stop after it
 *     (income with `survivorShare` continues to the survivor at that share);
 *   - at the next period start their accounts, real assets and debts pass to the survivor;
 *     taxable assets get a basis step-up (full for sole ownership; half for joint, full for joint
 *     property in US community-property states) when `tax.estate.stepUpBasis`;
 *   - married filing status becomes 'qualifying-surviving-spouse' for two years when a dependent
 *     child lives at home, then 'single' (unless a setFilingStatus effect says otherwise).
 */
import { type AccountState, type EngineContext, type PeriodState, traceEvent } from "./context.js";
import { ageAt, type MonthIndex, parseMonth, yearOf } from "./dates.js";
import { resolveRef } from "./milestones.js";

const COMMUNITY_PROPERTY = new Set(["AZ", "CA", "ID", "LA", "NV", "NM", "TX", "WA", "WI"]);

/** Month a person dies (last month alive), or null when they outlive the plan. */
export function deathMonthOf(ctx: EngineContext, personId: string): MonthIndex | null {
  let out: MonthIndex | null = null;
  const consider = (m: MonthIndex) => {
    if (out === null || m < out) out = m;
  };
  for (const st of ctx.milestones.values()) {
    if (!st.def.enabled || typeof st.month !== "number") continue;
    if (st.def.kind === "life-expectancy" && st.def.personId === personId) consider(st.month);
    for (const e of st.def.effects)
      if (e.kind === "death" && e.personId === personId) consider(st.month);
  }
  return out;
}

/** Exclusive cutoff month for events owned by `owner` (Infinity for joint / survivors). */
export function ownerCutoff(ctx: EngineContext, owner: string): number {
  if (!ctx.people.some((p) => p.id === owner)) return Number.POSITIVE_INFINITY;
  const d = deathMonthOf(ctx, owner);
  return d === null ? Number.POSITIVE_INFINITY : d + 1;
}

export function survivorOf(ctx: EngineContext, personId: string): string | null {
  const other = ctx.people.find((p) => p.id !== personId && !ctx.deceased.has(p.id));
  return other ? other.id : null;
}

function stepUp(ctx: EngineContext, basis: number, value: number, wasJoint: boolean): number {
  if (!ctx.plan.tax.estate.stepUpBasis || value <= basis) return basis;
  const loc = ctx.location;
  const full =
    !wasJoint || (loc.country === "US" && !!loc.region && COMMUNITY_PROPERTY.has(loc.region));
  return full ? value : basis + (value - basis) / 2;
}

function transferAccount(ctx: EngineContext, a: AccountState, from: string, to: string): void {
  const wasJoint = a.owner === "joint";
  if (a.owner === from) a.owner = to;
  if (a.costBasis !== null && (a.info.taxTreatment === "taxable" || a.info.assetClass === "crypto"))
    a.costBasis = stepUp(ctx, a.costBasis, Math.max(0, a.balance), wasJoint);
}

/** Apply milestone effects and deaths that take effect from this period. Runs at period open. */
export function applyEffects(ctx: EngineContext, ps: PeriodState): void {
  const at = ps.bounds.start;
  // Deaths first (they may change filing status).
  for (const p of ctx.people) {
    if (ctx.deceased.has(p.id)) continue;
    const d = deathMonthOf(ctx, p.id);
    if (d === null || d >= at) continue;
    ctx.deceased.add(p.id);
    const survivor = survivorOf(ctx, p.id);
    if (!survivor) continue;
    for (const a of ctx.accounts)
      if (a.owner === p.id || a.owner === "joint") transferAccount(ctx, a, p.id, survivor);
    for (const r of ctx.assets) {
      const wasJoint = r.owner === "joint";
      if (r.owner !== p.id && !wasJoint) continue;
      if (r.owner === p.id) r.owner = survivor;
      if (r.owned) r.costBasis = stepUp(ctx, r.costBasis, r.value, wasJoint);
    }
    for (const debt of ctx.debts) if (debt.owner === p.id) debt.owner = survivor;
    if (ctx.filingStatus === "married-joint" || ctx.filingStatus === "married-separate") {
      const deathYear = yearOf(d);
      const childAtHome = ctx.household.dependents.some(
        (dep) => ageAt(parseMonth(dep.birthMonth), at) < dep.independentAtAge,
      );
      ctx.filingStatus =
        childAtHome && ps.bounds.year <= deathYear + 2 ? "qualifying-surviving-spouse" : "single";
    }
    traceEvent(
      ctx,
      ps,
      "milestones",
      "SURVIVOR_TRANSFER",
      `${p.name} died; accounts, assets and debts pass to the survivor; filing status is now ${ctx.filingStatus}`,
      [p.id, survivor],
      { filingStatus: ctx.filingStatus },
    );
  }
  // QSS lasts two years after the year of death.
  if (ctx.filingStatus === "qualifying-surviving-spouse") {
    const dead = [...ctx.deceased].map((id) => deathMonthOf(ctx, id) ?? 0);
    const lastDeathYear = dead.length > 0 ? Math.max(...dead.map(yearOf)) : ps.bounds.year;
    if (ps.bounds.year > lastDeathYear + 2) ctx.filingStatus = "single";
  }
  for (const st of ctx.milestones.values()) {
    if (!st.def.enabled || st.def.effects.length === 0) continue;
    const m =
      st.month === undefined
        ? resolveRef(ctx, { kind: "milestone", milestoneId: st.def.id, offsetMonths: 0 })
        : st.month;
    if (typeof m !== "number" || m > at) continue;
    st.def.effects.forEach((e, i) => {
      const key = `${st.def.id}#${i}`;
      if (ctx.appliedEffects.has(key)) return;
      ctx.appliedEffects.add(key);
      switch (e.kind) {
        case "setFilingStatus":
          ctx.filingStatus = e.filingStatus;
          break;
        case "setWithholding":
          ctx.withholdingRates = {
            taxDeferred: e.taxDeferred ?? ctx.withholdingRates.taxDeferred,
            taxable: e.taxable ?? ctx.withholdingRates.taxable,
            conversions: e.conversions ?? ctx.withholdingRates.conversions,
          };
          break;
        case "death":
          return; // handled above via deathMonthOf
      }
      traceEvent(
        ctx,
        ps,
        "milestones",
        `EFFECT_${e.kind.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()}`,
        `${st.def.name}: ${e.kind} applied`,
        [st.def.id],
        { effect: e },
      );
    });
  }
}
