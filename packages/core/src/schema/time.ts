/**
 * Time references, ranges, change-over-time and rate specifications.
 *
 * Resolution rules (implemented in engine/dates.ts):
 *   - Every DateRef resolves to a single calendar month or to `null` ("never").
 *   - A TimeRange is active for months m with start <= m < end (end is EXCLUSIVE by default).
 *     Set `endInclusive: true` to include the end month ("through December 2030").
 *   - planStart = first simulated month; planEnd = the month AFTER the last simulated month,
 *     so `end: planEnd` covers the whole remaining plan.
 *   - age: the month the person reaches that age (birth month + age * 12, fractional ages
 *     allowed, e.g. 59.5).
 *   - dependentAge: the same for a household dependent (Household.dependents), so a child's
 *     costs move when their birth month changes.
 *   - milestone: the month the milestone resolves (see Milestone), or never if it never does.
 *   - offsetMonths shifts any resolved month (negative allowed).
 */
import { z } from "zod";
import { Id, Interpolation, MonthDate, Rate } from "./primitives.js";

const offsetMonths = z.number().int().min(-1200).max(1200).default(0);

export const DateRef = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("planStart"), offsetMonths }),
    z.object({ kind: z.literal("planEnd"), offsetMonths }),
    z.object({ kind: z.literal("never") }),
    z.object({ kind: z.literal("date"), date: MonthDate, offsetMonths }),
    z.object({
      kind: z.literal("age"),
      personId: Id,
      age: z.number().min(0).max(130),
      offsetMonths,
    }),
    z.object({
      kind: z.literal("dependentAge"),
      /** Id of a dependent in Household.dependents (not a person). */
      dependentId: Id,
      age: z.number().min(0).max(130),
      offsetMonths,
    }),
    z.object({ kind: z.literal("milestone"), milestoneId: Id, offsetMonths }),
  ])
  .meta({
    id: "DateRef",
    description:
      "A point in time resolved to a calendar month by the engine. 'age' follows a person (personId); 'dependentAge' follows a household dependent (dependentId), e.g. a child's costs from age 0 to 5.",
  });
export type DateRef = z.infer<typeof DateRef>;
export type DateRefInput = z.input<typeof DateRef>;

export const TimeRange = z
  .object({
    start: DateRef,
    end: DateRef,
    endInclusive: z.boolean().default(false),
  })
  .meta({ id: "TimeRange" });
export type TimeRange = z.infer<typeof TimeRange>;

/** Control point for schedules ("Advanced" editor). */
export const SchedulePoint = z
  .object({ at: DateRef, value: z.number() })
  .meta({ id: "SchedulePoint" });

/**
 * How an amount evolves over time after it starts.
 *  - none: flat in nominal terms from its first occurrence.
 *  - inflation: tracks inflation, plus an optional real premium (`plus`, e.g. +0.02 healthcare).
 *  - rate: fixed nominal growth per year.
 *  - schedule: explicit multipliers/amounts at points in time (Advanced editor).
 *  An optional cap/floor clamps the result (in the stated basis).
 */
export const Change = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("none") }),
    z.object({ kind: z.literal("inflation"), plus: Rate.default(0) }),
    z.object({ kind: z.literal("rate"), rate: Rate }),
    z.object({
      kind: z.literal("schedule"),
      valueKind: z.enum(["multiplier", "amount", "rate"]),
      interpolation: Interpolation.default("step"),
      points: z.array(SchedulePoint).min(1),
    }),
  ])
  .meta({ id: "Change", description: "Change-over-time rule for an amount." });
export type Change = z.infer<typeof Change>;

export const ChangeLimit = z
  .object({
    max: z.number().optional(),
    min: z.number().optional(),
    basis: z.enum(["real", "nominal"]).default("real"),
  })
  .meta({ id: "ChangeLimit" });

/** Historical market series identifiers shipped with the stochastic datasets. */
export const HistoricalSeries = z
  .enum(["us-stocks", "us-bonds", "us-cash", "us-inflation", "us-dividends", "crypto"])
  .meta({ id: "HistoricalSeries" });

/** A rate over time (growth, inflation, dividend yield...). */
export const RateSpec = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("none") }),
    z.object({ kind: z.literal("fixed"), rate: Rate }),
    z.object({
      kind: z.literal("schedule"),
      interpolation: Interpolation.default("step"),
      points: z.array(z.object({ at: DateRef, rate: Rate })).min(1),
    }),
    z.object({
      kind: z.literal("historical"),
      series: HistoricalSeries,
      startYear: z.number().int().min(1871).max(2100),
      /** When the dataset runs out, continue from this year (PL "loop year"). */
      loopYear: z.number().int().min(1871).max(2100).optional(),
      /** Added to every historical value (e.g. -0.01 = one point below history; PL modifier). */
      modifier: Rate.optional(),
    }),
  ])
  .meta({ id: "RateSpec" });
export type RateSpec = z.infer<typeof RateSpec>;

/** RateSpec that may defer to the plan-level assumption. */
export const AccountRateSpec = z
  .union([z.object({ kind: z.literal("inherit") }), RateSpec])
  .meta({ id: "AccountRateSpec" });
export type AccountRateSpec = z.infer<typeof AccountRateSpec>;

/** Repeat an event or asset purchase ("buy a car every 10 years"). */
export const Recurrence = z
  .object({
    /** Years between the end of one occurrence and the start of the next (0 = back-to-back). */
    yearsBetween: z.number().min(0).max(100),
    /** Extra growth per repetition on top of the event's own Change rule. */
    scalingRate: Rate.default(0),
    until: DateRef,
    /** Assets only: keep the final purchase instead of selling it at `until`. */
    keepLast: z.boolean().default(false),
  })
  .meta({ id: "Recurrence" });
export type Recurrence = z.infer<typeof Recurrence>;
