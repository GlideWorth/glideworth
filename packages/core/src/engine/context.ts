/** Mutable simulation state shared by the phases of the yearly pipeline. Internal to the engine. */

import type { z } from "zod";
import { NotImplementedError } from "../errors.js";
import { ACCOUNT_TYPE_INFO, type AccountTypeInfo } from "../schema/account-types.js";
import type { Account, AccountBehaviour, DrawdownCategory } from "../schema/accounts.js";
import type {
  AssetPurchase,
  Debt,
  DebtBehaviour,
  InterestModel,
  RealAsset,
  RealAssetBehaviour,
} from "../schema/assets-debts.js";
import type { ExpenseEvent } from "../schema/events.js";
import type { Household, Location } from "../schema/household.js";
import type { Milestone } from "../schema/milestones.js";
import type { CurrentFinances, Plan } from "../schema/plan.js";
import type { Amount } from "../schema/primitives.js";
import type { FilingStatus, TaxConfig } from "../schema/tax.js";
import type { DateRef } from "../schema/time.js";
import type { TaxRegistry } from "../tax/registry.js";
import type {
  ResolvedTaxCharacter,
  TaxDeductionItem,
  TaxIncomeItem,
  TaxJurisdiction,
  TaxWithdrawalItem,
} from "../tax/types.js";
import { ageAt, type MonthIndex, type PeriodBounds } from "./dates.js";
import type { DrawdownGroup } from "./drawdown.js";
import type {
  ExpenseLine,
  HistoricalDataset,
  IncomeLine,
  LedgerEntry,
  LedgerNode,
  MarketPeriod,
  PeriodResult,
  SimulationOptions,
  SimWarning,
  TaxLine,
  TaxPeriodResult,
  TraceEntry,
} from "./types.js";

export interface PersonState {
  id: string;
  role: "primary" | "partner";
  birth: MonthIndex;
  name: string;
}

export interface MilestoneState {
  def: Milestone;
  /** undefined = pending (not resolved yet), null = never, number = month reached. */
  month: MonthIndex | null | undefined;
  via: "time" | "metric" | "mixed" | null;
  /** True when it can only be resolved during the loop (metric criteria or dynamic dependency). */
  dynamic: boolean;
}

export interface AccountPeriodAcc {
  opening: number;
  contributions: number;
  withdrawals: number;
  growth: number;
  dividends: number;
  dividendsReinvested: number;
  fees: number;
  transfersIn: number;
  transfersOut: number;
  /** Required distributions (RMD, SEPP, custom) forced this period. */
  requiredDistribution: number;
  /** Qualified charitable distributions paid straight from this account (count toward RMDs). */
  qcd: number;
  /** Annual total return (growth + yield) applied this period; used by the cash-flow timing convention. */
  rate: number;
  /** Foreign-currency accounts: FX revaluation of the opening balance this period (part of `growth`). */
  fx?: number;
  /** Growth adjustment from the cash-flow timing convention (included in `growth`). */
  timing: number;
}

export interface AccountState {
  def: Account;
  behaviour: AccountBehaviour;
  info: AccountTypeInfo;
  category: DrawdownCategory;
  /** Current owner (changes on survivor transfer). */
  owner: string;
  balance: number;
  costBasis: number | null;
  contributionBasis: number | null;
  /**
   * US traditional IRA: nondeductible contributions not yet withdrawn (Form 8606 basis). Each
   * withdrawal or conversion takes a pro-rata share of it tax-free (IRC 72, 408(d)(1)).
   */
  iraBasis: number;
  /** Static open month (null = open from the start). */
  opensAt: MonthIndex | null;
  /** Planned accounts opening at a dynamic (metric) milestone: re-resolved every period. */
  opensRef: DateRef | null;
  /** UK PCLS: tax-free lump sum already crystallised. */
  pclsTaken: boolean;
  /** 72(t) SEPP fixed payment once started. */
  sepp: { start: MonthIndex; end: MonthIndex; annual: number | null } | null;
  /** Bond share used this period (for reporting and dividends). */
  bondShare: number;
  /** Bond share of the previous period (rebalancing gains); null before the first period. */
  prevBondShare?: number | null;
  /** Foreign currency of the account (absent = base currency). */
  currency?: string;
  p: AccountPeriodAcc;
}

