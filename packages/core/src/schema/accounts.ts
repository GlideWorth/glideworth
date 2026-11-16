/**
 * Accounts (cash, investment, retirement, education, health) and their behaviour settings.
 *
 * Split, mirroring the product we match:
 *   - `Account` lives in CurrentFinances: identity, owner, starting balance, cost basis, and a
 *     default `behaviour`.
 *   - Plans may override behaviour per account (`Plan.accountSettings[accountId]`) and may create
 *     accounts that open in the future (`Plan.plannedAccounts`).
 */
import { z } from "zod";
import {
  Amount,
  Appearance,
  CountryCode,
  CurrencyCode,
  Fraction,
  Id,
  MonthDate,
  NonNegativeMoney,
  Notes,
  Owner,
  Rate,
} from "./primitives.js";
import { sparsePartial } from "./sparse.js";
import { AccountRateSpec, DateRef, SchedulePoint } from "./time.js";

export const ACCOUNT_TYPES = [
  // Cash
  "cash",
  "savings",
  "certificate",
  // Generic investment
  "taxable",
  "crypto",
  // US retirement
  "traditional-ira",
  "roth-ira",
  "sep-ira",
  "simple-ira",
  "inherited-ira",
  "inherited-roth-ira",
  "401k",
  "roth-401k",
  "403b",
  "roth-403b",
  "457b",
  "roth-457b",
  "401a",
  "solo-401k",
  "tsp",
  "roth-tsp",
  // US health / education
  "hsa",
  "529",
  "coverdell-esa",
  // UK
  "uk-isa",
  "uk-lisa",
  "uk-sipp",
  "uk-workplace-pension",
  "uk-pension",
  "uk-gia",
  // Canada
  "ca-tfsa",
  "ca-rrsp",
  "ca-rrif",
  "ca-fhsa",
  "ca-resp",
  "ca-lira",
  "ca-non-registered",
  // Australia
  "au-super-accumulation",
  "au-super-pension",
  // Europe / Israel / New Zealand (tax/jurisdictions/{de,nl,fr,es,il,ie,nz}.ts)
  "de-bav",
  "de-riester",
  "de-ruerup",
  "nl-pension",
  "fr-pea",
  "fr-assurance-vie",
  "fr-per",
  "es-plan-pensiones",
  "il-pension",
  "il-keren-hishtalmut",
  "ie-pension",
  "nz-kiwisaver",
  // United Arab Emirates (tax/jurisdictions/ae.ts)
  "ae-dews",
  "ae-savings-scheme",
  // Generic escape hatches for any other jurisdiction
  "generic-tax-deferred",
  "generic-tax-free",
  "other",
] as const;
export const AccountType = z.enum(ACCOUNT_TYPES).meta({ id: "AccountType" });
export type AccountType = z.infer<typeof AccountType>;

/** How growth and withdrawals are taxed. Derived from the type by default; overridable. */
export const TaxTreatment = z
  .enum(["cash", "taxable", "tax-deferred", "tax-free", "hsa", "education"])
  .meta({ id: "TaxTreatment" });
export type TaxTreatment = z.infer<typeof TaxTreatment>;

/** Buckets for the drawdown order and for stacked charts. */
export const DrawdownCategory = z
  .enum([
    "cash",
    "taxable",
    "crypto",
    "tax-deferred",
    "tax-free",
    "hsa",
    "education",
    "real-assets",
  ])
  .meta({ id: "DrawdownCategory" });
export type DrawdownCategory = z.infer<typeof DrawdownCategory>;

export const AccountCategory = z
  .enum(["cash", "investment", "retirement", "education", "health", "other"])
  .meta({ id: "AccountCategory" });
export type AccountCategory = z.infer<typeof AccountCategory>;

export const WithdrawalRule = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("always") }),
    z.object({ kind: z.literal("never") }),
    z.object({ kind: z.literal("afterQualifiedAge") }),
    z.object({ kind: z.literal("from"), ref: DateRef }),
    z.object({ kind: z.literal("until"), ref: DateRef }),
  ])
  .meta({ id: "WithdrawalRule" });
