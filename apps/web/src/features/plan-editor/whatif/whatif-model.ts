/**
 * What-If staging: slider settings become a patch (RFC 6902 ops with `[id=...]` paths) against the
 * plan being edited. The staged plan is `applyPlanPatchWithInverse(plan, ops)`; the inverse undoes
 * an apply, `diffPlans` describes the change, and `createBranch` turns it into a branch.
 */
import {
  applyPlanPatchWithInverse,
  applyVariable,
  createBranch,
  diffPlans,
  earlyRetirementScenario,
  type PatchOp,
  type Plan,
  type PlanChange,
  type SimulationInput,
  scalableFlowIds,
} from "@glideworth/core";
import { diffFormat } from "../../results/core-bridge";

export interface WhatIfSettings {
  /** Percentage points added to the fixed stock return (e.g. -0.02). */
  growth: number;
  /** Percentage points added to the fixed inflation rate. */
  inflation: number;
  /** Years later (+) or earlier (-) than the plan's retirement. */
  retireShift: number;
  /** Multiplier on every recurring expense. */
  spending: number;
  /** Multiplier on every scalable contribution. */
  saving: number;
}

export const NEUTRAL: WhatIfSettings = {
  growth: 0,
  inflation: 0,
  retireShift: 0,
  spending: 1,
  saving: 1,
};

export const isNeutral = (s: WhatIfSettings) =>
  s.growth === 0 && s.inflation === 0 && s.retireShift === 0 && s.spending === 1 && s.saving === 1;

/** Which sliders the plan supports, with the reason when one is disabled. */
export interface Capabilities {
  growth: { ok: boolean; base?: number; reason?: string };
  inflation: { ok: boolean; base?: number; reason?: string };
  retirement: { ok: boolean; baseAge?: number; personName?: string; reason?: string };
  spending: { ok: boolean; reason?: string };
  saving: { ok: boolean; reason?: string };
}

export function capabilities(input: SimulationInput): Capabilities {
  const { plan, household } = input;
  const stock = plan.assumptions.stockReturn;
  const infl = plan.assumptions.inflation;
  const ms = plan.milestones.find((m) => m.kind === "retirement");
  const crit = ms && ms.criteria.length === 1 ? ms.criteria[0] : undefined;
  const who =
    crit?.kind === "age" ? household.people.find((p) => p.id === crit.personId) : undefined;
  // Core decides which flows have an amount to scale (`max` flows fill a limit and cannot).
  const scalable = new Set(scalableFlowIds(plan));
  const scalableFlows = plan.flows.filter((f) => scalable.has(f.id));
  return {
    growth:
      stock.kind === "fixed"
        ? { ok: true, base: stock.rate }
        : {
            ok: false,
            reason:
              "Stock returns use a schedule or historical series. Change them in Assumptions.",
          },
    inflation:
      infl.kind === "fixed"
        ? { ok: true, base: infl.rate }
        : {
            ok: false,
            reason: "Inflation uses a schedule or historical series. Change it in Assumptions.",
          },
    retirement:
      crit?.kind === "age"
        ? { ok: true, baseAge: crit.age, ...(who ? { personName: who.name } : {}) }
        : {
            ok: false,
            reason: ms
              ? "Retirement is not a simple age milestone."
              : "This plan has no retirement milestone.",
          },
    spending: plan.expenses.some(
      (e) => e.enabled && e.spendingType !== "not-spending" && "amount" in e,
    )
      ? { ok: true }
      : { ok: false, reason: "No spending to scale." },
    saving: scalableFlows.length
      ? { ok: true }
      : { ok: false, reason: "No contribution flows with an amount or share to scale." },
  };
}

export function buildOps(input: SimulationInput, s: WhatIfSettings): PatchOp[] {
  const { plan } = input;
  const caps = capabilities(input);
  const ops: PatchOp[] = [];
  if (s.growth !== 0 && caps.growth.ok)
    ops.push({
      op: "replace",
      path: "/assumptions/stockReturn",
      value: { kind: "fixed", rate: caps.growth.base! + s.growth },
    });
  if (s.inflation !== 0 && caps.inflation.ok)
    ops.push({
      op: "replace",
      path: "/assumptions/inflation",
      value: { kind: "fixed", rate: Math.max(-0.05, caps.inflation.base! + s.inflation) },
    });
  if (s.retireShift !== 0 && caps.retirement.ok)
    ops.push(...earlyRetirementScenario(input, { years: -s.retireShift }).patch);
  if (s.spending !== 1 && caps.spending.ok)
    ops.push(...(applyVariable(input, { kind: "spendingScale" }, s.spending).patch ?? []));
  if (s.saving !== 1 && caps.saving.ok)
    for (const f of plan.flows) {
      try {
        ops.push(
          ...(applyVariable(input, { kind: "flowScale", flowId: f.id }, s.saving).patch ?? []),
        );
      } catch {
        // Flow has no scalable amount (transfers, "all remaining"): leave it alone.
      }
    }
  return ops;
}

export interface Staged {
  ops: PatchOp[];
  plan: Plan;
  /** Undoes `ops` when applied to the staged plan. */
  inverse: PatchOp[];
  changes: PlanChange[];
}

/** Apply the staged ops; null when nothing is staged. Throws if the patched plan is invalid. */
export function stage(
  input: SimulationInput,
  s: WhatIfSettings,
  format?: { locale: string; currency: string },
): Staged | null {
  const ops = buildOps(input, s);
  if (ops.length === 0) return null;
  const { plan, inverse } = applyPlanPatchWithInverse(input.plan, ops);
  const changes = diffPlans(
    input.plan,
    plan,
    format ? diffFormat(input, format.locale, format.currency) : {},
  ).changes;
  return { ops, plan, inverse, changes };
}

export function branchFor(parent: Plan, ops: PatchOp[], name: string, id: string): Plan {
  return createBranch(parent, { id, name, patch: ops, description: "Saved from What-If mode." });
}
