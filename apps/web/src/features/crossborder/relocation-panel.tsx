/**
 * Insights → "Moving country": the relocation what-if (move from here to another country in a
 * month, optionally coming back) and the stay-versus-move comparison: outcome deltas, lifetime tax
 * by country and reason for both, an attribution of the difference and the plan diff (with save as
 * branch / compare from the shared preview). Both projections run in the simulation worker.
 */
import {
  type Location,
  type ProjectionResult,
  relocationScenario,
  type SimulationInput,
  summariseStayOrMove,
  TAX_BASIS_LABEL,
  type TaxBasisKind,
} from "@glideworth/core";
import { useQuery } from "@tanstack/react-query";
import { Loader2, Plane } from "lucide-react";
import { useMemo, useState } from "react";
import { ErrorState } from "../../components/charts/states";
import { Button } from "../../components/ui/button";
import { Card, CardBody, CardHeader } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { FieldGrid } from "../../components/ui/sheet";
import { SwitchField } from "../../components/ui/switch";
import { Table, TBody, TD, TH, THead, TR } from "../../components/ui/table";
import { cn } from "../../lib/cn";
import { COUNTRY_LIST, countryLabel, locationLabel } from "../../lib/countries";
import { formatSigned } from "../../lib/format";
import { useFormat } from "../../lib/workspace";
import { runVariant } from "../insights/insights-model";
import { PlanChangePreview } from "../insights/plan-preview";
import { variantOf } from "../insights/scenario-templates";
import { FormField } from "../plan-editor/components/form";
import { monthFromIndex, monthIndex } from "../plan-editor/state/finance-math";
import { attempt, bridge, diffFormat } from "../results/core-bridge";
import { LocationFields } from "./fields";
import { hasMoves, isCrossBorder, suggestedDestination } from "./model";
import { WhoField } from "./residency-section";

export function RelocationPanel({
  input,
  result,
}: {
  input: SimulationInput;
  result: ProjectionResult;
}) {
  // Collapsed for households that never move, so their Insights page stays as it was.
  const [open, setOpen] = useState(() => isCrossBorder(input, input.plan, result));
  if (!open)
    return (
      <Card>
        <CardBody className="flex flex-wrap items-center gap-3 py-3">
          <Plane className="size-4 text-ink-3" />
          <span className="min-w-0 flex-1 text-[12.5px] text-ink-2">
            Thinking of moving country? Compare staying with moving: tax by country, outcome and
            why.
          </span>
          <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
            Try a move
          </Button>
        </CardBody>
      </Card>
    );
  return <RelocationBody input={input} result={result} />;
}

