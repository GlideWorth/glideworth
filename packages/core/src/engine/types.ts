/**
 * Public contracts of the deterministic engine: `simulate(input) -> ProjectionResult`.
 *
 * All result money is NOMINAL (actual currency of that period). Each period carries
 * `priceIndexStart` and `priceIndex` (cumulative inflation since the reference month at the period
 * start and end), so any series converts to today's money with `toBasis(value, period, basis,
 * measure)`: flows by the start index, stocks by the end index. This keeps one source of truth and
 * makes "real vs nominal" a pure presentation choice for every series.
 *
 * Resolution: periods are annual today (`meta.resolution = 'annual'`, `months = 12`). Everything
 * is keyed by `startMonth` + `months` so monthly periods can be added later without changing
 * consumers that iterate `periods`.
 */
import { z } from "zod";
import { DrawdownCategory } from "../schema/accounts.js";
import { SpendingType, TaxCharacter } from "../schema/events.js";
import { Household } from "../schema/household.js";
import { CurrentFinances, Plan } from "../schema/plan.js";
import { Id, MonthDate, type ValueBasis } from "../schema/primitives.js";
import type { HistoricalSeries } from "../schema/time.js";

// ---------------------------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------------------------

/** Realised market rates for one period (decimal fractions). */
export const MarketPeriod = z
  .object({
    stocks: z.number(),
    bonds: z.number(),
    cash: z.number(),
    inflation: z.number(),
    dividendYield: z.number(),
    bondYield: z.number(),
    crypto: z.number(),
    /** Historical year this period was drawn from, when applicable. */
    sourceYear: z.number().int().optional(),
    /**
     * Optional FX shocks (Monte Carlo FX risk): per foreign currency, the multiplicative surprise to
     * its base-currency value over this period on top of the deterministic drift, as an annual
     * factor (1 = on the drift; 1.05 = the currency is worth 5% more than expected after a year).
     */
    fx: z.record(z.string(), z.number().positive()).optional(),
  })
  .meta({ id: "MarketPeriod" });
export type MarketPeriod = z.infer<typeof MarketPeriod>;

/** A full path of market rates. Monte Carlo / historical runners supply one per trial. */
export const MarketPath = z.object({ periods: z.array(MarketPeriod) }).meta({ id: "MarketPath" });
export type MarketPath = z.infer<typeof MarketPath>;

export const SimulationOptions = z
  .object({
    /** off: no trace; summary: one entry per notable decision; full: every phase step. */
    trace: z.enum(["off", "summary", "full"]).default("summary"),
    /**
     * strict (default): throw NotImplementedError when the plan uses a feature whose engine
     * phase is not implemented yet. non-strict: skip it and emit a FEATURE_NOT_MODELLED warning.
     */
    strict: z.boolean().default(true),
    /** Override plan assumptions with explicit per-period market rates. */
    market: MarketPath.optional(),
    /** Only 'annual' is implemented. */
    resolution: z.enum(["annual", "monthly"]).default("annual"),
    /** Skip per-period ledger/line items (fast path for Monte Carlo trials). */
    lean: z.boolean().default(false),
    /**
     * Which items count toward the Spending metric (UserSettings.spending). Absent = the
     * UserSettings defaults (mortgage interest counts, principal does not, taxes do not).
     */
    spendingDefinition: z
      .object({
        includeTaxes: z.boolean().default(false),
        includeMortgage: z.boolean().default(true),
        includeMortgagePrincipal: z.boolean().default(false),
        includeConsumerDebtPrincipal: z.boolean().default(false),
      })
      .optional(),
  })
  .meta({ id: "SimulationOptions" });
export type SimulationOptions = z.infer<typeof SimulationOptions>;
export type SimulationOptionsInput = z.input<typeof SimulationOptions>;

/**
 * Historical market data used by deterministic `RateSpec.historical` sequences. Supplied by the
 * stochastic workstream (c) through `simulate(input, { historical })`.
 */
