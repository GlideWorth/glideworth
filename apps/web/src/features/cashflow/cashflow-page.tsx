import type { ProjectionResult } from "@glideworth/core";
import { Pause, Play, SkipBack } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { prefersReducedMotion } from "../../components/charts/chart-prefs";
import { Chart } from "../../components/charts/echarts";
import { categoryColor, roleColor } from "../../components/charts/palette";
import { SeriesChart } from "../../components/charts/series-chart";
import { ChartLoading, EmptyState, ErrorState } from "../../components/charts/states";
import {
  baseOption,
  type ChartTokens,
  tooltipHeader,
  tooltipRow,
} from "../../components/charts/tokens";
import { Page } from "../../components/layout/app-shell";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardBody, CardHeader } from "../../components/ui/card";
import { PartialYearNote, PartialYearToggle, useAnnualise } from "../../components/ui/partial-year";
import { Segmented } from "../../components/ui/segmented";
import { ScrollRegion } from "../../components/ui/table";
import { Stat } from "../../components/ui/stat";
import { formatMoney } from "../../lib/format";
import { total } from "../../lib/money";
import { isPartialPeriod, periodLabel, periodShortLabel } from "../../lib/period";
import {
  agesLabel,
  CATEGORY_LABEL,
  CATEGORY_ORDER,
  conv,
  type EntityIndex,
} from "../results/model";
import { ProjectionChart } from "../results/projection-chart";
import { useAnalysis } from "../results/use-analysis";
import { buildSankey, type SankeyGrouping } from "./sankey";

function SankeyChart({
  result,
  from,
  to,
  grouping,
  index,
  basis,
  locale,
  currency,
  annualise,
}: {
  result: ProjectionResult;
  from: number;
  to: number;
  grouping: SankeyGrouping;
  index: EntityIndex;
  basis: "real" | "nominal";
  locale: string;
  currency: string;
  annualise: boolean;
}) {
  const graph = useMemo(
    () => buildSankey(result, from, to, basis, grouping, index, { annualise }),
    [result, from, to, basis, grouping, index, annualise],
  );
  const build = useCallback(
    (t: ChartTokens) => {
      const money = (v: number) => formatMoney(v, { locale, currency });
      const label = new Map(graph.nodes.map((n) => [n.key, n.label]));
      return {
        ...baseOption(t),
        tooltip: {
          ...baseOption(t).tooltip,
          trigger: "item",
          formatter: (x: {
            dataType: string;
            data: { source?: string; target?: string; value: number; name?: string };
            value: number;
          }) => {
            if (x.dataType === "edge")
              return `${tooltipHeader(`${label.get(x.data.source!)} → ${label.get(x.data.target!)}`)}${tooltipRow(null, "Amount", money(x.data.value), true)}`;
            return `${tooltipHeader(label.get(x.data.name!) ?? "")}${tooltipRow(null, "Total", money(x.value), true)}`;
          },
        },
        series: [
          {
            type: "sankey",
            left: 4,
            right: 200,
            top: 10,
            bottom: 10,
            nodeWidth: 12,
            nodeGap: 10,
            nodeAlign: "justify",
            layoutIterations: 48,
            draggable: false,
            animationDurationUpdate: t.reducedMotion ? 0 : 500,
            emphasis: { focus: "adjacency" },
            label: {
              color: t.ink,
              fontSize: 11.5,
              formatter: (p: { name: string; value: number }) =>
                `${label.get(p.name) ?? p.name}  {v|${formatMoney(p.value, { locale, currency, compact: true })}}`,
              rich: { v: { color: t.ink3, fontSize: 10.5 } },
            },
            lineStyle: { opacity: 0.38, curveness: 0.5 },
            data: graph.nodes.map((n) => ({
              name: n.key,
              depth: n.depth,
              itemStyle: { color: roleColor(t.theme, n.role, t.negative), borderWidth: 0 },
            })),
            links: graph.links.map((l) => {
              const other = graph.nodes.find(
                (n) => n.key === (l.source === "pool" ? l.target : l.source),
              );
              return {
                ...l,
                lineStyle: { color: roleColor(t.theme, other?.role ?? "pool", t.negative) },
              };
            }),
          },
        ],
      };
    },
    [graph, locale, currency],
  );
  if (graph.links.length === 0)
    return (
      <EmptyState title="No money moved in this span">
        The ledger has no entries for the selected years.
      </EmptyState>
    );
  return (
    <Chart
      build={build}
      height={Math.max(380, Math.min(720, graph.nodes.length * 30))}
      ariaLabel="Sankey diagram of money flowing from income sources and withdrawals through available cash to taxes, spending, savings and debt payments."
    />
  );
}

