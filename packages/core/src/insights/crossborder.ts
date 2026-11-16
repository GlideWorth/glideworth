/**
 * Cross-border insights: the residency timeline as data for the UI, assumption-audit checks for
 * plans that span countries, the "relocation" what-if template, and the "stay or move" comparison.
 */
import { formatMonth, parseMonth } from "../engine/dates.js";
import { simulate } from "../engine/simulate.js";
import { type ProjectionResult, type SimulationInput, toBasis } from "../engine/types.js";
import { ScenarioError } from "../errors.js";
import { ACCOUNT_TYPE_INFO } from "../schema/account-types.js";
import type { PatchOp, PlanDiff } from "../schema/changes.js";
import type { Location } from "../schema/household.js";
import type { Plan } from "../schema/plan.js";
import type { DateRef } from "../schema/time.js";
import { COUNTRY_TAX_CURRENCY } from "../tax/crossborder/currency.js";
import { countryName } from "../tax/crossborder/explain.js";
import { NON_RESIDENT_RULES } from "../tax/crossborder/nonresident.js";
import { treatyBetween } from "../tax/crossborder/treaties.js";
import { UK_VOLUNTARY_NI, ukIhtWorldwideScope } from "../tax/crossborder/uk.js";
import { ukStatePensionAge } from "../tax/data/uk.js";
import type { Finding } from "./contracts.js";
import { diffPlans } from "./diff.js";
import { fmtMoney } from "./format.js";
import { applyPlanPatch } from "./patch.js";
import type { ScenarioTemplate, TemplateInfo } from "./scenarios.js";

// ------------------------------------------------------------------ timeline

export interface ResidencyStep {
  personId: string;
  /** First month of this residence ('YYYY-MM'); null = from before the plan starts. */
  from: string | null;
  location: Location;
  source: "household" | "residency" | "milestone";
  /** Id of the residency entry or milestone. */
  refId?: string;
}

function finances(input: SimulationInput) {
  const sc = input.plan.startingConditions;
  return sc.kind === "snapshot" ? sc.finances : input.finances;
}

/** Resolve a DateRef statically (dates, ages, plan start; milestones from a result when given). */
function monthOf(input: SimulationInput, ref: DateRef, result?: ProjectionResult): number | null {
  const start = parseMonth(finances(input).asOf);
  switch (ref.kind) {
    case "planStart":
      return start + ref.offsetMonths;
    case "date":
      return parseMonth(ref.date) + ref.offsetMonths;
    case "age": {
      const p = input.household.people.find((x) => x.id === ref.personId);
      return p ? parseMonth(p.birthMonth) + Math.round(ref.age * 12) + ref.offsetMonths : null;
    }
    case "milestone": {
      const m = result?.milestones.find((x) => x.milestoneId === ref.milestoneId);
      return m?.month ? parseMonth(m.month) + ref.offsetMonths : null;
    }
    case "planEnd":
      return result ? parseMonth(result.meta.endMonth) + 1 + ref.offsetMonths : null;
    default:
      return null;
  }
}

/**
 * Each person's residency timeline (household location, then plan entries and relocation
 * milestones in date order). Milestone-bound entries need `result` to be dated.
 */
export function residencyTimelineOf(
  input: SimulationInput,
  result?: ProjectionResult,
): ResidencyStep[] {
  const out: ResidencyStep[] = [];
  for (const p of input.household.people) {
    const steps: (ResidencyStep & { at: number })[] = [];
    for (const r of input.plan.residency ?? []) {
      if (r.personId && r.personId !== p.id) continue;
      const m = monthOf(input, r.from, result);
      if (m === null) continue;
      steps.push({
        personId: p.id,
        from: formatMonth(m),
        location: r.location,
        source: "residency",
        refId: r.id,
        at: m,
      });
    }
    for (const ms of input.plan.milestones) {
      if (!ms.enabled) continue;
      for (const e of ms.effects) {
        if (e.kind !== "relocate" || (e.personId && e.personId !== p.id)) continue;
        const m = result?.milestones.find((x) => x.milestoneId === ms.id)?.month;
        if (!m) continue;
        steps.push({
          personId: p.id,
          from: m,
          location: e.location,
          source: "milestone",
          refId: ms.id,
          at: parseMonth(m),
        });
      }
    }
    steps.sort((a, b) => a.at - b.at);
    out.push({
      personId: p.id,
      from: null,
      location: input.household.location,
      source: "household",
    });
    for (const { at: _at, ...s } of steps) out.push(s);
  }
  return out;
}

