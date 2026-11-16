/**
 * The editing store shared by Current Finances, Plans and the Plan editor.
 *
 *   base  = what the server (or, offline, this browser) last confirmed
 *   draft = what the user sees and edits
 *
 * Edits are entity-scoped ("household" = household + current finances, or "plan:<id>"), which is
 * also the unit of saving (one PUT with If-Match per entity) and of undo/redo. Entities are
 * updated immutably, so "dirty" is a reference comparison and undo restores exact objects.
 */
import type { CurrentFinances, GlideworthDocument, Household, Plan } from "@glideworth/core";
import { create } from "zustand";
import { toast } from "../../../components/ui/toaster";
import { useUi } from "../../../stores/ui";

let lastReadOnlyToast = 0;
function toastReadOnly() {
  if (Date.now() - lastReadOnlyToast < 4000) return;
  lastReadOnlyToast = Date.now();
  if (useUi.getState().readOnlyWhy === "plan") {
    toast({
      title: "This workspace is read-only",
      description: "Nothing was changed. The workspace owner can restore editing in Billing.",
    });
    return;
  }
  toast({
    title: "View only",
    description: "Your role lets you look and run simulations, not change the plan.",
  });
}

export type HouseholdEntity = { household: Household; finances: CurrentFinances };
export type EntityKey = "household" | `plan:${string}`;
export type SaveStatus =
  | "saved"
  | "pending"
  | "saving"
  | "invalid"
  | "error"
  | "conflict"
  | "local";

export interface EntitySave {
  status: SaveStatus;
  message?: string;
  /** On conflict: the server's current value and version. */
  theirs?: unknown;
  theirsVersion?: number;
  savedAt?: number;
  /** The server refused the save (HTTP 400/403): what it said, per field where it said so. */
  rejected?: { code: string; issues: { path: string; label: string; message: string }[] };
}

export interface HistoryEntry {
  entity: EntityKey;
  before: unknown;
  after: unknown;
  label: string;
  key?: string;
  group?: number;
  t: number;
}

export interface EditorState {
  ready: boolean;
  source: "api" | "sample";
  householdId: string;
  /** Version of the household row (If-Match for finances saves); null until fetched. */
  householdVersion: number | null;
  base: GlideworthDocument | null;
  draft: GlideworthDocument | null;
  past: HistoryEntry[];
  future: HistoryEntry[];
  save: Partial<Record<EntityKey, EntitySave>>;
  /** Bumped on every draft change (autosave + persistence subscribe to it). */
  rev: number;
}

const HISTORY_LIMIT = 300;
const COALESCE_MS = 1200;
let groupSeq = 0;

export const planKey = (id: string): EntityKey => `plan:${id}`;

export function getEntity(doc: GlideworthDocument, key: EntityKey): unknown {
  if (key === "household") return { household: doc.household, finances: doc.finances };
  const id = key.slice(5);
  return doc.plans.find((p) => p.id === id);
}

export function setEntity(
  doc: GlideworthDocument,
  key: EntityKey,
  value: unknown,
): GlideworthDocument {
  if (key === "household") {
    const v = value as HouseholdEntity;
    return { ...doc, household: v.household, finances: v.finances };
  }
  const id = key.slice(5);
  const plan = value as Plan;
  const exists = doc.plans.some((p) => p.id === id);
  return {
    ...doc,
    plans: exists ? doc.plans.map((p) => (p.id === id ? plan : p)) : [...doc.plans, plan],
  };
}

function sameEntity(a: GlideworthDocument, b: GlideworthDocument, key: EntityKey): boolean {
  if (key === "household") return a.household === b.household && a.finances === b.finances;
  return getEntity(a, key) === getEntity(b, key);
}

export function isDirty(s: Pick<EditorState, "base" | "draft">, key: EntityKey): boolean {
  if (!s.base || !s.draft) return false;
  return !sameEntity(s.base, s.draft, key);
}

export function dirtyKeys(s: Pick<EditorState, "base" | "draft">): EntityKey[] {
  if (!s.base || !s.draft) return [];
  const keys: EntityKey[] = ["household", ...s.draft.plans.map((p) => planKey(p.id))];
  return keys.filter((k) => isDirty(s, k));
}

