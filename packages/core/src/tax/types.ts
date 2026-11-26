/**
 * TaxJurisdiction plug-in contract.
 *
 * The engine builds ONE TaxYearInput per period (after cash flows, inside the tax/drawdown
 * fixpoint loop) and asks every jurisdiction in the resolved stack to compute its lines.
 * Jurisdictions are pure and stateless: anything they need from earlier periods (IRMAA MAGI
 * look-back, carryforwards) arrives via `history`.
 *
 * Levels compose: a US household in New York City resolves to
 *   ['us-federal', 'us-payroll', 'us-state:NY', 'us-local:nyc'].
 * Each jurisdiction may read `priorLevels` (outputs of jurisdictions earlier in the stack) for
 * interactions such as state conformity to federal AGI or SALT deductions.
 */

import type { TaxLine } from "../engine/types.js";
import type { AccountType, TaxTreatment } from "../schema/accounts.js";
import type { TaxCharacter } from "../schema/events.js";
import type { Location } from "../schema/household.js";
import type { CountryCode, Id } from "../schema/primitives.js";
import type { FilingStatus, TaxConfig } from "../schema/tax.js";

/** Resolved tax character (never 'auto'; the engine resolves 'auto' via defaultCharacter). */
export type ResolvedTaxCharacter = Exclude<TaxCharacter, "auto">;

export interface TaxIncomeItem {
  sourceId: string;
  owner: string;
  character: ResolvedTaxCharacter;
  amount: number;
  /** Jurisdiction ids in which this item is exempt. */
  exemptIn: string[];
  /**
   * OPTIONAL (workstream b, additive): the account's dividend treatment so CA/AU plug-ins can
   * apply gross-up / dividend tax credits / franking. Absent = derive from `character`.
   * Engine: map from AccountBehaviour.dividends.treatment via `dividendTaxDetail()`.
   */
  dividendTreatment?: DividendTreatmentKind;
  /** OPTIONAL: for 'au-franked', the share of the dividend that is franked (default 1). */
  frankedShare?: number;
  /**
   * OPTIONAL: the income event type ('ca-oas', 'ca-cpp', 'state-pension', 'social-security'...).
   * Lets CA apply the OAS recovery tax and AU/UK identify government benefits.
   */
  incomeType?: string;
  /** OPTIONAL (engine): sale details of a real asset gain (non-resident rebasing). */
  sale?: { assetId: string; month: number; proceeds: number; costBasis: number; gain: number };
}

export type DividendTreatmentKind =
  | "qualified"
  | "ordinary"
  | "ca-eligible"
  | "ca-non-eligible"
  | "au-franked"
  | "au-unfranked";

export interface TaxWithdrawalItem {
  accountId: Id;
  accountType: AccountType;
  treatment: TaxTreatment;
  owner: string;
  /** Gross amount withdrawn. */
  amount: number;
  /** Portion already classified as taxable by the engine (gains, tax-deferred, earnings). */
  taxableAmount: number;
  character: ResolvedTaxCharacter;
  /** Early-withdrawal penalty rate applicable to the taxable/earnings part (0 when none). */
  penaltyRate: number;
  ownerAge: number;
  /** OPTIONAL: true when this item is a Roth conversion / RRSP->TFSA style transfer (no cash out). */
  isConversion?: boolean;
  /** OPTIONAL: the flow or strategy that caused a conversion (lets a planner tell its own apart). */
  causeId?: string;
}

export interface TaxDeductionItem {
  sourceId: string;
  kind: "deduction" | "credit" | "pre-tax-contribution";
  amount: number;
  itemized: boolean;
  levels: ("federal" | "state" | "local")[];
  owner: string;
  /** OPTIONAL: account receiving a pre-tax contribution (lets UK/AU/CA apply scheme rules). */
  accountId?: Id;
  accountType?: AccountType;
  /**
   * OPTIONAL (UK pensions): how relief is given. 'net-pay' (deducted from pay before income tax,
   * default for workplace pensions), 'relief-at-source' (amount is the NET personal contribution;
   * provider adds basic-rate relief, higher-rate relief via band extension; default for SIPP),
   * 'salary-sacrifice' (reduces pay for income tax AND National Insurance).
   */
  pensionScheme?: "net-pay" | "relief-at-source" | "salary-sacrifice";
  /** OPTIONAL: employer contribution (counts toward pension allowances, never toward income). */
  employer?: boolean;
}

