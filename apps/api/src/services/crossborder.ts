/**
 * Items held in another country: which accounts, assets and income are abroad, "how is this item
 * taxed and why", tax by country and basis, and the read-only rule tables (non-resident rules,
 * treaties, wrapper recognition). The household lives in one country for the whole plan.
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
  INCOME_CATEGORIES,
  type IncomeCategory,
  NON_RESIDENT_RULES,
  TAX_BASIS_LABEL,
  TREATIES,
  taxByCountry,
  treatyBetween,
  treatyRule,
  type ValueBasis,
  WRAPPER_RECOGNITION,
  wrapperView,
} from "@glideworth/core";
import { ApiError } from "../errors.js";
import { roundMoney } from "../views.js";
import type { SimulationService } from "./simulation.js";

export class CrossBorderService {
  constructor(private readonly sim: SimulationService) {}

  // ----------------------------------------------------------------------------- explain one item
  explainItem(planId: string, itemId: string, year?: number) {
    const { input, plan } = this.sim.inputFor(planId, { trace: "off" });
    const { result } = this.sim.projection(planId, { trace: "off" });
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
        ...explainItemTaxation(input, itemId, y),
      };
    } catch (e) {
      if (e instanceof Error && /no account, real asset/.test(e.message))
        throw new ApiError(404, "NOT_FOUND", e.message, {
          validItemIds: crossBorderItems(input).map((i) => i.id),
        });
      throw e;
    }
  }

  /** Accounts, real assets and income in another country than the one the household lives in. */
  items(planId: string) {
    const { input, plan } = this.sim.inputFor(planId, { trace: "off" });
    return { planId, planVersion: plan.version, items: crossBorderItems(input) };
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
      years: years.map((y) => ({ year: y.year, rows: round(y.rows) })),
      simplifications: t.crossBorder ? crossBorderSimplificationsFor(countries) : [],
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
