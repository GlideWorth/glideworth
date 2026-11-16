/**
 * "How is this item taxed, and why" for one account, real asset, debt or income stream in a given
 * year, from the same tables the engine uses (non-resident rules, treaties, wrapper recognition),
 * plus the per-country / per-basis tax summary and the cross-border simplifications list. Shared by
 * the API, MCP and the web so all three explain a plan the same way.
 */
import { parseMonth } from "../engine/dates.js";
import { type ProjectionResult, type SimulationInput, toBasis } from "../engine/types.js";
import { ScenarioError } from "../errors.js";
import { ACCOUNT_TYPE_INFO } from "../schema/account-types.js";
import type { AccountType, TaxTreatment } from "../schema/accounts.js";
import type { Location } from "../schema/household.js";
import type { ValueBasis } from "../schema/primitives.js";
import {
  type CrossBorderTreatment,
  explainCrossBorderTreatment,
  countryName as N,
} from "../tax/crossborder/explain.js";
import { NON_RESIDENT_RULES } from "../tax/crossborder/nonresident.js";
import type { IncomeCategory } from "../tax/crossborder/types.js";
import { residencyTimelineOf } from "./crossborder.js";

export type TaxBasisKind = "residence" | "source" | "citizenship" | "relief" | "exit" | "return";
export const TAX_BASES: readonly TaxBasisKind[] = [
  "residence",
  "source",
  "citizenship",
  "relief",
  "exit",
  "return",
];

/** Plain-language meaning of each basis, for tables and tooltips. */
export const TAX_BASIS_LABEL: Record<TaxBasisKind, { label: string; description: string }> = {
  residence: {
    label: "Residence",
    description: "Tax where you live, on your worldwide income.",
  },
  source: {
    label: "Source",
    description: "Tax charged as a non-resident by the country where the income or asset is.",
  },
  citizenship: {
    label: "Citizenship",
    description: "US tax on citizens and green-card holders living abroad.",
  },
  relief: {
    label: "Relief",
    description:
      "Credit for tax already paid in another country (negative: it removes double tax).",
  },
  exit: { label: "Exit", description: "Departure tax on unrealised gains when you leave." },
  return: {
    label: "Return",
    description: "Gains realised during a short absence, taxed in the year you come back.",
  },
};

/**
 * Known simplifications of the cross-border model (general ones first, then each involved
 * country's non-resident rules). Shown prominently whenever a plan spans countries.
 */
export const CROSS_BORDER_SIMPLIFICATIONS: readonly string[] = [
  "Residence is what you enter: no statutory residence test, 183-day rule or treaty tie-breaker is applied.",
  "A move part-way through a tax year splits it by months; real split-year rules (and full allowances in the year of arrival or departure) are approximated.",
  "Treaty relief is assumed claimed (forms such as DT-Individual filed); until then the source country may deduct tax.",
  "Double tax is relieved by the credit method, limited to the residence tax on the same income; there is one foreign-tax-credit basket and no carry-forward.",
  "Treaties other than UK-UAE are modelled at a basic level (main allocation rules only); unknown pairs fall back to both countries taxing with a credit.",
  "Foreign tax-free wrappers are not recognised by default (ISA, Roth, TFSA, DEWS...): the earnings share of each withdrawal is taxed where you live.",
  "Each country is computed in its own currency with your exchange-rate table at the start of each year; a missing rate is treated as 1.",
  "A gratuity or bonus paid after a move is taxed where you live when it is paid.",
];

export function crossBorderSimplificationsFor(countries: Iterable<string>): string[] {
  const out = [...CROSS_BORDER_SIMPLIFICATIONS];
  for (const c of new Set(countries)) {
    const nr = NON_RESIDENT_RULES[c];
    if (nr) for (const s of nr.simplifications) out.push(`${nr.label}: ${s}`);
  }
  return out;
}

// ------------------------------------------------------------------ tax by country and basis

export interface TaxByCountryRow {
  country: string;
  basis: TaxBasisKind;
  amount: number;
}

/**
 * Taxes by country and basis, per period and over the plan, in the chosen basis (real = today's
 * money). Single-country plans have no `byCountry` data: they report everything as residence tax
 * of the household's country, so the shape is the same.
 */
