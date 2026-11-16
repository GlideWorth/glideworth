/** Drawdown order, textbook withdrawal strategies, flexible spending / guardrails and tax strategies. */
import { z } from "zod";
import { DrawdownCategory } from "./accounts.js";
import { Amount, Fraction, Id, Rate } from "./primitives.js";
import { DateRef, TimeRange } from "./time.js";

export const DrawdownEntry = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("category"), category: DrawdownCategory }),
    z.object({ kind: z.literal("account"), accountId: Id }),
    z.object({ kind: z.literal("realAsset"), assetId: Id }),
  ])
  .meta({ id: "DrawdownEntry" });
export type DrawdownEntry = z.infer<typeof DrawdownEntry>;

export const DEFAULT_DRAWDOWN_ORDER: DrawdownEntry[] = [
  { kind: "category", category: "cash" },
  { kind: "category", category: "taxable" },
  { kind: "category", category: "crypto" },
  { kind: "category", category: "tax-deferred" },
  { kind: "category", category: "hsa" },
  { kind: "category", category: "tax-free" },
  { kind: "category", category: "education" },
  { kind: "category", category: "real-assets" },
];

export const DrawdownSettings = z
  .object({
    /** Accounts not matched by any entry are drawn last in category order above. */
    order: z.array(DrawdownEntry).default(DEFAULT_DRAWDOWN_ORDER),
    /** Within a category: proportional to balance, or in list order. */
    withinCategory: z.enum(["ordered", "proportional"]).default("ordered"),
    /** Couples: split withdrawals across owners by balance (PL v4.6.0). Not implemented yet (workstream a). */
    splitByOwner: z.boolean().default(false),
    /** Minimum cash buffer kept before drawing other accounts. */
    cashBuffer: Amount.optional(),
  })
  .meta({ id: "DrawdownSettings" });
export type DrawdownSettings = z.infer<typeof DrawdownSettings>;

const Bounds = z.object({
  floor: Amount.optional(),
  ceiling: Amount.optional(),
});

export const WithdrawalStrategyRule = z
  .discriminatedUnion("kind", [
    z.object({
      kind: z.literal("fixed-amount"),
      amount: Amount,
      inflationAdjust: z.boolean().default(true),
    }),
    /** "4% rule": initial % of portfolio, then inflation-adjusted. */
    z.object({ kind: z.literal("initial-percent"), rate: Rate }),
    z.object({ kind: z.literal("fixed-percent"), rate: Rate }),
    z.object({ kind: z.literal("one-over-n") }),
    z.object({ kind: z.literal("vpw"), stockShare: Fraction.optional() }),
    z.object({
      kind: z.literal("ratcheting"),
      rate: Rate,
      threshold: Rate.default(0.5),
      raise: Rate.default(0.1),
      cooldownYears: z.number().int().min(0).default(3),
    }),
    z.object({
      kind: z.literal("clyatt-95"),
      rate: Rate,
      minShareOfPrevious: Fraction.default(0.95),
    }),
    z.object({
      kind: z.literal("guyton-klinger"),
      rate: Rate,
      guardrail: Rate.default(0.2),
      adjustment: Rate.default(0.1),
    }),
  ])
  .meta({ id: "WithdrawalStrategyRule" });

export const WithdrawalStrategy = z
  .object({
    enabled: z.boolean().default(false),
    start: DateRef,
    rule: WithdrawalStrategyRule,
    bounds: Bounds.default({}),
    /** What other income does: reduce withdrawals, or raise spending. */
    incomeHandling: z
      .enum(["reduce-withdrawals", "increase-spending"])
      .default("reduce-withdrawals"),
    /** Treat the computed amount as desired spending rather than as a withdrawal. */
    treatAsSpending: z.boolean().default(false),
  })
  .meta({ id: "WithdrawalStrategy" });
export type WithdrawalStrategy = z.infer<typeof WithdrawalStrategy>;

export const FlexSpending = z
  .object({
    enabled: z.boolean().default(false),
    scope: z.enum(["all", "discretionary"]).default("discretionary"),
    interpolation: z.enum(["step", "linear"]).default("step"),
    /** "When portfolio is down `drawdown` from its all-time high, cut flexed spending by `cut`." */
    rules: z
      .array(z.object({ drawdown: Fraction, cut: Fraction }))
      .default([{ drawdown: 0.2, cut: 0.3 }]),
    window: TimeRange.optional(),
  })
  .meta({ id: "FlexSpending" });
export type FlexSpending = z.infer<typeof FlexSpending>;

/**
 * Risk-based guardrails (Glideworth differentiator): spending adjusts when the plan's forward
 * probability of success leaves a band. Evaluated by solvers/guardrails.ts using one shared set of
 * simulations (no nested Monte Carlo per year).
 */
export const RiskGuardrails = z
  .object({
    enabled: z.boolean().default(false),
    start: DateRef,
    targetSuccess: Fraction.default(0.8),
    lowerGuardrail: Fraction.default(0.7),
    upperGuardrail: Fraction.default(0.95),
    adjustmentStep: Fraction.default(0.1),
    scope: z.enum(["all", "discretionary"]).default("discretionary"),
    floor: Amount.optional(),
    /**
     * Withdrawal-rate band derived by `evaluateGuardrails` from the success-rate guardrails (spending
     * in scope plus fixed spending, over the investable portfolio at the period start). With it the
     * engine applies the guardrails year by year: above `cutAbove` spending in scope is cut by
     * `adjustmentStep`, below `raiseBelow` it is raised, and later years inherit the change.
     */
    withdrawalRateBand: z.object({ cutAbove: Rate, raiseBelow: Rate }).optional(),
  })
  .meta({ id: "RiskGuardrails" });
export type RiskGuardrails = z.infer<typeof RiskGuardrails>;

/** Bracket-targeting tax strategy (Roth conversions, withdrawal shielding, gain harvesting). */
export const TaxStrategy = z
  .object({
    enabled: z.boolean().default(false),
    range: TimeRange.optional(),
    target: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("bracket"), rate: Rate }),
      z.object({ kind: z.literal("irmaa-tier"), tier: z.number().int().min(1).max(6) }),
      z.object({ kind: z.literal("aca-fpl-multiple"), multiple: z.number().min(1).max(10) }),
      z.object({ kind: z.literal("income"), amount: Amount }),
    ]),
    constraints: z
      .object({
        capitalGainsBracket: Rate.optional(),
        avoidNiit: z.boolean().default(false),
        preserveAca: z.boolean().default(false),
      })
      .default({ avoidNiit: false, preserveAca: false }),
    modules: z
      .object({
        rothConversions: z.boolean().default(true),
        withdrawalShielding: z.boolean().default(true),
        gainHarvesting: z.boolean().default(true),
      })
      .default({ rothConversions: true, withdrawalShielding: true, gainHarvesting: true }),
    conversionSourceAccountIds: z.array(Id).default([]),
    conversionDestinationAccountId: Id.optional(),
  })
  .meta({ id: "TaxStrategy" });
export type TaxStrategy = z.infer<typeof TaxStrategy>;
