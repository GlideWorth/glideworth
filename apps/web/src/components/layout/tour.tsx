/**
 * Dismissible guided tour of the main areas. Each stop points at a real element (marked with
 * data-tour) and falls back to a centred card when the element is not on screen (e.g. phones).
 * Escape or "Skip tour" ends it; it can be restarted from the command palette or Settings.
 */
import { ArrowLeft, ArrowRight, X } from "lucide-react";
import {
  type CSSProperties,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { usePrefs } from "../../stores/prefs";
import { Button } from "../ui/button";
import { Kbd, modKey } from "../ui/kbd";

interface Stop {
  id: string;
  /** Candidate anchors, first visible wins. */
  anchors: string[];
  title: string;
  body: string;
}

export const TOUR: Stop[] = [
  {
    id: "welcome",
    anchors: [],
    title: "Welcome to Glideworth",
    body: "A one-minute tour of where things live. You can leave at any point and restart it from Settings.",
  },
  {
    id: "overview",
    anchors: ['[data-tour="nav-Overview"]', '[data-tour="bottom-nav"]'],
    title: "Overview: where you stand",
    body: "The dashboard, your current finances (accounts, property, debts) and Progress, your real net-worth history.",
  },
  {
    id: "planning",
    anchors: ['[data-tour="nav-Planning"]', '[data-tour="menu-button"]'],
    title: "Planning: what happens next",
    body: "Plans hold income, spending, milestones and savings flows. Branch a plan to explore a what-if without touching the original.",
  },
  {
    id: "analysis",
    anchors: ['[data-tour="nav-Analysis"]', '[data-tour="menu-button"]'],
    title: "Analysis: how robust is it",
    body: "Year-by-year results, chance of success across a thousand markets, cash flow, taxes, side-by-side comparisons and plain-language insights.",
  },
  {
    id: "plan",
    anchors: ['[data-tour="plan-switcher"]'],
    title: "The active plan",
    body: "Every analysis page follows this plan. Switch it here at any time.",
  },
  {
    id: "basis",
    anchors: ['[data-tour="basis"]'],
    title: "Today's money or future money",
    body: "Show every chart and table adjusted for inflation, or as the actual amounts in that year. Press B to flip.",
  },
  {
    id: "search",
    anchors: ['[data-tour="search"]'],
    title: "Find anything",
    body: `Press ${modKey} K to jump to any page or plan, add an account or event, or run a simulation. Press ? for every shortcut.`,
  },
  {
    id: "data",
    anchors: ['[data-tour="nav-data"]', '[data-tour="menu-button"]'],
    title: "Your data, your machine",
    body: "Import from ProjectionLab or CSV, download a full backup, and connect AI assistants under Settings.",
  },
];

function visibleRect(selectors: string[]): DOMRect | null {
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (!el) continue;
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < window.innerHeight) return r;
  }
  return null;
}

export function Tour() {
  const tour = usePrefs((s) => s.tour);
  const set = usePrefs((s) => s.set);
  const active = tour !== null && tour !== "done";
  const index = active
    ? Math.max(
        0,
        TOUR.findIndex((s) => s.id === tour),
      )
    : -1;
  const stop = index >= 0 ? TOUR[index] : undefined;
  const [rect, setRect] = useState<DOMRect | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  const go = useCallback(
    (i: number) => set({ tour: i >= TOUR.length ? "done" : TOUR[Math.max(0, i)]!.id }),
    [set],
  );
  const end = useCallback(() => set({ tour: "done" }), [set]);

  useLayoutEffect(() => {
    if (!stop) return;
    const measure = () => setRect(stop.anchors.length ? visibleRect(stop.anchors) : null);
    measure();
    window.addEventListener("resize", measure);
    const t = setInterval(measure, 400);
    return () => {
      window.removeEventListener("resize", measure);
      clearInterval(t);
    };
  }, [stop]);

  useEffect(() => {
    if (!stop) return;
    cardRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") end();
      else if (e.key === "ArrowRight") go(index + 1);
      else if (e.key === "ArrowLeft") go(index - 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [stop, index, go, end]);

  if (!stop) return null;

  const W = Math.min(340, window.innerWidth - 24);
  let style: CSSProperties;
  if (rect) {
    const below = rect.bottom + 12 + 180 < window.innerHeight;
    const right = rect.right + 12 + W < window.innerWidth && rect.width < 260;
    if (right)
      style = {
        left: rect.right + 12,
        top: Math.max(12, Math.min(rect.top, window.innerHeight - 220)),
      };
    else if (below)
      style = {
        top: rect.bottom + 10,
        left: Math.max(12, Math.min(rect.left, window.innerWidth - W - 12)),
      };
    else
      style = {
        bottom: window.innerHeight - rect.top + 10,
        left: Math.max(12, Math.min(rect.left, window.innerWidth - W - 12)),
      };
  } else style = { top: "50%", left: "50%", transform: "translate(-50%, -50%)" };

  return (
    <div className="no-print" data-app-chrome>
      <div aria-hidden className="pointer-events-none fixed inset-0 z-[70] bg-black/20" />
      {rect ? (
        <div
          aria-hidden
          className="pointer-events-none fixed z-[71] rounded-lg ring-2 ring-accent transition-all duration-200"
          style={{
            left: rect.left - 4,
            top: rect.top - 4,
            width: rect.width + 8,
            height: rect.height + 8,
            boxShadow: "0 0 0 9999px rgb(0 0 0 / 0.18)",
          }}
        />
      ) : null}
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="false"
        aria-labelledby="tour-title"
        aria-describedby="tour-body"
        tabIndex={-1}
        className="fixed z-[72] flex flex-col gap-2 rounded-xl border border-border bg-surface p-4 shadow-pop outline-none"
        style={{ ...style, width: W }}
      >
        <div className="flex items-center justify-between gap-2">
          <span className="eyebrow">
            Tour · {index + 1} of {TOUR.length}
          </span>
          <button
            type="button"
            onClick={end}
            aria-label="End the tour"
            className="rounded p-1 text-ink-3 hover:bg-surface-2 hover:text-ink"
          >
            <X className="size-3.5" />
          </button>
        </div>
        <h2 id="tour-title" className="display text-[17px] leading-snug font-semibold">
          {stop.title}
        </h2>
        <p id="tour-body" className="text-[13px] leading-relaxed text-ink-2">
          {stop.body}
        </p>
        <div className="mt-1 flex items-center gap-2">
          <div className="flex gap-1" aria-hidden>
            {TOUR.map((s, i) => (
              <span
                key={s.id}
                className={`h-1 rounded-full transition-all ${i === index ? "w-4 bg-accent" : "w-1.5 bg-surface-3"}`}
              />
            ))}
          </div>
          <div className="ml-auto flex items-center gap-1.5">
            {index > 0 ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => go(index - 1)}
                aria-label="Previous stop"
              >
                <ArrowLeft />
              </Button>
            ) : (
              <Button size="sm" variant="ghost" onClick={end}>
                Skip tour
              </Button>
            )}
            <Button size="sm" variant="primary" onClick={() => go(index + 1)}>
              {index === TOUR.length - 1 ? "Finish" : "Next"}{" "}
              {index < TOUR.length - 1 ? <ArrowRight /> : null}
            </Button>
          </div>
        </div>
        <p className="text-[11px] text-ink-3">
          <Kbd>←</Kbd> <Kbd>→</Kbd> to move, <Kbd>Esc</Kbd> to leave
        </p>
      </div>
    </div>
  );
}
