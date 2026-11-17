/**
 * Print-optimised plan report (browser print → PDF): summary, assumptions, charts, milestones,
 * a year-by-year table and caveats. Printing always uses the light theme.
 */
import { ENGINE_VERSION, type Plan, type RateSpec, SAMPLING_METHOD_LABEL } from "@glideworth/core";
import { Download, Printer } from "lucide-react";
import { useMemo } from "react";
import { taxKindColor } from "../../components/charts/palette";
import { SeriesChart } from "../../components/charts/series-chart";
import { ChartLoading, ErrorState } from "../../components/charts/states";
import { Button } from "../../components/ui/button";
import { ScrollRegion } from "../../components/ui/table";
import { formatMonth } from "../../lib/format";
import { periodShortLabel } from "../../lib/period";
import { useFormat } from "../../lib/workspace";
import { useUi } from "../../stores/ui";
import { useMcStore } from "../chance/mc-store";
import { fiMetrics } from "../dashboard/dashboard-view";
import { cellValue, conv, downloadText, projectionCsv, tableColumns } from "../results/model";
import { ProjectionChart } from "../results/projection-chart";
import { useAnalysis } from "../results/use-analysis";
import { byKindSeries, kindLabel, taxRegime } from "../taxes/tax-model";

const PRINT_CSS = `
@media print {
  @page { size: A4; margin: 14mm 12mm; }
  html, body { background: #fff !important; }
  .h-dvh { height: auto !important; overflow: visible !important; display: block !important; background: #fff !important; }
  main { overflow: visible !important; }
  aside, .min-w-0 > header { display: none !important; }
  .report-noprint { display: none !important; }
  .report-page { max-width: none !important; padding: 0 !important; }
  .report-block { break-inside: avoid; page-break-inside: avoid; }
  .report-break { break-before: page; }
  .report-page canvas { max-width: 100% !important; }
  .report-table th, .report-table td { padding: 2px 6px !important; font-size: 9.5px !important; }
}`;

function rate(spec: RateSpec, pct: (v: number) => string): string {
  switch (spec.kind) {
    case "none":
      return "none";
    case "fixed":
      return `${pct(spec.rate)} a year`;
    case "schedule":
      return `schedule (${spec.points.length} steps)`;
    case "historical":
      return `historical from ${spec.startYear}`;
  }
}

function Section({
  title,
  children,
  className,
}: {
  title: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`report-block flex flex-col gap-2 ${className ?? ""}`}>
      <h2 className="display border-b border-border pb-1 text-[17px] font-semibold">{title}</h2>
      {children}
    </section>
  );
}

export function assumptionsRows(plan: Plan, pct: (v: number) => string): [string, string][] {
  const a = plan.assumptions;
  return [
    ["Inflation", rate(a.inflation, pct)],
    ["Stock growth (ex dividends)", rate(a.stockReturn, pct)],
    ["Dividend yield", rate(a.dividendYield, pct)],
    ["Bond return", rate(a.bondReturn, pct)],
    ["Cash return", rate(a.cashReturn, pct)],
    [
      "Bond allocation",
      a.bondAllocation.kind === "fixed" ? pct(a.bondAllocation.share) : a.bondAllocation.kind,
    ],
    [
      "Tax method",
      plan.tax.mode === "flat"
        ? `Flat rates (income ${pct(plan.tax.flat.ordinary)}, gains ${pct(plan.tax.flat.capitalGains)})`
        : plan.tax.mode === "custom"
          ? "Custom brackets"
          : "Estimated from location",
    ],
    [
      "Chance-of-success method",
      `${SAMPLING_METHOD_LABEL[plan.monteCarlo.method] ?? plan.monteCarlo.method}, ${plan.monteCarlo.trials} trials`,
    ],
  ];
}

