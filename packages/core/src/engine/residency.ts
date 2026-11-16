/**
 * Residency timeline and the cross-border state of a run (ARCHITECTURE.md §4.6).
 *
 *   - Each person starts resident at `Household.location`. `Plan.residency` entries move them from
 *     an exact month (a move inside a period splits it); relocation milestone effects move them from
 *     the first period starting at or after the milestone (the long-standing effect timing).
 *   - A run is "cross-border" when the plan is in estimate mode and more than one country is
 *     involved: a residence change to another country, an account / asset / debt / income in
 *     another country, or a US citizen living outside the US. Single-country runs never touch this
 *     module beyond one boolean check, so their results are unchanged.
 *   - Exit and arrival effects (departure tax, arrival rebasing, UK temporary non-residence) are
 *     applied at period open as pinned tax items and cost-basis changes.
 */
import { ACCOUNT_TYPE_INFO } from "../schema/account-types.js";
import { fxPairKey } from "../schema/assumptions.js";
import type { Location } from "../schema/household.js";
import { COUNTRY_TAX_CURRENCY } from "../tax/crossborder/currency.js";
import { NON_RESIDENT_RULES } from "../tax/crossborder/nonresident.js";
import type { TaxIncomeItem } from "../tax/types.js";
import {
  type AccountState,
  type EngineContext,
  type PeriodState,
  traceEvent,
  warnOnce,
} from "./context.js";
import { formatMonth, type MonthIndex, parseMonth, yearOf } from "./dates.js";
import { resolveRef } from "./milestones.js";
import { accountCountryOf } from "./rules.js";

export interface ResidenceSegment {
  from: MonthIndex;
  /** Exclusive. */
  to: MonthIndex;
  location: Location;
}

export interface ResidencyState {
  active: boolean;
  /** Every country involved (residences, item countries). */
  countries: Set<string>;
  /** People taxed by the US on worldwide income wherever they live. */
  usPersons: Set<string>;
  /** Citizenships per person (default: the household's country). */
  citizenships: Map<string, Set<string>>;
  /** Jurisdiction currencies with no FX pair to the base currency (taxes computed at rate 1). */
  fxMissing: Set<string>;
  /** UK temporary non-residence: per person, the month they left the UK and the gains since. */
  ukAbsence: Map<string, { left: MonthIndex; eligible: boolean; gains: number }>;
  /** Estimated contribution basis of tax-free wrappers (earnings share when not recognised abroad). */
  wrapperBasis: Map<string, number>;
  /** Exit / arrival events already applied (key person|month|kind). */
  applied: Set<string>;
}

const US_PERSON = (p: { citizenships?: string[] | undefined; usGreenCard?: boolean | undefined }) =>
  !!p.usGreenCard || (p.citizenships ?? []).includes("US");

/** Country of an income event (explicit, else the state pension's country). */
function eventCountry(e: { country?: string | undefined }): string | undefined {
  return e.country;
}

/**
 * Decide whether the run is cross-border and prepare its state. Called once after the FX table is
 * resolved and before the FX path is built (it may add the tax currencies of the countries involved).
 */
export function initResidency(ctx: EngineContext): void {
  const { plan, household } = ctx;
  const mode = plan.tax.crossBorder?.mode ?? "auto";
  if (plan.tax.mode !== "estimate" || mode === "off") return;
  const base = household.location.country;
  const countries = new Set<string>([base]);
  for (const r of plan.residency ?? []) countries.add(r.location.country);
  for (const m of plan.milestones)
    if (m.enabled)
      for (const e of m.effects) if (e.kind === "relocate") countries.add(e.location.country);
  const excluded = new Set(plan.excludedIds);
  const accountDefs = [
    ...ctx.finances.accounts.filter((a) => !a.archived && !excluded.has(a.id)),
    ...plan.plannedAccounts,
  ];
  for (const a of accountDefs) countries.add(a.jurisdiction ?? (ACCOUNT_COUNTRY(a.type) || base));
  for (const r of [...ctx.finances.realAssets, ...plan.plannedRealAssets])
    if (!r.archived && !excluded.has(r.id)) countries.add(r.country ?? base);
  for (const d of ctx.finances.debts)
    if (!d.archived && !excluded.has(d.id)) countries.add(d.country ?? base);
  for (const e of plan.income) {
    const c = eventCountry(e);
    if (e.enabled && c) countries.add(c);
  }
  const usPersons = new Set(household.people.filter(US_PERSON).map((p) => p.id));
  const citizenships = new Map(
    household.people.map((p) => [p.id, new Set(p.citizenships?.length ? p.citizenships : [base])]),
  );
  // An explicit jurisdiction stack is the user's override: foreign accounts or assets alone do not
  // switch the plan to the cross-border model, only a move abroad or a US person outside the US.
  const residences = new Set<string>([base]);
  for (const r of plan.residency ?? []) residences.add(r.location.country);
  for (const m of plan.milestones)
    if (m.enabled)
      for (const e of m.effects) if (e.kind === "relocate") residences.add(e.location.country);
  const decisive = plan.tax.jurisdictions.length > 0 ? residences : countries;
  const active =
    decisive.size > 1 || (usPersons.size > 0 && [...residences].some((c) => c !== "US"));
  if (!active) return;
  if (usPersons.size > 0) countries.add("US");
  ctx.residency = {
    active,
    countries,
    usPersons,
    citizenships,
    fxMissing: new Set(),
    ukAbsence: new Map(),
    wrapperBasis: new Map(),
    applied: new Set(),
  };
  addTaxCurrencies(ctx, countries);
}