export interface HistoricalDataset {
  /** First and last calendar years available for a series. */
  range(series: z.infer<typeof HistoricalSeries>): { first: number; last: number } | null;
  /** Annual value (decimal fraction) for a series in a calendar year. */
  value(series: z.infer<typeof HistoricalSeries>, year: number): number | undefined;
}

export const SimulationInput = z
  .object({
    household: Household,
    /** Live CurrentFinances. Ignored when plan.startingConditions is a snapshot. */
    finances: CurrentFinances,
    plan: Plan,
    options: SimulationOptions.default(SimulationOptions.parse({})),
  })
  .meta({ id: "SimulationInput" });
export type SimulationInput = z.infer<typeof SimulationInput>;
export type SimulationInputInput = z.input<typeof SimulationInput>;

// ---------------------------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------------------------

export const AccountPeriod = z
  .object({
    accountId: Id,
    category: DrawdownCategory,
    opening: z.number(),
    contributions: z.number(),
    withdrawals: z.number(),
    growth: z.number(),
    dividends: z.number(),
    fees: z.number(),
    transfersIn: z.number(),
    transfersOut: z.number(),
    closing: z.number(),
    costBasis: z.number().nullable(),
    contributionBasis: z.number().nullable(),
    withdrawable: z.boolean(),
    liquid: z.boolean(),
    /** Owner at period end (changes on survivor transfer). */
    owner: z.string().optional(),
    /** Dividends reinvested into the account (the rest were paid out to the cash pool). */
    dividendsReinvested: z.number().optional(),
    /** Forced distributions (RMD, inherited schedule, custom, 72(t)) taken this period. */
    requiredDistribution: z.number().optional(),
    /** Share of the account invested in bonds this period. */
    bondShare: z.number().optional(),
    /** Whether the account is open (planned accounts open later). */
    open: z.boolean().optional(),
    /** Foreign-currency accounts: the account's currency (all other figures are base currency). */
    currency: z.string().optional(),
    /** Foreign-currency accounts: closing balance in the account's own currency. */
    closingOriginal: z.number().optional(),
    /** Foreign-currency accounts: base-currency units per unit of `currency` at the period end. */
    fxRate: z.number().optional(),
    /** Foreign-currency accounts: FX revaluation included in `growth`. */
    fxGain: z.number().optional(),
  })
  .meta({ id: "AccountPeriod" });
export type AccountPeriod = z.infer<typeof AccountPeriod>;

export const RealAssetPeriod = z
  .object({
    assetId: Id,
    value: z.number(),
    loanBalance: z.number(),
    equity: z.number(),
    ownershipCosts: z.number(),
    loanPayments: z.number(),
    loanInterest: z.number(),
    rentalIncome: z.number(),
    owned: z.boolean(),
    /** Price paid when bought this period (planned purchases). */
    purchasePrice: z.number().optional(),
    /** Net proceeds (after fees and loan payoff) when sold this period. */
    saleProceeds: z.number().optional(),
    owner: z.string().optional(),
    /** Foreign-currency assets: currency, value and loan balance in that currency, end FX rate. */
    currency: z.string().optional(),
    valueOriginal: z.number().optional(),
    loanBalanceOriginal: z.number().optional(),
    fxRate: z.number().optional(),
  })
  .meta({ id: "RealAssetPeriod" });
export type RealAssetPeriod = z.infer<typeof RealAssetPeriod>;

export const DebtPeriod = z
  .object({
    debtId: Id,
    opening: z.number(),
    interest: z.number(),
    payments: z.number(),
    forgiven: z.number(),
    closing: z.number(),
    /** Extra (above-schedule) payments made by debtPaydown flows / payoff strategies this period. */
    extraPayments: z.number().optional(),
    /** Foreign-currency debts: currency, closing balance in that currency, end FX rate. */
    currency: z.string().optional(),
    closingOriginal: z.number().optional(),
    fxRate: z.number().optional(),
  })
  .meta({ id: "DebtPeriod" });
export type DebtPeriod = z.infer<typeof DebtPeriod>;