export interface ActiveLoan {
  interest: z.infer<typeof InterestModel>;
  monthlyPayment: Amount;
  termEnd?: DateRef | undefined;
}

export interface AssetState {
  def: RealAsset;
  behaviour: RealAssetBehaviour;
  value: number;
  loanBalance: number;
  loan: ActiveLoan | null;
  owned: boolean;
  owner: string;
  /** Tax basis for gains on sale. */
  costBasis: number;
  /** Property-tax assessed value (null = follow market value). */
  assessed: number | null;
  /** Future purchase (planned real assets) and recurrence state. */
  planned: {
    purchase: z.infer<typeof AssetPurchase>;
    cycle: number;
    nextPurchase: MonthIndex | null;
    saleAt: MonthIndex | null;
    holdMonths: number | null;
  } | null;
  /** Sold / liquidated, never to be bought again. */
  done: boolean;
  /** Month of the latest in-plan purchase (null = owned since before the plan). */
  acquiredAt: MonthIndex | null;
  /** Foreign currency of the asset and its loan (absent = base currency). */
  currency?: string;
  p: {
    ownershipCosts: number;
    loanPayments: number;
    loanInterest: number;
    rentalIncome: number;
    purchasePrice: number;
    saleProceeds: number;
  };
}

export interface DebtState {
  def: Debt;
  behaviour: DebtBehaviour;
  balance: number;
  owner: string;
  /** Foreign currency of the debt (absent = base currency). */
  currency?: string;
  /** `extraPayments`: payments above the schedule made by debtPaydown flows this period. */
  p: {
    opening: number;
    interest: number;
    payments: number;
    forgiven: number;
    extraPayments?: number;
  };
}

/** Expense / debt / purchase lines paid preferentially from specific accounts. */
export interface TargetedLine {
  line: ExpenseLine;
  accountIds: string[];
  /** QCD: the withdrawal is excluded from taxable income. */
  qcd?: boolean;
}

/** Everything produced while simulating one period. */
export interface PeriodState {
  bounds: PeriodBounds;
  market: MarketPeriod;
  /** Assumption-based (non-stochastic) rates for accounts with monteCarlo: 'fixed'. */
  baseMarket: MarketPeriod;
  piStart: number;
  piEnd: number;
  ages: Record<string, number>;
  alive: Record<string, boolean>;
  incomeLines: IncomeLine[];
  expenseLines: ExpenseLine[];
  /** Cash that arrived in the pool (income not routed elsewhere, paid-out dividends...). */
  poolInflow: number;
  /** Mandatory outflows from the pool (expenses, scheduled debt/loan payments...). */
  poolRequired: number;
  taxIncome: TaxIncomeItem[];
  taxWithdrawals: TaxWithdrawalItem[];
  taxDeductions: TaxDeductionItem[];
  /** Engine-computed tax lines (charges not derivable from items, e.g. LISA withdrawal charge). */
  engineTaxLines: TaxLine[];
  /** Withholding mode per income source id (next-period settlement). */
  withholding: Map<string, { mode: "auto" | "none" } | { mode: "fixed"; rate: number }>;
  targeted: TargetedLine[];
  /** Withdrawal-strategy spending line (requested is recomputed inside the settle fixpoint). */
  strategy: { line: ExpenseLine; budget: number; taxesFromBudget: boolean } | null;
  /** Per-period contribution-limit usage keyed by owner|group. */
  limitUsed: Map<string, number>;
  taxes: TaxPeriodResult;
  shortfall: number;
  ledgerNodes: Map<string, LedgerNode>;
  ledger: LedgerEntry[];
  milestonesReached: string[];
  /** Effective tax settings this period (after milestone effects). */
  tax: TaxConfig;
  location: Location;
  stack: TaxJurisdiction[];
  /**
   * ACA marketplace coverage this period (benchmark premium, household size, advance credit).
   * `householdSize` is set only when an ACA expense overrides it; absent = the tax household.
   */
  aca: { benchmarkPremium: number; householdSize?: number; advanceCredit?: number } | null;
  /**
   * Wealth at the period start (custom wealth tax, ES wealth tax, NL box 3): net worth, liquid net
   * worth, portfolio, and the box-3 style split into cash, taxable investments and debts.
   */
  wealth: {
    netWorth: number;
    liquidNetWorth: number;
    portfolio: number;
    cash: number;
    taxableInvestments: number;
    debts: number;
  } | null;
  /** Qualified expenses still available this period for HSA (healthcare) and 529 (education) use. */
  qualified: { healthcare: number; education: number };
  /** Cross-border plans: taxes are computed per residence / source country (engine/crossborder.ts). */
  crossBorder?: boolean;
  /** Cross-border plans: per-period classification cache of tax items by source id. */
  itemInfo?: Map<string, import("./crossborder.js").ItemInfo>;
}

