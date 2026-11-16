/**
 * Cross-border plans: the residency timeline (plan entries, relocation milestones, each person's
 * history), the per-person cross-border profile (citizenships, US green card, past residence,
 * state-pension records), "how is this item taxed and why", stay-or-move, tax by country and
 * basis, and the read-only rule tables (non-resident rules, treaties, wrapper recognition).
 *
 * Validation here explains itself: every error names the field, what was wrong and what to do.
 */
import {
  ACCOUNT_TYPE_INFO,
  ACCOUNT_TYPES,
  type AccountType,
  COUNTRY_TAX_CURRENCY,
  CURRENCY_PEGS,
  crossBorderItems,
  crossBorderSimplificationsFor,
  explainCrossBorderTreatment,
  explainItemTaxation,
  type Household,
  INCOME_CATEGORIES,
  type IncomeCategory,
  NON_RESIDENT_RULES,
  PastResidence,
  type Person,
  type Plan,
  type ResidencyChange,
  residencyTimelineOf,
  StatePensionRecord,
  TAX_BASIS_LABEL,
  TREATIES,
  taxByCountry,
  treatyBetween,
  treatyRule,
  type ValueBasis,
  WRAPPER_RECOGNITION,
  wrapperView,
} from "@glideworth/core";
import { z } from "zod";
import { ApiError } from "../errors.js";
import { outcomeOf, roundMoney } from "../views.js";
import type { ServiceCtx } from "./context.js";
import type { HouseholdsService } from "./households.js";
import type { PlansService } from "./plans.js";
import type { SimulationService } from "./simulation.js";

const Month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "a month as YYYY-MM");
const Country = z
  .string()
  .regex(/^[A-Za-z]{2}$/, "a two-letter ISO country code, e.g. GB, AE, US")
  .transform((s) => s.toUpperCase());

/** The cross-border fields of one person, read and written as a unit. */
export const PersonCrossBorder = z
  .object({
    citizenships: z
      .array(Country)
      .max(5)
      .optional()
      .describe("ISO alpha-2 codes. Absent = a citizen of the household country only."),
    usGreenCard: z
      .boolean()
      .optional()
      .describe("Holds a US green card (taxed like a US citizen)."),
    residenceHistory: z
      .array(PastResidence)
      .max(40)
      .optional()
      .describe(
        "Tax residence before the plan starts, oldest first; only the last entry may have no `to`.",
      ),
    statePensionRecords: z
      .array(StatePensionRecord)
      .max(10)
      .optional()
      .describe("Qualifying years per state pension scheme, with planned voluntary years."),
  })
  .meta({ id: "PersonCrossBorder" });
export type PersonCrossBorder = z.infer<typeof PersonCrossBorder>;

export const StayOrMoveRequest = z
  .object({
    to: z
      .object({ country: Country, region: z.string().max(10).optional() })
      .optional()
      .describe(
        "Where to move (with `month`). Omit when comparing with an existing plan (`movePlanId`).",
      ),
    month: Month.optional().describe("First month living in the new country."),
    returnMonth: Month.optional().describe("Optional: first month back home."),
    personId: z.string().max(64).optional().describe("Who moves (default: everyone)."),
    movePlanId: z
      .string()
      .max(64)
      .optional()
      .describe("Compare with this plan (e.g. a relocation branch) instead of building a move."),
    basis: z.enum(["real", "nominal"]).default("real"),
  })
  .meta({ id: "StayOrMoveRequest" });

const ym = (s: string) => {
  const [y, m] = s.split("-").map(Number) as [number, number];
  return y * 12 + m - 1;
};

export class CrossBorderService {
  constructor(
    private readonly ctx: ServiceCtx,
    private readonly plans: PlansService,
    private readonly households: HouseholdsService,
    private readonly sim: SimulationService,
  ) {}

