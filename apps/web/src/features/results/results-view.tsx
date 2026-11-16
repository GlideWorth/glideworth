import { Link } from "@tanstack/react-router";
import { AlertTriangle, Flag, Table2 } from "lucide-react";
import { useMemo, useState } from "react";
import {
  type ChartKind,
  type ProjectionMode,
  useChartPrefs,
} from "../../components/charts/chart-prefs";
import { ChartLoading, EmptyState, ErrorState } from "../../components/charts/states";
import { Page } from "../../components/layout/app-shell";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardBody, CardHeader } from "../../components/ui/card";
import { PartialYearToggle, useAnnualise } from "../../components/ui/partial-year";
import { Segmented } from "../../components/ui/segmented";
import { Select } from "../../components/ui/select";
import { Stat } from "../../components/ui/stat";
import { formatMonth } from "../../lib/format";
import { hasPartialPeriods } from "../../lib/period";
import { DismissDatasetNotice, isDatasetReplaced } from "./dataset-notice";
import { conv, KIND_LABEL, MODE_LABEL, rangePresets } from "./model";
import { ProjectionChart, type ZoomRange } from "./projection-chart";
import { useAnalysis } from "./use-analysis";
import { YearDetailSheet } from "./year-detail";
import { YearTable } from "./year-table";

export function ChartControls({ people }: { people: { id: string; name: string }[] }) {
  const mode = useChartPrefs((s) => s.projectionMode);
  const setMode = useChartPrefs((s) => s.setProjectionMode);
  const kind = useChartPrefs((s) => s.chartKind);
  const setKind = useChartPrefs((s) => s.setChartKind);
  const axis = useChartPrefs((s) => s.axis);
  const setAxis = useChartPrefs((s) => s.setAxis);
  const patterns = useChartPrefs((s) => s.patterns);
  const setPatterns = useChartPrefs((s) => s.setPatterns);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select
        aria-label="Chart mode"
        value={mode}
        onValueChange={(v) => setMode(v as ProjectionMode)}
        options={(Object.keys(MODE_LABEL) as ProjectionMode[]).map((m) => ({
          value: m,
          label: MODE_LABEL[m],
        }))}
        className="w-[180px]"
      />
      <Segmented
        aria-label="Chart type"
        size="sm"
        value={kind}
        onChange={(v) => setKind(v as ChartKind)}
        options={(Object.keys(KIND_LABEL) as ChartKind[]).map((k) => ({
          value: k,
          label: KIND_LABEL[k],
        }))}
      />
      <Select
        aria-label="Horizontal axis"
        value={people.some((p) => p.id === axis) ? axis : "year"}
        onValueChange={setAxis}
        options={[
          { value: "year", label: "Axis: calendar year" },
          ...people.map((p) => ({ value: p.id, label: `Axis: ${p.name}'s age` })),
        ]}
        className="w-[170px]"
      />
      <label
        className="flex cursor-pointer items-center gap-1.5 text-[12px] text-ink-2"
        title="Add patterns to filled areas (colour-blind / print friendly)"
      >
        <input
          type="checkbox"
          className="accent-[var(--accent)]"
          checked={patterns}
          onChange={(e) => setPatterns(e.target.checked)}
        />
        Patterns
      </label>
    </div>
  );
}

