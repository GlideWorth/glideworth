import { log } from "../log.js";
import {
  type Actor,
  type PatchOp,
  Plan,
  type PlanDiff,
  type PlanInput,
  SCHEMA_VERSION,
} from "@glideworth/core";
import { and, asc, desc, eq, max, ne } from "drizzle-orm";
import { plans, planVersions } from "../db/schema.js";
import { ApiError, conflict, notFound } from "../errors.js";
import { clone, newId, nowIso } from "../util.js";
import type { ServiceCtx } from "./context.js";
import type { HouseholdsService } from "./households.js";
import { readPlanBody } from "./migrate.js";

export interface PlanVersionInfo {
  version: number;
  createdAt: string;
  actor: unknown;
  message: string | null;
  changeSetId: string | null;
}

export interface WriteOpts {
  actor: Actor;
  message?: string | undefined;
  changeSetId?: string | undefined;
  expectedVersion?: number | undefined;
  /** Branch children that must NOT be re-materialised after this write (merge bookkeeping). */
  skipChildren?: string[];
  /** Drop the branch lineage (promote to a standalone plan). */
  dropLineage?: boolean;
  /** Write (and recompute a branch patch) even when the body is unchanged. */
  recompute?: boolean;
}

const norm = (p: Plan) => JSON.stringify({ ...p, version: 0, updatedAt: "" });

export class PlansService {
  households!: HouseholdsService;
  constructor(private readonly ctx: ServiceCtx) {}
  private get db() {
    return this.ctx.db;
  }

  // ----------------------------------------------------------------------------- reads
  list(
    f: {
      householdId?: string | undefined;
      status?: "active" | "archived" | undefined;
      q?: string | undefined;
    } = {},
  ): Plan[] {
    const conds = [];
    if (f.householdId) conds.push(eq(plans.householdId, f.householdId));
    if (f.status) conds.push(eq(plans.status, f.status));
    const rows = this.db
      .select()
      .from(plans)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(asc(plans.sortOrder), asc(plans.createdAt), asc(plans.id))
      .all();
    const q = f.q?.toLowerCase();
    return rows
      .map((r) => readPlanBody(r.body, r.schemaVersion))
      .filter((p) => !q || p.name.toLowerCase().includes(q));
  }

  get(id: string): Plan {
    const row = this.db.select().from(plans).where(eq(plans.id, id)).get();
    if (!row) throw notFound("plan", id);
    return readPlanBody(row.body, row.schemaVersion);
  }

  tryGet(id: string): Plan | undefined {
    const row = this.db.select().from(plans).where(eq(plans.id, id)).get();
    return row ? readPlanBody(row.body, row.schemaVersion) : undefined;
  }

  children(id: string): Plan[] {
    return this.db
      .select()
      .from(plans)
      .where(eq(plans.parentPlanId, id))
      .orderBy(asc(plans.sortOrder), asc(plans.createdAt))
      .all()
      .map((r) => readPlanBody(r.body, r.schemaVersion));
  }

  // ----------------------------------------------------------------------------- persistence
  private persist(
    plan: Plan,
    actor: Actor,
    message: string | null,
    changeSetId: string | null,
    isNew: boolean,
  ): void {
    this.db.transaction((tx) => {
      const values = {
        name: plan.name,
        isMain: plan.isMain,
        status: plan.status,
        parentPlanId: plan.lineage?.parentPlanId ?? null,
        schemaVersion: SCHEMA_VERSION,
        body: plan,
        version: plan.version,
      };
      if (isNew)
        tx.insert(plans)
          .values({
            id: plan.id,
            householdId: plan.householdId,
            sortOrder: this.nextSortOrder(plan.householdId),
            ...values,
          })
          .run();
      else {
        const res = tx
          .update(plans)
          .set({ ...values, updatedAt: plan.updatedAt! })
          .where(and(eq(plans.id, plan.id), eq(plans.version, plan.version - 1)))
          .run();
        if (res.changes !== 1)
          throw conflict("plan changed concurrently", undefined, "VERSION_CONFLICT");
      }
      tx.insert(planVersions)
        .values({
          planId: plan.id,
          version: plan.version,
          schemaVersion: SCHEMA_VERSION,
          body: plan,
          actor,
          message,
          changeSetId,
        })
        .run();
    });
  }

