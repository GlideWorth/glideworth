/**
 * Milestones: named points in time defined by criteria (time-based and/or metric-based),
 * combined with AND ('all') or OR ('any'), optionally carrying effects (tax consequences, death
 * of a household member).
 *
 * Resolution semantics (engine/milestones.ts):
 *   - Time criteria (age/date/milestone) resolve before the year loop where possible.
 *   - Metric criteria are evaluated on each period's END state; when satisfied in period P the
 *     milestone is "reached" in the LAST month of P, so events bound to it start in P+1.
 *   - 'before' time criteria are true from plan start until the referenced month, so used alone
 *     they fire immediately (matches the product we are matching, v4.2.0).
 *   - A milestone that never satisfies its criteria resolves to `never`.
 */
import { z } from "zod";
import { Amount, Appearance, Comparator, Id, MonthDate, Rate } from "./primitives.js";
import { FilingStatus } from "./tax.js";

export const MilestoneMetric = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("netWorth") }),
    z.object({ kind: z.literal("liquidNetWorth") }),
    z.object({ kind: z.literal("portfolio") }),
    z.object({ kind: z.literal("cash") }),
    z.object({ kind: z.literal("accountBalance"), accountId: Id }),
    z.object({ kind: z.literal("totalDebt") }),
    z.object({ kind: z.literal("debtBalance"), debtId: Id }),
    z.object({ kind: z.literal("loanBalance"), assetId: Id }),
    z.object({ kind: z.literal("passiveIncome") }),
    z.object({ kind: z.literal("income") }),
    z.object({ kind: z.literal("spending") }),
    z.object({ kind: z.literal("expenses") }),
  ])
  .meta({ id: "MilestoneMetric" });
export type MilestoneMetric = z.infer<typeof MilestoneMetric>;

export const MetricThreshold = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("amount"), amount: Amount }),
    /** Multiple of annual spending/expenses, e.g. 25 = "25x spending" (FI). */
    z.object({
      kind: z.literal("multipleOf"),
      multiple: z.number().min(0),
      of: z.enum(["spending", "expenses", "essentialSpending"]),
      /** 'current' = this period; 'average' = mean over the remaining plan (PL 'avg'). */
      measurement: z.enum(["current", "average"]).default("current"),
      /** 'average' only: average over this many years from the period instead of the whole remaining plan. */
      averageYears: z.number().int().min(1).max(120).optional(),
    }),
  ])
  .meta({ id: "MetricThreshold" });

export const MilestoneCriterion = z
  .discriminatedUnion("kind", [
    z.object({
      kind: z.literal("age"),
      personId: Id,
      age: z.number().min(0).max(130),
      when: z.enum(["at", "before"]).default("at"),
    }),
    z.object({
      kind: z.literal("date"),
      date: MonthDate,
      when: z.enum(["at", "before"]).default("at"),
    }),
    z.object({
      kind: z.literal("milestone"),
      milestoneId: Id,
      offsetMonths: z.number().int().default(0),
      when: z.enum(["at", "before"]).default("at"),
    }),
    z.object({
      kind: z.literal("metric"),
      metric: MilestoneMetric,
      comparator: Comparator,
      threshold: MetricThreshold,
    }),
  ])
  .meta({ id: "MilestoneCriterion" });
export type MilestoneCriterion = z.infer<typeof MilestoneCriterion>;

export const MilestoneEffect = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("setFilingStatus"), filingStatus: FilingStatus }),
    z.object({
      kind: z.literal("setWithholding"),
      taxDeferred: Rate.optional(),
      taxable: Rate.optional(),
      conversions: Rate.optional(),
    }),
    /** Household member dies: survivor inherits, filing status changes, basis step-up applies. */
    z.object({ kind: z.literal("death"), personId: Id }),
  ])
  .meta({ id: "MilestoneEffect" });
export type MilestoneEffect = z.infer<typeof MilestoneEffect>;

export const MILESTONE_KINDS = [
  "retirement",
  "life-expectancy",
  "financial-independence",
  "coast-fi",
  "lean-fi",
  "fat-fi",
  "barista-fi",
  "debt-free",
  "move",
  "custom",
] as const;
export const MilestoneKind = z.enum(MILESTONE_KINDS).meta({ id: "MilestoneKind" });

export const Milestone = z
  .object({
    id: Id,
    name: z.string().min(1).max(120),
    kind: MilestoneKind,
    /** Person this milestone belongs to (retirement / life expectancy are per person). */
    personId: Id.optional(),
    combinator: z.enum(["all", "any"]).default("all"),
    criteria: z.array(MilestoneCriterion).min(1),
    effects: z.array(MilestoneEffect).default([]),
    /** Built-ins (retirement, life expectancy) cannot be deleted, only edited. */
    builtIn: z.boolean().default(false),
    enabled: z.boolean().default(true),
    showOnChart: z.boolean().default(true),
    appearance: Appearance.optional(),
  })
  .meta({ id: "Milestone" });
export type Milestone = z.infer<typeof Milestone>;
export type MilestoneInput = z.input<typeof Milestone>;
