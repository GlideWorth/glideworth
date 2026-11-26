/** Plan-level assumptions ("variables"): inflation, returns, bonds, dividends, horizon. */
import { z } from "zod";
import { CurrencyCode, Fraction, Id, Rate } from "./primitives.js";
import { DateRef, RateSpec, SchedulePoint, TimeRange } from "./time.js";

/**
 * A named inflation category (healthcare, education, housing or your own) with its own rate,
 * assignable per income/expense event (`inflationCategory`). The plan's `inflation` is the implicit
 * 'general' category.
 *  - mode 'premium' (default): general inflation + `rate` each period (e.g. healthcare at +2%).
 *    Stochastic runs move it one-for-one with each trial's sampled general inflation.
 *  - mode 'rate': the category's own rate (`rate`, fixed or a schedule); in stochastic runs (and
 *    under inflation rate overrides) it moves by `passThrough` x the trial's general-inflation
 *    surprise (sampled minus assumed), so categories stay coherent with the general path.
 */
export const InflationCategory = z
  .object({
    id: Id.refine((v) => v !== "general", "'general' is reserved for the plan inflation"),
    name: z.string().min(1).max(80),
    kind: z.enum(["healthcare", "education", "housing", "custom"]).default("custom"),
    mode: z.enum(["premium", "rate"]).default("premium"),
    rate: RateSpec,
    passThrough: z.number().min(0).max(3).default(1),
  })
  .meta({ id: "InflationCategory" });
export type InflationCategory = z.infer<typeof InflationCategory>;
export type InflationCategoryInput = z.input<typeof InflationCategory>;

/**
 * An exchange rate between two currencies, as entered by the user: 1 unit of `from` = `rate` units of
 * `to`, valid at the finances' `asOf`, optionally drifting by `annualDrift` a year (e.g. 0.01 = `from`
 * appreciates 1% a year against `to`). The engine resolves every foreign currency to the household's
 * base currency through a direct or inverse pair.
 */
export const FxRate = z
  .object({
    from: CurrencyCode,
    to: CurrencyCode,
    rate: z.number().positive(),
    annualDrift: Rate.default(0),
  })
  .meta({ id: "FxRate" });
export type FxRate = z.infer<typeof FxRate>;
export type FxRateInput = z.input<typeof FxRate>;

/**
 * The key of a currency pair regardless of direction: GBP>USD and USD>GBP are the same pair (the engine
 * uses either, inverted as needed), so a table must hold at most one of them.
 */
export function fxPairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/**
 * Household rates, then the plan's. A plan pair replaces the household's pair in either direction
 * (a plan's USD>GBP overrides the household's GBP>USD). Within one table the last entry for a pair wins.
 * This is the table the projection converts with (`fxTable`).
 */
export function mergeFxRates(
  household: readonly FxRate[] | undefined,
  plan: readonly FxRate[] | undefined,
): FxRate[] {
  const out = new Map<string, FxRate>();
  for (const r of household ?? []) out.set(fxPairKey(r.from, r.to), r);
  for (const r of plan ?? []) out.set(fxPairKey(r.from, r.to), r);
  return [...out.values()];
}

/**
 * Problems with an FX rate table, shared by the API (every write path) and the web editor so both refuse
 * the same tables: a pair from a currency to itself, and the same pair twice (in either direction).
 */
export function fxRateIssues(
  rates: readonly { from: string; to: string }[],
): { index: number; message: string }[] {
  const out: { index: number; message: string }[] = [];
  const seen = new Map<string, number>();
  rates.forEach((r, index) => {
    if (r.from === r.to) {
      out.push({ index, message: `${r.from} to ${r.to}: choose two different currencies` });
      return;
    }
    const k = fxPairKey(r.from, r.to);
    const first = seen.get(k);
    if (first !== undefined)
      out.push({
        index,
        message: `${r.from} and ${r.to} already have a rate (row ${first + 1}); keep one per pair, in either direction`,
      });
    else seen.set(k, index);
  });
  return out;
}

