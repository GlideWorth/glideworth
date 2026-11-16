/** Current finances (starting conditions) and plans (scenarios on top of them). */
import { z } from "zod";
import { Account, AccountBehaviourPatch, PlannedAccount } from "./accounts.js";
import {
  Debt,
  DebtBehaviourPatch,
  PlannedRealAsset,
  RealAsset,
  RealAssetBehaviourPatch,
} from "./assets-debts.js";
import { Assumptions, FxRate } from "./assumptions.js";
import { PatchOp } from "./changes.js";
import { ExpenseEvent, IncomeEvent } from "./events.js";
import { Flow, LeftoverPolicy } from "./flows.js";
import { Milestone } from "./milestones.js";
import {
  MonteCarloSettings,
  type MonteCarloSettingsInput,
  withReplacedDataset,
} from "./montecarlo.js";
import { Appearance, Id, MonthDate, Notes, Timestamp } from "./primitives.js";
import { ResidencyChange } from "./residency.js";
import {
  DrawdownSettings,
  FlexSpending,
  RiskGuardrails,
  TaxStrategy,
  WithdrawalStrategy,
} from "./strategies.js";
import { TaxConfig } from "./tax.js";

export const CurrentFinances = z
  .object({
    /** Month the balances are valid for. "Now" plans start here. */
    asOf: MonthDate,
    accounts: z.array(Account).default([]),
    realAssets: z.array(RealAsset).default([]),
    debts: z.array(Debt).default([]),
    /**
     * Exchange rates for accounts, assets, debts and events held in another currency than the
     * household's base currency (as of `asOf`, with optional annual drift per pair).
     */
    fxRates: z.array(FxRate).optional(),
    updatedAt: Timestamp.optional(),
  })
  .meta({ id: "CurrentFinances" });
export type CurrentFinances = z.infer<typeof CurrentFinances>;
export type CurrentFinancesInput = z.input<typeof CurrentFinances>;

export const StartingConditions = z
  .discriminatedUnion("kind", [
    /** "Now" plan: always reads the latest CurrentFinances; starts at finances.asOf. */
    z.object({ kind: z.literal("live") }),
    /** Fixed-date plan: frozen starting point, ignores later CurrentFinances edits. */
    z.object({ kind: z.literal("snapshot"), finances: CurrentFinances }),
  ])
  .meta({ id: "StartingConditions" });
export type StartingConditions = z.infer<typeof StartingConditions>;

/**
 * Branching lineage. The patch (applied to the parent's materialised body) is the source of
 * truth; the stored body is a materialised cache refreshed whenever the parent changes.
 */
export const PlanLineage = z
  .object({
    parentPlanId: Id,
    /** null = follow the parent's latest version; a number pins to that parent version. */
    parentVersion: z.number().int().nullable().default(null),
    patch: z.array(PatchOp).default([]),
  })
  .meta({ id: "PlanLineage" });
export type PlanLineage = z.infer<typeof PlanLineage>;

export const Plan = z
  .object({
    id: Id,
    householdId: Id,
    name: z.string().min(1).max(120),
    description: z.string().max(2000).optional(),
    appearance: Appearance.optional(),
    isMain: z.boolean().default(false),
    status: z.enum(["active", "archived"]).default("active"),
    lineage: PlanLineage.optional(),
    startingConditions: StartingConditions.default({ kind: "live" }),

    milestones: z.array(Milestone).default([]),
    /**
     * Residency timeline: dated changes of tax residence per person (or everyone). Absent = everyone
     * stays at `Household.location` (relocation milestone effects still apply).
     */
    residency: z.array(ResidencyChange).max(50).optional(),
    income: z.array(IncomeEvent).default([]),
    expenses: z.array(ExpenseEvent).default([]),
    /** Ordered savings waterfall: index 0 has highest priority. */
    flows: z.array(Flow).default([]),
    leftover: LeftoverPolicy.default({ kind: "save" }),

    /** Per-account behaviour overrides keyed by Account.id (shallow merge per top-level key). */
    accountSettings: z.record(Id, AccountBehaviourPatch).default({}),
    plannedAccounts: z.array(PlannedAccount).default([]),
    realAssetSettings: z.record(Id, RealAssetBehaviourPatch).default({}),
    plannedRealAssets: z.array(PlannedRealAsset).default([]),
    debtSettings: z.record(Id, DebtBehaviourPatch).default({}),
    /** Accounts/assets/debts from CurrentFinances excluded from this plan's simulation. */
    excludedIds: z.array(Id).default([]),

    drawdown: DrawdownSettings.default(DrawdownSettings.parse({})),
    withdrawalStrategy: WithdrawalStrategy.optional(),
    flexSpending: FlexSpending.default(FlexSpending.parse({})),
    riskGuardrails: RiskGuardrails.optional(),
    taxStrategy: TaxStrategy.optional(),

    assumptions: Assumptions.default(Assumptions.parse({})),
    tax: TaxConfig.default(TaxConfig.parse({})),
    /** A retired dataset id is read as its replacement and flagged (`withReplacedDataset`). */
    monteCarlo: z.preprocess(
      (raw: MonteCarloSettingsInput | undefined) =>
        withReplacedDataset(raw) as MonteCarloSettingsInput | undefined,
      MonteCarloSettings.default(MonteCarloSettings.parse({})),
    ),

    notes: Notes.optional(),
    /** Optimistic-concurrency version, incremented by the API on every write. */
    version: z.number().int().min(0).default(0),
    createdAt: Timestamp.optional(),
    updatedAt: Timestamp.optional(),
  })
  .meta({ id: "Plan" });
export type Plan = z.infer<typeof Plan>;
export type PlanInput = z.input<typeof Plan>;
