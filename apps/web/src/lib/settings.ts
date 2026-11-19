/**
 * Durable user settings (UserSettings) persisted through the API. The workspace document carries a
 * copy, so formatting (currency/locale) updates everywhere the moment a setting is saved.
 * When the API is offline the settings live in this browser only, and the UI says so.
 */
import type { UserSettings, UserSettingsInput } from "@glideworth/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "../components/ui/toaster";
import { loadApi } from "./api-lazy";
import { isExplainedProblem } from "./api-problems";
import { DEMO_KEYS, isDemo } from "./demo";
import { useWorkspace, type Workspace } from "./workspace";

/** The settings schema (Zod), loaded on first use so it is not part of the app shell. */
const schema = () => import("@glideworth/core").then((m) => m.UserSettings);

/**
 * Used only for the moment before the workspace (which always carries settings) has loaded: every
 * field is absent, which every reader treats as "not set".
 */
const NOT_LOADED = {} as UserSettings;

const LOCAL_KEY = "glideworth:settings:v1";
/** The demo keeps its settings apart from this browser's own offline copy. */
const localKey = () => (isDemo() ? DEMO_KEYS.settings : LOCAL_KEY);

async function readLocal(): Promise<UserSettings | null> {
  try {
    const raw = localStorage.getItem(localKey());
    return raw ? (await schema()).parse(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}
function writeLocal(s: UserSettings) {
  try {
    localStorage.setItem(localKey(), JSON.stringify(s));
  } catch {
    /* best effort */
  }
}

/** Deep merge for plain objects (JSON Merge Patch semantics without null-deletes), then validated. */
export async function mergeSettings(
  base: UserSettings,
  patch: Record<string, unknown>,
): Promise<UserSettings> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    const cur = out[k];
    out[k] =
      v &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      cur &&
      typeof cur === "object" &&
      !Array.isArray(cur)
        ? { ...(cur as object), ...(v as object) }
        : v === null
          ? undefined
          : v;
  }
  return (await schema()).parse(out);
}

export function useSettings() {
  const ws = useWorkspace();
  const online = ws.data?.source === "api";
  const q = useQuery({
    queryKey: ["settings", online],
    enabled: !!ws.data,
    queryFn: async (): Promise<{ settings: UserSettings; persisted: "api" | "local" }> => {
      if (online) {
        try {
          return { settings: await (await loadApi()).getSettings(), persisted: "api" };
        } catch {
          /* fall through to local */
        }
      }
      return {
        settings: (await readLocal()) ?? ws.data?.doc.settings ?? (await schema()).parse({}),
        persisted: "local",
      };
    },
    staleTime: 60_000,
  });
  return {
    settings: q.data?.settings ?? ws.data?.doc.settings ?? NOT_LOADED,
    persisted: q.data?.persisted ?? (online ? "api" : "local"),
    isLoading: q.isLoading || ws.isLoading,
  };
}

/** Save a partial settings change (merge patch). Optimistic; rolls back and toasts on failure. */
export function useUpdateSettings() {
  const qc = useQueryClient();
  const ws = useWorkspace();
  const online = ws.data?.source === "api";
  const key = ["settings", online];
  return useMutation({
    mutationFn: async (patch: Record<string, unknown>) => {
      if (online) return (await loadApi()).patchSettings(patch);
      const cur =
        qc.getQueryData<{ settings: UserSettings }>(key)?.settings ?? (await schema()).parse({});
      const next = await mergeSettings(cur, patch);
      writeLocal(next);
      return next;
    },
    onMutate: async (patch) => {
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<{ settings: UserSettings; persisted: "api" | "local" }>(key);
      const base = prev?.settings ?? ws.data?.doc.settings ?? (await schema()).parse({});
      let next: UserSettings;
      try {
        next = await mergeSettings(base, patch);
      } catch {
        return { prev };
      }
      qc.setQueryData(key, { settings: next, persisted: online ? "api" : "local" });
      qc.setQueryData<Workspace>(["workspace"], (w) =>
        w ? { ...w, doc: { ...w.doc, settings: next } } : w,
      );
      return { prev };
    },
    onError: (e, _patch, ctx) => {
      if (ctx?.prev) {
        qc.setQueryData(key, ctx.prev);
        qc.setQueryData<Workspace>(["workspace"], (w) =>
          w ? { ...w, doc: { ...w.doc, settings: ctx.prev!.settings } } : w,
        );
      }
      if (!isExplainedProblem(e))
        toast({
          title: "Setting not saved",
          description: e instanceof Error ? e.message : String(e),
          tone: "negative",
        });
    },
    onSuccess: (saved) => {
      qc.setQueryData(key, { settings: saved, persisted: online ? "api" : "local" });
      qc.setQueryData<Workspace>(["workspace"], (w) =>
        w ? { ...w, doc: { ...w.doc, settings: saved } } : w,
      );
    },
  });
}

export type { UserSettingsInput };