  // ----------------------------------------------------------------------------- validation
  /**
   * Check residency entries against the household and plan. Throws a 400 whose message says what
   * is wrong and how to fix it (unknown person, a move before the plan start, an unknown
   * milestone, two moves for the same person in the same month).
   */
  checkResidency(
    plan: Pick<Plan, "milestones">,
    household: Household,
    asOf: string,
    entries: ResidencyChange[],
  ) {
    const people = household.people.map((p) => p.id);
    const seen = new Map<string, string>();
    for (const [i, r] of entries.entries()) {
      const at = `residency[${i}] ('${r.id}')`;
      if (r.personId && !people.includes(r.personId))
        throw new ApiError(
          400,
          "VALIDATION",
          `${at}: personId '${r.personId}' is not a person in this household. Use one of ${people.map((p) => `'${p}'`).join(", ")}, or omit personId to move everyone.`,
          { field: `residency.${i}.personId`, validPersonIds: people },
        );
      const f = r.from;
      if (f.kind === "date" && ym(f.date) + f.offsetMonths < ym(asOf))
        throw new ApiError(
          400,
          "VALIDATION",
          `${at}: the move is dated ${f.date}, before the plan starts (${asOf}). Residence before the plan belongs in the person's residence history (PUT /households/{id}/people/{personId}/cross-border), or set the household location to where you live now.`,
          { field: `residency.${i}.from`, planStart: asOf },
        );
      if (f.kind === "milestone" && !plan.milestones.some((m) => m.id === f.milestoneId))
        throw new ApiError(
          400,
          "VALIDATION",
          `${at}: milestone '${f.milestoneId}' does not exist in this plan. Use one of ${plan.milestones.map((m) => `'${m.id}'`).join(", ") || "(none)"}, or date the move.`,
          {
            field: `residency.${i}.from.milestoneId`,
            validMilestoneIds: plan.milestones.map((m) => m.id),
          },
        );
      if (f.kind === "age" && !people.includes(f.personId))
        throw new ApiError(
          400,
          "VALIDATION",
          `${at}: the age-based date refers to person '${f.personId}', who is not in this household (${people.join(", ")}).`,
          { field: `residency.${i}.from.personId`, validPersonIds: people },
        );
      if (f.kind === "date") {
        const key = `${r.personId ?? "*"}|${ym(f.date) + f.offsetMonths}`;
        const prev = seen.get(key);
        if (prev)
          throw new ApiError(
            400,
            "VALIDATION",
            `${at}: ${r.personId ? `'${r.personId}'` : "the household"} already moves in ${f.date} (entry '${prev}'). Edit that entry instead of adding a second move in the same month.`,
            { field: `residency.${i}.from`, conflictsWith: prev },
          );
        seen.set(key, r.id);
      }
    }
  }

  /** Check a person's cross-border profile (dates in order, no overlaps, one record per scheme). */
  checkPersonProfile(
    p: PersonCrossBorder,
    person: Pick<Person, "birthMonth" | "name">,
    asOf: string,
  ) {
    const h = p.residenceHistory ?? [];
    for (const [i, r] of h.entries()) {
      if (r.to && ym(r.to) < ym(r.from))
        throw new ApiError(
          400,
          "VALIDATION",
          `residenceHistory[${i}]: ends (${r.to}) before it starts (${r.from}). Swap the dates.`,
          { field: `residenceHistory.${i}.to` },
        );
      if (ym(r.from) < ym(person.birthMonth))
        throw new ApiError(
          400,
          "VALIDATION",
          `residenceHistory[${i}]: starts in ${r.from}, before ${person.name} was born (${person.birthMonth}).`,
          { field: `residenceHistory.${i}.from` },
        );
      if (ym(r.from) > ym(asOf))
        throw new ApiError(
          400,
          "VALIDATION",
          `residenceHistory[${i}]: starts in ${r.from}, after the plan starts (${asOf}). Future moves belong in the plan's residency timeline (POST /plans/{id}/residency).`,
          { field: `residenceHistory.${i}.from` },
        );
      const next = h[i + 1];
      if (next) {
        if (!r.to)
          throw new ApiError(
            400,
            "VALIDATION",
            `residenceHistory[${i}]: only the most recent entry may have no end date; set 'to' (the month before ${next.from}).`,
            { field: `residenceHistory.${i}.to` },
          );
        if (ym(next.from) <= ym(r.to))
          throw new ApiError(
            400,
            "VALIDATION",
            `residenceHistory[${i + 1}]: starts in ${next.from}, overlapping the previous entry (to ${r.to}). List entries oldest first without overlaps.`,
            { field: `residenceHistory.${i + 1}.from` },
          );
      }
    }
    const schemes = new Set<string>();
    for (const [i, r] of (p.statePensionRecords ?? []).entries()) {
      if (schemes.has(r.country))
        throw new ApiError(
          400,
          "VALIDATION",
          `statePensionRecords[${i}]: there is already a record for ${r.country}; keep one record per country.`,
          { field: `statePensionRecords.${i}.country` },
        );
      schemes.add(r.country);
    }
    const c = p.citizenships ?? [];
    if (new Set(c).size !== c.length)
      throw new ApiError(400, "VALIDATION", "citizenships: each country may appear once.", {
        field: "citizenships",
      });
  }

