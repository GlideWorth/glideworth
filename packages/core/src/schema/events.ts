/** Income and expense events. Both share a common base (amount, frequency, time range, change). */
import { z } from "zod";
import {
  Amount,
  Appearance,
  CountryCode,
  CurrencyCode,
  Fraction,
  Frequency,
  Id,
  MonthDate,
  NonNegativeAmount,
  NonNegativeMoney,
  Notes,
  Owner,
  Rate,
} from "./primitives.js";
import { Change, ChangeLimit, DateRef, Recurrence, SchedulePoint, TimeRange } from "./time.js";

/** Tax character of income. 'auto' lets the jurisdiction infer it from the income type. */
export const TaxCharacter = z
  .enum([
    "auto",
    "wage",
    "self-employment",
    "ordinary",
    "pension",
    "social-security",
    "qualified-dividend",
    "ordinary-dividend",
    "interest",
    "capital-gains-long",
    "capital-gains-short",
    "rental",
    "tax-free",
  ])
  .meta({ id: "TaxCharacter" });
export type TaxCharacter = z.infer<typeof TaxCharacter>;

export const Withholding = z
  .discriminatedUnion("mode", [
    z.object({ mode: z.literal("auto") }),
    z.object({ mode: z.literal("fixed"), rate: Rate }),
    z.object({ mode: z.literal("none") }),
  ])
  .meta({ id: "Withholding" });

/** Where money goes / comes from when not via the default cash pool + flows. */
export const AccountRouting = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("auto") }),
    /** Ordered: primary first, then backups. Income splits evenly across listed accounts. */
    z.object({
      kind: z.literal("accounts"),
      accountIds: z.array(Id).min(1),
      /**
       * Income routing only: stop depositing into an account once its contribution limit for the
       * period is used up; the overflow goes to the next listed account, then to the cash pool.
       */
      preventOverflow: z.boolean().optional(),
    }),
  ])
  .meta({ id: "AccountRouting" });
export type AccountRouting = z.infer<typeof AccountRouting>;

const EventBase = z.object({
  id: Id,
  name: z.string().min(1).max(120),
  owner: Owner,
  /** Amount per occurrence (see `frequency`). Never negative (validation rejects it). */
  amount: NonNegativeAmount,
  frequency: Frequency,
  range: TimeRange,
  change: Change.default({ kind: "inflation", plus: 0 }),
  changeLimit: ChangeLimit.optional(),
  /** Grow the starting amount from the plan start even if the event starts later (PL v4.6.0). */
  growFromToday: z.boolean().default(true),
  /**
   * Inflation category the `inflation` change (and the today's-money basis) follows: 'general' (the
   * plan's inflation, the default) or the id of one of `assumptions.inflationCategories`.
   */
  inflationCategory: Id.optional(),
  /** Currency of `amount`. Absent = the household's base currency (converted with the FX table). */
  currency: CurrencyCode.optional(),
  recurrence: Recurrence.optional(),
  enabled: z.boolean().default(true),
  notes: Notes.optional(),
  appearance: Appearance.optional(),
});

const IncomeTax = z
  .object({
    character: TaxCharacter.default("auto"),
    withholding: Withholding.default({ mode: "auto" }),
    /** Jurisdiction ids (e.g. 'us-federal', 'us-state') where this income is exempt. */
    exemptIn: z.array(z.string()).default([]),
  })
  .meta({ id: "IncomeTax" });

