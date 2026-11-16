/** Real (non-financial) assets, their loans, and unsecured debts. */
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
import { Change, ChangeLimit, DateRef, Recurrence } from "./time.js";

export const REAL_ASSET_TYPES = [
  "house",
  "car",
  "rental-property",
  "commercial-property",
  "land",
  "building",
  "motorcycle",
  "boat",
  "jewelry",
  "precious-metals",
  "furniture",
  "instrument",
  "machinery",
  "collectible",
  "business",
  "custom",
] as const;
export const RealAssetType = z.enum(REAL_ASSET_TYPES).meta({ id: "RealAssetType" });
export type RealAssetType = z.infer<typeof RealAssetType>;

export const InterestModel = z
  .object({
    apr: Rate,
    method: z.enum(["simple", "compound"]).default("compound"),
    compounding: z.enum(["daily", "monthly", "annually"]).default("monthly"),
  })
  .meta({ id: "InterestModel" });

/** An amortising loan (mortgage, auto loan) attached to a real asset. */
export const Loan = z
  .object({
    id: Id,
    balance: NonNegativeMoney,
    interest: InterestModel,
    /** Scheduled payment per month, nominal unless basis says otherwise. */
    monthlyPayment: Amount,
    /** Optional fixed end (e.g. mortgage term). If absent, payments run until paid off. */
    termEnd: DateRef.optional(),
  })
  .meta({ id: "Loan" });
export type Loan = z.infer<typeof Loan>;

/** A recurring cost expressed as % of asset value or as an amount. */
export const AssetCost = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("none") }),
    z.object({ kind: z.literal("percentOfValue"), rate: Rate }),
    z.object({ kind: z.literal("amountPerYear"), amount: Amount }),
    z.object({ kind: z.literal("amountPerMonth"), amount: Amount }),
  ])
  .meta({ id: "AssetCost" });
export type AssetCost = z.infer<typeof AssetCost>;

export const PropertyTax = z
  .object({
    cost: AssetCost,
    assessedValue: z
      .discriminatedUnion("kind", [
        z.object({ kind: z.literal("marketValue") }),
        z.object({ kind: z.literal("specific"), amount: NonNegativeMoney }),
      ])
      .default({ kind: "marketValue" }),
    reassessment: z
      .discriminatedUnion("kind", [
        z.object({ kind: z.literal("auto") }),
        z.object({ kind: z.literal("default") }),
        z.object({ kind: z.literal("capped"), maxGrowth: Rate }),
        z.object({ kind: z.literal("ratcheting"), maxGrowth: Rate }),
      ])
      .default({ kind: "auto" }),
  })
  .meta({ id: "PropertyTax" });

export const RentalSettings = z
  .object({
    enabled: z.boolean().default(false),
    income: z
      .discriminatedUnion("kind", [
        z.object({ kind: z.literal("percentOfValue"), rate: Rate }),
        z.object({ kind: z.literal("amountPerYear"), amount: Amount }),
        z.object({ kind: z.literal("amountPerMonth"), amount: Amount }),
      ])
      .default({ kind: "percentOfValue", rate: 0.08 }),
    occupancy: Fraction.default(1),
    /** Share of the property that is rented (house hacking). The rest is personal use. */
    rentedShare: Fraction.default(1),
    management: AssetCost.default({ kind: "none" }),
    taxSettings: z
      .object({
        selfEmployment: z.boolean().default(false),
        estimateDeductions: z.boolean().default(true),
        qbiDeduction: z.boolean().default(false),
        buildingValue: NonNegativeMoney.default(0),
        classification: z.enum(["residential", "commercial"]).default("residential"),
        taxNetIncomeOnly: z.boolean().default(false),
      })
      .default({
        selfEmployment: false,
        estimateDeductions: true,
        qbiDeduction: false,
        buildingValue: 0,
        classification: "residential",
        taxNetIncomeOnly: false,
      }),
    countsAsPassiveIncome: z.boolean().default(true),
    /**
     * When the property is sold (scheduled sale or liquidation), the tenancy ends: rental income and
     * management costs stop from the sale month instead of running to the end of the sale period.
     * Default true; set false to keep rent for the whole period of the sale (PL `cancelRent` off).
     */
    cancelOnSale: z.boolean().optional(),
  })
  .meta({ id: "RentalSettings" });

export const AssetSale = z
  .object({
    at: DateRef,
    brokerFeeRate: Rate.default(0.06),
    /** Share of the gain exempted beyond automatic jurisdiction exclusions. */
    gainReduction: Fraction.default(0),
    proceedsTo: z
      .discriminatedUnion("kind", [
        z.object({ kind: z.literal("auto") }),
        z.object({ kind: z.literal("accounts"), accountIds: z.array(Id).min(1) }),
      ])
      .default({ kind: "auto" }),
  })
  .meta({ id: "AssetSale" });

export const AssetPurchase = z
  .object({
    at: DateRef,
    price: Amount,
    /** Market value right after purchase (defaults to price). */
    marketValue: Amount.optional(),
    downPayment: Amount.optional(),
    financing: Loan.omit({ balance: true }).optional(),
    fundFromAccountIds: z.array(Id).default([]),
  })
  .meta({ id: "AssetPurchase" });

