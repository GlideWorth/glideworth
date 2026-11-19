/**
 * Taxes for a household with items in another country (ARCHITECTURE.md §4.6). Replaces the single
 * jurisdiction stack when the run is cross-border (`initCrossBorder`). The household lives at
 * `Household.location` for the whole plan; moves are not modelled.
 *
 *   residence tax  = the residence country's stack on worldwide income (items exempt there under
 *                    a treaty removed; foreign wrappers seen the residence country's way);
 *   source tax     = each other country's non-resident rules on items sourced there (treaty
 *                    allocation and rate caps applied), per person;
 *   citizenship tax= US federal tax of US citizens / green-card holders living outside the US
 *                    (foreign earned income exclusion + foreign tax credit);
 *   relief         = credit in the residence country for source tax on the same income, limited to
 *                    the residence tax on it (difference method).
 *
 * Money is converted into each jurisdiction's currency with the plan's FX table at the period start
 * and the tax converted back.
 */
import type { AccountType, TaxTreatment } from "../schema/accounts.js";
import { ACCOUNT_TYPE_INFO } from "../schema/account-types.js";
import { fxPairKey } from "../schema/assumptions.js";
import type { Location } from "../schema/household.js";
import { COUNTRY_TAX_CURRENCY } from "../tax/crossborder/currency.js";
import { NON_RESIDENT_RULES } from "../tax/crossborder/nonresident.js";
import { citizenshipMayTax, treatyRule } from "../tax/crossborder/treaties.js";
import type { IncomeCategory, SourceRule } from "../tax/crossborder/types.js";
import { wrapperView } from "../tax/crossborder/wrappers.js";
import { NATIONAL_JURISDICTION_BY_COUNTRY } from "../tax/registry.js";
import type {
  BracketFill,
  TaxDeductionItem,
  TaxIncomeItem,
  TaxJurisdiction,
  TaxPerson,
  TaxWithdrawalItem,
  TaxYearInput,
  TaxYearOutput,
} from "../tax/types.js";
import { type AccountState, type EngineContext, type PeriodState, warnOnce } from "./context.js";
import { fxAt } from "./indices.js";
import { accountCountryOf } from "./rules.js";
import type { TaxLine } from "./types.js";

export interface ItemInfo {
  country: string;
  category: IncomeCategory | null;
  /** Deductions that follow an income item (rental costs follow the rent). */
  follows?: "rental";
  accountId?: string;
  assetId?: string;
  government?: boolean;
}

type Basis = NonNullable<TaxLine["basis"]>;

export interface CrossBorderResult {
  total: number;
  lines: TaxLine[];
  outputs: TaxYearOutput[];
  grossIncome: number;
  taxableIncome: number;
  facts: Record<string, number>;
  byCountry: { country: string; basis: Basis; amount: number }[];
  brackets?: BracketFill[];
}

const PROPERTY_TYPES = new Set([
  "house",
  "rental-property",
  "commercial-property",
  "land",
  "building",
]);
const GOV_BENEFITS = new Set(["state-pension", "social-security", "ca-cpp", "ca-oas", "ca-gis"]);

// ------------------------------------------------------------------ run state

export interface CrossBorderState {
  /** Every country involved (the residence, item countries). */
  countries: Set<string>;
  /** People taxed by the US on worldwide income wherever they live. */
  usPersons: Set<string>;
  /** Citizenships per person (default: the household's country). */
  citizenships: Map<string, Set<string>>;
  /** Jurisdiction currencies with no FX pair to the base currency (taxes computed at rate 1). */
  fxMissing: Set<string>;
  /** Estimated contribution basis of tax-free wrappers (earnings share when not recognised abroad). */
  wrapperBasis: Map<string, number>;
}

const US_PERSON = (p: { citizenships?: string[] | undefined; usGreenCard?: boolean | undefined }) =>
  !!p.usGreenCard || (p.citizenships ?? []).includes("US");

/**
 * Decide whether the run is cross-border and prepare its state. Called once after the FX table is
 * resolved and before the FX path is built (it may add the tax currencies of the countries involved).
 *
 * A run is cross-border when the plan is in estimate mode and more than one country is involved (an
 * account / asset / debt / income in another country) or a US citizen lives outside the US. An
 * explicit jurisdiction stack is the user's override: foreign items alone do not switch it on.
 * Single-country runs never touch this module beyond one boolean check, so their results are unchanged.
 */
export function initCrossBorder(ctx: EngineContext): void {
  const { plan, household } = ctx;
  const mode = plan.tax.crossBorder?.mode ?? "auto";
  if (plan.tax.mode !== "estimate" || mode === "off") return;
  const home = household.location.country;
  const countries = new Set<string>([home]);
  const excluded = new Set(plan.excludedIds);
  const accountDefs = [
    ...ctx.finances.accounts.filter((a) => !a.archived && !excluded.has(a.id)),
    ...plan.plannedAccounts,
  ];
  const typeCountry = (type: string) =>
    (ACCOUNT_TYPE_INFO as Record<string, { country?: string }>)[type]?.country;
  for (const a of accountDefs) countries.add(a.jurisdiction ?? (typeCountry(a.type) || home));
  for (const r of [...ctx.finances.realAssets, ...plan.plannedRealAssets])
    if (!r.archived && !excluded.has(r.id)) countries.add(r.country ?? home);
  for (const d of ctx.finances.debts)
    if (!d.archived && !excluded.has(d.id)) countries.add(d.country ?? home);
  for (const e of plan.income) if (e.enabled && e.country) countries.add(e.country);
  const usPersons = new Set(household.people.filter(US_PERSON).map((p) => p.id));
  const usAbroad = usPersons.size > 0 && home !== "US";
  const active = usAbroad || (plan.tax.jurisdictions.length === 0 && countries.size > 1);
  if (!active) return;
  if (usPersons.size > 0) countries.add("US");
  ctx.crossBorder = {
    countries,
    usPersons,
    citizenships: new Map(
      household.people.map((p) => [
        p.id,
        new Set(p.citizenships?.length ? p.citizenships : [home]),
      ]),
    ),
    fxMissing: new Set(),
    wrapperBasis: new Map(),
  };
  addTaxCurrencies(ctx, countries);
}

