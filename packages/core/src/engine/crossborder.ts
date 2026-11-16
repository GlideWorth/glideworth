/**
 * Cross-border tax for one period (ARCHITECTURE.md §4.6). Replaces the single jurisdiction stack
 * when the run is cross-border (engine/residency.ts):
 *
 *   per person and residence segment:
 *     residence tax  = the residence country's stack on worldwide income (items exempt there under
 *                      a treaty removed; foreign wrappers seen the residence country's way);
 *     source tax     = each other country's non-resident rules on items sourced there (treaty
 *                      allocation and rate caps applied);
 *     citizenship tax= US federal tax of US citizens / green-card holders living abroad (foreign
 *                      earned income exclusion + foreign tax credit);
 *     relief         = credit in the residence country for source tax on the same income, limited to
 *                      the residence tax on it (difference method).
 *
 * Split years are prorated: each residence segment is taxed on its share (months / period months)
 * of every item, with its thresholds prorated by the plug-in (`months`). Exit and return charges
 * (pinned items) go to one country in full. Money is converted into each jurisdiction's currency
 * with the plan's FX table at the period start and the tax converted back.
 */
import type { AccountType, TaxTreatment } from "../schema/accounts.js";
import type { Location } from "../schema/household.js";
import { COUNTRY_TAX_CURRENCY } from "../tax/crossborder/currency.js";
import { NON_RESIDENT_RULES } from "../tax/crossborder/nonresident.js";
import { treatyRule } from "../tax/crossborder/treaties.js";
import type { IncomeCategory } from "../tax/crossborder/types.js";
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
import { resolveWindow } from "./amounts.js";
import { type EngineContext, type PeriodState, warnOnce } from "./context.js";
import { fxAt } from "./indices.js";
import {
  isNational,
  residenceAt,
  sameLocation,
  warnFxMissing,
  wrapperEarningsShare,
} from "./residency.js";
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
  /** Income events: the months the event runs (a split year gives each residence its months). */
  window?: { start: number; end: number };
  /** One-off income paid in this month (goes to the residence of that month). */
  onceAt?: number;
}

type Basis = NonNullable<TaxLine["basis"]>;

