/**
 * Nested plan collections and singletons, addressed by id. Every write goes through
 * PlansService.write, so each is optimistic-concurrency-checked, validated, versioned and audited.
 */
import {
  type Actor,
  Assumptions,
  DrawdownSettings,
  ExpenseEvent,
  FlexSpending,
  Flow,
  IncomeEvent,
  LeftoverPolicy,
  Milestone,
  MonteCarloSettings,
  type Plan,
  PlannedAccount,
  PlannedRealAsset,
  ResidencyChange,
  RiskGuardrails,
  TaxConfig,
  TaxStrategy,
  WithdrawalStrategy,
} from "@glideworth/core";
import type { z } from "zod";
import { ApiError, conflict, notFound } from "../errors.js";
import { mergePatch, newId } from "../util.js";
import type { PlansService } from "./plans.js";

export interface CollectionDef {
  key:
    | "income"
    | "expenses"
    | "milestones"
    | "flows"
    | "plannedAccounts"
    | "plannedRealAssets"
    | "residency";
  /** Singular label for messages/OpenAPI. */
  label: string;
  prefix: string;
  schema: z.ZodType;
  tag: string;
}

export const COLLECTIONS: CollectionDef[] = [
  { key: "income", label: "income event", prefix: "inc", schema: IncomeEvent, tag: "Plan: income" },
  {
    key: "expenses",
    label: "expense event",
    prefix: "exp",
    schema: ExpenseEvent,
    tag: "Plan: expenses",
  },
  {
    key: "milestones",
    label: "milestone",
    prefix: "ms",
    schema: Milestone,
    tag: "Plan: milestones",
  },
  { key: "flows", label: "flow", prefix: "flow", schema: Flow, tag: "Plan: flows" },
  {
    key: "plannedAccounts",
    label: "planned account",
    prefix: "pacct",
    schema: PlannedAccount,
    tag: "Plan: planned accounts",
  },
  {
    key: "plannedRealAssets",
    label: "planned real asset",
    prefix: "passet",
    schema: PlannedRealAsset,
    tag: "Plan: planned assets",
  },
  {
    key: "residency",
    label: "residency change",
    prefix: "res",
    schema: ResidencyChange,
    tag: "Plan: residency",
  },
];

export interface SingletonDef {
  key:
    | "assumptions"
    | "tax"
    | "withdrawalStrategy"
    | "drawdown"
    | "flexSpending"
    | "riskGuardrails"
    | "taxStrategy"
    | "monteCarlo"
    | "leftover";
  label: string;
  schema: z.ZodType;
  /** Optional on Plan: DELETE removes it. Required ones reset to defaults on DELETE. */
  optional: boolean;
  tag: string;
}

export const SINGLETONS: SingletonDef[] = [
  {
    key: "assumptions",
    label: "assumptions",
    schema: Assumptions,
    optional: false,
    tag: "Plan: settings",
  },
  { key: "tax", label: "tax settings", schema: TaxConfig, optional: false, tag: "Plan: settings" },
  {
    key: "withdrawalStrategy",
    label: "withdrawal strategy",
    schema: WithdrawalStrategy,
    optional: true,
    tag: "Plan: settings",
  },
  {
    key: "drawdown",
    label: "drawdown settings",
    schema: DrawdownSettings,
    optional: false,
    tag: "Plan: settings",
  },
  {
    key: "flexSpending",
    label: "flexible spending",
    schema: FlexSpending,
    optional: false,
    tag: "Plan: settings",
  },
  {
    key: "riskGuardrails",
    label: "risk guardrails",
    schema: RiskGuardrails,
    optional: true,
    tag: "Plan: settings",
  },
  {
    key: "taxStrategy",
    label: "tax strategy",
    schema: TaxStrategy,
    optional: true,
    tag: "Plan: settings",
  },
  {
    key: "monteCarlo",
    label: "Monte Carlo settings",
    schema: MonteCarloSettings,
    optional: false,
    tag: "Plan: settings",
  },
  {
    key: "leftover",
    label: "leftover policy",
    schema: LeftoverPolicy,
    optional: false,
    tag: "Plan: settings",
  },
];

export const collectionDef = (key: string) => COLLECTIONS.find((c) => c.key === key)!;
export const singletonDef = (key: string) => SINGLETONS.find((c) => c.key === key)!;

type Item = { id: string };
type Mutable = Record<string, unknown>;

export class PlanPartsService {
  constructor(private readonly plans: PlansService) {}

  private listOf(p: Plan, key: CollectionDef["key"]): Item[] {
    const r = p as unknown as Record<string, Item[] | undefined>;
    r[key] ??= [];
    return r[key]!;
  }

  // ----------------------------------------------------------------------------- collections
  list(planId: string, key: CollectionDef["key"]): Item[] {
    return (this.plans.get(planId) as unknown as Record<string, Item[]>)[key] ?? [];
  }

  get(planId: string, key: CollectionDef["key"], itemId: string): Item {
    const item = this.list(planId, key).find((i) => i.id === itemId);
    if (!item) throw notFound(collectionDef(key).label, itemId);
    return item;
  }

