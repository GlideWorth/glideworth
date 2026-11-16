/**
 * Bridges the editing store with the server:
 *   - loads/syncs the store from the workspace query,
 *   - autosaves dirty entities (debounced) with If-Match optimistic concurrency,
 *   - turns HTTP 409 into a conflict the UI resolves (reload / keep mine / merge),
 *   - keeps unsaved drafts in localStorage so nothing is lost on reload or while offline,
 *   - publishes saved state back to the workspace query so every page sees it.
 */
import { CurrentFinances, GlideworthDocument, Household, Plan } from "@glideworth/core";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { z } from "zod";
import { toast } from "../../../components/ui/toaster";
import { ApiRequestError, api, type FinancePath, isMissingRoute } from "../../../lib/api";
import { useWorkspace, type Workspace } from "../../../lib/workspace";
import {
  commitSaved,
  dirtyKeys,
  type EditorState,
  type EntityKey,
  getEntity,
  type HouseholdEntity,
  loadDocument,
  resolveEntity,
  setEntity,
  setHouseholdVersion,
  setSave,
  syncFromServer,
  useEditorStore,
} from "./doc-store";
import { deepEqual, merge3 } from "./merge";
import { validate } from "./validation";

const HouseholdBundle = z.object({ household: Household, finances: CurrentFinances });
const SAMPLE_KEY = "glideworth:sample-doc:v1";
const draftsKey = (hh: string) => `glideworth:drafts:v1:${hh}`;
const AUTOSAVE_MS = 900;
const RETRY_MS = 5_000;