export function taxByCountry(
  result: ProjectionResult,
  basis: ValueBasis = "real",
  home?: string,
): {
  crossBorder: boolean;
  lifetime: TaxByCountryRow[];
  years: {
    year: number;
    periodIndex: number;
    rows: TaxByCountryRow[];
    residence?: Record<string, { country: string; region?: string; months: number }[]>;
  }[];
} {
  const country =
    home ?? result.periods.find((p) => p.taxes.byCountry)?.taxes.byCountry?.[0]?.country ?? "";
  const crossBorder = result.periods.some((p) => p.taxes.byCountry !== undefined);
  const life = new Map<string, number>();
  const years = result.periods.map((p) => {
    const raw = p.taxes.byCountry ?? [
      { country, basis: "residence" as const, amount: p.taxes.total },
    ];
    const rows = raw
      .map((r) => ({
        country: r.country,
        basis: r.basis,
        amount: toBasis(r.amount, p, basis, "flow"),
      }))
      .filter((r) => Math.abs(r.amount) > 1e-9);
    for (const r of rows) {
      const k = `${r.country}|${r.basis}`;
      life.set(k, (life.get(k) ?? 0) + r.amount);
    }
    return {
      year: p.year,
      periodIndex: p.index,
      rows,
      ...(p.taxes.residence ? { residence: p.taxes.residence } : {}),
    };
  });
  const lifetime = [...life.entries()]
    .map(([k, amount]) => {
      const [c, b] = k.split("|") as [string, TaxBasisKind];
      return { country: c, basis: b, amount };
    })
    .sort((a, b) => b.amount - a.amount);
  return { crossBorder, lifetime, years };
}

// ------------------------------------------------------------------ explain one item

export type ExplainedItemKind = "account" | "realAsset" | "debt" | "income";

export interface ItemTaxExplanation {
  itemId: string;
  kind: ExplainedItemKind;
  name: string;
  year: number;
  /** Country the item is in (its source country). */
  country: string;
  currency: string;
  owner: string;
  /** Owner's residence(s) during the year, with months. */
  residence: { personId: string; country: string; region?: string; months: number }[];
  /** One entry per (residence, income category) pair that applies to the item. */
  treatments: (CrossBorderTreatment & { label: string })[];
  /** US citizens / green-card holders abroad: US tax applies on top (citizenship basis). */
  citizenship?: string;
  warnings: string[];
  /** Plain summary sentence. */
  summary: string;
}

const CATEGORY_LABEL: Record<IncomeCategory, string> = {
  employment: "Pay",
  "self-employment": "Self-employment profit",
  rental: "Rent",
  "private-pension": "Pension withdrawals",
  "pension-lump-sum": "Pension lump sum",
  "state-pension": "State pension",
  "government-pension": "Government pension",
  interest: "Interest",
  dividends: "Dividends",
  "gains-property": "Gain when sold",
  "gains-securities": "Gains when sold",
  other: "Withdrawals",
};

const PROPERTY = new Set(["house", "rental-property", "commercial-property", "land", "building"]);
const STATE_BENEFITS = new Set(["state-pension", "social-security", "ca-cpp", "ca-oas", "ca-gis"]);
const EARNED = new Set(["salary", "hourly", "bonus", "rsu", "self-employment"]);

function finances(input: SimulationInput) {
  const sc = input.plan.startingConditions;
  return sc.kind === "snapshot" ? sc.finances : input.finances;
}

function incomeCategories(type: string, government: boolean): IncomeCategory[] {
  if (STATE_BENEFITS.has(type)) return ["state-pension"];
  if (type === "pension" || type === "annuity")
    return [government ? "government-pension" : "private-pension"];
  if (type === "self-employment") return ["self-employment"];
  if (EARNED.has(type)) return ["employment"];
  return ["other"];
}

function accountCategories(treatment: TaxTreatment): IncomeCategory[] {
  switch (treatment) {
    case "tax-deferred":
      return ["private-pension", "pension-lump-sum"];
    case "taxable":
      return ["dividends", "interest", "gains-securities"];
    case "tax-free":
      return ["other"];
    default:
      return ["interest"];
  }
}

/** The months of `year` (the projection period with that year, or the plan's year alignment). */
function monthsOf(
  input: SimulationInput,
  year: number,
  result?: ProjectionResult,
): { start: number; months: number } {
  const p = result?.periods.find((x) => x.year === year);
  if (p) return { start: parseMonth(p.startMonth), months: p.months };
  const a = input.plan.assumptions.yearAlignment as { kind: string; startMonth?: number };
  const m = a.kind === "fiscal" && a.startMonth ? a.startMonth : 1;
  return { start: parseMonth(`${year}-${String(m).padStart(2, "0")}`), months: 12 };
}