  // ----------------------------------------------------------------------------- person profile
  getPersonProfile(
    householdId: string,
    personId: string,
  ): PersonCrossBorder & { personId: string } {
    const rec = this.households.get(householdId);
    const p = rec.household.people.find((x) => x.id === personId);
    if (!p)
      throw new ApiError(404, "NOT_FOUND", `person '${personId}' not found`, {
        validPersonIds: rec.household.people.map((x) => x.id),
      });
    return {
      personId,
      ...(p.citizenships ? { citizenships: p.citizenships } : {}),
      ...(p.usGreenCard !== undefined ? { usGreenCard: p.usGreenCard } : {}),
      ...(p.residenceHistory ? { residenceHistory: p.residenceHistory } : {}),
      ...(p.statePensionRecords ? { statePensionRecords: p.statePensionRecords } : {}),
    };
  }

  /** Replace (PUT) or merge (PATCH) a person's cross-border profile. */
  setPersonProfile(
    householdId: string,
    personId: string,
    body: unknown,
    mode: "replace" | "merge",
    expected?: number,
  ) {
    const rec = this.households.get(householdId);
    const p = rec.household.people.find((x) => x.id === personId);
    if (!p)
      throw new ApiError(404, "NOT_FOUND", `person '${personId}' not found`, {
        validPersonIds: rec.household.people.map((x) => x.id),
      });
    const parsed = PersonCrossBorder.parse(body);
    const current = this.getPersonProfile(householdId, personId);
    const next: PersonCrossBorder = mode === "merge" ? { ...current, ...parsed } : { ...parsed };
    this.checkPersonProfile(next, p, rec.finances.asOf);
    // Explicit nulls in a replace: absent fields are removed.
    const patch: Record<string, unknown> = {
      citizenships: next.citizenships ?? null,
      usGreenCard: next.usGreenCard ?? null,
      residenceHistory: next.residenceHistory ?? null,
      statePensionRecords: next.statePensionRecords ?? null,
    };
    const out = this.households.updatePerson(householdId, personId, patch, expected);
    return { profile: this.getPersonProfile(householdId, personId), version: out.record.version };
  }

  // ----------------------------------------------------------------------------- timeline
  timeline(planId: string) {
    const { input, plan } = this.sim.inputFor(planId, { trace: "off" });
    let result: ReturnType<SimulationService["projection"]>["result"] | undefined;
    try {
      result = this.sim.projection(planId, { trace: "summary" }).result;
    } catch {
      result = undefined;
    }
    const steps = residencyTimelineOf(input, result);
    const milestones = new Map(plan.milestones.map((m) => [m.id, m.name]));
    const people = input.household.people.map((p) => ({
      personId: p.id,
      name: p.name,
      citizenships: p.citizenships ?? [input.household.location.country],
      ...(p.usGreenCard ? { usGreenCard: true } : {}),
      residenceHistory: p.residenceHistory ?? [],
      steps: steps
        .filter((s) => s.personId === p.id)
        .map((s) => ({
          from: s.from,
          location: s.location,
          source: s.source,
          ...(s.refId ? { refId: s.refId } : {}),
          ...(s.source === "milestone" && s.refId ? { milestone: milestones.get(s.refId) } : {}),
        })),
    }));
    const unresolved = (plan.residency ?? [])
      .filter((r) => !steps.some((s) => s.refId === r.id))
      .map((r) => r.id);
    const countries = [...new Set(steps.map((s) => s.location.country))];
    const crossBorder = result?.periods.some((p) => p.taxes.byCountry !== undefined) ?? false;
    const warnings: string[] = [];
    for (const c of countries)
      if (!NON_RESIDENT_RULES[c])
        warnings.push(
          `${c}: Glideworth has no tax rules for this country; while living there taxes use the plan's flat or custom settings.`,
        );
    for (let i = 0; i < countries.length; i++)
      for (let j = i + 1; j < countries.length; j++)
        if (!treatyBetween(countries[i]!, countries[j]!))
          warnings.push(
            `No ${countries[i]}-${countries[j]} treaty in Glideworth's tables: both countries tax under their own rules with a credit.`,
          );
    if (unresolved.length)
      warnings.push(
        `Entries ${unresolved.join(", ")} could not be dated (a milestone that never happens, or a date after the plan ends).`,
      );
    return {
      planId,
      planVersion: plan.version,
      household: input.household.location,
      entries: plan.residency ?? [],
      people,
      countries,
      crossBorder,
      years: result
        ? result.periods
            .filter((p) => p.taxes.residence)
            .map((p) => ({ year: p.year, startMonth: p.startMonth, residence: p.taxes.residence }))
        : [],
      warnings,
    };
  }

