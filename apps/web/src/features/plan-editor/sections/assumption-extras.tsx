/**
 * Assumptions added with multi-currency and category inflation: named inflation categories
 * (healthcare, education, housing, your own) that events can follow, and per-plan exchange-rate
 * overrides on top of the household's rates.
 */
import {
  type InflationCategory,
  InflationCategory as InflationCategorySchema,
} from "@glideworth/core";
import { Plus, X } from "lucide-react";
import { Button } from "../../../components/ui/button";
import { Card, CardHeader } from "../../../components/ui/card";
import { HelpTip } from "../../../components/ui/help-tip";
import { Input } from "../../../components/ui/input";
import { NumberInput, PercentInput } from "../../../components/ui/number-input";
import { Segmented } from "../../../components/ui/segmented";
import { Select } from "../../../components/ui/select";
import { FxRatesEditor, foreignCurrencies } from "../../currency/fx";
import { usePlan, useUpdatePlan } from "../components/plan-context";
import { newId } from "../state/defaults";
import { useEditorStore } from "../state/doc-store";

const KIND_LABEL: Record<InflationCategory["kind"], string> = {
  healthcare: "Healthcare",
  education: "Education",
  housing: "Housing",
  custom: "Custom",
};
const PRESET: Record<InflationCategory["kind"], number> = {
  healthcare: 0.02,
  education: 0.02,
  housing: 0.005,
  custom: 0,
};

export function InflationCategoriesCard() {
  const plan = usePlan();
  const update = useUpdatePlan();
  if (!plan) return null;
  const cats = plan.assumptions.inflationCategories ?? [];
  const setCats = (next: InflationCategory[], label: string, key?: string) =>
    update(
      (p) => ({
        ...p,
        assumptions: { ...p.assumptions, inflationCategories: next.length ? next : undefined },
      }),
      label,
      key ? `infcat:${key}` : undefined,
    );
  const setOne = (i: number, patch: Partial<InflationCategory>, key?: string) =>
    setCats(
      cats.map((c, j) => (j === i ? { ...c, ...patch } : c)),
      "Edit inflation category",
      key,
    );
  const usedBy = (id: string) =>
    [...plan.income, ...plan.expenses].filter((e) => e.inflationCategory === id).length;
  const add = (kind: InflationCategory["kind"]) => {
    if (kind !== "custom" && cats.some((c) => c.kind === kind)) return;
    setCats(
      [
        ...cats,
        InflationCategorySchema.parse({
          id: kind === "custom" ? newId("infl") : kind,
          name: KIND_LABEL[kind],
          kind,
          mode: "premium",
          rate: { kind: "fixed", rate: PRESET[kind] },
        }),
      ],
      `Add ${KIND_LABEL[kind].toLowerCase()} inflation`,
    );
  };
  return (
    <Card>
      <CardHeader
        eyebrow="Prices"
        title={
          <span className="flex items-center gap-1">
            Inflation by category
            <HelpTip>
              Some costs rise faster than prices in general. A category either adds a premium to
              general inflation or follows its own rate; expenses and income opt in from their
              editor. Their today&rsquo;s-money figures then use the category&rsquo;s price index.
            </HelpTip>
          </span>
        }
      />
      <div className="grid gap-3 p-4">
        {cats.length === 0 ? (
          <p className="text-[12.5px] text-ink-3">
            Everything follows general inflation. Add healthcare, education or housing to let those
            costs grow at their own pace.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {cats.map((c, i) => {
              const rate = c.rate.kind === "fixed" ? c.rate.rate : null;
              const n = usedBy(c.id);
              return (
                <li key={c.id} className="grid gap-2 rounded-lg border border-border p-2.5">
                  <div className="grid items-end gap-2 sm:grid-cols-[minmax(0,1.2fr)_auto_minmax(0,0.8fr)_auto]">
                    <div className="flex flex-col gap-1 text-[12px] font-medium text-ink-2">
                      Name
                      <Input
                        aria-label="Category name"
                        value={c.name}
                        maxLength={80}
                        onChange={(e) =>
                          setOne(i, { name: e.target.value || KIND_LABEL[c.kind] }, `${c.id}:name`)
                        }
                      />
                    </div>
                    <div className="flex flex-col gap-1 text-[12px] font-medium text-ink-2">
                      Grows
                      <Segmented<InflationCategory["mode"]>
                        size="sm"
                        aria-label={`${c.name}: how it grows`}
                        value={c.mode}
                        onChange={(mode) => setOne(i, { mode })}
                        options={[
                          { value: "premium", label: "Inflation +" },
                          { value: "rate", label: "Own rate" },
                        ]}
                      />
                    </div>
                    <div className="flex flex-col gap-1 text-[12px] font-medium text-ink-2">
                      {c.mode === "premium" ? "Premium a year" : "Rate a year"}
                      {rate !== null ? (
                        <PercentInput
                          aria-label={`${c.name} rate`}
                          value={rate}
                          onValueChange={(v) =>
                            setOne(i, { rate: { kind: "fixed", rate: v ?? 0 } }, `${c.id}:rate`)
                          }
                        />
                      ) : (
                        <span className="h-8 text-[12px] leading-8 text-ink-3">
                          Varies over time
                        </span>
                      )}
                    </div>
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={`Remove ${c.name}`}
                      onClick={() =>
                        setCats(
                          cats.filter((_, j) => j !== i),
                          `Remove ${c.name.toLowerCase()} inflation`,
                        )
                      }
                    >
                      <X />
                    </Button>
                  </div>
                  {c.mode === "rate" ? (
                    <div className="flex items-center gap-2 text-[12px] text-ink-2">
                      Moves with general inflation surprises ×
                      <NumberInput
                        aria-label={`${c.name} pass-through`}
                        className="w-[80px]"
                        decimals={2}
                        value={c.passThrough}
                        onValueChange={(v) =>
                          setOne(i, { passThrough: Math.min(3, Math.max(0, v ?? 1)) }, `${c.id}:pt`)
                        }
                      />
                      <span className="text-ink-3">(Monte Carlo)</span>
                    </div>
                  ) : null}
                  <p className="text-[11.5px] text-ink-3">
                    {n
                      ? `Used by ${n} ${n === 1 ? "event" : "events"}.`
                      : "Not used yet: pick it on an expense or income."}
                  </p>
                </li>
              );
            })}
          </ul>
        )}
        <div className="flex flex-wrap gap-1.5">
          {(["healthcare", "education", "housing", "custom"] as const).map((k) => (
            <Button
              key={k}
              size="sm"
              variant="secondary"
              disabled={k !== "custom" && cats.some((c) => c.kind === k)}
              onClick={() => add(k)}
            >
              <Plus /> {KIND_LABEL[k]}
            </Button>
          ))}
        </div>
      </div>
    </Card>
  );
}