export const IncomeLine = z
  .object({
    sourceId: z.string(),
    sourceKind: z.enum([
      "income",
      "dividend",
      "interest",
      "rental",
      "benefit",
      "pension",
      "asset-sale",
    ]),
    label: z.string(),
    owner: z.string(),
    amount: z.number(),
    taxCharacter: TaxCharacter,
    /** Foreign-currency events: the event's currency and the amount in it (`amount` is base). */
    currency: z.string().optional(),
    amountOriginal: z.number().optional(),
  })
  .meta({ id: "IncomeLine" });
export type IncomeLine = z.infer<typeof IncomeLine>;

export const ExpenseLine = z
  .object({
    sourceId: z.string(),
    sourceKind: z.enum([
      "expense",
      "debt-payment",
      "loan-payment",
      "asset-cost",
      "leftover-spending",
      "asset-purchase",
    ]),
    label: z.string(),
    category: z.string(),
    owner: z.string(),
    /** Amount the plan asked for this period. */
    requested: z.number(),
    /** Amount actually paid (requested minus any unfunded part). */
    funded: z.number(),
    spendingType: SpendingType,
    /** Share cut by flexible-spending rules this period (requested is already reduced). */
    flexCut: z.number().optional(),
    /** Foreign-currency events: the event's currency and the requested amount in it. */
    currency: z.string().optional(),
    requestedOriginal: z.number().optional(),
  })
  .meta({ id: "ExpenseLine" });
export type ExpenseLine = z.infer<typeof ExpenseLine>;

export const TaxLine = z
  .object({
    jurisdictionId: z.string(),
    kind: z.enum([
      "income",
      "capital-gains",
      "dividends",
      "payroll",
      "self-employment",
      "niit",
      "amt",
      "irmaa",
      "aca-reconciliation",
      "penalty",
      "wealth",
      "property",
      "local",
      "credit",
      "other",
    ]),
    label: z.string(),
    /** Positive = tax owed; credits are negative. */
    amount: z.number(),
    /** Base the line was computed on (for drill-down). */
    base: z.number().optional(),
    /**
     * Cross-border plans only: why this country taxes it. 'residence' (worldwide income of a
     * resident), 'source' (income sourced there, taxed as a non-resident), 'citizenship' (US
     * citizens abroad), 'relief' (credit for foreign tax). Absent = single-country plan (residence).
     */
    basis: z.enum(["residence", "source", "citizenship", "relief"]).optional(),
    /** Cross-border plans only: country (ISO alpha-2) of the jurisdiction. */
    country: z.string().optional(),
    /** Cross-border plans only: the person the line belongs to. */
    personId: z.string().optional(),
  })
  .meta({ id: "TaxLine" });
export type TaxLine = z.infer<typeof TaxLine>;

export const TaxPeriodResult = z
  .object({
    total: z.number(),
    lines: z.array(TaxLine),
    grossIncome: z.number(),
    taxableIncome: z.number(),
    effectiveRate: z.number(),
    marginalRate: z.number(),
    /** Withheld during the period (cash-flow timing). */
    withheld: z.number(),
    /** Prior-period settlement paid (+) or refunded (-) in this period. */
    settlement: z.number(),
    /** Jurisdiction-specific extra values (e.g. AGI, MAGI) for drill-down and IRMAA look-back. */
    facts: z.record(z.string(), z.number()).default({}),
    /** Cross-border plans only: the tax per country and basis, in the base currency. */
    byCountry: z
      .array(
        z.object({
          country: z.string(),
          basis: z.enum(["residence", "source", "citizenship", "relief"]),
          amount: z.number(),
        }),
      )
      .optional(),
    /**
     * OPTIONAL: bracket fill per jurisdiction/person/schedule from `TaxJurisdiction.explainYear`.
     * Only present with `options.trace: 'full'` (never in lean Monte Carlo runs).
     */
    brackets: z
      .array(
        z.object({
          jurisdictionId: z.string(),
          personId: z.string().optional(),
          schedule: z.string(),
          bands: z.array(
            z.object({
              label: z.string(),
              rate: z.number(),
              from: z.number(),
              to: z.number(),
              amount: z.number(),
              tax: z.number(),
            }),
          ),
        }),
      )
      .optional(),
  })
  .meta({ id: "TaxPeriodResult" });
