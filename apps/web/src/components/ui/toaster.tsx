/**
 * Minimal toast notifications: `toast({ title, description, action })` from anywhere, rendered by
 * one <Toaster /> in an aria-live region. Calm by default; 'negative' tone for failures.
 */
import { X } from "lucide-react";
import { create } from "zustand";
import { cn } from "../../lib/cn";
import { privateChildren } from "./private-text";

export interface ToastInput {
  title: string;
  description?: string;
  tone?: "neutral" | "positive" | "negative";
  action?: { label: string; onClick: () => void };
  /** ms; 0 keeps it until dismissed. */
  duration?: number;
}
interface ToastItem extends ToastInput {
  id: number;
}

const useToasts = create<{ items: ToastItem[] }>(() => ({ items: [] }));
let seq = 0;

export function toast(t: ToastInput): number {
  const id = ++seq;
  useToasts.setState((s) => ({ items: [...s.items.slice(-3), { ...t, id }] }));
  const ms = t.duration ?? (t.action ? 7000 : 4000);
  if (ms > 0) setTimeout(() => dismissToast(id), ms);
  return id;
}

export function dismissToast(id: number) {
  useToasts.setState((s) => ({ items: s.items.filter((x) => x.id !== id) }));
}

export function Toaster() {
  const items = useToasts((s) => s.items);
  return (
    <div
      aria-live="polite"
      data-app-chrome
      className="pointer-events-none fixed inset-x-0 bottom-[calc(56px+env(safe-area-inset-bottom))] z-[60] flex flex-col items-center gap-2 p-3 sm:items-end sm:p-4 md:bottom-0"
    >
      {items.map((t) => (
        <div
          key={t.id}
          role={t.tone === "negative" ? "alert" : "status"}
          className={cn(
            "pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-lg border bg-surface px-3.5 py-2.5 shadow-pop",
            "animate-[glideworth-toast-in_160ms_ease-out]",
            t.tone === "negative" ? "border-negative/40" : "border-border",
          )}
        >
          <span
            aria-hidden
            className={cn(
              "mt-1.5 size-1.5 shrink-0 rounded-full",
              t.tone === "negative"
                ? "bg-negative"
                : t.tone === "positive"
                  ? "bg-positive"
                  : "bg-accent",
            )}
          />
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-medium text-ink">{privateChildren(t.title)}</div>
            {t.description ? (
              <div className="mt-0.5 text-[12px] text-ink-2">{privateChildren(t.description)}</div>
            ) : null}
          </div>
          {t.action ? (
            <button
              type="button"
              className="shrink-0 rounded px-1.5 py-0.5 text-[12.5px] font-semibold text-accent hover:bg-accent-soft"
              onClick={() => {
                t.action!.onClick();
                dismissToast(t.id);
              }}
            >
              {t.action.label}
            </button>
          ) : null}
          <button
            type="button"
            aria-label="Dismiss"
            className="shrink-0 rounded p-[5px] text-ink-3 hover:bg-surface-2"
            onClick={() => dismissToast(t.id)}
          >
            <X className="size-3.5" />
          </button>
        </div>
      ))}
      <style>
        {
          "@keyframes glideworth-toast-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}"
        }
      </style>
    </div>
  );
}