  // ----------------------------------------------------------------------------- explain one item
  explainItem(planId: string, itemId: string, year?: number) {
    const { input, plan } = this.sim.inputFor(planId, { trace: "off" });
    const { result } = this.sim.projection(planId, { trace: "summary" });
    const y = year ?? result.periods.find((p) => p.months === 12)?.year ?? result.periods[0]?.year;
    if (y === undefined) throw new ApiError(422, "SCENARIO", "the plan projects no years");
    if (!result.periods.some((p) => p.year === y))
      throw new ApiError(404, "NOT_FOUND", `year ${y} is outside the projection`, {
        firstYear: result.periods[0]?.year,
        lastYear: result.periods[result.periods.length - 1]?.year,
      });
    try {
      return {
        planId,
        planVersion: plan.version,
        ...explainItemTaxation(input, itemId, y, result),
      };
    } catch (e) {
      if (e instanceof Error && /no account, real asset/.test(e.message))
        throw new ApiError(404, "NOT_FOUND", e.message, {
          validItemIds: crossBorderItems(input, result).map((i) => i.id),
        });
      throw e;
    }
  }

  /** Items whose country differs from where their owner lives at some point. */
  items(planId: string) {
    const { input, plan } = this.sim.inputFor(planId, { trace: "off" });
    const { result } = this.sim.projection(planId, { trace: "summary" });
    return { planId, planVersion: plan.version, items: crossBorderItems(input, result) };
  }

  // ----------------------------------------------------------------------------- tax by country
  taxByCountry(
    planId: string,
    q: { basis: ValueBasis; fromYear?: number | undefined; toYear?: number | undefined },
  ) {
    const { input, plan } = this.sim.inputFor(planId, { trace: "off" });
    const { result } = this.sim.projection(planId, { trace: "off" });
    const t = taxByCountry(result, q.basis, input.household.location.country);
    const years = t.years.filter(
      (y) =>
        (q.fromYear === undefined || y.year >= q.fromYear) &&
        (q.toYear === undefined || y.year <= q.toYear),
    );
    const round = (rows: { country: string; basis: string; amount: number }[]) =>
      rows.map((r) => ({ ...r, amount: roundMoney(r.amount) })).filter((r) => r.amount !== 0);
    const byCountry: Record<string, number> = {};
    const byBasis: Record<string, number> = {};
    for (const r of t.lifetime) {
      byCountry[r.country] = (byCountry[r.country] ?? 0) + r.amount;
      byBasis[r.basis] = (byBasis[r.basis] ?? 0) + r.amount;
    }
    const countries = [...new Set(t.lifetime.map((r) => r.country))];
    return {
      planId,
      planVersion: plan.version,
      currency: result.meta.currency,
      basis: q.basis,
      engineVersion: result.meta.engineVersion,
      crossBorder: t.crossBorder,
      bases: TAX_BASIS_LABEL,
      totals: {
        byCountry: Object.fromEntries(
          Object.entries(byCountry).map(([k, v]) => [k, roundMoney(v)]),
        ),
        byBasis: Object.fromEntries(Object.entries(byBasis).map(([k, v]) => [k, roundMoney(v)])),
        rows: round(t.lifetime),
      },
      years: years.map((y) => ({
        year: y.year,
        rows: round(y.rows),
        ...(y.residence ? { residence: y.residence } : {}),
      })),
      simplifications: t.crossBorder ? crossBorderSimplificationsFor(countries) : [],
    };
  }

