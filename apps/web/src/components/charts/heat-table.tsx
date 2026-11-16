/**
 * A heatmap as a real table: every cell is readable text (screen readers, copy-paste, print) and its
 * background encodes the value with the theme tokens, so it follows light and dark mode without a
 * chart runtime. Used for strategies × metrics and income by tax rate.
 */
import type { ReactNode } from "react";
import { cn } from "../../lib/cn";
import { ScrollRegion } from "../ui/table";

export interface HeatTableProps {
  caption: string;
  rowHeader: string;
  rows: { key: string; label: ReactNode; sub?: ReactNode }[];
  cols: { key: string; label: ReactNode; sub?: ReactNode }[];
  /** Display text per cell. */
  text: (r: number, c: number) => ReactNode;
  /** 0..1 strength per cell (null: no colour). */
  level: (r: number, c: number) => number | null;
  /** 'good' tints toward the accent (spruce); 'scale' uses ochre for a neutral magnitude. */
  tone?: "good" | "scale";
  /** Cells to outline (e.g. the best value per column). */
  highlight?: (r: number, c: number) => boolean;
  /** Cell min width in px (columns scroll horizontally on narrow screens). */
  cellWidth?: number;
  stickyFirst?: boolean;
  onColumnClick?: (c: number) => void;
}

export function HeatTable({
  caption,
  rowHeader,
  rows,
  cols,
  text,
  level,
  tone = "scale",
  highlight,
  cellWidth = 92,
  stickyFirst = true,
  onColumnClick,
}: HeatTableProps) {
  const colour = tone === "good" ? "var(--accent)" : "var(--ochre)";
  return (
    <ScrollRegion label={`${caption}, scrolls sideways if it does not fit`}>
      <table className="w-full border-separate border-spacing-[3px] text-[12px]">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            <th
              scope="col"
              className={cn(
                "bg-surface px-2 py-1.5 text-left text-[11px] font-semibold tracking-wider text-ink-3 uppercase",
                stickyFirst && "sticky left-0 z-[1]",
              )}
            >
              {rowHeader}
            </th>
            {cols.map((c, ci) => (
              <th
                key={c.key}
                scope="col"
                style={{ minWidth: cellWidth }}
                className="px-1.5 py-1.5 text-right align-bottom text-[11px] font-semibold text-ink-2"
              >
                {onColumnClick ? (
                  <button
                    type="button"
                    className="hover:text-accent hover:underline"
                    onClick={() => onColumnClick(ci)}
                  >
                    {c.label}
                  </button>
                ) : (
                  c.label
                )}
                {c.sub ? <div className="font-normal text-ink-3">{c.sub}</div> : null}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, ri) => (
            <tr key={r.key}>
              <th
                scope="row"
                className={cn(
                  "bg-surface px-2 py-1.5 text-left align-top font-medium text-ink",
                  stickyFirst && "sticky left-0 z-[1]",
                )}
              >
                {r.label}
                {r.sub ? <div className="text-[11px] font-normal text-ink-3">{r.sub}</div> : null}
              </th>
              {cols.map((c, ci) => {
                const l = level(ri, ci);
                const strong = l !== null && l > 0.62;
                return (
                  <td
                    key={c.key}
                    className={cn(
                      "num rounded-[5px] px-2 py-1.5 text-right",
                      l === null ? "text-ink-3" : strong ? "font-semibold" : "text-ink",
                      highlight?.(ri, ci) && "ring-2 ring-accent ring-inset",
                    )}
                    style={
                      l === null
                        ? { background: "var(--surface-2)" }
                        : {
                            background: `color-mix(in oklab, ${colour} ${Math.round(8 + l * 62)}%, var(--surface))`,
                            color: strong
                              ? tone === "good"
                                ? "var(--accent-ink)"
                                : "var(--ink)"
                              : undefined,
                          }
                    }
                  >
                    {text(ri, ci)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </ScrollRegion>
  );
}
