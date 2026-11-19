/** Tax configuration stored on a plan. The computation lives in src/tax (TaxJurisdiction plug-ins). */
import { z } from "zod";
import { Fraction, Money, NonNegativeMoney, Rate } from "./primitives.js";

/**
 * Plan-level switches for items in another country (TaxConfig.crossBorder). The household lives
 * at `Household.location` for the whole plan; an account, property, debt or income in another
 * country is taxed there as a non-resident (treaty permitting) and where the household lives, with
 * a credit for double tax (ARCHITECTURE.md §4.6). Every field is optional.
 */
export const CrossBorderSettings = z
  .object({
    /** 'auto' (default): the rules apply when an item's country differs from the residence. */
    mode: z.enum(["auto", "off"]).optional(),
    /**
     * Per-pair override of how the residence country treats a foreign wrapper: key
     * `<residence>:<accountCountry>:<accountType>` -> recognised (true) or not (false).
     */
    wrapperRecognition: z.record(z.string(), z.boolean()).optional(),
  })
  .meta({ id: "CrossBorderSettings" });
export type CrossBorderSettings = z.infer<typeof CrossBorderSettings>;

export const FilingStatus = z
  .enum([
    "single",
    "married-joint",
    "married-separate",
    "head-of-household",
    "qualifying-surviving-spouse",
  ])
  .meta({ id: "FilingStatus" });
export type FilingStatus = z.infer<typeof FilingStatus>;

/** A progressive bracket table: each row taxes income from `from` up to the next row's `from`. */
export const BracketTable = z
  .object({
    brackets: z
      .array(z.object({ from: NonNegativeMoney, rate: Rate }))
      .min(1)
      .describe("Sorted ascending by `from`; first row should start at 0."),
    /** Thresholds are in this basis; 'real' thresholds are indexed with inflation. */
    basis: z.enum(["real", "nominal"]).default("real"),
  })
  .meta({ id: "BracketTable" });
export type BracketTable = z.infer<typeof BracketTable>;

/** Generic custom jurisdiction: user-defined brackets for any country. */
export const CustomTaxRules = z
  .object({
    ordinary: BracketTable,
    capitalGains: BracketTable.optional(),
    dividends: BracketTable.optional(),
    /** Share of capital gains that is taxable (e.g. 0.5 in Canada). */
    capitalGainsInclusion: Fraction.default(1),
    capitalGainsAsOrdinary: z.boolean().default(false),
    standardDeduction: NonNegativeMoney.default(0),
    personalAllowancePerPerson: NonNegativeMoney.default(0),
    payroll: BracketTable.optional(),
    wealthTax: z
      .object({ table: BracketTable, metric: z.enum(["netWorth", "liquidNetWorth", "portfolio"]) })
      .optional(),
    /** Optional: one effective rate on all taxable ordinary income instead of `ordinary` brackets. */
    flatEffectiveRate: Rate.optional(),
    /** Optional: tax on securities purchases and/or sales. */
    financialTransactionTax: z
      .object({ rate: Rate, base: z.enum(["purchases", "sales", "both"]).default("purchases") })
      .optional(),
    /** Optional: tax each person separately (allowance and brackets per person). Default: household. */
    perPerson: z.boolean().optional(),
    /**
     * Optional: bond fund distributions (the bond-yield part of portfolio dividends) taxed with their
     * own table. Absent = taxed as ordinary income (interest).
     */
    bondDividends: BracketTable.optional(),
    /** Optional: tax-free dividend allowance per person (or household), in today's money. */
    dividendAllowance: NonNegativeMoney.optional(),
    /**
     * Optional: 'income' stacks capital gains on top of ordinary income in the `capitalGains`
     * table (US-style); 'none' (default) taxes gains from the bottom of their table.
     */
    capitalGainsOffset: z.enum(["none", "income"]).optional(),
    /** Optional: like capitalGainsOffset, for the `dividends` table. */
    dividendOffset: z.enum(["none", "income"]).optional(),
    /** Optional: additional named income taxes (surtaxes, solidarity levies, church tax...). */
    extraTaxes: z
      .array(
        z.object({
          name: z.string().min(1).max(80),
          table: BracketTable,
          /** Base: taxable ordinary income (default), earned income only, or all taxable income. */
          base: z.enum(["ordinary", "earned", "total"]).default("ordinary"),
        }),
      )
      .optional(),
  })
  .meta({ id: "CustomTaxRules" });