export function ReportView() {
  const { plan, doc, result, isLoading, error, index, basis } = useAnalysis();
  const f = useFormat();
  const theme = useUi((s) => s.theme);
  const setTheme = useUi((s) => s.setTheme);
  const mcEntry = useMcStore((s) => (plan ? s.byPlan[plan.id] : undefined));
  const mc = mcEntry && mcEntry.planVersion === plan?.version ? mcEntry : undefined;
  const fi = result ? fiMetrics(result, plan) : null;
  const cols = useMemo(() => {
    if (!result) return [];
    const all = tableColumns(result, index);
    const keep = [
      "year",
      ...index.people.map((p) => `age:${p.id}`),
      "income",
      "spending",
      "taxes",
      "contributions",
      "withdrawals",
      "netWorth",
    ];
    return keep
      .map((k) => all.find((c) => c.id === k))
      .filter((c): c is NonNullable<typeof c> => !!c);
  }, [result, index]);
  const regime = taxRegime(plan, doc?.household.location.country, result);
  const taxSeries = useMemo(
    () => (result ? byKindSeries(result, basis, "kind") : []),
    [result, basis],
  );
  const generated = new Intl.DateTimeFormat(f.locale, { dateStyle: "long" }).format(new Date());

  const print = () => {
    const prev = theme;
    const dark = document.documentElement.dataset.theme === "dark";
    if (dark) setTheme("light");
    setTimeout(
      () => {
        window.print();
        if (dark) setTheme(prev);
      },
      dark ? 500 : 0,
    );
  };

  const last = result?.periods.at(-1);
  return (
    <div className="report-page mx-auto flex w-full max-w-[960px] flex-col gap-6 px-6 py-6">
      <style>{PRINT_CSS}</style>
      <div className="report-noprint flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-surface px-4 py-2.5 shadow-card">
        <span className="text-[12.5px] text-ink-2">
          Print or save as PDF from your browser. Printing uses the light theme and A4 pages.
        </span>
        <div className="flex gap-2">
          {result ? (
            <Button
              size="sm"
              variant="secondary"
              onClick={() =>
                downloadText(
                  `glideworth-report-${plan?.id}.csv`,
                  projectionCsv(result, cols, basis, f.currency),
                )
              }
            >
              <Download /> Table CSV
            </Button>
          ) : null}
          <Button size="sm" variant="primary" onClick={print} disabled={!result}>
            <Printer /> Print / PDF
          </Button>
        </div>
      </div>
      {isLoading ? <ChartLoading /> : null}
      {error ? <ErrorState error={error} /> : null}
      {result && plan && doc && last ? (
        <>
          <header className="report-block flex flex-col gap-1">
            <div className="eyebrow">Glideworth plan report</div>
            <h1 className="display text-[30px] leading-tight font-semibold">{plan.name}</h1>
            <div className="text-[13px] text-ink-2">
              {doc.household.name} · prepared {generated} ·{" "}
              {basis === "real" ? "amounts in today's money" : "amounts in future (nominal) money"}{" "}
              · {f.currency}
            </div>
            {plan.description ? (
              <p className="mt-1 max-w-2xl text-[13px]">{plan.description}</p>
            ) : null}
          </header>

          <Section title="Summary">
            <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3">
              {(
                [
                  [
                    "Outcome",
                    result.summary.success
                      ? "Every year funded"
                      : `Short from ${result.summary.firstShortfallYear}`,
                  ],
                  ["Retirement", fi?.retireMonth ? formatMonth(fi.retireMonth, f.locale) : "—"],
                  [
                    "Financial independence",
                    fi?.fiMonth ? formatMonth(fi.fiMonth, f.locale) : "Not reached",
                  ],
                  [
                    `Net worth in ${last.year}`,
                    f.money(conv(last, last.totals.netWorth, basis, "netWorth"), true),
                  ],
                  [
                    "Lifetime taxes",
                    f.money(
                      basis === "real"
                        ? result.summary.lifetimeTaxesReal
                        : result.summary.lifetimeTaxes,
                      true,
                    ),
                  ],
                  [
                    "Chance of success",
                    mc
                      ? `${f.percent(mc.result.successRate, 0)}${mc.example ? " (example data)" : ` · ${mc.result.trials} trials`}`
                      : "Not run",
                  ],
                ] as const
              ).map(([k, v]) => (
                <div key={k}>
                  <div className="eyebrow">{k}</div>
                  <div className="num text-[16px] font-semibold">{v}</div>
                </div>
              ))}
            </div>
          </Section>

          <Section title="Net worth projection">
            <ProjectionChart
              result={result}
              basis={basis}
              locale={f.locale}
              currency={f.currency}
              index={index}
              plan={plan}
              mode="netWorth"
              kind="bar"
              compact
              legend
              height={300}
            />
          </Section>

          <div className="grid gap-6 md:grid-cols-2">
            <Section title="Income and outgoings">
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
                legend
                height={220}
              />
            </Section>
            <Section title="Taxes by type">
              <SeriesChart
                labels={result.periods.map((p) => periodShortLabel(p))}
                format="money"
                locale={f.locale}
                currency={f.currency}
                height={220}
                ariaLabel="Taxes by type each year"
                series={taxSeries.map((s) => ({
                  name: kindLabel(s.key, regime),
                  color: (t) => taxKindColor(t.theme, s.key),
                  type: "bar" as const,
                  stack: "t",
                  values: s.values,
                }))}
              />
            </Section>
          </div>

          <div className="grid gap-6 md:grid-cols-2">
            <Section title="Milestones">
              <table className="report-table w-full text-[12.5px]">
                <tbody>
                  {result.milestones.map((m) => (
                    <tr key={m.milestoneId} className="border-b border-border last:border-0">
                      <td className="py-1">{m.name}</td>
                      <td className="num py-1 text-right">
                        {m.month ? formatMonth(m.month, f.locale) : "Never"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Section>
            <Section title="Key assumptions">
              <table className="report-table w-full text-[12.5px]">
                <tbody>
                  {assumptionsRows(plan, (v) => f.percent(v)).map(([k, v]) => (
                    <tr key={k} className="border-b border-border last:border-0">
                      <td className="py-1 text-ink-2">{k}</td>
                      <td className="py-1 text-right">{v}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Section>
          </div>

          <Section title="Year by year" className="report-break">
            {/* (i) a11y sweep: scroll horizontally on phones instead of widening the page */}
            <ScrollRegion label="Year by year table, scrolls sideways if it does not fit">
              <table className="report-table w-full border-collapse text-[11.5px]">
                <thead>
                  <tr className="border-b border-border-strong">
                    {cols.map((c) => (
                      <th
                        key={c.id}
                        className={`px-1.5 py-1 font-semibold text-ink-2 ${c.kind === "year" ? "text-left" : "text-right"}`}
                      >
                        {c.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.periods.map((p) => (
                    <tr
                      key={p.index}
                      className={`border-b border-border ${p.status === "shortfall" ? "text-negative" : ""}`}
                    >
                      {cols.map((c) => {
                        const v = cellValue(c, p, basis);
                        return (
                          <td
                            key={c.id}
                            className={`num px-1.5 py-[3px] ${c.kind === "year" ? "text-left" : "text-right"}`}
                          >
                            {v === null
                              ? "—"
                              : c.kind === "money" && typeof v === "number"
                                ? f.money(v)
                                : String(v)}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </ScrollRegion>
          </Section>

          <Section title="Warnings and caveats">
            <ul className="list-disc pl-5 text-[12.5px] leading-relaxed text-ink-2">
              {result.warnings
                .filter((w) => w.severity !== "info")
                .slice(0, 8)
                .map((w) => (
                  <li key={w.message}>{w.message}</li>
                ))}
              <li>
                This is a deterministic projection: markets grow at the plan's assumed rates every
                year. Real outcomes vary; see the chance-of-success analysis.
              </li>
              <li>
                {basis === "real"
                  ? "Amounts are in today's money: future values are divided by cumulative assumed inflation since the plan start."
                  : "Amounts are nominal (future money) and include inflation."}
              </li>
              <li>
                Tax figures are estimates from the plan's tax settings, not tax advice. This report
                is for planning only and is not financial advice.
              </li>
              <li>
                Engine {ENGINE_VERSION}; plan version {plan.version}; projection from{" "}
                {result.meta.startMonth} to {result.meta.endMonth}.
              </li>
            </ul>
          </Section>
        </>
      ) : null}
    </div>
  );
}
