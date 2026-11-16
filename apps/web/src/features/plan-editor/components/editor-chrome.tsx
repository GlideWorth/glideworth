/**
 * Editing chrome shared by Finances, Plans and the Plan editor: the save indicator, the 409
 * conflict banner, undo/redo (buttons + Cmd/Ctrl+Z), and the frame that mounts autosave.
 * Toasts, confirmations and the command palette are mounted once, globally, by the app shell.
 */
import { useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Check,
  CloudOff,
  GitMerge,
  Loader2,
  Redo2,
  RotateCcw,
  Undo2,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { Button } from "../../../components/ui/button";
import { Kbd, modKey } from "../../../components/ui/kbd";
import { toast } from "../../../components/ui/toaster";
import { Tooltip } from "../../../components/ui/tooltip";
import { cn } from "../../../lib/cn";
import {
  type EntityKey,
  type EntitySave,
  isDirty,
  redo,
  undo,
  useEditorStore,
} from "../state/doc-store";
import { flushSaves, resolveConflict, useEditorBridge } from "../state/sync";

export function EditorFrame({ children }: { children: ReactNode }) {
  useEditorBridge();
  useUndoShortcuts();
  return <>{children}</>;
}

function runHistory(dir: "undo" | "redo") {
  const el = document.activeElement as HTMLElement | null;
  // Commit whatever is being typed first, so undo steps back from what the user sees.
  if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) el.blur();
  const label = dir === "undo" ? undo() : redo();
  if (label) toast({ title: `${dir === "undo" ? "Undid" : "Redid"}: ${label}`, duration: 1800 });
}

export function useUndoShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest("[data-native-undo]")) return;
      const k = e.key.toLowerCase();
      if (k === "z" && !e.shiftKey) {
        e.preventDefault();
        runHistory("undo");
      } else if ((k === "z" && e.shiftKey) || (k === "y" && e.ctrlKey && !e.metaKey)) {
        e.preventDefault();
        runHistory("redo");
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
}

export function UndoRedo() {
  const past = useEditorStore((s) => s.past);
  const future = useEditorStore((s) => s.future);
  const last = past[past.length - 1];
  const next = future[future.length - 1];
  return (
    <div className="flex items-center">
      <Tooltip
        content={
          last ? (
            <span>
              Undo {last.label} <Kbd className="ml-1">{modKey}Z</Kbd>
            </span>
          ) : (
            "Nothing to undo"
          )
        }
      >
        <Button
          variant="ghost"
          size="icon"
          aria-label={last ? `Undo ${last.label}` : "Undo"}
          disabled={!last}
          onClick={() => runHistory("undo")}
        >
          <Undo2 />
        </Button>
      </Tooltip>
      <Tooltip
        content={
          next ? (
            <span>
              Redo {next.label} <Kbd className="ml-1">{modKey}⇧Z</Kbd>
            </span>
          ) : (
            "Nothing to redo"
          )
        }
      >
        <Button
          variant="ghost"
          size="icon"
          aria-label={next ? `Redo ${next.label}` : "Redo"}
          disabled={!next}
          onClick={() => runHistory("redo")}
        >
          <Redo2 />
        </Button>
      </Tooltip>
    </div>
  );
}

