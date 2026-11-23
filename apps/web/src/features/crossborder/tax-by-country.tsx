/**
 * Taxes page, cross-border plans only: what the estimate leaves out (shown first), tax by country
 * and by reason (residence, source, citizenship, relief) for the plan and the selected year, with
 * relief shown as its own negative line so it is visible that nothing is taxed twice, and a "how
 * this is taxed and why" panel per account, property and income.
 */
import {
  crossBorderItems,
  crossBorderSimplificationsFor,
  explainItemTaxation,
  type GlideworthDocument,
  type ItemTaxExplanation,
  type PeriodResult,
  type ProjectionResult,
  type SimulationInput,
  TAX_BASES,
  TAX_BASIS_LABEL,
  type TaxBasisKind,
  taxByCountry,
  type ValueBasis,
} from "@glideworth/core";
import { ExternalLink, Globe2, Info, TriangleAlert } from "lucide-react";
import { useMemo, useState } from "react";
import { slotColor } from "../../components/charts/palette";
import { SeriesChart } from "../../components/charts/series-chart";
import type { ChartTokens } from "../../components/charts/tokens";
import { Badge } from "../../components/ui/badge";
import { Card, CardBody, CardHeader } from "../../components/ui/card";
import { Select } from "../../components/ui/select";
import { Table, TBody, TD, TH, THead, TR } from "../../components/ui/table";
import { cn } from "../../lib/cn";
import { countryLabel } from "../../lib/countries";
import { periodShortLabel } from "../../lib/period";
import { useViewFormat as useFormat } from "../results/format-context";
import { countrySlot } from "./model";
import { PrivateText } from "../../components/ui/private-text";

type Row = { country: string; basis: TaxBasisKind; amount: number };

/** country → basis → amount, plus the bases that have any amount (in TAX_BASES order). */
function pivot(rows: Row[], include: string[] = []) {
  const by = new Map<string, Partial<Record<TaxBasisKind, number>>>();
  const used = new Set<TaxBasisKind>();
  for (const r of rows) {
    if (Math.abs(r.amount) < 0.5) continue;
    const m = by.get(r.country) ?? {};
    m[r.basis] = (m[r.basis] ?? 0) + r.amount;
    by.set(r.country, m);
    used.add(r.basis);
  }
  // The country you live in still gets a row when it taxes nothing (the UAE), so a zero is visible.
  for (const c of include) if (!by.has(c)) by.set(c, {});
  const bases = TAX_BASES.filter((b) => used.has(b));
  const countries = [...by.entries()]
    .map(([country, m]) => ({
      country,
      m,
      net: Object.values(m).reduce((s, v) => s + (v ?? 0), 0),
    }))
    .sort((a, b) => b.net - a.net);
  return { bases, countries };
}

function BasisTable({
  rows,
  caption,
  include,
}: {
  rows: Row[];
  caption: string;
  include?: string[];
}) {
  const f = useFormat();
  const { bases, countries } = pivot(rows, include);
  if (countries.length === 0) return <p className="text-[12.5px] text-ink-3">No tax.</p>;
  const total = countries.reduce((s, c) => s + c.net, 0);
  return (
    <div className="overflow-x-auto">
      <Table>
        <caption className="sr-only">{caption}</caption>
        <THead>
          <TR>
            <TH>Country</TH>
            {bases.map((b) => (
              <TH key={b} numeric>
                <span title={TAX_BASIS_LABEL[b].description}>{TAX_BASIS_LABEL[b].label}</span>
              </TH>
            ))}
            <TH numeric>Paid</TH>
          </TR>
        </THead>
        <TBody>
          {countries.map((c) => (
            <TR key={c.country}>
              <TD className="font-medium">{countryLabel(c.country)}</TD>
              {bases.map((b) => {
                const v = c.m[b];
                return (
                  <TD key={b} numeric className={cn(v !== undefined && v < 0 && "text-positive")}>
                    {v === undefined ? <span className="text-ink-3">—</span> : f.money(v)}
                  </TD>
                );
              })}
              <TD numeric className="font-semibold">
                {f.money(c.net)}
              </TD>
            </TR>
          ))}
          {countries.length > 1 ? (
            <TR>
              <TD className="font-semibold">Total</TD>
              {bases.map((b) => (
                <TD key={b} numeric className="text-ink-2">
                  {f.money(countries.reduce((s, c) => s + (c.m[b] ?? 0), 0))}
                </TD>
              ))}
              <TD numeric className="font-semibold">
                {f.money(total)}
              </TD>
            </TR>
          ) : null}
        </TBody>
      </Table>
    </div>
  );
}

