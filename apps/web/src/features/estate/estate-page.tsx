import type { GlideworthDocument, Plan, ProjectionResult, ValueBasis } from "@glideworth/core";
import { ExternalLink } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { SeriesChart } from "../../components/charts/series-chart";
import { ChartLoading, EmptyState, ErrorState } from "../../components/charts/states";
import { Page } from "../../components/layout/app-shell";
import { Badge } from "../../components/ui/badge";
import { Card, CardBody, CardHeader } from "../../components/ui/card";
import { Stat } from "../../components/ui/stat";
import { Table, TBody, TD, TH, THead, TR } from "../../components/ui/table";
import { useViewFormat as useFormat } from "../results/format-context";
import { agesLabel, conv, type EntityIndex } from "../results/model";
import { useAnalysis } from "../results/use-analysis";
import { type EstateYear, estateRegime, estateSeries, passesToWhom } from "./estate-model";

function EstateBody({
  doc,
  plan,
  result,
  index,
  basis,
}: {
  doc: GlideworthDocument;
  plan: Plan;
  result: ProjectionResult;
  index: EntityIndex;
  basis: ValueBasis;
}) {
  const f = useFormat();
  const regime = estateRegime(doc);
  const couple = doc.household.people.length > 1;
  const years = useMemo(
    () => estateSeries(doc, plan, result, { transferAllowances: couple }),
    [doc, plan, result, couple],
  );
  const [sel, setSel] = useState(() => {
    const at = result.periods.findIndex((p) => p.months === 12);
    return Math.max(0, at);
  });
  const onPick = useCallback((i: number) => setSel(i), []);
  const i = Math.min(sel, years.length - 1);
  const y = years[i]!;
  const p = result.periods[i]!;
  const last = years[years.length - 1]!;
  const lastP = result.periods[result.periods.length - 1]!;
  const labels = useMemo(() => years.map((x) => String(x.year)), [years]);
  const vals = (pick: (x: EstateYear) => number) =>
    years.map((x, k) => conv(result.periods[k]!, pick(x), basis, "stock"));
  const m = (v: number, compact = false) => f.money(conv(p, v, basis, "stock"), compact);
  const rows = useMemo(() => passesToWhom(doc, result, y, regime), [doc, result, y, regime]);
  const settings = plan.tax.estate;
  const money = (v: number) => m(Math.abs(v) < 0.5 ? 0 : v);

  return (
    <>
      <div className="grid grid-cols-2 gap-x-4 sm:gap-x-6 gap-y-4 rounded-[var(--radius-card)] border border-border bg-surface px-5 py-4 shadow-card md:grid-cols-4">
        <Stat
          label={`Estate in ${y.year}`}
          value={m(y.estate, true)}
          sub={basis === "real" ? "Today's money" : "Future money"}
        />
        <Stat
          label={regime === "none" ? "Estate tax" : y.taxName}
          value={regime === "none" ? "Not modelled" : m(y.estateTax, true)}
          sub={
            regime === "none"
              ? "No estate-tax model for this country"
              : `${f.percent(y.taxRate)} of the estate`
          }
        />
        <Stat
          label="Net legacy to heirs"
          value={m(y.toHeirs, true)}
          sub="After tax, costs and charity"
        />
        <Stat
          label={`At the end of the plan (${last.year})`}
          value={f.money(conv(lastP, last.toHeirs, basis, "stock"), true)}
          sub={`${f.money(conv(lastP, last.estate, basis, "stock"), true)} estate`}
        />
      </div>

      <Card>
        <CardHeader
          eyebrow="Over time"
          title="Estate value and what reaches your heirs"
          actions={
            <input
              type="range"
              min={0}
              max={years.length - 1}
              value={i}
              aria-label="Year of death"
              aria-valuetext={String(y.year)}
              onChange={(e) => setSel(Number(e.target.value))}
              className="w-[160px] accent-[var(--accent)] sm:w-[260px]"
            />
          }
        />
        <CardBody>
          <SeriesChart
            labels={labels}
            format="money"
            locale={f.locale}
            currency={f.currency}
            height={320}
            zoom
            ariaLabel="Estate value each year, split into what reaches heirs, charity, tax and costs"
            onClickIndex={onPick}
            markers={[{ index: i, label: "", tone: "accent" }]}
            series={[
              {
                name: "To heirs",
                color: (t) => t.accent,
                type: "area",
                stack: "e",
                values: vals((x) => Math.max(0, x.toHeirs)),
              },
              {
                name: "To charity",
                color: (t) => t.positive ?? t.accent,
                type: "area",
                stack: "e",
                values: vals((x) => x.toCharity),
              },
              {
                name: y.taxName,
                color: (t) => t.negative,
                type: "area",
                stack: "e",
                values: vals((x) => x.estateTax),
              },
              {
                name: "Heirs' tax and costs",
                color: (t) => t.ochre,
                type: "area",
                stack: "e",
                values: vals(
                  (x) => x.heirIncomeTax + x.embeddedGainsTax + x.liquidationCosts + x.adminCosts,
                ),
              },
            ]}
            tooltipExtra={(k) =>
              `<div style="margin-top:4px;opacity:.75">Estate ${f.money(conv(result.periods[k]!, years[k]!.estate, basis, "stock"))}</div>`
            }
          />
          <p className="mt-1 text-[11.5px] text-ink-3">
            Each year shows what would happen if the last surviving person died at the end of that
            year. The stack adds up to the estate (assets less debts). Click a year to inspect it.
          </p>
        </CardBody>
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader eyebrow="What the estate is made of" title="Estate by account type" />
          <CardBody>
            <SeriesChart
              labels={labels}
              format="money"
              locale={f.locale}
              currency={f.currency}
              height={260}
              ariaLabel="Estate composition by tax treatment each year"
              onClickIndex={onPick}
              series={[
                {
                  name: "Cash",
                  color: (t) => t.stone,
                  type: "bar",
                  stack: "c",
                  values: vals((x) => x.cash),
                },
                {
                  name: "Taxable",
                  color: (t) => t.ochre,
                  type: "bar",
                  stack: "c",
                  values: vals((x) => x.taxable),
                },
                {
                  name: "Tax-free",
                  color: (t) => t.accent,
                  type: "bar",
                  stack: "c",
                  values: vals((x) => x.taxFree),
                },
                {
                  name: "Pensions and tax-deferred",
                  color: (t) => t.ink2,
                  type: "bar",
                  stack: "c",
                  values: vals((x) => x.taxDeferred),
                },
                {
                  name: "Property and other assets",
                  color: (t) => t.ink3,
                  type: "bar",
                  stack: "c",
                  values: vals((x) => x.realEstate),
                },
                {
                  name: "Debts",
                  color: (t) => t.negative,
                  type: "bar",
                  stack: "c",
                  values: vals((x) => -x.debts),
                },
              ]}
            />
          </CardBody>
        </Card>
        <Card>
          <CardHeader
            eyebrow="Tax"
            title={regime === "none" ? "Estate tax" : `${y.taxName} by year of death`}
          />
          <CardBody>
            {regime === "none" ? (
              <EmptyState title="No estate-tax model for this country">
                Net legacy still deducts selling costs, administration and the heirs' tax on
                pensions and gains from the plan's estate settings.
              </EmptyState>
            ) : (
              <SeriesChart
                labels={labels}
                format="money"
                locale={f.locale}
                currency={f.currency}
                height={260}
                ariaLabel={`${y.taxName} owed if death occurred at the end of each year`}
                onClickIndex={onPick}
                markers={[{ index: i, label: "", tone: "accent" }]}
                series={[
                  {
                    name: y.taxName,
                    color: (t) => t.negative,
                    type: "bar",
                    values: vals((x) => x.estateTax),
                  },
                ]}
              />
            )}
            {regime === "uk" ? (
              <p className="mt-1 text-[11.5px] text-ink-3">
                Nil-rate bands are frozen to April 2030 and then follow the plan's threshold policy.
                {couple ? " Unused bands from the first death are assumed to transfer." : ""}
              </p>
            ) : null}
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader
          eyebrow="Selected year"
          title={`${y.year} · ${agesLabel(p, index.people)}`}
          actions={
            y.source ? (
              <a
                href={y.source}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-[12px] text-accent hover:underline"
              >
                <ExternalLink className="size-3" /> Rules
              </a>
            ) : null
          }
        />
        <CardBody className="grid gap-6 lg:grid-cols-2">
          <div className="flex flex-col gap-2">
            <div className="text-[13px] font-semibold">From estate to net legacy</div>
            <Table>
              <TBody>
                <TR>
                  <TD>Assets</TD>
                  <TD numeric>{money(y.assets)}</TD>
                </TR>
                <TR>
                  <TD>Debts</TD>
                  <TD numeric>{money(-y.debts)}</TD>
                </TR>
                <TR>
                  <TD className="font-semibold">Estate</TD>
                  <TD numeric className="font-semibold">
                    {money(y.estate)}
                  </TD>
                </TR>
                <TR>
                  <TD>{y.taxName}</TD>
                  <TD numeric>{money(-y.estateTax)}</TD>
                </TR>
                <TR>
                  <TD>
                    Heirs' income tax on pensions ({f.percent(settings.heirTaxDeferredRate, 0)})
                  </TD>
                  <TD numeric>{money(-y.heirIncomeTax)}</TD>
                </TR>
                <TR>
                  <TD>
                    Capital gains on taxable accounts{" "}
                    {settings.stepUpBasis ? (
                      <span className="text-ink-3">(basis stepped up)</span>
                    ) : null}
                  </TD>
                  <TD numeric>{money(-y.embeddedGainsTax)}</TD>
                </TR>
                <TR>
                  <TD>Selling costs on property ({f.percent(settings.liquidationCostRate, 0)})</TD>
                  <TD numeric>{money(-y.liquidationCosts)}</TD>
                </TR>
                <TR>
                  <TD>Administration ({f.percent(settings.adminCostRate, 0)})</TD>
                  <TD numeric>{money(-y.adminCosts)}</TD>
                </TR>
                <TR>
                  <TD className="font-semibold">Net legacy</TD>
                  <TD numeric className="font-semibold">
                    {money(y.netLegacy)}
                  </TD>
                </TR>
              </TBody>
            </Table>
            <p className="text-[11.5px] text-ink-3">
              Rates come from the plan's tax settings (estate). Change them in the plan editor under
              Taxes.
            </p>
          </div>
          <div className="flex flex-col gap-2">
            {y.detail.length > 0 ? (
              <>
                <div className="text-[13px] font-semibold">{y.taxName} working</div>
                <Table>
                  <TBody>
                    {y.detail.map((d) => (
                      <TR key={d.label}>
                        <TD>
                          {d.label}
                          {d.note ? <div className="text-[11px] text-ink-3">{d.note}</div> : null}
                        </TD>
                        <TD numeric>{typeof d.value === "number" ? money(d.value) : d.value}</TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </>
            ) : null}
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          eyebrow={couple ? "Couple" : "Heirs"}
          title="What passes to whom"
          actions={couple ? <Badge tone="accent">{y.year}</Badge> : undefined}
        />
        <CardBody>
          <Table>
            <THead>
              <TR>
                <TH>Event</TH>
                <TH>From</TH>
                <TH>To</TH>
                <TH numeric>Amount</TH>
                <TH numeric>Tax</TH>
                <TH className="hidden md:table-cell">Notes</TH>
              </TR>
            </THead>
            <TBody>
              {rows.map((r) => (
                <TR key={`${r.stage}-${r.to}`}>
                  <TD>{r.stage}</TD>
                  <TD>{r.from}</TD>
                  <TD>{r.to}</TD>
                  <TD numeric>{money(r.amount)}</TD>
                  <TD numeric>{r.tax > 0 ? money(r.tax) : "—"}</TD>
                  <TD className="hidden text-[11.5px] text-ink-3 md:table-cell">{r.note}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
          <p className="mt-2 text-[11.5px] text-ink-3">
            This is a planning estimate, not legal or tax advice. It assumes everything is left to
            the partner first and then to heirs, with no lifetime gifts or trusts.
          </p>
        </CardBody>
      </Card>
    </>
  );
}

export function EstateView() {
  const { plan, doc, result, isLoading, error, index, basis } = useAnalysis();
  return (
    <Page
      title="Estate and legacy"
      description={
        plan
          ? `What “${plan.name}” leaves behind if the last survivor died in each year: estate tax, costs and what reaches your heirs.`
          : undefined
      }
    >
      {isLoading ? <ChartLoading /> : null}
      {error ? <ErrorState error={error} title="Simulation failed" /> : null}
      {result && plan && doc ? (
        <EstateBody doc={doc} plan={plan} result={result} index={index} basis={basis} />
      ) : null}
    </Page>
  );
}
