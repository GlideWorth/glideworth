import type {
  AnalyticsIncomeType,
  BracketFill,
  GlideworthDocument,
  PeriodResult,
  Plan,
  ProjectionResult,
  SimulationInput,
  TaxJurisdiction,
  ValueBasis,
} from "@glideworth/core";
import { ExternalLink } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { ShareBar } from "../../components/charts/mini";
import { slotColor, taxKindColor } from "../../components/charts/palette";
import { SeriesChart } from "../../components/charts/series-chart";
import { ChartLoading, EmptyState, ErrorState } from "../../components/charts/states";
import type { ChartTokens } from "../../components/charts/tokens";
import { Page } from "../../components/layout/app-shell";
import { Badge } from "../../components/ui/badge";
import { Card, CardBody, CardHeader } from "../../components/ui/card";
import { Segmented } from "../../components/ui/segmented";
import { Select } from "../../components/ui/select";
import { Stat } from "../../components/ui/stat";
import { Table, TBody, TD, TH, THead, TR } from "../../components/ui/table";
import { countryLabel } from "../../lib/countries";
import { periodShortLabel } from "../../lib/period";
import { useResolvedTheme } from "../../lib/theme";
import {
  CrossBorderCaveats,
  CrossBorderTaxCard,
  ItemTaxationPanel,
} from "../crossborder/tax-by-country";
import { useViewFormat as useFormat } from "../results/format-context";
import { agesLabel, conv, type EntityIndex } from "../results/model";
import { useAnalysis } from "../results/use-analysis";
import { IncomeByRateCard } from "./income-by-rate";
import {
  analyseYear,
  MARGINAL_TYPES,
  marginalOverTime,
  progressionFor,
  resolveTaxStack,
  type TaxSource,
  taxSources,
} from "./tax-analytics";
import {
  byKindSeries,
  compositionSeries,
  kindLabel,
  lifetimeByLabel,
  type TaxRegime,
  taxRegime,
  weightedEffectiveRate,
} from "./tax-model";
import { jurisdictionLabel, TaxSimplifications } from "./tax-notes";

const SCHEDULE_LABEL: Record<string, string> = {
  "non-savings": "Earned, pension and rental income",
  savings: "Savings interest",
  dividends: "Dividends",
  "capital-gains": "Capital gains",
  ordinary: "Ordinary income",
  preferential: "Long-term gains and qualified dividends",
};
const scheduleLabel = (s: string) => SCHEDULE_LABEL[s] ?? s.replace(/-/g, " ");