function residenceAtMonth(steps: ResidencyStep[], personId: string, m: number): Location | null {
  let loc: Location | null = null;
  for (const s of steps)
    if (s.personId === personId && (s.from === null || parseMonth(s.from) <= m)) loc = s.location;
  return loc;
}

// ------------------------------------------------------------------ audit

function accountCountry(type: string, jurisdiction: string | undefined, base: string): string {
  return (
    jurisdiction ??
    (ACCOUNT_TYPE_INFO as Record<string, { country?: string }>)[type]?.country ??
    base
  );
}

/** Assumption-audit checks for plans that span countries (part of `auditAssumptions`). */
export function crossBorderFindings(input: SimulationInput, result?: ProjectionResult): Finding[] {
  const out: Finding[] = [];
  const { household, plan } = input;
  const fin = finances(input);
  const base = household.location.country;
  const steps = residencyTimelineOf(input, result);
  const residences = new Set(steps.map((s) => s.location.country));
  const moves = steps.filter((s) => s.source !== "household");
  const fx = [...(fin.fxRates ?? []), ...(plan.assumptions.fxRates ?? [])];
  const hasPair = (a: string, b: string) =>
    a === b || fx.some((r) => (r.from === a && r.to === b) || (r.from === b && r.to === a));
  const finding = (
    code: string,
    severity: Finding["severity"],
    title: string,
    message: string,
    refs: string[] = [],
    suggestion?: string,
  ): Finding => ({
    code,
    severity,
    title,
    message,
    periodIndex: null,
    refs,
    evidence: [{ source: "plan" }],
    ...(suggestion ? { suggestion } : {}),
  });
  const start = parseMonth(fin.asOf);
  const foreignItem =
    fin.accounts.some((a) => accountCountry(a.type, a.jurisdiction, base) !== base) ||
    fin.realAssets.some((r) => (r.country ?? base) !== base) ||
    plan.income.some((e) => e.country && e.country !== base);
  const usAbroad = household.people.some(
    (p) => (p.usGreenCard || p.citizenships?.includes("US")) && base !== "US",
  );
  if (moves.length === 0 && !foreignItem && !usAbroad) return out;

  // 1. Assets held in another country than the residence, valued in a currency with no FX rate.
  const multi = residences.size > 1 || moves.length > 0;
  const items: { id: string; name: string; country: string; currency: string | undefined }[] = [
    ...fin.accounts.map((a) => ({
      id: a.id,
      name: a.name,
      country: accountCountry(a.type, a.jurisdiction, base),
      currency: a.currency,
    })),
    ...fin.realAssets.map((r) => ({
      id: r.id,
      name: r.name,
      country: r.country ?? base,
      currency: r.currency,
    })),
  ];
  for (const it of items) {
    if (it.country === base && !multi) continue;
    const local = COUNTRY_TAX_CURRENCY[it.country];
    const cur = it.currency ?? household.currency;
    if (it.country !== base && local && !it.currency && local !== household.currency)
      out.push(
        finding(
          "XB_FOREIGN_ASSET_BASE_CURRENCY",
          "warning",
          `${it.name} is in ${it.country} but valued in ${household.currency}`,
          `${it.name} is held in ${it.country}, where it is normally denominated in ${local}, but has no currency set, so exchange-rate moves are ignored.`,
          [it.id],
          `Set its currency to ${local} and add a ${local}/${household.currency} rate to the FX table.`,
        ),
      );
    else if (!hasPair(cur, household.currency))
      out.push(
        finding(
          "XB_MISSING_FX",
          "critical",
          `No exchange rate for ${it.name}`,
          `${it.name} is in ${cur} but the FX table has no ${cur}/${household.currency} rate.`,
          [it.id],
        ),
      );
  }
  for (const c of residences) {
    const cur = COUNTRY_TAX_CURRENCY[c];
    if (cur && !hasPair(cur, household.currency))
      out.push(
        finding(
          "XB_TAX_FX_MISSING",
          "warning",
          `No ${cur} exchange rate for ${c} taxes`,
          `Taxes while living in ${c} are computed in ${cur}, but the FX table has no ${cur}/${household.currency} rate: thresholds would be applied unconverted.`,
          [],
          `Add a ${cur}/${household.currency} rate.`,
        ),
      );
  }

  // 2. Contributions planned into a wrapper that non-residents cannot fund.
  for (const f of plan.flows) {
    if (f.kind !== "contribution" || !f.enabled) continue;
    const acc = [...fin.accounts, ...plan.plannedAccounts].find((a) => a.id === f.accountId);
    if (!acc) continue;
    const country = accountCountry(acc.type, acc.jurisdiction, base);
    const rule = NON_RESIDENT_RULES[country]?.wrappers.find((w) =>
      w.accountTypes.includes(acc.type),
    );
    if (!rule || rule.contributions === "allowed") continue;
    const owner = acc.owner === "joint" ? (household.people[0]?.id ?? "") : acc.owner;
    const leaves = steps.some(
      (s) => s.personId === owner && s.source !== "household" && s.location.country !== country,
    );
    const abroadNow = residenceAtMonth(steps, owner, start)?.country !== country;
    if (!leaves && !abroadNow) continue;
    out.push(
      finding(
        "XB_WRAPPER_NON_RESIDENT_CONTRIBUTIONS",
        "warning",
        `${acc.name} cannot be funded while living abroad`,
        `${rule.note} The flow "${f.name}" is capped while its owner lives outside ${country}; the rest goes down the waterfall.`,
        [f.id, acc.id],
        "End the flow at the move, or redirect it to an account in your new country.",
      ),
    );
  }

  // 3. Returning to the UK within the temporary non-residence window.
  for (const p of household.people) {
    const mine = steps.filter((s) => s.personId === p.id);
    for (let i = 1; i < mine.length; i++) {
      const leave = mine[i]!;
      if (mine[i - 1]!.location.country !== "GB" || leave.location.country === "GB" || !leave.from)
        continue;
      const back = mine.slice(i + 1).find((s) => s.location.country === "GB");
      if (!back?.from) continue;
      const months = parseMonth(back.from) - parseMonth(leave.from);
      const rule = NON_RESIDENT_RULES.GB!.temporaryNonResidence!;
      if (months > rule.maxYears * 12) continue;
      const gains = result?.periods.some(
        (x) =>
          parseMonth(x.startMonth) >= parseMonth(leave.from!) &&
          parseMonth(x.startMonth) < parseMonth(back.from!) &&
          x.accounts.some((a) => a.withdrawals > 0 && a.category === "taxable"),
      );
      out.push(
        finding(
          "XB_UK_TEMPORARY_NON_RESIDENCE",
          gains ? "warning" : "info",
          `${p.name} returns to the UK within ${rule.maxYears} years`,
          `${p.name} leaves the UK in ${leave.from} and returns in ${back.from} (${(months / 12).toFixed(1)} years). Gains realised while abroad on assets held before leaving are taxed in the UK in the year of return.${gains ? " This plan sells taxable investments while abroad." : ""}`,
          [p.id],
          "Stay abroad for more than five full years before selling, or realise gains before leaving.",
        ),
      );
    }
  }

  // 4. UK State Pension qualifying years gap and voluntary contributions.
  for (const p of household.people) {
    const rec = p.statePensionRecords?.find((r) => r.country === "GB");
    const leavesUk =
      steps.some((s) => s.personId === p.id && s.location.country !== "GB") &&
      (base === "GB" || rec);
    if (!rec || !leavesUk) continue;
    const [by, bm] = p.birthMonth.split("-").map(Number) as [number, number];
    const spa = ukStatePensionAge(by, bm);
    const spaMonth = parseMonth(p.birthMonth) + Math.round(spa * 12);
    const asOf = rec.asOf ? parseMonth(rec.asOf) : start;
    const ukMonths = (() => {
      let m = 0;
      for (let t = asOf; t < spaMonth; t += 12)
        if (residenceAtMonth(steps, p.id, t)?.country === "GB") m += 12;
      return m;
    })();
    const voluntary = rec.voluntaryYears ?? 0;
    const projected = rec.qualifyingYears + Math.floor(ukMonths / 12) + voluntary;
    const gap = UK_VOLUNTARY_NI.fullRateYears - projected;
    if (gap <= 0) continue;
    const eligible = rec.qualifyingYears >= UK_VOLUNTARY_NI.minYearsResidenceOrContributions;
    const cost = UK_VOLUNTARY_NI.class3Weekly * 52;
    out.push(
      finding(
        "XB_STATE_PENSION_GAP",
        "info",
        `${p.name}: ${gap} qualifying year${gap === 1 ? "" : "s"} short of a full UK State Pension`,
        `${p.name} has ${rec.qualifyingYears} qualifying years and would reach about ${projected} by State Pension age (${spa}) at the planned UK residence${voluntary ? ` (including ${voluntary} voluntary year${voluntary === 1 ? "" : "s"})` : ""}; ${UK_VOLUNTARY_NI.fullRateYears} give the full new State Pension. ${eligible ? `Voluntary Class 3 contributions from abroad cost about ${fmtMoney(cost, { currency: "GBP", locale: "en-GB" })} a year (${UK_VOLUNTARY_NI.year}); each year adds about 1/35 of the full pension.` : `Paying voluntary contributions from abroad needs ${UK_VOLUNTARY_NI.minYearsResidenceOrContributions} years of UK residence or contributions (from 2026-27).`}`,
        [p.id],
        eligible
          ? "Check your forecast on gov.uk and consider voluntary Class 3 contributions (add them as an expense)."
          : undefined,
      ),
    );
  }

  // 5. Country pairs without a treaty in Glideworth's tables.
  const sources = new Set(items.map((i) => i.country));
  for (const e of plan.income) if (e.country) sources.add(e.country);
  for (const r of residences)
    for (const s of sources)
      if (r !== s && NON_RESIDENT_RULES[s] && !treatyBetween(r, s))
        out.push(
          finding(
            "XB_UNKNOWN_TREATY",
            "warning",
            r === "XX"
              ? `No treaty data for ${countryName(s)} while living somewhere else`
              : `No ${countryName(r)}-${countryName(s)} treaty in Glideworth's tables`,
            `While living ${r === "XX" ? "somewhere else (no country set)" : `in ${countryName(r)}`} with income or assets in ${countryName(s)}, Glideworth taxes under both countries' own rules and credits the ${countryName(s)} tax where you live. A real treaty may allocate taxing rights differently.`,
            [],
          ),
        );
  return out;
}