/**
 * Explain how one item is taxed in `year`: its source country, the owner's residence (split years
 * give one entry per residence), and for every income category the item produces the non-resident
 * rule, the treaty article, how the residence country sees a foreign wrapper and the relief.
 * `result` dates milestone-bound moves; without it only dated moves are known.
 */
export function explainItemTaxation(
  input: SimulationInput,
  itemId: string,
  year: number,
  result?: ProjectionResult,
): ItemTaxExplanation {
  const fin = finances(input);
  const { household, plan } = input;
  const base = household.location.country;
  const overrides = plan.tax.crossBorder?.wrapperRecognition;
  let kind: ExplainedItemKind;
  let name: string;
  let owner: string;
  let country: string;
  let currency: string = household.currency;
  let categories: IncomeCategory[];
  let account: { type: AccountType; treatment: TaxTreatment } | undefined;

  const acc = [...fin.accounts, ...plan.plannedAccounts].find((a) => a.id === itemId);
  const asset =
    fin.realAssets.find((r) => r.id === itemId) ??
    plan.plannedRealAssets.find((r) => r.id === itemId);
  const debt = fin.debts.find((d) => d.id === itemId);
  const inc = plan.income.find((e) => e.id === itemId);
  if (acc) {
    const info = ACCOUNT_TYPE_INFO[acc.type];
    const treatment = (acc.taxTreatment ?? info.taxTreatment) as TaxTreatment;
    kind = "account";
    name = acc.name;
    owner = acc.owner;
    country = acc.jurisdiction ?? info.country ?? base;
    currency = acc.currency ?? household.currency;
    categories = accountCategories(treatment);
    account = { type: acc.type, treatment };
  } else if (asset) {
    kind = "realAsset";
    name = asset.name;
    owner = asset.owner;
    country = asset.country ?? base;
    currency = asset.currency ?? household.currency;
    categories = PROPERTY.has(asset.type) ? ["rental", "gains-property"] : ["gains-securities"];
  } else if (debt) {
    kind = "debt";
    name = debt.name;
    owner = debt.owner;
    country = debt.country ?? base;
    currency = debt.currency ?? household.currency;
    categories = [];
  } else if (inc) {
    kind = "income";
    name = inc.name;
    owner = inc.owner;
    categories = incomeCategories(inc.type, inc.governmentService === true);
    country = inc.country ?? base;
    currency = (inc as { currency?: string }).currency ?? household.currency;
  } else {
    throw new ScenarioError(`no account, real asset, debt or income with id '${itemId}'`, {
      itemId,
    });
  }

  const people =
    owner === "joint" || !household.people.some((p) => p.id === owner)
      ? household.people
      : household.people.filter((p) => p.id === owner);
  const steps = residencyTimelineOf(input, result);
  const { start, months } = monthsOf(input, year, result);
  const residence: ItemTaxExplanation["residence"] = [];
  for (const p of people) {
    const fromResult = result?.periods.find((x) => x.year === year)?.taxes.residence?.[p.id];
    if (fromResult?.length) {
      for (const r of fromResult)
        residence.push({
          personId: p.id,
          country: r.country,
          ...(r.region ? { region: r.region } : {}),
          months: r.months,
        });
      continue;
    }
    const counts = new Map<string, { loc: Location; months: number }>();
    for (let m = start; m < start + months; m++) {
      let loc = household.location;
      for (const s of steps)
        if (s.personId === p.id && (s.from === null || parseMonth(s.from) <= m)) loc = s.location;
      const k = `${loc.country}|${loc.region ?? ""}`;
      const c = counts.get(k) ?? { loc, months: 0 };
      c.months++;
      counts.set(k, c);
    }
    for (const { loc, months: n } of counts.values())
      residence.push({
        personId: p.id,
        country: loc.country,
        ...(loc.region ? { region: loc.region } : {}),
        months: n,
      });
  }

  const residences = [...new Set(residence.map((r) => r.country))];
  const treatments: ItemTaxExplanation["treatments"] = [];
  const warnings: string[] = [];
  for (const res of residences) {
    const holder = people.find((p) =>
      residence.some((r) => r.personId === p.id && r.country === res),
    );
    const national = (holder?.citizenships ?? [base]).includes(res);
    for (const cat of categories) {
      // Pay without a country is earned where its owner lives.
      const source =
        kind === "income" && !inc?.country && (cat === "employment" || cat === "self-employment")
          ? res
          : country;
      const t = explainCrossBorderTreatment({
        residence: res,
        source,
        category: cat,
        nationalOfResidence: national,
        ...(account ? { account } : {}),
        ...(overrides ? { wrapperOverrides: overrides } : {}),
      });
      treatments.push({ ...t, label: CATEGORY_LABEL[cat] });
      if (t.unknownTreaty && !warnings.some((w) => w.includes(`${N(res)}-${N(source)}`)))
        warnings.push(
          `No ${N(res)}-${N(source)} treaty in Glideworth's tables: both countries tax under their own rules and ${N(res)} credits the ${N(source)} tax. A real treaty may allocate taxing rights differently.`,
        );
      if (t.wrapper && !t.wrapper.recognised && account?.treatment !== "taxable")
        if (!warnings.some((w) => w.startsWith(`${N(res)} does not recognise`)))
          warnings.push(
            `${N(res)} does not recognise this ${N(source)} wrapper: ${t.wrapper.note}`,
          );
      if (
        !NON_RESIDENT_RULES[source] &&
        source !== res &&
        !warnings.some((w) => w.includes(`rules for ${N(source)}`))
      )
        warnings.push(
          `Glideworth has no non-resident rules for ${N(source)}: no ${N(source)} tax is modelled while you live abroad.`,
        );
    }
  }
  const usPerson = people.some((p) => p.usGreenCard || p.citizenships?.includes("US"));
  const citizenship =
    usPerson && residences.some((r) => r !== "US")
      ? (NON_RESIDENT_RULES.US?.citizenshipTaxation?.note ??
        "US citizens and green-card holders are taxed by the US on worldwide income wherever they live.")
      : undefined;

  let summary: string;
  if (kind === "debt")
    summary = `${name} is a debt in ${N(country)}: debts are not taxed. Interest relief abroad is not modelled; repayments in ${currency} follow your exchange-rate table.`;
  else if (treatments.every((t) => t.residence === t.source))
    summary = `${name} is taxed only in ${residences.map(N).join(" and ")}, where ${people.length > 1 ? "you live" : "its owner lives"} in ${year}.`;
  else {
    const src = treatments.filter((t) => t.sourceTaxes).map((t) => t.label.toLowerCase());
    const where = residences.map(N).join(" and ");
    summary =
      src.length > 0
        ? `${name} is in ${N(country)}; in ${year} ${N(country)} taxes the ${[...new Set(src)].join(" and ")} as a non-resident and ${where} ${treatments.some((t) => t.relief === "credit") ? "gives a credit for that tax" : "exempts it"}.`
        : `${name} is in ${N(country)}, but in ${year} only ${where} (where ${people.length > 1 ? "you live" : "its owner lives"}) taxes it.`;
  }
  return {
    itemId,
    kind,
    name,
    year,
    country,
    currency,
    owner,
    residence,
    treatments,
    ...(citizenship ? { citizenship } : {}),
    warnings,
    summary,
  };
}