function RelocationBody({ input, result }: { input: SimulationInput; result: ProjectionResult }) {
  const f = useFormat();
  const home = input.household.location;
  const start = monthIndex(input.finances.asOf);
  const [to, setTo] = useState<Location>(() => ({
    country: suggestedDestination(home.country, COUNTRY_LIST),
  }));
  const [month, setMonth] = useState(() => monthFromIndex(Math.floor(start / 12) * 12 + 24));
  const [back, setBack] = useState(false);
  const [returnMonth, setReturnMonth] = useState(() =>
    monthFromIndex(Math.floor(start / 12) * 12 + 24 + 60),
  );
  const [personId, setPersonId] = useState<string | undefined>(undefined);
  const same = to.country === home.country;
  const built = useMemo(
    () =>
      same
        ? {
            error: new Error(
              `You already live in ${countryLabel(home.country)}: pick another country.`,
            ),
          }
        : attempt(() => {
            const t = relocationScenario(input, {
              to,
              month,
              ...(back && returnMonth > month ? { returnMonth } : {}),
              ...(personId ? { personId } : {}),
            });
            return { template: t, variant: variantOf(input, t) };
          }),
    [input, to, month, back, returnMonth, personId, same, home.country],
  );
  const title = built.value?.template.title ?? "Move country";
  const variant = built.value?.variant;
  // Same key as the shared preview below, so the move is simulated once (in the worker).
  const q = useQuery({
    queryKey: [
      "variant",
      input.plan.id,
      input.plan.version,
      title,
      JSON.stringify(variant?.changes ?? []),
      false,
    ],
    queryFn: () => runVariant(input, variant!),
    enabled: !!variant,
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const cmp = useMemo(() => {
    if (!q.data || !variant) return null;
    const diff = attempt(() =>
      bridge.diffPlans(input.plan, variant.plan, diffFormat(input, f.locale, f.currency)),
    );
    if (!diff.value) return null;
    return summariseStayOrMove(result, q.data, diff.value, home.country);
  }, [q.data, variant, input, result, home.country, f.locale, f.currency]);
  const money = (v: number) => f.money(v, true);
  const already = hasMoves(input.plan);

  return (
    <Card>
      <CardHeader eyebrow="Moving country" title="Stay or move?" />
      <CardBody className="flex flex-col gap-4">
        <p className="text-[12.5px] text-ink-2">
          Try a move from {locationLabel(home)}: tax residence changes in the month you choose (and
          back, if you return). Accounts, property and pensions keep their country, so the old
          country may still tax them; end or add income for the new country in the plan to make it
          realistic.
        </p>
        <FieldGrid cols={3}>
          <LocationFields label="Move to" value={to} onChange={setTo} />
          <FormField label="From">
            {(id) => (
              <Input
                id={id}
                type="month"
                value={month}
                onChange={(e) => e.target.value && setMonth(e.target.value)}
              />
            )}
          </FormField>
          <WhoField value={personId} onChange={setPersonId} people={input.household.people} />
        </FieldGrid>
        <SwitchField
          label={`Come back to ${countryLabel(home.country)}`}
          checked={back}
          onCheckedChange={setBack}
        />
        {back ? (
          <FieldGrid>
            <FormField
              label="Back in"
              error={returnMonth <= month ? "The return must be after the move." : undefined}
            >
              {(id) => (
                <Input
                  id={id}
                  type="month"
                  value={returnMonth}
                  onChange={(e) => e.target.value && setReturnMonth(e.target.value)}
                />
              )}
            </FormField>
          </FieldGrid>
        ) : null}
        {built.error ? (
          <p className="text-[12.5px] text-negative">
            {built.error instanceof Error ? built.error.message : String(built.error)}
          </p>
        ) : null}
        {built.value?.template.notes.length ? (
          <ul className="flex list-disc flex-col gap-1 pl-5 text-[12px] text-ink-2">
            {built.value.template.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        ) : null}
        {q.isLoading ? (
          <div className="flex items-center gap-2 text-[12.5px] text-ink-3">
            <Loader2 className="size-4 animate-spin" /> Simulating the move in a background worker…
          </div>
        ) : null}
        {q.error ? <ErrorState error={q.error} title="The move could not be simulated" /> : null}
        {cmp ? (
          <div className="grid gap-5 lg:grid-cols-2">
            <div className="flex flex-col gap-2">
              <div className="eyebrow">Lifetime tax, today's money</div>
              <div className="overflow-x-auto">
                <Table>
                  <caption className="sr-only">
                    Lifetime tax by country and reason, staying versus moving
                  </caption>
                  <THead>
                    <TR>
                      <TH>Country · reason</TH>
                      <TH numeric>{already ? "This plan" : "Stay"}</TH>
                      <TH numeric>Move</TH>
                      <TH numeric>Change</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {cmp.taxesByCountry
                      .filter((r) => Math.abs(r.stay) > 0.5 || Math.abs(r.move) > 0.5)
                      .map((r) => (
                        <TR key={`${r.country}-${r.basis}`}>
                          <TD>
                            {countryLabel(r.country)} ·{" "}
                            <span className="text-ink-2">
                              {TAX_BASIS_LABEL[r.basis as TaxBasisKind]?.label ?? r.basis}
                            </span>
                          </TD>
                          <TD numeric>{money(r.stay)}</TD>
                          <TD numeric>{money(r.move)}</TD>
                          <TD
                            numeric
                            className={cn(
                              r.delta < -0.5
                                ? "text-positive"
                                : r.delta > 0.5
                                  ? "text-negative"
                                  : "text-ink-3",
                            )}
                          >
                            {formatSigned(r.delta, money)}
                          </TD>
                        </TR>
                      ))}
                  </TBody>
                </Table>
              </div>
            </div>
            <div className="flex flex-col gap-2">
              <div className="eyebrow">Where the difference in end net worth comes from</div>
              <Attribution
                rows={cmp.attribution}
                money={money}
                total={cmp.deltas.endNetWorthReal}
              />
            </div>
          </div>
        ) : null}
        {variant ? (
          <PlanChangePreview input={input} base={result} variant={variant} title={title} />
        ) : null}
        {!variant && !built.error ? (
          <div className="flex items-center gap-2 text-[12px] text-ink-3">
            <Plane className="size-4" /> Choose where and when.
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}

function Attribution({
  rows,
  money,
  total,
}: {
  rows: { label: string; delta: number }[];
  money: (v: number) => string;
  total: number;
}) {
  const max = Math.max(1, ...rows.map((r) => Math.abs(r.delta)));
  const label = (l: string) =>
    l.replace(/^([A-Z]{2}) tax \((\w+)\)$/, (_m, c: string, b: string) => {
      const basis = TAX_BASIS_LABEL[b as TaxBasisKind]?.label.toLowerCase() ?? b;
      return `${countryLabel(c)} tax (${basis})`;
    });
  return (
    <div className="flex flex-col gap-1.5">
      {rows.map((r) => (
        <div
          key={r.label}
          className="grid grid-cols-[minmax(0,1fr)_96px] items-center gap-2 text-[12px]"
        >
          <div className="min-w-0">
            <div className="truncate">{label(r.label)}</div>
            <div className="mt-0.5 h-2 rounded-full bg-surface-2">
              <div
                className={cn(
                  "h-2 rounded-full",
                  r.delta >= 0 ? "bg-positive/70" : "bg-negative/70",
                )}
                style={{ width: `${(Math.abs(r.delta) / max) * 100}%` }}
              />
            </div>
          </div>
          <div className={cn("num text-right", r.delta >= 0 ? "text-positive" : "text-negative")}>
            {formatSigned(r.delta, money)}
          </div>
        </div>
      ))}
      <div className="mt-1 flex justify-between border-t border-border pt-1.5 text-[12.5px] font-semibold">
        <span>End net worth</span>
        <span className="num">{formatSigned(total, money)}</span>
      </div>
      <p className="text-[11.5px] text-ink-3">
        Positive helps the move. Lower tax in a country shows as a gain; “Growth, exchange rates and
        timing” is everything else (returns on what you no longer pay in tax, currency moves, the
        timing of income).
      </p>
    </div>
  );
}
