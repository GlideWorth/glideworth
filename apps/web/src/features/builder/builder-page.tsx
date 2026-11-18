import type { ValueBasis } from "@glideworth/core";
import { Download, Plus, Save, Search, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Chart } from "../../components/charts/echarts";
import { slotColor } from "../../components/charts/palette";
import { ChartLoading, EmptyState, ErrorState } from "../../components/charts/states";
import {
  axisStyle,
  baseOption,
  type ChartTokens,
  tooltipHeader,
  tooltipRow,
} from "../../components/charts/tokens";
import { Page } from "../../components/layout/app-shell";
import { Button } from "../../components/ui/button";
import { Card, CardBody, CardHeader } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { Segmented } from "../../components/ui/segmented";
import { Select } from "../../components/ui/select";
import { toast } from "../../components/ui/toaster";
import { cn } from "../../lib/cn";
import { formatMoney, formatPercent } from "../../lib/format";
import { periodShortLabel } from "../../lib/period";
import { downloadText, toCsv } from "../results/model";
import { useAnalysis } from "../results/use-analysis";
import {
  buildCatalog,
  buildSeries,
  type CatalogEntry,
  type ChartType,
  type ChartView,
  defaultAxis,
  emptyView,
  loadViews,
  saveViews,
  upsertView,
} from "./builder-model";

function Picker({
  catalog,
  selected,
  onToggle,
}: {
  catalog: CatalogEntry[];
  selected: Set<string>;
  onToggle: (c: CatalogEntry) => void;
}) {
  const [q, setQ] = useState("");
  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const m = new Map<string, CatalogEntry[]>();
    for (const c of catalog) {
      if (needle && !`${c.label} ${c.group}`.toLowerCase().includes(needle)) continue;
      m.set(c.group, [...(m.get(c.group) ?? []), c]);
    }
    return [...m.entries()];
  }, [catalog, q]);
  return (
    <div className="flex flex-col gap-2">
      <div className="relative">
        <Search className="pointer-events-none absolute top-2 left-2.5 size-3.5 text-ink-3" />
        <Input
          aria-label="Search series"
          placeholder="Search accounts, taxes, metrics…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="pl-8"
        />
      </div>
      <div className="max-h-[420px] overflow-y-auto rounded-md border border-border">
        {groups.length === 0 ? (
          <div className="p-3 text-[12.5px] text-ink-3">Nothing matches.</div>
        ) : null}
        {groups.map(([g, items]) => (
          <details
            key={g}
            open={!!q || g === "Metrics"}
            className="border-b border-border last:border-0"
          >
            <summary className="cursor-pointer bg-surface-2/60 px-3 py-1.5 text-[12px] font-semibold pointer-coarse:py-3">
              {g} <span className="font-normal text-ink-3">({items.length})</span>
            </summary>
            <ul>
              {items.map((c) => (
                <li key={c.ref}>
                  <label className="flex cursor-pointer items-center gap-2 px-3 py-1 text-[12.5px] hover:bg-surface-2/60 pointer-coarse:min-h-11">
                    <input
                      type="checkbox"
                      checked={selected.has(c.ref)}
                      onChange={() => onToggle(c)}
                      className="accent-[var(--accent)]"
                    />
                    <span className="min-w-0 flex-1 truncate">{c.label}</span>
                    {c.kind === "percent" ? (
                      <span className="text-[10.5px] text-ink-3">%</span>
                    ) : null}
                  </label>
                </li>
              ))}
            </ul>
          </details>
        ))}
      </div>
    </div>
  );
}