export type WithdrawalRule = z.infer<typeof WithdrawalRule>;

export const LiquidityRule = z
  .enum(["always", "never", "whenWithdrawable", "afterQualifiedAge"])
  .meta({ id: "LiquidityRule" });

export const FeeSpec = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("none") }),
    z.object({ kind: z.literal("percentOfBalance"), rate: Rate }),
    z.object({ kind: z.literal("percentOfEarnings"), rate: Rate }),
    z.object({ kind: z.literal("amount"), amount: Amount }),
  ])
  .meta({ id: "FeeSpec" });

export const DividendSettings = z
  .object({
    yield: AccountRateSpec.default({ kind: "inherit" }),
    /** 'auto' lets the jurisdiction decide (e.g. US qualified vs ordinary split). */
    treatment: z
      .enum([
        "auto",
        "qualified",
        "ordinary",
        "tax-free",
        "municipal",
        "treasury",
        "ca-eligible",
        "ca-non-eligible",
        "au-franked",
        "au-unfranked",
      ])
      .default("auto"),
    /** For au-franked: share of dividends franked. For mixed treatments: share qualified. */
    qualifiedShare: Fraction.optional(),
    reinvest: z.union([z.boolean(), z.literal("inherit")]).default("inherit"),
  })
  .meta({ id: "DividendSettings" });

export const BondAllocation = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("inherit") }),
    z.object({ kind: z.literal("none") }),
    z.object({ kind: z.literal("fixed"), share: Fraction }),
    z.object({
      kind: z.literal("schedule"),
      interpolation: z.enum(["step", "linear"]).default("linear"),
      points: z.array(SchedulePoint).min(1),
    }),
  ])
  .meta({ id: "BondAllocation" });

export const DistributionRule = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("none") }),
    z.object({
      kind: z.literal("required"),
      /** Jurisdiction rule implementing required minimum distributions. */
      rule: z.enum([
        "us-rmd",
        "us-inherited-10-year",
        "us-inherited-stretch",
        "ca-rrif-minimum",
        "au-minimum-drawdown",
      ]),
      /** Distributions already taken in the first plan year (PL v4.5.0). */
      alreadyTakenThisYear: NonNegativeMoney.default(0),
    }),
    z.object({
      kind: z.literal("custom"),
      /** Amount per point (schedule.valueKind = amount) in `basis`. */
      points: z.array(SchedulePoint).min(1),
      basis: z.enum(["real", "nominal"]).default("real"),
    }),
  ])
  .meta({ id: "DistributionRule" });

export const SeppSettings = z
  .object({
    method: z
      .enum(["none", "rmd", "fixed-amortization", "fixed-annuitization", "custom"])
      .default("none"),
    start: DateRef.optional(),
    interestRate: Rate.optional(),
    customAmount: Amount.optional(),
  })
  .meta({ id: "SeppSettings" });

/** Behaviour of an account in a simulation. Every field has a default so `{}` is valid. */
export const AccountBehaviour = z
  .object({
    growth: AccountRateSpec.default({ kind: "inherit" }),
    dividends: DividendSettings.default({
      yield: { kind: "inherit" },
      treatment: "auto",
      reinvest: "inherit",
    }),
    fees: FeeSpec.default({ kind: "none" }),
    bondAllocation: BondAllocation.default({ kind: "inherit" }),
    withdrawals: WithdrawalRule.default({ kind: "always" }),
    liquid: LiquidityRule.default("whenWithdrawable"),
    earlyWithdrawal: z
      .object({
        enabled: z.boolean().default(false),
        qualifiedAge: z.number().min(0).max(100).default(59.5),
        penaltyRate: Rate.default(0.1),
      })
      .default({ enabled: false, qualifiedAge: 59.5, penaltyRate: 0.1 }),
    distributions: DistributionRule.default({ kind: "none" }),
    sepp: SeppSettings.default({ method: "none" }),
    /** Chance-of-success treatment (PL: Fixed vs Auto). */
    monteCarlo: z.enum(["auto", "fixed"]).default("auto"),
    /** UK pensions: UFPLS (25% of each withdrawal tax-free) or PCLS (lump sum up front). */
    ukDrawdownMethod: z.enum(["ufpls", "pcls"]).optional(),
    /** Share of withdrawals that is tax-free (UK 25%, custom pensions). */
    taxFreeWithdrawalShare: Fraction.optional(),
    /** HSA contribution-limit tier. */
    hsaCoverage: z.enum(["self", "family"]).optional(),
    /** Link as an offset account to a debt or financed asset loan (AU/UK offset mortgages). */
    offsetForLoanId: Id.optional(),
    /** Treat as "excess cash" first in drawdown (PL 'repurpose'). */
    isExcessCash: z.boolean().default(false),
  })
  .meta({ id: "AccountBehaviour" });