  /** New plans go to the end of the household's display order. */
  private nextSortOrder(householdId: string): number {
    const row = this.db
      .select({ m: max(plans.sortOrder) })
      .from(plans)
      .where(eq(plans.householdId, householdId))
      .get();
    return (row?.m ?? -1) + 1;
  }

  /**
   * Persist the display order of a household's plans. Listed ids come first, in the given order;
   * plans not listed keep their relative order after them. Unknown ids are a 404 and change nothing.
   */
  reorder(householdId: string, ids: string[]): Plan[] {
    this.households.get(householdId);
    if (new Set(ids).size !== ids.length)
      throw new ApiError(400, "VALIDATION", "ids contains duplicates");
    const current = this.list({ householdId });
    const unknown = ids.filter((i) => !current.some((p) => p.id === i));
    if (unknown.length)
      throw new ApiError(404, "NOT_FOUND", `unknown plan ids: ${unknown.join(", ")}`, {
        unknownIds: unknown,
      });
    const rest = current.map((p) => p.id).filter((i) => !ids.includes(i));
    this.db.transaction((tx) => {
      [...ids, ...rest].forEach((planId, n) => {
        tx.update(plans).set({ sortOrder: n }).where(eq(plans.id, planId)).run();
      });
    });
    return this.list({ householdId });
  }

  private demoteOthers(plan: Plan, actor: Actor): void {
    if (!plan.isMain) return;
    for (const other of this.list({ householdId: plan.householdId })) {
      if (other.id !== plan.id && other.isMain) {
        const next = Plan.parse({
          ...other,
          isMain: false,
          version: other.version + 1,
          updatedAt: nowIso(),
        });
        this.persist(next, actor, `no longer main (main is now '${plan.name}')`, null, false);
      }
    }
  }

  private announce(
    plan: Plan,
    kind: "created" | "updated",
    actor: Actor,
    message: string | null,
  ): void {
    this.ctx.events.publish("plan.updated", {
      planId: plan.id,
      householdId: plan.householdId,
      name: plan.name,
      version: plan.version,
      change: kind,
      message,
      actor: { kind: actor.kind, id: actor.id ?? null, label: actor.label ?? null },
    });
  }

  // ----------------------------------------------------------------------------- create
  create(
    input: Omit<PlanInput, "id" | "lineage"> & { id?: string },
    actor: Actor,
    message = "created",
  ): Plan {
    this.households.get(input.householdId);
    const ts = nowIso();
    const plan = Plan.parse({
      ...input,
      id: input.id ?? newId("plan"),
      version: 1,
      createdAt: ts,
      updatedAt: ts,
    });
    if (plan.lineage)
      throw new ApiError(400, "VALIDATION", "use POST /plans/{id}/branches to create a branch");
    if (this.db.select({ id: plans.id }).from(plans).where(eq(plans.id, plan.id)).get())
      throw conflict(`plan '${plan.id}' already exists`);
    this.db.transaction(() => {
      this.persist(plan, actor, message, null, true);
      this.demoteOthers(plan, actor);
    });
    this.announce(plan, "created", actor, message);
    return plan;
  }

  /**
   * Import path: keeps lineage. A plan that already exists continues its version history (the import is
   * recorded as the next version, message 'imported', and every earlier version stays); a new plan starts
   * at version 1 with an 'imported' entry.
   */
  insertImported(plan: Plan, actor: Actor): Plan {
    const ts = nowIso();
    const prev = this.db.select().from(plans).where(eq(plans.id, plan.id)).get();
    if (prev && prev.householdId !== plan.householdId)
      throw conflict(`plan '${plan.id}' already exists in another household`);
    const last = prev
      ? Math.max(
          prev.version,
          this.db
            .select({ m: max(planVersions.version) })
            .from(planVersions)
            .where(eq(planVersions.planId, plan.id))
            .get()?.m ?? 0,
        )
      : 0;
    const next = Plan.parse({
      ...plan,
      version: last + 1,
      createdAt: prev
        ? readPlanBody(prev.body, prev.schemaVersion).createdAt
        : (plan.createdAt ?? ts),
      updatedAt: ts,
    });
    this.persist(next, actor, "imported", null, !prev);
    return next;
  }

