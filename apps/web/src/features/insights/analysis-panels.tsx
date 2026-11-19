/**
 * More analysis on the Insights page, computed in the analysis worker: the strategies × metrics
 * heatmap (core `strategyMetricsMatrix`).
 */
import type { Plan, SimulationInput, StrategyMetricsMatrix } from "@glideworth/core";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, Play } from "lucide-react";
import { useState } from "react";
import { HeatTable } from "../../components/charts/heat-table";
import { ErrorState } from "../../components/charts/states";
import { Button } from "../../components/ui/button";
import { Card, CardBody, CardHeader } from "../../components/ui/card";
import { SwitchField } from "../../components/ui/switch";
import { cn } from "../../lib/cn";
import { useFormat } from "../../lib/workspace";
import { useAnalysisQuery } from "../analysis/analysis-client";

const planKey = (plan: Plan, input: SimulationInput) =>
  `${plan.id}:${plan.version}:${input.finances.asOf}`;

// ------------------------------------------------------------------------ strategies × metrics

export function StrategyMatrixPanel({ input, plan }: { input: SimulationInput; plan: Plan }) {
  const f = useFormat();
  const qc = useQueryClient();
  const [success, setSuccess] = useState(true);
  const [started, setStarted] = useState(false);
  const q = useAnalysisQuery<"strategyMatrix">(
    ["strategy-matrix", planKey(plan, input), success],
    { kind: "strategyMatrix", input, opts: { successRate: success } },
    started,
  );
  const m = q.data;
  return (
    <Card>
      <CardHeader
        eyebrow="Compare strategies"
        title="Strategies × outcomes"
        actions={
          q.isFetching ? null : (
            <Button
              size="sm"
              variant={m ? "ghost" : "primary"}
              onClick={() => {
                if (m) void qc.invalidateQueries({ queryKey: ["analysis", "strategy-matrix"] });
                setStarted(true);
              }}
            >
              <Play /> {m ? "Run again" : "Compare"}
            </Button>
          )
        }
      />
      <CardBody className="flex flex-col gap-3">
        <p className="text-[12.5px] text-ink-2">
          Each withdrawal and tax strategy Glideworth can model for your household, scored on
          lifetime tax, what your heirs keep, the chance of success and final net worth. Greener is
          better in each column; the outlined cell is the best.
        </p>
        {!started ? (
          <SwitchField
            label="Include the chance of success"
            hint="Runs Monte Carlo for every strategy; slower."
            checked={success}
            onCheckedChange={setSuccess}
          />
        ) : null}
        {q.isFetching ? (
          <div className="flex items-center gap-2 py-4 text-[12.5px] text-ink-3">
            <Loader2 className="size-4 animate-spin" /> Simulating every strategy in the background…
          </div>
        ) : q.isError ? (
          <ErrorState error={q.error} title="Strategies could not be compared" />
        ) : m ? (
          <MatrixTable m={m} money={(v) => f.money(v, true)} pct={(v) => f.percent(v, 0)} />
        ) : null}
      </CardBody>
    </Card>
  );
}

function MatrixTable({
  m,
  money,
  pct,
}: {
  m: StrategyMetricsMatrix;
  money: (v: number) => string;
  pct: (v: number) => string;
}) {
  const fmt = (j: number, v: number | null) =>
    v === null ? "—" : m.columns[j]!.unit === "share" ? pct(v) : money(v);
  const delta = (j: number, d: number | null, score: number | null) => {
    if (d === null || Math.abs(d) < (m.columns[j]!.unit === "share" ? 0.005 : 0.5)) return null;
    const better = m.columns[j]!.better === "higher" ? d > 0 : d < 0;
    // On a strongly tinted cell the tint already says "better"; keep the text readable.
    const tinted = score !== null && score > 0.62;
    return (
      <div
        className={cn(
          "text-[10.5px] font-normal",
          tinted ? "opacity-85" : better ? "text-positive" : "text-negative",
        )}
      >
        {d > 0 ? "+" : "−"}
        {m.columns[j]!.unit === "share" ? pct(Math.abs(d)) : money(Math.abs(d))}
      </div>
    );
  };
  return (
    <>
      <HeatTable
        caption="Strategies scored on each outcome"
        rowHeader="Strategy"
        tone="good"
        cellWidth={110}
        rows={m.rows.map((r) => ({
          key: r.id,
          label: r.label,
          sub:
            r.status !== "ok"
              ? r.status === "unsupported"
                ? "Not modelled for this plan"
                : r.error
              : undefined,
        }))}
        cols={m.columns.map((c) => ({
          key: c.id,
          label: c.label,
          sub: c.better === "lower" ? "lower is better" : "higher is better",
        }))}
        // oxlint-disable-next-line react/no-unstable-nested-components -- render-prop callback, not a component
        text={(r, c) => (
          <>
            {fmt(c, m.rows[r]!.values[c] ?? null)}
            {r > 0 ? delta(c, m.rows[r]!.deltas[c] ?? null, m.rows[r]!.scores[c] ?? null) : null}
          </>
        )}
        level={(r, c) => m.rows[r]!.scores[c] ?? null}
        highlight={(r, c) => m.best[c] === m.rows[r]!.id}
      />
      <p className="text-[11.5px] text-ink-3">
        The first row is your plan as it stands; differences are against it. Today&rsquo;s money.
      </p>
    </>
  );
}