function ACCOUNT_COUNTRY(type: string): string | undefined {
  return (ACCOUNT_TYPE_INFO as Record<string, { country?: string }>)[type]?.country;
}

/** Make the tax currency of every involved country convertible (FX table pair, direct or inverse). */
function addTaxCurrencies(ctx: EngineContext, countries: Set<string>): void {
  const base = ctx.household.currency;
  ctx.fx ??= new Map();
  const table = new Map<string, { from: string; to: string; rate: number; annualDrift: number }>();
  for (const r of ctx.finances.fxRates ?? []) table.set(fxPairKey(r.from, r.to), r);
  for (const r of ctx.plan.assumptions.fxRates ?? []) table.set(fxPairKey(r.from, r.to), r);
  for (const c of countries) {
    const cur = COUNTRY_TAX_CURRENCY[c];
    if (!cur || cur === base || ctx.fx.has(cur)) continue;
    const pair = table.get(fxPairKey(cur, base));
    if (!pair) {
      ctx.residency!.fxMissing.add(cur);
      continue;
    }
    if (pair.from === cur) ctx.fx.set(cur, { rate: pair.rate, drift: pair.annualDrift });
    else ctx.fx.set(cur, { rate: 1 / pair.rate, drift: 1 / (1 + pair.annualDrift) - 1 });
  }
}

/** A person's residence changes: [effective month, location], sorted; the first is the base. */
export function residenceTimeline(
  ctx: EngineContext,
  personId: string,
): { from: number; location: Location }[] {
  const out: { from: number; location: Location; order: number }[] = [
    { from: Number.NEGATIVE_INFINITY, location: ctx.household.location, order: 0 },
  ];
  let order = 1;
  for (const st of ctx.milestones.values()) {
    if (!st.def.enabled || typeof st.month !== "number") continue;
    for (const e of st.def.effects) {
      if (e.kind !== "relocate" || (e.personId && e.personId !== personId)) continue;
      // Milestone effects apply from the first period starting at or after the milestone month.
      const m = st.month;
      const p = ctx.periods.find((b) => b.start >= m);
      const from = m <= ctx.start ? ctx.start : p ? p.start : Number.POSITIVE_INFINITY;
      out.push({ from, location: e.location, order: order++ });
    }
  }
  for (const r of ctx.plan.residency ?? []) {
    if (r.personId && r.personId !== personId) continue;
    const m = resolveRef(ctx, r.from);
    if (typeof m !== "number") continue;
    out.push({ from: Math.max(m, ctx.start), location: r.location, order: order++ });
  }
  out.sort((a, b) => a.from - b.from || a.order - b.order);
  return out.map(({ from, location }) => ({ from, location }));
}

/** Residence of a person at month m. */
export function residenceAt(ctx: EngineContext, personId: string, m: MonthIndex): Location {
  let loc = ctx.household.location;
  for (const t of residenceTimeline(ctx, personId)) if (t.from <= m) loc = t.location;
  return loc;
}

/** Residence segments of a person inside [from, to). */
export function segmentsIn(
  ctx: EngineContext,
  personId: string,
  from: MonthIndex,
  to: MonthIndex,
): ResidenceSegment[] {
  const tl = residenceTimeline(ctx, personId);
  const out: ResidenceSegment[] = [];
  for (let i = 0; i < tl.length; i++) {
    const s = Math.max(from, tl[i]!.from);
    const e = Math.min(to, i + 1 < tl.length ? tl[i + 1]!.from : Number.POSITIVE_INFINITY);
    if (e <= s) continue;
    const last = out[out.length - 1];
    if (last && sameLocation(last.location, tl[i]!.location)) last.to = e;
    else out.push({ from: s, to: e, location: tl[i]!.location });
  }
  return out;
}