export type TaxPeriodResult = z.infer<typeof TaxPeriodResult>;

export const LedgerNodeKind = z.enum([
  "income",
  "pool",
  "expense",
  "tax",
  "account",
  "debt",
  "asset",
  "external",
  "growth",
  "shortfall",
]);

export const LedgerNode = z
  .object({ id: z.string(), kind: LedgerNodeKind, label: z.string(), refId: z.string().optional() })
  .meta({ id: "LedgerNode" });
export type LedgerNode = z.infer<typeof LedgerNode>;

/** A money movement. The ledger is the single source for Sankey diagrams and explanations. */
export const LedgerEntry = z
  .object({
    from: z.string(),
    to: z.string(),
    amount: z.number().nonnegative(),
    kind: z.enum([
      "income",
      "expense",
      "tax",
      "contribution",
      "withdrawal",
      "debt-payment",
      "transfer",
      "leftover",
      "shortfall",
      "purchase",
      "sale",
    ]),
    /** Flow / event / account id that caused the movement. */
    causeId: z.string().optional(),
    /** The drawdown rule that decided a withdrawal (only for `proportional` / `fillToCeiling` entries). */
    rule: z
      .object({
        kind: z.enum(["proportional", "fill-to-ceiling"]),
        /** Position of the entry in `plan.drawdown.order` (1 = first). */
        entry: z.number().int(),
        /** fill-to-ceiling: whose taxable income was measured (absent where it is taxed jointly). */
        owner: z.string().optional(),
        /** fill-to-ceiling: the ceiling, in words ("top of the 20% band", "income 50,000"). */
        ceiling: z.string().optional(),
        /** fill-to-ceiling: the marginal rate of the band this withdrawal filled. */
        bandRate: z.number().optional(),
        /** fill-to-ceiling: taxable income that still fitted in that band before this withdrawal. */
        room: z.number().optional(),
      })
      .optional(),
  })
  .meta({ id: "LedgerEntry" });
export type LedgerEntry = z.infer<typeof LedgerEntry>;

export const PeriodTotals = z
  .object({
    netWorth: z.number(),
    liquidNetWorth: z.number(),
    assets: z.number(),
    liabilities: z.number(),
    portfolio: z.number(),
    cash: z.number(),
    realAssets: z.number(),
    income: z.number(),
    passiveIncome: z.number(),
    expenses: z.number(),
    spending: z.number(),
    taxes: z.number(),
    contributions: z.number(),
    withdrawals: z.number(),
    /**
     * Share of after-tax regular income that was saved, in [0, 1]:
     * `savedFromIncome / afterTaxIncome` (null when after-tax income is not positive). See
     * `savedFromIncome` and `afterTaxIncome`.
     */
    savingsRate: z.number().nullable(),
    /**
     * Savings-rate numerator: net saving (contributions - withdrawals, employer and government
     * top-ups included) minus the one-off inflows of the period (`oneOffInflows`), clamped to
     * [0, afterTaxIncome]. Saving a windfall or sale proceeds is not saving out of income.
     */
    savedFromIncome: z.number().optional(),
    /**
     * Savings-rate denominator: income (including employer pension contributions, relief-at-source
     * top-ups and LISA bonuses, which are counted on both sides) minus one-off income
     * (inheritances, windfalls) minus taxes. Asset-sale proceeds are never income.
     */
    afterTaxIncome: z.number().optional(),
    /** One-off cash of the period: asset-sale proceeds plus inheritance and windfall income. */
    oneOffInflows: z.number().optional(),
    withdrawalRate: z.number().nullable(),
    /** Expenses that could not be funded this period (> 0 means the plan failed this period). */
    shortfall: z.number(),
    byCategory: z.partialRecord(DrawdownCategory, z.number()),
    /** Net worth split by owner (person ids and 'joint'). */
    netWorthByOwner: z.record(z.string(), z.number()).optional(),
    /** Tax-free (UK PCLS/UFPLS) pension cash taken this period. */
    taxFreePensionCash: z.number().optional(),
    /**
     * Part of `income` (and of `contributions`) paid straight into accounts by an employer or the
     * government: employer pension contributions, UK relief-at-source top-ups, LISA bonuses. Not
     * cash the household receives: cash income = income - externalContributions.
     */
    externalContributions: z.number().optional(),
  })
  .meta({ id: "PeriodTotals" });
