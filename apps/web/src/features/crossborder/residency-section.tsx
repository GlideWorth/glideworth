/**
 * Plan editor → "Where you live": the residency timeline per person. Everyone starts resident in
 * the household's country; dated moves (one person or everyone) and relocation milestones change
 * it. Shows each person's residence as a strip, warns about countries without rules, unknown
 * treaty pairs and missing exchange rates, and holds the plan's cross-border switches.
 */
import {
  CROSS_BORDER_SIMPLIFICATIONS,
  NON_RESIDENT_RULES,
  type Plan,
  type ResidencyChange,
  type TaxConfig,
  treatyBetween,
} from "@glideworth/core";
import { Flag, Globe2, Plus, Trash2, TriangleAlert } from "lucide-react";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardBody, CardHeader } from "../../components/ui/card";
import { EmptyState } from "../../components/ui/empty-state";
import { Select } from "../../components/ui/select";
import { FieldGrid } from "../../components/ui/sheet";
import { SwitchField } from "../../components/ui/switch";
import { COUNTRY_LIST, countryLabel, currencyOfCountry, locationLabel } from "../../lib/countries";
import { useFormat } from "../../lib/workspace";
import { hasPair } from "../currency/fx";
import { DateRefField, EnumField, FormField, useScope } from "../plan-editor/components/form";
import { replaceById, usePlan, useUpdatePlan } from "../plan-editor/components/plan-context";
import { newId } from "../plan-editor/state/defaults";
import { useEditorStore } from "../plan-editor/state/doc-store";
import { monthFromIndex } from "../plan-editor/state/finance-math";
import { formatMonthIndex, resolveRef, type TimeContext } from "../plan-editor/state/resolve";
import { FxRateInline, LocationFields } from "./fields";
import { countryColor, newResidencyEntry, residenceSegments, suggestedDestination } from "./model";

const EVERYONE = "__all";

