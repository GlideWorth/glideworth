/**
 * Income by tax rate: how much income fell in each marginal-rate band, every year (core
 * `incomeByTaxRate` on a full-trace projection, run in the analysis worker). A heatmap table: rows are
 * rates, columns are years.
 */
import type { SimulationInput, ValueBasis } from "@glideworth/core";
import { Loader2 } from "lucide-react";
import { useMemo, useState } from "react";
import { HeatTable } from "../../components/charts/heat-table";
import { ErrorState } from "../../components/charts/states";
import { Card, CardBody, CardHeader } from "../../components/ui/card";
import { Segmented } from "../../components/ui/segmented";
import { useFormat } from "../../lib/workspace";
import { useAnalysisQuery } from "../analysis/analysis-client";
import { jurisdictionLabel } from "./tax-notes";

export function IncomeByRateCard({
  input,
  basis,
  planKey,
  onPickYear,
}: {
  input: SimulationInput;
  basis: ValueBasis;
  planKey: string;
  onPickYear?: (year: number) => void;
}) {
  const f = useFormat();
  const [span, setSpan] = useState<"10" | "all">("10");
  const q = useAnalysisQuery<"incomeByTaxRate">(["income-by-rate", planKey, basis], {
    kind: "incomeByTaxRate",
    input,
    opts: { basis },
  });
  const m = q.data;
  const view = useMemo(() => {
    if (!m) return null;
    // Rates that hold any income at all, top rate first.
    const keep = m.columns
      .map((c, j) => ({ c, j, total: m.cells.reduce((s, row) => s + (row[j] ?? 0), 0) }))
      .filter((x) => x.total > 0.5)
      .reverse();
    const years = m.years.map((y, i) => ({ y, i })).slice(0, span === "10" ? 10 : undefined);
    const max = Math.max(1, ...years.flatMap(({ i }) => keep.map(({ j }) => m.cells[i]?.[j] ?? 0)));
    return { keep, years, max };
  }, [m, span]);
  return (
    <Card>
      <CardHeader
        eyebrow="Bands"
        title="Income by tax rate"
        actions={
          <Segmented
            size="sm"
            aria-label="Years shown"
            value={span}
            onChange={setSpan}
            options={[
              { value: "10", label: "10 years" },
              { value: "all", label: "Whole plan" },
            ]}
          />
        }
      />
      <CardBody className="flex flex-col gap-2">
        {q.isLoading ? (
          <div className="flex items-center gap-2 py-6 text-[12.5px] text-ink-3">
            <Loader2 className="size-4 animate-spin" /> Filling the bands for every year…
          </div>
        ) : q.isError ? (
          <ErrorState error={q.error} title="Bands could not be computed" />
        ) : m && view?.keep.length ? (
          <>
            <HeatTable
              caption="Income taxed at each marginal rate, by year"
              rowHeader="Rate"
              cellWidth={74}
              rows={view.keep.map(({ c }) => ({
                key: String(c.rate),
                label: f.percent(c.rate, (c.rate * 100) % 1 ? 1 : 0),
                sub: c.labels.slice(0, 2).join(", "),
              }))}
              cols={view.years.map(({ y }) => ({ key: String(y), label: y }))}
              text={(r, c) => {
                const v = m.cells[view.years[c]!.i]?.[view.keep[r]!.j] ?? 0;
                return v > 0.5 ? f.money(v, true) : "—";
              }}
              level={(r, c) => {
                const v = m.cells[view.years[c]!.i]?.[view.keep[r]!.j] ?? 0;
                return v > 0.5 ? v / view.max : null;
              }}
              onColumnClick={onPickYear ? (c) => onPickYear(view.years[c]!.y) : undefined}
            />
            <p className="text-[11.5px] text-ink-3">
              {m.jurisdictionId
                ? `${jurisdictionLabel(m.jurisdictionId) ?? m.jurisdictionId} bands. `
                : ""}
              The 0% row is income covered by allowances and deductions.{" "}
              {basis === "real" ? "Today's money." : "Future money."} Click a year to inspect it
              below.
            </p>
          </>
        ) : (
          <div className="py-4 text-[12.5px] text-ink-3">
            No banded income in this plan (flat-rate taxes have no bands).
          </div>
        )}
      </CardBody>
    </Card>
  );
}