/** "What this estimate leaves out" for a cross-border plan: shown prominently at the top. */
export function CrossBorderCaveats({ countries }: { countries: string[] }) {
  const items = useMemo(() => crossBorderSimplificationsFor(countries), [countries]);
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, 3);
  return (
    <Card className="border-ochre/40">
      <CardBody className="flex flex-col gap-2 py-3">
        <div className="flex items-center gap-2 text-[13px] font-semibold">
          <Globe2 className="size-4 text-ochre" /> Cross-border estimate:{" "}
          {countries.map(countryLabel).join(", ")}
        </div>
        <ul className="flex list-disc flex-col gap-1 pl-5 text-[12.5px] text-ink-2">
          {shown.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ul>
        {items.length > 3 ? (
          <button
            type="button"
            className="self-start text-[12px] font-medium text-accent hover:underline"
            onClick={() => setAll((v) => !v)}
            aria-expanded={all}
          >
            {all ? "Show fewer" : `Show all ${items.length} simplifications`}
          </button>
        ) : null}
      </CardBody>
    </Card>
  );
}

/** The selected year's tax by country and reason (also used in the Results year drill-down). */
export function YearTaxByCountry({
  p,
  basis,
  home,
}: {
  p: PeriodResult;
  basis: ValueBasis;
  home: string;
}) {
  const rows = useMemo(() => {
    const t = taxByCountry({ periods: [p] } as unknown as ProjectionResult, basis, home);
    return t.years[0]?.rows ?? [];
  }, [p, basis, home]);
  if (!p.taxes.byCountry) return null;
  const relief = rows.filter((r) => r.basis === "relief").reduce((s, r) => s + r.amount, 0);
  return (
    <div className="flex flex-col gap-2">
      <BasisTable rows={rows} caption={`Tax by country and reason in ${p.year}`} include={[home]} />
      {relief < -0.5 ? <ReliefNote /> : null}
    </div>
  );
}

function ReliefNote() {
  return (
    <p className="flex gap-1.5 text-[11.5px] text-ink-3">
      <Info className="mt-0.5 size-3.5 shrink-0" />
      Relief is a credit for tax already paid on the same income in another country, so it is not
      taxed twice. The country you live in gives it, and so does the US for its citizens abroad.
      “Paid” is what each country actually collects.
    </p>
  );
}

export function CrossBorderTaxCard({
  result,
  doc,
  basis,
  yearIdx,
  onPick,
}: {
  result: ProjectionResult;
  doc: GlideworthDocument;
  basis: ValueBasis;
  yearIdx: number;
  onPick: (i: number) => void;
}) {
  const f = useFormat();
  const home = doc.household.location.country;
  const t = useMemo(() => taxByCountry(result, basis, home), [result, basis, home]);
  const p = result.periods[yearIdx]!;
  const labels = useMemo(() => result.periods.map((x) => periodShortLabel(x)), [result]);
  const countries = useMemo(() => [...new Set(t.lifetime.map((r) => r.country))], [t]);
  const series = useMemo(
    () =>
      countries.map((c) => ({
        name: countryLabel(c),
        color: (tk: ChartTokens) => slotColor(tk.theme, countrySlot(c, home)),
        type: "bar" as const,
        stack: "c",
        values: t.years.map((y) =>
          y.rows.filter((r) => r.country === c).reduce((s, r) => s + r.amount, 0),
        ),
      })),
    [countries, t, home],
  );
  const relief = t.lifetime.filter((r) => r.basis === "relief").reduce((s, r) => s + r.amount, 0);
  return (
    <Card>
      <CardHeader eyebrow="Across borders" title="Tax by country and reason" />
      <CardBody className="flex flex-col gap-5">
        <div>
          <SeriesChart
            labels={labels}
            format="money"
            locale={f.locale}
            currency={f.currency}
            height={240}
            ariaLabel="Tax paid to each country every year, after relief"
            onClickIndex={onPick}
            markers={[{ index: yearIdx, label: "", tone: "accent" }]}
            series={series}
          />
          <p className="mt-1 text-[11.5px] text-ink-3">
            Each bar is what a country collects that year, after any credit for tax paid elsewhere.
            Amounts in {basis === "real" ? "today's" : "future"} money, {f.currency}.
          </p>
        </div>
        <div className="grid gap-5 lg:grid-cols-2">
          <div className="flex flex-col gap-2">
            <div className="eyebrow">Whole plan</div>
            <BasisTable
              rows={t.lifetime}
              caption="Lifetime tax by country and reason"
              include={[home]}
            />
            {relief < -0.5 ? <ReliefNote /> : null}
          </div>
          <div className="flex flex-col gap-2">
            <div className="eyebrow">
              {p.year}
              {p.months < 12 ? ` (${p.months} months)` : ""}
            </div>
            <YearTaxByCountry p={p} basis={basis} home={home} />
          </div>
        </div>
        <dl className="grid gap-x-4 gap-y-1 text-[11.5px] text-ink-3 sm:grid-cols-2">
          {TAX_BASES.filter((b) => b === "residence" || t.lifetime.some((r) => r.basis === b)).map(
            (b) => (
              <div key={b} className="flex gap-1.5">
                <dt className="font-semibold text-ink-2">{TAX_BASIS_LABEL[b].label}:</dt>
                <dd>{TAX_BASIS_LABEL[b].description}</dd>
              </div>
            ),
          )}
        </dl>
      </CardBody>
    </Card>
  );
}