const IncomeCommon = EventBase.extend({
  tax: IncomeTax.default({ character: "auto", withholding: { mode: "auto" }, exemptIn: [] }),
  /** auto = cash pool, then Flows; accounts = deposit directly. */
  sendTo: AccountRouting.default({ kind: "auto" }),
  partTime: z
    .object({ range: TimeRange, share: Fraction })
    .optional()
    .describe("Scale the amount to `share` during `range` (e.g. 0.5 for half-time)."),
  /**
   * Share of this income that continues to the surviving partner after the owner dies
   * (pensions, annuities). Default: stops at death.
   */
  survivorShare: Fraction.optional(),
  /**
   * Country the income is sourced in (where the work is done, the payer of a pension...). Absent:
   * pay and self-employment are sourced where the owner lives at the time; other income in the
   * household's country (`Household.location`); a state pension in its own `country`.
   */
  country: CountryCode.optional(),
  /**
   * Government / public-service pension (taxed under the treaty article for government service,
   * usually only by the paying country). Applies to 'pension' and 'annuity' events.
   */
  governmentService: z.boolean().optional(),
});

/**
 * End-of-service benefit paid as a lump sum when the employment ends (UAE gratuity under Article 51
 * of Federal Decree-Law 33 of 2021). The engine pays it in the month after the salary's range ends,
 * from the salary's last basic wage (`basicShare` of the amount) and years of service.
 */
export const EndOfServiceBenefit = z
  .object({
    scheme: z.literal("ae-gratuity"),
    /** First month of continuous service (default: the salary's start, or the plan start). */
    serviceStart: MonthDate.optional(),
    /** Share of the salary amount that is basic wage (allowances excluded). Default 1. */
    basicShare: Fraction.default(1),
  })
  .meta({ id: "EndOfServiceBenefit" });
export type EndOfServiceBenefit = z.infer<typeof EndOfServiceBenefit>;

/**
 * A bonus set as a share of a salary instead of a fixed amount. Each year the bonus is `rate` times
 * the linked salary's pay that year (after the salary's own growth, part-time share and the owner's
 * death; prorated when the salary runs for part of the year, 0 in a year with no salary). The
 * bonus's own frequency spreads that annual figure, and its range, recurrence and part-time share
 * apply as usual; its `amount`, `change`, `changeLimit`, `inflationCategory` and `currency` are
 * ignored.
 */
export const BonusPercentOfSalary = z
  .object({
    /** Id of a `salary` income event in the same plan. */
    salaryIncomeId: Id,
    /** Share of the annual salary, as a fraction (0.1 = 10%). */
    rate: z.number().min(0).max(10),
  })
  .meta({ id: "BonusPercentOfSalary" });
export type BonusPercentOfSalary = z.infer<typeof BonusPercentOfSalary>;

export const DefinedBenefitPension = z
  .object({
    employeeContribution: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("percentOfPay"), rate: Rate }),
      z.object({ kind: z.literal("amount"), amount: Amount }),
    ]),
    contributionsReduceTaxableIncome: z.boolean().default(true),
    payouts: TimeRange,
    payout: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("percentOfFinalPay"), rate: Rate }),
      z.object({ kind: z.literal("percentOfCareerAverage"), rate: Rate }),
      z.object({ kind: z.literal("amount"), amount: Amount }),
    ]),
    payoutsTaxFree: z.boolean().default(false),
    payoutChange: Change.default({ kind: "inflation", plus: 0 }),
    /** Share of the payout continuing to a surviving partner. */
    survivorShare: Fraction.optional(),
  })
  .meta({ id: "DefinedBenefitPension" });

export const SocialSecurityEstimate = z
  .object({
    /** Primary insurance amount: monthly benefit at full retirement age, in today's money. */
    pia: NonNegativeMoney,
    claimAge: z.number().min(62).max(70),
    fullRetirementAge: z.number().min(62).max(70).optional(),
    includePlannedEarnings: z.boolean().default(true),
    expectedShare: Fraction.default(1),
    priorCoveredEarnings: z
      .array(z.object({ year: z.number().int(), earnings: NonNegativeMoney }))
      .default([]),
    spousal: z.boolean().default(true),
    survivor: z.boolean().default(true),
  })
  .meta({ id: "SocialSecurityEstimate" });

