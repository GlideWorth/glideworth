/**
 * The last real chance-of-success run, kept in session storage so a reload of this tab still
 * shows it on the dashboard and on /chance. Example previews are not stored. A new tab starts empty.
 *
 * A run belongs to one household as it was when the run finished. The key carries the household id,
 * so another account in this tab never reads it, and the saved run carries a mark of the household's
 * contents (people, accounts, balances), so a reload after a balance update does not bring back a
 * figure computed from the old balances. The plan version covers edits to the plan itself.
 */
import type { MonteCarloResult } from "@glideworth/core";
import { DEMO_KEYS, isDemo } from "../../lib/demo";
import { useEditorStore } from "../plan-editor/state/doc-store";
import type { ChanceRun } from "./mc-store";

export interface SavedChance {
  planId: string;
  planVersion: number;
  result: MonteCarloResult;
  at: number;
  /** Mark of the household's contents when the run finished (absent in the demo's saved run). */
  householdMark?: string;
}

export function workspaceChanceKey(householdId: string, planId: string): string {
  return `glideworth:chance:v2:${householdId}:${planId}`;
}

/** JSON with object keys in a fixed order, so the same contents always give the same text. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

/** A short mark of what a Monte Carlo run reads from the household. Not a secret, only a comparison. */
export function householdMark(household: object, finances: unknown): string {
  // The save time is set by the server after the contents are already what the run read.
  const text = canonical({ household: { ...household, updatedAt: undefined }, finances });
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${text.length}.${(h >>> 0).toString(36)}`;
}

/** The household open in the editor: its id for the key and the mark of its current contents. */
function currentHousehold(): { id: string; mark: string } | null {
  const doc = useEditorStore.getState().draft;
  if (!doc) return null;
  return { id: doc.household.id, mark: householdMark(doc.household, doc.finances) };
}

export function parseSavedChance(raw: string | null): SavedChance | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as SavedChance;
    if (!v || typeof v.planId !== "string" || typeof v.planVersion !== "number" || !v.result)
      return null;
    if (typeof v.result.successRate !== "number" || typeof v.result.trials !== "number")
      return null;
    return v;
  } catch {
    return null;
  }
}

function writeBlob(key: string, saved: SavedChance): void {
  try {
    sessionStorage.setItem(key, JSON.stringify(saved));
  } catch {
    // A full result (every trial) can exceed the quota. The headline figures are enough to restore.
    try {
      sessionStorage.setItem(
        key,
        JSON.stringify({ ...saved, result: { ...saved.result, trialSummaries: [] } }),
      );
    } catch {
      // Blocked or still full: this page still has the run in memory.
    }
  }
}

/** Read the run saved for this plan, if the household is still as it was. In the demo there is one shared slot. */
export function readSavedChance(planId: string): SavedChance | null {
  try {
    if (isDemo()) {
      const saved = parseSavedChance(sessionStorage.getItem(DEMO_KEYS.chance));
      return saved && saved.planId === planId ? saved : null;
    }
    const hh = currentHousehold();
    if (!hh) return null;
    const saved = parseSavedChance(sessionStorage.getItem(workspaceChanceKey(hh.id, planId)));
    if (!saved || saved.planId !== planId || saved.householdMark !== hh.mark) return null;
    return saved;
  } catch {
    return null;
  }
}

/** Persist a finished run. Example previews stay in memory only. */
export function rememberChanceRun(planId: string, run: ChanceRun): void {
  if (run.example) return;
  const saved = { planId, planVersion: run.planVersion, result: run.result, at: run.at };
  if (isDemo()) return writeBlob(DEMO_KEYS.chance, saved);
  const hh = currentHousehold();
  if (!hh) return;
  writeBlob(workspaceChanceKey(hh.id, planId), { ...saved, householdMark: hh.mark });
}
