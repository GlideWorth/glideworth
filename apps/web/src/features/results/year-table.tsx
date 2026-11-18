/** Year-by-year table with a column chooser and CSV export (respects today's/future money). */
import type { ProjectionResult, ValueBasis } from "@glideworth/core";
import { Columns3, Download } from "lucide-react";
import { Popover } from "radix-ui";
import { useMemo } from "react";
import { useChartPrefs } from "../../components/charts/chart-prefs";
import { Button } from "../../components/ui/button";
import { PartialYearToggle, useAnnualise } from "../../components/ui/partial-year";
import { ScrollRegion, Table, TBody, TD, TH, THead, TR } from "../../components/ui/table";
import { cn } from "../../lib/cn";
import { isPartialPeriod, periodLabel } from "../../lib/period";
import { useFormat } from "../../lib/workspace";
import {
  type ColumnDef,
  cellValue,
  downloadText,
  type EntityIndex,
  projectionCsv,
  tableColumns,
  yearCell,
} from "./model";

export function YearTable({
  result,
  basis,
  index,
  selected,
  onSelect,
  fileName = "glideworth-projection",
  maxHeight = 420,
}: {
  result: ProjectionResult;
  basis: ValueBasis;
  index: EntityIndex;
  selected?: number | null;
  onSelect?: (i: number) => void;
  fileName?: string;
  maxHeight?: number;
}) {
  const f = useFormat();
  const annualise = useAnnualise();
  const partial = result.periods.filter(isPartialPeriod);
  const all = useMemo(() => tableColumns(result, index), [result, index]);
  const chosen = useChartPrefs((s) => s.tableColumns);
  const setChosen = useChartPrefs((s) => s.setTableColumns);
  const cols = useMemo(() => {
    const ids = chosen ?? all.filter((c) => c.defaultOn).map((c) => c.id);
    const picked = all.filter((c) => ids.includes(c.id));
    return picked.length ? picked : all.filter((c) => c.defaultOn);
  }, [all, chosen]);

  const fmt = (c: ColumnDef, v: number | string | null) => {
    if (v === null || v === undefined) return "—";
    if (typeof v === "string") return v;
    if (c.kind === "money") return f.money(v);
    if (c.kind === "percent") return f.percent(v);
    return String(v);
  };

  const toggle = (id: string) => {
    const cur = cols.map((c) => c.id);
    setChosen(cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]);
  };
  const groups = [...new Set(all.map((c) => c.group))];

  return (
    <div className="flex flex-col">
      <div className="flex flex-wrap items-center justify-end gap-2 border-b border-border px-3 py-2">
        <span className="mr-auto text-[12px] text-ink-3">
          {result.periods.length} years · {cols.length} columns ·{" "}
          {basis === "real" ? "today's money" : "future money"}
        </span>
        <PartialYearToggle periods={result.periods} />
        <Popover.Root>
          <Popover.Trigger asChild>
            <Button size="sm" variant="secondary">
              <Columns3 /> Columns
            </Button>
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Content
              align="end"
              sideOffset={6}
              className="z-50 max-h-[60vh] w-[280px] overflow-y-auto rounded-lg border border-border bg-surface p-3 shadow-pop"
            >
              <div className="mb-2 flex items-center justify-between">
                <span className="text-[12.5px] font-semibold">Choose columns</span>
                <button
                  type="button"
                  className="text-[11.5px] text-ink-3 underline"
                  onClick={() => setChosen(null)}
                >
                  Reset
                </button>
              </div>
              {groups.map((g) => (
                <fieldset key={g} className="mb-2">
                  <legend className="eyebrow mb-1">{g}</legend>
                  {all
                    .filter((c) => c.group === g)
                    .map((c) => (
                      <label
                        key={c.id}
                        className="flex cursor-pointer items-center gap-2 py-0.5 text-[12.5px] pointer-coarse:min-h-11"
                      >
                        <input
                          type="checkbox"
                          className="accent-[var(--accent)]"
                          checked={cols.some((x) => x.id === c.id)}
                          onChange={() => toggle(c.id)}
                        />
                        {c.label}
                      </label>
                    ))}
                </fieldset>
              ))}
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
        <Button
          size="sm"
          variant="secondary"
          onClick={() =>
            downloadText(
              `${fileName}-${basis === "real" ? "todays-money" : "nominal"}.csv`,
              projectionCsv(result, cols, basis, f.currency),
            )
          }
        >
          <Download /> CSV
        </Button>
      </div>
      <ScrollRegion
        axis="y"
        label="Year by year projection table, scrolls down"
        style={{ maxHeight }}
      >
        <Table>
          <THead>
            <TR>
              {cols.map((c) => (
                <TH key={c.id} numeric={c.kind !== "text"} className="whitespace-nowrap">
                  {c.label}
                </TH>
              ))}
            </TR>
          </THead>
          <TBody>
            {result.periods.map((p) => (
              <TR
                key={p.index}
                onClick={onSelect ? () => onSelect(p.index) : undefined}
                className={cn(
                  onSelect && "cursor-pointer",
                  selected === p.index && "bg-accent-soft/60",
                )}
              >
                {cols.map((c) => {
                  const v = c.kind === "year" ? yearCell(p) : cellValue(c, p, basis, { annualise });
                  return (
                    <TD
                      key={c.id}
                      numeric
                      className={cn(
                        "whitespace-nowrap",
                        c.id === "netWorth" && p.status === "shortfall" && "text-negative",
                        c.kind === "year" && "text-left font-medium",
                      )}
                    >
                      {c.kind === "year" && isPartialPeriod(p) ? (
                        <span title={periodLabel(p, { annualise })}>{fmt(c, v)}</span>
                      ) : (
                        fmt(c, v)
                      )}
                    </TD>
                  );
                })}
              </TR>
            ))}
          </TBody>
        </Table>
      </ScrollRegion>
      {partial.length ? (
        <p className="border-t border-border px-3 py-2 text-[11.5px] text-ink-3">
          * Partial {partial.length === 1 ? "year" : "years"}:{" "}
          {partial.map((p) => periodLabel(p)).join("; ")}.{" "}
          {annualise
            ? "Income, spending, taxes and other money moved are shown scaled to a full year; balances are actual. The CSV has the actual amounts."
            : "Money moved in those years covers only those months; choose Annualised to compare them with full years."}
        </p>
      ) : null}
    </div>
  );
}