export type PeriodTotals = z.infer<typeof PeriodTotals>;

export const PeriodResult = z
  .object({
    index: z.number().int(),
    year: z.number().int(),
    startMonth: MonthDate,
    months: z.number().int().min(1).max(12),
    ages: z.record(z.string(), z.number()),
    alive: z.record(z.string(), z.boolean()),
    market: MarketPeriod,
    /**
     * Cumulative inflation factor at period END relative to the reference month (=1). Deflator for
     * STOCKS (balances, net worth: values at the period end). Use `toBasis(v, p, basis, 'stock')`.
     */
    priceIndex: z.number(),
    /**
     * Cumulative inflation factor at period START (the first period's is 1). Deflator for FLOWS
     * (income, spending, taxes, contributions: amounts the engine values at the period's price
     * level when it starts). Use `toBasis(v, p, basis, 'flow')`. Optional only so results cached
     * before it existed still parse; `deflator()` derives it from `priceIndex` when absent.
     */
    priceIndexStart: z.number().optional(),
    /**
     * Start-of-period index of each inflation category the plan defines (Assumptions.
     * inflationCategories), keyed by category id. Absent when the plan defines none.
     */
    categoryPriceIndexStart: z.record(z.string(), z.number()).optional(),
    accounts: z.array(AccountPeriod),
    realAssets: z.array(RealAssetPeriod),
    debts: z.array(DebtPeriod),
    income: z.array(IncomeLine),
    expenses: z.array(ExpenseLine),
    taxes: TaxPeriodResult,
    ledgerNodes: z.array(LedgerNode),
    ledger: z.array(LedgerEntry),
    milestonesReached: z.array(Id),
    totals: PeriodTotals,
    status: z.enum(["ok", "shortfall"]),
  })
  .meta({ id: "PeriodResult" });
export type PeriodResult = z.infer<typeof PeriodResult>;

export const MilestoneResolution = z
  .object({
    milestoneId: Id,
    name: z.string(),
    status: z.enum(["reached", "never", "disabled"]),
    month: MonthDate.nullable(),
    periodIndex: z.number().int().nullable(),
    ages: z.record(z.string(), z.number()).default({}),
    /** How it resolved: 'time' (from criteria dates) or 'metric' (from simulated state). */
    via: z.enum(["time", "metric", "mixed"]).nullable(),
  })
  .meta({ id: "MilestoneResolution" });
export type MilestoneResolution = z.infer<typeof MilestoneResolution>;

export const WarningCode = z.enum([
  "SHORTFALL",
  "DEPLETED",
  "EARLY_WITHDRAWAL_PENALTY",
  "MILESTONE_NEVER_REACHED",
  "NEGATIVE_BALANCE",
  "FEATURE_NOT_MODELLED",
  "DANGLING_REFERENCE",
  "ASSUMPTION",
  /** The plan named a historical dataset that has been withdrawn; a replacement was used. */
  "DATASET_REPLACED",
]);
export type WarningCode = z.infer<typeof WarningCode>;

/**
 * A money figure inside a warning. `template` writes it as `{token}` (for example `{shortfall}`)
 * so a display layer can format the nominal amount in the household currency and in the basis
 * that screen is showing. Flows deflate by the start-of-period index; balances by the end index.
 */
export const WarningAmount = z
  .object({
    token: z.string(),
    nominal: z.number(),
    measure: z.enum(["flow", "stock"]),
  })
  .meta({ id: "WarningAmount" });
export type WarningAmount = z.infer<typeof WarningAmount>;

