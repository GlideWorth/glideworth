/**
 * Shared primitives for the Glideworth domain schema.
 *
 * MONEY CONVENTION (project-wide, see docs/ARCHITECTURE.md §"Money and units"):
 *   - Money is a JS `number` in MAJOR currency units (1234.56 means 1,234.56 of the currency).
 *   - Never integer minor units. The engine never rounds intermediate values.
 *   - Rounding happens only at presentation (Intl.NumberFormat) and in importers that must
 *     match external data.
 *   - Rates are decimal fractions: 0.07 means 7% per year.
 *   - Every amount entered by a user carries a ValueBasis: 'real' (today's money) or 'nominal'.
 */
import { z } from "zod";

/** Stable identifier. UUIDs (as used by ProjectionLab exports) and short slugs are both valid. */
export const Id = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, 'ids may contain letters, digits, "_" and "-"')
  .meta({ id: "Id", description: "Stable identifier (UUID or slug)." });
export type Id = z.infer<typeof Id>;

/** Money in major currency units (e.g. 1234.56). Float64; no intermediate rounding. */
export const Money = z.number().meta({
  id: "Money",
  description: "Amount in MAJOR currency units (e.g. 1234.56), never minor units.",
});
export type Money = z.infer<typeof Money>;

/** Non-negative money. */
export const NonNegativeMoney = z.number().nonnegative().meta({ id: "NonNegativeMoney" });

/** Annual rate as a decimal fraction (0.07 = 7%/yr). Negative values allowed (e.g. depreciation). */
export const Rate = z
  .number()
  .min(-1)
  .max(10)
  .meta({ id: "Rate", description: "Decimal fraction per year: 0.07 means 7%." });
export type Rate = z.infer<typeof Rate>;

/** Share in [0, 1]. */
export const Fraction = z
  .number()
  .min(0)
  .max(1)
  .meta({ id: "Fraction", description: "Share in [0, 1]." });

/** Calendar month, 'YYYY-MM'. The engine's time unit for event boundaries. */
export const MonthDate = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "expected YYYY-MM")
  .meta({ id: "MonthDate", description: "Calendar month 'YYYY-MM'." });
export type MonthDate = z.infer<typeof MonthDate>;

/** Calendar date, 'YYYY-MM-DD'. Used for progress snapshots and audit timestamps. */
export const IsoDate = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, "expected YYYY-MM-DD")
  .meta({ id: "IsoDate", description: "Calendar date 'YYYY-MM-DD'." });
export type IsoDate = z.infer<typeof IsoDate>;

/** ISO 8601 timestamp. */
export const Timestamp = z.string().datetime({ offset: true }).meta({ id: "Timestamp" });

/** ISO 4217 currency code. Display only today; per-account currency is reserved (see Account.currency). */
export const CurrencyCode = z
  .string()
  .regex(/^[A-Z]{3}$/)
  .meta({ id: "CurrencyCode", description: "ISO 4217 code, e.g. USD, GBP, CAD, AUD, EUR." });
export type CurrencyCode = z.infer<typeof CurrencyCode>;

/** BCP 47 locale tag used for number/date formatting. */
export const LocaleTag = z
  .string()
  .min(2)
  .max(35)
  .meta({ id: "LocaleTag", description: "BCP 47, e.g. en-GB." });

/** ISO 3166-1 alpha-2 country, or 'XX' for a custom/unspecified jurisdiction. */
export const CountryCode = z
  .string()
  .regex(/^[A-Z]{2}$/)
  .meta({ id: "CountryCode", description: "ISO 3166-1 alpha-2; 'XX' = custom/unspecified." });
export type CountryCode = z.infer<typeof CountryCode>;

/** 'real' = today's money (deflated to the plan's reference month); 'nominal' = actual future currency. */
export const ValueBasis = z.enum(["real", "nominal"]).meta({
  id: "ValueBasis",
  description: "'real' = today's money; 'nominal' = actual (inflated) currency.",
});
export type ValueBasis = z.infer<typeof ValueBasis>;

/** A user-entered amount with its basis. */
export const Amount = z
  .object({
    value: Money,
    basis: ValueBasis.default("real"),
  })
  .meta({ id: "Amount" });
export type Amount = z.infer<typeof Amount>;

/**
 * An amount that may not be negative (income and expense events, prices). A negative salary or
 * expense is always a data-entry mistake: model a refund or a cost as its own event instead.
 */
export const NonNegativeAmount = z
  .object({
    value: z.number().nonnegative({ message: "amount must not be negative" }).meta({
      id: "NonNegativeMoneyValue",
      description: "Amount in MAJOR currency units; never negative.",
    }),
    basis: ValueBasis.default("real"),
  })
  .meta({ id: "NonNegativeAmount" });

export const Frequency = z
  .enum([
    "once",
    "weekly",
    "biweekly",
    "semimonthly",
    "monthly",
    "quarterly",
    "semiannually",
    "yearly",
  ])
  .meta({ id: "Frequency" });
export type Frequency = z.infer<typeof Frequency>;

/** Occurrences per year for each frequency ('once' handled specially by the engine). */
export const FREQUENCY_PER_YEAR: Record<Frequency, number> = {
  once: 1,
  weekly: 52,
  biweekly: 26,
  semimonthly: 24,
  monthly: 12,
  quarterly: 4,
  semiannually: 2,
  yearly: 1,
};

/**
 * Owner of an account/asset/debt/event: a person id, or the reserved literal 'joint'.
 * Person ids may never be 'joint'.
 */
export const Owner = z.string().min(1).max(64).meta({
  id: "Owner",
  description: "Person id, or the reserved value 'joint'.",
});
export type Owner = z.infer<typeof Owner>;
export const JOINT = "joint" as const;

export const Comparator = z.enum([">=", ">", "<=", "<", "="]).meta({ id: "Comparator" });
export type Comparator = z.infer<typeof Comparator>;

export const Interpolation = z.enum(["step", "linear"]).meta({ id: "Interpolation" });
export type Interpolation = z.infer<typeof Interpolation>;

/** Presentation hints. Colors are design-token names (see apps/web tokens), not hex codes. */
export const Appearance = z
  .object({
    color: z.string().max(40).optional(),
    icon: z.string().max(60).optional(),
  })
  .meta({ id: "Appearance" });

export const Notes = z.string().max(20_000);