// ------------------------------------------------------------------ inheritance tax scope

/** UK IHT scope (worldwide assets or UK assets only) for a person in tax year `taxYear`. */
export function ukInheritanceTaxScope(
  input: SimulationInput,
  personId: string,
  taxYear: number,
  result?: ProjectionResult,
): { inScope: boolean; reason: string } {
  const steps = residencyTimelineOf(input, result);
  const person = input.household.people.find((p) => p.id === personId);
  if (!person) throw new ScenarioError(`unknown person '${personId}'`, { personId });
  const years = new Set<number>();
  const start = parseMonth(finances(input).asOf);
  const firstYear = Math.min(taxYear - 40, Number(person.birthMonth.slice(0, 4)));
  for (let y = firstYear; y <= taxYear; y++) {
    const m = y * 12 + 3;
    let gb: boolean;
    if (m >= start) gb = residenceAtMonth(steps, personId, m)?.country === "GB";
    else if (person.residenceHistory?.length)
      gb = person.residenceHistory.some(
        (h) => h.country === "GB" && parseMonth(h.from) <= m && (!h.to || parseMonth(h.to) >= m),
      );
    else gb = input.household.location.country === "GB" && m >= parseMonth(person.birthMonth);
    if (gb) years.add(y);
  }
  return ukIhtWorldwideScope(years, taxYear);
}