// ------------------------------------------------------------------ how is this taxed

function TreatmentRow({ t }: { t: ItemTaxExplanation["treatments"][number] }) {
  const verdict =
    t.residence === t.source
      ? `Taxed in ${countryLabel(t.residence)} only`
      : t.sourceTaxes && t.residenceTaxes
        ? `Both may tax: ${countryLabel(t.residence)} credits ${countryLabel(t.source)}'s tax`
        : t.sourceTaxes
          ? `Taxed in ${countryLabel(t.source)} only (exempt in ${countryLabel(t.residence)})`
          : t.residenceTaxes
            ? `Taxed in ${countryLabel(t.residence)} only`
            : "Not taxed";
  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-border px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[12.5px] font-semibold">{t.label}</span>
        <span className="text-[12px] text-ink-2">{verdict}</span>
        {t.maxSourceRate !== undefined ? (
          <Badge>{`${Math.round(t.maxSourceRate * 100)}% cap at source`}</Badge>
        ) : null}
        {t.treaty ? (
          <Badge tone="accent">
            {t.treaty.name}
            {t.treaty.depth === "basic" ? " (basic)" : ""}
          </Badge>
        ) : t.residence !== t.source ? (
          <Badge tone="ochre">No treaty in Glideworth</Badge>
        ) : null}
      </div>
      <ol className="flex list-decimal flex-col gap-0.5 pl-5 text-[12px] text-ink-2">
        {t.steps.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ol>
      {t.sources.length ? (
        <ul className="flex flex-wrap gap-x-3 gap-y-0.5">
          {t.sources.slice(0, 3).map((s) => (
            <li key={s.url} className="max-w-full truncate text-[11.5px]">
              <a
                href={s.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-accent hover:underline"
              >
                <ExternalLink className="size-3 shrink-0" />
                <span className="truncate">{s.note ?? s.url.replace(/^https?:\/\//, "")}</span>
              </a>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function ItemTaxationPanel({
  input,
  result,
  yearIdx,
  onPick,
}: {
  input: SimulationInput;
  result: ProjectionResult;
  yearIdx: number;
  onPick: (i: number) => void;
}) {
  const items = useMemo(() => crossBorderItems(input), [input]);
  const [pick, setPick] = useState<string | null>(null);
  const id = pick && items.some((i) => i.id === pick) ? pick : (items[0]?.id ?? null);
  const p = result.periods[yearIdx]!;
  const e = useMemo(() => {
    if (!id) return null;
    try {
      return { value: explainItemTaxation(input, id, p.year) };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }, [input, id, p.year]);
  return (
    <Card>
      <CardHeader
        eyebrow="Explain"
        title="How this is taxed, and why"
        actions={
          items.length ? (
            <div className="flex flex-wrap items-center gap-1.5">
              <Select
                aria-label="Account, property or income"
                className="w-[220px]"
                value={id ?? ""}
                onValueChange={setPick}
                options={items.map((i) => ({
                  value: i.id,
                  label: i.name,
                  hint: `${countryLabel(i.country)} · ${i.kind === "realAsset" ? "property" : i.kind}`,
                }))}
              />
              <Select
                aria-label="Year"
                className="w-[110px]"
                value={String(yearIdx)}
                onValueChange={(v) => onPick(Number(v))}
                options={result.periods.map((x, i) => ({
                  value: String(i),
                  label: periodShortLabel(x),
                }))}
              />
            </div>
          ) : null
        }
      />
      <CardBody className="flex flex-col gap-3">
        {items.length === 0 ? (
          <p className="text-[12.5px] text-ink-2">
            Nothing in this plan is in a country other than where you live.
          </p>
        ) : null}
        {e && "error" in e ? <p className="text-[12.5px] text-negative">{e.error}</p> : null}
        {e && "value" in e && e.value ? (
          <>
            <p className="text-[13px]">
              <PrivateText>{e.value.summary}</PrivateText>
            </p>
            <div className="text-[12px] text-ink-2">
              In {countryLabel(e.value.country)}, held in {e.value.currency}. You live in{" "}
              {countryLabel(e.value.residence)}.
            </div>
            {e.value.warnings.length ? (
              <ul className="flex flex-col gap-1 rounded-md bg-ochre-soft px-3 py-2 text-[12px] text-ochre">
                {e.value.warnings.map((w) => (
                  <li key={w} className="flex gap-1.5">
                    <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                    {w}
                  </li>
                ))}
              </ul>
            ) : null}
            {e.value.citizenship ? (
              <p className="rounded-md bg-surface-2 px-3 py-2 text-[12px] text-ink-2">
                <span className="font-semibold text-ink">US citizenship: </span>
                {e.value.citizenship}
              </p>
            ) : null}
            <div className="grid gap-2 lg:grid-cols-2">
              {e.value.treatments.map((t) => (
                <TreatmentRow key={`${t.residence}-${t.category}`} t={t} />
              ))}
            </div>
          </>
        ) : null}
      </CardBody>
    </Card>
  );
}