/** Routes we found missing this session; we stop calling them and keep data locally. */
const missing = new Set<string>();

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function readJson<T>(key: string): T | null {
  try {
    const raw = storage()?.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown) {
  try {
    if (value === null) storage()?.removeItem(key);
    else storage()?.setItem(key, JSON.stringify(value));
  } catch {
    /* quota or privacy mode: drafts are best-effort */
  }
}

// --------------------------------------------------------------------------- local drafts

interface StoredDrafts {
  savedAt: string;
  household?: { value: HouseholdEntity; baseUpdatedAt: string | null };
  plans: Record<string, { value: Plan; baseVersion: number }>;
}

function persistDrafts(s: EditorState) {
  if (!s.base || !s.draft || s.source !== "api") return;
  const keys = dirtyKeys(s);
  if (!keys.length) return writeJson(draftsKey(s.householdId), null);
  const out: StoredDrafts = { savedAt: new Date().toISOString(), plans: {} };
  for (const k of keys) {
    if (k === "household")
      out.household = {
        value: getEntity(s.draft, k) as HouseholdEntity,
        baseUpdatedAt: s.base.household.updatedAt ?? s.base.finances.updatedAt ?? null,
      };
    else {
      const plan = getEntity(s.draft, k) as Plan;
      const base = getEntity(s.base, k) as Plan | undefined;
      if (base) out.plans[plan.id] = { value: plan, baseVersion: base.version };
    }
  }
  writeJson(draftsKey(s.householdId), out);
}

/** Re-apply drafts saved by a previous session when they still sit on the server's version. */
export function restoreDrafts(
  doc: GlideworthDocument,
): { draft: GlideworthDocument; keys: EntityKey[] } | undefined {
  const stored = readJson<StoredDrafts>(draftsKey(doc.household.id));
  if (!stored) return undefined;
  let draft = doc;
  const keys: EntityKey[] = [];
  let dropped = 0;
  if (stored.household) {
    const serverStamp = doc.household.updatedAt ?? doc.finances.updatedAt ?? null;
    const parsed = HouseholdBundle.safeParse(stored.household.value);
    if (parsed.success && stored.household.baseUpdatedAt === serverStamp) {
      draft = setEntity(draft, "household", parsed.data);
      keys.push("household");
    } else dropped++;
  }
  for (const [id, d] of Object.entries(stored.plans)) {
    const server = doc.plans.find((p) => p.id === id);
    const parsed = Plan.safeParse(d.value);
    if (server && parsed.success && server.version === d.baseVersion) {
      draft = setEntity(draft, `plan:${id}`, parsed.data);
      keys.push(`plan:${id}`);
    } else dropped++;
  }
  if (dropped)
    toast({
      title: "Some unsaved changes were out of date",
      description: "They were made against an older version and have been discarded.",
    });
  return keys.length ? { draft, keys } : undefined;
}

// --------------------------------------------------------------------------- publishing

function publish(qc: QueryClient) {
  const s = useEditorStore.getState();
  if (!s.base || !s.draft) return;
  let doc = s.base;
  // Entities kept locally (offline / route missing) are still what the user expects to see.
  for (const [k, v] of Object.entries(s.save))
    if (v?.status === "local")
      doc = setEntity(doc, k as EntityKey, getEntity(s.draft, k as EntityKey));
  qc.setQueryData<Workspace>(["workspace"], (ws) => (ws ? { ...ws, doc } : ws));
}

// --------------------------------------------------------------------------- saving

let flushing = false;
let flushAgain = false;

export async function flushSaves(qc: QueryClient): Promise<void> {
  if (flushing) {
    flushAgain = true;
    return;
  }
  flushing = true;
  try {
    for (const key of dirtyKeys(useEditorStore.getState())) await saveEntity(key);
    publish(qc);
  } finally {
    flushing = false;
    if (flushAgain) {
      flushAgain = false;
      void flushSaves(qc);
    }
  }
}

async function saveEntity(key: EntityKey) {
  const s = useEditorStore.getState();
  if (!s.base || !s.draft) return;
  const st = s.save[key];
  if (st?.status === "conflict" || st?.status === "saving") return;
  const value = getEntity(s.draft, key);
  const baseValue = getEntity(s.base, key);
  if (value === undefined) return;

  const issues = key === "household" ? validate(HouseholdBundle, value) : validate(Plan, value);
  if (issues.count) {
    setSave(key, {
      status: "invalid",
      message: `${issues.count} ${issues.count === 1 ? "problem" : "problems"} to fix before saving`,
    });
    return;
  }
  if (baseValue !== undefined && deepEqual(value, baseValue)) {
    resolveEntity(key, baseValue, baseValue);
    return;
  }

  if (s.source === "sample") {
    const stamp = new Date().toISOString();
    const stamped =
      key === "household"
        ? value
        : { ...(value as Plan), version: (value as Plan).version + 1, updatedAt: stamp };
    commitSaved(key, value, stamped, "local");
    writeJson(SAMPLE_KEY, useEditorStore.getState().base);
    return;
  }

  const routeId = key === "household" ? "household" : "plan";
  if (missing.has(routeId)) {
    setSave(key, { status: "local", message: localMessage(key) });
    return;
  }

  setSave(key, { status: "saving" });
  try {
    if (key === "household") {
      await saveHousehold(
        s.householdId,
        s.householdVersion,
        baseValue as HouseholdEntity,
        value as HouseholdEntity,
      );
    } else {
      const plan = value as Plan;
      const basePlan = baseValue as Plan;
      const saved = await api.updatePlan(plan.id, plan, basePlan.version);
      commitSaved(key, value, saved);
    }
  } catch (e) {
    if (e instanceof ApiRequestError && e.status === 409) {
      try {
        if (key === "household") {
          const theirs = await api.getHousehold(s.householdId);
          setSave(key, {
            status: "conflict",
            theirs: { household: theirs.household, finances: theirs.finances },
            theirsVersion: theirs.version,
            message: "Your finances were changed somewhere else.",
          });
        } else {
          const theirs = await api.getPlan((value as Plan).id);
          setSave(key, {
            status: "conflict",
            theirs,
            theirsVersion: theirs.version,
            message: `This plan was saved somewhere else (now version ${theirs.version}).`,
          });
        }
      } catch (inner) {
        setSave(key, { status: "error", message: errorText(inner) });
      }
    } else if (isMissingRoute(e)) {
      missing.add(routeId);
      setSave(key, { status: "local", message: localMessage(key) });
    } else if (e instanceof ApiRequestError && e.status === 402) {
      // The workspace turned read-only (trial or subscription ended) after the edit was made. The edit
      // stays on screen and in this browser's drafts; it is not silently dropped and not retried blindly.
      const message =
        "This workspace is read-only, so this change is kept here but not saved. The owner can restore editing in Billing; then make the change again to save it.";
      setSave(key, {
        status: "invalid",
        message,
        rejected: { code: e.code, issues: [{ path: "", label: "Read-only", message }] },
      });
    } else if (e instanceof ApiRequestError && (e.status === 400 || e.status === 403)) {
      // Refused, not failed: retrying cannot help, so show what the server said next to the edit.
      const rejected = describeRejection(e, value);
      setSave(key, {
        status: "invalid",
        message:
          e.status === 403
            ? "You have view-only access: changes cannot be saved"
            : `The server refused this change${rejected.issues.length ? `: ${rejected.issues[0]!.message}` : ""}`,
        rejected,
      });
    } else {
      setSave(key, { status: "error", message: errorText(e) });
    }
  }
}

/**
 * Turn a 400/403 from the API into field-level messages: VALIDATION carries Zod issues (paths like
 * ["income", 0, "amount", "value"], named here with the item's name), INVALID_TOKEN a reserved key
 * such as `__proto__`, FORBIDDEN the role that is missing.
 */
export function describeRejection(
  e: ApiRequestError,
  value: unknown,
): NonNullable<import("./doc-store").EntitySave["rejected"]> {
  if (e.status === 403)
    return {
      code: e.code,
      issues: [
        {
          path: "",
          label: "Access",
          message: "Your role is view-only. Ask the owner for editor access to make changes.",
        },
      ],
    };
  if (e.code === "INVALID_TOKEN" || /__proto__|constructor|prototype/.test(e.message))
    return {
      code: e.code,
      issues: [
        {
          path: "",
          label: "Reserved name",
          message:
            "A name or key uses a reserved word (__proto__, constructor or prototype). Rename it and try again.",
        },
      ],
    };
  const raw = Array.isArray(e.details)
    ? e.details
    : e.details &&
        typeof e.details === "object" &&
        Array.isArray((e.details as { issues?: unknown }).issues)
      ? (e.details as { issues: unknown[] }).issues
      : [];
  const issues = raw.flatMap((i) => {
    if (!i || typeof i !== "object") return [];
    const it = i as { path?: unknown[]; message?: string };
    const path = Array.isArray(it.path) ? it.path.map(String) : [];
    return [
      {
        path: path.join("."),
        label: labelForPath(value, path),
        message: it.message ?? "Invalid value",
      },
    ];
  });
  return {
    code: e.code,
    issues: issues.length ? issues : [{ path: "", label: "", message: e.message }],
  };
}

function labelForPath(value: unknown, path: string[]): string {
  const parts: string[] = [];
  let cur: unknown = value;
  for (const seg of path) {
    if (cur && typeof cur === "object") {
      const next = (cur as Record<string, unknown>)[seg];
      if (Array.isArray(cur) && next && typeof next === "object" && "name" in (next as object))
        parts.push(String((next as { name: unknown }).name));
      else if (!/^\d+$/.test(seg)) parts.push(seg.replace(/([A-Z])/g, " $1").toLowerCase());
      cur = next;
    } else if (!/^\d+$/.test(seg)) parts.push(seg);
  }
  return parts.join(" › ");
}

function localMessage(key: EntityKey) {
  return key === "household"
    ? "Kept in this browser — the server cannot store finance edits yet."
    : "Kept in this browser — the server cannot store this yet.";
}

function errorText(e: unknown): string {
  if (e instanceof ApiRequestError) return `${e.message} (HTTP ${e.status})`;
  if (e instanceof TypeError || (e instanceof ApiRequestError && e.status >= 502))
    return "Server unreachable — retrying automatically.";
  return e instanceof Error ? e.message : String(e);
}

/**
 * The API stores the household body and each finance item separately (no whole-finances PUT), so
 * a household save is a diff: PUT the body if it changed, then create / replace / delete items,
 * then move `asOf` through the balances route. Only the first write carries If-Match (that is
 * where a concurrent edit is detected); afterwards we re-read the record for its new version.
 * If a later step fails, the base is refreshed from the server so the next attempt diffs against
 * what actually got stored.
 */
const FINANCE_KINDS = [
  ["accounts", "accounts"],
  ["realAssets", "real-assets"],
  ["debts", "debts"],
] as const;

export function householdOps(base: HouseholdEntity, draft: HouseholdEntity) {
  const ops: {
    kind: "household" | "create" | "replace" | "delete" | "asOf";
    path?: FinancePath;
    id?: string;
    body?: unknown;
  }[] = [];
  if (!deepEqual(base.household, draft.household))
    ops.push({ kind: "household", body: draft.household });
  for (const [k, path] of FINANCE_KINDS) {
    const before = new Map<string, unknown>(base.finances[k].map((x) => [x.id, x]));
    const after = new Set(draft.finances[k].map((x) => x.id));
    for (const id of before.keys()) if (!after.has(id)) ops.push({ kind: "delete", path, id });
    for (const item of draft.finances[k]) {
      const old = before.get(item.id);
      if (!old) ops.push({ kind: "create", path, id: item.id, body: item });
      else if (!deepEqual(old, item)) ops.push({ kind: "replace", path, id: item.id, body: item });
    }
  }
  if (base.finances.asOf !== draft.finances.asOf)
    ops.push({ kind: "asOf", body: draft.finances.asOf });
  return ops;
}

/** Keep the user's local ordering when the server returns items in its own order. */
function orderLike<T extends { id: string }>(server: T[], local: T[]): T[] {
  const pos = new Map(local.map((x, i) => [x.id, i]));
  return [...server].sort((a, b) => (pos.get(a.id) ?? 1e9) - (pos.get(b.id) ?? 1e9));
}

async function saveHousehold(
  id: string,
  knownVersion: number | null,
  base: HouseholdEntity,
  draft: HouseholdEntity,
) {
  let version = knownVersion ?? (await api.getHousehold(id)).version;
  // Preferred: one atomic, validated write of the whole document. The stored array order IS the
  // display order, so reordering accounts / assets / debts persists with it.
  if (!missing.has("current-finances")) {
    try {
      const rec = await api.replaceCurrentFinances(
        id,
        { household: draft.household, finances: draft.finances },
        version,
      );
      setHouseholdVersion(rec.version);
      commitSaved("household", draft, { household: rec.household, finances: rec.finances });
      return;
    } catch (e) {
      if (!isMissingRoute(e)) throw e;
      missing.add("current-finances");
    }
  }
  const ops = householdOps(base, draft);
  let first = true;
  const v = () => {
    const x = first ? version : undefined;
    first = false;
    return x;
  };
  try {
    for (const op of ops) {
      if (op.kind === "household")
        version = (await api.replaceHousehold(id, op.body as Household, v())).version;
      else if (op.kind === "create") await api.createFinanceItem(id, op.path!, op.body, v());
      else if (op.kind === "replace")
        await api.replaceFinanceItem(id, op.path!, op.id!, op.body, v());
      else if (op.kind === "delete") await api.deleteFinanceItem(id, op.path!, op.id!, v());
      else await api.updateBalances(id, { asOf: op.body as string, recordSnapshot: false }, v());
    }
  } catch (e) {
    if (!first && !(e instanceof ApiRequestError && e.status === 409 && ops.length === 1)) {
      // Partially applied: re-base on the server so the retry only sends what is left.
      const rec = await api.getHousehold(id).catch(() => null);
      if (rec) {
        setHouseholdVersion(rec.version);
        resolveEntity("household", draft, { household: rec.household, finances: rec.finances });
      }
    }
    throw e;
  }
  let rec = await api.getHousehold(id);
  // Older servers: persist the display order separately when it differs from what was stored.
  const wanted = [
    ["accounts", "accounts", draft.finances.accounts, rec.finances.accounts],
    ["real-assets", "real-assets", draft.finances.realAssets, rec.finances.realAssets],
    ["debts", "debts", draft.finances.debts, rec.finances.debts],
  ] as const;
  for (const [, collection, mine, theirs] of wanted) {
    const ids = mine.map((x) => x.id);
    if (ids.length < 2 || ids.join() === theirs.map((x) => x.id).join()) continue;
    try {
      await api.reorderCollection(id, collection, ids);
      rec = await api.getHousehold(id);
    } catch (e) {
      if (!isMissingRoute(e)) throw e;
      break;
    }
  }
  setHouseholdVersion(rec.version);
  const finances = {
    ...rec.finances,
    accounts: orderLike(rec.finances.accounts, draft.finances.accounts),
    realAssets: orderLike(rec.finances.realAssets, draft.finances.realAssets),
    debts: orderLike(rec.finances.debts, draft.finances.debts),
  };
  commitSaved("household", draft, { household: rec.household, finances });
}

// --------------------------------------------------------------------------- conflict resolution

export type ConflictChoice = "theirs" | "mine" | "merge";

/** Resolve a 409. Returns the list of paths that needed a manual pick (merge only). */
export function resolveConflict(key: EntityKey, choice: ConflictChoice, qc: QueryClient): string[] {
  const s = useEditorStore.getState();
  const st = s.save[key];
  if (!s.base || !s.draft || st?.status !== "conflict") return [];
  const theirs = st.theirs;
  const mine = getEntity(s.draft, key);
  const base = getEntity(s.base, key);
  if (key === "household" && st.theirsVersion !== undefined) setHouseholdVersion(st.theirsVersion);
  let conflicts: string[] = [];
  if (choice === "theirs") resolveEntity(key, theirs, theirs);
  else if (choice === "mine") {
    const value =
      key === "household" ? mine : { ...(mine as Plan), version: (theirs as Plan).version };
    resolveEntity(key, value, theirs);
  } else {
    const merged = merge3(base, mine, theirs);
    conflicts = merged.conflicts;
    const value =
      key === "household"
        ? merged.value
        : { ...(merged.value as Plan), version: (theirs as Plan).version };
    resolveEntity(key, value, theirs);
  }
  void flushSaves(qc);
  return conflicts;
}

// --------------------------------------------------------------------------- the hook

/**
 * Mount once per editing page. Loads the store from the workspace, autosaves, persists drafts
 * and warns before leaving with unsaved changes.
 */
export function useEditorBridge() {
  const { data } = useWorkspace();
  const qc = useQueryClient();

  useEffect(() => {
    if (!data) return;
    const s = useEditorStore.getState();
    const fresh = !s.ready || s.householdId !== data.doc.household.id || s.source !== data.source;
    if (fresh) {
      if (data.source === "sample") {
        const local = readJson<unknown>(SAMPLE_KEY);
        const parsed = local ? safeDocument(local) : null;
        loadDocument(parsed ?? data.doc, "sample");
        if (parsed)
          qc.setQueryData<Workspace>(["workspace"], (ws) => (ws ? { ...ws, doc: parsed } : ws));
      } else {
        loadDocument(data.doc, "api", restoreDrafts(data.doc));
        api
          .getHousehold(data.doc.household.id)
          .then((r) => setHouseholdVersion(r.version))
          .catch(() => undefined);
      }
    } else if (data.source === "api") {
      syncFromServer(data.doc);
    } else if (s.base && data.doc !== s.base) {
      // Offline: the bundled sample was re-created; keep showing this browser's saved copy.
      publish(qc);
    }
  }, [data, qc]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let persistTimer: ReturnType<typeof setTimeout> | undefined;
    const unsub = useEditorStore.subscribe((s, prev) => {
      if (s.rev === prev.rev || s.draft === prev.draft) return;
      clearTimeout(persistTimer);
      persistTimer = setTimeout(() => persistDrafts(useEditorStore.getState()), 400);
      clearTimeout(timer);
      timer = setTimeout(() => void flushSaves(qc), AUTOSAVE_MS);
    });
    const onUnload = (e: BeforeUnloadEvent) => {
      const st = useEditorStore.getState();
      persistDrafts(st);
      const unsaved = dirtyKeys(st).some((k) => st.save[k]?.status !== "local");
      if (unsaved) e.preventDefault();
    };
    window.addEventListener("beforeunload", onUnload);
    // A save that failed because the server was unreachable retries by itself (and as soon as the
    // browser reports it is back online) instead of waiting for the next edit.
    const retryFailed = () => {
      const st = useEditorStore.getState();
      if (dirtyKeys(st).some((k) => st.save[k]?.status === "error")) void flushSaves(qc);
    };
    const retryTimer = setInterval(retryFailed, RETRY_MS);
    window.addEventListener("online", retryFailed);
    return () => {
      clearInterval(retryTimer);
      window.removeEventListener("online", retryFailed);
      unsub();
      clearTimeout(timer);
      clearTimeout(persistTimer);
      window.removeEventListener("beforeunload", onUnload);
      persistDrafts(useEditorStore.getState());
      void flushSaves(qc);
    };
  }, [qc]);
}

function safeDocument(raw: unknown): GlideworthDocument | null {
  const parsed = GlideworthDocument.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** Forget this browser's offline copy of the sample (used by "Reset sample"). */
export function clearLocalSample() {
  writeJson(SAMPLE_KEY, null);
}

/** After a structural change (plan created/deleted offline), persist and publish the workspace. */
export function afterStructuralChange(qc: QueryClient) {
  const s = useEditorStore.getState();
  if (s.source === "sample") writeJson(SAMPLE_KEY, s.base);
  publish(qc);
}