/** Aggregated save state for the given entities ("household", "plan:<id>"). */
export function SaveIndicator({ keys }: { keys: EntityKey[] }) {
  const save = useEditorStore((s) => s.save);
  const dirtyCount = useEditorStore((s) => keys.filter((k) => isDirty(s, k)).length);
  const source = useEditorStore((s) => s.source);
  const qc = useQueryClient();
  const states = keys.map((k) => save[k]).filter(Boolean);
  const pick = (st: string) => states.find((s) => s?.status === st);
  const conflict = pick("conflict");
  const error = pick("error");
  const invalid = pick("invalid");
  const saving = pick("saving");
  const local = pick("local");
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((x) => x + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  let icon: ReactNode = <Check className="size-3.5" />;
  let text = "All changes saved";
  let tone = "text-ink-3";
  let detail: string | undefined;
  if (conflict) {
    icon = <AlertTriangle className="size-3.5" />;
    text = "Conflict";
    tone = "text-negative";
    detail = conflict.message;
  } else if (error) {
    icon = <CloudOff className="size-3.5" />;
    text = "Not saved";
    tone = "text-negative";
    detail = error.message;
  } else if (invalid && dirtyCount) {
    icon = <AlertTriangle className="size-3.5" />;
    text = invalid.message ?? "Fix errors to save";
    tone = "text-warning";
  } else if (saving) {
    icon = <Loader2 className="size-3.5 animate-spin" />;
    text = "Saving…";
  } else if (local || (source === "sample" && states.some((s) => s?.status === "local"))) {
    icon = <CloudOff className="size-3.5" />;
    text = source === "sample" ? "Saved in this browser" : "Saved in this browser only";
    detail = local?.message ?? "The API is offline, so edits are kept in this browser.";
  } else if (dirtyCount) {
    icon = <span className="size-1.5 rounded-full bg-ochre" />;
    text = "Unsaved changes";
    tone = "text-ink-2";
  } else {
    const at = Math.max(0, ...states.map((s) => s?.savedAt ?? 0));
    if (at) text = `Saved ${relative(at)}`;
  }
  return (
    <div className={cn("flex items-center gap-1.5 text-[12px]", tone)} aria-live="polite">
      <Tooltip content={detail ?? text}>
        <span className="inline-flex items-center gap-1.5">
          {icon}
          <span className="max-w-[220px] truncate">{text}</span>
        </span>
      </Tooltip>
      {error ? (
        <Button size="sm" variant="ghost" onClick={() => void flushSaves(qc)}>
          <RotateCcw /> Retry
        </Button>
      ) : null}
    </div>
  );
}

function relative(t: number): string {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  return new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function ConflictBanner({ entity, what }: { entity: EntityKey; what: string }) {
  const st = useEditorStore((s) => s.save[entity]);
  const qc = useQueryClient();
  if (st?.status === "invalid" && st.rejected)
    return <RejectedBanner rejected={st.rejected} what={what} />;
  if (st?.status !== "conflict") return null;
  const choose = (c: "theirs" | "mine" | "merge") => {
    const conflicts = resolveConflict(entity, c, qc);
    if (c === "merge")
      toast({
        title: conflicts.length
          ? `Merged, with ${conflicts.length} overlapping ${conflicts.length === 1 ? "edit" : "edits"}`
          : "Merged both sets of changes",
        description: conflicts.length
          ? `Where you both changed the same thing, your version was kept: ${conflicts.slice(0, 3).join(", ")}${conflicts.length > 3 ? "…" : ""}`
          : "Saving the combined version now.",
        duration: conflicts.length ? 9000 : 4000,
      });
    else if (c === "theirs")
      toast({
        title: "Loaded the latest saved version",
        description: "Your unsaved edits were discarded.",
      });
    else toast({ title: "Saving your version over theirs" });
  };
  return (
    <div
      role="alert"
      className="flex flex-col gap-3 rounded-[var(--radius-card)] border border-negative/30 bg-negative-soft/60 px-4 py-3 sm:flex-row sm:items-center"
    >
      <AlertTriangle className="size-4 shrink-0 text-negative" />
      <div className="min-w-0 flex-1 text-[13px]">
        <div className="font-semibold text-ink">{what} changed somewhere else</div>
        <div className="text-ink-2">
          {st.message} Your edits are safe here. Choose how to continue:
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="primary" onClick={() => choose("merge")}>
          <GitMerge /> Merge both
        </Button>
        <Button size="sm" onClick={() => choose("mine")}>
          Keep mine
        </Button>
        <Button size="sm" variant="ghost" onClick={() => choose("theirs")}>
          Reload theirs
        </Button>
      </div>
    </div>
  );
}

/** The server refused a save (400 validation, reserved key, or a view-only role): say what and where. */
function RejectedBanner({
  rejected,
  what,
}: {
  rejected: NonNullable<EntitySave["rejected"]>;
  what: string;
}) {
  return (
    <div
      role="alert"
      className="flex gap-3 rounded-[var(--radius-card)] border border-negative/30 bg-negative-soft/60 px-4 py-3"
    >
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-negative" />
      <div className="min-w-0 flex-1 text-[13px]">
        <div className="font-semibold text-ink">
          {rejected.code === "FORBIDDEN" ? `${what} is read-only for you` : `${what} was not saved`}
        </div>
        <ul className="mt-1 flex flex-col gap-0.5 text-ink-2">
          {rejected.issues.slice(0, 6).map((i) => (
            <li key={`${i.path}-${i.message}`}>
              {i.label ? <span className="font-medium text-ink">{i.label}: </span> : null}
              {i.message.charAt(0).toUpperCase() + i.message.slice(1)}
            </li>
          ))}
        </ul>
        {rejected.code !== "FORBIDDEN" ? (
          <div className="mt-1 text-[12px] text-ink-3">
            Correct it and Glideworth saves again automatically. Your edits stay in this browser
            until then.
          </div>
        ) : null}
      </div>
    </div>
  );
}