export function BuilderView() {
  const { plan, result, isLoading, error, index, basis, f } = useAnalysis();
  const catalog = useMemo(() => (result ? buildCatalog(result, index) : []), [result, index]);
  const byRef = useMemo(() => new Map(catalog.map((c) => [c.ref, c])), [catalog]);
  const [views, setViews] = useState<ChartView[]>([]);
  const [view, setView] = useState<ChartView>(emptyView);
  const [name, setName] = useState("");
  const [table, setTable] = useState(false);
  const planId = plan?.id;

  useEffect(() => {
    if (!planId) return;
    const v = loadViews(planId);
    setViews(v);
    const first = v[0];
    if (first) {
      setView(first);
      setName(first.name);
    } else {
      setView(emptyView());
      setName("");
    }
  }, [planId]);

  const built = useMemo(
    () => (result ? buildSeries(view, catalog, result, basis) : { series: [], missing: [] }),
    [view, catalog, result, basis],
  );
  const labels = useMemo(() => result?.periods.map((p) => periodShortLabel(p)) ?? [], [result]);
  const selected = useMemo(() => new Set(view.series.map((s) => s.ref)), [view.series]);

  const toggle = (c: CatalogEntry) =>
    setView((v) => {
      if (v.series.some((s) => s.ref === c.ref))
        return { ...v, series: v.series.filter((s) => s.ref !== c.ref) };
      const existing = v.series.flatMap((s) => {
        const e = byRef.get(s.ref);
        return e ? [{ kind: e.kind, axis: s.axis }] : [];
      });
      return { ...v, series: [...v.series, { ref: c.ref, axis: defaultAxis(c.kind, existing) }] };
    });

  const persist = (next: ChartView[]) => {
    setViews(next);
    if (planId && !saveViews(planId, next))
      toast({
        title: "Couldn’t save in this browser",
        description: "Storage is unavailable.",
        tone: "negative",
      });
  };
  const save = () => {
    const finalName = name.trim() || "Untitled view";
    const id = view.id || `view-${Date.now().toString(36)}`;
    const next = { ...view, id, name: finalName };
    setView(next);
    setName(finalName);
    persist(upsertView(views, next));
    toast({
      title: `Saved “${finalName}”`,
      description: "Available on this device for this plan.",
    });
  };
  const remove = () => {
    if (!view.id) return;
    persist(views.filter((v) => v.id !== view.id));
    setView(emptyView());
    setName("");
  };

  const money = useCallback(
    (v: number, compact = true) =>
      formatMoney(v, { locale: f.locale, currency: f.currency, compact }),
    [f.locale, f.currency],
  );
  const rightKind = built.series
    .filter((s) => s.axis === "right")
    .every((s) => s.kind === "percent")
    ? "percent"
    : "money";
  const leftKind = built.series.filter((s) => s.axis === "left").every((s) => s.kind === "percent")
    ? "percent"
    : "money";
  const fmt = useCallback(
    (kind: "money" | "percent", v: number, compact = true) =>
      kind === "percent" ? formatPercent(v, f.locale, compact ? 0 : 1) : money(v, compact),
    [f.locale, money],
  );

  const build = useCallback(
    (t: ChartTokens) => {
      const ax = axisStyle(t);
      const hasRight = built.series.some((s) => s.axis === "right");
      const hasBar = built.series.some((s) => s.type === "bar");
      const col = (i: number) => slotColor(t.theme, i);
      return {
        ...baseOption(t),
        legend: {
          ...baseOption(t).legend,
          show: built.series.length > 1,
          data: built.series.map((s) => s.label),
        },
        grid: {
          ...baseOption(t).grid,
          top: built.series.length > 1 ? 34 : 14,
          bottom: 40,
          right: hasRight ? 8 : 12,
        },
        tooltip: {
          ...baseOption(t).tooltip,
          axisPointer: hasBar
            ? { type: "shadow", shadowStyle: { color: `${t.ink3}18` } }
            : { type: "line", lineStyle: { color: t.ink3 } },
          formatter: (params: unknown) => {
            const ps = (Array.isArray(params) ? params : [params]) as {
              dataIndex: number;
              seriesIndex: number;
              value: number | null;
            }[];
            const i = ps[0]?.dataIndex ?? 0;
            return `${tooltipHeader(labels[i] ?? "")}${ps
              .filter((p) => p.value !== null && p.value !== undefined)
              .map((p) => {
                const s = built.series[p.seriesIndex]!;
                return tooltipRow(
                  col(p.seriesIndex),
                  s.label,
                  fmt(s.kind, p.value as number, false),
                );
              })
              .join("")}`;
          },
        },
        xAxis: {
          type: "category",
          data: labels,
          boundaryGap: hasBar,
          ...ax,
          splitLine: { show: false },
          axisLabel: { ...ax.axisLabel, hideOverlap: true },
        },
        yAxis: [
          {
            type: "value",
            ...ax,
            axisLabel: { ...ax.axisLabel, formatter: (v: number) => fmt(leftKind, v) },
          },
          ...(hasRight
            ? [
                {
                  type: "value",
                  ...ax,
                  splitLine: { show: false },
                  axisLabel: { ...ax.axisLabel, formatter: (v: number) => fmt(rightKind, v) },
                },
              ]
            : []),
        ],
        dataZoom: [
          { type: "inside", zoomOnMouseWheel: "shift", moveOnMouseWheel: false },
          {
            type: "slider",
            height: 16,
            bottom: 6,
            borderColor: t.border,
            fillerColor: `${t.accent}1f`,
            textStyle: { color: t.ink3, fontSize: 10 },
          },
        ],
        series: built.series.map((s, i) => {
          const c = col(i);
          const common = {
            name: s.label,
            data: s.values,
            yAxisIndex: s.axis === "right" ? 1 : 0,
            stack: s.stack,
            emphasis: { focus: "series" },
          };
          if (s.type === "bar")
            return {
              ...common,
              type: "bar",
              itemStyle: {
                color: c,
                borderColor: t.surface,
                borderWidth: labels.length > 40 ? 0 : 0.75,
              },
              barCategoryGap: labels.length > 60 ? "12%" : "26%",
            };
          return {
            ...common,
            type: "line",
            symbol: "none",
            lineStyle: { width: 2.25, color: c, type: s.axis === "right" ? "dashed" : "solid" },
            itemStyle: { color: c },
            areaStyle: s.type === "area" ? { color: c, opacity: s.stack ? 0.85 : 0.18 } : undefined,
          };
        }),
      };
    },
    [built, labels, leftKind, rightKind, fmt],
  );

  const exportCsv = () => {
    if (!built.series.length) return;
    downloadText(
      `glideworth-${(view.name || "custom-chart").toLowerCase().replace(/[^a-z0-9]+/g, "-")}.csv`,
      toCsv(
        ["year", ...built.series.map((s) => s.label)],
        labels.map((y, i) => [y, ...built.series.map((s) => s.values[i] ?? null)]),
      ),
    );
  };

  const setSeries = (ref: string, patch: Partial<ChartView["series"][number]>) =>
    setView((v) => ({
      ...v,
      series: v.series.map((s) => (s.ref === ref ? { ...s, ...patch } : s)),
    }));

  return (
    <Page
      title="Custom charts"
      description={
        plan
          ? `Chart any series from “${plan.name}”: accounts, categories, tax lines and metrics. Save views for this plan.`
          : undefined
      }
    >
      {isLoading ? <ChartLoading /> : null}
      {error ? <ErrorState error={error} title="Simulation failed" /> : null}
      {result ? (
        <div className="grid gap-5 lg:grid-cols-[320px_minmax(0,1fr)]">
          <Card className="self-start">
            <CardHeader eyebrow="Series" title="Pick what to plot" />
            <CardBody>
              <Picker catalog={catalog} selected={selected} onToggle={toggle} />
            </CardBody>
          </Card>
          <div className="flex min-w-0 flex-col gap-5">
            <Card>
              <CardHeader
                eyebrow="Saved views"
                title={view.id ? view.name : "New view"}
                actions={
                  views.length ? (
                    <Select
                      aria-label="Open a saved view"
                      className="w-[200px]"
                      value={view.id || "__new"}
                      onValueChange={(id) => {
                        const v = views.find((x) => x.id === id);
                        if (v) {
                          setView(v);
                          setName(v.name);
                        } else {
                          setView(emptyView());
                          setName("");
                        }
                      }}
                      options={[
                        { value: "__new", label: "New view" },
                        ...views.map((v) => ({ value: v.id, label: v.name })),
                      ]}
                    />
                  ) : null
                }
              />
              <CardBody className="flex flex-col gap-3">
                <div className="flex flex-wrap items-center gap-3">
                  <Segmented<ChartType>
                    aria-label="Chart type"
                    size="sm"
                    value={view.chartType}
                    onChange={(chartType) => setView({ ...view, chartType })}
                    options={[
                      { value: "line", label: "Lines" },
                      { value: "bar", label: "Bars" },
                      { value: "area", label: "Areas" },
                    ]}
                  />
                  <label className="flex items-center gap-1.5 text-[12.5px]">
                    <input
                      type="checkbox"
                      checked={view.stacked}
                      onChange={(e) => setView({ ...view, stacked: e.target.checked })}
                      className="accent-[var(--accent)]"
                    />
                    Stack money series
                  </label>
                  <Segmented<"follow" | ValueBasis>
                    aria-label="Money basis"
                    size="sm"
                    value={view.basis}
                    onChange={(b) => setView({ ...view, basis: b })}
                    options={[
                      { value: "follow", label: "App setting" },
                      { value: "real", label: "Today's money" },
                      { value: "nominal", label: "Future money" },
                    ]}
                  />
                </div>
                {built.series.length === 0 ? (
                  <EmptyState title="Pick at least one series" icon={<Plus className="size-5" />}>
                    Tick accounts, categories, tax lines or metrics on the left.
                  </EmptyState>
                ) : (
                  <Chart
                    build={build}
                    height={340}
                    ariaLabel={`Custom chart of ${built.series.map((s) => s.label).join(", ")} by year`}
                  />
                )}
                {built.missing.length ? (
                  <p className="text-[12px] text-ink-3">
                    {built.missing.length} saved series no longer exist in this plan and are hidden.
                  </p>
                ) : null}
                {view.series.length ? (
                  <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
                    {view.series.map((s, i) => {
                      const e = byRef.get(s.ref);
                      if (!e) return null;
                      return (
                        <li
                          key={s.ref}
                          className="flex flex-wrap items-center gap-2 px-3 py-1.5 text-[12.5px]"
                        >
                          <span
                            aria-hidden
                            className="size-2.5 rounded-[3px]"
                            style={{
                              background: slotColor(
                                "light",
                                built.series.findIndex((b) => b.ref === s.ref),
                              ),
                            }}
                          />
                          <span className="min-w-0 flex-1 truncate">{e.label}</span>
                          <Select
                            aria-label={`Type for ${e.label}`}
                            className="w-[112px]"
                            value={s.type ?? "inherit"}
                            onValueChange={(t) =>
                              setSeries(s.ref, {
                                type: t === "inherit" ? undefined : (t as ChartType),
                              })
                            }
                            options={[
                              { value: "inherit", label: "Chart type" },
                              { value: "line", label: "Line" },
                              { value: "bar", label: "Bars" },
                              { value: "area", label: "Area" },
                            ]}
                          />
                          <Segmented<"left" | "right">
                            aria-label={`Axis for ${e.label}`}
                            size="sm"
                            value={s.axis}
                            onChange={(axis) => setSeries(s.ref, { axis })}
                            options={[
                              { value: "left", label: "Left axis" },
                              { value: "right", label: "Right axis" },
                            ]}
                          />
                          <Button
                            size="icon"
                            variant="ghost"
                            aria-label={`Remove ${e.label}`}
                            onClick={() =>
                              setView({ ...view, series: view.series.filter((_, k) => k !== i) })
                            }
                          >
                            <X />
                          </Button>
                        </li>
                      );
                    })}
                  </ul>
                ) : null}
                <div className="flex flex-wrap items-center gap-2">
                  <Input
                    aria-label="View name"
                    value={name}
                    placeholder="Name this view"
                    onChange={(e) => {
                      setName(e.target.value);
                      setView((v) => ({ ...v, name: e.target.value }));
                    }}
                    className="h-8 max-w-[240px] text-[12.5px]"
                  />
                  <Button size="sm" variant="primary" onClick={save} disabled={!view.series.length}>
                    <Save /> {view.id ? "Update view" : "Save view"}
                  </Button>
                  {view.id ? (
                    <Button size="sm" variant="ghost" onClick={remove}>
                      <Trash2 /> Delete
                    </Button>
                  ) : null}
                  <span className="grow" />
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setTable((v) => !v)}
                    aria-pressed={table}
                  >
                    {table ? "Hide table" : "Show table"}
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={exportCsv}
                    disabled={!built.series.length}
                  >
                    <Download /> CSV
                  </Button>
                </div>
                <p className="text-[11.5px] text-ink-3">
                  Saved views are kept in this browser, per plan. Percent series sit on the right
                  axis when charted with money.
                </p>
              </CardBody>
            </Card>
            {table && built.series.length ? (
              <Card>
                <CardHeader eyebrow="Same data" title="Table" />
                <div className="max-h-[420px] overflow-auto">
                  <table className="w-full text-[12.5px]">
                    <thead className="sticky top-0 bg-surface text-left text-ink-3">
                      <tr>
                        <th className="px-3 py-1.5">Year</th>
                        {built.series.map((s) => (
                          <th key={s.ref} className="px-3 py-1.5 text-right">
                            {s.label}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {labels.map((y, i) => (
                        <tr key={y} className={cn("border-t border-border")}>
                          <td className="num px-3 py-1">{y}</td>
                          {built.series.map((s) => (
                            <td key={s.ref} className="num px-3 py-1 text-right">
                              {s.values[i] === null ? "—" : fmt(s.kind, s.values[i]!, false)}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            ) : null}
          </div>
        </div>
      ) : null}
    </Page>
  );
}