  // ----------------------------------------------------------------------------- stay or move
  stayOrMove(planId: string, req: z.infer<typeof StayOrMoveRequest>) {
    const { input, plan } = this.sim.inputFor(planId, { trace: "off" });
    let opts: Parameters<ServiceCtx["deps"]["compareStayingVersusMoving"]>[1];
    let notes: string[] = [];
    if (req.movePlanId) {
      const other = this.plans.get(req.movePlanId);
      if (other.householdId !== plan.householdId)
        throw new ApiError(
          422,
          "SCENARIO",
          `plan '${req.movePlanId}' belongs to another household; compare plans of one household (a plan and its relocation branch).`,
        );
      opts = { movePlan: { ...other, lineage: undefined } };
    } else {
      if (!req.to || !req.month)
        throw new ApiError(
          400,
          "VALIDATION",
          "give `to` (country, optional region) and `month` (YYYY-MM) for the move, or `movePlanId` to compare with an existing plan.",
          { required: ["to", "month"] },
        );
      if (req.returnMonth && ym(req.returnMonth) <= ym(req.month))
        throw new ApiError(
          400,
          "VALIDATION",
          `returnMonth (${req.returnMonth}) must be after month (${req.month}).`,
          { field: "returnMonth" },
        );
      if (req.to.country === input.household.location.country)
        throw new ApiError(
          400,
          "VALIDATION",
          `the household already lives in ${req.to.country}; choose another country to compare a move.`,
          { field: "to.country" },
        );
      if (req.personId && !input.household.people.some((p) => p.id === req.personId))
        throw new ApiError(
          400,
          "VALIDATION",
          `personId '${req.personId}' is not in this household.`,
          {
            validPersonIds: input.household.people.map((p) => p.id),
          },
        );
      const move = {
        to: { country: req.to.country, ...(req.to.region ? { region: req.to.region } : {}) },
        month: req.month,
        ...(req.returnMonth ? { returnMonth: req.returnMonth } : {}),
        ...(req.personId ? { personId: req.personId } : {}),
      };
      opts = move;
      notes = this.ctx.deps.relocationScenario(input, move).notes;
    }
    const out = this.ctx.deps.compareStayingVersusMoving(input, opts);
    const r = (n: number) => roundMoney(n);
    return {
      planId,
      planVersion: plan.version,
      currency: out.stay.meta.currency,
      basis: "real" as const,
      stay: outcomeOf(out.stay),
      move: outcomeOf(out.move),
      moveSuccess: out.move.summary.success,
      deltas: {
        endNetWorthReal: r(out.deltas.endNetWorthReal),
        lifetimeTaxesReal: r(out.deltas.lifetimeTaxesReal),
        totalShortfallReal: r(out.deltas.totalShortfallReal),
      },
      taxesByCountry: out.taxesByCountry
        .map((x) => ({ ...x, stay: r(x.stay), move: r(x.move), delta: r(x.delta) }))
        .filter((x) => x.stay !== 0 || x.move !== 0),
      attribution: out.attribution.map((a) => ({ label: a.label, delta: r(a.delta) })),
      changes: out.diff.changes.map((c) => c.description),
      ops: out.diff.patch,
      notes,
    };
  }

  // ----------------------------------------------------------------------------- rule tables
  countries() {
    const codes = new Set([
      ...Object.keys(NON_RESIDENT_RULES),
      ...Object.keys(COUNTRY_TAX_CURRENCY),
    ]);
    return [...codes].sort().map((c) => {
      const nr = NON_RESIDENT_RULES[c];
      const peg = CURRENCY_PEGS.find((p) => p.from === COUNTRY_TAX_CURRENCY[c]);
      return {
        country: c,
        label: nr?.label ?? c,
        taxCurrency: COUNTRY_TAX_CURRENCY[c] ?? null,
        nonResidentRules: nr ? nr.depth : null,
        treaties: TREATIES.filter((t) => t.pair.includes(c)).map((t) =>
          t.pair.find((x) => x !== c)!,
        ),
        ...(peg ? { peg } : {}),
        ...(nr?.departure ? { departureTax: true } : {}),
        ...(nr?.citizenshipTaxation ? { citizenshipTaxation: true } : {}),
      };
    });
  }

  nonResidentRules(country: string) {
    const c = country.toUpperCase();
    const nr = NON_RESIDENT_RULES[c];
    if (!nr)
      throw new ApiError(
        404,
        "NOT_FOUND",
        `Glideworth has no non-resident rules for '${c}'. Countries with rules: ${Object.keys(NON_RESIDENT_RULES).sort().join(", ")}.`,
        { validCountries: Object.keys(NON_RESIDENT_RULES).sort() },
      );
    return nr;
  }

