/**
 * Change sets and plan diffs.
 *
 * PatchOp is RFC 6902 JSON Patch with ONE extension: an array element may be addressed by id
 * with the segment `[id=<id>]`, e.g. `/income/[id=salary-1]/amount/value`. Agents and the UI
 * should always use id addressing for arrays of entities (indexes are fragile).
 */
import { z } from "zod";
import { Id, Timestamp } from "./primitives.js";

export const PatchOp = z
  .discriminatedUnion("op", [
    z.object({ op: z.literal("add"), path: z.string(), value: z.unknown() }),
    z.object({ op: z.literal("remove"), path: z.string() }),
    z.object({ op: z.literal("replace"), path: z.string(), value: z.unknown() }),
    z.object({ op: z.literal("move"), from: z.string(), path: z.string() }),
    z.object({ op: z.literal("test"), path: z.string(), value: z.unknown() }),
  ])
  .meta({ id: "PatchOp" });
export type PatchOp = z.infer<typeof PatchOp>;

export const Actor = z
  .object({
    kind: z.enum(["user", "api-key", "mcp", "system", "importer"]),
    id: z.string().max(80).optional(),
    label: z.string().max(120).optional(),
  })
  .meta({ id: "Actor" });
export type Actor = z.infer<typeof Actor>;

/** Headline outcome numbers used for previews and diffs. All money in real (today's) terms. */
export const OutcomeSummary = z
  .object({
    successRate: z.number().min(0).max(1).nullable(),
    endNetWorthReal: z.number(),
    lifetimeTaxesReal: z.number(),
    depletionYear: z.number().int().nullable(),
    retirementYear: z.number().int().nullable(),
  })
  .meta({ id: "OutcomeSummary" });
export type OutcomeSummary = z.infer<typeof OutcomeSummary>;

/** A proposed set of edits to one plan (MCP writes go through this; never whole-plan overwrite). */
export const ChangeSet = z
  .object({
    id: Id,
    planId: Id,
    /** Plan.version the ops were authored against; applying fails with 409 if it moved. */
    baseVersion: z.number().int().min(0),
    ops: z.array(PatchOp).min(1),
    summary: z.string().max(500),
    rationale: z.string().max(4000).optional(),
    status: z.enum(["proposed", "applied", "discarded", "conflict"]),
    createdBy: Actor,
    createdAt: Timestamp,
    appliedAt: Timestamp.optional(),
    preview: z.object({ before: OutcomeSummary, after: OutcomeSummary }).optional(),
  })
  .meta({ id: "ChangeSet" });
export type ChangeSet = z.infer<typeof ChangeSet>;

export const PlanChange = z
  .object({
    /** JSON pointer using `[id=...]` segments. */
    path: z.string(),
    kind: z.enum(["added", "removed", "changed", "moved"]),
    entity: z.object({
      type: z.enum([
        "plan",
        "milestone",
        "income",
        "expense",
        "flow",
        "account",
        "realAsset",
        "debt",
        "assumption",
        "tax",
        "strategy",
        "monteCarlo",
      ]),
      id: Id.optional(),
      name: z.string().optional(),
    }),
    before: z.unknown().optional(),
    after: z.unknown().optional(),
    /** Human-readable: "Salary raised from 80,000 to 90,000 per year". */
    description: z.string(),
  })
  .meta({ id: "PlanChange" });
export type PlanChange = z.infer<typeof PlanChange>;

export const PlanDiff = z
  .object({
    basePlanId: Id,
    otherPlanId: Id,
    changes: z.array(PlanChange),
    /** Patch that turns base into other (feeds branching and change sets). */
    patch: z.array(PatchOp),
    outcome: z.object({ base: OutcomeSummary, other: OutcomeSummary }).optional(),
  })
  .meta({ id: "PlanDiff" });
export type PlanDiff = z.infer<typeof PlanDiff>;
