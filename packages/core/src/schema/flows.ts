/**
 * Flows: the ordered savings waterfall applied to each period's surplus, plus transfers and
 * extra debt payments. Order in Plan.flows = priority (index 0 first).
 */
import { z } from "zod";
import { Amount, Appearance, Fraction, Frequency, Id, Notes, Owner } from "./primitives.js";
import { TimeRange } from "./time.js";

export const ContributionMethod = z
  .discriminatedUnion("kind", [
    /** Fill to the contribution limit (or all remaining surplus when unlimited). */
    z.object({ kind: z.literal("max") }),
    z.object({ kind: z.literal("percentOfRemaining"), share: Fraction }),
    z.object({ kind: z.literal("amount"), amount: Amount, frequency: Frequency.default("yearly") }),
    /** Percent of a specific income event (401k deferral %). */
    z.object({ kind: z.literal("percentOfIncome"), incomeId: Id, share: Fraction }),
  ])
  .meta({ id: "ContributionMethod" });
export type ContributionMethod = z.infer<typeof ContributionMethod>;

export const ContributionLimit = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("none") }),
    /** Jurisdiction default for the account type (IRS, ISA allowance, TFSA room...). */
    z.object({ kind: z.literal("jurisdiction") }),
    z.object({ kind: z.literal("custom"), amount: Amount }),
  ])
  .meta({ id: "ContributionLimit" });

/**
 * One tier of an employer match: the employer adds `matchRate` x the employee's contributions that
 * fall in the next `bandShareOfPay` of pay. Tiers are consecutive bands from the first percent of
 * pay up: the US safe-harbor basic match (100% of the first 3% of pay, 50% of the next 2%) is
 * `[{ matchRate: 1, bandShareOfPay: 0.03 }, { matchRate: 0.5, bandShareOfPay: 0.02 }]`.
 */
export const EmployerMatchTier = z
  .object({
    /** Employer money per unit of employee contribution in this band (1.5 = 150%). */
    matchRate: z.number().min(0).max(10),
    /** Width of this band as a share of pay (0.04 = the next 4% of pay). */
    bandShareOfPay: Fraction,
  })
  .meta({ id: "EmployerMatchTier" });
export type EmployerMatchTier = z.infer<typeof EmployerMatchTier>;

export const EmployerMatch = z
  .object({
    incomeId: Id,
    /** Match tiers in order, from the first percent of pay up (empty: no match). */
    tiers: z
      .array(EmployerMatchTier)
      .max(10)
      .refine((t) => t.reduce((s, x) => s + x.bandShareOfPay, 0) <= 1 + 1e-9, {
        message: "Tiers cover more than 100% of pay",
      })
      .default([]),
    /**
     * A fixed employer contribution, whatever the employee contributes (an employer HSA deposit of
     * $250 a quarter): paid in the periods the flow runs while the employee has pay from
     * `incomeId`. `amount.basis` 'real' keeps it in today's money, 'nominal' fixes the dollars.
     */
    fixed: z
      .object({
        amount: Amount,
        frequency: Frequency.exclude(["once"]).default("yearly"),
      })
      .optional(),
    designation: z.enum(["traditional", "roth"]).default("traditional"),
    reduceIfUnderfunded: z.boolean().default(false),
  })
  .refine((e) => e.tiers.length > 0 || e.fixed !== undefined, {
    message: "Add a match tier or a fixed amount",
    path: ["tiers"],
  })
  .meta({ id: "EmployerMatch" });
export type EmployerMatch = z.infer<typeof EmployerMatch>;

const FlowBase = z.object({
  id: Id,
  name: z.string().min(1).max(120),
  owner: Owner,
  range: TimeRange,
  /** "Always Fund": mandatory, draws from other accounts if income is insufficient. */
  mandatory: z.boolean().default(false),
  enabled: z.boolean().default(true),
  notes: Notes.optional(),
  appearance: Appearance.optional(),
});