  // ----------------------------------------------------------------------------- update
  /** Parent body a branch is derived from (pinned version, or the parent's latest). */
  parentSource(plan: Plan): Plan {
    const l = plan.lineage;
    if (!l) throw new ApiError(400, "VALIDATION", `plan '${plan.id}' is not a branch`);
    if (l.parentVersion === null) return this.get(l.parentPlanId);
    return this.versionBody(l.parentPlanId, l.parentVersion);
  }

  /** The single write path: optimistic concurrency, validation, history row, branch bookkeeping. */
  write(id: string, mutate: (p: Plan) => PlanInput | Plan, o: WriteOpts): Plan {
    const current = this.get(id);
    if (o.expectedVersion !== undefined && current.version !== o.expectedVersion)
      throw conflict(
        `plan is at version ${current.version}, not ${o.expectedVersion}`,
        { currentVersion: current.version },
        "VERSION_CONFLICT",
      );
    const draft = mutate(clone(current));
    let next = Plan.parse({
      ...draft,
      id,
      householdId: current.householdId,
      lineage: o.dropLineage ? undefined : current.lineage,
      version: current.version + 1,
      createdAt: current.createdAt,
      updatedAt: nowIso(),
    });
    if (!o.dropLineage && !o.recompute && norm(current) === norm(next)) return current;
    if (next.lineage) {
      const parent = this.parentSource(current);
      next = Plan.parse({
        ...next,
        lineage: { ...next.lineage, patch: this.ctx.deps.branchPatch(parent, next) },
      });
    }
    this.db.transaction(() => {
      this.persist(next, o.actor, o.message ?? null, o.changeSetId ?? null, false);
      this.demoteOthers(next, o.actor);
      this.rematerializeChildren(id, o.actor, o.skipChildren ?? []);
    });
    this.announce(next, "updated", o.actor, o.message ?? null);
    return next;
  }

  /** Full replace (PUT). */
  replace(
    id: string,
    input: PlanInput,
    expectedVersion: number | undefined,
    actor: Actor,
    message?: string,
  ): Plan {
    return this.write(id, () => input, { actor, expectedVersion, message });
  }

  /** RFC 6902 patch (PATCH). Uses core's applyPlanPatch (with `[id=...]` segments). */
  patch(
    id: string,
    ops: PatchOp[],
    expectedVersion: number | undefined,
    actor: Actor,
    message?: string,
  ): Plan {
    return this.write(id, (p) => this.ctx.deps.applyPlanPatch(p, ops), {
      actor,
      expectedVersion,
      message,
    });
  }

  /** Re-apply branch patches after a parent changed (children that follow the parent's latest version). */
  private rematerializeChildren(parentId: string, actor: Actor, skip: string[]): void {
    for (const child of this.children(parentId)) {
      if (skip.includes(child.id) || child.lineage?.parentVersion !== null) continue;
      const parent = this.get(parentId);
      try {
        const mat = this.ctx.deps.materializePlan(child, (pid, pinned) =>
          pinned === null
            ? pid === parentId
              ? parent
              : this.tryGet(pid)
            : this.versionBody(pid, pinned),
        );
        const next = Plan.parse({
          ...mat,
          id: child.id,
          householdId: child.householdId,
          lineage: child.lineage,
          isMain: child.isMain,
          version: child.version + 1,
          createdAt: child.createdAt,
          updatedAt: nowIso(),
        });
        if (norm(child) === norm(next)) continue;
        this.persist(
          next,
          { kind: "system", label: "branch re-materialised" },
          `parent '${parent.name}' changed (v${parent.version})`,
          null,
          false,
        );
        this.announce(next, "updated", actor, "branch re-materialised");
        this.rematerializeChildren(child.id, actor, []);
      } catch (err) {
        // A stale patch (target removed in the parent) must not block the parent's own write.
        if (err instanceof Error && "feature" in err) throw err;
        log.warn("plan.branch_rematerialise_failed", { err });
      }
    }
  }