/** How the year's income fills each rate band, straight from core's `explainYear` bracket data. */
function BracketFillView({
  fills,
  index,
  p,
  basis,
}: {
  fills: BracketFill[];
  index: EntityIndex;
  p: PeriodResult;
  basis: ValueBasis;
}) {
  const f = useFormat();
  const meaningful = fills.filter(
    (x) => x.bands.some((b) => b.amount > 0.5) || x.schedule === "non-savings",
  );
  const [pick, setPick] = useState(0);
  if (meaningful.length === 0)
    return (
      <EmptyState title="No bands to show">
        This plan's tax set-up has no progressive bands for this year (flat-rate estimates or no
        taxable income). Switch the plan to estimated or custom taxes to see how income fills each
        band.
      </EmptyState>
    );
  const cur = meaningful[Math.min(pick, meaningful.length - 1)]!;
  const m = (v: number) => f.money(conv(p, v, basis, "flow"));
  const person = cur.personId ? index.people.find((x) => x.id === cur.personId)?.name : undefined;
  const finite = cur.bands.filter((b) => Number.isFinite(b.to));
  const top = Math.max(
    ...cur.bands.map((b) => b.from + b.amount),
    ...finite.map((b) => b.to * 0.5),
    1,
  );
  const used = cur.bands.reduce((s, b) => s + b.amount, 0);
  const taxTotal = cur.bands.reduce((s, b) => s + b.tax, 0);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-[13px] font-semibold">
            {scheduleLabel(cur.schedule)}
            {person ? ` · ${person}` : ""}
          </div>
          <div className="text-[11.5px] text-ink-3">
            {cur.jurisdictionId} · bands indexed to {p.year}
          </div>
        </div>
        {meaningful.length > 1 ? (
          <Select
            aria-label="Income schedule"
            className="w-[210px]"
            value={String(Math.min(pick, meaningful.length - 1))}
            onValueChange={(v) => setPick(Number(v))}
            options={meaningful.map((x, i) => ({
              value: String(i),
              label: `${scheduleLabel(x.schedule)}${
                x.personId
                  ? ` · ${index.people.find((q) => q.id === x.personId)?.name ?? x.personId}`
                  : ""
              }`,
            }))}
          />
        ) : null}
      </div>
      <fieldset className="flex flex-col gap-1.5">
        <legend className="sr-only">Income by tax band</legend>
        {cur.bands.map((b, i) => {
          const width = Number.isFinite(b.to) ? b.to - b.from : Math.max(0, top - b.from);
          const pct = width > 0 ? Math.min(1, b.amount / width) : 0;
          return (
            <div
              key={`${b.label}-${b.from}`}
              className="grid grid-cols-[120px_1fr_96px] items-center gap-3 text-[12.5px] sm:grid-cols-[160px_1fr_120px]"
            >
              <div>
                <div className="font-medium">{b.label}</div>
                <div className="num text-[11px] text-ink-3">
                  {f.percent(b.rate, 1)} · {m(b.from)}
                  {Number.isFinite(b.to) ? `–${m(b.to)}` : "+"}
                </div>
              </div>
              <div className="h-4 overflow-hidden rounded-[4px] bg-surface-2">
                <div
                  className="h-full rounded-[4px] transition-[width]"
                  style={{
                    width: `${pct * 100}%`,
                    background: `color-mix(in oklab, var(--accent) ${30 + Math.min(i, 5) * 14}%, var(--ochre))`,
                  }}
                />
              </div>
              <div className="num text-right">
                {b.amount > 0.5 ? m(b.amount) : <span className="text-ink-3">—</span>}
              </div>
            </div>
          );
        })}
      </fieldset>
      <div className="text-[12px] text-ink-2">
        <span className="num font-semibold">{m(used)}</span> in bands,{" "}
        <span className="num font-semibold">{m(taxTotal)}</span> tax on this schedule. Marginal rate
        this year <span className="num font-semibold">{f.percent(p.taxes.marginalRate)}</span>.
      </div>
    </div>
  );
}

const REGIME_NOTE: Record<TaxRegime, string> = {
  uk: "UK: Income Tax (England/Wales/NI or Scottish bands), National Insurance, savings and dividend allowances, Capital Gains Tax, pension tax relief, the High Income Child Benefit Charge and student loan repayments, all per person. ISA income and withdrawals are tax-free; pension withdrawals are 25% tax-free up to the lump sum allowance.",
  us: "US: federal and state income tax, FICA payroll tax, net investment income tax, IRMAA and early-withdrawal penalties appear as they apply.",
  ca: "Canada: federal and provincial income tax, the capital gains inclusion rate, dividend gross-up and credits, OAS recovery tax and RRIF minimums appear as they apply.",
  au: "Australia: resident income tax, Medicare levy, franking credits, the capital gains discount and superannuation tax appear as they apply.",
  custom:
    "Your own bracket tables and rates from the plan tax settings. There is no statutory data behind these figures.",
  flat: "Flat effective rates from the plan tax settings. There are no brackets or allowances behind these figures.",
  other:
    "No estimate preset exists for this country; use flat or custom taxes in the plan settings.",
};