  treaties(country?: string) {
    const c = country?.toUpperCase();
    return TREATIES.filter((t) => !c || t.pair.includes(c)).map((t) => ({
      pair: t.pair,
      name: t.name,
      depth: t.depth,
      method: t.method,
    }));
  }

  /** The treaty for a pair (or the fallback), with the decision for every income category both ways. */
  treaty(a: string, b: string) {
    const x = a.toUpperCase();
    const y = b.toUpperCase();
    if (x === y)
      throw new ApiError(
        400,
        "VALIDATION",
        "give two different countries (a treaty is between two states).",
      );
    const t = treatyBetween(x, y);
    const decide = (residence: string, source: string) =>
      Object.fromEntries(
        INCOME_CATEGORIES.map((cat) => {
          const d = treatyRule(residence, source, cat);
          return [
            cat,
            {
              allocation: d.rule.allocation,
              sourceMayTax: d.sourceMayTax,
              residenceTaxes: d.residenceTaxes,
              ...(d.rule.maxSourceRate !== undefined
                ? { maxSourceRate: d.rule.maxSourceRate }
                : {}),
              ...(d.rule.note ? { note: d.rule.note } : {}),
            },
          ];
        }),
      );
    return {
      pair: [x, y].sort(),
      known: !!t,
      ...(t
        ? { name: t.name, depth: t.depth, method: t.method, notes: t.notes, sources: t.sources }
        : {
            fallback: `No ${x}-${y} treaty in Glideworth's tables: both countries tax under their domestic law and the residence country credits the source country's tax (shown as a warning in results).`,
          }),
      [`residentIn${x}`]: decide(x, y),
      [`residentIn${y}`]: decide(y, x),
    };
  }

  wrappers(q: { residence?: string | undefined; accountCountry?: string | undefined }) {
    const r = q.residence?.toUpperCase();
    const c = q.accountCountry?.toUpperCase();
    const rows = WRAPPER_RECOGNITION.filter(
      (w) =>
        (!r || w.residence === r) && (!c || w.accountCountry === c || w.accountCountry === "*"),
    );
    const views =
      r && c
        ? ACCOUNT_TYPES.filter(
            (t) => (ACCOUNT_TYPE_INFO[t] as { country?: string }).country === c,
          ).map((t) => {
            const info = ACCOUNT_TYPE_INFO[t as AccountType];
            const v = wrapperView(r, c, t as AccountType, info.taxTreatment);
            return { accountType: t, label: info.label, treatment: info.taxTreatment, ...v };
          })
        : undefined;
    const nonResident = c ? (NON_RESIDENT_RULES[c]?.wrappers ?? []) : undefined;
    return {
      rows,
      ...(views ? { accountTypes: views } : {}),
      ...(nonResident ? { whileNonResident: nonResident } : {}),
      default:
        "Not listed: foreign tax-free wrappers are not recognised (the earnings share of a withdrawal is taxed where you live); foreign pensions are taxed as pension income without their tax-free lump sum. Override per plan with tax.crossBorder.wrapperRecognition.",
    };
  }

  explainRule(q: {
    residence: string;
    source: string;
    category: IncomeCategory;
    nationalOfResidence?: boolean | undefined;
    accountType?: string | undefined;
  }) {
    let account:
      | { type: AccountType; treatment: (typeof ACCOUNT_TYPE_INFO)[AccountType]["taxTreatment"] }
      | undefined;
    if (q.accountType) {
      if (!(ACCOUNT_TYPES as readonly string[]).includes(q.accountType))
        throw new ApiError(400, "VALIDATION", `unknown account type '${q.accountType}'.`, {
          field: "accountType",
        });
      const t = q.accountType as AccountType;
      account = { type: t, treatment: ACCOUNT_TYPE_INFO[t].taxTreatment };
    }
    return explainCrossBorderTreatment({
      residence: q.residence.toUpperCase(),
      source: q.source.toUpperCase(),
      category: q.category,
      ...(q.nationalOfResidence !== undefined
        ? { nationalOfResidence: q.nationalOfResidence }
        : {}),
      ...(account ? { account } : {}),
    });
  }

  simplifications(countries: string[]) {
    return { items: crossBorderSimplificationsFor(countries.map((c) => c.toUpperCase())) };
  }
}