export function CashFlowView() {
  const { plan, result, isLoading, error, index, basis, f } = useAnalysis();
  const annualise = useAnnualise();
  const n = result?.periods.length ?? 0;
  const [spanMode, setSpanMode] = useState<"year" | "range">("year");
  const [year, setYear] = useState(0);
  const [rangeEnd, setRangeEnd] = useState(0);
  const [grouping, setGrouping] = useState<SankeyGrouping>("grouped");
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    if (n) {
      setYear((y) => Math.min(y, n - 1));
      setRangeEnd((e) => (e === 0 ? Math.min(n - 1, 9) : Math.min(e, n - 1)));
    }
  }, [n]);
  useEffect(() => {
    if (!playing || !n) return;
    const id = setInterval(
      () => {
        setYear((y) => {
          if (y >= n - 1) {
            setPlaying(false);
            return y;
          }
          return y + 1;
        });
      },
      prefersReducedMotion() ? 1400 : 900,
    );
    return () => clearInterval(id);
  }, [playing, n]);

  const from = spanMode === "year" ? year : Math.min(year, rangeEnd);
  const to = spanMode === "year" ? year : Math.max(year, rangeEnd);
  const graph = useMemo(
    () => (result ? buildSankey(result, from, to, basis, "grouped", index, { annualise }) : null),
    [result, from, to, basis, index, annualise],
  );
  const p = result?.periods[year];
  const pe = result?.periods[to];

  const savingsRate = useMemo(
    () => (result ? result.periods.map((x) => x.totals.savingsRate) : []),
    [result],
  );
  const labels = useMemo(
    () => (result ? result.periods.map((x) => periodShortLabel(x)) : []),
    [result],
  );
  const drawdown = useMemo(() => {
    if (!result) return [];
    const cats = CATEGORY_ORDER.filter((c) =>
      result.periods.some((x) => x.accounts.some((a) => a.category === c && a.withdrawals > 0.5)),
    );
    return cats.map((c) => ({
      name: CATEGORY_LABEL[c],
      color: (t: ChartTokens) => categoryColor(t.theme, c),
      type: "bar" as const,
      stack: "w",
      values: result.periods.map((x) =>
        conv(
          x,
          x.accounts.filter((a) => a.category === c).reduce((s, a) => s + a.withdrawals, 0),
          basis,
          "flow",
        ),
      ),
    }));
  }, [result, basis]);
  const penalties = useMemo(
    () =>
      result
        ? result.periods.map((x) => {
            const v = x.taxes.lines
              .filter((l) => l.kind === "penalty")
              .reduce((s, l) => s + l.amount, 0);
            return v > 0.5 ? conv(x, v, basis, "flow") : null;
          })
        : [],
    [result, basis],
  );
  // Savings rate parts (engine definition): saved out of after-tax income, one-off money excluded.
  const savingParts = useMemo(() => {
    if (!result) return null;
    let saved = 0;
    let afterTax = 0;
    let oneOff = 0;
    const view = from === to ? { annualise } : {};
    for (let i = from; i <= to; i++) {
      const x = result.periods[i];
      if (!x) continue;
      saved += total(x, "savedFromIncome", basis, view);
      afterTax += total(x, "afterTaxIncome", basis, view);
      oneOff += total(x, "oneOffInflows", basis, view);
    }
    const known = result.periods[from]?.totals.afterTaxIncome !== undefined;
    return known ? { saved, afterTax, oneOff, rate: afterTax > 0 ? saved / afterTax : null } : null;
  }, [result, from, to, basis, annualise]);
  const onPick = useCallback((i: number) => {
    setPlaying(false);
    setYear(i);
  }, []);

  return (
    <Page
      title="Cash flow"
      description={
        plan
          ? `Where every unit of money came from and went in “${plan.name}”, straight from the engine's ledger.`
          : undefined
      }
    >
      {isLoading ? <ChartLoading /> : null}
      {error ? <ErrorState error={error} title="Simulation failed" /> : null}
      {result && p && pe && graph ? (
        <>
          <Card>
            <CardHeader
              eyebrow={spanMode === "year" ? "Single year" : "Year range"}
              title={
                spanMode === "year"
                  ? `${periodLabel(p, { annualise })} · ${agesLabel(p, index.people)}`
                  : `${result.periods[from]!.year}–${pe.year} (${to - from + 1} years combined${
                      result.periods.slice(from, to + 1).some(isPartialPeriod)
                        ? ", actual months"
                        : ""
                    })`
              }
              actions={
                <>
                  <PartialYearToggle periods={result.periods} />
                  <Badge>{basis === "real" ? "Today's money" : "Future money"}</Badge>
                </>
              }
            />
            {spanMode === "year" ? <PartialYearNote period={p} className="mx-4 mt-3" /> : null}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-4 py-2.5">
              <Segmented
                aria-label="Span"
                size="sm"
                value={spanMode}
                onChange={(v) => {
                  setSpanMode(v);
                  setPlaying(false);
                }}
                options={[
                  { value: "year", label: "One year" },
                  { value: "range", label: "Range" },
                ]}
              />
              <Segmented
                aria-label="Grouping"
                size="sm"
                value={grouping}
                onChange={setGrouping}
                options={[
                  { value: "grouped", label: "Grouped" },
                  { value: "detail", label: "Every line" },
                ]}
              />
              <div className="flex min-w-[260px] flex-1 items-center gap-2">
                {spanMode === "year" ? (
                  <>
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label="Back to first year"
                      onClick={() => {
                        setPlaying(false);
                        setYear(0);
                      }}
                    >
                      <SkipBack />
                    </Button>
                    <Button
                      size="icon"
                      variant="secondary"
                      aria-label={playing ? "Pause" : "Play through the years"}
                      onClick={() => {
                        if (!playing && year >= n - 1) setYear(0);
                        setPlaying(!playing);
                      }}
                    >
                      {playing ? <Pause /> : <Play />}
                    </Button>
                  </>
                ) : null}
                <div className="flex flex-1 flex-col">
                  <input
                    type="range"
                    min={0}
                    max={n - 1}
                    value={year}
                    aria-label={spanMode === "year" ? "Year" : "Range start"}
                    aria-valuetext={String(result.periods[year]!.year)}
                    onChange={(e) => onPick(Number(e.target.value))}
                    className="w-full accent-[var(--accent)]"
                  />
                  {spanMode === "range" ? (
                    <input
                      type="range"
                      min={0}
                      max={n - 1}
                      value={rangeEnd}
                      aria-label="Range end"
                      aria-valuetext={String(result.periods[rangeEnd]!.year)}
                      onChange={(e) => setRangeEnd(Number(e.target.value))}
                      className="w-full accent-[var(--ochre)]"
                    />
                  ) : null}
                </div>
                <span className="num w-[86px] text-right text-[12.5px] text-ink-2">
                  {spanMode === "year"
                    ? periodShortLabel(p)
                    : `${result.periods[from]!.year}–${pe.year}`}
                </span>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4 border-b border-border px-4 py-3 sm:grid-cols-3 lg:grid-cols-6">
              <Stat
                label="Money in"
                value={f.money(graph.totals.inflow, true)}
                sub={
                  graph.totals.withdrawn > 0.5
                    ? `incl. ${f.money(graph.totals.withdrawn, true)} withdrawn`
                    : "Income, nothing withdrawn"
                }
              />
              <Stat label="Taxes" value={f.money(graph.totals.taxes, true)} />
              <Stat label="Spending" value={f.money(graph.totals.spending, true)} />
              <Stat
                label="Debt & loans"
                value={f.money(graph.totals.debt, true)}
                sub="Repayments and purchases"
              />
              <Stat label="Saved" value={f.money(graph.totals.saved, true)} />
              <Stat
                label="Savings rate"
                value={
                  savingParts?.rate !== null && savingParts?.rate !== undefined
                    ? f.percent(savingParts.rate)
                    : spanMode === "year" && p.totals.savingsRate !== null
                      ? f.percent(p.totals.savingsRate)
                      : "—"
                }
                sub={
                  savingParts
                    ? `${f.money(savingParts.saved, true)} of ${f.money(savingParts.afterTax, true)} after-tax income`
                    : "Saved ÷ after-tax income"
                }
              />
            </div>
            <CardBody>
              <ScrollRegion label="Cash flow diagram, scrolls sideways if it does not fit">
                <div className="min-w-[620px]">
                  <SankeyChart
                    result={result}
                    from={from}
                    to={to}
                    grouping={grouping}
                    annualise={annualise}
                    index={index}
                    basis={basis}
                    locale={f.locale}
                    currency={f.currency}
                  />
                </div>
              </ScrollRegion>
            </CardBody>
          </Card>

          <div className="grid gap-5 lg:grid-cols-2">
            <Card>
              <CardHeader eyebrow="Over time" title="Income vs outgoings" />
              <CardBody>
                <ProjectionChart
                  result={result}
                  basis={basis}
                  locale={f.locale}
                  currency={f.currency}
                  index={index}
                  plan={plan}
                  mode="incomeExpenses"
                  kind="bar"
                  compact
                  height={280}
                  selected={year}
                  onSelectYear={onPick}
                  annualise={annualise}
                />
                <p className="mt-1 text-[11.5px] text-ink-3">
                  Income and withdrawals above zero; spending and taxes below. Click a year to load
                  it above.
                </p>
              </CardBody>
            </Card>
            <Card>
              <CardHeader eyebrow="Over time" title="Savings rate" />
              <CardBody>
                <SeriesChart
                  labels={labels}
                  format="percent"
                  locale={f.locale}
                  height={280}
                  ariaLabel="Savings rate by year"
                  onClickIndex={onPick}
                  markers={[{ index: year, label: "", tone: "accent" }]}
                  yMin={0}
                  yMax={1}
                  series={[
                    {
                      name: "Savings rate",
                      color: (t) => roleColor(t.theme, "savings", t.negative),
                      type: "area",
                      values: savingsRate,
                    },
                  ]}
                  tooltipExtra={(i) => {
                    const x = result.periods[i];
                    if (!x || x.totals.afterTaxIncome === undefined) return "";
                    return [
                      tooltipRow(
                        null,
                        "Saved from income",
                        f.money(total(x, "savedFromIncome", basis)),
                      ),
                      tooltipRow(
                        null,
                        "After-tax income",
                        f.money(total(x, "afterTaxIncome", basis)),
                      ),
                      (x.totals.oneOffInflows ?? 0) > 0.5
                        ? tooltipRow(
                            null,
                            "One-off money (not counted)",
                            f.money(total(x, "oneOffInflows", basis)),
                          )
                        : "",
                    ].join("");
                  }}
                />
                {savingParts ? (
                  <dl className="mt-2 grid grid-cols-3 gap-2 text-[12px]">
                    <div>
                      <dt className="text-ink-3">Saved from income</dt>
                      <dd className="num font-medium">{f.money(savingParts.saved, true)}</dd>
                    </div>
                    <div>
                      <dt className="text-ink-3">After-tax income</dt>
                      <dd className="num font-medium">{f.money(savingParts.afterTax, true)}</dd>
                    </div>
                    <div>
                      <dt className="text-ink-3">One-off money</dt>
                      <dd className="num font-medium">{f.money(savingParts.oneOff, true)}</dd>
                    </div>
                  </dl>
                ) : null}
                <p className="mt-1 text-[11.5px] text-ink-3">
                  Share of after-tax income saved, between 0% and 100%. Sale proceeds, inheritances
                  and windfalls you save are not counted as saving from income.{" "}
                  {spanMode === "range"
                    ? "Figures above cover the selected years."
                    : `Figures above are for ${p?.year ?? ""}.`}
                </p>
              </CardBody>
            </Card>
          </div>
          <Card>
            <CardHeader
              eyebrow="Drawdown"
              title="Withdrawals by account type"
              actions={
                penalties.some((x) => x !== null) ? (
                  <Badge tone="negative">Early-withdrawal penalties</Badge>
                ) : null
              }
            />
            <CardBody>
              {drawdown.length === 0 ? (
                <EmptyState title="No withdrawals in this plan">
                  The plan never needs to draw on its accounts.
                </EmptyState>
              ) : (
                <SeriesChart
                  labels={labels}
                  format="money"
                  locale={f.locale}
                  currency={f.currency}
                  height={280}
                  zoom
                  ariaLabel="Withdrawals by account type each year, with early-withdrawal penalties"
                  onClickIndex={onPick}
                  series={[
                    ...drawdown,
                    ...(penalties.some((x) => x !== null)
                      ? [
                          {
                            name: "Penalty paid",
                            color: (t: ChartTokens) => t.negative,
                            type: "line" as const,
                            values: penalties,
                            symbol: true,
                          },
                        ]
                      : []),
                  ]}
                />
              )}
            </CardBody>
          </Card>
        </>
      ) : null}
    </Page>
  );
}
