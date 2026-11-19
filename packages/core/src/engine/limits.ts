/**
 * Contribution limits. The engine asks the jurisdiction plug-in of the account's country first
 * (whatever the plan's tax mode, so a flat-rate UK plan still uses the ISA allowance and the
 * pension annual allowance / MPAA from the UK tax data), then the plan's own stack
 * (`TaxJurisdiction.contributionLimit`). Only when no plug-in answers (countries without one) does
 * it fall back to the small table below. Limits are annual, per owner and per LIMIT GROUP
 * (accounts sharing one allowance, e.g. all 401(k)-type deferrals, or ISA + LISA).
 */
import type { AccountType } from "../schema/accounts.js";
import { pickYear } from "../tax/common.js";
import { US_LIMITS_2026, US_LIMITS_YEARS } from "../tax/data/us-federal.js";
import type { AccountState, EngineContext, PeriodState } from "./context.js";
import { ownerAge } from "./context.js";
import { nonResidentContributionCap } from "./crossborder.js";
import { rulesFor } from "./rules.js";

export interface LimitGroup {
  /** Shared allowance id. */
  group: string;
  annual: number;
}

const US_401K: AccountType[] = [
  "401k",
  "roth-401k",
  "403b",
  "roth-403b",
  "tsp",
  "roth-tsp",
  "solo-401k",
  "401a",
];

export function limitGroupOf(type: AccountType): string {
  if (US_401K.includes(type)) return "us-401k";
  if (type === "457b" || type === "roth-457b") return "us-457b";
  if (type === "traditional-ira" || type === "roth-ira") return "us-ira";
  if (type === "uk-isa" || type === "uk-lisa") return "uk-isa";
  if (type === "uk-sipp" || type === "uk-workplace-pension" || type === "uk-pension")
    return "uk-pension";
  return type;
}

/**
 * US 415(c) total annual additions limit for `year` (from the US tax data): the published figure,
 * indexed with the plan's price index after the latest published year.
 */
export function us415c(year: number, pi: number): number {
  const L = pickYear(US_LIMITS_YEARS, year);
  return L.sepOrSoloTotal * (year > L.year ? pi : 1);
}

function fallbackLimit(
  ctx: EngineContext,
  a: AccountState,
  age: number,
  pi: number,
  earned: number,
): number | null {
  const t = a.def.type;
  const g = limitGroupOf(t);
  // US accounts outside a US tax stack: the 2026 IRS limits, indexed from the plan start.
  const L = US_LIMITS_2026;
  switch (g) {
    case "us-401k":
    case "us-457b": {
      const catchUp = age >= 60 && age < 64 ? L.catchUp60to63 : age >= 50 ? L.catchUp50 : 0;
      return (L.electiveDeferral + catchUp) * pi;
    }
    case "us-ira":
      return Math.min((L.ira + (age >= 50 ? L.iraCatchUp : 0)) * pi, Math.max(0, earned));
    case "sep-ira":
      return Math.min(L.sepOrSoloTotal * pi, 0.25 * Math.max(0, earned));
    case "simple-ira": {
      const catchUp =
        age >= 60 && age < 64 ? L.simpleCatchUp60to63 : age >= 50 ? L.simpleCatchUp : 0;
      return (L.simple + catchUp) * pi;
    }
    case "hsa":
      return (
        ((a.behaviour.hsaCoverage === "family" ? L.hsa.family : L.hsa.self) +
          (age >= 55 ? L.hsa.catchUp55 : 0)) *
        pi
      );
    case "coverdell-esa":
      return 2_000;
    case "uk-isa":
      return 20_000;
    case "uk-pension": {
      const allowance = ctx.flexiblyAccessed.has(a.owner) ? 10_000 : 60_000;
      return Math.min(allowance, Math.max(3_600, earned));
    }
    case "ca-tfsa":
      return 7_000 * pi;
    case "ca-rrsp":
      return Math.min(32_490 * pi, 0.18 * Math.max(0, earned));
    case "ca-fhsa":
      return 8_000;
    case "au-super-accumulation":
      return 30_000 * pi;
    default:
      return null;
  }
}

/** Earned income (wages + self-employment) of an owner this period. */
export function earnedIncome(ps: PeriodState, owner: string): number {
  let s = 0;
  for (const i of ps.taxIncome)
    if (
      (i.character === "wage" || i.character === "self-employment") &&
      (owner === "joint" || i.owner === owner)
    )
      s += i.amount;
  return s;
}

/** Annual limit (nominal) for contributions to `a`, or null when uncapped. */
/** Account type whose limit is the shared allowance of a group (a LISA shares the ISA allowance). */
const GROUP_TYPE: Partial<Record<AccountType, AccountType>> = { "uk-lisa": "uk-isa" };

function jurisdictionLimit(
  ctx: EngineContext,
  ps: PeriodState,
  a: AccountState,
  accountType: AccountType,
): number | null {
  const age = ownerAge(ctx, a.owner, ps.bounds.start);
  const earned = earnedIncome(ps, a.owner) * (12 / ps.bounds.months);
  for (const j of rulesFor(ctx, a, ps)) {
    if (!j.contributionLimit) continue;
    const v = j.contributionLimit({
      accountType,
      year: ps.bounds.year,
      ownerAge: age,
      priceIndex: ps.piStart,
      earnedIncome: earned,
      flexiblyAccessed: ctx.flexiblyAccessed.has(a.owner),
      ...(a.behaviour.hsaCoverage ? { coverage: a.behaviour.hsaCoverage } : {}),
    });
    if (v !== null && v !== undefined) return v;
  }
  return null;
}

export function annualLimit(
  ctx: EngineContext,
  ps: PeriodState,
  a: AccountState,
): LimitGroup | null {
  const group = limitGroupOf(a.def.type);
  const v = jurisdictionLimit(ctx, ps, a, GROUP_TYPE[a.def.type] ?? a.def.type);
  if (v !== null)
    return { group, annual: ps.crossBorder ? nonResidentContributionCap(ctx, ps, a, v) : v };
  const age = ownerAge(ctx, a.owner, ps.bounds.start);
  const earned = earnedIncome(ps, a.owner) * (12 / ps.bounds.months);
  const fb = fallbackLimit(ctx, a, age, ps.piStart, earned);
  if (fb === null) return null;
  return { group, annual: ps.crossBorder ? nonResidentContributionCap(ctx, ps, a, fb) : fb };
}

/** Extra LISA-specific cap within the ISA allowance (UK tax data: £4,000, contributions 18-49). */
export function lisaCap(ctx: EngineContext, ps: PeriodState, a: AccountState): number {
  if (a.def.type !== "uk-lisa") return Number.POSITIVE_INFINITY;
  const v = jurisdictionLimit(ctx, ps, a, "uk-lisa");
  if (v !== null) return v;
  const age = ownerAge(ctx, a.owner, ps.bounds.start);
  return age >= 18 && age < 50 ? 4_000 : 0;
}
