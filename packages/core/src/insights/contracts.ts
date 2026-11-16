/** Shared output contracts for insights: findings and explanations (UI, REST and MCP render these). */
import { z } from "zod";
import { PatchOp } from "../schema/changes.js";

/** A concrete, previewable fix: apply `patch` with applyPlanPatch (or propose it as a change set). */
export const SuggestedFix = z
  .object({
    description: z.string(),
    patch: z.array(PatchOp),
  })
  .meta({ id: "SuggestedFix" });
export type SuggestedFix = z.infer<typeof SuggestedFix>;

export const Finding = z
  .object({
    code: z.string(),
    severity: z.enum(["info", "warning", "critical"]),
    title: z.string(),
    message: z.string(),
    periodIndex: z.number().int().nullable(),
    /** Entity ids involved (accounts, events, milestones). */
    refs: z.array(z.string()),
    /** Trace entries / ledger entries / numbers backing the finding. Every entry has a `source`. */
    evidence: z.array(z.record(z.string(), z.unknown())).default([]),
    suggestion: z.string().optional(),
    /** Machine-applicable fix (plan patch), when one exists. */
    fix: SuggestedFix.optional(),
  })
  .meta({ id: "Finding" });
export type Finding = z.infer<typeof Finding>;

export const Explanation = z
  .object({
    headline: z.string(),
    findings: z.array(Finding),
  })
  .meta({ id: "Explanation" });
export type Explanation = z.infer<typeof Explanation>;