export type AccountBehaviour = z.infer<typeof AccountBehaviour>;

/**
 * Partial overrides a plan applies on top of an account's default behaviour (shallow per key).
 * Truly sparse: absent keys stay absent after parsing (no defaults are filled in).
 */
export const AccountBehaviourPatch = sparsePartial(AccountBehaviour).meta({
  id: "AccountBehaviourPatch",
});
export type AccountBehaviourPatch = z.infer<typeof AccountBehaviourPatch>;

export const InheritedAccountInfo = z
  .object({
    originalOwnerBirthMonth: MonthDate,
    originalOwnerDeathMonth: MonthDate,
    beneficiaryClass: z
      .enum(["eligible-designated", "designated", "non-designated"])
      .default("designated"),
  })
  .meta({ id: "InheritedAccountInfo" });

export const Account = z
  .object({
    id: Id,
    name: z.string().min(1).max(120),
    type: AccountType,
    owner: Owner,
    /** Balance at CurrentFinances.asOf (or Plan.startingConditions.asOf for fixed-date plans). */
    balance: z.number(),
    /** Taxable/529/crypto: aggregate cost basis in money. May exceed balance. */
    costBasis: NonNegativeMoney.optional(),
    /** Roth-type: cumulative contributions (withdrawable tax/penalty-free). */
    contributionBasis: NonNegativeMoney.optional(),
    /** Overrides the type's default tax treatment (rare; e.g. 'other' accounts). */
    taxTreatment: TaxTreatment.optional(),
    /**
     * Country the account is held in (its situs) and whose statutory rules apply to it: contribution
     * limits, access ages, whether non-residents may still pay in, how its income is sourced (a UK
     * pension held by someone living abroad stays a UK pension). Absent = the account type's country
     * (uk-isa -> GB), else the household's country (`Household.location`).
     */
    jurisdiction: CountryCode.optional(),
    /**
     * UK ISAs: which kind. A cash ISA counts toward the cash ISA sub-limit (from April 2027, for
     * savers under 65) as well as the overall ISA allowance. Absent = stocks and shares.
     */
    ukIsaType: z.enum(["cash", "stocks-and-shares", "innovative-finance"]).optional(),
    /**
     * Currency the balance, cost basis and contribution basis are in. Absent = the household's base
     * currency. Foreign accounts are converted to the base currency with `CurrentFinances.fxRates`;
     * results report base-currency figures plus `closingOriginal` in this currency.
     */
    currency: CurrencyCode.optional(),
    inherited: InheritedAccountInfo.optional(),
    /**
     * Month the account was opened / first funded (US Roth five-year rule). Absent = long enough
     * ago that the five-year clock is satisfied; planned accounts use their `opensAt`.
     */
    openedOn: MonthDate.optional(),
    behaviour: AccountBehaviour.default(AccountBehaviour.parse({})),
    institution: z.string().max(120).optional(),
    notes: Notes.optional(),
    appearance: Appearance.optional(),
    archived: z.boolean().default(false),
  })
  .meta({ id: "Account" });
export type Account = z.infer<typeof Account>;
export type AccountInput = z.input<typeof Account>;

/** An account created inside a plan that opens at a future date with zero balance. */
export const PlannedAccount = Account.extend({ opensAt: DateRef }).meta({ id: "PlannedAccount" });
export type PlannedAccount = z.infer<typeof PlannedAccount>;