/** Behaviour of a real asset in a plan; defaults on the asset, overridable per plan. */
export const RealAssetBehaviour = z
  .object({
    usage: z.enum(["primary-residence", "personal", "investment"]).default("personal"),
    appreciation: Change.default({ kind: "inflation", plus: 0 }),
    /**
     * Cap and/or floor on the asset's market value (in `basis` money; real = today's money). E.g. a
     * depreciating car with `min` = scrap value, or appreciation capped at a ceiling.
     */
    appreciationLimit: ChangeLimit.optional(),
    propertyTax: PropertyTax.optional(),
    maintenance: AssetCost.default({ kind: "none" }),
    insurance: AssetCost.default({ kind: "none" }),
    improvements: AssetCost.default({ kind: "none" }),
    hoa: AssetCost.default({ kind: "none" }),
    rental: RentalSettings.optional(),
    sale: AssetSale.optional(),
    recurrence: Recurrence.optional(),
    /** Sell automatically when needed to cover a shortfall (position by drawdown order). */
    liquidateIfNeeded: z.boolean().default(false),
    excludeLoanFromLiquidNetWorth: z.boolean().default(false),
  })
  .meta({ id: "RealAssetBehaviour" });
export type RealAssetBehaviour = z.infer<typeof RealAssetBehaviour>;

/** Plan-level sparse override of a real asset's behaviour (absent keys keep the asset's value). */
export const RealAssetBehaviourPatch = sparsePartial(RealAssetBehaviour).meta({
  id: "RealAssetBehaviourPatch",
});
export type RealAssetBehaviourPatch = z.infer<typeof RealAssetBehaviourPatch>;

export const RealAsset = z
  .object({
    id: Id,
    name: z.string().min(1).max(120),
    type: RealAssetType,
    owner: Owner,
    currentValue: NonNegativeMoney,
    purchasePrice: NonNegativeMoney.optional(),
    loan: Loan.optional(),
    /** Currency of the value, prices, loan and costs. Absent = the household's base currency. */
    currency: CurrencyCode.optional(),
    /**
     * Country the asset is in (situs): its rental income and gains are sourced there, whatever the
     * owner's residence. Absent = the household's country (`Household.location`).
     */
    country: CountryCode.optional(),
    /** Month the asset was acquired (non-resident gain rules: time apportionment, rebasing). */
    acquiredOn: MonthDate.optional(),
    /**
     * Known market values at past dates (in the asset's currency), e.g. the value at 5 April 2015
     * for UK non-resident capital gains tax rebasing. The non-resident rules pick the one dated at
     * their rebasing date.
     */
    valuations: z
      .array(z.object({ month: MonthDate, value: NonNegativeMoney }))
      .max(20)
      .optional(),
    behaviour: RealAssetBehaviour.default(RealAssetBehaviour.parse({})),
    notes: Notes.optional(),
    appearance: Appearance.optional(),
    archived: z.boolean().default(false),
  })
  .meta({ id: "RealAsset" });
export type RealAsset = z.infer<typeof RealAsset>;
export type RealAssetInput = z.input<typeof RealAsset>;

/** A real asset bought during the plan (with optional repeat purchases). */
export const PlannedRealAsset = RealAsset.omit({ currentValue: true, loan: true })
  .extend({ purchase: AssetPurchase })
  .meta({ id: "PlannedRealAsset" });
export type PlannedRealAsset = z.infer<typeof PlannedRealAsset>;

export const DEBT_TYPES = [
  "debt",
  "student-loan",
  "medical",
  "credit-card",
  "personal-loan",
  "auto-loan",
  "heloc",
  "tax-debt",
  "other",
] as const;
export const DebtType = z.enum(DEBT_TYPES).meta({ id: "DebtType" });

export const DebtBehaviour = z
  .object({
    paymentsStart: DateRef.default({ kind: "planStart", offsetMonths: 0 }),
    /** Plan-level override of the scheduled payment. */
    monthlyPaymentOverride: Amount.optional(),
    payFrom: z
      .discriminatedUnion("kind", [
        z.object({ kind: z.literal("auto") }),
        z.object({ kind: z.literal("accounts"), accountIds: z.array(Id).min(1) }),
      ])
      .default({ kind: "auto" }),
    forgiveness: z.object({ at: DateRef, taxable: z.boolean().default(false) }).optional(),
    interestTaxDeductible: z.boolean().default(false),
    /** Scheduled payments stop from this month (the remaining balance keeps accruing interest). */
    paymentsEnd: DateRef.optional(),
    /**
     * Change of the balance over time on top of interest and payments (PL debt `yearlyChange`): a
     * yearly rate applied to the balance (negative = the balance shrinks, e.g. indexation relief),
     * optionally clamped (nominal money).
     */
    balanceChange: z
      .object({ rate: Rate, min: NonNegativeMoney.optional(), max: NonNegativeMoney.optional() })
      .optional(),
  })
  .meta({ id: "DebtBehaviour" });
export type DebtBehaviour = z.infer<typeof DebtBehaviour>;

/** Plan-level sparse override of a debt's behaviour (absent keys keep the debt's value). */
export const DebtBehaviourPatch = sparsePartial(DebtBehaviour).meta({ id: "DebtBehaviourPatch" });
export type DebtBehaviourPatch = z.infer<typeof DebtBehaviourPatch>;

export const Debt = z
  .object({
    id: Id,
    name: z.string().min(1).max(120),
    type: DebtType,
    owner: Owner,
    balance: NonNegativeMoney,
    interest: InterestModel,
    monthlyPayment: Amount,
    /** Currency of the balance and payment. Absent = the household's base currency. */
    currency: CurrencyCode.optional(),
    /** Country of the lender (situs of the debt). Absent = the household's country. */
    country: CountryCode.optional(),
    behaviour: DebtBehaviour.default(DebtBehaviour.parse({})),
    notes: Notes.optional(),
    appearance: Appearance.optional(),
    archived: z.boolean().default(false),
  })
  .meta({ id: "Debt" });
export type Debt = z.infer<typeof Debt>;
export type DebtInput = z.input<typeof Debt>;