export const SimWarning = z
  .object({
    code: WarningCode,
    severity: z.enum(["info", "warning", "error"]),
    /** Plain English, complete on its own. Money in it is nominal, in the household currency. */
    message: z.string(),
    periodIndex: z.number().int().nullable(),
    refs: z.array(z.string()).default([]),
    /**
     * `message` with each figure in `amounts` as a `{token}`, so a caller can format it in the money
     * basis it shows (`warningText`). Set only when the warning quotes money.
     */
    template: z.string().optional(),
    amounts: z.array(WarningAmount).optional(),
  })
  .meta({ id: "SimWarning" });
export type SimWarning = z.infer<typeof SimWarning>;

/** Explainability trace: why the engine did what it did. Consumed by insights/explain.ts. */
export const TraceEntry = z
  .object({
    periodIndex: z.number().int(),
    phase: z.string(),
    code: z.string(),
    message: z.string(),
    refs: z.array(z.string()).default([]),
    data: z.record(z.string(), z.unknown()).optional(),
  })
  .meta({ id: "TraceEntry" });
export type TraceEntry = z.infer<typeof TraceEntry>;

export const ProjectionSummary = z
  .object({
    success: z.boolean(),
    firstShortfallYear: z.number().int().nullable(),
    totalShortfall: z.number(),
    endNetWorth: z.number(),
    endNetWorthReal: z.number(),
    lifetimeTaxes: z.number(),
    lifetimeTaxesReal: z.number(),
    retirementYear: z.number().int().nullable(),
  })
  .meta({ id: "ProjectionSummary" });
export type ProjectionSummary = z.infer<typeof ProjectionSummary>;

export const ProjectionResult = z
  .object({
    meta: z.object({
      engineVersion: z.string(),
      schemaVersion: z.number().int(),
      resolution: z.enum(["annual", "monthly"]),
      planId: Id,
      planVersion: z.number().int(),
      currency: z.string(),
      /** Month all `real` values are expressed in (plan start month). */
      referenceMonth: MonthDate,
      startMonth: MonthDate,
      /** Last simulated month (inclusive). */
      endMonth: MonthDate,
      /** All money in `periods` is nominal; use priceIndex to convert. */
      valueBasis: z.literal("nominal"),
      /**
       * Exchange rates used (foreign currency -> base `currency`) at the plan start, with their
       * annual drift. Present only when some account, asset, debt or event is in another currency.
       */
      fxRates: z
        .array(z.object({ currency: z.string(), rate: z.number(), annualDrift: z.number() }))
        .optional(),
      strict: z.boolean(),
      /** OPTIONAL: tax-year data provenance of the jurisdictions used (`TaxJurisdiction.sources`). */
      taxSources: z
        .array(
          z.object({
            jurisdictionId: z.string(),
            taxYear: z.string(),
            url: z.string(),
            note: z.string().optional(),
          }),
        )
        .optional(),
    }),
    periods: z.array(PeriodResult),
    milestones: z.array(MilestoneResolution),
    warnings: z.array(SimWarning),
    summary: ProjectionSummary,
    trace: z.array(TraceEntry),
  })
  .meta({ id: "ProjectionResult" });
export type ProjectionResult = z.infer<typeof ProjectionResult>;

// ---------------------------------------------------------------------------------------------
// Today's money (the ONE conversion every layer uses; see ARCHITECTURE.md §3)
// ---------------------------------------------------------------------------------------------

/**
 * What a money value measures, which decides its deflator:
 *  - 'stock': a balance at the END of the period (net worth, account closing balances, loan
 *    balances). Deflated by the end-of-period index `priceIndex`.
 *  - 'flow': money that moves DURING the period (income, expenses, spending, taxes, contributions,
 *    withdrawals, shortfall). The engine values every flow at the price level in force when the
 *    period starts (amounts are valued at the first active month; a `real` amount entered for the
 *    first year is paid exactly as entered), so flows deflate by the start-of-period index
 *    `priceIndexStart`. An inflation-linked amount entered in today's money therefore reads back
 *    exactly as entered in every year it runs from the period start, whatever the period length.
 */
export type MoneyMeasure = "stock" | "flow";

