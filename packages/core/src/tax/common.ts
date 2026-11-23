/**
 * Shared, allocation-light helpers for the tax plug-ins. Everything here is pure.
 */
import type { TaxLine } from "../engine/types.js";
import { ACCOUNT_TYPE_INFO } from "../schema/account-types.js";
import type { BracketFill, ResolvedTaxCharacter, TaxPerson, TaxYearInput } from "./types.js";

/** A rate schedule in absolute thresholds (already indexed and prorated). */
export interface Band {
  /** Lower bound of the band (inclusive). */
  from: number;
  rate: number;
  label?: string;
}

/**
 * Tax on the slice [start, start + amount) of a band schedule. Bands are sorted ascending by
 * `from`; the last band is open-ended. Returns tax and the rate on the last unit of the slice.
 * When `fill` is given, per-band amounts are appended (for bracket-fill analytics).
 */
export function sliceTax(
  bands: readonly Band[],
  start: number,
  amount: number,
  fill?: BracketFill["bands"],
): { tax: number; marginal: number } {
  if (amount <= 0) return { tax: 0, marginal: rateAt(bands, start) };
  const end = start + amount;
  let tax = 0;
  let marginal = bands[0]?.rate ?? 0;
  for (let i = 0; i < bands.length; i++) {
    const b = bands[i]!;
    const lo = b.from;
    const hi = i + 1 < bands.length ? bands[i + 1]!.from : Number.POSITIVE_INFINITY;
    if (end <= lo) break;
    const a = Math.max(lo, start);
    const z = Math.min(hi, end);
    if (z > a) {
      tax += (z - a) * b.rate;
      marginal = b.rate;
      fill?.push({
        label: b.label ?? `${round2(b.rate * 100)}%`,
        rate: b.rate,
        from: lo,
        to: hi,
        amount: z - a,
        tax: (z - a) * b.rate,
      });
    }
  }
  return { tax, marginal };
}