/** Pick an inflation category for an income or expense ('general' = the plan's inflation). */
export function InflationCategorySelect({
  value,
  onChange,
  id,
}: {
  value: string | undefined;
  onChange: (v: string | undefined) => void;
  id?: string;
}) {
  const plan = usePlan();
  const cats = plan?.assumptions.inflationCategories ?? [];
  return (
    <Select
      id={id}
      value={value ?? "general"}
      onValueChange={(v) => onChange(v === "general" ? undefined : v)}
      options={[
        { value: "general", label: "General inflation" },
        ...cats.map((c) => ({
          value: c.id,
          label: c.name,
          hint:
            c.rate.kind === "fixed"
              ? c.mode === "premium"
                ? `inflation + ${Math.round(c.rate.rate * 1000) / 10}%`
                : `${Math.round(c.rate.rate * 1000) / 10}% a year`
              : undefined,
        })),
        ...(value && value !== "general" && !cats.some((c) => c.id === value)
          ? [{ value, label: `${value} (missing: add it in Assumptions)` }]
          : []),
      ]}
    />
  );
}

export function PlanFxCard() {
  const plan = usePlan();
  const update = useUpdatePlan();
  const draft = useEditorStore((s) => s.draft);
  if (!plan || !draft) return null;
  const base = draft.household.currency;
  const inUse = foreignCurrencies(draft, [plan]);
  const household = draft.finances.fxRates ?? [];
  if (!inUse.length && !(plan.assumptions.fxRates?.length ?? 0)) return null;
  return (
    <Card>
      <CardHeader eyebrow="Currencies" title="Exchange rates for this plan" />
      <div className="grid gap-3 p-4">
        {household.length ? (
          <p className="text-[12px] text-ink-2">
            Household rates:{" "}
            {household
              .map(
                (r) =>
                  `1 ${r.from} = ${r.rate} ${r.to}${r.annualDrift ? ` (${r.annualDrift > 0 ? "+" : ""}${Math.round(r.annualDrift * 1000) / 10}%/yr)` : ""}`,
              )
              .join(" · ")}
            . Pairs below replace them in this plan only.
          </p>
        ) : null}
        <FxRatesEditor
          rates={plan.assumptions.fxRates ?? []}
          base={base}
          inUse={inUse}
          inheritFrom={household}
          onChange={(fxRates) =>
            update(
              (p) => ({
                ...p,
                assumptions: { ...p.assumptions, fxRates: fxRates.length ? fxRates : undefined },
              }),
              "Edit plan exchange rates",
              "as:fx",
            )
          }
        />
      </div>
    </Card>
  );
}