function JurisdictionDetail({
  result,
  p,
  regime,
  basis,
}: {
  result: ProjectionResult;
  p: PeriodResult;
  regime: TaxRegime;
  basis: ValueBasis;
}) {
  const f = useFormat();
  const groups = new Map<string, { label: string; year: number; life: number }[]>();
  const lifetime = lifetimeByLabel(result, basis);
  for (const row of lifetime) {
    const year = p.taxes.lines
      .filter((l) => l.jurisdictionId === row.jurisdiction && l.label === row.label)
      .reduce((s, l) => s + conv(p, l.amount, basis, "flow"), 0);
    const g = groups.get(row.jurisdiction) ?? [];
    g.push({ label: row.label, year, life: row.total });
    groups.set(row.jurisdiction, g);
  }
  const relief = p.taxes.facts.pensionTaxRelief;
  const lifeRelief = result.periods.reduce(
    (s, x) => s + conv(x, x.taxes.facts.pensionTaxRelief ?? 0, basis, "flow"),
    0,
  );
  const jurName = (j: string) =>
    jurisdictionLabel(j) ??
    (j === "uk"
      ? "United Kingdom (HMRC)"
      : j === "flat"
        ? "Flat-rate estimate"
        : j === "custom"
          ? "Your custom rules"
          : j === "engine"
            ? "Glideworth engine charges"
            : j.startsWith("us-federal")
              ? "US federal"
              : j.startsWith("us-payroll")
                ? "US payroll (FICA)"
                : j.startsWith("us-state")
                  ? `US state ${j.split(":")[1] ?? ""}`.trim()
                  : j.startsWith("us-local")
                    ? `US local ${j.split(":")[1] ?? ""}`.trim()
                    : j === "ca-federal"
                      ? "Canada federal (CRA)"
                      : j.startsWith("ca-province")
                        ? `Canada province ${j.split(":")[1] ?? ""}`.trim()
                        : j === "au"
                          ? "Australia (ATO)"
                          : j);
  if (groups.size === 0) return <EmptyState title="No taxes in this plan" />;
  return (
    <div className="flex flex-col gap-4">
      {[...groups.entries()].map(([j, rows]) => (
        <div key={j}>
          <div className="mb-1 flex items-center gap-2">
            <span className="text-[13px] font-semibold">{jurName(j)}</span>
            {regime === "uk" && j === "uk" ? <Badge tone="accent">UK</Badge> : null}
          </div>
          <Table>
            <THead>
              <TR>
                <TH>Tax</TH>
                <TH numeric>{p.year}</TH>
                <TH numeric>Lifetime</TH>
              </TR>
            </THead>
            <TBody>
              {rows.map((r) => (
                <TR key={r.label}>
                  <TD>{r.label}</TD>
                  <TD numeric>{f.money(r.year)}</TD>
                  <TD numeric>{f.money(r.life)}</TD>
                </TR>
              ))}
              {j === "uk" && relief !== undefined ? (
                <TR>
                  <TD className="text-positive">Pension tax relief (added to pensions)</TD>
                  <TD numeric className="text-positive">
                    {f.money(conv(p, relief, basis, "flow"))}
                  </TD>
                  <TD numeric className="text-positive">
                    {f.money(lifeRelief)}
                  </TD>
                </TR>
              ) : null}
            </TBody>
          </Table>
        </div>
      ))}
      <p className="text-[11.5px] text-ink-3">{REGIME_NOTE[regime]}</p>
    </div>
  );
}