  create(
    planId: string,
    key: CollectionDef["key"],
    input: Mutable,
    o: { index?: number | undefined; expectedVersion?: number | undefined; actor: Actor },
  ) {
    const def = collectionDef(key);
    const item = def.schema.parse({ ...input, id: input.id ?? newId(def.prefix) }) as Item;
    const plan = this.plans.write(
      planId,
      (p) => {
        const list = this.listOf(p, key);
        if (list.some((x) => x.id === item.id))
          throw conflict(`${def.label} '${item.id}' already exists`);
        if (o.index === undefined || o.index >= list.length) list.push(item);
        else list.splice(Math.max(0, o.index), 0, item);
        return p;
      },
      {
        actor: o.actor,
        expectedVersion: o.expectedVersion,
        message: `added ${def.label} '${item.id}'`,
      },
    );
    return { item, plan };
  }

  update(
    planId: string,
    key: CollectionDef["key"],
    itemId: string,
    body: Mutable,
    mode: "replace" | "merge",
    o: { expectedVersion?: number | undefined; actor: Actor },
  ) {
    const def = collectionDef(key);
    let item!: Item;
    const plan = this.plans.write(
      planId,
      (p) => {
        const list = this.listOf(p, key);
        const i = list.findIndex((x) => x.id === itemId);
        if (i < 0) throw notFound(def.label, itemId);
        const merged = mode === "merge" ? mergePatch(list[i], body) : body;
        item = def.schema.parse({ ...(merged as object), id: itemId }) as Item;
        list[i] = item;
        return p;
      },
      {
        actor: o.actor,
        expectedVersion: o.expectedVersion,
        message: `updated ${def.label} '${itemId}'`,
      },
    );
    return { item, plan };
  }

  delete(
    planId: string,
    key: CollectionDef["key"],
    itemId: string,
    o: { expectedVersion?: number | undefined; actor: Actor },
  ) {
    const def = collectionDef(key);
    return this.plans.write(
      planId,
      (p) => {
        const list = this.listOf(p, key);
        const found = list.find((x) => x.id === itemId);
        if (!found) throw notFound(def.label, itemId);
        if (key === "milestones" && (found as { builtIn?: boolean }).builtIn)
          throw new ApiError(
            409,
            "CONFLICT",
            `milestone '${itemId}' is built in and cannot be deleted`,
          );
        (p as unknown as Record<string, Item[]>)[key] = list.filter((x) => x.id !== itemId);
        return p;
      },
      {
        actor: o.actor,
        expectedVersion: o.expectedVersion,
        message: `removed ${def.label} '${itemId}'`,
      },
    );
  }

  /** Reorder a collection (flows: priority order). `ids` must be a permutation of the current ids. */
  reorder(
    planId: string,
    key: CollectionDef["key"],
    ids: string[],
    o: { expectedVersion?: number | undefined; actor: Actor },
  ) {
    return this.plans.write(
      planId,
      (p) => {
        const list = this.listOf(p, key);
        const have = new Set(list.map((x) => x.id));
        if (
          ids.length !== list.length ||
          ids.some((i) => !have.has(i)) ||
          new Set(ids).size !== ids.length
        )
          throw new ApiError(400, "VALIDATION", "ids must be a permutation of the existing ids", {
            expected: [...have],
          });
        (p as unknown as Record<string, Item[]>)[key] = ids.map((i) =>
          list.find((x) => x.id === i)!,
        );
        return p;
      },
      { actor: o.actor, expectedVersion: o.expectedVersion, message: `reordered ${key}` },
    );
  }

  // ----------------------------------------------------------------------------- singletons
  getSingleton(planId: string, key: SingletonDef["key"]): unknown {
    const v = (this.plans.get(planId) as unknown as Mutable)[key];
    if (v === undefined) throw notFound(singletonDef(key).label, planId);
    return v;
  }

  putSingleton(
    planId: string,
    key: SingletonDef["key"],
    body: unknown,
    mode: "replace" | "merge",
    o: { expectedVersion?: number | undefined; actor: Actor },
  ) {
    const def = singletonDef(key);
    let value: unknown;
    const plan = this.plans.write(
      planId,
      (p) => {
        const cur = (p as unknown as Mutable)[key];
        value = def.schema.parse(mode === "merge" ? mergePatch(cur ?? {}, body) : body);
        (p as unknown as Mutable)[key] = value;
        return p;
      },
      { actor: o.actor, expectedVersion: o.expectedVersion, message: `updated ${def.label}` },
    );
    return { value, plan };
  }

  deleteSingleton(
    planId: string,
    key: SingletonDef["key"],
    o: { expectedVersion?: number | undefined; actor: Actor },
  ) {
    const def = singletonDef(key);
    return this.plans.write(
      planId,
      (p) => {
        (p as unknown as Mutable)[key] = undefined;
        return p;
      },
      {
        actor: o.actor,
        expectedVersion: o.expectedVersion,
        message: def.optional ? `removed ${def.label}` : `reset ${def.label} to defaults`,
      },
    );
  }
}