export interface TaxPerson {
  id: Id;
  role: "primary" | "partner";
  age: number;
  alive: boolean;
  /** OPTIONAL: calendar birth year (State Pension age, RMD start age). Fallback: year - age. */
  birthYear?: number;
  /** OPTIONAL: calendar birth month 1-12 (month-accurate State Pension age cohorts). */
  birthMonth?: number;
  /**
   * OPTIONAL (US IRC 219(g)): an active participant in a workplace plan this period (money went
   * into their 401(k)-type, 403(b), 401(a), TSP, SEP or SIMPLE account). Absent = not covered.
   */
  activeParticipant?: boolean;
}

export interface TaxYearInput {
  year: number;
  periodIndex: number;
  /** Months in the period (12 for full years; partial first/last periods prorate thresholds). */
  months: number;
  filingStatus: FilingStatus;
  location: Location;
  people: TaxPerson[];
  /**
   * Household dependents with their age at the period start. `dependent` says whether they are
   * still a dependent this period by the household's own setting (born by the period end and
   * younger than their `independentAtAge`; engine/dependents.ts). Absent = counted once born
   * (age >= 0). Read it through `householdDependents` so every plug-in uses the same rule.
   */
  dependents: { id: Id; age: number; dependent?: boolean }[];
  /** Cumulative inflation since the plan reference month; index real thresholds with it. */
  priceIndex: number;
  income: TaxIncomeItem[];
  withdrawals: TaxWithdrawalItem[];
  deductions: TaxDeductionItem[];
  config: TaxConfig;
  /** Facts from previous periods (most recent last), e.g. { magi: ..., agi: ... }. */
  history: Record<string, number>[];
  /**
   * OPTIONAL: wealth metrics at period start (custom wealth tax). Absent = no wealth tax line.
   */
  wealth?: {
    netWorth: number;
    liquidNetWorth: number;
    portfolio: number;
    /**
     * OPTIONAL (NL Box 3, additive): cash/savings balances, taxable investments held outside
     * pension and tax-free wrappers, and debts other than the main-home mortgage. Absent = NL
     * treats `portfolio` as "other assets" with no savings or debts.
     */
    cash?: number;
    taxableInvestments?: number;
    debts?: number;
  };
  /** OPTIONAL: securities traded this period (custom financial transaction tax). */
  transactions?: { purchases: number; sales: number };
  /**
   * OPTIONAL (US ACA premium tax credit): benchmark (second-lowest silver) premium for the period,
   * household size and any advance credit already netted from premiums. Engine maps from a
   * healthcare expense with `healthcare.kind === 'aca'`. `householdSize` absent = automatic: the
   * living adults on the return plus `householdDependents` (us-federal `acaHouseholdSize`).
   */
  aca?: { benchmarkPremium: number; householdSize?: number; advanceCredit?: number };
  /**
   * OPTIONAL (cross-border plans): the people are taxed as NON-residents of this jurisdiction on
   * the items given (income sourced there). `personalAllowance[personId] === false` removes the
   * personal allowance (UK: only British / EEA citizens and treaty cases keep it). Absent = resident.
   */
  nonResident?: { personalAllowance: Record<string, boolean> };
}

export interface TaxYearOutput {
  lines: TaxLine[];
  grossIncome: number;
  taxableIncome: number;
  /** Marginal rate on one more unit of ordinary income at this level. */
  marginalRate: number;
  /** Facts exposed to later levels and later periods (agi, magi, ...). */
  facts: Record<string, number>;
  /**
   * OPTIONAL: per-schedule bracket fill for the tax analytics UI (only filled when requested via
   * `TaxJurisdiction.explainYear`, never in the hot path).
   */
  brackets?: BracketFill[];
}

/** How one schedule of income (per person when taxed individually) fills a rate table. */
export interface BracketFill {
  jurisdictionId: string;
  /** Person id for individually-taxed jurisdictions (UK, CA, AU); absent = household. */
  personId?: string;
  /** e.g. 'non-savings', 'savings', 'dividends', 'capital-gains', 'ordinary', 'preferential'. */
  schedule: string;
  bands: { label: string; rate: number; from: number; to: number; amount: number; tax: number }[];
}

export interface TaxContributionLimitQuery {
  accountType: AccountType;
  year: number;
  ownerAge: number;
  priceIndex: number;
  earnedIncome: number;
  coverage?: "self" | "family";
  /** OPTIONAL: the owner has flexibly accessed a pension (UK money purchase annual allowance). */
  flexiblyAccessed?: boolean;
}

export interface PensionAccessQuery {
  accountType: AccountType;
  /** Owner's birth year and month (1-12). */
  birthYear: number;
  birthMonth: number;
}