export function ResultsView() {
  const { plan, doc, input, result, ms, isLoading, error, index, basis, f } = useAnalysis();
  const annualise = useAnnualise();
  const mode = useChartPrefs((s) => s.projectionMode);
  const kind = useChartPrefs((s) => s.chartKind);
  const axis = useChartPrefs((s) => s.axis);
  const [selected, setSelected] = useState<number | null>(null);
  const [range, setRange] = useState<ZoomRange | null>(null);
  const [rangeId, setRangeId] = useState("all");
  const presets = useMemo(() => (result ? rangePresets(result) : []), [result]);
  const last = result?.periods.at(-1);
  const primary = doc?.household.people.find((p) => p.role === "primary");
  const ewWarn = result?.warnings.filter((w) => w.code === "EARLY_WITHDRAWAL_PENALTY") ?? [];
  const warns = result?.warnings.filter((w) => w.severity !== "info") ?? [];

  return (
    <Page
      title="Results"
      description={
        plan
          ? `Deterministic projection of “${plan.name}”. Hover or tap for a breakdown; select any year to open it.`
          : undefined
      }
      actions={
        ms !== undefined && result ? (
          <Badge>{`${result.periods.length} years · ${ms.toFixed(0)} ms in a worker`}</Badge>
        ) : null
      }
    >
      {result && last ? (
        <div className="grid grid-cols-2 gap-x-4 sm:gap-x-6 gap-y-4 rounded-[var(--radius-card)] border border-border bg-surface px-5 py-4 shadow-card md:grid-cols-4">
          <Stat
            label="Plan outcome"
            value={result.summary.success ? "Fully funded" : "Shortfall"}
            tone={result.summary.success ? "positive" : "negative"}
            sub={
              result.summary.firstShortfallYear
                ? `First shortfall in ${result.summary.firstShortfallYear}`
                : "Every year’s spending is covered"
            }
          />
          <Stat
            label="Retirement"
            value={result.summary.retirementYear ?? "—"}
            sub={primary ? `${primary.name}’s retirement milestone` : undefined}
          />
          <Stat
            label={`Net worth in ${last.year}`}
            value={f.money(conv(last, last.totals.netWorth, basis, "netWorth"), true)}
            sub={basis === "real" ? "Today's money" : "Future money"}
          />
          <Stat
            label="Lifetime taxes"
            value={f.money(
              basis === "real" ? result.summary.lifetimeTaxesReal : result.summary.lifetimeTaxes,
              true,
            )}
            sub={plan?.tax.mode === "flat" ? "Flat-rate estimate" : "Estimated"}
          />
        </div>
      ) : isLoading ? (
        // Holds the place of the summary while the worker runs, so the chart below does not jump down
        // when the figures arrive (layout shift of about 0.3 on a phone otherwise).
        <div
          aria-hidden
          className="min-h-[198px] rounded-[var(--radius-card)] border border-border bg-surface shadow-card md:min-h-[130px] lg:min-h-[103px]"
        />
      ) : null}

      <Card>
        <CardHeader
          eyebrow="Projection"
          title={MODE_LABEL[mode]}
          actions={
            <Badge tone="neutral">{basis === "real" ? "Today's money" : "Future money"}</Badge>
          }
        />
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2">
          <ChartControls people={index.people} />
          {result ? <PartialYearToggle periods={result.periods} /> : null}
          {presets.length > 1 ? (
            <div className="max-w-full overflow-x-auto">
              <Segmented
                aria-label="Display range"
                size="sm"
                value={rangeId}
                onChange={(id) => {
                  const p = presets.find((x) => x.id === id);
                  setRangeId(id);
                  if (p) setRange({ start: p.start, end: p.end });
                }}
                options={presets.map((p) => ({ value: p.id, label: p.label }))}
              />
            </div>
          ) : null}
        </div>
        <CardBody className="pt-3">
          {isLoading ? <ChartLoading height={400} /> : null}
          {error ? <ErrorState error={error} title="Simulation failed" /> : null}
          {!isLoading && !error && !result ? (
            <EmptyState
              title="No plan to show yet"
              action={
                <Button asChild size="sm">
                  <Link to="/plans">Create a plan</Link>
                </Button>
              }
            />
          ) : null}
          {result ? (
            <ProjectionChart
              result={result}
              basis={basis}
              locale={f.locale}
              currency={f.currency}
              index={index}
              plan={plan}
              mode={mode}
              kind={kind}
              axis={axis}
              selected={selected}
              onSelectYear={setSelected}
              range={range}
              onRangeChange={() => setRangeId("custom")}
              height={420}
              annualise={annualise}
            />
          ) : null}
          {result ? (
            <p className="mt-1 text-[11.5px] text-ink-3">
              Drag the slider or hold Shift and scroll to zoom. Flags mark milestones; triangles
              mark income starting or ending; diamonds mark one-off costs.
              {hasPartialPeriods(result.periods)
                ? " Years marked * are partial (the plan starts or ends part-way through them)."
                : ""}
            </p>
          ) : null}
        </CardBody>
      </Card>

      {result ? (
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
          <Card>
            <CardHeader eyebrow="Timeline" title="Milestones" />
            <CardBody className="flex flex-col gap-2">
              {result.milestones.length === 0 ? (
                <div className="text-ink-3">No milestones in this plan.</div>
              ) : null}
              {result.milestones.map((m) => (
                <button
                  type="button"
                  key={m.milestoneId}
                  className="flex items-center justify-between gap-2 rounded-md px-1 py-0.5 text-left hover:bg-surface-2 disabled:hover:bg-transparent"
                  disabled={m.periodIndex === null}
                  onClick={() => m.periodIndex !== null && setSelected(m.periodIndex)}
                >
                  <span className="flex items-center gap-2">
                    <Flag
                      className={
                        m.status === "reached" ? "size-3.5 text-ochre" : "size-3.5 text-ink-3"
                      }
                    />
                    <span>{m.name}</span>
                  </span>
                  <span className="num text-ink-2">
                    {m.month ? formatMonth(m.month, f.locale) : "Never"}
                    {m.month && primary && m.ages[primary.id] !== undefined
                      ? ` · age ${Math.floor(m.ages[primary.id]!)}`
                      : ""}
                  </span>
                </button>
              ))}
              {warns.length > 0 ? (
                <div className="mt-2 flex flex-col gap-1 rounded-md bg-negative-soft px-3 py-2 text-[12.5px] text-negative">
                  <div className="flex items-center gap-1.5 font-semibold">
                    <AlertTriangle className="size-3.5" /> {warns.length} warning
                    {warns.length > 1 ? "s" : ""}
                  </div>
                  {warns.slice(0, 4).map((w) =>
                    isDatasetReplaced(w) ? (
                      <div key={w.message} className="flex flex-wrap items-start gap-x-2">
                        <span className="min-w-0 flex-1">{w.message}</span>
                        {plan ? <DismissDatasetNotice plan={plan} /> : null}
                      </div>
                    ) : (
                      <button
                        type="button"
                        key={w.message}
                        className="text-left hover:underline"
                        onClick={() => w.periodIndex !== null && setSelected(w.periodIndex)}
                      >
                        {w.message}
                      </button>
                    ),
                  )}
                  {ewWarn.length ? (
                    <div className="text-[11.5px]">
                      Early-withdrawal penalties apply in {ewWarn.length} year(s).
                    </div>
                  ) : null}
                  <Link to="/insights" className="mt-1 text-[12px] font-medium underline">
                    Why? Open insights →
                  </Link>
                </div>
              ) : null}
            </CardBody>
          </Card>
          <Card>
            <CardHeader
              eyebrow="Year by year"
              title="Data table"
              actions={<Table2 className="size-4 text-ink-3" aria-hidden />}
            />
            <YearTable
              result={result}
              basis={basis}
              index={index}
              selected={selected}
              onSelect={setSelected}
              fileName={`glideworth-${plan?.name.toLowerCase().replace(/\W+/g, "-") ?? "plan"}`}
            />
          </Card>
        </div>
      ) : null}

      {result ? (
        <YearDetailSheet
          result={result}
          periodIndex={selected}
          basis={basis}
          index={index}
          input={input}
          onClose={() => setSelected(null)}
          onNavigate={setSelected}
        />
      ) : null}
    </Page>
  );
}