export interface StrategyState {
  /** Strategy periods elapsed (0 = not started). */
  yearIndex: number;
  initialPortfolio: number;
  startPriceIndex: number;
  /** Last annual withdrawal (nominal); null before the first. */
  previous: number | null;
  /** Price index at the previous strategy period. */
  lastCpi: number;
  /** Market-only portfolio return over the previous period. */
  lastReturn: number;
  yearsSinceRaise: number | null;
  ratchetBase: number | null;
}

export interface EngineContext {
  options: SimulationOptions;
  household: Household;
  finances: CurrentFinances;
  plan: Plan;
  registry: TaxRegistry;
  historical: HistoricalDataset | undefined;
  people: PersonState[];
  start: MonthIndex;
  endExclusive: MonthIndex;
  periods: PeriodBounds[];
  market: MarketPeriod[];
  baseMarket: MarketPeriod[];
  /** Price index at each period start (reference = plan start = 1). */
  piStart: number[];
  milestones: Map<string, MilestoneState>;
  accounts: AccountState[];
  accountById: Map<string, AccountState>;
  assets: AssetState[];
  debts: DebtState[];
  warnings: SimWarning[];
  trace: TraceEntry[];
  taxHistory: Record<string, number>[];
  results: PeriodResult[];
  unsupportedSeen: Set<string>;
  /** Warnings emitted once per key. */
  warnedOnce: Set<string>;
  /** Mutable tax settings (milestone effects change them). */
  filingStatus: FilingStatus;
  location: Location;
  withholdingRates: TaxConfig["withholding"];
  appliedEffects: Set<string>;
  deceased: Set<string>;
  /** UK lump-sum allowance used per person (tax-free pension cash). */
  lsaUsed: Map<string, number>;
  /** Owners who have flexibly accessed a UK pension (money-purchase annual allowance). */
  flexiblyAccessed: Set<string>;
  /** Salary history for defined-benefit pensions: incomeId -> pay record. */
  payHistory: Map<string, { payMonths: number; months: number; finalAnnual: number }>;
  /** Defined-benefit pension annual payout fixed at payout start: incomeId -> nominal annual. */
  dbPayout: Map<string, { annual: number; start: MonthIndex }>;
  /** Market-only performance index for flexible spending (all-time-high tracking). */
  perf: { index: number; ath: number };
  strategy: StrategyState;
  /** Risk-guardrail spending multiplier carried from year to year (1 = as planned). */
  guardrailMultiplier: number;
  /** Tax liability not yet settled (next-period settlement). */
  pendingSettlement: number;
  /** Plan expense events plus engine-synthesised ones (auto Medicare). */
  expenseEvents: ExpenseEvent[];
  /** Static drawdown order. */
  drawdownGroups: DrawdownGroup[];
  /** Rank of each drawdown category (global hierarchy for "pay from" accounts). */
  drawdownCategoryRank: Map<DrawdownCategory, number>;
  /** Ids of one-off income events (inheritance, windfall); built lazily for the savings rate. */
  oneOffIncomeIds?: Set<string>;
  /** Inflation category indices (engine/indices.ts). */
  categories?: Map<string, import("./indices.js").CategoryIndex>;
  /** Resolved FX rates to the base currency, per foreign currency (engine/indices.ts). */
  fx?: Map<string, import("./indices.js").ResolvedFx>;
  /**
   * Per-period FX path when the market path carries FX shocks (Monte Carlo FX risk): for each
   * foreign currency, its rate at each period start and the period's annual growth factor.
   */
  fxPath?: Map<string, { start: number[]; growth: number[] }>;
  /** Items in other countries (engine/crossborder.ts); absent = single-country plan. */
  crossBorder?: import("./crossborder.js").CrossBorderState;
}