export const ContributionFlow = FlowBase.extend({
  kind: z.literal("contribution"),
  accountId: Id,
  strategy: z
    .discriminatedUnion("kind", [
      z.object({ kind: z.literal("indefinite") }),
      z.object({ kind: z.literal("target"), target: Amount }),
    ])
    .default({ kind: "indefinite" }),
  method: ContributionMethod,
  limit: ContributionLimit.default({ kind: "none" }),
  /** Employer match on workplace plans. */
  employer: EmployerMatch.optional(),
  /** US special contribution routes. */
  route: z.enum(["standard", "backdoor-roth", "mega-backdoor-roth"]).default("standard"),
  taxDeductible: z.boolean().optional(),
  fundFromAccountIds: z.array(Id).default([]),
  /**
   * Target strategy on a cash account: once the balance exceeds the target, move the excess back
   * into the waterfall so later flows can use it (PL "route excess onward").
   */
  routeExcessOnward: z.boolean().optional(),
  /**
   * Tap the fund: once the flow's range has ended, the account pays `rate` x its opening balance
   * each year into the cash pool (a sinking fund that is spent down, PL `tapFund`/`tapRate`).
   */
  tapFund: z.object({ rate: Fraction }).optional(),
  /**
   * UK pensions: how tax relief is given on this contribution. Absent = the plan's
   * `tax.uk.defaultPensionScheme`, else relief at source for SIPPs and net pay for workplace pensions.
   */
  pensionScheme: z.enum(["net-pay", "relief-at-source", "salary-sacrifice"]).optional(),
}).meta({ id: "ContributionFlow" });

/**
 * Debt payoff strategy: spread a paydown flow's payment over several debts instead of only its
 * `targetId`. 'avalanche' pays the highest interest rate first (least interest overall); 'snowball'
 * pays the smallest balance first (quickest wins). With `rollover`, the scheduled payments of debts
 * already paid off are added to the budget (the classic snowball).
 */
export const DebtPayoffAllocation = z
  .object({
    strategy: z.enum(["avalanche", "snowball"]),
    /** Debts and financed real assets in scope (`targetId` is always included). Default: all of them. */
    targetIds: z.array(Id).optional(),
    rollover: z.boolean().default(true),
  })
  .meta({ id: "DebtPayoffAllocation" });
export type DebtPayoffAllocation = z.infer<typeof DebtPayoffAllocation>;

export const DebtPaydownFlow = FlowBase.extend({
  kind: z.literal("debtPaydown"),
  /** A Debt id or a RealAsset id (its loan). With `allocation`, one of the debts in scope. */
  targetId: Id,
  /** Payoff strategy across debts (avalanche / snowball); absent = pay `targetId` only. */
  allocation: DebtPayoffAllocation.optional(),
  method: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("max") }),
    z.object({ kind: z.literal("percentOfRemaining"), share: Fraction }),
    z.object({ kind: z.literal("amount"), amount: Amount, frequency: Frequency.default("yearly") }),
    z.object({ kind: z.literal("percentOfBalance"), share: Fraction }),
  ]),
}).meta({ id: "DebtPaydownFlow" });

export const TransferFlow = FlowBase.extend({
  kind: z.literal("transfer"),
  fromAccountId: Id,
  to: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("account"), accountId: Id }),
    z.object({ kind: z.literal("external"), label: z.string().max(120) }),
  ]),
  amount: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("amount"), amount: Amount, frequency: Frequency.default("yearly") }),
    z.object({ kind: z.literal("percentOfBalance"), share: Fraction }),
    z.object({ kind: z.literal("all") }),
  ]),
  /** 'auto' detects Roth conversions, RRSP meltdown, etc. */
  taxHandling: z.enum(["auto", "taxable", "tax-exempt"]).default("auto"),
}).meta({ id: "TransferFlow" });

export const Flow = z
  .discriminatedUnion("kind", [ContributionFlow, DebtPaydownFlow, TransferFlow])
  .meta({ id: "Flow" });
export type Flow = z.infer<typeof Flow>;
export type FlowInput = z.input<typeof Flow>;

/** What happens to surplus after all flows. */
export const LeftoverPolicy = z
  .discriminatedUnion("kind", [
    /** Save to this account (default: first cash account). */
    z.object({ kind: z.literal("save"), accountId: Id.optional() }),
    /** Becomes "Discretionary spending" in the period. */
    z.object({ kind: z.literal("spend") }),
  ])
  .meta({ id: "LeftoverPolicy" });
export type LeftoverPolicy = z.infer<typeof LeftoverPolicy>;