export const IncomeEvent = z
  .discriminatedUnion("type", [
    IncomeCommon.extend({
      type: z.literal("salary"),
      pension: DefinedBenefitPension.optional(),
      endOfService: EndOfServiceBenefit.optional(),
    }),
    IncomeCommon.extend({
      type: z.literal("hourly"),
      hoursPerWeek: z.number().min(0).max(168),
      pension: DefinedBenefitPension.optional(),
    }),
    IncomeCommon.extend({ type: z.literal("self-employment") }),
    IncomeCommon.extend({
      type: z.literal("bonus"),
      /** Absent: the bonus is the fixed `amount`. Present: a share of a linked salary. */
      percentOfSalary: BonusPercentOfSalary.optional(),
    }),
    IncomeCommon.extend({
      type: z.literal("rsu"),
      /** Vesting schedule: amount (in `amount.basis`) vesting at each point. Overrides amount/frequency. */
      vesting: z.array(SchedulePoint).default([]),
      destinationAccountId: Id.optional(),
    }),
    IncomeCommon.extend({ type: z.literal("inheritance") }),
    IncomeCommon.extend({ type: z.literal("windfall") }),
    IncomeCommon.extend({
      type: z.literal("social-security"),
      /** 'amount' uses `amount`; 'estimate' computes benefits from PIA and claim age. */
      mode: z.enum(["amount", "estimate"]).default("amount"),
      estimate: SocialSecurityEstimate.optional(),
    }),
    IncomeCommon.extend({ type: z.literal("pension") }),
    IncomeCommon.extend({ type: z.literal("annuity"), purchaseExpenseId: Id.optional() }),
    IncomeCommon.extend({
      type: z.literal("state-pension"),
      country: CountryCode.optional(),
      /**
       * UK-style triple lock: each year the benefit rises by the highest of inflation, earnings
       * growth (inflation + `earningsPremium`) and `floor`. Overrides `change` when present.
       */
      tripleLock: z
        .object({ earningsPremium: Rate.default(0.01), floor: Rate.default(0.025) })
        .optional(),
      /**
       * Deferral uplift when the pension starts after State Pension age. 'auto' (default for UK
       * State Pensions): the new State Pension rule, +1% for every 9 weeks deferred (about 5.8% a
       * year), only when deferred at least 9 weeks; the amount entered is the full rate at State
       * Pension age. 'none': no uplift. 'rate': your own uplift per year deferred (pro rata).
       */
      deferral: z
        .discriminatedUnion("kind", [
          z.object({ kind: z.literal("auto") }),
          z.object({ kind: z.literal("none") }),
          z.object({ kind: z.literal("rate"), ratePerYear: Rate }),
        ])
        .optional(),
    }),
    IncomeCommon.extend({ type: z.literal("ca-cpp"), survivor: z.boolean().default(true) }),
    IncomeCommon.extend({ type: z.literal("ca-oas") }),
    IncomeCommon.extend({ type: z.literal("ca-gis") }),
    IncomeCommon.extend({ type: z.literal("other") }),
  ])
  .meta({ id: "IncomeEvent" });
export type IncomeEvent = z.infer<typeof IncomeEvent>;
export type IncomeEventInput = z.input<typeof IncomeEvent>;
export type IncomeType = IncomeEvent["type"];

export const SpendingType = z.enum(["essential", "discretionary", "hybrid", "not-spending"]).meta({
  id: "SpendingType",
  description: "Flexibility class. 'hybrid' uses discretionaryShare.",
});
export type SpendingType = z.infer<typeof SpendingType>;

const ExpenseTax = z
  .object({
    treatment: z.enum(["auto", "taxable", "tax-exempt"]).default("auto"),
    deductible: z.boolean().default(false),
    itemized: z.boolean().default(false),
    /** Jurisdiction levels where deductible. */
    deductibleIn: z
      .array(z.enum(["federal", "state", "local"]))
      .default(["federal", "state", "local"]),
    /** Pre-tax payroll deduction from this income event. */
    payrollDeductionFromIncomeId: Id.optional(),
  })
  .meta({ id: "ExpenseTax" });