/** Each person's residence as a horizontal strip over the plan (also used on Results-adjacent pages). */
export function ResidenceStrips({
  plan,
  tctx,
  household,
}: {
  plan: Pick<Plan, "residency" | "milestones">;
  tctx: TimeContext;
  household: {
    people: { id: string; name: string }[];
    location: { country: string; region?: string };
  };
}) {
  const f = useFormat();
  const segs = residenceSegments(plan, household as never, tctx);
  const span = Math.max(1, tctx.end - tctx.start);
  const home = household.location.country;
  return (
    <ul className="flex flex-col gap-2" aria-label="Residence over the plan">
      {household.people.map((p) => {
        const mine = segs.filter((s) => s.personId === p.id);
        return (
          <li key={p.id} className="flex flex-col gap-1">
            <div className="text-[12px] font-medium text-ink-2">{p.name}</div>
            <div className="flex h-6 w-full overflow-hidden rounded-md border border-border">
              {mine.map((s) => {
                const w = ((s.to - s.from) / span) * 100;
                return (
                  <div
                    key={`${s.from}-${s.location.country}`}
                    title={`${locationLabel(s.location)}: ${formatMonthIndex(s.from, f.locale)} to ${formatMonthIndex(s.to - 1, f.locale)}`}
                    className="flex min-w-0 items-center overflow-hidden px-1.5 text-[11px] font-medium whitespace-nowrap text-ink"
                    style={{
                      width: `${w}%`,
                      background: `color-mix(in oklab, ${countryColor(s.location.country, home)} 22%, var(--surface))`,
                      boxShadow: `inset 3px 0 0 ${countryColor(s.location.country, home)}`,
                    }}
                  >
                    {w > 7 ? (
                      <span className="truncate">{countryLabel(s.location.country)}</span>
                    ) : null}
                  </div>
                );
              })}
            </div>
            <div className="sr-only">
              {mine
                .map(
                  (s) =>
                    `${locationLabel(s.location)} from ${formatMonthIndex(s.from, f.locale)} to ${formatMonthIndex(s.to - 1, f.locale)}`,
                )
                .join("; ")}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function taxYearStart(plan: Plan): number {
  const a = plan.assumptions.yearAlignment as { kind: string; startMonth?: number };
  return a.kind === "fiscal" && a.startMonth ? a.startMonth : 1;
}

export function ResidencySection({ onOpenMilestone }: { onOpenMilestone: (id: string) => void }) {
  const plan = usePlan();
  const update = useUpdatePlan();
  const f = useFormat();
  const doc = useEditorStore((s) => s.draft);
  const { people, tctx } = useScope();
  if (!plan || !doc || !tctx) return null;
  const h = doc.household;
  const home = h.location.country;
  const entries = plan.residency ?? [];
  const relocations = plan.milestones.flatMap((m) =>
    m.enabled ? m.effects.filter((e) => e.kind === "relocate").map((e) => ({ m, e })) : [],
  );
  const setEntries = (
    fn: (xs: ResidencyChange[]) => ResidencyChange[],
    label: string,
    key?: string,
  ) =>
    update(
      (p) => {
        const next = fn(p.residency ?? []);
        return { ...p, residency: next.length ? next : undefined };
      },
      label,
      key,
    );
  const add = () => {
    const month = monthFromIndex(Math.max(tctx.start + 12, Math.floor(tctx.start / 12) * 12 + 12));
    const dest = suggestedDestination(home, COUNTRY_LIST);
    setEntries(
      (xs) => [...xs, newResidencyEntry(newId("res"), month, { country: dest })],
      "Add a move",
    );
  };
  const setCb = (patch: Partial<NonNullable<TaxConfig["crossBorder"]>>, label: string) =>
    update(
      (p) => ({ ...p, tax: { ...p.tax, crossBorder: { ...(p.tax.crossBorder ?? {}), ...patch } } }),
      label,
    );

  const countries = new Set<string>([home]);
  for (const r of entries) countries.add(r.location.country);
  for (const { e } of relocations) countries.add(e.location.country);
  const list = [...countries];
  const warnings: string[] = [];
  for (const c of list)
    if (c !== "XX" && !NON_RESIDENT_RULES[c])
      warnings.push(`${countryLabel(c)}: Glideworth has no tax rules for this country yet.`);
  for (let i = 0; i < list.length; i++)
    for (let j = i + 1; j < list.length; j++)
      if (!treatyBetween(list[i]!, list[j]!))
        warnings.push(
          `No ${countryLabel(list[i]!)}–${countryLabel(list[j]!)} treaty in Glideworth's tables: both countries tax under their own rules and the one you live in gives a credit.`,
        );
  const fx = doc.finances.fxRates ?? [];
  const missingFx = [
    ...new Set(list.map(currencyOfCountry).filter((c): c is string => !!c)),
  ].filter(
    (c) =>
      c !== h.currency && !hasPair([...fx, ...(plan.assumptions.fxRates ?? [])], c, h.currency),
  );
  const moves = entries.length + relocations.length > 0;
  const tyStart = taxYearStart(plan);
  const cb = plan.tax.crossBorder ?? {};

  return (
    <>
      <Card>
        <CardHeader
          eyebrow="Residency"
          title="Where you live"
          actions={
            <Button size="sm" variant="secondary" onClick={add}>
              <Plus /> Add a move
            </Button>
          }
        />
        <CardBody className="flex flex-col gap-4">
          <p className="text-[12.5px] text-ink-2">
            Everyone starts tax resident in {locationLabel(h.location)} (the household's location).
            Add a move for one of you or both: accounts, property and pensions keep their country.
          </p>
          <ResidenceStrips plan={plan} tctx={tctx} household={h} />
          {!moves ? (
            <EmptyState compact icon={Globe2} title="No moves planned">
              This plan keeps everyone in {countryLabel(home)}. Add a move to see how another
              country would tax you, or try “Compare staying with moving” in Insights.
            </EmptyState>
          ) : null}
          {entries.map((r) => {
            const at = resolveRef(r.from, tctx);
            const split = at !== null && ((at % 12) + 1 - tyStart + 12) % 12 !== 0;
            return (
              <div key={r.id} className="flex flex-col gap-3 rounded-lg border border-border p-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2 text-[13px] font-semibold">
                    <span
                      className="size-2.5 shrink-0 rounded-full"
                      style={{ background: countryColor(r.location.country, home) }}
                    />
                    <span className="truncate">
                      {r.personId
                        ? (people.find((p) => p.id === r.personId)?.name ?? "Someone")
                        : "Everyone"}{" "}
                      moves to {locationLabel(r.location)}
                      {at !== null ? ` · ${formatMonthIndex(at, f.locale)}` : ""}
                    </span>
                  </div>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={`Remove the move to ${countryLabel(r.location.country)}`}
                    onClick={() =>
                      setEntries((xs) => xs.filter((x) => x.id !== r.id), "Remove a move")
                    }
                  >
                    <Trash2 />
                  </Button>
                </div>
                <FieldGrid>
                  <DateRefField
                    label="From"
                    allowNever={false}
                    value={r.from}
                    onChange={(from) =>
                      setEntries(
                        (xs) => replaceById(xs, r.id, (x) => ({ ...x, from })),
                        "Edit move date",
                        `${r.id}:from`,
                      )
                    }
                  />
                  {people.length > 1 ? (
                    <EnumField
                      label="Who moves"
                      value={r.personId ?? EVERYONE}
                      onChange={(v) =>
                        setEntries(
                          (xs) =>
                            replaceById(xs, r.id, (x) => {
                              const { personId: _p, ...rest } = x;
                              return v === EVERYONE ? rest : { ...rest, personId: v };
                            }),
                          "Edit who moves",
                        )
                      }
                      options={[
                        { value: EVERYONE, label: "Everyone" },
                        ...people.map((p) => ({ value: p.id, label: p.name })),
                      ]}
                    />
                  ) : null}
                  <LocationFields
                    label="Moves to"
                    value={r.location}
                    onChange={(location) =>
                      setEntries(
                        (xs) => replaceById(xs, r.id, (x) => ({ ...x, location })),
                        "Edit destination",
                      )
                    }
                  />
                </FieldGrid>
                {at !== null && at < tctx.start ? (
                  <p className="text-[11.5px] text-negative">
                    This is before the plan starts. Record past moves under Finances → About you →
                    past residence, and set the household's location to where you live now.
                  </p>
                ) : split ? (
                  <p className="text-[11.5px] text-ink-3">
                    Part-way through a tax year: each country taxes its share of that year by
                    months, and pay is taxed where you live while you earn it (statutory split-year
                    rules are approximated).
                  </p>
                ) : null}
              </div>
            );
          })}
          {relocations.map(({ m, e }) => (
            <div
              key={`${m.id}-${e.location.country}`}
              className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-border px-3 py-2 text-[12.5px]"
            >
              <Flag className="size-3.5 text-ink-3" />
              <span className="min-w-0 flex-1">
                {e.personId
                  ? (people.find((p) => p.id === e.personId)?.name ?? "Someone")
                  : "Everyone"}{" "}
                moves to {locationLabel(e.location)} at the milestone{" "}
                <span className="font-medium">{m.name}</span>
                {tctx.milestoneMonth[m.id] != null
                  ? ` (≈ ${formatMonthIndex(tctx.milestoneMonth[m.id]!, f.locale)})`
                  : " (when it happens)"}
              </span>
              <Badge>From a milestone</Badge>
              <Button size="sm" variant="ghost" onClick={() => onOpenMilestone(m.id)}>
                Edit milestone
              </Button>
            </div>
          ))}
          {moves && warnings.length ? (
            <ul className="flex flex-col gap-1 rounded-md bg-ochre-soft px-3 py-2 text-[12px] text-ochre">
              {warnings.map((w) => (
                <li key={w} className="flex gap-1.5">
                  <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                  {w}
                </li>
              ))}
            </ul>
          ) : null}
          {moves
            ? missingFx.map((c) => (
                <div
                  key={c}
                  className="rounded-md border border-border bg-surface-2 px-3 py-2 text-[12.5px]"
                >
                  <p className="mb-1 text-ink-2">
                    Taxes while living in{" "}
                    {list
                      .filter((x) => currencyOfCountry(x) === c)
                      .map(countryLabel)
                      .join(", ")}{" "}
                    are worked out in {c}.
                  </p>
                  <FxRateInline currency={c} base={h.currency} />
                </div>
              ))
            : null}
          {moves && plan.tax.mode !== "estimate" ? (
            <p className="text-[12px] text-ink-2">
              Cross-border rules apply only when this plan estimates taxes (Taxes → mode
              “Estimate”). With {plan.tax.mode} taxes, a move changes nothing in the tax figures.
            </p>
          ) : null}
        </CardBody>
      </Card>
      {moves ? (
        <Card>
          <CardHeader eyebrow="Residency" title="Cross-border rules" />
          <CardBody className="flex flex-col gap-3">
            <p className="text-[12.5px] text-ink-2">
              How Glideworth treats moves in this plan. The defaults follow each country's rules.
            </p>
            <SwitchField
              label="Apply cross-border tax rules"
              hint="Off: taxes follow only where you live (no source-country tax, no relief). Useful to compare."
              checked={cb.mode !== "off"}
              onCheckedChange={(v) =>
                setCb({ mode: v ? undefined : "off" }, "Cross-border rules on/off")
              }
            />
            <SwitchField
              label="Departure tax when leaving Canada or Australia"
              hint="Off models the elections that defer the tax until a real sale."
              checked={cb.departureTax !== "defer"}
              onCheckedChange={(v) =>
                setCb({ departureTax: v ? undefined : "defer" }, "Departure tax")
              }
            />
            <SwitchField
              label="UK temporary non-residence"
              hint="Gains realised during an absence of five years or less are taxed in the year you return."
              checked={cb.ukTemporaryNonResidence !== false}
              onCheckedChange={(v) =>
                setCb(
                  { ukTemporaryNonResidence: v ? undefined : false },
                  "UK temporary non-residence",
                )
              }
            />
            <SwitchField
              label="Freeze the UK State Pension where it is not uprated"
              hint="It stays at the rate when you left while you live in such a country."
              checked={cb.freezeStatePensionAbroad !== false}
              onCheckedChange={(v) =>
                setCb({ freezeStatePensionAbroad: v ? undefined : false }, "State Pension freeze")
              }
            />
            <details className="text-[12px] text-ink-2">
              <summary className="cursor-pointer font-medium text-ink">
                What this model leaves out
              </summary>
              <ul className="mt-1.5 flex list-disc flex-col gap-1 pl-5">
                {CROSS_BORDER_SIMPLIFICATIONS.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ul>
            </details>
          </CardBody>
        </Card>
      ) : null}
    </>
  );
}

/** Small picker used where a single person or everyone can be chosen (relocate effects). */
export function WhoField({
  value,
  onChange,
  people,
  label = "Who moves",
}: {
  value: string | undefined;
  onChange: (v: string | undefined) => void;
  people: { id: string; name: string }[];
  label?: string;
}) {
  if (people.length < 2) return null;
  return (
    <FormField label={label}>
      {(id) => (
        <Select
          id={id}
          value={value ?? EVERYONE}
          onValueChange={(v) => onChange(v === EVERYONE ? undefined : v)}
          options={[
            { value: EVERYONE, label: "Everyone" },
            ...people.map((p) => ({ value: p.id, label: p.name })),
          ]}
        />
      )}
    </FormField>
  );
}
