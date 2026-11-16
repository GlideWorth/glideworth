/**
 * Writing a whole workspace: used by guided setup, sample households, ProjectionLab import and
 * restore-from-backup. One atomic server call (POST /api/v1/import, format "glideworth"): when the
 * workspace already has a household, the new document takes over its id and replaces it in a
 * single transaction, so a failure never leaves you with half of each.
 */
import type { GlideworthDocument } from "@glideworth/core";
import type { QueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import type { Workspace } from "../../lib/workspace";
import { usePrefs } from "../../stores/prefs";
import { useUi } from "../../stores/ui";
import { resetEditorStore } from "../plan-editor/state/doc-store";

/** Give a document a different household id (plans and snapshots follow). */
export function rehome(doc: GlideworthDocument, householdId: string): GlideworthDocument {
  if (doc.household.id === householdId) return doc;
  return {
    ...doc,
    household: { ...doc.household, id: householdId },
    plans: doc.plans.map((p) => ({ ...p, householdId })),
    progress: doc.progress.map((s) => ({ ...s, householdId })),
  };
}

const SAMPLE_KEY = "glideworth:sample-doc:v1";

export interface PersistOutcome {
  where: "server" | "browser";
  householdId: string;
}

/**
 * Save `doc` as THE workspace. Online: replaces the current household atomically (or creates the
 * first one). Offline: keeps it in this browser so the app is still explorable.
 */
export async function persistWorkspace(
  qc: QueryClient,
  doc: GlideworthDocument,
  /** 'merge': update the household and the plans in `doc`, keep every other plan and snapshot. */
  opts: { mode?: "replace" | "merge" } = {},
): Promise<PersistOutcome> {
  const ws = qc.getQueryData<Workspace>(["workspace"]);
  const online = ws?.source === "api" || !!ws?.firstRun;
  // A new workspace makes any "review your import" checklist stale (callers that import set a
  // fresh one afterwards).
  usePrefs.setState({ importChecklist: null });
  if (!online) {
    try {
      localStorage.setItem(SAMPLE_KEY, JSON.stringify(doc));
    } catch {
      /* quota: still show it for this session */
    }
    resetEditorStore();
    qc.setQueryData<Workspace>(["workspace"], (w) => (w ? { ...w, doc } : w));
    return { where: "browser", householdId: doc.household.id };
  }
  const existing = ws?.source === "api" ? ws.doc.household.id : undefined;
  const target = existing ? rehome(doc, existing) : doc;
  await api.importDocument({
    format: "glideworth",
    data: target,
    mode: existing ? (opts.mode ?? "replace") : "create",
  });
  try {
    localStorage.removeItem(`glideworth:drafts:v1:${target.household.id}`);
  } catch {
    /* ignore */
  }
  resetEditorStore();
  const main = target.plans.find((p) => p.isMain) ?? target.plans[0];
  if (main) useUi.getState().setActivePlan(main.id);
  await qc.invalidateQueries({ queryKey: ["workspace"] });
  await qc.invalidateQueries({ queryKey: ["settings"] });
  await qc.invalidateQueries({ queryKey: ["snapshots"] });
  return { where: "server", householdId: target.household.id };
}