const ExpenseCommon = EventBase.extend({
  spendingType: SpendingType.default("essential"),
  /** For 'hybrid': share that is discretionary (cut first in a shortfall / flex rules). */
  discretionaryShare: Fraction.optional(),
  payFrom: AccountRouting.default({ kind: "auto" }),
  tax: ExpenseTax.default({
    treatment: "auto",
    deductible: false,
    itemized: false,
    deductibleIn: ["federal", "state", "local"],
  }),
  dependentId: Id.optional(),
});

export const HealthcareDetails = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("standard") }),
    z.object({
      kind: z.literal("aca"),
      benchmarkPremium: Amount,
      householdSize: z.number().int().min(1).max(20),
      advanceCreditShare: Fraction.default(1),
    }),
    z.object({
      kind: z.literal("medicare"),
      personId: Id,
      partB: Amount.optional(),
      partD: Amount.optional(),
      partA: Amount.optional(),
      supplemental: z
        .discriminatedUnion("kind", [
          z.object({ kind: z.literal("none") }),
          z.object({ kind: z.literal("medigap"), premium: Amount }),
          z.object({ kind: z.literal("advantage"), premium: Amount }),
        ])
        .default({ kind: "none" }),
      enrollment: DateRef.optional(),
    }),
  ])
  .meta({ id: "HealthcareDetails" });

export const CharityDetails = z
  .object({
    vehicle: z.enum(["cash", "qcd", "daf"]).default("cash"),
    qcdFromAccountId: Id.optional(),
    carryforward: z.boolean().default(true),
  })
  .meta({ id: "CharityDetails" });

export const ExpenseEvent = z
  .discriminatedUnion("type", [
    ExpenseCommon.extend({ type: z.literal("living") }),
    ExpenseCommon.extend({ type: z.literal("housing") }),
    ExpenseCommon.extend({
      type: z.literal("healthcare"),
      healthcare: HealthcareDetails.default({ kind: "standard" }),
    }),
    /**
     * Long-term care (care home, home care, nursing). Treated like a healthcare expense: qualified
     * medical use for HSA withdrawals; new events default to healthcare inflation (general
     * inflation + `assumptions.healthcareInflationPremium`). Start it at an age or milestone with
     * `range.start`.
     */
    ExpenseCommon.extend({ type: z.literal("long-term-care") }),
    ExpenseCommon.extend({ type: z.literal("education") }),
    ExpenseCommon.extend({ type: z.literal("childcare") }),
    ExpenseCommon.extend({ type: z.literal("dependent-support") }),
    ExpenseCommon.extend({ type: z.literal("travel") }),
    ExpenseCommon.extend({ type: z.literal("wedding") }),
    ExpenseCommon.extend({ type: z.literal("charity"), charity: CharityDetails.optional() }),
    ExpenseCommon.extend({ type: z.literal("transportation") }),
    ExpenseCommon.extend({ type: z.literal("insurance") }),
    ExpenseCommon.extend({ type: z.literal("entertainment") }),
    ExpenseCommon.extend({ type: z.literal("personal") }),
    ExpenseCommon.extend({ type: z.literal("pets") }),
    ExpenseCommon.extend({ type: z.literal("tax-payment") }),
    ExpenseCommon.extend({
      type: z.literal("tax-deduction"),
      /** A pure deduction/credit with no cash outflow when amount is 0 cash. */
      creditOrDeduction: z.enum(["deduction", "credit"]).default("deduction"),
    }),
    ExpenseCommon.extend({ type: z.literal("other") }),
  ])
  .meta({ id: "ExpenseEvent" });
export type ExpenseEvent = z.infer<typeof ExpenseEvent>;
export type ExpenseEventInput = z.input<typeof ExpenseEvent>;
export type ExpenseType = ExpenseEvent["type"];