/** Every account, real asset, debt and income stream whose country differs from where its owner lives at some point. */
export function crossBorderItems(
  input: SimulationInput,
  result?: ProjectionResult,
): { id: string; kind: ExplainedItemKind; name: string; country: string }[] {
  const fin = finances(input);
  const base = input.household.location.country;
  const steps = residencyTimelineOf(input, result);
  const residences = new Set(steps.map((s) => s.location.country));
  const anyForeign = (c: string) => [...residences].some((r) => r !== c);
  const out: { id: string; kind: ExplainedItemKind; name: string; country: string }[] = [];
  for (const a of fin.accounts) {
    if (a.archived) continue;
    const c = a.jurisdiction ?? ACCOUNT_TYPE_INFO[a.type].country ?? base;
    if (anyForeign(c)) out.push({ id: a.id, kind: "account", name: a.name, country: c });
  }
  for (const r of fin.realAssets) {
    if (r.archived) continue;
    const c = r.country ?? base;
    if (anyForeign(c)) out.push({ id: r.id, kind: "realAsset", name: r.name, country: c });
  }
  for (const e of input.plan.income) {
    if (!e.enabled) continue;
    const c = e.country ?? base;
    if (anyForeign(c) || EARNED.has(e.type)) {
      if (residences.size > 1 || c !== base)
        out.push({ id: e.id, kind: "income", name: e.name, country: c });
    }
  }
  return out;
}