/** Make the tax currency of every involved country convertible (FX table pair, direct or inverse). */
function addTaxCurrencies(ctx: EngineContext, countries: Set<string>): void {
  const baseCurrency = ctx.household.currency;
  ctx.fx ??= new Map();
  const table = new Map<string, { from: string; to: string; rate: number; annualDrift: number }>();
  for (const r of ctx.finances.fxRates ?? []) table.set(fxPairKey(r.from, r.to), r);
  for (const r of ctx.plan.assumptions.fxRates ?? []) table.set(fxPairKey(r.from, r.to), r);
  for (const c of countries) {
    const cur = COUNTRY_TAX_CURRENCY[c];
    if (!cur || cur === baseCurrency || ctx.fx.has(cur)) continue;
    const pair = table.get(fxPairKey(cur, baseCurrency));
    if (!pair) {
      ctx.crossBorder!.fxMissing.add(cur);
      continue;
    }
    if (pair.from === cur) ctx.fx.set(cur, { rate: pair.rate, drift: pair.annualDrift });
    else ctx.fx.set(cur, { rate: 1 / pair.rate, drift: 1 / (1 + pair.annualDrift) - 1 });
  }
}

/** Period open: taxes this period go through `crossBorderTaxes`. */
export function openCrossBorderPeriod(ctx: EngineContext, ps: PeriodState): void {
  if (!ctx.crossBorder) return;
  ps.crossBorder = true;
  ps.itemInfo = new Map();
}

