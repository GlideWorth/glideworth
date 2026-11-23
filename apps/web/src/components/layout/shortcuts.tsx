/**
 * Global keyboard shortcuts and the "?" help overlay. Single keys and "g then x" sequences are
 * ignored while typing in a field, inside an open dialog, or with a modifier held.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { X } from "lucide-react";
import { Dialog as D } from "radix-ui";
import { Fragment, useEffect, useRef } from "react";
import { useUi } from "../../stores/ui";
import { recordSnapshot, toggleBasis, toggleHideAmounts, toggleTheme } from "../command/actions";
import { Kbd, modKey } from "../ui/kbd";

export const GO_TO: { key: string; to: string; label: string }[] = [
  { key: "d", to: "/", label: "Dashboard" },
  { key: "f", to: "/finances", label: "Current finances" },
  { key: "h", to: "/progress", label: "Progress (history)" },
  { key: "p", to: "/plans", label: "Plans" },
  { key: "e", to: "/plans/active", label: "Plan editor" },
  { key: "r", to: "/results", label: "Results" },
  { key: "c", to: "/chance", label: "Chance of success" },
  { key: "o", to: "/cashflow", label: "Cash flow" },
  { key: "t", to: "/taxes", label: "Taxes" },
  { key: "m", to: "/compare", label: "Compare" },
  { key: "i", to: "/insights", label: "Insights" },
  { key: "x", to: "/import", label: "Import & export" },
  { key: "s", to: "/settings", label: "Settings" },
];

interface ShortcutGroup {
  title: string;
  items: { keys: string[][]; label: string }[];
}

export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: "Anywhere",
    items: [
      { keys: [[modKey, "K"]], label: "Search pages, plans and actions" },
      { keys: [["?"]], label: "Show keyboard shortcuts" },
      { keys: [["B"]], label: "Toggle today's / future money" },
      { keys: [["⇧", "D"]], label: "Toggle light / dark theme" },
      { keys: [["⇧", "H"]], label: "Hide or show amounts (for screen sharing)" },
      { keys: [["⇧", "S"]], label: "Record a progress snapshot" },
      { keys: [["["]], label: "Collapse or expand the sidebar" },
      { keys: [["Esc"]], label: "Close a dialog, menu or drawer" },
    ],
  },
  {
    title: "Go to",
    items: GO_TO.map((g) => ({ keys: [["G", g.key.toUpperCase()]], label: g.label })),
  },
  {
    title: "Editing",
    items: [
      { keys: [[modKey, "Z"]], label: "Undo" },
      { keys: [[modKey, "⇧", "Z"]], label: "Redo" },
      { keys: [["Enter"]], label: "Run the highlighted command" },
    ],
  },
];

/** True when the key event should not trigger single-key shortcuts. */
export function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || typeof el.closest !== "function") return false;
  if (el.isContentEditable) return true;
  return !!el.closest(
    'input, textarea, select, [contenteditable="true"], [role="combobox"], [role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]',
  );
}

export function useGlobalShortcuts() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const pending = useRef<{ key: string; at: number } | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTypingTarget(e.target)) return;
      const ui = useUi.getState();
      const k = e.key;
      const g = pending.current;
      if (g && Date.now() - g.at < 1200) {
        pending.current = null;
        const hit = GO_TO.find((x) => x.key === k.toLowerCase());
        if (hit) {
          e.preventDefault();
          void navigate({ to: hit.to });
          return;
        }
      }
      if (k === "g" || k === "G") {
        pending.current = { key: "g", at: Date.now() };
        return;
      }
      if (k === "?") {
        e.preventDefault();
        ui.setShortcutsOpen(!ui.shortcutsOpen);
      } else if (k === "b" || k === "B") {
        if (e.shiftKey && k === "B") return;
        e.preventDefault();
        toggleBasis();
      } else if (k === "D" && e.shiftKey) {
        e.preventDefault();
        toggleTheme();
      } else if (k === "H" && e.shiftKey) {
        e.preventDefault();
        toggleHideAmounts();
      } else if (k === "S" && e.shiftKey) {
        e.preventDefault();
        void recordSnapshot(qc);
      } else if (k === "[") {
        e.preventDefault();
        ui.toggleSidebar();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate, qc]);
}

export function ShortcutsOverlay() {
  const open = useUi((s) => s.shortcutsOpen);
  const setOpen = useUi((s) => s.setShortcutsOpen);
  return (
    <D.Root open={open} onOpenChange={setOpen}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-[55] bg-black/30" />
        <D.Content className="fixed top-1/2 left-1/2 z-[56] flex max-h-[86dvh] w-[min(94vw,720px)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-pop">
          <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
            <div>
              <D.Title className="display text-[19px] font-semibold">Keyboard shortcuts</D.Title>
              <D.Description className="mt-0.5 text-[12.5px] text-ink-2">
                Single keys work when you are not typing in a field.
              </D.Description>
            </div>
            <D.Close className="rounded-md p-1 text-ink-3 hover:bg-surface-2" aria-label="Close">
              <X className="size-4" />
            </D.Close>
          </div>
          <div className="grid min-h-0 gap-x-8 gap-y-5 overflow-y-auto px-5 py-4 sm:grid-cols-2">
            {SHORTCUT_GROUPS.map((g) => (
              <section key={g.title} className={g.title === "Go to" ? "sm:row-span-2" : undefined}>
                <h3 className="eyebrow mb-2">{g.title}</h3>
                <dl className="flex flex-col">
                  {g.items.map((it) => (
                    <div
                      key={it.label}
                      className="flex items-center justify-between gap-3 border-b border-border/70 py-1.5 last:border-b-0"
                    >
                      <dt className="text-[13px] text-ink-2">{it.label}</dt>
                      <dd className="flex shrink-0 items-center gap-1">
                        {it.keys.map((combo, ci) => (
                          <Fragment key={combo.join("+")}>
                            {ci > 0 ? <span className="text-[11px] text-ink-3">or</span> : null}
                            {combo.map((key, i) => (
                              <Fragment key={key}>
                                {i > 0 && combo[0] === "G" ? (
                                  <span className="text-[10.5px] text-ink-3">then</span>
                                ) : null}
                                <Kbd>{key}</Kbd>
                              </Fragment>
                            ))}
                          </Fragment>
                        ))}
                      </dd>
                    </div>
                  ))}
                </dl>
              </section>
            ))}
          </div>
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}