/**
 * Called by any phase that meets a feature it cannot model yet.
 * strict: throws NotImplementedError. non-strict: one FEATURE_NOT_MODELLED warning per feature.
 */
export function unsupported(
  ctx: EngineContext,
  feature: string,
  workstream: string,
  hint?: string,
  refs: string[] = [],
): void {
  if (ctx.options.strict) throw new NotImplementedError(feature, workstream, hint);
  if (ctx.unsupportedSeen.has(feature)) return;
  ctx.unsupportedSeen.add(feature);
  ctx.warnings.push({
    code: "FEATURE_NOT_MODELLED",
    severity: "warning",
    message: `${feature} is not modelled yet and was skipped for the whole plan${hint ? ` (${hint})` : ""}.`,
    periodIndex: null,
    refs,
  });
}

/** Push a warning once per `key` for the whole run. */
export function warnOnce(ctx: EngineContext, key: string, w: SimWarning): void {
  if (ctx.warnedOnce.has(key)) return;
  ctx.warnedOnce.add(key);
  ctx.warnings.push(w);
}

export function traceEvent(
  ctx: EngineContext,
  ps: PeriodState | null,
  phase: string,
  code: string,
  message: string | (() => string),
  refs: string[] = [],
  data?: Record<string, unknown>,
  level: "summary" | "full" = "summary",
): void {
  const t = ctx.options.trace;
  if (t === "off" || (t === "summary" && level === "full")) return;
  ctx.trace.push({
    periodIndex: ps?.bounds.index ?? -1,
    phase,
    code,
    message: typeof message === "function" ? message() : message,
    refs,
    ...(data ? { data } : {}),
  });
}

export function accountInfo(def: Account): AccountTypeInfo {
  const info = ACCOUNT_TYPE_INFO[def.type];
  return def.taxTreatment ? { ...info, taxTreatment: def.taxTreatment } : info;
}

/** The person an owner refers to (joint -> primary while alive, else the survivor). */
export function ownerPerson(ctx: EngineContext, owner: string): PersonState {
  const direct = ctx.people.find((x) => x.id === owner);
  if (direct) return direct;
  const primary = ctx.people.find((x) => x.role === "primary")!;
  if (!ctx.deceased.has(primary.id)) return primary;
  return ctx.people.find((x) => !ctx.deceased.has(x.id)) ?? primary;
}

/** Age of the account/event owner (joint -> primary person, or the survivor). */
export function ownerAge(ctx: EngineContext, owner: string, at: MonthIndex): number {
  return ageAt(ownerPerson(ctx, owner).birth, at);
}

/** Price index at an arbitrary month (geometric within the period). */
export function priceIndexAt(ctx: EngineContext, m: MonthIndex): number {
  const ps = ctx.periods;
  if (ps.length === 0) return 1;
  if (m <= ps[0]!.start) return (1 + ctx.market[0]!.inflation) ** ((m - ps[0]!.start) / 12);
  // Binary search for the period containing m.
  let lo = 0;
  let hi = ps.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (m < ps[mid]!.end) hi = mid;
    else lo = mid + 1;
  }
  const b = ps[lo]!;
  return ctx.piStart[lo]! * (1 + ctx.market[lo]!.inflation) ** ((m - b.start) / 12);
}

/** Index of the period containing month m (clamped). */
export function periodIndexAt(ctx: EngineContext, m: MonthIndex): number {
  const ps = ctx.periods;
  let lo = 0;
  let hi = ps.length - 1;
  if (m < ps[0]!.start) return 0;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (m < ps[mid]!.end) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

export function addNode(ps: PeriodState, node: LedgerNode): string {
  if (!ps.ledgerNodes.has(node.id)) ps.ledgerNodes.set(node.id, node);
  return node.id;
}

export function addLedger(ctx: EngineContext, ps: PeriodState, entry: LedgerEntry): void {
  if (ctx.options.lean || !(entry.amount > 1e-12)) return;
  ps.ledger.push(entry);
}

export const POOL = "pool";

export function resolvedCharacter(c: string, fallback: ResolvedTaxCharacter): ResolvedTaxCharacter {
  return c === "auto" ? fallback : (c as ResolvedTaxCharacter);
}

export function fmt(n: number): string {
  return n.toFixed(2);
}