export function sameLocation(a: Location, b: Location): boolean {
  return (
    a.country === b.country &&
    (a.region ?? "") === (b.region ?? "") &&
    (a.locality ?? "") === (b.locality ?? "")
  );
}

/** First month (after `before`) from which the person stops being resident in `country`, or null. */
export function lastDeparture(
  ctx: EngineContext,
  personId: string,
  country: string,
  before: MonthIndex,
): MonthIndex | null {
  const tl = residenceTimeline(ctx, personId);
  let left: MonthIndex | null = null;
  for (let i = 1; i < tl.length; i++) {
    const t = tl[i]!;
    if (t.from > before) break;
    if (tl[i - 1]!.location.country === country && t.location.country !== country) left = t.from;
    if (t.location.country === country) left = null;
  }
  if (left === null && tl.length > 0 && tl[tl.length - 1]!.from <= before) {
    // Already abroad at the plan start: the last past residence in `country` (residence history).
    const person = ctx.household.people.find((p) => p.id === personId);
    const cur = residenceAt(ctx, personId, before);
    if (cur.country !== country)
      for (const h of person?.residenceHistory ?? [])
        if (h.country === country && h.to) left = Math.max(left ?? -Infinity, parseMonth(h.to) + 1);
  }
  return left;
}

/** Period open: residence segments, the effective location / stack, exit and arrival effects. */
export function openResidencyPeriod(ctx: EngineContext, ps: PeriodState): void {
  const st = ctx.residency;
  if (!st?.active) return;
  ps.crossBorder = true;
  ps.itemInfo = new Map();
  const { start, end } = ps.bounds;
  const residence = new Map<string, ResidenceSegment[]>();
  for (const p of ctx.people) residence.set(p.id, segmentsIn(ctx, p.id, start, end));
  ps.residence = residence;
  const primary = ctx.people.find((p) => p.role === "primary") ?? ctx.people[0]!;
  const loc = residence.get(primary.id)?.[0]?.location ?? ctx.household.location;
  ps.location = loc;
  const config =
    loc.country === ctx.household.location.country
      ? ps.tax
      : { ...ps.tax, jurisdictions: [] as string[] };
  try {
    ps.stack = ctx.registry.resolveStack(config, loc);
  } catch {
    ps.stack = [];
    warnOnce(ctx, `no-preset:${loc.country}`, {
      code: "ASSUMPTION",
      severity: "warning",
      message: `Glideworth has no tax preset for ${loc.country}: income tax there is not included while you live there.`,
      periodIndex: ps.bounds.index,
      refs: [],
    });
  }
  for (const p of ctx.people) exitAndArrival(ctx, ps, p.id);
}

function taxableAccountsOf(
  ctx: EngineContext,
  personId: string,
): { a: AccountState; share: number }[] {
  const couple = ctx.people.length > 1;
  const out: { a: AccountState; share: number }[] = [];
  for (const a of ctx.accounts) {
    if (a.info.taxTreatment !== "taxable" || a.category === "cash" || a.costBasis === null)
      continue;
    if (a.opensAt !== null && a.opensAt > ctx.start) continue;
    const share = a.owner === personId ? 1 : a.owner === "joint" ? (couple ? 0.5 : 1) : 0;
    if (share > 0) out.push({ a, share });
  }
  return out;
}

function ukResidentYearsBefore(
  ctx: EngineContext,
  personId: string,
  left: MonthIndex,
  years: number,
): number {
  // Tax years (6 April) before the year of departure in which the person was UK resident.
  const person = ctx.household.people.find((p) => p.id === personId);
  const leftYear = yearOf(left) - (left % 12 < 3 ? 1 : 0);
  let n = 0;
  for (let y = leftYear - years; y < leftYear; y++) {
    const m = y * 12 + 3; // April of tax year y
    let resident: boolean;
    if (m >= ctx.start) resident = residenceAt(ctx, personId, m).country === "GB";
    else {
      const hist = person?.residenceHistory;
      if (!hist || hist.length === 0) resident = ctx.household.location.country === "GB";
      else
        resident = hist.some(
          (h) => h.country === "GB" && parseMonth(h.from) <= m && (!h.to || parseMonth(h.to) >= m),
        );
    }
    if (resident) n++;
  }
  return n;
}

