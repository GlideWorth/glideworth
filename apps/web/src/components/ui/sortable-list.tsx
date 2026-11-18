/**
 * Drag-to-reorder list without a dependency. Pointer events (mouse, pen, touch) on a grip handle;
 * the handle is also a keyboard control: ↑/↓ move the item, and a live region announces it.
 */
import { GripVertical } from "lucide-react";
import {
  type KeyboardEvent,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useRef,
  useState,
} from "react";
import { cn } from "../../lib/cn";

export interface SortableHandleProps {
  onPointerDown: (e: ReactPointerEvent<HTMLButtonElement>) => void;
  onKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => void;
  "aria-label": string;
  "aria-describedby": string;
}

interface DragState {
  from: number;
  to: number;
  startY: number;
  dy: number;
  rects: DOMRect[];
}

export function SortableList<T>({
  items,
  getId,
  getLabel,
  onReorder,
  renderItem,
  "aria-label": ariaLabel,
  className,
}: {
  items: T[];
  getId: (t: T) => string;
  getLabel: (t: T) => string;
  onReorder: (from: number, to: number) => void;
  renderItem: (item: T, ctx: { index: number; handle: ReactNode; dragging: boolean }) => ReactNode;
  "aria-label": string;
  className?: string;
}) {
  const listRef = useRef<HTMLOListElement>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [announce, setAnnounce] = useState("");
  const hintId = useRef(`sortable-hint-${Math.random().toString(36).slice(2, 8)}`).current;

  const start = (index: number, e: ReactPointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    const els = Array.from(listRef.current?.children ?? []).filter((c) => c.tagName === "LI");
    const rects = els.map((el) => el.getBoundingClientRect());
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
    // The live drag lives in a local (not a state updater) so committing happens exactly once,
    // even when React double-invokes updaters in StrictMode.
    let d: DragState = { from: index, to: index, startY: e.clientY, dy: 0, rects };
    setDrag(d);
    const move = (ev: PointerEvent) => {
      const dy = ev.clientY - d.startY;
      const self = d.rects[d.from]!;
      const center = self.top + self.height / 2 + dy;
      let to = d.from;
      d.rects.forEach((r, i) => {
        const mid = r.top + r.height / 2;
        if (i < d.from && center < mid) to = Math.min(to, i);
        if (i > d.from && center > mid) to = Math.max(to, i);
      });
      d = { ...d, dy, to };
      setDrag(d);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      setDrag(null);
      if (d.to !== d.from) {
        onReorder(d.from, d.to);
        setAnnounce(
          `Moved ${getLabel(items[d.from]!)} to position ${d.to + 1} of ${items.length}.`,
        );
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  const key = (index: number, e: KeyboardEvent<HTMLButtonElement>) => {
    const to = e.key === "ArrowUp" ? index - 1 : e.key === "ArrowDown" ? index + 1 : null;
    if (to === null || to < 0 || to >= items.length) return;
    e.preventDefault();
    onReorder(index, to);
    setAnnounce(`Moved ${getLabel(items[index]!)} to position ${to + 1} of ${items.length}.`);
    const target = e.currentTarget;
    requestAnimationFrame(() => {
      const handles = listRef.current?.querySelectorAll<HTMLButtonElement>("[data-sort-handle]");
      (handles?.[to] ?? target).focus();
    });
  };

  const offsetFor = (i: number): number => {
    if (!drag) return 0;
    if (i === drag.from) return drag.dy;
    const h = drag.rects[drag.from]!.height + 8;
    if (drag.from < drag.to && i > drag.from && i <= drag.to) return -h;
    if (drag.from > drag.to && i < drag.from && i >= drag.to) return h;
    return 0;
  };

  return (
    <>
      <ol ref={listRef} aria-label={ariaLabel} className={cn("flex flex-col gap-2", className)}>
        {items.map((item, i) => {
          const dragging = drag?.from === i;
          const handle = (
            <button
              type="button"
              data-sort-handle
              onPointerDown={(e) => start(i, e)}
              onKeyDown={(e) => key(i, e)}
              aria-label={`Reorder ${getLabel(item)} (position ${i + 1} of ${items.length})`}
              aria-describedby={hintId}
              className="flex h-8 w-6 shrink-0 cursor-grab touch-none pointer-coarse:size-11 items-center justify-center rounded text-ink-3 hover:bg-surface-2 hover:text-ink active:cursor-grabbing"
            >
              <GripVertical className="size-4" />
            </button>
          );
          return (
            <li
              key={getId(item)}
              style={{
                transform: drag ? `translateY(${offsetFor(i)}px)` : undefined,
                transition: drag && !dragging ? "transform 160ms ease" : undefined,
                zIndex: dragging ? 10 : undefined,
                position: "relative",
              }}
              className={cn(dragging && "opacity-95 [&>*]:shadow-pop")}
            >
              {renderItem(item, { index: i, handle, dragging })}
            </li>
          );
        })}
      </ol>
      <p id={hintId} className="sr-only">
        Drag, or press the up and down arrow keys, to change the order.
      </p>
      <p aria-live="polite" className="sr-only">
        {announce}
      </p>
    </>
  );
}

export function moveItem<T>(xs: T[], from: number, to: number): T[] {
  const out = [...xs];
  const [it] = out.splice(from, 1);
  out.splice(to, 0, it!);
  return out;
}