/** A contribution sub-limit inside an account's allowance (UK cash ISA). */
export interface ContributionSubLimitQuery {
  accountType: AccountType;
  /** The account's sub-type (UK ISAs: `Account.ukIsaType`). */
  subtype?: string;
  /** Tax year of the period (calendar year of its start month). */
  year: number;
  ownerAge: number;
  config: TaxConfig;
}

export interface ContributionSubLimit {
  /** Allowance key, per owner ('uk-cash-isa'). */
  key: string;
  /** Annual amount (nominal) from the first month it applies. */
  annual: number;
  /** First month the sub-limit applies ('YYYY-MM'); the engine prorates a period it starts in. */
  from: string;
}

/** A state (government) pension starting after the statutory age. */
export interface StatePensionDeferralQuery {
  birthYear: number;
  birthMonth: number;
  /** Months between the statutory pension age and the first payment (> 0). */
  monthsDeferred: number;
}

export interface HomeSaleQuery {
  filingStatus: FilingStatus;
  year: number;
  priceIndex: number;
  /** Months the home was owned before the sale (null = since before the plan started). */
  monthsOwned: number | null;
}

export interface RequiredDistributionQuery {
  accountType: AccountType;
  rule: string;
  year: number;
  ownerAge: number;
  priorYearEndBalance: number;
  ownerBirthYear: number;
}

export interface TaxJurisdiction {
  /** 'flat', 'custom', 'us-federal', 'us-payroll', 'us-state:CA', 'uk', 'ca-federal', 'ca-province:ON', 'au'. */
  id: string;
  label: string;
  level: "national" | "state" | "local" | "payroll" | "synthetic";
  country?: CountryCode;
  /** 'stub' jurisdictions throw NotImplementedError from computeYear. */
  status: "implemented" | "stub";
  /** Workstream (area of the code base) that owns the implementation. */
  owner: string;

  computeYear(input: TaxYearInput, priorLevels: TaxYearOutput[]): TaxYearOutput;

  /** Optional capabilities used by flows (limits), distributions and the explainability layer. */
  contributionLimit?(q: TaxContributionLimitQuery): number | null;
  requiredDistribution?(q: RequiredDistributionQuery): number;
  /** Map 'auto' income character for an income type (salary -> wage...). */
  defaultCharacter?(incomeType: string): ResolvedTaxCharacter;
  /** Ids of law toggles this jurisdiction understands, with labels and defaults. */
  lawToggles?: { id: string; label: string; default: boolean }[];
  /**
   * OPTIONAL: like computeYear but also returns `brackets` (bracket fill) for analytics. Slower;
   * use from the UI/analytics layer only.
   */
  explainYear?(input: TaxYearInput, priorLevels: TaxYearOutput[]): TaxYearOutput;
  /**
   * OPTIONAL: specialise a parameterised plug-in ('us-state' + 'CA' -> 'us-state:CA'). The registry
   * calls this for ids with a ':' suffix so the region no longer has to come from the location.
   */
  parameterize?(param: string): TaxJurisdiction;
  /**
   * OPTIONAL: age from which an account type can be accessed without penalty (UK normal minimum
   * pension age, US 59.5, AU preservation age...). null = no age rule from this jurisdiction.
   */
  pensionAccessAge?(q: PensionAccessQuery): number | null;
  /**
   * OPTIONAL: gain on selling a main residence that is excluded from tax (US §121 $250k/$500k; UK
   * private residence relief = Infinity). null = no exclusion.
   */
  homeSaleExclusion?(q: HomeSaleQuery): number | null;
  /**
   * OPTIONAL: statutory state-pension age for a birth cohort (UK State Pension age, German
   * Regelaltersgrenze, Dutch AOW age). null = no rule from this jurisdiction.
   */
  statePensionAge?(q: { birthYear: number; birthMonth: number }): number | null;
  /**
   * OPTIONAL: uplift (0.058 = +5.8%) for a state pension first paid `monthsDeferred` months after
   * the statutory age (UK +1% per 9 weeks; DE +0.5% a month). Absent = no deferral uplift.
   */
  statePensionDeferralUplift?(q: StatePensionDeferralQuery): number;
  /**
   * OPTIONAL: a sub-limit inside an account's contribution allowance (UK cash ISA). null = none.
   */
  contributionSubLimit?(q: ContributionSubLimitQuery): ContributionSubLimit | null;
  /** OPTIONAL: tax-year data provenance shown in the UI (tax year label + official source URLs). */
  sources?: { taxYear: string; url: string; note?: string }[];
  /** OPTIONAL: known simplifications of this plug-in, as plain sentences for the UI. */
  simplifications?: readonly string[];
}