// ------------------------------------------------------------------ relocation template

/**
 * Cross-border what-if templates (kept apart from `WHAT_IF_TEMPLATES` until the API registers a
 * parameter schema for each; see docs/STATUS.md hand-off).
 */
export const CROSS_BORDER_TEMPLATES: TemplateInfo[] = [
  { id: "relocation", title: "Move country", params: ["to", "month", "returnMonth", "personId"] },
];

/**
 * "Move from here to `to` in `month` (optionally back home in `returnMonth`)" as residency entries.
 * Accounts and income keep their countries; end or add income events for the new country yourself.
 */
export function relocationScenario(
  input: SimulationInput,
  opts: { to: Location; month: string; returnMonth?: string; personId?: string },
): ScenarioTemplate {
  const from = input.household.location;
  const who = opts.personId
    ? input.household.people.find((p) => p.id === opts.personId)
    : undefined;
  if (opts.personId && !who)
    throw new ScenarioError(`unknown person '${opts.personId}'`, { personId: opts.personId });
  const id = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 64);
  const entry = (m: string, location: Location, tag: string) => ({
    id: id(`move-${tag}-${location.country}-${m}`),
    ...(opts.personId ? { personId: opts.personId } : {}),
    from: { kind: "date", date: m, offsetMonths: 0 },
    location,
  });
  const entries = [
    entry(opts.month, opts.to, "out"),
    ...(opts.returnMonth ? [entry(opts.returnMonth, from, "back")] : []),
  ];
  const patch: PatchOp[] = input.plan.residency
    ? entries.map((value) => ({ op: "add", path: "/residency/-", value }))
    : [{ op: "add", path: "/residency", value: entries }];
  const notes: string[] = [
    "Accounts, property and pensions keep their country: the old country may still tax income from them (non-resident rules) and the new one taxes you on worldwide income, with a credit for double tax.",
    "Pay is taxed where it is earned: end salaries at the move and add income for the new country.",
    "Set exchange rates for the new country's currency in the FX table.",
  ];
  const outRules = NON_RESIDENT_RULES[from.country];
  if (outRules?.departure) notes.push(`${outRules.label}: ${outRules.departure.note}`);
  if (from.country === "GB" && opts.returnMonth)
    notes.push(NON_RESIDENT_RULES.GB!.temporaryNonResidence!.note);
  if (!treatyBetween(from.country, opts.to.country))
    notes.push(
      `No ${from.country}-${opts.to.country} treaty is in Glideworth's tables: credit method with a warning.`,
    );
  return {
    id: id(`relocate-${opts.to.country}-${opts.month}`),
    title: `${who ? `${who.name} moves` : "Move"} to ${opts.to.country} in ${opts.month}${opts.returnMonth ? `, back in ${opts.returnMonth}` : ""}`,
    description: `Tax residence moves from ${from.country} to ${opts.to.country} in ${opts.month}${opts.returnMonth ? ` and back to ${from.country} in ${opts.returnMonth}` : ""}.`,
    patch,
    notes,
  };
}

