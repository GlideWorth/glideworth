/**
 * Plan lifecycle operations (create, duplicate, branch, archive, main, delete). Each goes through
 * the API when connected and degrades gracefully: offline they apply locally, and when a route
 * is missing they fall back to the nearest equivalent with a toast explaining what happened.
 */
import { Plan } from "@glideworth/core";
import type { QueryClient } from "@tanstack/react-query";
import { toast } from "../../components/ui/toaster";
import { api, isMissingRoute } from "../../lib/api";
import { newId } from "../plan-editor/state/defaults";
import {
  addPlanToWorkspace,
  editPlan,
  removePlanFromWorkspace,
  useEditorStore,
} from "../plan-editor/state/doc-store";
import { afterStructuralChange, flushSaves } from "../plan-editor/state/sync";

const offline = () => useEditorStore.getState().source === "sample";
const stamp = () => new Date().toISOString();

function local(plan: Plan): Plan {
  return Plan.parse({
    ...plan,
    version: plan.version || 1,
    createdAt: plan.createdAt ?? stamp(),
    updatedAt: stamp(),
  });
}

export async function createPlan(qc: QueryClient, plan: Plan): Promise<Plan> {
  if (offline()) {
    const p = local(plan);
    addPlanToWorkspace(p);
    afterStructuralChange(qc);
    return p;
  }
  const { version: _v, createdAt: _c, updatedAt: _u, ...body } = plan;
  const created = await api.createPlan(body);
  addPlanToWorkspace(created);
  afterStructuralChange(qc);
  return created;
}

function copyOf(src: Plan, name: string, extra: Partial<Plan> = {}): Plan {
  return Plan.parse({
    ...structuredClone(src),
    id: newId("plan"),
    name,
    isMain: false,
    status: "active",
    lineage: undefined,
    version: 0,
    createdAt: undefined,
    updatedAt: undefined,
    ...extra,
  });
}

export async function duplicatePlan(qc: QueryClient, src: Plan): Promise<Plan> {
  await flushSaves(qc);
  const name = `${src.name} (copy)`;
  if (!offline()) {
    try {
      const p = await api.duplicatePlan(src.id, name);
      addPlanToWorkspace(p);
      afterStructuralChange(qc);
      return p;
    } catch (e) {
      if (!isMissingRoute(e)) throw e;
    }
  }
  const current = useEditorStore.getState().draft?.plans.find((p) => p.id === src.id) ?? src;
  return createPlan(qc, copyOf(current, name));
}

/**
 * A branch follows its parent: the server stores a patch and re-materialises it when the parent
 * changes. Without branch support we create an independent copy and say so.
 */
export async function branchPlan(
  qc: QueryClient,
  src: Plan,
  name = `${src.name} — what if`,
): Promise<Plan> {
  await flushSaves(qc);
  if (!offline()) {
    try {
      const p = await api.createBranch(src.id, { name, description: `Branch of “${src.name}”.` });
      addPlanToWorkspace(p);
      afterStructuralChange(qc);
      return p;
    } catch (e) {
      if (!isMissingRoute(e)) throw e;
    }
  }
  const p = await createPlan(
    qc,
    copyOf(src, name, {
      description: `Copy of “${src.name}” (branching needs the server; this copy won’t follow later changes).`,
    }),
  );
  toast({
    title: "Created an independent copy",
    description: "Live branches need the API; this copy won’t follow changes to the original.",
  });
  return p;
}

export async function setPlanStatus(
  qc: QueryClient,
  plan: Plan,
  action: "archive" | "unarchive" | "set-main",
) {
  await flushSaves(qc);
  const s = useEditorStore.getState();
  const current = s.base?.plans.find((p) => p.id === plan.id) ?? plan;
  const applyLocally = () => {
    if (action === "set-main") {
      for (const p of s.draft?.plans ?? [])
        if (p.isMain && p.id !== plan.id)
          editPlan(p.id, (x) => ({ ...x, isMain: false }), "Change main plan");
      editPlan(plan.id, (x) => ({ ...x, isMain: true, status: "active" }), "Make main plan");
    } else
      editPlan(
        plan.id,
        (x) => ({ ...x, status: action === "archive" ? "archived" : "active" }),
        action === "archive" ? "Archive plan" : "Restore plan",
      );
  };
  if (offline()) return applyLocally();
  try {
    const updated = await api.planLifecycle(plan.id, action, current.version);
    addPlanToWorkspace(updated);
    if (action === "set-main") await qc.invalidateQueries({ queryKey: ["workspace"] });
    afterStructuralChange(qc);
  } catch (e) {
    if (isMissingRoute(e)) applyLocally();
    else throw e;
  }
}

export async function deletePlan(qc: QueryClient, plan: Plan) {
  if (offline()) {
    removePlanFromWorkspace(plan.id);
    afterStructuralChange(qc);
    return;
  }
  try {
    await api.deletePlan(plan.id);
    removePlanFromWorkspace(plan.id);
    afterStructuralChange(qc);
  } catch (e) {
    if (!isMissingRoute(e)) throw e;
    await setPlanStatus(qc, plan, "archive");
    toast({
      title: "Archived instead",
      description: "This server can’t delete plans yet, so the plan was archived.",
    });
  }
}

/**
 * Fold a branch's changes into its parent (the parent gets a new version; the branch is removed)
 * or promote it to an independent plan. Needs the server: offline there is no lineage to merge.
 */
export async function mergeBranch(
  qc: QueryClient,
  branch: Plan,
  strategy: "into-parent" | "promote",
): Promise<Plan> {
  await flushSaves(qc);
  if (offline()) throw new Error("Merging a branch needs the Glideworth server.");
  const out = await api.mergeBranch(branch.id, { strategy });
  if (out.branchDeleted) removePlanFromWorkspace(branch.id);
  addPlanToWorkspace(out.plan);
  // Other branches of the parent are re-materialised server-side: reload everything.
  await qc.invalidateQueries({ queryKey: ["workspace"] });
  afterStructuralChange(qc);
  return out.plan;
}