  // ----------------------------------------------------------------------------- lifecycle
  delete(id: string, opts: { force?: boolean }, actor: Actor): void {
    const plan = this.get(id);
    const kids = this.children(id);
    if (kids.length && !opts.force)
      throw conflict(
        `plan has ${kids.length} branch(es); pass force=true to promote them to standalone plans`,
        { branchIds: kids.map((k) => k.id) },
        "IN_USE",
      );
    this.db.transaction(() => {
      for (const k of kids)
        this.write(k.id, (p) => p, {
          actor,
          dropLineage: true,
          message: `parent '${plan.name}' deleted`,
        });
      this.db.delete(plans).where(eq(plans.id, id)).run();
    });
    this.announce({ ...plan, version: plan.version + 1 }, "updated", actor, "deleted");
  }

  setArchived(
    id: string,
    archived: boolean,
    expectedVersion: number | undefined,
    actor: Actor,
  ): Plan {
    return this.write(
      id,
      (p) => ({
        ...p,
        status: archived ? "archived" : "active",
        isMain: archived ? false : p.isMain,
      }),
      { actor, expectedVersion, message: archived ? "archived" : "unarchived" },
    );
  }

  setMain(id: string, expectedVersion: number | undefined, actor: Actor): Plan {
    return this.write(id, (p) => ({ ...p, isMain: true, status: "active" }), {
      actor,
      expectedVersion,
      message: "set as main plan",
    });
  }

  duplicate(id: string, opts: { name?: string | undefined }, actor: Actor): Plan {
    const src = this.get(id);
    const { id: _i, version: _v, createdAt: _c, updatedAt: _u, lineage: _l, ...rest } = src;
    return this.create(
      { ...rest, name: opts.name ?? `${src.name} (copy)`, isMain: false, status: "active" },
      actor,
      `duplicated from '${src.name}' v${src.version}`,
    );
  }

  // ----------------------------------------------------------------------------- versions
  listVersions(id: string): PlanVersionInfo[] {
    this.get(id);
    return this.db
      .select({
        version: planVersions.version,
        createdAt: planVersions.createdAt,
        actor: planVersions.actor,
        message: planVersions.message,
        changeSetId: planVersions.changeSetId,
      })
      .from(planVersions)
      .where(eq(planVersions.planId, id))
      .orderBy(desc(planVersions.version))
      .all();
  }

  versionBody(id: string, version: number): Plan {
    const row = this.db
      .select()
      .from(planVersions)
      .where(and(eq(planVersions.planId, id), eq(planVersions.version, version)))
      .get();
    if (!row) throw notFound(`version ${version} of plan`, id);
    return readPlanBody(row.body, row.schemaVersion);
  }

  /** Undo: write the body of an older version as a new version (history is never rewritten). */
  restore(id: string, version: number, expectedVersion: number | undefined, actor: Actor): Plan {
    const old = this.versionBody(id, version);
    const {
      id: _i,
      householdId: _h,
      version: _v,
      createdAt: _c,
      updatedAt: _u,
      lineage: _l,
      ...body
    } = old;
    return this.write(id, (cur) => ({ ...cur, ...body, lineage: cur.lineage }), {
      actor,
      expectedVersion,
      message: `restored version ${version}`,
    });
  }

  diffVersions(id: string, from: number, to: number | "current"): PlanDiff {
    const base = this.versionBody(id, from);
    const other = to === "current" ? this.get(id) : this.versionBody(id, to);
    return this.ctx.deps.diffPlans(base, other, this.households.diffNames(base.householdId));
  }