function statusAfterChange(s: EditorState, draft: GlideworthDocument, key: EntityKey): EntitySave {
  const prev = s.save[key];
  if (prev?.status === "conflict") return prev;
  if (s.base && sameEntity(s.base, draft, key)) return { status: "saved", savedAt: prev?.savedAt };
  return { status: "pending" };
}

export const useEditorStore = create<EditorState>()(() => ({
  ready: false,
  source: "sample",
  householdId: "",
  householdVersion: null,
  base: null,
  draft: null,
  past: [],
  future: [],
  save: {},
  rev: 0,
}));

const set = useEditorStore.setState;
const get = useEditorStore.getState;

/** Initialise from a loaded workspace (and optionally restored local drafts). */
export function loadDocument(
  doc: GlideworthDocument,
  source: "api" | "sample",
  restored?: { draft: GlideworthDocument; keys: EntityKey[] },
) {
  const save: Partial<Record<EntityKey, EntitySave>> = {};
  for (const k of restored?.keys ?? [])
    save[k] = { status: "pending", message: "Restored unsaved changes" };
  set({
    ready: true,
    source,
    householdId: doc.household.id,
    householdVersion: null,
    base: doc,
    draft: restored?.draft ?? doc,
    past: [],
    future: [],
    save,
    rev: get().rev + 1,
  });
}

/**
 * The server sent a newer workspace. Entities without local edits adopt it; entities with
 * local edits keep the draft (a later save will 409 and offer a merge if they truly diverged).
 */
export function syncFromServer(doc: GlideworthDocument) {
  const s = get();
  if (!s.base || !s.draft || s.base === doc) return;
  let base = s.base;
  let draft = s.draft;
  const keys: EntityKey[] = ["household", ...doc.plans.map((p) => planKey(p.id))];
  for (const k of keys) {
    const serverValue = getEntity(doc, k);
    const dirty = isDirty(s, k);
    base = setEntity(base, k, serverValue);
    if (!dirty) draft = setEntity(draft, k, serverValue);
  }
  set({ base, draft, rev: s.rev + 1 });
}

/** Apply an edit to one entity. `coalesce` merges rapid edits of the same field into one undo step. */
export function editEntity<T>(
  key: EntityKey,
  update: (v: T) => T,
  label: string,
  coalesce?: string,
) {
  const s = get();
  if (!s.draft) return;
  if (useUi.getState().readOnly) {
    toastReadOnly();
    return;
  }
  const before = getEntity(s.draft, key) as T | undefined;
  if (before === undefined) return;
  const after = update(before);
  if (after === before || JSON.stringify(after) === JSON.stringify(before)) return;
  const draft = setEntity(s.draft, key, after);
  const now = Date.now();
  const last = s.past[s.past.length - 1];
  let past: HistoryEntry[];
  if (
    coalesce &&
    last &&
    last.entity === key &&
    last.key === coalesce &&
    now - last.t < COALESCE_MS
  ) {
    past = [...s.past.slice(0, -1), { ...last, after, t: now }];
  } else {
    past = [...s.past, { entity: key, before, after, label, key: coalesce, t: now }].slice(
      -HISTORY_LIMIT,
    );
  }
  set({
    draft,
    past,
    future: [],
    save: { ...s.save, [key]: statusAfterChange(s, draft, key) },
    rev: s.rev + 1,
  });
}

export const editPlan = (id: string, update: (p: Plan) => Plan, label: string, coalesce?: string) =>
  editEntity<Plan>(planKey(id), update, label, coalesce);

export const editHousehold = (
  update: (h: HouseholdEntity) => HouseholdEntity,
  label: string,
  coalesce?: string,
) => editEntity<HouseholdEntity>("household", update, label, coalesce);

/** Several entities in one undo step (e.g. life expectancy applied to every plan). */
export function editMany(
  edits: { key: EntityKey; update: (v: unknown) => unknown }[],
  label: string,
) {
  const group = ++groupSeq;
  const startLen = get().past.length;
  for (const e of edits) editEntity(e.key, e.update, label);
  const s = get();
  set({ past: s.past.map((h, i) => (i >= startLen ? { ...h, group } : h)) });
}