/** Period close (after the settle converged): the contribution basis of tax-free wrappers. */
export function closeCrossBorderPeriod(ctx: EngineContext): void {
  const st = ctx.crossBorder;
  if (!st) return;
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

function initialWrapperBasis(a: AccountState): number {
  return a.def.contributionBasis ?? a.def.costBasis ?? Math.max(0, a.p.opening);
}

/** Earnings share of a tax-free wrapper's withdrawals (for residence countries that do not recognise it). */
function wrapperEarningsShare(ctx: EngineContext, a: AccountState): number {
  const basis = ctx.crossBorder?.wrapperBasis.get(a.def.id) ?? initialWrapperBasis(a);
  const value = Math.max(a.p.opening + a.p.contributions + a.p.transfersIn, 1e-9);
  return Math.max(0, Math.min(1, 1 - basis / value));
}

/**
 * People's citizenship includes `country` (default: the household's country). For the US, a
 * green-card holder counts too (treaty saving clauses treat them like citizens).
 */
function isNational(ctx: EngineContext, personId: string, country: string): boolean {
  if (country === "US" && ctx.crossBorder?.usPersons.has(personId)) return true;
  return (
    ctx.crossBorder?.citizenships.get(personId)?.has(country) ??
    ctx.household.location.country === country
  );
}

/**
 * Contribution eligibility of a wrapper whose country is not the household's residence: the annual
 * limit after the country's non-resident wrapper rule (ISA, UK pensions, TFSA, RRSP: none).
 */
export function nonResidentContributionCap(
  ctx: EngineContext,
  ps: PeriodState,
  a: AccountState,
  annual: number,
): number {
  if (!ps.crossBorder) return annual;
  const country = accountCountryOf(ctx, a);
  if (country === ctx.household.location.country) return annual;
  const rule = NON_RESIDENT_RULES[country]?.wrappers.find((w) =>
    w.accountTypes.includes(a.def.type),
  );
  return !rule || rule.contributions === "allowed" ? annual : 0;
}

/** Warn once when a tax currency has no FX pair (tax for that country computed without conversion). */
function warnFxMissing(ctx: EngineContext, currency: string): void {
  warnOnce(ctx, `tax-fx:${currency}`, {
    code: "ASSUMPTION",
    severity: "warning",
    message: `No exchange rate between ${currency} and ${ctx.household.currency}: tax thresholds in ${currency} were applied to ${ctx.household.currency} amounts unconverted. Add a ${currency} rate to the FX table.`,
    periodIndex: null,
    refs: [],
  });
}

// ------------------------------------------------------------------ classification

function categoryOfCharacter(c: string): IncomeCategory {
  switch (c) {
    case "wage":
      return "employment";
    case "self-employment":
      return "self-employment";
    case "pension":
      return "private-pension";
    case "social-security":
      return "state-pension";
    case "interest":
      return "interest";
    case "qualified-dividend":
    case "ordinary-dividend":
      return "dividends";
    case "rental":
      return "rental";
    case "capital-gains-long":
    case "capital-gains-short":
      return "gains-securities";
    default:
      return "other";
  }
}

function base(ctx: EngineContext): string {
  return ctx.household.location.country;
}

/** Items whose character was changed for one computation keep their original classification. */
const KEEP_INFO = new WeakMap<TaxIncomeItem, ItemInfo>();

export function classifyIncome(ctx: EngineContext, ps: PeriodState, it: TaxIncomeItem): ItemInfo {
  const kept = KEEP_INFO.get(it);
  if (kept) return kept;
  const key = `i|${it.sourceId}|${it.character}|${it.owner}`;
  const hit = ps.itemInfo?.get(key);
  if (hit) return hit;
  const info = classifyIncomeUncached(ctx, it);
  ps.itemInfo?.set(key, info);
  return info;
}

function classifyIncomeUncached(ctx: EngineContext, it: TaxIncomeItem): ItemInfo {
  const [prefix, rest = ""] = splitOnce(it.sourceId);
  const asset = (id: string) => ctx.assets.find((r) => r.def.id === id);
  const account = (id: string) => ctx.accountById.get(id);
  switch (prefix) {
    case "rental": {
      const r = asset(rest);
      return { country: r?.def.country ?? base(ctx), category: "rental", assetId: rest };
    }
    case "asset-sale": {
      const r = asset(rest);
      const prop = r ? PROPERTY_TYPES.has(r.def.type) : false;
      return {
        country: r?.def.country ?? base(ctx),
        category: prop ? "gains-property" : "gains-securities",
        assetId: rest,
      };
    }
    case "dividends":
    case "interest":
    case "rebalance": {
      const a = account(rest);
      return {
        country: a ? accountCountryOf(ctx, a) : base(ctx),
        category: prefix === "rebalance" ? "gains-securities" : categoryOfCharacter(it.character),
        accountId: rest,
      };
    }
    case "debt-forgiven": {
      const d = ctx.debts.find((x) => x.def.id === rest);
      return { country: d?.def.country ?? base(ctx), category: "other" };
    }
    default:
      break;
  }
  const eventId = it.sourceId.split(":")[0]!;
  const e = ctx.plan.income.find((x) => x.id === eventId);
  if (e) {
    const db = it.sourceId.includes(":pension");
    let category: IncomeCategory =
      GOV_BENEFITS.has(e.type) || GOV_BENEFITS.has(it.incomeType ?? "")
        ? "state-pension"
        : db || e.type === "pension" || e.type === "annuity"
          ? e.governmentService
            ? "government-pension"
            : "private-pension"
          : categoryOfCharacter(it.character);
    if (category === "other" && (e.type === "bonus" || e.type === "rsu")) category = "employment";
    // Pay without a country is sourced where the work is done: where the household lives.
    return {
      country: e.country ?? base(ctx),
      category,
      ...(e.governmentService ? { government: true } : {}),
    };
  }
  return { country: base(ctx), category: categoryOfCharacter(it.character) };
}

function classifyWithdrawal(ctx: EngineContext, ps: PeriodState, w: TaxWithdrawalItem): ItemInfo {
  const key = `w|${w.accountId}`;
  const hit = ps.itemInfo?.get(key);
  if (hit) return hit;
  const a = ctx.accountById.get(w.accountId);
  const country = a ? accountCountryOf(ctx, a) : base(ctx);
  const category: IncomeCategory =
    w.treatment === "tax-deferred"
      ? "private-pension"
      : w.treatment === "taxable"
        ? "gains-securities"
        : "other";
  const info = { country, category, accountId: w.accountId };
  ps.itemInfo?.set(key, info);
  return info;
}

function classifyDeduction(ctx: EngineContext, ps: PeriodState, d: TaxDeductionItem): ItemInfo {
  const [prefix, rest = ""] = splitOnce(d.sourceId);
  if (prefix === "rental-deductions") {
    const r = ctx.assets.find((x) => x.def.id === rest);
    return {
      country: r?.def.country ?? base(ctx),
      category: null,
      follows: "rental",
      assetId: rest,
    };
  }
  if (d.accountId) {
    const a = ctx.accountById.get(d.accountId);
    return {
      country: a ? accountCountryOf(ctx, a) : base(ctx),
      category: null,
      accountId: d.accountId,
    };
  }
  void ps;
  return { country: "", category: null };
}

function splitOnce(s: string): [string, string] {
  const i = s.indexOf(":");
  return i < 0 ? [s, ""] : [s.slice(0, i), s.slice(i + 1)];
}

// ------------------------------------------------------------------ helpers

function genericType(t: TaxTreatment, type: AccountType): AccountType {
  if (t === "tax-deferred") return "generic-tax-deferred";
  if (t === "tax-free") return "generic-tax-free";
  if (t === "taxable") return "taxable";
  return type;
}

function share(owner: string, ids: readonly string[], alive: readonly string[]): number {
  if (alive.length <= 1) return ids.length > 0 ? 1 : 0;
  let s = 0;
  for (const id of ids) {
    if (owner === id) s += 1;
    else if (!alive.includes(owner)) s += 1 / alive.length;
  }
  return Math.min(1, s);
}

function scaleInput(input: TaxYearInput, k: number): TaxYearInput {
  if (k === 1) return input;
  return {
    ...input,
    income: input.income.map((i) => ({ ...i, amount: i.amount * k })),
    withdrawals: input.withdrawals.map((w) => ({
      ...w,
      amount: w.amount * k,
      taxableAmount: w.taxableAmount * k,
    })),
    deductions: input.deductions.map((d) => ({ ...d, amount: d.amount * k })),
    ...(input.wealth
      ? {
          wealth: Object.fromEntries(
            Object.entries(input.wealth).map(([key, v]) => [
              key,
              typeof v === "number" ? v * k : v,
            ]),
          ) as TaxYearInput["wealth"],
        }
      : {}),
    ...(input.transactions
      ? {
          transactions: {
            purchases: input.transactions.purchases * k,
            sales: input.transactions.sales * k,
          },
        }
      : {}),
    ...(input.aca
      ? {
          aca: {
            ...input.aca,
            benchmarkPremium: input.aca.benchmarkPremium * k,
            ...(input.aca.advanceCredit !== undefined
              ? { advanceCredit: input.aca.advanceCredit * k }
              : {}),
          },
        }
      : {}),
  };
}

/** Base-currency units per unit of the country's tax currency (1 when unknown, with a warning). */
function taxRate(ctx: EngineContext, ps: PeriodState, country: string): number {
  const cur = COUNTRY_TAX_CURRENCY[country];
  if (!cur || cur === ctx.household.currency) return 1;
  if (ctx.fx?.has(cur)) return fxAt(ctx, cur, ps.bounds.start);
  warnFxMissing(ctx, cur);
  return 1;
}

interface RunOut {
  total: number;
  outputs: TaxYearOutput[];
  lines: TaxLine[];
  gross: number;
  taxable: number;
  brackets: BracketFill[];
}

function runStack(
  stack: readonly TaxJurisdiction[],
  input: TaxYearInput,
  rate: number,
  tag: { basis: Basis; country: string; personId?: string; suffix?: string },
  explain: boolean,
): RunOut {
  const conv = scaleInput(input, 1 / rate);
  const outputs: TaxYearOutput[] = [];
  for (const j of stack)
    outputs.push(
      explain && j.explainYear ? j.explainYear(conv, outputs) : j.computeYear(conv, outputs),
    );
  const lines: TaxLine[] = [];
  let total = 0;
  for (const o of outputs)
    for (const l of o.lines) {
      const amount = l.amount * rate;
      total += amount;
      lines.push({
        ...l,
        amount,
        ...(l.base !== undefined ? { base: l.base * rate } : {}),
        ...(tag.suffix ? { label: `${l.label}${tag.suffix}` } : {}),
        basis: tag.basis,
        country: tag.country,
        ...(tag.personId ? { personId: tag.personId } : {}),
      });
    }
  const brackets: BracketFill[] = [];
  if (explain)
    for (const o of outputs)
      for (const b of o.brackets ?? [])
        brackets.push({
          ...b,
          ...(b.personId || !tag.personId ? {} : { personId: tag.personId }),
          bands: b.bands.map((x) => ({
            ...x,
            from: x.from * rate,
            to: x.to * rate,
            amount: x.amount * rate,
            tax: x.tax * rate,
          })),
        });
  return {
    total,
    outputs,
    lines,
    gross: outputs.reduce((s, o) => Math.max(s, o.grossIncome), 0) * rate,
    taxable: outputs.reduce((s, o) => Math.max(s, o.taxableIncome), 0) * rate,
    brackets,
  };
}

function totalOf(
  stack: readonly TaxJurisdiction[],
  input: TaxYearInput,
  rate: number,
  exceptKinds?: ReadonlySet<TaxLine["kind"]>,
): number {
  const conv = scaleInput(input, 1 / rate);
  const outputs: TaxYearOutput[] = [];
  let t = 0;
  for (const j of stack) {
    const o = j.computeYear(conv, outputs);
    outputs.push(o);
    for (const l of o.lines) if (!exceptKinds?.has(l.kind)) t += l.amount;
  }
  return t * rate;
}

/** Foreign social security contributions (not creditable against US tax). */
const SOCIAL_CONTRIBUTIONS = new Set<TaxLine["kind"]>(["payroll", "self-employment"]);

/** US tax lines the foreign tax credit cannot reduce (it offsets regular income tax and AMT only). */
const NOT_CREDITABLE = new Set<TaxLine["kind"]>(["niit", "irmaa", "penalty"]);

/** Flat non-resident rate for a holder living in `residence` (the rule's residence override, if any). */
function flatRateFor(rule: SourceRule, residence: string): number {
  const o = rule.rateByResidence?.find((x) => x.residences.includes(residence));
  return o?.rate ?? rule.rate ?? 0;
}

/**
 * Stacking rule for the foreign earned income exclusion (Form 2555, Foreign Earned Income Tax
 * Worksheet): the tax on `excluded` at the ordinary rates of the person's filing status, with no
 * deduction, in base currency. Computed with the plug-in on the excluded amount plus the deduction
 * the plug-in gives on it, so the taxable income it taxes is the excluded amount.
 */
function ordinaryTaxOnExcluded(
  j: TaxJurisdiction,
  base: TaxYearInput,
  pid: string,
  excluded: number,
  rate: number,
): number {
  const make = (amount: number): TaxYearInput => ({
    ...base,
    income: [{ sourceId: "__feie__", owner: pid, character: "ordinary", amount, exemptIn: [] }],
    withdrawals: [],
    deductions: [],
    dependents: [],
  });
  const tag = { basis: "citizenship" as const, country: "US", personId: pid };
  const first = runStack([j], make(excluded), rate, tag, false);
  const f = first.outputs[0]?.facts ?? {};
  const deduction = ((f["us.deduction"] ?? 0) + (f["us.seniorDeduction"] ?? 0)) * rate;
  const r = runStack([j], make(excluded + deduction), rate, tag, false);
  return r.lines.filter((l) => l.kind === "income").reduce((s, l) => s + l.amount, 0);
}

function residenceStack(ctx: EngineContext, ps: PeriodState, loc: Location): TaxJurisdiction[] {
  try {
    return ctx.registry
      .resolveStack({ ...ps.tax, mode: "estimate" }, loc)
      .filter((j) => j.status === "implemented");
  } catch {
    warnOnce(ctx, `no-preset:${loc.country}`, {
      code: "ASSUMPTION",
      severity: "warning",
      message: `Glideworth has no tax preset for ${loc.country}: income tax where you live is not included.`,
      periodIndex: ps.bounds.index,
      refs: [],
    });
    return [];
  }
}

function nationalJurisdiction(ctx: EngineContext, country: string): TaxJurisdiction | null {
  const id = NATIONAL_JURISDICTION_BY_COUNTRY[country];
  if (!id) return null;
  try {
    const j = ctx.registry.get(id);
    return j.status === "implemented" ? j : null;
  } catch {
    return null;
  }
}

function warnUnknownTreaty(ctx: EngineContext, a: string, b: string): void {
  const [x, y] = a < b ? [a, b] : [b, a];
  warnOnce(ctx, `treaty:${x}:${y}`, {
    code: "ASSUMPTION",
    severity: "warning",
    message: `No tax treaty between ${x} and ${y} is in Glideworth's tables: both countries tax under their own rules and the country of residence gives a credit for the other's tax. Check the actual treaty.`,
    periodIndex: null,
    refs: [],
  });
}

// ------------------------------------------------------------------ the computation

interface Options {
  explain?: boolean;
  /** Extra ordinary income for the primary person (finite-difference marginal rate). */
  extra?: number;
}

export function crossBorderTaxes(
  ctx: EngineContext,
  ps: PeriodState,
  base0: TaxYearInput,
  opts: Options = {},
): CrossBorderResult {
  const explain = !!opts.explain;
  const allPeople = base0.people;
  const aliveP = allPeople.filter((p) => p.alive);
  const alivePeople = aliveP.length > 0 ? aliveP : allPeople.slice(0, 1);
  const alive = alivePeople.map((p) => p.id);
  const primary = (alivePeople.find((p) => p.role === "primary") ?? alivePeople[0]!).id;
  const input: TaxYearInput = opts.extra
    ? {
        ...base0,
        income: [
          ...base0.income,
          {
            sourceId: "__marginal__",
            owner: primary,
            character: "ordinary",
            amount: opts.extra,
            exemptIn: [],
          },
        ],
      }
    : base0;
  const st = ctx.crossBorder!;
  const overrides = ctx.plan.tax.crossBorder?.wrapperRecognition;
  const location = ps.location;
  const R = location.country;

  const incomeInfo = input.income.map((it) => classifyIncome(ctx, ps, it));
  const wInfo = input.withdrawals.map((w) => classifyWithdrawal(ctx, ps, w));
  const dInfo = input.deductions.map((d) => classifyDeduction(ctx, ps, d));

  const lines: TaxLine[] = [];
  const outputs: TaxYearOutput[] = [];
  const brackets: BracketFill[] = [];
  const facts: Record<string, number> = {};
  const byCountry = new Map<string, number>();
  let rasTopUp = 0;
  const add = (country: string, basis: Basis, amount: number) => {
    if (amount === 0) return;
    const k = `${country}|${basis}`;
    byCountry.set(k, (byCountry.get(k) ?? 0) + amount);
  };
  const collect = (r: RunOut, country: string, basis: Basis, rate: number) => {
    lines.push(...r.lines);
    outputs.push(...r.outputs);
    brackets.push(...r.brackets);
    add(country, basis, r.total);
    for (const o of r.outputs)
      for (const [k, v] of Object.entries(o.facts)) {
        if (k === "uk.reliefAtSourceTopUp") rasTopUp += v * rate;
        else facts[k] = v;
      }
  };
  const people = (ids: string[]): TaxPerson[] => alivePeople.filter((p) => ids.includes(p.id));

  /** Items of `ids` for a computation: the `keep*` callbacks decide inclusion. */
  const itemsFor = (
    ids: string[],
    keepIncome: (info: ItemInfo) => boolean,
    keepWithdrawal: (info: ItemInfo, w: TaxWithdrawalItem) => TaxWithdrawalItem | null,
    keepDeduction: (info: ItemInfo) => boolean,
  ) => {
    const single = ids.length === 1 ? ids[0]! : null;
    const owner = (o: string) => single ?? o;
    const income: TaxIncomeItem[] = [];
    input.income.forEach((it, i) => {
      const s = share(it.owner, ids, alive);
      if (!(s > 0) || !keepIncome(incomeInfo[i]!)) return;
      income.push({ ...it, owner: owner(it.owner), amount: it.amount * s });
    });
    const withdrawals: TaxWithdrawalItem[] = [];
    input.withdrawals.forEach((w0, i) => {
      const s = share(w0.owner, ids, alive);
      if (!(s > 0)) return;
      const w = keepWithdrawal(wInfo[i]!, w0);
      if (!w) return;
      withdrawals.push({
        ...w,
        owner: owner(w.owner),
        amount: w.amount * s,
        taxableAmount: w.taxableAmount * s,
      });
    });
    const deductions: TaxDeductionItem[] = [];
    input.deductions.forEach((d, i) => {
      const s = share(d.owner, ids, alive);
      if (!(s > 0) || !keepDeduction(dInfo[i]!)) return;
      deductions.push({ ...d, owner: owner(d.owner), amount: d.amount * s });
    });
    return { income, withdrawals, deductions };
  };

  // ---- residence
  const residenceKeeps = (info: ItemInfo) => {
    if (!info.category || info.country === R || !info.country) return true;
    const d = treatyRule(R, info.country, info.category, {
      nationalOfResidence: isNational(ctx, alive[0]!, R),
    });
    if (!d.known) warnUnknownTreaty(ctx, R, info.country);
    return d.residenceTaxes;
  };
  const resItems = itemsFor(
    alive,
    residenceKeeps,
    (info, w) => {
      if (info.country === R) return w;
      if (!residenceKeeps(info)) return null;
      const view = wrapperView(R, info.country, w.accountType, w.treatment, overrides);
      const type = genericType(w.treatment, w.accountType);
      if (w.treatment === "tax-free" && !view.recognised) {
        const a = ctx.accountById.get(w.accountId);
        const earnings = a ? wrapperEarningsShare(ctx, a) : 1;
        return {
          ...w,
          accountType: "taxable",
          treatment: "taxable",
          character: "capital-gains-long",
          taxableAmount: w.amount * earnings,
        };
      }
      if (w.treatment === "tax-deferred" && !view.lumpSumTaxFree && w.amount > w.taxableAmount) {
        const lump = treatyRule(R, info.country, "pension-lump-sum", {});
        if (lump.residenceTaxes) return { ...w, accountType: type, taxableAmount: w.amount };
      }
      return { ...w, accountType: type };
    },
    (info) => {
      if (info.follows === "rental")
        return info.country === R || residenceKeeps({ ...info, category: "rental" });
      if (info.accountId) return info.country === R;
      return true;
    },
  );
  // Pay for work done abroad is income here but not subject to this country's payroll taxes
  // (UK National Insurance, US FICA): it enters the residence calculation as ordinary income.
  resItems.income = resItems.income.map((it) => {
    if (it.character !== "wage") return it;
    const info = classifyIncome(ctx, ps, it);
    if (info.country === R) return it;
    const conv: TaxIncomeItem = { ...it, character: "ordinary" };
    KEEP_INFO.set(conv, info);
    return conv;
  });
  const resStack = residenceStack(ctx, ps, location);
  const resRate = taxRate(ctx, ps, R);
  const rInput: TaxYearInput = { ...input, ...resItems, people: alivePeople, location };
  if (R !== "US") delete (rInput as { aca?: unknown }).aca;
  const res = runStack(
    resStack,
    rInput,
    resRate,
    { basis: "residence", country: R, ...(alive.length === 1 ? { personId: alive[0] } : {}) },
    explain,
  );
  collect(res, R, "residence", resRate);
  const residenceTax = { total: res.total, stack: resStack, rate: resRate, input: rInput };

  // ---- source
  const sourceTaxOf = new Map<string, number>();
  const sourceItemsOf = new Map<string, (info: ItemInfo) => boolean>();
  const sources = new Set<string>();
  for (const info of [...incomeInfo, ...wInfo])
    if (info.country && info.country !== R) sources.add(info.country);
  for (const S of sources) {
    const nr = NON_RESIDENT_RULES[S];
    if (!nr) continue;
    for (const pid of alive) {
      if (S === "US" && st.usPersons.has(pid)) continue; // taxed through citizenship below
      const nationalR = isNational(ctx, pid, R);
      const decide = (info: ItemInfo) => {
        if (info.country !== S || !info.category) return null;
        const rule = nr.rules[info.category];
        if (!rule.taxed) return null;
        const d = treatyRule(R, S, info.category, { nationalOfResidence: nationalR });
        if (!d.sourceMayTax) return null;
        return { rule, cap: d.rule.maxSourceRate };
      };
      sourceItemsOf.set(S, (info) => decide(info) !== null);
      const flatTax = { amount: 0, byCat: new Map<IncomeCategory, number>() };
      const isFlat = (info: ItemInfo) => decide(info)?.rule.method === "flat";
      const items = itemsFor(
        [pid],
        (info) => {
          const d = decide(info);
          return !!d && d.rule.method !== "flat";
        },
        (info, w) => {
          const d = decide(info);
          if (!d || d.rule.method === "flat") return null;
          if (w.treatment === "tax-deferred" && !nr.pensionLumpSumTaxFree)
            return { ...w, taxableAmount: w.amount };
          return w;
        },
        (info) => (info.follows === "rental" || !!info.accountId) && info.country === S,
      );
      if (nr.propertyGainsExemptAfterYears)
        items.income = items.income.filter(
          (it) => !heldLongerThan(ctx, it, nr.propertyGainsExemptAfterYears! * 12),
        );
      // Flat-rate items (final withholding).
      input.income.forEach((it, i) => {
        const info = incomeInfo[i]!;
        if (!isFlat(info)) return;
        const s = share(it.owner, [pid], alive);
        if (!(s > 0)) return;
        const d = decide(info)!;
        const rate = Math.min(flatRateFor(d.rule, R), d.cap ?? Number.POSITIVE_INFINITY);
        const t = it.amount * s * rate;
        flatTax.amount += t;
        flatTax.byCat.set(info.category!, (flatTax.byCat.get(info.category!) ?? 0) + t);
      });
      input.withdrawals.forEach((w, i) => {
        const info = wInfo[i]!;
        if (!isFlat(info)) return;
        const s = share(w.owner, [pid], alive);
        if (!(s > 0)) return;
        const d = decide(info)!;
        const rate = Math.min(flatRateFor(d.rule, R), d.cap ?? Number.POSITIVE_INFINITY);
        const t = (nr.pensionLumpSumTaxFree ? w.taxableAmount : w.amount) * s * rate;
        flatTax.amount += t;
        flatTax.byCat.set(info.category!, (flatTax.byCat.get(info.category!) ?? 0) + t);
      });
      const jid = NATIONAL_JURISDICTION_BY_COUNTRY[S] ?? S.toLowerCase();
      for (const [cat, t] of flatTax.byCat)
        if (t !== 0) {
          lines.push({
            jurisdictionId: jid,
            kind:
              cat === "dividends"
                ? "dividends"
                : cat.startsWith("gains")
                  ? "capital-gains"
                  : "income",
            label: `${nr.label} non-resident tax on ${cat.replace(/-/g, " ")} (${personName(ctx, pid)})`,
            amount: t,
            basis: "source",
            country: S,
            personId: pid,
          });
          add(S, "source", t);
        }
      let total = flatTax.amount;
      // Resident-rate items through the national plug-in, as a non-resident.
      if (items.income.length + items.withdrawals.length > 0) {
        const j = nationalJurisdiction(ctx, S);
        if (j) {
          // Non-resident property gains: rebasing / time apportionment.
          if (nr.propertyGains) applyPropertyRebasing(ctx, ps, items.income, nr.propertyGains);
          const rate = taxRate(ctx, ps, S);
          const pa = paEntitled(ctx, pid, nr);
          const sInput: TaxYearInput = {
            ...input,
            ...items,
            people: people([pid]),
            location: { country: S },
            filingStatus: "single",
            nonResident: { personalAllowance: { [pid]: pa } },
          };
          delete (sInput as { wealth?: unknown }).wealth;
          delete (sInput as { aca?: unknown }).aca;
          delete (sInput as { transactions?: unknown }).transactions;
          let r = runStack(
            [j],
            sInput,
            rate,
            { basis: "source", country: S, personId: pid, suffix: " (non-resident)" },
            explain,
          );
          if (nr.disregardedIncome) {
            const dis = new Set(nr.disregardedIncome.categories);
            const limited: TaxYearInput = {
              ...sInput,
              income: sInput.income.filter((it) => !dis.has(categoryFor(ctx, ps, it))),
              nonResident: { personalAllowance: { [pid]: false } },
            };
            const alt = runStack(
              [j],
              limited,
              rate,
              {
                basis: "source",
                country: S,
                personId: pid,
                suffix: " (non-resident, disregarded income limit)",
              },
              explain,
            );
            if (alt.total < r.total - 1e-9) r = alt;
          }
          collect(r, S, "source", rate);
          total += r.total;
        }
      }
      if (total !== 0) sourceTaxOf.set(S, (sourceTaxOf.get(S) ?? 0) + total);
    }
  }

  // ---- relief: the residence country credits source tax on the same income
  if (residenceTax.stack.length > 0 && residenceTax.total > 0)
    for (const [S, srcTax] of sourceTaxOf) {
      if (!(srcTax > 0)) continue;
      const taxedThere = sourceItemsOf.get(S)!;
      const without: TaxYearInput = {
        ...residenceTax.input,
        income: residenceTax.input.income.filter((it) => !taxedThere(classifyIncome(ctx, ps, it))),
        withdrawals: residenceTax.input.withdrawals.filter(
          (w) => !taxedThere(classifyWithdrawal(ctx, ps, w)),
        ),
      };
      const attributable = Math.max(
        0,
        residenceTax.total - totalOf(residenceTax.stack, without, residenceTax.rate),
      );
      const credit = Math.min(srcTax, attributable);
      if (credit > 1e-9) {
        lines.push({
          jurisdictionId: residenceTax.stack[0]!.id,
          kind: "credit",
          label: `Foreign tax credit (${S} tax on ${S} income)`,
          amount: -credit,
          basis: "relief",
          country: R,
          ...(alive.length === 1 ? { personId: alive[0] } : {}),
        });
        add(R, "relief", -credit);
        residenceTax.total -= credit;
      }
    }

  // ---- citizenship-based taxation (US)
  const usFed = st.usPersons.size > 0 && R !== "US" ? nationalJurisdiction(ctx, "US") : null;
  if (usFed)
    for (const pid of alive) {
      if (!st.usPersons.has(pid)) continue;
      const rate = taxRate(ctx, ps, "US");
      // Saving clause: everything is taxed except what the treaty with the residence country keeps
      // for citizens (US Social Security of a UK or Canadian resident: only there).
      const usMayTax = (info: ItemInfo) =>
        !info.category || citizenshipMayTax("US", R, info.country, info.category);
      const items = itemsFor(
        [pid],
        usMayTax,
        (info, w) => {
          if (!usMayTax(info)) return null;
          if (info.country === "US") return w;
          const view = wrapperView("US", info.country, w.accountType, w.treatment, overrides);
          if (w.treatment === "tax-free" && !view.recognised) {
            const a = ctx.accountById.get(w.accountId);
            const earnings = a ? wrapperEarningsShare(ctx, a) : 1;
            return {
              ...w,
              accountType: "taxable",
              treatment: "taxable",
              character: "capital-gains-long",
              taxableAmount: w.amount * earnings,
            };
          }
          if (w.treatment === "tax-deferred" && !view.lumpSumTaxFree)
            return {
              ...w,
              accountType: genericType(w.treatment, w.accountType),
              taxableAmount: w.amount,
            };
          return { ...w, accountType: genericType(w.treatment, w.accountType) };
        },
        (info) => !info.accountId || info.country === "US",
      );
      const countryOf = (it: TaxIncomeItem) => classifyIncome(ctx, ps, it).country;
      // Foreign earned income exclusion (prorated by the period's months).
      const feieRow = NON_RESIDENT_RULES.US!.citizenshipTaxation!.foreignEarnedIncomeExclusion;
      const feieUsd =
        [...feieRow].reverse().find((r) => r.year <= ps.bounds.year)?.amount ?? feieRow[0]!.amount;
      // Later years than the table: the last amount, indexed with the plan's inflation.
      const lastRow = feieRow[feieRow.length - 1]!;
      const feie =
        feieUsd * rate * (ps.bounds.months / 12) * (ps.bounds.year > lastRow.year ? ps.piStart : 1);
      const isForeignEarned = (it: TaxIncomeItem) =>
        (it.character === "wage" || it.character === "self-employment") && countryOf(it) !== "US";
      let foreignEarned = 0;
      for (const it of items.income) if (isForeignEarned(it)) foreignEarned += it.amount;
      const excluded = Math.min(foreignEarned, feie);
      let grossIncome = 0;
      for (const it of items.income) grossIncome += it.amount;
      for (const w of items.withdrawals) grossIncome += w.taxableAmount;
      const fs = base0.filingStatus;
      // Stacking rule (Form 2555): tax = tax on all income including the excluded pay, less the
      // tax at the same rates on the excluded amount alone, so the rest is taxed at the rates that
      // would apply without the exclusion.
      const uInput: TaxYearInput = {
        ...input,
        ...items,
        people: people([pid]),
        location: { country: "US" },
        filingStatus:
          fs === "married-joint" || fs === "married-separate" ? "married-separate" : "single",
      };
      delete (uInput as { wealth?: unknown }).wealth;
      delete (uInput as { aca?: unknown }).aca;
      const full = runStack(
        [usFed],
        uInput,
        rate,
        { basis: "citizenship", country: "US", personId: pid, suffix: " (US citizen abroad)" },
        explain,
      );
      const exclusionTax =
        excluded > 0
          ? Math.min(ordinaryTaxOnExcluded(usFed, uInput, pid, excluded, rate), full.total)
          : 0;
      const usSourceOnly: TaxYearInput = {
        ...uInput,
        income: uInput.income.filter((it) => countryOf(it) === "US"),
        withdrawals: uInput.withdrawals.filter(
          (w) => classifyWithdrawal(ctx, ps, w).country === "US",
        ),
      };
      // Foreign tax credit limit: the US income tax (after the exclusion) on foreign income.
      const creditable =
        full.total -
        exclusionTax -
        full.lines.filter((l) => NOT_CREDITABLE.has(l.kind)).reduce((s, l) => s + l.amount, 0);
      const limit = Math.max(0, creditable - totalOf([usFed], usSourceOnly, rate, NOT_CREDITABLE));
      // Foreign tax paid by this person: their share of the residence tax plus other source taxes,
      // less the part on pay excluded under the FEIE, which cannot be credited (Publication 514:
      // pro rata to the income the foreign tax was charged on).
      // Social security contributions (UK National Insurance and the like) are left out: no credit
      // is allowed for those paid to a country with a US social security agreement (Publication 514).
      const residenceContributions = lines
        .filter((l) => l.basis === "residence" && SOCIAL_CONTRIBUTIONS.has(l.kind))
        .reduce((s, l) => s + l.amount, 0);
      let foreignPaid = Math.max(0, residenceTax.total - residenceContributions) / alive.length;
      for (const l of lines)
        if (
          l.basis === "source" &&
          l.personId === pid &&
          l.country !== "US" &&
          !SOCIAL_CONTRIBUTIONS.has(l.kind)
        )
          foreignPaid += l.amount;
      if (excluded > 0 && grossIncome > 0) foreignPaid *= Math.max(0, 1 - excluded / grossIncome);
      const ftc = Math.min(foreignPaid, limit);
      collect(full, "US", "citizenship", rate);
      if (exclusionTax > 1e-9) {
        lines.push({
          jurisdictionId: usFed.id,
          kind: "income",
          label: `Foreign earned income exclusion (${personName(ctx, pid)})`,
          amount: -exclusionTax,
          base: excluded,
          basis: "citizenship",
          country: "US",
          personId: pid,
        });
        add("US", "citizenship", -exclusionTax);
      }
      if (excluded > 0) facts[`us.feie.${pid}`] = excluded;
      if (ftc > 1e-9) {
        lines.push({
          jurisdictionId: usFed.id,
          kind: "credit",
          label: `Foreign tax credit (${R} and other foreign tax) (${personName(ctx, pid)})`,
          amount: -ftc,
          basis: "relief",
          country: "US",
          personId: pid,
        });
        add("US", "relief", -ftc);
      }
      // The residence country credits US tax on US-source income (US tax not on foreign income).
      const usNet = full.total - exclusionTax;
      const usSourceTax = Math.max(0, Math.min(usNet - ftc, totalOf([usFed], usSourceOnly, rate)));
      if (usSourceTax > 1e-9 && residenceTax.stack.length > 0 && residenceTax.total > 0) {
        const without: TaxYearInput = {
          ...residenceTax.input,
          income: residenceTax.input.income.filter((it) => countryOf(it) !== "US"),
          withdrawals: residenceTax.input.withdrawals.filter(
            (w) => classifyWithdrawal(ctx, ps, w).country !== "US",
          ),
        };
        const attributable = Math.max(
          0,
          residenceTax.total - totalOf(residenceTax.stack, without, residenceTax.rate),
        );
        const credit = Math.min(usSourceTax, attributable);
        if (credit > 1e-9) {
          lines.push({
            jurisdictionId: residenceTax.stack[0]!.id,
            kind: "credit",
            label: `Foreign tax credit (US tax on US income) (${personName(ctx, pid)})`,
            amount: -credit,
            basis: "relief",
            country: R,
            personId: pid,
          });
          add(R, "relief", -credit);
          residenceTax.total -= credit;
        }
      }
    }

  if (rasTopUp !== 0) facts["uk.reliefAtSourceTopUp"] = rasTopUp;
  let total = 0;
  for (const l of lines) total += l.amount;
  return {
    total,
    lines,
    outputs,
    grossIncome: res.gross,
    taxableIncome: res.taxable,
    facts,
    byCountry: [...byCountry].map(([k, amount]) => {
      const [country, basis] = k.split("|") as [string, Basis];
      return { country, basis, amount };
    }),
    ...(explain ? { brackets } : {}),
  };
}

function categoryFor(ctx: EngineContext, ps: PeriodState, it: TaxIncomeItem): IncomeCategory {
  return classifyIncome(ctx, ps, it).category ?? "other";
}

function paEntitled(
  ctx: EngineContext,
  pid: string,
  nr: (typeof NON_RESIDENT_RULES)[string],
): boolean {
  const pa = nr.personalAllowance;
  if (pa.kind === "all") return true;
  if (pa.kind === "none") return false;
  const cit = ctx.crossBorder?.citizenships.get(pid);
  return !!cit && (pa.citizens ?? []).some((c) => cit.has(c));
}

/**
 * Non-resident gain on property in a country with rebasing (UK NRCGT): the lowest of the gain over
 * the valuation at the rebasing date (when the asset has one), the time-apportioned gain (when the
 * acquisition month is known) and the whole gain. Scales the item by the same exclusions the engine
 * applied (gain reduction, main-home relief).
 */
function applyPropertyRebasing(
  ctx: EngineContext,
  ps: PeriodState,
  income: TaxIncomeItem[],
  rule: NonNullable<(typeof NON_RESIDENT_RULES)[string]["propertyGains"]>,
): void {
  for (let i = 0; i < income.length; i++) {
    const it = income[i]!;
    if (!it.sale || !(it.sale.gain > 0)) continue;
    const r = ctx.assets.find((x) => x.def.id === it.sale!.assetId);
    if (!r) continue;
    const commercial =
      r.def.type === "commercial-property" ||
      r.behaviour.rental?.taxSettings.classification === "commercial";
    const rebaseMonth = parseYm(commercial ? rule.rebasing.commercial : rule.rebasing.residential);
    const acquired = r.acquiredAt ?? (r.def.acquiredOn ? parseYm(r.def.acquiredOn) : null);
    const whole = it.sale.gain;
    const options = [whole];
    if (acquired !== null && acquired >= rebaseMonth) {
      // Bought after the rebasing date: the whole gain is in scope.
    } else {
      const val = r.def.valuations?.find((v) => parseYm(v.month) === rebaseMonth);
      if (val) {
        const fx = r.currency ? fxAt(ctx, r.currency, ps.bounds.start) : 1;
        options.push(Math.max(0, it.sale.proceeds - val.value * fx));
      }
      if (rule.timeApportionment && acquired !== null) {
        const owned = it.sale.month - acquired;
        const after = it.sale.month - rebaseMonth;
        if (owned > 0) options.push((whole * Math.max(0, Math.min(owned, after))) / owned);
      }
    }
    const chargeable = Math.min(...options);
    const k = whole > 0 ? it.amount / whole : 0;
    income[i] = { ...it, amount: chargeable * k };
  }
}

/** A property gain on an asset owned for more than `months` (false when the purchase month is unknown). */
function heldLongerThan(ctx: EngineContext, it: TaxIncomeItem, months: number): boolean {
  if (!it.sale) return false;
  const r = ctx.assets.find((x) => x.def.id === it.sale!.assetId);
  if (!r) return false;
  const acquired = r.acquiredAt ?? (r.def.acquiredOn ? parseYm(r.def.acquiredOn) : null);
  return acquired !== null && it.sale.month - acquired > months;
}

function parseYm(m: string): number {
  const [y, mo] = m.split("-").map(Number) as [number, number];
  return y * 12 + mo - 1;
}

/** A person's name for tax-line labels (the id when unknown). */
function personName(ctx: EngineContext, pid: string): string {
  return ctx.people.find((p) => p.id === pid)?.name ?? pid;
}