/** The parts of a period the conversion needs (old cached results may lack `priceIndexStart`). */
export type DeflatablePeriod = Pick<PeriodResult, "priceIndex"> &
  Partial<Pick<PeriodResult, "priceIndexStart" | "months" | "market">>;

/**
 * Price index that converts a nominal value of `period` to today's money for the given measure.
 * Falls back to deriving the start index from `priceIndex`, `market.inflation` and `months` for
 * results produced before `priceIndexStart` existed.
 */
export function deflator(period: DeflatablePeriod, measure: MoneyMeasure = "stock"): number {
  if (measure === "stock") return period.priceIndex || 1;
  if (period.priceIndexStart !== undefined) return period.priceIndexStart || 1;
  if (period.market && period.months !== undefined)
    return period.priceIndex / (1 + period.market.inflation) ** (period.months / 12) || 1;
  return period.priceIndex || 1;
}

/**
 * Convert a nominal amount of `period` to the requested basis. THE conversion used by core, the
 * API, MCP, exports and the web, so the layers cannot drift. `measure` defaults to 'stock' for
 * backwards compatibility; pass 'flow' for anything that happens during the period (or use
 * `totalsMeasure(key)` / `PERIOD_TOTALS_MEASURE` to look it up for a `PeriodTotals` field).
 */
export function toBasis(
  nominal: number,
  period: DeflatablePeriod,
  basis: ValueBasis,
  measure: MoneyMeasure = "stock",
): number {
  return basis === "nominal" ? nominal : nominal / deflator(period, measure);
}

/** Convert a today's-money amount of `period` to nominal (inverse of `toBasis`). */
export function fromBasis(
  value: number,
  period: DeflatablePeriod,
  basis: ValueBasis,
  measure: MoneyMeasure = "stock",
): number {
  return basis === "nominal" ? value : value * deflator(period, measure);
}

/**
 * Measure of every money field of `PeriodTotals` (ratios are `null`: never deflate them). The API
 * and web convert totals with `toBasis(v, p, basis, PERIOD_TOTALS_MEASURE[key] ?? 'stock')`.
 */
export const PERIOD_TOTALS_MEASURE: Readonly<Record<keyof PeriodTotals, MoneyMeasure | null>> = {
  netWorth: "stock",
  liquidNetWorth: "stock",
  assets: "stock",
  liabilities: "stock",
  portfolio: "stock",
  cash: "stock",
  realAssets: "stock",
  byCategory: "stock",
  netWorthByOwner: "stock",
  income: "flow",
  passiveIncome: "flow",
  expenses: "flow",
  spending: "flow",
  taxes: "flow",
  contributions: "flow",
  withdrawals: "flow",
  shortfall: "flow",
  taxFreePensionCash: "flow",
  externalContributions: "flow",
  savedFromIncome: "flow",
  afterTaxIncome: "flow",
  oneOffInflows: "flow",
  savingsRate: null,
  withdrawalRate: null,
};

/** Measure of a `PeriodTotals` key (or of a stochastic metric with the same name). */
export function totalsMeasure(key: string): MoneyMeasure | null {
  const m = (PERIOD_TOTALS_MEASURE as Record<string, MoneyMeasure | null | undefined>)[key];
  return m === undefined ? "stock" : m;
}

/**
 * Age a person reaches during a period (the label for that year): their age at the period start,
 * plus the months of the period, floored. The year someone turns 60 is labelled 60 even when the
 * period starts before their birthday. Matches milestone ages and the web's `periodAge`.
 */
export function periodAge(
  period: Pick<PeriodResult, "ages" | "months">,
  personId: string,
): number | null {
  const a = period.ages[personId];
  if (a === undefined) return null;
  return Math.floor(a + (period.months - 1) / 12 + 1e-9);
}

/** Extract a series from a projection in the requested basis. */
export function series(
  result: ProjectionResult,
  pick: (p: PeriodResult) => number,
  basis: ValueBasis,
  measure: MoneyMeasure = "stock",
): { year: number; value: number }[] {
  return result.periods.map((p) => ({ year: p.year, value: toBasis(pick(p), p, basis, measure) }));
}