function applyHistory(direction: "undo" | "redo"): string | null {
  const s = get();
  if (!s.draft) return null;
  const from = direction === "undo" ? [...s.past] : [...s.future];
  const to = direction === "undo" ? [...s.future] : [...s.past];
  const first = from.pop();
  if (!first) return null;
  const batch = [first];
  while (first.group !== undefined && from.length && from[from.length - 1]!.group === first.group)
    batch.push(from.pop()!);
  let draft = s.draft;
  const save = { ...s.save };
  for (const e of batch) {
    if (getEntity(draft, e.entity) === undefined) continue; // plan deleted since
    draft = setEntity(draft, e.entity, direction === "undo" ? e.before : e.after);
    save[e.entity] = statusAfterChange(s, draft, e.entity);
  }
  to.push(...batch.reverse());
  set({
    draft,
    past: direction === "undo" ? from : to,
    future: direction === "undo" ? to : from,
    save,
    rev: s.rev + 1,
  });
  return first.label;
}

export const undo = () => applyHistory("undo");
export const redo = () => applyHistory("redo");

export function setSave(key: EntityKey, value: EntitySave) {
  set((s) => ({ save: { ...s.save, [key]: value } }));
}

/** A save succeeded. `sent` is the draft value we sent; `server` what came back. */
export function commitSaved(
  key: EntityKey,
  sent: unknown,
  server: unknown,
  status: SaveStatus = "saved",
) {
  const s = get();
  if (!s.base || !s.draft) return;
  const base = setEntity(s.base, key, server);
  let draft = s.draft;
  const current = getEntity(s.draft, key);
  const unchanged =
    key === "household"
      ? (current as HouseholdEntity).household === (sent as HouseholdEntity).household &&
        (current as HouseholdEntity).finances === (sent as HouseholdEntity).finances
      : current === sent;
  if (unchanged) draft = setEntity(draft, key, server);
  else if (key !== "household" && current) {
    // Edited while saving: keep the newer draft but carry the new version forward.
    const p = server as Plan;
    draft = setEntity(draft, key, {
      ...(current as Plan),
      version: p.version,
      updatedAt: p.updatedAt,
    });
  }
  set({
    base,
    draft,
    save: {
      ...s.save,
      [key]: { status: sameEntity(base, draft, key) ? status : "pending", savedAt: Date.now() },
    },
    rev: s.rev + 1,
  });
}

/** Replace the draft and base of an entity after resolving a conflict. */
export function resolveEntity(key: EntityKey, draftValue: unknown, baseValue: unknown) {
  const s = get();
  if (!s.base || !s.draft) return;
  const base = setEntity(s.base, key, baseValue);
  const draft = setEntity(s.draft, key, draftValue);
  set({
    base,
    draft,
    save: { ...s.save, [key]: { status: sameEntity(base, draft, key) ? "saved" : "pending" } },
    rev: s.rev + 1,
  });
}

/** A plan that already exists on the server (or locally, offline) joins the workspace. */
export function addPlanToWorkspace(plan: Plan) {
  const s = get();
  if (!s.base || !s.draft) return;
  set({
    base: setEntity(s.base, planKey(plan.id), plan),
    draft: setEntity(s.draft, planKey(plan.id), plan),
    rev: s.rev + 1,
  });
}

export function removePlanFromWorkspace(id: string) {
  const s = get();
  if (!s.base || !s.draft) return;
  const drop = (d: GlideworthDocument) => ({ ...d, plans: d.plans.filter((p) => p.id !== id) });
  const key = planKey(id);
  const { [key]: _gone, ...save } = s.save;
  set({
    base: drop(s.base),
    draft: drop(s.draft),
    past: s.past.filter((h) => h.entity !== key),
    future: s.future.filter((h) => h.entity !== key),
    save,
    rev: s.rev + 1,
  });
}

export function setHouseholdVersion(v: number | null) {
  set({ householdVersion: v });
}

/** Test helper. */
export function resetEditorStore() {
  set({
    ready: false,
    source: "sample",
    householdId: "",
    householdVersion: null,
    base: null,
    draft: null,
    past: [],
    future: [],
    save: {},
    rev: 0,
  });
}