// ------------------------------------------------------------------ stay or move

export interface StayOrMove {
  stay: ProjectionResult;
  move: ProjectionResult;
  diff: PlanDiff;
  /** Change (move minus stay) of the headline outcomes, in today's money. */
  deltas: {
    endNetWorthReal: number;
    lifetimeTaxesReal: number;
    totalShortfallReal: number;
    success: boolean;
  };
  /** Lifetime taxes in today's money by country and basis (residence, source, relief...). */
  taxesByCountry: { country: string; basis: string; stay: number; move: number; delta: number }[];
  /** Plain-language attribution of the difference. */
  attribution: { label: string; delta: number }[];
}

function taxesByCountry(r: ProjectionResult, home: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const p of r.periods) {
    const rows = p.taxes.byCountry ?? [
      { country: home, basis: "residence", amount: p.taxes.total },
    ];
    for (const b of rows) {
      const k = `${b.country}|${b.basis}`;
      out.set(k, (out.get(k) ?? 0) + toBasis(b.amount, p, "real", "flow"));
    }
  }
  return out;
}

/**
 * Compare staying with moving: simulates the plan as is and with `relocationScenario(opts)` (or a
 * given `movePlan`), and returns the plan diff, headline deltas, taxes by country and an
 * attribution of the difference (tax by country, spending, everything else).
 */