function SourcesCard({
  sources,
  plan,
  regime,
}: {
  sources: TaxSource[];
  plan: Plan | undefined;
  regime: TaxRegime;
}) {
  const policy = plan?.tax.thresholdIndexation ?? "legislated";
  return (
    <Card>
      <CardHeader eyebrow="Provenance" title="Tax data and sources" />
      <CardBody className="flex flex-col gap-3">
        {sources.length === 0 ? (
          <p className="text-[12.5px] text-ink-2">{REGIME_NOTE[regime]}</p>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {sources.map((s) => (
              <div key={s.jurisdiction} className="flex flex-col gap-1.5 text-[12.5px]">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold">{s.label}</span>
                  {s.years.length > 0 ? (
                    <Badge tone="accent">
                      {s.years.length === 1
                        ? `Tax year ${s.years[0]}`
                        : `Tax years ${s.years[0]} to ${s.years[s.years.length - 1]}`}
                    </Badge>
                  ) : (
                    <Badge>No statutory data</Badge>
                  )}
                </div>
                <ul className="flex flex-col gap-0.5">
                  {s.links.map((l) => (
                    <li key={l.url} className="truncate">
                      <a
                        href={l.url}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-accent hover:underline"
                      >
                        <ExternalLink className="size-3 shrink-0" />
                        <span className="truncate">
                          {l.note ?? l.url.replace(/^https?:\/\//, "")}
                        </span>
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
        <p className="text-[11.5px] text-ink-3">
          Years after the latest published tax year use the plan's threshold policy ({policy}):
          frozen, indexed with inflation, or the legislated freeze followed by indexing. These are
          estimates for planning, not tax advice.
        </p>
      </CardBody>
    </Card>
  );
}

function MarginalCards({
  doc,
  plan,
  result,
  stack,
  index,
  yearIdx,
  basis,
  labels,
  onPick,
  marginalByType,
  inputPriceIndex,
  progressionInput,
}: {
  doc: GlideworthDocument;
  plan: Plan;
  result: ProjectionResult;
  stack: TaxJurisdiction[];
  index: EntityIndex;
  yearIdx: number;
  basis: ValueBasis;
  labels: string[];
  onPick: (i: number) => void;
  marginalByType: Record<AnalyticsIncomeType, number> | undefined;
  inputPriceIndex: number;
  progressionInput: Parameters<typeof progressionFor>[1] | undefined;
}) {
  const f = useFormat();
  const p = result.periods[yearIdx]!;
  void index;
  const [type, setType] = useState<AnalyticsIncomeType>("ordinary");
  const over = useMemo(
    () => marginalOverTime(doc, plan, result, stack, type),
    [doc, plan, result, stack, type],
  );
  const prog = useMemo(() => {
    if (!progressionInput) return [];
    const upTo = Math.max(150_000 * inputPriceIndex, 1);
    return progressionFor(stack, progressionInput, type, upTo, upTo / 60);
  }, [stack, progressionInput, type, inputPriceIndex]);
  const typeLabel = MARGINAL_TYPES.find((t) => t.id === type)?.label ?? type;
  const toBasis = (v: number) => conv(p, v, basis, "flow");
  return (
    <>
      <Card>
        <CardHeader
          eyebrow="Rates"
          title="Marginal rate by income type"
          actions={
            <Select
              aria-label="Income type"
              className="w-[200px]"
              value={type}
              onValueChange={(v) => setType(v as AnalyticsIncomeType)}
              options={MARGINAL_TYPES.map((t) => ({ value: t.id, label: t.label }))}
            />
          }
        />
        <CardBody className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div>
            <SeriesChart
              labels={labels}
              format="percent"
              locale={f.locale}
              height={240}
              ariaLabel={`Marginal tax rate on extra ${typeLabel.toLowerCase()} by year`}
              onClickIndex={onPick}
              stepX
              markers={[{ index: yearIdx, label: "", tone: "accent" }]}
              series={[
                {
                  name: `Extra ${typeLabel.toLowerCase()}`,
                  color: (t) => t.accent,
                  values: over,
                  width: 2.5,
                },
              ]}
            />
            <p className="mt-1 text-[11.5px] text-ink-3">
              Tax on one more unit of this income, re-running the whole tax stack, so allowance
              tapers, benefit charges and similar cliffs are included.
            </p>
          </div>
          <div>
            <div className="eyebrow mb-1">{p.year}, all income types</div>
            <Table>
              <THead>
                <TR>
                  <TH>Income type</TH>
                  <TH numeric>Marginal rate</TH>
                </TR>
              </THead>
              <TBody>
                {MARGINAL_TYPES.map((t) => (
                  <TR key={t.id}>
                    <TD>{t.label}</TD>
                    <TD numeric>{marginalByType ? f.percent(marginalByType[t.id] ?? 0) : "—"}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </div>
        </CardBody>
      </Card>
      <Card>
        <CardHeader
          eyebrow={`${p.year}`}
          title={`Marginal-rate progression: extra ${typeLabel.toLowerCase()}`}
        />
        <CardBody>
          {prog.length === 0 ? (
            <EmptyState title="No progression available" />
          ) : (
            <SeriesChart
              labels={prog.map((x) => f.money(toBasis(x.extra), true))}
              format="percent"
              locale={f.locale}
              height={240}
              legend={false}
              ariaLabel={`Marginal rate as extra ${typeLabel.toLowerCase()} increases in ${p.year}`}
              stepX
              series={[
                {
                  name: "Marginal rate",
                  color: (t) => t.ochre,
                  values: prog.map((x) => x.marginalRate),
                  width: 2.5,
                },
              ]}
              tooltipTitle={(i) =>
                `Extra ${f.money(toBasis(prog[i]?.extra ?? 0))} on top of this year's income`
              }
            />
          )}
          <p className="mt-1 text-[11.5px] text-ink-3">
            How the rate on the next {f.money(toBasis(prog[0]?.extra ?? 0), true)} of{" "}
            {typeLabel.toLowerCase()} changes as you add more, in{" "}
            {basis === "real" ? "today's" : "future"} money.
          </p>
        </CardBody>
      </Card>
    </>
  );
}

function TaxesBody({
  result,
  plan,
  doc,
  index,
  basis,
  input,
}: {
  result: ProjectionResult;
  plan: Plan;
  doc: GlideworthDocument;
  index: EntityIndex;
  basis: ValueBasis;
  input: SimulationInput | undefined;
}) {
  const f = useFormat();
  const theme = useResolvedTheme();
  const [split, setSplit] = useState<"kind" | "jurisdiction">("kind");
  const [year, setYear] = useState(() =>
    Math.max(
      0,
      result.periods.findIndex((p) => p.months === 12),
    ),
  );
  const regime = taxRegime(plan, doc.household.location.country, result);
  const stackRes = useMemo(() => resolveTaxStack(doc, plan), [doc, plan]);
  const stack = stackRes.ok ? stackRes.stack : undefined;
  const yearIdx = Math.min(year, result.periods.length - 1);
  const p = result.periods[yearIdx]!;
  const yearA = useMemo(() => {
    if (!stack) return undefined;
    try {
      return { value: analyseYear(doc, plan, result, stack, yearIdx) };
    } catch (e) {
      return { error: e };
    }
  }, [doc, plan, result, stack, yearIdx]);
  const sources = useMemo(() => (stack ? taxSources(stack) : []), [stack]);
  const labels = useMemo(() => result.periods.map((x) => periodShortLabel(x)), [result]);
  const byKind = useMemo(() => byKindSeries(result, basis, split), [result, basis, split]);
  const comp = useMemo(() => compositionSeries(result, basis), [result, basis]);
  const lifetime = useMemo(() => lifetimeByLabel(result, basis), [result, basis]);
  const lifeTotal = lifetime.reduce((s, x) => s + x.total, 0);
  const onPick = useCallback((i: number) => setYear(i), []);
  const peakMarginal = Math.max(...result.periods.map((x) => x.taxes.marginalRate));
  const kindColor = (k: string) => (t: ChartTokens) => taxKindColor(t.theme, k);
  const jurColor = (i: number) => (t: ChartTokens) => slotColor(t.theme, [2, 4, 6, 1, 5][i % 5]!);
  const value = yearA && "value" in yearA ? yearA.value : undefined;
  // Cross-border plans only (a single-country plan shows none of this).
  const crossCountries = useMemo(() => {
    if (!result.periods.some((x) => x.taxes.byCountry !== undefined)) return null;
    const c = new Set<string>([doc.household.location.country]);
    for (const x of result.periods) for (const r of x.taxes.byCountry ?? []) c.add(r.country);
    return [...c];
  }, [result, doc]);

  return (
    <>
      {!stackRes.ok ? (
        <Card>
          <CardBody className="text-[12.5px] text-ink-2">
            Bracket-level analytics are unavailable: {stackRes.reason} Totals below still come from
            the simulation.
          </CardBody>
        </Card>
      ) : null}
      <Card>
        <CardBody className="py-3">
          <TaxSimplifications tax={plan.tax} location={doc.household.location} compact />
        </CardBody>
      </Card>
      {crossCountries ? <CrossBorderCaveats countries={crossCountries} /> : null}
      <div className="grid grid-cols-2 gap-x-4 sm:gap-x-6 gap-y-4 rounded-[var(--radius-card)] border border-border bg-surface px-5 py-4 shadow-card md:grid-cols-4">
        <Stat
          label="Lifetime tax"
          value={f.money(lifeTotal, true)}
          sub={basis === "real" ? "Today's money" : "Future money"}
        />
        <Stat
          label="Average effective rate"
          value={f.percent(weightedEffectiveRate(result))}
          sub="Lifetime tax ÷ lifetime income"
        />
        <Stat label="Peak marginal rate" value={f.percent(peakMarginal)} />
        <Stat
          label={`Tax in ${p.year}`}
          value={f.money(conv(p, p.taxes.total, basis, "taxes"), true)}
          sub={`${f.percent(p.taxes.effectiveRate)} effective`}
        />
      </div>

      {crossCountries ? (
        <CrossBorderTaxCard
          result={result}
          doc={doc}
          basis={basis}
          yearIdx={yearIdx}
          onPick={onPick}
        />
      ) : null}

      <Card>
        <CardHeader
          eyebrow="Over time"
          title="Tax by type"
          actions={
            <Segmented
              aria-label="Split taxes by"
              size="sm"
              value={split}
              onChange={setSplit}
              options={[
                { value: "kind", label: "By type" },
                { value: "jurisdiction", label: "By jurisdiction" },
              ]}
            />
          }
        />
        <CardBody>
          <SeriesChart
            labels={labels}
            format="money"
            locale={f.locale}
            currency={f.currency}
            height={300}
            zoom
            ariaLabel="Taxes paid each year, stacked by type"
            onClickIndex={onPick}
            markers={[{ index: year, label: "", tone: "accent" }]}
            series={byKind.map((s, i) => ({
              name: split === "kind" ? kindLabel(s.key, regime) : s.key,
              color: split === "kind" ? kindColor(s.key) : jurColor(i),
              type: "bar",
              stack: "t",
              values: s.values,
            }))}
          />
        </CardBody>
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader eyebrow="Rates" title="Effective and marginal rate" />
          <CardBody>
            <SeriesChart
              labels={labels}
              format="percent"
              locale={f.locale}
              height={260}
              ariaLabel="Effective and marginal tax rates by year"
              onClickIndex={onPick}
              stepX
              series={[
                {
                  name: "Marginal",
                  color: (t) => t.ochre,
                  values: result.periods.map((x) => x.taxes.marginalRate),
                  dashed: true,
                },
                {
                  name: "Effective",
                  color: (t) => t.accent,
                  values: result.periods.map((x) => x.taxes.effectiveRate),
                  width: 2.5,
                },
              ]}
            />
          </CardBody>
        </Card>
        <Card>
          <CardHeader eyebrow="Composition" title="What the income is made of" />
          <CardBody>
            <SeriesChart
              labels={labels}
              format="money"
              locale={f.locale}
              currency={f.currency}
              height={260}
              ariaLabel="Gross income by tax character each year"
              onClickIndex={onPick}
              series={[
                ...comp.groups.map((g, i) => ({
                  name: g.key,
                  color: (t: ChartTokens) => slotColor(t.theme, [0, 6, 5, 1, 2, 4, 7][i % 7]!),
                  type: "bar" as const,
                  stack: "c",
                  values: g.values,
                })),
                {
                  name: "Account withdrawals",
                  color: (t: ChartTokens) => t.stone,
                  type: "bar" as const,
                  stack: "c",
                  values: comp.withdrawals,
                  hatch: true,
                },
              ]}
            />
          </CardBody>
        </Card>
      </div>

      {input ? (
        <IncomeByRateCard
          input={input}
          basis={basis}
          planKey={`${plan.id}:${plan.version}:${doc.finances.asOf}`}
          onPickYear={(y) =>
            setYear(
              Math.max(
                0,
                result.periods.findIndex((x) => x.year === y),
              ),
            )
          }
        />
      ) : null}

      {stack && plan ? (
        <MarginalCards
          doc={doc}
          plan={plan}
          result={result}
          stack={stack}
          index={index}
          yearIdx={yearIdx}
          basis={basis}
          labels={labels}
          onPick={onPick}
          marginalByType={value?.analysis.marginalByType}
          inputPriceIndex={value?.input.priceIndex ?? p.priceIndex}
          progressionInput={value?.input}
        />
      ) : null}

      <Card>
        <CardHeader
          eyebrow="Selected year"
          title={`${p.year} · ${agesLabel(p, index.people)}`}
          actions={
            <input
              type="range"
              min={0}
              max={result.periods.length - 1}
              value={yearIdx}
              aria-label="Year"
              aria-valuetext={String(p.year)}
              onChange={(e) => setYear(Number(e.target.value))}
              className="w-[180px] accent-[var(--accent)] sm:w-[260px]"
            />
          }
        />
        <CardBody className="grid gap-6 lg:grid-cols-2">
          <div className="flex flex-col gap-2">
            {value ? (
              <BracketFillView fills={value.analysis.brackets} index={index} p={p} basis={basis} />
            ) : yearA && "error" in yearA ? (
              <ErrorState error={yearA.error} title="Bands could not be computed" />
            ) : (
              <EmptyState title="No bands to show">
                {regime === "flat"
                  ? "This plan uses flat effective rates, which have no bands."
                  : "The tax stack for this plan is unavailable."}
              </EmptyState>
            )}
            {crossCountries && value ? (
              <p className="text-[11.5px] text-ink-3">
                Bands show {countryLabel(doc.household.location.country)}'s calculation as if
                everything were taxed there; in a cross-border plan the tax by country and reason
                above is what the plan pays.
              </p>
            ) : value && value.analysis.brackets.length > 0 && Math.abs(value.drift) > 0.03 ? (
              <p className="text-[11.5px] text-ink-3">
                Bands are rebuilt from this year's income and withdrawals and differ from the
                simulated tax by {f.percent(Math.abs(value.drift), 0)} of that year's tax, so treat
                band amounts as approximate.
              </p>
            ) : null}
          </div>
          <JurisdictionDetail result={result} p={p} regime={regime} basis={basis} />
        </CardBody>
      </Card>

      {crossCountries && input ? (
        <ItemTaxationPanel input={input} result={result} yearIdx={yearIdx} onPick={onPick} />
      ) : null}

      <Card>
        <CardHeader eyebrow="Lifetime" title="Total tax by type" />
        <CardBody className="flex flex-col gap-3">
          <ShareBar
            ariaLabel="Share of lifetime tax by type"
            height={12}
            parts={lifetime.map((l) => ({
              label: l.label,
              value: l.total,
              color: taxKindColor(theme, l.kind),
            }))}
          />
          <Table>
            <THead>
              <TR>
                <TH>Tax</TH>
                <TH>Jurisdiction</TH>
                <TH numeric>Lifetime</TH>
                <TH numeric>Share</TH>
              </TR>
            </THead>
            <TBody>
              {lifetime.map((l) => (
                <TR key={`${l.jurisdiction}${l.label}`}>
                  <TD>{l.label}</TD>
                  <TD className="text-ink-2">{l.jurisdiction}</TD>
                  <TD numeric>{f.money(l.total)}</TD>
                  <TD numeric>{lifeTotal > 0 ? f.percent(l.total / lifeTotal) : "—"}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </CardBody>
      </Card>

      <SourcesCard sources={sources} plan={plan} regime={regime} />
    </>
  );
}

export function TaxesView() {
  const { plan, doc, result, isLoading, error, index, basis, input } = useAnalysis();
  return (
    <Page
      title="Taxes"
      description={
        plan
          ? `Lifetime and per-year tax analytics for “${plan.name}”. Click any year to inspect it.`
          : undefined
      }
    >
      {isLoading ? <ChartLoading /> : null}
      {error ? <ErrorState error={error} title="Simulation failed" /> : null}
      {result && plan && doc ? (
        <TaxesBody
          result={result}
          plan={plan}
          doc={doc}
          index={index}
          basis={basis}
          input={input}
        />
      ) : null}
    </Page>
  );
}