export function rateAt(bands: readonly Band[], x: number): number {
  let r = bands[0]?.rate ?? 0;
  for (const b of bands) if (x >= b.from) r = b.rate;
  return r;
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

/** Bands from [threshold, rate] pairs with a multiplier applied to thresholds. */
export function bands(
  rows: readonly (readonly [number, number])[],
  factor = 1,
  labels?: string[],
): Band[] {
  return rows.map(([from, rate], i) => ({
    from: from * factor,
    rate,
    ...(labels?.[i] ? { label: labels[i] } : {}),
  }));
}

// ----------------------------------------------------------------------------- threshold policy

export type ThresholdPolicy = "legislated" | "indexed" | "frozen";

export function thresholdPolicy(input: TaxYearInput): ThresholdPolicy {
  return input.config.thresholdIndexation ?? "legislated";
}

/**
 * Multiplier applied to nominal thresholds published for a tax year.
 *
 * - frozen: 1 forever (fiscal drag).
 * - indexed: the plan's price index (thresholds keep their real value from the plan start).
 * - legislated: 1 while `frozenThroughYear` lasts (announced freezes), then indexed with inflation
 *   from that point on. The price index at the end of the freeze is remembered in a fact
 *   (`<key>.indexAnchor`) so later periods index from it, not from the plan start.
 *
 * Returns the factor and the fact to publish.
 */
export function indexFactor(
  input: TaxYearInput,
  key: string,
  frozenThroughYear: number | undefined,
): { factor: number; facts: Record<string, number> } {
  const policy = thresholdPolicy(input);
  if (policy === "frozen") return { factor: 1, facts: {} };
  if (policy === "indexed" || frozenThroughYear === undefined)
    return { factor: input.priceIndex, facts: {} };
  const anchorKey = `${key}.indexAnchor`;
  if (input.year <= frozenThroughYear)
    return { factor: 1, facts: { [anchorKey]: input.priceIndex } };
  const last = input.history[input.history.length - 1];
  const anchor = last?.[anchorKey] ?? 1;
  return { factor: input.priceIndex / anchor, facts: { [anchorKey]: anchor } };
}

/** Pick the data row for a year: latest row with startYear <= year (earliest if before all). */
export function pickYear<T extends { startYear: number }>(rows: readonly T[], year: number): T {
  let best = rows[0]!;
  for (const r of rows) if (r.startYear <= year && r.startYear >= best.startYear) best = r;
  return best;
}

// ----------------------------------------------------------------------------- people & owners

export function alivePeople(input: TaxYearInput): TaxPerson[] {
  const alive = input.people.filter((p) => p.alive);
  return alive.length > 0 ? alive : input.people.slice(0, 1);
}

/**
 * The dependents counted this period: the household's own "still a dependent" rule
 * (engine/dependents.ts, carried as `dependent` on the input). Plug-ins apply their own tax-law age
 * tests on top of this list, never instead of it.
 */
export function householdDependents(input: TaxYearInput): TaxYearInput["dependents"] {
  return input.dependents.filter((d) => d.dependent ?? d.age >= 0);
}

export function birthYearOf(p: TaxPerson, year: number): number {
  return p.birthYear ?? Math.floor(year - p.age);
}

/**
 * Share of an item owned by `personId`. 'joint' (and unknown owners) split evenly among the
 * living people; a dead person's own items pass to the survivor.
 */
export function ownerShare(owner: string, personId: string, people: TaxPerson[]): number {
  if (people.length === 1) return 1;
  if (owner === personId) return 1;
  if (people.some((p) => p.id === owner)) return 0;
  return 1 / people.length;
}

// ----------------------------------------------------------------------------- income buckets

/** Per-person buckets of income by broad character. All amounts are positive. */
export interface IncomeBuckets {
  wage: number;
  selfEmployment: number;
  pension: number;
  socialSecurity: number;
  ordinary: number;
  interest: number;
  qualifiedDividends: number;
  ordinaryDividends: number;
  rental: number;
  gainsLong: number;
  gainsShort: number;
  /** Taxable withdrawals from tax-deferred accounts (pensions, IRAs, RRSPs...). */
  deferredWithdrawals: number;
  /** Tax-free part of tax-deferred withdrawals (UK 25%, etc.). */
  deferredTaxFree: number;
  /** Penalty base x rate summed (engine-supplied early-withdrawal penalties). */
  penalties: number;
  /** Dividends by treatment (CA/AU). */
  caEligible: number;
  caNonEligible: number;
  auFranked: number;
  auUnfranked: number;
  /** Dividends without a CA/AU treatment tag, by character (CA/AU map these to defaults). */
  untaggedQualified: number;
  untaggedOrdinary: number;
}

export function emptyBuckets(): IncomeBuckets {
  return {
    wage: 0,
    selfEmployment: 0,
    pension: 0,
    socialSecurity: 0,
    ordinary: 0,
    interest: 0,
    qualifiedDividends: 0,
    ordinaryDividends: 0,
    rental: 0,
    gainsLong: 0,
    gainsShort: 0,
    deferredWithdrawals: 0,
    deferredTaxFree: 0,
    penalties: 0,
    caEligible: 0,
    caNonEligible: 0,
    auFranked: 0,
    auUnfranked: 0,
    untaggedQualified: 0,
    untaggedOrdinary: 0,
  };
}

function addCharacter(b: IncomeBuckets, c: ResolvedTaxCharacter, amt: number): void {
  switch (c) {
    case "wage":
      b.wage += amt;
      break;
    case "self-employment":
      b.selfEmployment += amt;
      break;
    case "pension":
      b.pension += amt;
      break;
    case "social-security":
      b.socialSecurity += amt;
      break;
    case "interest":
      b.interest += amt;
      break;
    case "qualified-dividend":
      b.qualifiedDividends += amt;
      break;
    case "ordinary-dividend":
      b.ordinaryDividends += amt;
      break;
    case "rental":
      b.rental += amt;
      break;
    case "capital-gains-long":
      b.gainsLong += amt;
      break;
    case "capital-gains-short":
      b.gainsShort += amt;
      break;
    case "tax-free":
      break;
    default:
      b.ordinary += amt;
  }
}

/**
 * Bucket income and withdrawals for one person (or the household when personId is undefined).
 * Items exempt in `jurisdictionId` (or its base id) are skipped.
 */
export function collectIncome(
  input: TaxYearInput,
  jurisdictionId: string,
  personId?: string,
  people: TaxPerson[] = alivePeople(input),
): IncomeBuckets {
  const b = emptyBuckets();
  const base = jurisdictionId.split(":")[0]!;
  for (const it of input.income) {
    if (it.amount <= 0) continue;
    if (it.exemptIn.includes(jurisdictionId) || it.exemptIn.includes(base)) continue;
    const share = personId === undefined ? 1 : ownerShare(it.owner, personId, people);
    if (share === 0) continue;
    const amt = it.amount * share;
    const isDividend =
      it.character === "qualified-dividend" || it.character === "ordinary-dividend";
    if (isDividend) {
      switch (it.dividendTreatment) {
        case "ca-eligible":
          b.caEligible += amt;
          break;
        case "ca-non-eligible":
          b.caNonEligible += amt;
          break;
        case "au-franked": {
          const f = it.frankedShare ?? 1;
          b.auFranked += amt * f;
          b.auUnfranked += amt * (1 - f);
          break;
        }
        case "au-unfranked":
          b.auUnfranked += amt;
          break;
        default:
          if (it.character === "qualified-dividend") b.untaggedQualified += amt;
          else b.untaggedOrdinary += amt;
      }
    }
    addCharacter(b, it.character, amt);
  }
  for (const w of input.withdrawals) {
    const share = personId === undefined ? 1 : ownerShare(w.owner, personId, people);
    if (share === 0) continue;
    const taxable = Math.max(0, w.taxableAmount) * share;
    if (w.treatment === "tax-deferred") {
      b.deferredWithdrawals += taxable;
      b.deferredTaxFree += Math.max(0, w.amount - w.taxableAmount) * share;
    } else if (taxable > 0) {
      addCharacter(b, w.character, taxable);
    }
    if (w.penaltyRate > 0) b.penalties += taxable * w.penaltyRate;
  }
  return b;
}

/** Sum deduction items by kind for a person (or household), filtered by level. */
export function sumDeductions(
  input: TaxYearInput,
  kind: "deduction" | "credit" | "pre-tax-contribution",
  opts: {
    personId?: string;
    level?: "federal" | "state" | "local";
    itemized?: boolean;
    people?: TaxPerson[];
  } = {},
): number {
  const people = opts.people ?? alivePeople(input);
  let s = 0;
  for (const d of input.deductions) {
    if (d.kind !== kind || d.amount <= 0 || d.employer) continue;
    if (opts.level && !d.levels.includes(opts.level)) continue;
    if (opts.itemized !== undefined && d.itemized !== opts.itemized) continue;
    const share = opts.personId === undefined ? 1 : ownerShare(d.owner, opts.personId, people);
    s += d.amount * share;
  }
  return s;
}

/** Country a withdrawal's account type belongs to (undefined = generic, handled by any national level). */
export function accountCountry(accountType: string): string | undefined {
  return (ACCOUNT_TYPE_INFO as Record<string, { country?: string }>)[accountType]?.country;
}

// ----------------------------------------------------------------------------- lines

export class LineSink {
  readonly lines: TaxLine[] = [];
  constructor(private readonly jurisdictionId: string) {}
  add(kind: TaxLine["kind"], label: string, amount: number, base?: number): void {
    if (amount === 0 || !Number.isFinite(amount)) return;
    this.lines.push({
      jurisdictionId: this.jurisdictionId,
      kind,
      label,
      amount,
      ...(base !== undefined ? { base } : {}),
    });
  }
  total(): number {
    let s = 0;
    for (const l of this.lines) s += l.amount;
    return s;
  }
}

// ----------------------------------------------------------------------------- per-person items

/** Deduction items for one person, split the way the European/IL/NZ plug-ins need them. */
export interface PersonDeductions {
  /** Employee/personal pre-tax contributions by account type ('' = no account type). */
  pretaxByType: Record<string, number>;
  pretax: number;
  /** Employer contributions (never income, but some limits count them). */
  employer: number;
  employerByType: Record<string, number>;
  deductions: number;
  credits: number;
}

export function personDeductions(
  input: TaxYearInput,
  personId: string,
  people: TaxPerson[],
): PersonDeductions {
  const r: PersonDeductions = {
    pretaxByType: {},
    pretax: 0,
    employer: 0,
    employerByType: {},
    deductions: 0,
    credits: 0,
  };
  for (const d of input.deductions) {
    if (d.amount <= 0) continue;
    const share = ownerShare(d.owner, personId, people);
    if (share === 0) continue;
    const amt = d.amount * share;
    if (d.kind === "credit") r.credits += amt;
    else if (d.kind === "deduction") r.deductions += amt;
    else if (d.employer) {
      r.employer += amt;
      const k = d.accountType ?? "";
      r.employerByType[k] = (r.employerByType[k] ?? 0) + amt;
    } else {
      r.pretax += amt;
      const k = d.accountType ?? "";
      r.pretaxByType[k] = (r.pretaxByType[k] ?? 0) + amt;
    }
  }
  return r;
}

/** Government (state / statutory) pension income for a person: incomeType 'state-pension' or 'social-security'. */
export function statePensionOf(input: TaxYearInput, personId: string, people: TaxPerson[]): number {
  let s = 0;
  for (const it of input.income) {
    if (it.amount <= 0 || it.character === "tax-free") continue;
    const gov =
      it.incomeType === "state-pension" ||
      it.incomeType === "social-security" ||
      it.character === "social-security";
    if (gov) s += it.amount * ownerShare(it.owner, personId, people);
  }
  return s;
}

/** Taxable withdrawals for a person from the given account types (any treatment). */
export function withdrawalsFrom(
  input: TaxYearInput,
  personId: string,
  people: TaxPerson[],
  types: ReadonlySet<string>,
): { gross: number; taxable: number } {
  let gross = 0;
  let taxable = 0;
  for (const w of input.withdrawals) {
    if (!types.has(w.accountType)) continue;
    const share = ownerShare(w.owner, personId, people);
    if (share === 0) continue;
    gross += w.amount * share;
    taxable += clamp0(w.taxableAmount) * share;
  }
  return { gross, taxable };
}

export function lastFact(input: TaxYearInput, key: string): number | undefined {
  for (let i = input.history.length - 1; i >= 0; i--) {
    const v = input.history[i]![key];
    if (v !== undefined) return v;
  }
  return undefined;
}

/**
 * Bracket fill for a formula tariff (German §32a zones): splits [0, x) at `edges` and reports the
 * tax of each slice from `tax` (average rate per slice as `rate`).
 */
export function formulaFill(
  tax: (x: number) => number,
  edges: readonly { from: number; label: string }[],
  x: number,
): BracketFill["bands"] {
  const out: BracketFill["bands"] = [];
  for (let i = 0; i < edges.length; i++) {
    const lo = edges[i]!.from;
    const hi = i + 1 < edges.length ? edges[i + 1]!.from : Number.POSITIVE_INFINITY;
    if (x <= lo) break;
    const top = Math.min(x, hi);
    const t = tax(top) - tax(lo);
    out.push({
      label: edges[i]!.label,
      rate: t / (top - lo),
      from: lo,
      to: hi,
      amount: top - lo,
      tax: t,
    });
  }
  return out;
}

/** Months-in-period proration for annual thresholds. */
export function periodScale(input: TaxYearInput): number {
  return Math.max(0, Math.min(12, input.months)) / 12;
}

export function clamp0(x: number): number {
  return Math.max(x, 0);
}

/** Finite-difference marginal rate: total tax delta for one extra unit of ordinary income. */
export function finiteMarginal(
  compute: (input: TaxYearInput) => number,
  input: TaxYearInput,
  character: ResolvedTaxCharacter = "ordinary",
  owner?: string,
  delta = 1,
): number {
  const base = compute(input);
  const who = owner ?? input.people.find((p) => p.alive)?.id ?? input.people[0]?.id ?? "joint";
  const bumped: TaxYearInput = {
    ...input,
    income: [
      ...input.income,
      { sourceId: "__marginal__", owner: who, character, amount: delta, exemptIn: [] },
    ],
  };
  return (compute(bumped) - base) / delta;
}
