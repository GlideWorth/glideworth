/**
 * Persist plan variants: as a branch of the base plan, or applied to the base plan itself.
 * Through the API when connected (If-Match concurrency, branches created via
 * POST /plans/{id}/branches); in the offline sample, only in this session's workspace cache.
 */
import type { Plan } from "@glideworth/core";
import type { QueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import type { Workspace } from "../../lib/workspace";

export async function saveAsBranch(
  qc: QueryClient,
  ws: Workspace,
  base: Plan,
  body: Plan,
  name: string,
  description: string,
): Promise<string> {
  if (ws.source === "api") {
    const branch = await api.createBranch(base.id, { name, description });
    const { lineage: _l, version: _v, createdAt: _c, updatedAt: _u, ...rest } = body;
    const next = await api.updatePlan(
      branch.id,
      {
        ...rest,
        id: branch.id,
        householdId: branch.householdId,
        name,
        description,
        isMain: false,
        lineage: branch.lineage,
      },
      branch.version,
    );
    await qc.invalidateQueries({ queryKey: ["workspace"] });
    return next.id;
  }
  const id = `plan-whatif-${Date.now().toString(36)}`;
  const { lineage: _l, ...rest } = body;
  qc.setQueryData<Workspace>(["workspace"], (w) =>
    w
      ? {
          ...w,
          doc: {
            ...w.doc,
            plans: [...w.doc.plans, { ...rest, id, name, description, isMain: false, version: 0 }],
          },
        }
      : w,
  );
  return id;
}

export async function applyToPlan(
  qc: QueryClient,
  ws: Workspace,
  base: Plan,
  body: Plan,
): Promise<void> {
  if (ws.source === "api") {
    const { createdAt: _c, updatedAt: _u, ...rest } = body;
    await api.updatePlan(
      base.id,
      { ...rest, id: base.id, lineage: base.lineage, version: base.version },
      base.version,
    );
    await qc.invalidateQueries({ queryKey: ["workspace"] });
    return;
  }
  qc.setQueryData<Workspace>(["workspace"], (w) =>
    w
      ? {
          ...w,
          doc: {
            ...w.doc,
            plans: w.doc.plans.map((p) =>
              p.id === base.id ? { ...body, id: base.id, version: base.version + 1 } : p,
            ),
          },
        }
      : w,
  );
}
