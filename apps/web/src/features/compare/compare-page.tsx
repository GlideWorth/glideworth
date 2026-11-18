import type {
  GlideworthDocument,
  Plan,
  PlanChange,
  ProjectionResult,
  SimulationInput,
} from "@glideworth/core";
import { SimulationOptions } from "@glideworth/core";
import { useQueries } from "@tanstack/react-query";
import { X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { slotColor } from "../../components/charts/palette";
import { SeriesChart } from "../../components/charts/series-chart";
import {
  ChartLoading,
  EmptyState,
  ErrorState,
  ExampleBadge,
  NotAvailable,
} from "../../components/charts/states";
import { Page } from "../../components/layout/app-shell";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardBody, CardHeader } from "../../components/ui/card";
import { Select } from "../../components/ui/select";
import { Table, TBody, TD, TH, THead, TR } from "../../components/ui/table";
import { cn } from "../../lib/cn";
import { formatSigned } from "../../lib/format";
import { conv } from "../../lib/money";
import { useResolvedTheme } from "../../lib/theme";
import { useFormat } from "../../lib/workspace";
import { useUi } from "../../stores/ui";
import { runSimulation } from "../../workers/sim-client";
import { useMcStore } from "../chance/mc-store";
import { attempt, bridge, diffFormat } from "../results/core-bridge";
import { exampleDiff } from "../results/fixtures";
import { useAnalysis } from "../results/use-analysis";
import { attributeDifference, type CompareMetrics, compareMetrics } from "./compare-model";
import { type SessionScenario, useScenarioStore } from "./scenario-store";

interface Candidate {
  id: string;
  name: string;
  plan: Plan;
  input: SimulationInput;
  kind: "plan" | "whatif";
  changes?: string[];
}

function inputForPlan(doc: GlideworthDocument, plan: Plan): SimulationInput {
  const { lineage: _l, ...body } = plan;
  return {
    household: doc.household,
    finances: doc.finances,
    plan: body as Plan,
    options: SimulationOptions.parse({ trace: "summary" }),
  };
}

function candidates(doc: GlideworthDocument, scenarios: SessionScenario[]): Candidate[] {
  const out: Candidate[] = doc.plans.map((p) => ({
    id: p.id,
    name: p.name,
    plan: p,
    input: inputForPlan(doc, p),
    kind: "plan",
  }));
  for (const s of scenarios) {
    const base = doc.plans.find((p) => p.id === s.basePlanId);
    if (!base) continue;
    const input = inputForPlan(doc, s.plan);
    out.push({
      id: s.id,
      name: s.name,
      plan: s.plan,
      input: { ...input, options: { ...input.options, ...(s.market ? { market: s.market } : {}) } },
      kind: "whatif",
      changes: s.changes,
    });
  }
  return out;
}

type Metric = "netWorth" | "liquidNetWorth" | "spending" | "income" | "taxes";
const METRIC_LABEL: Record<Metric, string> = {
  netWorth: "Net worth",
  liquidNetWorth: "Liquid net worth",
  spending: "Spending",
  income: "Income",
  taxes: "Taxes",
};

const ROWS: {
  key: keyof CompareMetrics;
  label: string;
  kind: "money" | "year" | "percent";
  better: "higher" | "lower" | "earlier" | null;
}[] = [
  { key: "endNetWorthReal", label: "Net worth at end", kind: "money", better: "higher" },
  { key: "peakNetWorthReal", label: "Peak net worth", kind: "money", better: "higher" },
  { key: "retirementYear", label: "Retirement", kind: "year", better: null },
  { key: "fiYear", label: "Financial independence", kind: "year", better: "earlier" },
  { key: "firstShortfallYear", label: "First shortfall", kind: "year", better: null },
  { key: "totalShortfallReal", label: "Unfunded spending", kind: "money", better: "lower" },
  { key: "lifetimeSpendingReal", label: "Lifetime spending", kind: "money", better: null },
  { key: "lifetimeTaxesReal", label: "Lifetime taxes", kind: "money", better: "lower" },
  { key: "avgSavingsRate", label: "Average savings rate", kind: "percent", better: null },
  { key: "firstWithdrawalRate", label: "First withdrawal rate", kind: "percent", better: "lower" },
];