  // ----------------------------------------------------------------------------- branches
  createBranch(
    parentId: string,
    input: {
      name: string;
      description?: string | undefined;
      patch?: PatchOp[] | undefined;
      pinParentVersion?: boolean | undefined;
    },
    actor: Actor,
  ): Plan {
    const parent = this.get(parentId);
    const ts = nowIso();
    const draft = this.ctx.deps.createBranch(parent, {
      id: newId("plan"),
      name: input.name,
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.patch ? { patch: input.patch } : {}),
      pin: input.pinParentVersion ?? false,
    });
    const branch = Plan.parse({ ...draft, version: 1, createdAt: ts, updatedAt: ts });
    this.persist(branch, actor, `branched from '${parent.name}' v${parent.version}`, null, true);
    this.announce(branch, "created", actor, "branch created");
    return branch;
  }

  diffAgainstParent(branchId: string): { parent: Plan; branch: Plan; diff: PlanDiff } {
    const branch = this.get(branchId);
    const parent = this.parentSource(branch);
    const diff = this.ctx.deps.diffPlans(
      parent,
      branch,
      this.households.diffNames(parent.householdId),
    );
    return { parent, branch, diff: { ...diff, basePlanId: parent.id, otherPlanId: branch.id } };
  }

  /**
   * Merge a branch.
   *  - `into-parent`: the parent takes the branch's content (keeps its own name/main/status); the
   *    branch is deleted unless `keepBranch`.
   *  - `promote`: the branch becomes a standalone plan (lineage dropped), optionally the main plan.
   */
  merge(
    branchId: string,
    o: {
      strategy: "into-parent" | "promote";
      keepBranch?: boolean | undefined;
      makeMain?: boolean | undefined;
      expectedParentVersion?: number | undefined;
      force?: boolean | undefined;
    },
    actor: Actor,
  ): { plan: Plan; parent: Plan | null; branchDeleted: boolean } {
    const branch = this.get(branchId);
    if (!branch.lineage)
      throw new ApiError(400, "VALIDATION", `plan '${branchId}' is not a branch`);
    if (o.strategy === "promote") {
      const plan = this.write(branchId, (p) => ({ ...p, isMain: o.makeMain ? true : p.isMain }), {
        actor,
        dropLineage: true,
        message: "promoted to a standalone plan",
      });
      return { plan, parent: null, branchDeleted: false };
    }
    const parent = this.get(branch.lineage.parentPlanId);
    if (o.expectedParentVersion !== undefined && parent.version !== o.expectedParentVersion)
      throw conflict(
        `parent is at version ${parent.version}, not ${o.expectedParentVersion}`,
        { currentVersion: parent.version },
        "VERSION_CONFLICT",
      );
    if (
      branch.lineage.parentVersion !== null &&
      branch.lineage.parentVersion !== parent.version &&
      !o.force
    )
      throw conflict(
        `branch is pinned to parent v${branch.lineage.parentVersion} but the parent is at v${parent.version}; merging would overwrite newer parent edits (pass force=true)`,
        { pinnedVersion: branch.lineage.parentVersion, parentVersion: parent.version },
        "PARENT_MOVED",
      );
    const kids = this.children(branchId);
    if (!o.keepBranch && kids.length)
      throw conflict(
        "branch has its own branches; use keepBranch=true or promote it first",
        { branchIds: kids.map((k) => k.id) },
        "IN_USE",
      );
    let mergedParent!: Plan;
    this.db.transaction(() => {
      mergedParent = this.write(parent.id, (p) => this.ctx.deps.mergeBranchIntoParent(p, branch), {
        actor,
        message: `merged branch '${branch.name}'`,
        skipChildren: [branchId],
      });
      if (!o.keepBranch) this.db.delete(plans).where(eq(plans.id, branchId)).run();
      // keepBranch: its patch is recomputed against the new parent (otherwise additions would apply twice).
      else
        this.write(branchId, (b) => b, {
          actor,
          message: "branch rebased after merge",
          recompute: true,
        });
    });
    return { plan: mergedParent, parent: mergedParent, branchDeleted: !o.keepBranch };
  }

  /** Other plans of the same household (used by compare). */
  siblings(id: string): Plan[] {
    const p = this.get(id);
    return this.db
      .select()
      .from(plans)
      .where(and(eq(plans.householdId, p.householdId), ne(plans.id, id)))
      .all()
      .map((r) => readPlanBody(r.body, r.schemaVersion));
  }
}