export const Assumptions = z
  .object({
    inflation: RateSpec.default({ kind: "fixed", rate: 0.03 }),
    /** Equity price growth (excluding dividends). */
    stockReturn: RateSpec.default({ kind: "fixed", rate: 0.07 }),
    dividendYield: RateSpec.default({ kind: "fixed", rate: 0.015 }),
    bondReturn: RateSpec.default({ kind: "fixed", rate: 0.02 }),
    bondYield: RateSpec.default({ kind: "fixed", rate: 0.03 }),
    cashReturn: RateSpec.default({ kind: "fixed", rate: 0.01 }),
    cryptoReturn: RateSpec.default({ kind: "fixed", rate: 0.07 }),
    /** Extra growth for healthcare costs over inflation (applied by healthcare expense defaults). */
    healthcareInflationPremium: Rate.default(0.02),
    /** Government benefit COLA relative to inflation (e.g. -0.005). */
    benefitColaModifier: Rate.default(0),
    /**
     * US: automatically add a Medicare premium expense for each person from age 65 (unless the
     * plan already has a Medicare healthcare expense for them).
     */
    autoMedicare: z.boolean().optional(),
    bondAllocation: z
      .object({
        kind: z.enum(["none", "fixed", "glidepath"]).default("none"),
        share: Fraction.default(0),
        /** For glidepath: points (value = bond share). */
        points: z.array(SchedulePoint).default([]),
        interpolation: z.enum(["step", "linear"]).default("linear"),
        distribution: z.enum(["even", "weighted"]).default("even"),
        /** Asset location: accounts filled with bonds first. */
        locationPriority: z.array(Id).default([]),
      })
      .default({
        kind: "none",
        share: 0,
        points: [],
        interpolation: "linear",
        distribution: "even",
        locationPriority: [],
      }),
    dividendReinvestment: z
      .object({ enabled: z.boolean().default(true), window: TimeRange.optional() })
      .default({ enabled: true }),
    /** Year alignment for each simulated period. */
    yearAlignment: z
      .discriminatedUnion("kind", [
        z.object({ kind: z.literal("calendar") }),
        z.object({ kind: z.literal("fiscal"), startMonth: z.number().int().min(1).max(12) }),
        z.object({ kind: z.literal("rolling") }),
      ])
      .default({ kind: "calendar" }),
    /** Plan horizon. Default ends when the last person's life-expectancy milestone resolves. */
    end: z
      .discriminatedUnion("kind", [
        z.object({ kind: z.literal("lastLifeExpectancy") }),
        z.object({ kind: z.literal("ref"), ref: DateRef }),
      ])
      .default({ kind: "lastLifeExpectancy" }),
    /**
     * When in the year cash flows (contributions, withdrawals, spending) happen relative to growth.
     * 'end': flows land after the year's growth (they earn / lose nothing that year); 'start': flows
     * happen before growth (a withdrawal forgoes the whole year's return, as in FIRECalc);
     * 'mid' (default): mid-year approximation, flows earn half a year of the period's return.
     */
    cashFlowTiming: z.enum(["start", "mid", "end"]).optional(),
    /**
     * Temporary overrides of market rates over a time range (stress tests such as the market-crash
     * what-if). Applied on top of whatever RateSpec the series uses (fixed, schedule or historical)
     * in deterministic projections; Monte Carlo trials use their own sampled rates.
     */
    rateOverrides: z
      .array(
        z.object({
          series: z.enum([
            "stocks",
            "bonds",
            "cash",
            "inflation",
            "dividendYield",
            "bondYield",
            "crypto",
          ]),
          range: TimeRange,
          rate: Rate,
        }),
      )
      .optional(),
    /** Named inflation categories (healthcare, education, housing, custom) events can use. */
    inflationCategories: z.array(InflationCategory).optional(),
    /**
     * Plan-level FX rates/drift that replace the household's (`CurrentFinances.fxRates`) pair by
     * pair, for what-ifs such as "sterling falls 2% a year".
     */
    fxRates: z.array(FxRate).optional(),
    /**
     * Capital gains on rebalancing: when a glide path (or a per-account bond schedule) changes a
     * taxable account's bond share, the switch sells holdings and realises gains pro rata to the
     * account's unrealised gain. Off by default (most rebalancing happens with new money).
     */
    rebalancingGains: z.boolean().optional(),
    /** Hard cap on simulated years (safety). */
    maxYears: z.number().int().min(1).max(120).default(100),
  })
  .meta({ id: "Assumptions" });
export type Assumptions = z.infer<typeof Assumptions>;
export type AssumptionsInput = z.input<typeof Assumptions>;
