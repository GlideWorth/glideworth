/** Progress snapshots (actuals over time) and user settings. */
import { z } from "zod";
import { DrawdownCategory } from "./accounts.js";
import { OutcomeCategory } from "./montecarlo.js";
import {
  CurrencyCode,
  Fraction,
  Id,
  IsoDate,
  LocaleTag,
  Money,
  Notes,
  Timestamp,
  ValueBasis,
} from "./primitives.js";

export const ProgressSnapshot = z
  .object({
    id: Id,
    householdId: Id,
    date: IsoDate,
    source: z.enum(["manual", "auto", "import", "api"]).default("manual"),
    netWorth: Money,
    assets: Money,
    liabilities: Money,
    byCategory: z
      .partialRecord(z.union([DrawdownCategory, z.enum(["debt", "loans"])]), Money)
      .default({}),
    accounts: z.array(z.object({ accountId: Id, balance: Money })).default([]),
    realAssets: z
      .array(z.object({ assetId: Id, value: Money, loanBalance: Money.default(0) }))
      .default([]),
    debts: z.array(z.object({ debtId: Id, balance: Money })).default([]),
    note: Notes.optional(),
    createdAt: Timestamp.optional(),
  })
  .meta({ id: "ProgressSnapshot" });
export type ProgressSnapshot = z.infer<typeof ProgressSnapshot>;
export type ProgressSnapshotInput = z.input<typeof ProgressSnapshot>;

export const UserSettings = z
  .object({
    /** Overrides household currency for display only (FX not applied; label-only until FX ships). */
    displayCurrency: CurrencyCode.optional(),
    locale: LocaleTag.optional(),
    theme: z.enum(["system", "light", "dark"]).default("system"),
    valueBasis: ValueBasis.default("real"),
    compactNumbers: z.boolean().default(true),
    reduceMotion: z.boolean().default(false),
    autoProgressSnapshots: z.boolean().default(true),
    /** Which items count as "spending" (PL Spending metric settings). */
    spending: z
      .object({
        includeTaxes: z.boolean().default(false),
        includeMortgage: z.boolean().default(true),
        includeMortgagePrincipal: z.boolean().default(false),
        includeConsumerDebtPrincipal: z.boolean().default(false),
      })
      .default({
        includeTaxes: false,
        includeMortgage: true,
        includeMortgagePrincipal: false,
        includeConsumerDebtPrincipal: false,
      }),
    effectiveTaxRate: z
      .object({
        includeLocal: z.boolean().default(true),
        includeProperty: z.boolean().default(false),
        includePayroll: z.boolean().default(true),
        /**
         * Optional: non-taxable inflows added to the effective-rate denominator (gross income):
         * tax-free income and distributions, the non-taxable (principal) part of account
         * withdrawals, and real-asset sale proceeds. All default to false.
         */
        income: z
          .object({
            taxFreeDistributions: z.boolean().optional(),
            nonTaxableCapitalWithdrawals: z.boolean().optional(),
            nonTaxableSaleProceeds: z.boolean().optional(),
          })
          .optional(),
      })
      .default({ includeLocal: true, includeProperty: false, includePayroll: true }),
    outcomeCategories: z.array(OutcomeCategory).optional(),
    /**
     * Optional rating bands for the chance of success (e.g. "Excellent" from 0.9). Sorted by
     * `minRate` descending when used; see `successRateBand()`.
     */
    successRateBands: z
      .array(
        z.object({
          name: z.string().min(1).max(60),
          minRate: Fraction,
          color: z.string().max(40).optional(),
        }),
      )
      .optional(),
    defaultPlanId: Id.optional(),
    onboarding: z
      .object({ completed: z.boolean().default(false), step: z.string().max(40).optional() })
      .default({ completed: false }),
  })
  .meta({ id: "UserSettings" });
export type UserSettings = z.infer<typeof UserSettings>;
export type UserSettingsInput = z.input<typeof UserSettings>;

/** The rating band a success rate falls in (highest `minRate` not above `rate`), or null. */
export function successRateBand(
  settings: Pick<UserSettings, "successRateBands">,
  rate: number,
): NonNullable<UserSettings["successRateBands"]>[number] | null {
  const bands = [...(settings.successRateBands ?? [])].sort((a, b) => b.minRate - a.minRate);
  return bands.find((b) => rate >= b.minRate - 1e-12) ?? null;
}