export interface CrossBorderResult {
  total: number;
  lines: TaxLine[];
  outputs: TaxYearOutput[];
  grossIncome: number;
  taxableIncome: number;
  facts: Record<string, number>;
  residence: Record<string, { country: string; region?: string; months: number }[]>;
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

function ownerResidence(ctx: EngineContext, ps: PeriodState, owner: string, at?: number): string {
  const id = ctx.people.some((p) => p.id === owner)
    ? owner
    : (ctx.people.find((p) => p.role === "primary") ?? ctx.people[0]!).id;
  const m = Math.max(ps.bounds.start, Math.min(ps.bounds.end - 1, at ?? ps.bounds.start));
  return residenceAt(ctx, id, m).country;
}

/** Share of a period item that belongs to a residence segment [g.from, g.from + g.months). */
function fractionIn(
  info: ItemInfo | undefined,
  g: { from: number; months: number },
  ps: PeriodState,
): number {
  const lo = g.from;
  const hi = g.from + g.months;
  if (g.months >= ps.bounds.months) return 1;
  if (info?.onceAt !== undefined) {
    const m = Math.max(ps.bounds.start, Math.min(ps.bounds.end - 1, info.onceAt));
    return m >= lo && m < hi ? 1 : 0;
  }
  if (info?.window) {
    const a = Math.max(info.window.start, ps.bounds.start);
    const b = Math.min(info.window.end, ps.bounds.end);
    if (b > a) return Math.max(0, Math.min(b, hi) - Math.max(a, lo)) / (b - a);
  }
  return g.months / ps.bounds.months;
}

/** Items whose character was changed for one computation keep their original classification. */
const KEEP_INFO = new WeakMap<TaxIncomeItem, ItemInfo>();

export function classifyIncome(ctx: EngineContext, ps: PeriodState, it: TaxIncomeItem): ItemInfo {
  const kept = KEEP_INFO.get(it);
  if (kept) return kept;
  const key = `i|${it.sourceId}|${it.character}|${it.owner}`;
  const hit = ps.itemInfo?.get(key);
  if (hit) return hit;
  const info = classifyIncomeUncached(ctx, ps, it);
  ps.itemInfo?.set(key, info);
  return info;
}

function classifyIncomeUncached(ctx: EngineContext, ps: PeriodState, it: TaxIncomeItem): ItemInfo {
  if (it.pin) return { country: it.pin.country, category: "gains-securities" };
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
    const earned = category === "employment" || category === "self-employment";
    const w = resolveWindow(ctx, e.range);
    const gratuity = it.sourceId.endsWith(":gratuity");
    const once = gratuity ? w.end : e.frequency === "once" ? w.start : null;
    // Pay is sourced where the work is done: the owner's residence in the months it is earned.
    const country =
      e.country ??
      (earned ? ownerResidence(ctx, ps, it.owner, once ?? w.start ?? ps.bounds.start) : base(ctx));
    return {
      country,
      category,
      ...(e.governmentService ? { government: true } : {}),
      ...(once !== null && Number.isFinite(once) ? { onceAt: once } : {}),
      ...(w.start !== null && !db ? { window: { start: w.start, end: w.end } } : {}),
    };
  }
  return {
    country: ownerResidence(ctx, ps, it.owner),
    category: categoryOfCharacter(it.character),
  };
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

function totalOf(stack: readonly TaxJurisdiction[], input: TaxYearInput, rate: number): number {
  const conv = scaleInput(input, 1 / rate);
  const outputs: TaxYearOutput[] = [];
  let t = 0;
  for (const j of stack) {
    const o = j.computeYear(conv, outputs);
    outputs.push(o);
    for (const l of o.lines) t += l.amount;
  }
  return t * rate;
}

function residenceStack(ctx: EngineContext, ps: PeriodState, loc: Location): TaxJurisdiction[] {
  const config = loc.country === base(ctx) ? ps.tax : { ...ps.tax, jurisdictions: [] as string[] };
  try {
    return ctx.registry
      .resolveStack({ ...config, mode: "estimate" }, loc)
      .filter((j) => j.status === "implemented");
  } catch {
    warnOnce(ctx, `no-preset:${loc.country}`, {
      code: "ASSUMPTION",
      severity: "warning",
      message: `Glideworth has no tax preset for ${loc.country}: income tax there is not included while you live there.`,
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

interface Group {
  people: string[];
  location: Location;
  from: number;
  months: number;
}

function groupsOf(ctx: EngineContext, ps: PeriodState, alive: string[]): Group[] {
  const groups: Group[] = [];
  for (const id of alive) {
    for (const s of ps.residence?.get(id) ?? []) {
      const g = groups.find(
        (x) =>
          x.from === s.from && x.months === s.to - s.from && sameLocation(x.location, s.location),
      );
      if (g) g.people.push(id);
      else groups.push({ people: [id], location: s.location, from: s.from, months: s.to - s.from });
    }
  }
  void ctx;
  return groups;
}

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
  const months = ps.bounds.months;
  const st = ctx.residency!;
  const overrides = ctx.plan.tax.crossBorder?.wrapperRecognition;

  const incomeInfo = input.income.map((it) => classifyIncome(ctx, ps, it));
  const wInfo = input.withdrawals.map((w) => classifyWithdrawal(ctx, ps, w));
  const dInfo = input.deductions.map((d) => classifyDeduction(ctx, ps, d));

  const lines: TaxLine[] = [];
  const outputs: TaxYearOutput[] = [];
  const brackets: BracketFill[] = [];
  const facts: Record<string, number> = {};
  const byCountry = new Map<string, number>();
  let gross = 0;
  let taxable = 0;
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
  const pinnedUsed = new Set<number>();

  /** Items of `ids` for a computation: `keep` decides inclusion and returns the amount factor. */
  const itemsFor = (
    ids: string[],
    g: { from: number; months: number },
    R: string,
    keepIncome: (info: ItemInfo, it: TaxIncomeItem, i: number) => boolean,
    keepWithdrawal: (info: ItemInfo, w: TaxWithdrawalItem) => TaxWithdrawalItem | null,
    keepDeduction: (info: ItemInfo, d: TaxDeductionItem) => boolean,
    pinnedBasis: "residence" | "none",
  ) => {
    const single = ids.length === 1 ? ids[0]! : null;
    const owner = (o: string) => single ?? o;
    const income: TaxIncomeItem[] = [];
    input.income.forEach((it, i) => {
      const s = share(it.owner, ids, alive);
      if (!(s > 0)) return;
      const info = incomeInfo[i]!;
      if (it.pin) {
        if (
          pinnedBasis !== "residence" ||
          it.pin.country !== R ||
          pinnedUsed.has(i) ||
          !ids.includes(it.owner)
        )
          return;
        pinnedUsed.add(i);
        income.push({ ...it, owner: owner(it.owner) });
        return;
      }
      if (!keepIncome(info, it, i)) return;
      const f = fractionIn(info, g, ps);
      if (!(f > 0)) return;
      income.push({ ...it, owner: owner(it.owner), amount: it.amount * s * f });
    });
    const withdrawals: TaxWithdrawalItem[] = [];
    input.withdrawals.forEach((w0, i) => {
      const s = share(w0.owner, ids, alive);
      if (!(s > 0)) return;
      const w = keepWithdrawal(wInfo[i]!, w0);
      if (!w) return;
      const f = g.months / months;
      withdrawals.push({
        ...w,
        owner: owner(w.owner),
        amount: w.amount * s * f,
        taxableAmount: w.taxableAmount * s * f,
      });
    });
    const deductions: TaxDeductionItem[] = [];
    input.deductions.forEach((d, i) => {
      const s = share(d.owner, ids, alive);
      if (!(s > 0) || !keepDeduction(dInfo[i]!, d)) return;
      deductions.push({ ...d, owner: owner(d.owner), amount: (d.amount * s * g.months) / months });
    });
    return { income, withdrawals, deductions };
  };

  const groups = groupsOf(ctx, ps, alive);
  const residenceTax = new Map<
    Group,
    { total: number; stack: TaxJurisdiction[]; rate: number; input: TaxYearInput }
  >();

  // ---- residence
  for (const g of groups) {
    const R = g.location.country;
    const national = (id: string) => isNational(ctx, id, R);
    const residenceKeeps = (info: ItemInfo) => {
      if (!info.category || info.country === R || !info.country) return true;
      const d = treatyRule(R, info.country, info.category, {
        nationalOfResidence: national(g.people[0]!),
      });
      if (!d.known) warnUnknownTreaty(ctx, R, info.country);
      return d.residenceTaxes;
    };
    const items = itemsFor(
      g.people,
      g,
      R,
      (info) => residenceKeeps(info),
      (info, w) => {
        if (info.country === R) return w;
        if (!residenceKeeps(info)) return null;
        const view = wrapperView(R, info.country, w.accountType, w.treatment, overrides);
        const type = genericType(w.treatment, w.accountType);
        if (w.treatment === "tax-free" && !view.recognised) {
          const a = ctx.accountById.get(w.accountId);
          const share = a ? wrapperEarningsShare(ctx, a) : 1;
          return {
            ...w,
            accountType: "taxable",
            treatment: "taxable",
            character: "capital-gains-long",
            taxableAmount: w.amount * share,
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
      "residence",
    );
    // Pay for work done abroad is income here but not subject to this country's payroll taxes
    // (UK National Insurance, US FICA): it enters the residence calculation as ordinary income.
    items.income = items.income.map((it) => {
      if (it.character !== "wage" || it.pin) return it;
      const info = classifyIncome(ctx, ps, it);
      if (info.country === R) return it;
      const conv: TaxIncomeItem = { ...it, character: "ordinary" };
      KEEP_INFO.set(conv, info);
      return conv;
    });
    const stack = residenceStack(ctx, ps, g.location);
    const rate = taxRate(ctx, ps, R);
    const whole = g.people.length === alive.length;
    const fs = base0.filingStatus;
    const rInput: TaxYearInput = {
      ...input,
      ...items,
      people: people(g.people),
      months: g.months,
      location: g.location,
      filingStatus: whole
        ? fs
        : fs === "married-joint" || fs === "married-separate"
          ? "single"
          : fs,
      ...(input.wealth && !whole
        ? {
            wealth: Object.fromEntries(
              Object.entries(input.wealth).map(([k, v]) => [
                k,
                typeof v === "number" ? (v * g.people.length) / alive.length : v,
              ]),
            ) as TaxYearInput["wealth"],
          }
        : {}),
    };
    if (R !== "US") delete (rInput as { aca?: unknown }).aca;
    const r = runStack(
      stack,
      rInput,
      rate,
      {
        basis: "residence",
        country: R,
        ...(g.people.length === 1 ? { personId: g.people[0] } : {}),
      },
      explain,
    );
    // Pinned exit / return charges show their own basis.
    const pinned = items.income.filter((i) => i.pin);
    collect(r, R, "residence", rate);
    if (pinned.length > 0 && stack.length > 0) {
      const without = { ...rInput, income: rInput.income.filter((i) => !i.pin) };
      const charge = r.total - totalOf(stack, without, rate);
      if (Math.abs(charge) > 1e-9) {
        add(R, "residence", -charge);
        add(R, pinned[0]!.pin!.basis, charge);
      }
    }
    gross += r.gross;
    taxable += r.taxable;
    residenceTax.set(g, { total: r.total, stack, rate, input: rInput });
  }

  // ---- source
  const sourceTaxOf = new Map<string, number>(); // `${groupIndex}|${S}` -> tax
  const sourceItemsOf = new Map<string, (info: ItemInfo) => boolean>();
  groups.forEach((g, gi) => {
    const R = g.location.country;
    const f = g.months / months;
    const sources = new Set<string>();
    for (const info of [...incomeInfo, ...wInfo])
      if (info.country && info.country !== R) sources.add(info.country);
    for (const S of sources) {
      const nr = NON_RESIDENT_RULES[S];
      if (!nr) continue;
      for (const pid of g.people) {
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
        sourceItemsOf.set(`${gi}|${S}`, (info) => decide(info) !== null);
        const flatTax = { amount: 0, byCat: new Map<IncomeCategory, number>() };
        const isFlat = (info: ItemInfo) => decide(info)?.rule.method === "flat";
        const items = itemsFor(
          [pid],
          g,
          R,
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
          "none",
        );
        // Flat-rate items (final withholding).
        input.income.forEach((it, i) => {
          const info = incomeInfo[i]!;
          if (!isFlat(info) || it.pin) return;
          const s = share(it.owner, [pid], alive);
          if (!(s > 0)) return;
          const d = decide(info)!;
          const rate = Math.min(d.rule.rate ?? 0, d.cap ?? Number.POSITIVE_INFINITY);
          const t = it.amount * s * fractionIn(info, g, ps) * rate;
          flatTax.amount += t;
          flatTax.byCat.set(info.category!, (flatTax.byCat.get(info.category!) ?? 0) + t);
        });
        input.withdrawals.forEach((w, i) => {
          const info = wInfo[i]!;
          if (!isFlat(info)) return;
          const s = share(w.owner, [pid], alive);
          if (!(s > 0)) return;
          const d = decide(info)!;
          const rate = Math.min(d.rule.rate ?? 0, d.cap ?? Number.POSITIVE_INFINITY);
          const amt = (nr.pensionLumpSumTaxFree ? w.taxableAmount : w.amount) * s * f;
          const t = amt * rate;
          flatTax.amount += t;
          flatTax.byCat.set(info.category!, (flatTax.byCat.get(info.category!) ?? 0) + t);
        });
        const jid = NATIONAL_JURISDICTION_BY_COUNTRY[S] ?? S.toLowerCase();
        for (const [cat, t] of flatTax.byCat)
          if (t !== 0) {
            const l: TaxLine = {
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
            };
            lines.push(l);
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
              months: g.months,
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
        if (total !== 0)
          sourceTaxOf.set(`${gi}|${S}`, (sourceTaxOf.get(`${gi}|${S}`) ?? 0) + total);
      }
    }
  });

  // ---- relief: residence country credits source tax on the same income
  groups.forEach((g, gi) => {
    const rt = residenceTax.get(g)!;
    if (rt.stack.length === 0 || !(rt.total > 0)) return;
    for (const [k, srcTax] of sourceTaxOf) {
      const [idx, S] = k.split("|") as [string, string];
      if (Number(idx) !== gi || !(srcTax > 0)) continue;
      const taxedThere = sourceItemsOf.get(k)!;
      const without: TaxYearInput = {
        ...rt.input,
        income: rt.input.income.filter((it) => it.pin || !taxedThere(classifyIncome(ctx, ps, it))),
        withdrawals: rt.input.withdrawals.filter((w) => {
          const info = classifyWithdrawal(ctx, ps, w);
          return !taxedThere(info);
        }),
      };
      const attributable = Math.max(0, rt.total - totalOf(rt.stack, without, rt.rate));
      const credit = Math.min(srcTax, attributable);
      if (credit > 1e-9) {
        const R = g.location.country;
        lines.push({
          jurisdictionId: rt.stack[0]!.id,
          kind: "credit",
          label: `Foreign tax credit (${S} tax on ${S} income)`,
          amount: -credit,
          basis: "relief",
          country: R,
          ...(g.people.length === 1 ? { personId: g.people[0] } : {}),
        });
        add(R, "relief", -credit);
        rt.total -= credit;
      }
    }
  });

  // ---- citizenship-based taxation (US)
  const usFed = st.usPersons.size > 0 ? nationalJurisdiction(ctx, "US") : null;
  if (usFed)
    for (const g of groups) {
      if (g.location.country === "US") continue;
      const R = g.location.country;
      for (const pid of g.people) {
        if (!st.usPersons.has(pid)) continue;
        const rate = taxRate(ctx, ps, "US");
        const items = itemsFor(
          [pid],
          g,
          "US",
          () => true,
          (info, w) => {
            if (info.country === "US") return w;
            const view = wrapperView("US", info.country, w.accountType, w.treatment, overrides);
            if (w.treatment === "tax-free" && !view.recognised) {
              const a = ctx.accountById.get(w.accountId);
              const sh = a ? wrapperEarningsShare(ctx, a) : 1;
              return {
                ...w,
                accountType: "taxable",
                treatment: "taxable",
                character: "capital-gains-long",
                taxableAmount: w.amount * sh,
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
          "none",
        );
        // Pinned charges in this person's residence segment also count for the US.
        input.income.forEach((it) => {
          if (it.pin && it.owner === pid && it.pin.country === R) items.income.push({ ...it });
        });
        const countryOf = (it: TaxIncomeItem) => classifyIncome(ctx, ps, it).country;
        // Foreign earned income exclusion (prorated by the months abroad).
        const feieRow = NON_RESIDENT_RULES.US!.citizenshipTaxation!.foreignEarnedIncomeExclusion;
        const feieUsd =
          [...feieRow].reverse().find((r) => r.year <= ps.bounds.year)?.amount ??
          feieRow[0]!.amount;
        // Later years than the table: the last amount, indexed with the plan's inflation.
        const lastRow = feieRow[feieRow.length - 1]!;
        const feie =
          feieUsd * rate * (g.months / 12) * (ps.bounds.year > lastRow.year ? ps.piStart : 1);
        let foreignEarned = 0;
        for (const it of items.income)
          if (
            (it.character === "wage" || it.character === "self-employment") &&
            countryOf(it) !== "US"
          )
            foreignEarned += it.amount;
        const excluded = Math.min(foreignEarned, feie);
        const k = foreignEarned > 0 ? 1 - excluded / foreignEarned : 1;
        if (k < 1)
          items.income = items.income.map((it) =>
            (it.character === "wage" || it.character === "self-employment") &&
            countryOf(it) !== "US"
              ? { ...it, amount: it.amount * k }
              : it,
          );
        const fs = base0.filingStatus;
        const uInput: TaxYearInput = {
          ...input,
          ...items,
          people: people([pid]),
          months: g.months,
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
        const foreignOnly = (it: TaxIncomeItem) => countryOf(it) !== "US";
        const usSourceOnly: TaxYearInput = {
          ...uInput,
          income: uInput.income.filter((it) => !foreignOnly(it)),
          withdrawals: uInput.withdrawals.filter(
            (w) => classifyWithdrawal(ctx, ps, w).country === "US",
          ),
        };
        const limit = Math.max(0, full.total - totalOf([usFed], usSourceOnly, rate));
        // Foreign tax paid by this person: their share of the residence tax plus other source taxes.
        const rt = residenceTax.get(g)!;
        const personShare = g.people.length === 1 ? 1 : 1 / g.people.length;
        let foreignPaid = Math.max(0, rt.total) * personShare;
        for (const l of lines)
          if (l.basis === "source" && l.personId === pid && l.country !== "US")
            foreignPaid += l.amount;
        const ftc = Math.min(foreignPaid, limit);
        collect(full, "US", "citizenship", rate);
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
        const usSourceTax = Math.max(0, Math.min(full.total - ftc, full.total - limit));
        if (usSourceTax > 1e-9 && rt.stack.length > 0 && rt.total > 0) {
          const without: TaxYearInput = {
            ...rt.input,
            income: rt.input.income.filter((it) => it.pin || countryOf(it) !== "US"),
            withdrawals: rt.input.withdrawals.filter(
              (w) => classifyWithdrawal(ctx, ps, w).country !== "US",
            ),
          };
          const attributable = Math.max(0, rt.total - totalOf(rt.stack, without, rt.rate));
          const credit = Math.min(usSourceTax, attributable);
          if (credit > 1e-9) {
            lines.push({
              jurisdictionId: rt.stack[0]!.id,
              kind: "credit",
              label: `Foreign tax credit (US tax on US income) (${personName(ctx, pid)})`,
              amount: -credit,
              basis: "relief",
              country: R,
              personId: pid,
            });
            add(R, "relief", -credit);
            rt.total -= credit;
          }
        }
      }
    }

  if (rasTopUp !== 0) facts["uk.reliefAtSourceTopUp"] = rasTopUp;
  let total = 0;
  for (const l of lines) total += l.amount;
  const residence: CrossBorderResult["residence"] = {};
  for (const [id, segs] of ps.residence ?? [])
    residence[id] = segs.map((s) => ({
      country: s.location.country,
      ...(s.location.region ? { region: s.location.region } : {}),
      months: s.to - s.from,
    }));
  return {
    total,
    lines,
    outputs,
    grossIncome: gross,
    taxableIncome: taxable,
    facts,
    residence,
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
  const cit = ctx.residency?.citizenships.get(pid);
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

function parseYm(m: string): number {
  const [y, mo] = m.split("-").map(Number) as [number, number];
  return y * 12 + mo - 1;
}

/** A person's name for tax-line labels (the id when unknown). */
function personName(ctx: EngineContext, pid: string): string {
  return ctx.people.find((p) => p.id === pid)?.name ?? pid;
}
