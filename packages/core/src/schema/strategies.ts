/** Drawdown order, textbook withdrawal strategies, flexible spending / guardrails and tax strategies. */
import { z } from "zod";
import { DrawdownCategory } from "./accounts.js";
import { Amount, Fraction, Id, Rate } from "./primitives.js";
import { DateRef, TimeRange } from "./time.js";

/**
 * The taxable-income ceiling of a `fillToCeiling` drawdown entry. Uses only thresholds already in
 * the tax tables: `bracket` keeps each person's (or, where income is taxed jointly, the household's)
 * ordinary income within the band taxed at `rate` (0 = within the personal allowance / standard
 * deduction; 0.2 = within the UK basic-rate band; 0.12 = within the US 12% bracket); `income` keeps
 * it at or below an amount you choose (taxable income, or AGI where the tax system reports one).
 */
export const DrawdownCeiling = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("bracket"), rate: Rate }),
    z.object({ kind: z.literal("income"), amount: Amount }),
  ])
  .meta({ id: "DrawdownCeiling" });
export type DrawdownCeiling = z.infer<typeof DrawdownCeiling>;

export const DrawdownEntry = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("category"), category: DrawdownCategory }),
    z.object({ kind: z.literal("account"), accountId: Id }),
    z.object({ kind: z.literal("realAsset"), assetId: Id }),
    /** Draw from these accounts together, each in proportion to its withdrawable balance. */
    z.object({ kind: z.literal("proportional"), accountIds: z.array(Id).min(2) }),
    /**
     * Draw from pre-tax (tax-deferred) accounts only while taxable income stays within `ceiling`,
     * then pass the rest of the need to the next entry. Per person where the tax system taxes
     * individuals (the lowest-taxed person first), for the household where it taxes jointly. The
     * accounts stay available to later entries. Empty `accountIds` = every tax-deferred account.
     */
    z.object({
      kind: z.literal("fillToCeiling"),
      ceiling: DrawdownCeiling,
      accountIds: z.array(Id).default([]),
    }),
  ])
  .meta({ id: "DrawdownEntry" });
export type DrawdownEntry = z.infer<typeof DrawdownEntry>;

const grouped = (n: number) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** A ceiling in words, for the ledger, the trace and change descriptions. */
export function describeDrawdownCeiling(c: DrawdownCeiling): string {
  if (c.kind === "bracket")
    return c.rate === 0
      ? "tax-free allowance (0% band)"
      : `top of the ${+(c.rate * 100).toFixed(2)}% band`;
  return `taxable income of ${grouped(c.amount.value)}${c.amount.basis === "nominal" ? " (nominal)" : " (today's money)"}`;
}

/** One drawdown entry in words; `name` turns an account or asset id into its name. */
export function describeDrawdownEntry(e: DrawdownEntry, name: (id: string) => string): string {
  switch (e.kind) {
    case "category":
      return e.category;
    case "account":
      return name(e.accountId);
    case "realAsset":
      return name(e.assetId);
    case "proportional":
      return `${e.accountIds.map(name).join(" + ")} (in proportion to balances)`;
    case "fillToCeiling":
      return `${e.accountIds.length ? e.accountIds.map(name).join(" + ") : "pre-tax accounts"} up to the ${describeDrawdownCeiling(e.ceiling)}`;
  }
}

/** Why a blended drawdown entry drew a ledger withdrawal, in words (see LedgerEntry.rule). */
export function describeDrawdownRule(
  rule: {
    kind: "proportional" | "fill-to-ceiling";
    entry: number;
    owner?: string | undefined;
    ceiling?: string | undefined;
    bandRate?: number | undefined;
  },
  personName: (id: string) => string = (id) => id,
): string {
  if (rule.kind === "proportional")
    return `drawdown entry ${rule.entry}: in proportion to balances`;
  const who = rule.owner ? `${personName(rule.owner)}'s` : "the household's";
  const band = rule.bandRate === undefined ? "" : ` ${+(rule.bandRate * 100).toFixed(2)}% band`;
  return `drawdown entry ${rule.entry}: fills ${who}${band}, up to the ${rule.ceiling ?? "ceiling"}`;
}

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
    /** Couples: split each category's withdrawal across owners in proportion to their balances. */
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