function exitAndArrival(ctx: EngineContext, ps: PeriodState, personId: string): void {
  const st = ctx.residency!;
  const tl = residenceTimeline(ctx, personId);
  const { start, end } = ps.bounds;
  const settings = ctx.plan.tax.crossBorder ?? {};
  for (let i = 1; i < tl.length; i++) {
    const prev = tl[i - 1]!.location.country;
    const next = tl[i]!.location.country;
    const at = tl[i]!.from;
    if (prev === next || !Number.isFinite(at)) continue;
    // Departure: the last month resident in `prev` (at - 1) falls in this period.
    if (at > start && at <= end && at > ctx.start) {
      const key = `${personId}|${at}|exit`;
      if (!st.applied.has(key)) {
        st.applied.add(key);
        departure(ctx, ps, personId, prev, at, settings.departureTax ?? "apply");
        if (prev === "GB" && (settings.ukTemporaryNonResidence ?? true)) {
          const r = NON_RESIDENT_RULES.GB!.temporaryNonResidence!;
          const eligible =
            ukResidentYearsBefore(ctx, personId, at, r.ofYears) >= r.priorResidentYears;
          st.ukAbsence.set(personId, { left: at, eligible, gains: 0 });
        }
      }
    }
    // Arrival in this period.
    if (at >= start && at < end) {
      const key = `${personId}|${at}|arrive`;
      if (st.applied.has(key)) continue;
      st.applied.add(key);
      if (NON_RESIDENT_RULES[next]?.arrivalRebasing && at > ctx.start) {
        let stepped = 0;
        for (const { a, share } of taxableAccountsOf(ctx, personId)) {
          const gain = Math.max(0, a.balance - a.costBasis!) * share;
          a.costBasis! += gain;
          stepped += gain;
        }
        if (stepped > 0)
          traceEvent(
            ctx,
            ps,
            "tax",
            "ARRIVAL_REBASING",
            () =>
              `Arrival in ${next}: investments rebased to market value (${stepped.toFixed(2)} of gains never taxed there)`,
            [personId],
            { country: next, amount: stepped },
          );
      }
      if (next === "GB") {
        const abs = st.ukAbsence.get(personId);
        if (abs) {
          st.ukAbsence.delete(personId);
          const r = NON_RESIDENT_RULES.GB!.temporaryNonResidence!;
          const within = at - abs.left <= r.maxYears * 12;
          if (abs.eligible && within && abs.gains > 1e-9) {
            ps.taxIncome.push({
              sourceId: `tnr:${personId}`,
              owner: personId,
              character: "capital-gains-long",
              amount: abs.gains,
              exemptIn: [],
              pin: { country: "GB", basis: "return" },
            });
            traceEvent(
              ctx,
              ps,
              "tax",
              "UK_TEMPORARY_NON_RESIDENCE",
              () =>
                `Back in the UK within ${r.maxYears} years (left ${formatMonth(abs.left)}): ${abs.gains.toFixed(2)} of gains realised abroad are taxed this year`,
              [personId],
              { gains: abs.gains, left: formatMonth(abs.left), returned: formatMonth(at) },
            );
          }
        }
      }
    }
  }
}

function departure(
  ctx: EngineContext,
  ps: PeriodState,
  personId: string,
  country: string,
  at: MonthIndex,
  mode: "apply" | "defer",
): void {
  const rule = NON_RESIDENT_RULES[country]?.departure;
  if (!rule || mode === "defer") return;
  let gain = 0;
  for (const { a, share } of taxableAccountsOf(ctx, personId)) {
    const g = Math.max(0, a.balance - a.costBasis!) * share;
    if (!(g > 0)) continue;
    gain += g;
    a.costBasis! += g;
  }
  if (!(gain > 1e-9)) return;
  const item: TaxIncomeItem = {
    sourceId: `departure:${personId}`,
    owner: personId,
    character: "capital-gains-long",
    amount: gain,
    exemptIn: [],
    pin: { country, basis: "exit" },
  };
  ps.taxIncome.push(item);
  traceEvent(
    ctx,
    ps,
    "tax",
    "DEPARTURE_TAX",
    () =>
      `Leaving ${country} in ${formatMonth(at)}: investments are deemed sold (${gain.toFixed(2)} of gains taxed in ${country}; cost basis stepped up)`,
    [personId],
    { country, gain },
  );
}

/**
 * Period close (after the settle converged): remember UK temporary non-residence gains and the
 * contribution basis of tax-free wrappers.
 */