export function compareStayingVersusMoving(
  input: SimulationInput,
  opts:
    | { to: Location; month: string; returnMonth?: string; personId?: string }
    | { movePlan: Plan },
): StayOrMove {
  const movePlan =
    "movePlan" in opts
      ? opts.movePlan
      : applyPlanPatch(input.plan, relocationScenario(input, opts).patch);
  const stay = simulate(input);
  const move = simulate({ ...input, plan: movePlan });
  const diff = diffPlans(input.plan, movePlan);
  return summariseStayOrMove(stay, move, diff, input.household.location.country);
}

/**
 * The comparison part of `compareStayingVersusMoving`, from two results already computed (the web
 * runs both simulations in a worker and summarises on the main thread).
 */
export function summariseStayOrMove(
  stay: ProjectionResult,
  move: ProjectionResult,
  diff: PlanDiff,
  home: string,
): StayOrMove {
  const a = taxesByCountry(stay, home);
  const b = taxesByCountry(move, home);
  const keys = new Set([...a.keys(), ...b.keys()]);
  const rows = [...keys].map((k) => {
    const [country, basis] = k.split("|") as [string, string];
    const s = a.get(k) ?? 0;
    const m = b.get(k) ?? 0;
    return { country, basis, stay: s, move: m, delta: m - s };
  });
  rows.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
  const realSum = (r: ProjectionResult, f: (p: ProjectionResult["periods"][number]) => number) =>
    r.periods.reduce((s, p) => s + toBasis(f(p), p, "real", "flow"), 0);
  const dNw = move.summary.endNetWorthReal - stay.summary.endNetWorthReal;
  const dTax = move.summary.lifetimeTaxesReal - stay.summary.lifetimeTaxesReal;
  const dSpend = realSum(move, (p) => p.totals.expenses) - realSum(stay, (p) => p.totals.expenses);
  const attribution = [
    ...rows
      .filter((r) => Math.abs(r.delta) > 0.5)
      .map((r) => ({ label: `${r.country} tax (${r.basis})`, delta: -r.delta })),
    { label: "Spending and other outflows", delta: -dSpend },
    { label: "Growth, exchange rates and timing", delta: dNw + dTax + dSpend },
  ];
  return {
    stay,
    move,
    diff,
    deltas: {
      endNetWorthReal: dNw,
      lifetimeTaxesReal: dTax,
      totalShortfallReal:
        realSum(move, (p) => p.totals.shortfall) - realSum(stay, (p) => p.totals.shortfall),
      success: move.summary.success,
    },
    taxesByCountry: rows,
    attribution,
  };
}