export function CompareView() {
  const { doc, plan, basis } = useAnalysis();
  const f = useFormat();
  const scenarios = useScenarioStore((s) => s.items);
  const preset = useScenarioStore((s) => s.compareIds);
  const removeScenario = useScenarioStore((s) => s.remove);
  const setActive = useUi((s) => s.setActivePlan);
  const mcByPlan = useMcStore((s) => s.byPlan);
  const all = useMemo(() => (doc ? candidates(doc, scenarios) : []), [doc, scenarios]);
  const [ids, setIds] = useState<string[]>([]);
  const [metric, setMetric] = useState<Metric>("netWorth");
  const [exampleDiffs, setExampleDiffs] = useState(false);

  useEffect(() => {
    if (!all.length) return;
    setIds((cur) => {
      const valid = cur.filter((id) => all.some((c) => c.id === id));
      if (valid.length >= 2) return valid;
      const fromPreset = preset.filter((id) => all.some((c) => c.id === id));
      if (fromPreset.length >= 2) return fromPreset.slice(0, 4);
      const first = plan?.id ?? all[0]!.id;
      const second = all.find((c) => c.id !== first)?.id;
      return second ? [first, second] : [first];
    });
  }, [all, preset, plan]);

  const chosen = ids.map((id) => all.find((c) => c.id === id)).filter((c): c is Candidate => !!c);
  const queries = useQueries({
    queries: chosen.map((c) => ({
      queryKey: [
        "compare-sim",
        c.id,
        c.plan.version,
        c.plan.updatedAt,
        c.kind === "whatif" ? JSON.stringify(c.changes) : "",
      ],
      queryFn: () => runSimulation(c.input).then((r) => r.result),
      staleTime: Number.POSITIVE_INFINITY,
      retry: false,
    })),
  });
  const results = queries.map((q) => q.data);
  const base = chosen[0];
  const baseResult = results[0];

  const toggle = (id: string) =>
    setIds((cur) =>
      cur.includes(id) ? cur.filter((x) => x !== id) : cur.length >= 4 ? cur : [...cur, id],
    );
  const makeBaseline = (id: string) => setIds((cur) => [id, ...cur.filter((x) => x !== id)]);

  const allYears = [...new Set(results.flatMap((r) => r?.periods.map((p) => p.year) ?? []))].sort(
    (a, b) => a - b,
  );
  const seriesFor = (r: ProjectionResult | undefined) =>
    allYears.map((y) => {
      const p = r?.periods.find((x) => x.year === y);
      if (!p) return null;
      const v = p.totals[metric];
      return conv(p, v, basis, metric);
    });

  const metrics = results.map((r) => (r ? compareMetrics(r) : null));
  const fmt = (kind: "money" | "year" | "percent", v: number | null) =>
    v === null
      ? "—"
      : kind === "money"
        ? f.money(v, true)
        : kind === "percent"
          ? f.percent(v)
          : String(v);

  const diffs = chosen.slice(1).map((c) => {
    if (!base) return { c, changes: null as PlanChange[] | null, error: null as unknown };
    if (c.kind === "whatif" && c.changes)
      return {
        c,
        changes: c.changes.map((d) => ({
          path: "",
          kind: "changed" as const,
          entity: { type: "plan" as const },
          description: d,
        })),
        error: null,
      };
    const r = attempt(() =>
      bridge.diffPlans(base.plan, c.plan, diffFormat(doc, f.locale, f.currency)),
    );
    return {
      c,
      changes: r.value?.changes ?? (exampleDiffs ? exampleDiff(base.id, c.id).changes : null),
      error: r.error,
    };
  });

  return (
    <Page
      title="Compare"
      description="Two to four plans, branches or what-ifs side by side, in today's or future money."
    >
      {!doc ? <ChartLoading /> : null}
      {doc ? (
        <Card>
          <CardHeader
            eyebrow="Choose 2–4"
            title="Plans and what-ifs"
            actions={<Badge>{chosen.length} selected</Badge>}
          />
          <CardBody className="flex flex-wrap gap-2">
            {all.map((c) => {
              const i = ids.indexOf(c.id);
              return (
                <span key={c.id} className="inline-flex items-center">
                  <button
                    type="button"
                    aria-pressed={i >= 0}
                    onClick={() => toggle(c.id)}
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[12.5px] font-medium transition-colors",
                      i >= 0
                        ? "border-accent bg-accent-soft text-ink"
                        : "border-border text-ink-2 hover:border-border-strong",
                    )}
                  >
                    {i >= 0 ? <SwatchIndex i={i} /> : null}
                    {c.name}
                    {c.kind === "whatif" ? (
                      <Badge tone="ochre">what-if</Badge>
                    ) : c.plan.lineage ? (
                      <Badge>branch</Badge>
                    ) : null}
                  </button>
                  {c.kind === "whatif" ? (
                    <button
                      type="button"
                      aria-label={`Remove ${c.name}`}
                      className="ml-0.5 rounded p-0.5 text-ink-3 hover:text-ink"
                      onClick={() => removeScenario(c.id)}
                    >
                      <X className="size-3.5" />
                    </button>
                  ) : null}
                </span>
              );
            })}
          </CardBody>
        </Card>
      ) : null}

      {chosen.length < 2 && doc ? (
        <Card>
          <EmptyState title="Pick at least two to compare">
            Create plans or branches in Plans, or make a what-if in Insights, then select them
            above.
          </EmptyState>
        </Card>
      ) : null}

      {chosen.length >= 2 ? (
        <>
          <Card>
            <CardHeader
              eyebrow="Overlay"
              title={`${METRIC_LABEL[metric]} by year`}
              actions={
                <Select
                  aria-label="Metric"
                  value={metric}
                  onValueChange={setMetric}
                  options={(Object.keys(METRIC_LABEL) as Metric[]).map((m) => ({
                    value: m,
                    label: METRIC_LABEL[m],
                  }))}
                  className="w-[160px]"
                />
              }
            />
            <CardBody>
              {queries.some((q) => q.isLoading) ? <ChartLoading height={300} /> : null}
              {queries.map((q, i) =>
                q.error ? (
                  <ErrorState
                    key={chosen[i]!.id}
                    error={q.error}
                    title={`${chosen[i]!.name} could not be simulated`}
                  />
                ) : null,
              )}
              {results.some(Boolean) ? (
                <SeriesChart
                  labels={allYears.map(String)}
                  format="money"
                  locale={f.locale}
                  currency={f.currency}
                  height={320}
                  zoom
                  ariaLabel={`${METRIC_LABEL[metric]} for each selected plan; the first plan is the dashed baseline`}
                  series={chosen.map((c, i) => ({
                    name: i === 0 ? `${c.name} (baseline)` : c.name,
                    color: (t) => (i === 0 ? t.ink3 : slotColor(t.theme, [0, 2, 1, 4][i - 1]!)),
                    values: seriesFor(results[i]),
                    dashed: i === 0,
                    width: i === 0 ? 1.75 : 2.25,
                  }))}
                />
              ) : null}
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              eyebrow="Outcomes"
              title="Metrics and differences"
              actions={<Badge>Today's money</Badge>}
            />
            <div className="overflow-x-auto">
              <Table>
                <THead>
                  <TR>
                    <TH className="px-2 align-bottom sm:px-3">Metric</TH>
                    {chosen.map((c, i) => (
                      <TH
                        key={c.id}
                        numeric
                        className="max-w-[220px] min-w-[104px] px-2 align-bottom sm:min-w-[150px] sm:px-3"
                      >
                        <span className="flex items-center justify-end gap-1.5" title={c.name}>
                          <SwatchIndex i={i} />
                          <span className="line-clamp-2 break-words text-right">{c.name}</span>
                        </span>
                        {i > 0 ? (
                          <button
                            type="button"
                            className="mt-0.5 text-[10.5px] font-medium tracking-normal text-ink-3 normal-case underline hover:text-ink pointer-coarse:-my-4 pointer-coarse:py-4"
                            onClick={() => makeBaseline(c.id)}
                          >
                            Make baseline
                          </button>
                        ) : (
                          <span className="mt-0.5 block text-[10.5px] font-medium tracking-normal text-ink-3 normal-case">
                            Baseline
                          </span>
                        )}
                      </TH>
                    ))}
                  </TR>
                </THead>
                <TBody>
                  {[...ROWS].map((row) => (
                    <TR key={row.key}>
                      <TD className="px-2 text-ink-2 sm:px-3">{row.label}</TD>
                      {metrics.map((m, i) => {
                        const v = m ? (m[row.key] as number | null) : null;
                        const b = metrics[0] ? (metrics[0][row.key] as number | null) : null;
                        const d = i > 0 && v !== null && b !== null ? v - b : null;
                        const good =
                          d === null || Math.abs(d) < 1e-9 || !row.better
                            ? null
                            : row.better === "higher"
                              ? d > 0
                              : d < 0;
                        return (
                          <TD key={chosen[i]!.id} numeric className="px-2 sm:px-3">
                            <div>{fmt(row.kind, v)}</div>
                            {d !== null && Math.abs(d) > 1e-9 ? (
                              <div
                                className={cn(
                                  "text-[11px]",
                                  good === null
                                    ? "text-ink-3"
                                    : good
                                      ? "text-positive"
                                      : "text-negative",
                                )}
                              >
                                {d > 0 ? "+" : "−"}
                                {row.kind === "year"
                                  ? `${Math.abs(d)} yr`
                                  : fmt(row.kind, Math.abs(d))}
                              </div>
                            ) : null}
                          </TD>
                        );
                      })}
                    </TR>
                  ))}
                  <TR>
                    <TD className="px-2 text-ink-2 sm:px-3">Chance of success</TD>
                    {chosen.map((c) => {
                      const e = mcByPlan[c.id];
                      return (
                        <TD key={c.id} numeric className="px-2 sm:px-3">
                          {e && e.planVersion === c.plan.version ? (
                            `${f.percent(e.result.successRate, 0)}${e.example ? " (example)" : ""}`
                          ) : (
                            <span className="text-ink-3">not run</span>
                          )}
                        </TD>
                      );
                    })}
                  </TR>
                </TBody>
              </Table>
            </div>
            <div className="border-t border-border px-4 py-2 text-[11.5px] text-ink-3">
              Money in today's terms. Green/red marks better/worse than the baseline where there is
              a clear direction.
            </div>
          </Card>

          <div className="grid gap-5 lg:grid-cols-2">
            <Card>
              <CardHeader
                eyebrow="What differs"
                title="Changes from the baseline"
                actions={
                  exampleDiffs ? <ExampleBadge onExit={() => setExampleDiffs(false)} /> : null
                }
              />
              <CardBody className="flex flex-col gap-4">
                {diffs.map(({ c, changes, error }) => (
                  <div key={c.id}>
                    <div className="mb-1 font-semibold">{c.name}</div>
                    {changes ? (
                      changes.length ? (
                        <ul className="flex flex-col gap-1 text-[13px]">
                          {changes.map((ch) => (
                            <li key={ch.path + ch.description} className="flex gap-1.5">
                              <span
                                className={
                                  ch.kind === "removed"
                                    ? "text-negative"
                                    : ch.kind === "added"
                                      ? "text-positive"
                                      : "text-ochre"
                                }
                              >
                                {ch.kind === "removed" ? "−" : ch.kind === "added" ? "+" : "~"}
                              </span>
                              {ch.description}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <div className="text-[12.5px] text-ink-3">
                          No differences in plan settings.
                        </div>
                      )
                    ) : (
                      <NotAvailable
                        className="py-4"
                        what="Plan diff"
                        error={error}
                        onPreview={() => setExampleDiffs(true)}
                      />
                    )}
                  </div>
                ))}
              </CardBody>
            </Card>
            <Card>
              <CardHeader eyebrow="Attribution" title="Where the difference comes from" />
              <CardBody className="flex flex-col gap-4">
                {baseResult
                  ? chosen.slice(1).map((c, k) => {
                      const r = results[k + 1];
                      if (!r) return null;
                      const a = attributeDifference(baseResult, r);
                      const max = Math.max(1, ...a.parts.map((p) => Math.abs(p.value)));
                      const exp = attempt(() =>
                        bridge.explainDifference(
                          baseResult,
                          r,
                          bridge.diffPlans(
                            base!.plan,
                            c.plan,
                            diffFormat(doc, f.locale, f.currency),
                          ),
                        ),
                      );
                      return (
                        <div key={c.id}>
                          <div className="mb-1 flex items-baseline justify-between gap-2">
                            <span className="font-semibold">{c.name}</span>
                            <span
                              className={cn(
                                "num text-[13px] font-semibold",
                                Math.abs(a.total) < 0.5
                                  ? "text-ink-3"
                                  : a.total > 0
                                    ? "text-positive"
                                    : "text-negative",
                              )}
                            >
                              {Math.abs(a.total) < 0.5
                                ? "Same end net worth"
                                : `${formatSigned(a.total, (v) => f.money(v, true))} end net worth`}
                            </span>
                          </div>
                          {exp.value ? (
                            <p className="mb-2 text-[12.5px] text-ink-2">{exp.value.headline}</p>
                          ) : null}
                          <div className="flex flex-col gap-1">
                            {a.parts.map((p) => (
                              <div
                                key={p.label}
                                className="grid grid-cols-[150px_1fr_86px] items-center gap-2 text-[12.5px]"
                              >
                                <span className="text-ink-2">{p.label}</span>
                                <span className="relative h-3">
                                  <span className="absolute top-0 left-1/2 h-full w-px bg-border" />
                                  <span
                                    className={cn(
                                      "absolute top-0 h-full rounded-[3px]",
                                      p.value >= 0 ? "bg-positive/70" : "bg-negative/70",
                                    )}
                                    style={
                                      p.value >= 0
                                        ? { left: "50%", width: `${(p.value / max) * 50}%` }
                                        : { right: "50%", width: `${(-p.value / max) * 50}%` }
                                    }
                                  />
                                </span>
                                <span className="num text-right">
                                  {p.value >= 0 ? "+" : "−"}
                                  {f.money(Math.abs(p.value), true)}
                                </span>
                              </div>
                            ))}
                          </div>
                        </div>
                      );
                    })
                  : null}
                <p className="text-[11.5px] text-ink-3">
                  Lifetime totals in today's money versus the baseline. Positive bars add to the
                  final net worth.
                </p>
              </CardBody>
            </Card>
          </div>
          <div className="flex flex-wrap gap-2">
            {chosen
              .filter((c) => c.kind === "plan")
              .map((c) => (
                <Button key={c.id} size="sm" variant="ghost" onClick={() => setActive(c.id)}>
                  Make “{c.name}” the active plan
                </Button>
              ))}
          </div>
        </>
      ) : null}
    </Page>
  );
}

function SwatchIndex({ i }: { i: number }) {
  const theme = useResolvedTheme();
  return (
    <span
      aria-hidden
      className="inline-block h-[3px] w-3 rounded"
      style={
        i === 0
          ? {
              background:
                "repeating-linear-gradient(90deg, var(--ink-3) 0 3px, transparent 3px 5px)",
            }
          : { background: slotColor(theme, [0, 2, 1, 4][i - 1]!) }
      }
    />
  );
}