export function closeResidencyPeriod(ctx: EngineContext, ps: PeriodState): void {
  const st = ctx.residency;
  if (!st?.active) return;
  for (const [pid, abs] of st.ukAbsence) {
    if (!abs.eligible || ps.bounds.start - abs.left > 5 * 12) continue;
    const segs = ps.residence?.get(pid) ?? [];
    const months = segs
      .filter((s) => s.location.country !== "GB")
      .reduce((s, x) => s + (x.to - x.from), 0);
    if (months <= 0) continue;
    const f = months / ps.bounds.months;
    const people = ctx.people.filter((p) => ps.alive[p.id]);
    const share = (owner: string) =>
      owner === pid
        ? 1
        : owner === "joint" || !people.some((p) => p.id === owner)
          ? 1 / Math.max(1, people.length)
          : 0;
    let g = 0;
    for (const it of ps.taxIncome) {
      if (
        it.pin ||
        (it.character !== "capital-gains-long" && it.character !== "capital-gains-short")
      )
        continue;
      if (it.sale) {
        const asset = ctx.assets.find((r) => r.def.id === it.sale!.assetId);
        if ((asset?.def.country ?? ctx.household.location.country) === "GB") continue; // NRCGT already
      }
      g += it.amount * share(it.owner);
    }
    for (const w of ps.taxWithdrawals)
      if (w.treatment === "taxable") g += Math.max(0, w.taxableAmount) * share(w.owner);
    abs.gains += g * f;
  }
  for (const a of ctx.accounts) {
    if (a.info.taxTreatment !== "tax-free") continue;
    const prev = st.wrapperBasis.get(a.def.id) ?? initialWrapperBasis(a);
    const inflow = a.p.contributions + a.p.transfersIn;
    const outflow = a.p.withdrawals + a.p.transfersOut;
    const pool = Math.max(a.p.opening + inflow, 1e-9);
    st.wrapperBasis.set(
      a.def.id,
      Math.max(0, prev + inflow - outflow * Math.min(1, (prev + inflow) / pool)),
    );
  }
}

export function initialWrapperBasis(a: AccountState): number {
  return a.def.contributionBasis ?? a.def.costBasis ?? Math.max(0, a.p.opening);
}

/** Earnings share of a tax-free wrapper's withdrawals (for residence countries that do not recognise it). */
export function wrapperEarningsShare(ctx: EngineContext, a: AccountState): number {
  const basis = ctx.residency?.wrapperBasis.get(a.def.id) ?? initialWrapperBasis(a);
  const value = Math.max(a.p.opening + a.p.contributions + a.p.transfersIn, 1e-9);
  return Math.max(0, Math.min(1, 1 - basis / value));
}

/** People's citizenship includes `country` (default: the household's country). */
export function isNational(ctx: EngineContext, personId: string, country: string): boolean {
  return (
    ctx.residency?.citizenships.get(personId)?.has(country) ??
    ctx.household.location.country === country
  );
}

/**
 * Contribution eligibility of a wrapper while its owner is non-resident in the wrapper's country:
 * the annual limit after the country's non-resident wrapper rule (ISA: none; UK pensions: £3,600
 * gross for 5 tax years after leaving, then none; TFSA/RRSP: none).
 */
export function nonResidentContributionCap(
  ctx: EngineContext,
  ps: PeriodState,
  a: AccountState,
  annual: number,
): number {
  if (!ps.crossBorder || !ps.residence) return annual;
  const country = accountCountryOf(ctx, a);
  const rules = NON_RESIDENT_RULES[country];
  const rule = rules?.wrappers.find((w) => w.accountTypes.includes(a.def.type));
  if (!rule || rule.contributions === "allowed") return annual;
  const owners = a.owner === "joint" ? ctx.people.map((p) => p.id) : [a.owner];
  const residentSome = owners.some((o) =>
    (ps.residence!.get(o) ?? []).some((s) => s.location.country === country),
  );
  if (residentSome) return annual;
  if (rule.contributions === "none") return 0;
  const left = lastDeparture(ctx, owners[0]!, country, ps.bounds.start);
  const years = left === null ? Number.POSITIVE_INFINITY : (ps.bounds.start - left) / 12;
  // Same basis as the country's own limit (UK: compared with the contributions the plan makes).
  if (years < (rule.yearsAfterDeparture ?? 0)) return Math.min(annual, rule.capGross ?? 0);
  return 0;
}

/** Warn once when a tax currency has no FX pair (tax for that country computed without conversion). */
export function warnFxMissing(ctx: EngineContext, currency: string): void {
  warnOnce(ctx, `tax-fx:${currency}`, {
    code: "ASSUMPTION",
    severity: "warning",
    message: `No exchange rate between ${currency} and ${ctx.household.currency}: tax thresholds in ${currency} were applied to ${ctx.household.currency} amounts unconverted. Add a ${currency} rate to the FX table.`,
    periodIndex: null,
    refs: [],
  });
}