/** UK-specific options (workstream b). All optional; absent = sensible defaults. */
export const UkTaxOptions = z
  .object({
    /** Student/postgraduate loan plans per person (repaid through payroll at 9% / 6%). */
    studentLoans: z
      .array(
        z.object({
          personId: z.string(),
          plan: z.enum(["plan1", "plan2", "plan4", "plan5", "postgraduate"]),
          /** Outstanding balance; repayments stop once repaid (interest not modelled). */
          balance: NonNegativeMoney.optional(),
          /** Calendar year the balance is written off (no repayments from this year). */
          writeOffYear: z.number().int().optional(),
        }),
      )
      .optional(),
    /** Child Benefit is claimed (drives the High Income Child Benefit Charge). */
    childBenefitClaimed: z.boolean().optional(),
    /** Override Scottish taxpayer status (default: location.region is 'SCT'/'Scotland'). */
    scottishTaxpayer: z.boolean().optional(),
    /** Default pension relief method when a contribution does not say. */
    defaultPensionScheme: z.enum(["net-pay", "relief-at-source", "salary-sacrifice"]).optional(),
    /**
     * Cash ISA sub-limit (Budget 2025: £12,000 of the £20,000 ISA allowance may go into cash ISAs
     * from 6 April 2027; savers aged 65 and over keep the full allowance). Defaults: on, the amount
     * in the UK tax data for the tax year, from 2027-04, exempt from age 65. `enabled: false` turns
     * it off; the other fields override the legislated values.
     */
    cashIsaLimit: z
      .object({
        enabled: z.boolean().default(true),
        /** Annual cash ISA limit (nominal); absent = the UK tax data's value for the tax year. */
        amount: NonNegativeMoney.optional(),
        /** First month the limit applies ('YYYY-MM'); default 2027-04 (6 April 2027). */
        from: z
          .string()
          .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
          .optional(),
        /** Savers this age or older are exempt (default 65). */
        exemptFromAge: z.number().min(0).max(120).optional(),
      })
      .optional(),
  })
  .meta({ id: "UkTaxOptions" });
export type UkTaxOptions = z.infer<typeof UkTaxOptions>;
export type CustomTaxRules = z.infer<typeof CustomTaxRules>;

export const FlatTaxRates = z
  .object({
    ordinary: Rate,
    capitalGains: Rate,
    dividends: Rate,
    /** Applied on top as a single "local" line. */
    local: Rate.default(0),
    /**
     * Optional: bond fund distributions (bond-yield part of dividends). 'income' (default) taxes them
     * at the ordinary rate, 'dividends' at the dividend rate, 'rate' at `rate`.
     */
    bondDividends: z
      .object({ treatment: z.enum(["income", "dividends", "rate"]), rate: Rate.optional() })
      .optional(),
    /**
     * Optional: additive adjustment (percentage points as a fraction) applied to the ordinary and
     * capital-gains rates in flat mode and to every bracket rate in custom mode (PL tax modifiers).
     */
    modifier: z.object({ ordinary: Rate.default(0), capitalGains: Rate.default(0) }).optional(),
  })
  .meta({ id: "FlatTaxRates" });
export type FlatTaxRates = z.infer<typeof FlatTaxRates>;

export const EstateSettings = z
  .object({
    liquidationCostRate: Rate.default(0.06),
    adminCostRate: Rate.default(0.02),
    stepUpBasis: z.boolean().default(true),
    heirTaxDeferredRate: Rate.default(0.25),
    heirCapitalGainsRate: Rate.default(0.15),
    charitableShare: Fraction.default(0),
  })
  .meta({ id: "EstateSettings" });

export const TaxConfig = z
  .object({
    /**
     * estimate: full jurisdiction stack resolved from household location (us-federal + us-state:XX ...).
     * flat: single effective rates (FlatTaxRates). custom: user brackets (CustomTaxRules).
     */
    mode: z.enum(["estimate", "flat", "custom"]).default("flat"),
    /** Explicit jurisdiction stack override; empty = derive from household.location. */
    jurisdictions: z.array(z.string()).default([]),
    filingStatus: FilingStatus.default("single"),
    flat: FlatTaxRates.default({ ordinary: 0.2, capitalGains: 0.15, dividends: 0.15, local: 0 }),
    custom: CustomTaxRules.optional(),
    /** Law toggles keyed by jurisdiction-defined ids (e.g. 'us.tcjaSunset', 'us.obbbaSeniorDeduction'). */
    lawToggles: z.record(z.string(), z.boolean()).default({}),
    /** Withholding rates on account withdrawals (cash-flow timing only, not liability). */
    withholding: z
      .object({
        taxDeferred: Rate.default(0),
        taxable: Rate.default(0),
        conversions: Rate.default(0),
      })
      .default({ taxDeferred: 0, taxable: 0, conversions: 0 }),
    /** When the difference between withholding and liability is settled. */
    settlement: z.enum(["same-period", "next-period"]).default("same-period"),
    /** Prior-year tax due in the first plan year (not modelled by the incumbent). */
    firstYearPriorTaxDue: Money.default(0),
    /**
     * How tax thresholds move in future years. legislated (default): follow announced freezes, then
     * index with inflation; indexed: index every year; frozen: never index (fiscal drag forever).
     */
    thresholdIndexation: z.enum(["legislated", "indexed", "frozen"]).optional(),
    /** Optional local income-tax rate on taxable income (US localities not in the built-in table). */
    localIncomeTaxRate: Rate.optional(),
    uk: UkTaxOptions.optional(),
    /** Items in another country (source taxation, treaties). Absent = defaults. */
    crossBorder: CrossBorderSettings.optional(),
    estate: EstateSettings.default({
      liquidationCostRate: 0.06,
      adminCostRate: 0.02,
      stepUpBasis: true,
      heirTaxDeferredRate: 0.25,
      heirCapitalGainsRate: 0.15,
      charitableShare: 0,
    }),
  })
  .meta({ id: "TaxConfig" });
export type TaxConfig = z.infer<typeof TaxConfig>;
export type TaxConfigInput = z.input<typeof TaxConfig>;
