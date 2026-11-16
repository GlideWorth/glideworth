import { type Actor, ChangeSet, PatchOp, type Plan, PlanChange } from "@glideworth/core";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { changeSets } from "../db/schema.js";
import { conflict, notFound } from "../errors.js";
import { newId, nowIso } from "../util.js";
import type { ServiceCtx } from "./context.js";
import type { PlansService } from "./plans.js";
import type { SimulationService } from "./simulation.js";

export const ChangeSetView = ChangeSet.extend({
  changes: z
    .array(PlanChange)
    .describe("Human-readable diff of what applying the change set would do."),
}).meta({ id: "ChangeSetView" });
export type ChangeSetView = z.infer<typeof ChangeSetView>;

export const ProposeBody = z
  .object({
    ops: z
      .array(PatchOp)
      .min(1)
      .max(200)
      .describe(
        "RFC 6902 operations; address array entities by id: /income/[id=salary]/amount/value.",
      ),
    summary: z.string().min(1).max(500).describe("One line: what this change does."),
    rationale: z.string().max(4000).optional(),
    baseVersion: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Plan version the ops were authored against (default: current)."),
    preview: z
      .boolean()
      .default(true)
      .describe("Run before/after simulations (set false to skip)."),
  })
  .meta({
    id: "ProposeChangeSet",
    examples: [
      {
        summary: "Raise travel budget to 15k/yr",
        rationale: "User asked to travel more in early retirement",
        baseVersion: 1,
        ops: [{ op: "replace", path: "/expenses/[id=exp-travel]/amount/value", value: 15000 }],
      },
    ],
  });

type Row = typeof changeSets.$inferSelect;

export class ChangeSetsService {
  constructor(
    private readonly ctx: ServiceCtx,
    private readonly plans: PlansService,
    private readonly sim: SimulationService,
  ) {}

  private view(r: Row): ChangeSetView {
    return r.body as ChangeSetView;
  }

  private row(id: string): Row {
    const r = this.ctx.db.select().from(changeSets).where(eq(changeSets.id, id)).get();
    if (!r) throw notFound("change set", id);
    return r;
  }

  get(id: string): ChangeSetView {
    return this.view(this.row(id));
  }

  list(f: { planId?: string | undefined; status?: string | undefined } = {}): ChangeSetView[] {
    const conds = [];
    if (f.planId) conds.push(eq(changeSets.planId, f.planId));
    if (f.status) conds.push(eq(changeSets.status, f.status as Row["status"]));
    return this.ctx.db
      .select()
      .from(changeSets)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(changeSets.createdAt))
      .all()
      .map((r) => this.view(r));
  }

  /** Validate and preview a set of edits without applying them. */
  propose(planId: string, body: z.infer<typeof ProposeBody>, actor: Actor): ChangeSetView {
    const plan = this.plans.get(planId);
    const baseVersion = body.baseVersion ?? plan.version;
    if (baseVersion !== plan.version)
      throw conflict(
        `ops were authored against version ${baseVersion} but the plan is at ${plan.version}; re-read the plan and propose again`,
        { baseVersion, currentVersion: plan.version },
        "VERSION_CONFLICT",
      );
    const { diff, preview } = this.sim.preview(planId, body.ops, body.preview);
    const cs: ChangeSetView = {
      id: newId("cs"),
      planId,
      baseVersion,
      ops: body.ops,
      summary: body.summary,
      ...(body.rationale ? { rationale: body.rationale } : {}),
      status: "proposed",
      createdBy: actor,
      createdAt: nowIso(),
      ...(preview ? { preview } : {}),
      changes: diff.changes,
    };
    this.ctx.db
      .insert(changeSets)
      .values({
        id: cs.id,
        planId,
        baseVersion,
        status: "proposed",
        body: cs as never,
        createdAt: cs.createdAt,
      })
      .run();
    return cs;
  }

  private save(cs: ChangeSetView): void {
    this.ctx.db
      .update(changeSets)
      .set({ status: cs.status, body: cs as never, appliedAt: cs.appliedAt ?? null })
      .where(eq(changeSets.id, cs.id))
      .run();
  }

  /** Apply atomically: fails with 409 CHANGESET_CONFLICT if the plan moved since the proposal. */
  apply(id: string, actor: Actor): { changeSet: ChangeSetView; plan: Plan } {
    const cs = this.get(id);
    if (cs.status !== "proposed")
      throw conflict(
        `change set is ${cs.status}, not proposed`,
        { status: cs.status },
        "CHANGESET_NOT_PROPOSED",
      );
    const current = this.plans.get(cs.planId);
    if (current.version !== cs.baseVersion) {
      this.save({ ...cs, status: "conflict" });
      throw conflict(
        `plan moved from version ${cs.baseVersion} to ${current.version} since this change set was proposed; propose it again`,
        { baseVersion: cs.baseVersion, currentVersion: current.version },
        "CHANGESET_CONFLICT",
      );
    }
    let plan!: Plan;
    let applied!: ChangeSetView;
    this.ctx.db.transaction(() => {
      plan = this.plans.write(cs.planId, (p) => this.ctx.deps.applyPlanPatch(p, cs.ops), {
        actor,
        expectedVersion: cs.baseVersion,
        message: cs.summary,
        changeSetId: cs.id,
      });
      applied = { ...cs, status: "applied", appliedAt: nowIso() };
      this.save(applied);
    });
    return { changeSet: applied, plan };
  }

  discard(id: string): ChangeSetView {
    const cs = this.get(id);
    if (cs.status === "applied")
      throw conflict(
        "an applied change set cannot be discarded; restore a plan version instead",
        undefined,
        "CHANGESET_NOT_PROPOSED",
      );
    const next = { ...cs, status: "discarded" as const };
    this.save(next);
    return next;
  }
}
