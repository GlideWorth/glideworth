/**
 * Plan settings: assumptions (rates and how they vary over time, bonds and glide path, year
 * alignment, horizon), tax (mode, jurisdictions, filing status, flat or custom brackets, UK
 * options, withholding, estate, tax strategy) and Chance-of-Success (Monte Carlo) settings.
 */

import {
  Assumptions,
  type BracketTable,
  defaultStackIds,
  hasTaxPreset,
  type Location,
  type MonteCarloSettings,
  type Plan,
  type TaxConfig,
  type TaxStrategy,
} from "@glideworth/core";
import { Plus, RotateCcw, X } from "lucide-react";
import { useState } from "react";
import { Button } from "../../../components/ui/button";
import { Card, CardHeader } from "../../../components/ui/card";
import { HelpTip } from "../../../components/ui/help-tip";
import { Input } from "../../../components/ui/input";
import {
  AmountInput,
  CurrencyInput,
  NumberInput,
  PercentInput,
} from "../../../components/ui/number-input";
import { Segmented } from "../../../components/ui/segmented";
import { Select } from "../../../components/ui/select";
import { FieldGrid, FormSection } from "../../../components/ui/sheet";
import { InlineSwitch, SwitchField } from "../../../components/ui/switch";
import { COUNTRY_LIST, countryInfo, countryLabel } from "../../../lib/countries";
import { TaxSimplifications } from "../../taxes/tax-notes";
import {
  AccountListEditor,
  DateRefField,
  EnumField,
  FormField,
  RateSpecEditor,
  SchedulePointsEditor,
} from "../components/form";
import { usePlan, useUpdatePlan } from "../components/plan-context";
import { useEditorStore } from "../state/doc-store";
import { HELP } from "../state/labels";
import { useIssues } from "../state/validation";
import { InflationCategoriesCard, PlanFxCard } from "./assumption-extras";

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

// ------------------------------------------------------------------------------- assumptions

export function AssumptionsSection() {
  const plan = usePlan();
  const update = useUpdatePlan();
  const country = useEditorStore((s) => s.draft?.household.location.country);
  const issues = useIssues(Assumptions, plan?.assumptions);
  if (!plan) return null;
  const a = plan.assumptions;
  const set = (v: Partial<Plan["assumptions"]>, label: string, key?: string) =>
    update(
      (p) => ({ ...p, assumptions: { ...p.assumptions, ...v } }),
      label,
      key ? `as:${key}` : undefined,
    );
  const b = a.bondAllocation;
  const rates: [
    keyof Plan["assumptions"],
    string,
    string,
    "us-stocks" | "us-bonds" | "us-cash" | "us-inflation" | "us-dividends" | "crypto",
  ][] = [
    [
      "inflation",
      "Inflation",
      "Drives “today’s money” and every amount set to grow with inflation. UK target 2%; long-run averages ~2.5–3%.",
      "us-inflation",
    ],
    [
      "stockReturn",
      "Stock growth",
      "Price growth of equities, before dividends. Real-terms long-run ≈ 4–5%, so ~7% nominal.",
      "us-stocks",
    ],
    [
      "dividendYield",
      "Dividend yield",
      "Paid out (or reinvested) on top of growth.",
      "us-dividends",
    ],
    ["bondReturn", "Bond growth", "Price growth of the bond portion.", "us-bonds"],
    ["bondYield", "Bond yield", "Interest paid by the bond portion.", "us-bonds"],
    [
      "cashReturn",
      "Cash interest",
      "Savings rate for cash accounts that use the plan default.",
      "us-cash",
    ],
    ["cryptoReturn", "Crypto growth", "Used by crypto accounts on the plan default.", "crypto"],
  ];
  return (
    <>
      <Card>
        <CardHeader
          eyebrow="Markets & prices"
          title="Rates"
          actions={
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                set(
                  Assumptions.parse({
                    ...a,
                    inflation: undefined,
                    stockReturn: undefined,
                    dividendYield: undefined,
                    bondReturn: undefined,
                    bondYield: undefined,
                    cashReturn: undefined,
                    cryptoReturn: undefined,
                  }),
                  "Reset rates",
                )
              }
            >
              <RotateCcw /> Defaults
            </Button>
          }
        />
        <div className="grid gap-4 p-4">
          {rates.map(([k, label, help, series]) => (
            <RateSpecEditor
              key={k}
              label={label}
              help={help}
              defaultSeries={series}
              allowNone={k !== "inflation"}
              value={a[k] as Plan["assumptions"]["inflation"]}
              onChange={(v) =>
                set({ [k]: v } as Partial<Plan["assumptions"]>, `Edit ${label.toLowerCase()}`, k)
              }
            />
          ))}
          {issues.count ? (
            <p className="text-[12px] text-negative">{issues.all[0]?.message}</p>
          ) : null}
          <FieldGrid>
            <FormField
              label="Healthcare inflation premium"
              help="Extra growth for healthcare costs above inflation, used by new healthcare expenses."
            >
              {(id) => (
                <PercentInput
                  id={id}
                  value={a.healthcareInflationPremium}
                  onValueChange={(v) =>
                    set({ healthcareInflationPremium: v ?? 0 }, "Edit healthcare premium", "hc")
                  }
                />
              )}
            </FormField>
            <FormField
              label="Benefit increases vs inflation"
              help="Government benefits (State Pension, Social Security) rise with inflation plus this. Negative models less generous uprating."
            >
              {(id) => (
                <PercentInput
                  id={id}
                  value={a.benefitColaModifier}
                  onValueChange={(v) =>
                    set({ benefitColaModifier: v ?? 0 }, "Edit benefit COLA", "cola")
                  }
                />
              )}
            </FormField>
          </FieldGrid>
          {country === "US" ? (
            <SwitchField
              label="Add Medicare premiums automatically from 65"
              checked={!!a.autoMedicare}
              onCheckedChange={(autoMedicare) => set({ autoMedicare }, "Toggle auto Medicare")}
            />
          ) : null}
        </div>
      </Card>

      <InflationCategoriesCard />
      <PlanFxCard />

      <Card>
        <CardHeader
          eyebrow="Asset mix"
          title={
            <span className="flex items-center gap-1">
              Bonds & glide path <HelpTip>{HELP.glidePath}</HelpTip>
            </span>
          }
        />
        <div className="grid gap-3 p-4">
          <Segmented<"none" | "fixed" | "glidepath">
            aria-label="Bond allocation"
            size="sm"
            value={b.kind}
            onChange={(kind) =>
              set(
                {
                  bondAllocation: {
                    ...b,
                    kind,
                    points:
                      kind === "glidepath" && !b.points.length
                        ? [
                            { at: { kind: "planStart", offsetMonths: 0 }, value: 0.2 },
                            {
                              at: plan.milestones.find((m) => m.kind === "retirement")
                                ? {
                                    kind: "milestone",
                                    milestoneId: plan.milestones.find(
                                      (m) => m.kind === "retirement",
                                    )!.id,
                                    offsetMonths: 0,
                                  }
                                : { kind: "planStart", offsetMonths: 240 },
                              value: 0.5,
                            },
                          ]
                        : b.points,
                  },
                },
                "Change bond allocation",
              )
            }
            options={[
              { value: "none", label: "All stocks" },
              { value: "fixed", label: "Fixed share" },
              { value: "glidepath", label: "Glide path" },
            ]}
          />
          {b.kind !== "none" ? (
            <SwitchField
              label="Tax gains when rebalancing"
              hint="When the bond share changes, selling in a taxable account realises a share of its unrealised gain. Off: rebalancing is assumed to happen with new money."
              checked={!!a.rebalancingGains}
              onCheckedChange={(rebalancingGains) =>
                set({ rebalancingGains: rebalancingGains || undefined }, "Toggle rebalancing gains")
              }
            />
          ) : null}
          {b.kind === "fixed" ? (
            <FormField label="Bond share">
              {(id) => (
                <PercentInput
                  id={id}
                  className="w-[120px]"
                  value={b.share}
                  onValueChange={(v) =>
                    set({ bondAllocation: { ...b, share: v ?? 0 } }, "Edit bond share", "bs")
                  }
                />
              )}
            </FormField>
          ) : null}
          {b.kind === "glidepath" ? (
            <>
              <Segmented<"step" | "linear">
                aria-label="Between points"
                size="sm"
                value={b.interpolation}
                onChange={(interpolation) =>
                  set({ bondAllocation: { ...b, interpolation } }, "Edit glide path")
                }
                options={[
                  { value: "linear", label: "Gradual" },
                  { value: "step", label: "Step" },
                ]}
              />
              <SchedulePointsEditor
                points={b.points}
                onChange={(points) =>
                  set({ bondAllocation: { ...b, points } }, "Edit glide path", "gp")
                }
                getValue={(p) => p.value}
                setValue={(p, v) => ({ ...p, value: v })}
                kind="percent"
                make={() => ({
                  at: { kind: "planStart", offsetMonths: 12 * 10 * b.points.length },
                  value: 0.4,
                })}
              />
            </>
          ) : null}
          {b.kind !== "none" ? (
            <>
              <EnumField
                label="Spread across accounts"
                value={b.distribution}
                onChange={(distribution) =>
                  set({ bondAllocation: { ...b, distribution } }, "Edit bond spread")
                }
                options={[
                  { value: "even", label: "Evenly" },
                  { value: "weighted", label: "Weighted by priority below" },
                ]}
              />
              <FormField
                label="Hold bonds in these accounts first"
                help="Asset location: e.g. bonds in your pension, equities in your ISA."
              >
                {() => (
                  <AccountListEditor
                    ids={b.locationPriority}
                    onChange={(locationPriority) =>
                      set({ bondAllocation: { ...b, locationPriority } }, "Edit bond location")
                    }
                  />
                )}
              </FormField>
            </>
          ) : null}
        </div>
      </Card>

      <Card>
        <CardHeader eyebrow="Mechanics" title="Timing & horizon" />
        <div className="grid gap-3 p-4">
          <SwitchField
            label="Reinvest dividends"
            hint="Accounts can override this."
            checked={a.dividendReinvestment.enabled}
            onCheckedChange={(enabled) =>
              set(
                { dividendReinvestment: { ...a.dividendReinvestment, enabled } },
                "Toggle dividend reinvestment",
              )
            }
          />
          <FieldGrid>
            <FormField label="Each simulated year runs" help={HELP.yearAlignment}>
              {(id) => (
                <Select<string>
                  id={id}
                  value={
                    a.yearAlignment.kind === "fiscal"
                      ? `fiscal-${a.yearAlignment.startMonth}`
                      : a.yearAlignment.kind
                  }
                  onValueChange={(v) =>
                    set(
                      {
                        yearAlignment:
                          v === "calendar"
                            ? { kind: "calendar" }
                            : v === "rolling"
                              ? { kind: "rolling" }
                              : { kind: "fiscal", startMonth: Number(v.split("-")[1]) },
                      },
                      "Change year alignment",
                    )
                  }
                  options={[
                    { value: "calendar", label: "January – December" },
                    { value: "fiscal-4", label: "April – March (UK tax year)" },
                    { value: "fiscal-7", label: "July – June (AU tax year)" },
                    { value: "rolling", label: "From the plan start month" },
                    ...MONTHS.map((m, i) => ({
                      value: `fiscal-${i + 1}`,
                      label: `From ${m}`,
                    })).filter((o) => !["fiscal-1", "fiscal-4", "fiscal-7"].includes(o.value)),
                  ]}
                />
              )}
            </FormField>
            <FormField label="Simulate at most" hint="Safety cap on the plan length.">
              {(id) => (
                <NumberInput
                  id={id}
                  decimals={0}
                  suffix="years"
                  value={a.maxYears}
                  onValueChange={(v) =>
                    set(
                      { maxYears: Math.max(1, Math.min(120, Math.round(v ?? 100))) },
                      "Edit max years",
                      "max",
                    )
                  }
                />
              )}
            </FormField>
          </FieldGrid>
          <EnumField<"lastLifeExpectancy" | "ref">
            label="Plan ends"
            value={a.end.kind}
            onChange={(k) =>
              set(
                {
                  end:
                    k === "ref"
                      ? { kind: "ref", ref: { kind: "planStart", offsetMonths: 12 * 40 } }
                      : { kind: "lastLifeExpectancy" },
                },
                "Change plan end",
              )
            }
            options={[
              {
                value: "lastLifeExpectancy",
                label: "When the last person reaches life expectancy",
              },
              { value: "ref", label: "At a specific point" },
            ]}
          />
          {a.end.kind === "ref" ? (
            <DateRefField
              label="End at"
              value={a.end.ref}
              allowNever={false}
              onChange={(ref) => set({ end: { kind: "ref", ref } }, "Edit plan end")}
            />
          ) : null}
        </div>
      </Card>
    </>
  );
}

// ------------------------------------------------------------------------------- taxes

function BracketEditor({
  value,
  onChange,
  label,
}: {
  value: BracketTable;
  onChange: (b: BracketTable) => void;
  label: string;
}) {
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-border p-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[12.5px] font-medium">{label}</span>
        <Segmented<"real" | "nominal">
          aria-label={`${label} thresholds`}
          size="sm"
          value={value.basis}
          onChange={(basis) => onChange({ ...value, basis })}
          options={[
            { value: "real", label: "Rise with inflation" },
            { value: "nominal", label: "Frozen" },
          ]}
        />
      </div>
      <ol className="flex flex-col gap-1">
        {value.brackets.map((br, i) => (
          // oxlint-disable-next-line react/no-array-index-key -- bracket rows have no ids
          <li key={i} className="flex items-center gap-2 text-[12.5px]">
            <span className="w-10 text-ink-3">{i === 0 ? "From" : "Over"}</span>
            <CurrencyInput
              aria-label={`Bracket ${i + 1} threshold`}
              decimals={0}
              className="w-[140px]"
              value={br.from}
              onValueChange={(v) =>
                onChange({
                  ...value,
                  brackets: value.brackets.map((x, j) =>
                    j === i ? { ...x, from: Math.max(0, v ?? 0) } : x,
                  ),
                })
              }
            />
            <span className="text-ink-3">taxed at</span>
            <PercentInput
              aria-label={`Bracket ${i + 1} rate`}
              className="w-[96px]"
              value={br.rate}
              onValueChange={(v) =>
                onChange({
                  ...value,
                  brackets: value.brackets.map((x, j) => (j === i ? { ...x, rate: v ?? 0 } : x)),
                })
              }
            />
            <Button
              size="icon"
              variant="ghost"
              className="ml-auto size-7"
              disabled={value.brackets.length <= 1}
              aria-label={`Remove bracket ${i + 1}`}
              onClick={() =>
                onChange({ ...value, brackets: value.brackets.filter((_, j) => j !== i) })
              }
            >
              <X />
            </Button>
          </li>
        ))}
      </ol>
      <Button
        size="sm"
        variant="ghost"
        className="self-start"
        onClick={() => {
          const last = value.brackets[value.brackets.length - 1];
          onChange({
            ...value,
            brackets: [
              ...value.brackets,
              { from: (last?.from ?? 0) + 50_000, rate: Math.min(1, (last?.rate ?? 0.2) + 0.1) },
            ],
          });
        }}
      >
        <Plus /> Add bracket
      </Button>
    </div>
  );
}

const UK_BANDS: BracketTable = {
  basis: "real",
  brackets: [
    { from: 0, rate: 0 },
    { from: 12_570, rate: 0.2 },
    { from: 50_270, rate: 0.4 },
    { from: 125_140, rate: 0.45 },
  ],
};
const LAW_TOGGLES: Record<string, { label: string; countries: string[] }> = {
  "us.tcjaSunset": { label: "TCJA brackets expire (US)", countries: ["US"] },
  "us.obbbaSeniorDeduction": { label: "Senior deduction (OBBBA, US)", countries: ["US"] },
  "us.obbbaSaltCap": { label: "$40k SALT cap (OBBBA, US)", countries: ["US"] },
};

/** "Tax rules from": automatic (household location) or any supported country (and region). */
function JurisdictionPicker({
  jurisdictions,
  location,
  onChange,
}: {
  jurisdictions: string[];
  location: Location;
  onChange: (ids: string[]) => void;
}) {
  const [advanced, setAdvanced] = useState(false);
  // Which country preset the explicit stack matches (if any).
  const match = COUNTRY_LIST.flatMap((c) =>
    [undefined, ...(c.regions?.map((r) => r.value) ?? [])].map((region) => {
      try {
        return {
          c: c.code,
          region,
          ids: defaultStackIds({ country: c.code, ...(region ? { region } : {}) }),
        };
      } catch {
        return null;
      }
    }),
  ).find((x) => x && x.ids.join(",") === jurisdictions.join(","));
  const value = jurisdictions.length === 0 ? "auto" : (match?.c ?? "custom");
  const info = value !== "auto" && value !== "custom" ? countryInfo(value) : undefined;
  const pick = (country: string, region?: string) => {
    if (country === "auto") return onChange([]);
    try {
      onChange(defaultStackIds({ country, ...(region ? { region } : {}) }));
    } catch {
      onChange([]);
    }
  };
  return (
    <div className="grid gap-2">
      <FieldGrid>
        <EnumField
          label="Tax rules"
          help="Automatic follows Current finances → Household (and any “Relocate” milestone). Pick a country to use its rules regardless."
          value={value}
          onChange={(c) =>
            pick(
              c,
              countryInfo(c)?.regionAffectsTax
                ? (countryInfo(c)?.regions?.[0]?.value ?? undefined)
                : undefined,
            )
          }
          options={[
            {
              value: "auto",
              label: `Automatic: ${countryLabel(location.country)}${location.region ? ` (${location.region})` : ""}`,
            },
            ...COUNTRY_LIST.filter((c) => hasTaxPreset(c.code)).map((c) => ({
              value: c.code,
              label: c.label,
            })),
            ...(value === "custom" ? [{ value: "custom", label: "Custom list (advanced)" }] : []),
          ]}
        />
        {info?.regionAffectsTax && info.regions ? (
          <EnumField
            label={info.regionLabel ?? "Region"}
            value={match?.region ?? ""}
            onChange={(r) => pick(info.code, r)}
            options={info.regions}
          />
        ) : null}
      </FieldGrid>
      <button
        type="button"
        className="self-start text-[11.5px] text-ink-3 underline-offset-2 hover:text-ink hover:underline"
        onClick={() => setAdvanced((v) => !v)}
        aria-expanded={advanced}
      >
        {advanced ? "Hide" : "Edit"} jurisdiction ids
      </button>
      {advanced ? (
        <FormField
          label="Jurisdiction ids"
          hint="Comma-separated, e.g. uk, us-federal, us-state:NY, es:MD. Blank = automatic."
        >
          {(id) => (
            <Input
              id={id}
              value={jurisdictions.join(", ")}
              placeholder="Automatic"
              onChange={(e) =>
                onChange(
                  e.target.value
                    .split(",")
                    .map((x) => x.trim())
                    .filter(Boolean),
                )
              }
            />
          )}
        </FormField>
      ) : null}
    </div>
  );
}

export function TaxesSection() {
  const plan = usePlan();
  const update = useUpdatePlan();
  const household = useEditorStore((s) => s.draft?.household);
  if (!plan || !household) return null;
  const t = plan.tax;
  const set = (v: Partial<TaxConfig>, label: string, key?: string) =>
    update((p) => ({ ...p, tax: { ...p.tax, ...v } }), label, key ? `tax:${key}` : undefined);
  const gb = household.location.country === "GB";
  const custom = t.custom ?? {
    ordinary: gb
      ? UK_BANDS
      : {
          basis: "real",
          brackets: [
            { from: 0, rate: 0.1 },
            { from: 40_000, rate: 0.25 },
          ],
        },
    capitalGainsInclusion: 1,
    capitalGainsAsOrdinary: false,
    standardDeduction: 0,
    personalAllowancePerPerson: 0,
  };
  const uk = t.uk ?? {};
  return (
    <>
      <Card>
        <CardHeader
          eyebrow="How tax is worked out"
          title={
            <span className="flex items-center gap-1">
              Tax model <HelpTip>{HELP.taxMode}</HelpTip>
            </span>
          }
        />
        <div className="grid gap-3 p-4">
          <Segmented<TaxConfig["mode"]>
            aria-label="Tax mode"
            value={t.mode}
            onChange={(mode) =>
              set(
                { mode, ...(mode === "custom" && !t.custom ? { custom } : {}) },
                "Change tax mode",
              )
            }
            options={[
              { value: "estimate", label: "Estimate for my location" },
              { value: "flat", label: "Flat rates" },
              { value: "custom", label: "My own brackets" },
            ]}
          />
          {t.mode === "estimate" ? (
            <JurisdictionPicker
              jurisdictions={t.jurisdictions}
              location={household.location}
              onChange={(jurisdictions) => set({ jurisdictions }, "Change tax rules")}
            />
          ) : null}
          <TaxSimplifications tax={t} location={household.location} compact />
          <FieldGrid>
            <EnumField
              label="Filing status"
              help="Joint filing exists in the US; most countries tax each person separately."
              value={t.filingStatus}
              onChange={(filingStatus) => set({ filingStatus }, "Change filing status")}
              options={[
                { value: "single", label: gb ? "Individual (UK default)" : "Single" },
                { value: "married-joint", label: "Married, filing jointly" },
                { value: "married-separate", label: "Married, filing separately" },
                { value: "head-of-household", label: "Head of household" },
                { value: "qualifying-surviving-spouse", label: "Qualifying surviving spouse" },
              ]}
            />
          </FieldGrid>
          {t.mode === "flat" ? (
            <FieldGrid cols={3}>
              <FormField label="Income">
                {(id) => (
                  <PercentInput
                    id={id}
                    value={t.flat.ordinary}
                    onValueChange={(v) =>
                      set({ flat: { ...t.flat, ordinary: v ?? 0 } }, "Edit flat rate", "fo")
                    }
                  />
                )}
              </FormField>
              <FormField label="Capital gains">
                {(id) => (
                  <PercentInput
                    id={id}
                    value={t.flat.capitalGains}
                    onValueChange={(v) =>
                      set({ flat: { ...t.flat, capitalGains: v ?? 0 } }, "Edit flat rate", "fc")
                    }
                  />
                )}
              </FormField>
              <FormField label="Dividends">
                {(id) => (
                  <PercentInput
                    id={id}
                    value={t.flat.dividends}
                    onValueChange={(v) =>
                      set({ flat: { ...t.flat, dividends: v ?? 0 } }, "Edit flat rate", "fd")
                    }
                  />
                )}
              </FormField>
              <FormField label="Local / extra">
                {(id) => (
                  <PercentInput
                    id={id}
                    value={t.flat.local}
                    onValueChange={(v) =>
                      set({ flat: { ...t.flat, local: v ?? 0 } }, "Edit flat rate", "fl")
                    }
                  />
                )}
              </FormField>
            </FieldGrid>
          ) : null}
          {t.mode === "custom" ? (
            <div className="grid gap-3">
              {gb ? (
                <Button
                  size="sm"
                  variant="ghost"
                  className="self-start"
                  onClick={() =>
                    set(
                      { custom: { ...custom, ordinary: UK_BANDS, personalAllowancePerPerson: 0 } },
                      "Use UK bands",
                    )
                  }
                >
                  Fill with UK 2025/26 income tax bands
                </Button>
              ) : null}
              <BracketEditor
                label="Income"
                value={custom.ordinary}
                onChange={(ordinary) =>
                  set({ custom: { ...custom, ordinary } }, "Edit brackets", "ord")
                }
              />
              {(["capitalGains", "dividends", "payroll"] as const).map((k) => (
                <div key={k}>
                  <SwitchField
                    label={
                      k === "capitalGains"
                        ? "Separate capital gains brackets"
                        : k === "dividends"
                          ? "Separate dividend brackets"
                          : "Payroll / social security tax"
                    }
                    checked={!!custom[k]}
                    onCheckedChange={(on) =>
                      set(
                        {
                          custom: {
                            ...custom,
                            [k]: on
                              ? {
                                  basis: "real",
                                  brackets: [{ from: 0, rate: k === "payroll" ? 0.08 : 0.1 }],
                                }
                              : undefined,
                          },
                        },
                        "Toggle brackets",
                      )
                    }
                  />
                  {custom[k] ? (
                    <div className="mt-2">
                      <BracketEditor
                        label={
                          k === "capitalGains"
                            ? "Capital gains"
                            : k === "dividends"
                              ? "Dividends"
                              : "Payroll"
                        }
                        value={custom[k]!}
                        onChange={(v) => set({ custom: { ...custom, [k]: v } }, "Edit brackets", k)}
                      />
                    </div>
                  ) : null}
                </div>
              ))}
              <FieldGrid>
                <FormField label="Share of gains taxed">
                  {(id) => (
                    <PercentInput
                      id={id}
                      value={custom.capitalGainsInclusion}
                      onValueChange={(v) =>
                        set(
                          { custom: { ...custom, capitalGainsInclusion: v ?? 1 } },
                          "Edit inclusion",
                          "inc",
                        )
                      }
                    />
                  )}
                </FormField>
                <FormField label="Standard deduction">
                  {(id) => (
                    <CurrencyInput
                      id={id}
                      decimals={0}
                      value={custom.standardDeduction}
                      onValueChange={(v) =>
                        set(
                          { custom: { ...custom, standardDeduction: Math.max(0, v ?? 0) } },
                          "Edit deduction",
                          "sd",
                        )
                      }
                    />
                  )}
                </FormField>
                <FormField label="Allowance per person">
                  {(id) => (
                    <CurrencyInput
                      id={id}
                      decimals={0}
                      value={custom.personalAllowancePerPerson}
                      onValueChange={(v) =>
                        set(
                          {
                            custom: { ...custom, personalAllowancePerPerson: Math.max(0, v ?? 0) },
                          },
                          "Edit allowance",
                          "pa",
                        )
                      }
                    />
                  )}
                </FormField>
              </FieldGrid>
              <SwitchField
                label="Tax gains as ordinary income"
                checked={custom.capitalGainsAsOrdinary}
                onCheckedChange={(capitalGainsAsOrdinary) =>
                  set({ custom: { ...custom, capitalGainsAsOrdinary } }, "Toggle gains as income")
                }
              />
              <SwitchField
                label="Tax each person separately"
                checked={!!custom.perPerson}
                onCheckedChange={(perPerson) =>
                  set({ custom: { ...custom, perPerson } }, "Toggle per person")
                }
              />
            </div>
          ) : null}
          <EnumField<"legislated" | "indexed" | "frozen">
            label="Future thresholds"
            help="UK thresholds are frozen until 2030/31. “Legislated” follows announced freezes, then rises with inflation."
            value={t.thresholdIndexation ?? "legislated"}
            onChange={(thresholdIndexation) => set({ thresholdIndexation }, "Edit indexation")}
            options={[
              { value: "legislated", label: "As legislated, then with inflation" },
              { value: "indexed", label: "Rise with inflation every year" },
              { value: "frozen", label: "Frozen forever (fiscal drag)" },
            ]}
          />
          {Object.entries(LAW_TOGGLES)
            .filter(([, v]) => v.countries.includes(household.location.country))
            .map(([k, v]) => (
              <SwitchField
                key={k}
                label={v.label}
                checked={!!t.lawToggles[k]}
                onCheckedChange={(on) =>
                  set({ lawToggles: { ...t.lawToggles, [k]: on } }, "Toggle law")
                }
              />
            ))}
        </div>
      </Card>

      {gb ? (
        <Card>
          <CardHeader eyebrow="United Kingdom" title="UK specifics" />
          <div className="grid gap-3 p-4">
            <EnumField<"net-pay" | "relief-at-source" | "salary-sacrifice">
              label="Workplace pension relief"
              help="Salary sacrifice also saves National Insurance. Relief at source adds 20% to personal contributions; higher-rate relief is claimed back."
              value={uk.defaultPensionScheme ?? "relief-at-source"}
              onChange={(defaultPensionScheme) =>
                set({ uk: { ...uk, defaultPensionScheme } }, "Edit pension relief")
              }
              options={[
                { value: "salary-sacrifice", label: "Salary sacrifice" },
                { value: "net-pay", label: "Net pay arrangement" },
                { value: "relief-at-source", label: "Relief at source" },
              ]}
            />
            <SwitchField
              label="Scottish taxpayer"
              hint={
                household.location.region === "SCT"
                  ? "Set automatically from your location."
                  : "Scottish income tax bands apply."
              }
              checked={uk.scottishTaxpayer ?? household.location.region === "SCT"}
              onCheckedChange={(scottishTaxpayer) =>
                set({ uk: { ...uk, scottishTaxpayer } }, "Toggle Scottish taxpayer")
              }
            />
            <SwitchField
              label="Cash ISA limit"
              hint="From 6 April 2027 at most £12,000 of the ISA allowance can go into cash ISAs (savers 65 and over keep the full allowance). Applies to accounts marked as cash ISAs."
              checked={uk.cashIsaLimit?.enabled ?? true}
              onCheckedChange={(enabled) =>
                set(
                  { uk: { ...uk, cashIsaLimit: { ...(uk.cashIsaLimit ?? {}), enabled } } },
                  "Toggle cash ISA limit",
                )
              }
            />
            {(uk.cashIsaLimit?.enabled ?? true) ? (
              <FieldGrid>
                <FormField
                  label="Cash ISA limit a year"
                  hint="Blank: the legislated amount for each tax year."
                >
                  {(id) => (
                    <CurrencyInput
                      id={id}
                      decimals={0}
                      value={uk.cashIsaLimit?.amount ?? null}
                      onValueChange={(v) =>
                        set(
                          {
                            uk: {
                              ...uk,
                              cashIsaLimit: {
                                enabled: true,
                                ...(uk.cashIsaLimit ?? {}),
                                amount: v === null ? undefined : Math.max(0, v),
                              },
                            },
                          },
                          "Edit cash ISA limit",
                          "cashisa",
                        )
                      }
                    />
                  )}
                </FormField>
                <FormField label="Applies from" hint="Default April 2027.">
                  {(id) => (
                    <Input
                      id={id}
                      type="month"
                      value={uk.cashIsaLimit?.from ?? ""}
                      onChange={(e) =>
                        set(
                          {
                            uk: {
                              ...uk,
                              cashIsaLimit: {
                                enabled: true,
                                ...(uk.cashIsaLimit ?? {}),
                                from: e.target.value || undefined,
                              },
                            },
                          },
                          "Edit cash ISA limit date",
                        )
                      }
                    />
                  )}
                </FormField>
              </FieldGrid>
            ) : null}
            <SwitchField
              label="Claiming Child Benefit"
              hint="Turns on the High Income Child Benefit Charge."
              checked={!!uk.childBenefitClaimed}
              onCheckedChange={(childBenefitClaimed) =>
                set({ uk: { ...uk, childBenefitClaimed } }, "Toggle Child Benefit")
              }
            />
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <span className="text-[12.5px] font-medium">Student loans</span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    set(
                      {
                        uk: {
                          ...uk,
                          studentLoans: [
                            ...(uk.studentLoans ?? []),
                            { personId: household.people[0]!.id, plan: "plan2" },
                          ],
                        },
                      },
                      "Add student loan",
                    )
                  }
                >
                  <Plus /> Add
                </Button>
              </div>
              {(uk.studentLoans ?? []).map((l, i) => (
                <div
                  // oxlint-disable-next-line react/no-array-index-key -- loans have no ids
                  key={i}
                  className="grid items-end gap-2 rounded-lg border border-border p-2 sm:grid-cols-[1fr_1fr_1fr_90px_auto]"
                >
                  <EnumField
                    label="Who"
                    value={l.personId}
                    onChange={(personId) =>
                      set(
                        {
                          uk: {
                            ...uk,
                            studentLoans: uk.studentLoans!.map((x, j) =>
                              j === i ? { ...x, personId } : x,
                            ),
                          },
                        },
                        "Edit student loan",
                      )
                    }
                    options={household.people.map((p) => ({ value: p.id, label: p.name }))}
                  />
                  <EnumField
                    label="Plan"
                    value={l.plan}
                    onChange={(plan2) =>
                      set(
                        {
                          uk: {
                            ...uk,
                            studentLoans: uk.studentLoans!.map((x, j) =>
                              j === i ? { ...x, plan: plan2 } : x,
                            ),
                          },
                        },
                        "Edit student loan",
                      )
                    }
                    options={[
                      { value: "plan1", label: "Plan 1" },
                      { value: "plan2", label: "Plan 2" },
                      { value: "plan4", label: "Plan 4 (Scotland)" },
                      { value: "plan5", label: "Plan 5" },
                      { value: "postgraduate", label: "Postgraduate" },
                    ]}
                  />
                  <FormField label="Balance">
                    {(id) => (
                      <CurrencyInput
                        id={id}
                        decimals={0}
                        value={l.balance ?? null}
                        onValueChange={(v) =>
                          set(
                            {
                              uk: {
                                ...uk,
                                studentLoans: uk.studentLoans!.map((x, j) =>
                                  j === i ? { ...x, balance: v ?? undefined } : x,
                                ),
                              },
                            },
                            "Edit student loan",
                            `sl${i}`,
                          )
                        }
                      />
                    )}
                  </FormField>
                  <FormField label="Written off">
                    {(id) => (
                      <NumberInput
                        id={id}
                        decimals={0}
                        locale="en-GB"
                        value={l.writeOffYear ?? null}
                        onValueChange={(v) =>
                          set(
                            {
                              uk: {
                                ...uk,
                                studentLoans: uk.studentLoans!.map((x, j) =>
                                  j === i
                                    ? { ...x, writeOffYear: v === null ? undefined : Math.round(v) }
                                    : x,
                                ),
                              },
                            },
                            "Edit student loan",
                            `slw${i}`,
                          )
                        }
                      />
                    )}
                  </FormField>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label="Remove student loan"
                    onClick={() =>
                      set(
                        { uk: { ...uk, studentLoans: uk.studentLoans!.filter((_, j) => j !== i) } },
                        "Remove student loan",
                      )
                    }
                  >
                    <X />
                  </Button>
                </div>
              ))}
              <p className="text-[11.5px] text-ink-3">
                Repaid through payroll (9% above the plan threshold) and written off after the
                plan’s term. Add them here rather than as a debt.
              </p>
            </div>
          </div>
        </Card>
      ) : null}

      <Card>
        <CardHeader eyebrow="Cash-flow timing" title="Withholding & settlement" />
        <div className="grid gap-3 p-4">
          <p className="text-[12px] text-ink-3">
            Tax taken off withdrawals at source. It only changes when tax is paid, not how much.
          </p>
          <FieldGrid cols={3}>
            <FormField label="Pension withdrawals">
              {(id) => (
                <PercentInput
                  id={id}
                  value={t.withholding.taxDeferred}
                  onValueChange={(v) =>
                    set(
                      { withholding: { ...t.withholding, taxDeferred: v ?? 0 } },
                      "Edit withholding",
                      "wd",
                    )
                  }
                />
              )}
            </FormField>
            <FormField label="Taxable sales">
              {(id) => (
                <PercentInput
                  id={id}
                  value={t.withholding.taxable}
                  onValueChange={(v) =>
                    set(
                      { withholding: { ...t.withholding, taxable: v ?? 0 } },
                      "Edit withholding",
                      "wt",
                    )
                  }
                />
              )}
            </FormField>
            <FormField label="Conversions">
              {(id) => (
                <PercentInput
                  id={id}
                  value={t.withholding.conversions}
                  onValueChange={(v) =>
                    set(
                      { withholding: { ...t.withholding, conversions: v ?? 0 } },
                      "Edit withholding",
                      "wc",
                    )
                  }
                />
              )}
            </FormField>
          </FieldGrid>
          <FieldGrid>
            <EnumField
              label="Balance settled"
              value={t.settlement}
              onChange={(settlement) => set({ settlement }, "Edit settlement")}
              options={[
                { value: "same-period", label: "In the same year" },
                { value: "next-period", label: "The following year (self-assessment)" },
              ]}
            />
            <FormField label="Tax still due for last year" hint="Paid in the first plan year.">
              {(id) => (
                <CurrencyInput
                  id={id}
                  decimals={0}
                  value={t.firstYearPriorTaxDue}
                  onValueChange={(v) =>
                    set({ firstYearPriorTaxDue: v ?? 0 }, "Edit prior tax", "prior")
                  }
                />
              )}
            </FormField>
          </FieldGrid>
        </div>
      </Card>

      <Card>
        <CardHeader eyebrow="What heirs receive" title="Estate" />
        <div className="grid gap-3 p-4">
          <FieldGrid cols={3}>
            <FormField label="Selling costs">
              {(id) => (
                <PercentInput
                  id={id}
                  value={t.estate.liquidationCostRate}
                  onValueChange={(v) =>
                    set(
                      { estate: { ...t.estate, liquidationCostRate: v ?? 0 } },
                      "Edit estate",
                      "el",
                    )
                  }
                />
              )}
            </FormField>
            <FormField label="Probate & admin">
              {(id) => (
                <PercentInput
                  id={id}
                  value={t.estate.adminCostRate}
                  onValueChange={(v) =>
                    set({ estate: { ...t.estate, adminCostRate: v ?? 0 } }, "Edit estate", "ea")
                  }
                />
              )}
            </FormField>
            <FormField label="Left to charity">
              {(id) => (
                <PercentInput
                  id={id}
                  value={t.estate.charitableShare}
                  onValueChange={(v) =>
                    set({ estate: { ...t.estate, charitableShare: v ?? 0 } }, "Edit estate", "ec")
                  }
                />
              )}
            </FormField>
            <FormField label="Heirs’ tax on pensions">
              {(id) => (
                <PercentInput
                  id={id}
                  value={t.estate.heirTaxDeferredRate}
                  onValueChange={(v) =>
                    set(
                      { estate: { ...t.estate, heirTaxDeferredRate: v ?? 0 } },
                      "Edit estate",
                      "eh",
                    )
                  }
                />
              )}
            </FormField>
            <FormField label="Heirs’ tax on gains">
              {(id) => (
                <PercentInput
                  id={id}
                  value={t.estate.heirCapitalGainsRate}
                  onValueChange={(v) =>
                    set(
                      { estate: { ...t.estate, heirCapitalGainsRate: v ?? 0 } },
                      "Edit estate",
                      "eg",
                    )
                  }
                />
              )}
            </FormField>
          </FieldGrid>
          <SwitchField
            label="Cost basis resets at death"
            hint="UK: no CGT on death. US: step-up in basis."
            checked={t.estate.stepUpBasis}
            onCheckedChange={(stepUpBasis) =>
              set({ estate: { ...t.estate, stepUpBasis } }, "Toggle step-up")
            }
          />
        </div>
      </Card>

      <TaxStrategyCard />
    </>
  );
}

function TaxStrategyCard() {
  const plan = usePlan();
  const update = useUpdatePlan();
  const accounts = useEditorStore((s) => s.draft?.finances.accounts ?? []);
  if (!plan) return null;
  const ts = plan.taxStrategy;
  const set = (v: Partial<TaxStrategy>, label: string, key?: string) =>
    update(
      (p) => ({ ...p, taxStrategy: { ...p.taxStrategy!, ...v } }),
      label,
      key ? `ts:${key}` : undefined,
    );
  return (
    <Card>
      <CardHeader
        eyebrow="Tax strategy"
        title={
          <span className="flex items-center gap-1">
            Tax strategy{" "}
            <HelpTip>
              Fill up a tax band each year with Roth conversions, by shifting withdrawals, or by
              realising gains at low rates.
            </HelpTip>
          </span>
        }
      />
      <div className="grid gap-3 p-4">
        <SwitchField
          label="Fill a target band each year"
          checked={!!ts?.enabled}
          onCheckedChange={(on) =>
            update(
              (p) => ({
                ...p,
                taxStrategy: p.taxStrategy
                  ? { ...p.taxStrategy, enabled: on }
                  : {
                      enabled: on,
                      target: { kind: "bracket", rate: 0.2 },
                      constraints: { avoidNiit: false, preserveAca: false },
                      modules: {
                        rothConversions: true,
                        withdrawalShielding: true,
                        gainHarvesting: true,
                      },
                      conversionSourceAccountIds: [],
                    },
              }),
              on ? "Enable tax strategy" : "Disable tax strategy",
            )
          }
        />
        {ts?.enabled ? (
          <>
            <FieldGrid>
              <EnumField<TaxStrategy["target"]["kind"]>
                label="Target"
                value={ts.target.kind}
                onChange={(k) =>
                  set(
                    {
                      target:
                        k === "bracket"
                          ? { kind: k, rate: 0.2 }
                          : k === "irmaa-tier"
                            ? { kind: k, tier: 1 }
                            : k === "aca-fpl-multiple"
                              ? { kind: k, multiple: 4 }
                              : { kind: "income", amount: { value: 50_270, basis: "real" } },
                    },
                    "Change target",
                  )
                }
                options={[
                  { value: "bracket", label: "Top of a tax band" },
                  { value: "income", label: "An income level" },
                  { value: "irmaa-tier", label: "IRMAA tier (US)" },
                  { value: "aca-fpl-multiple", label: "ACA FPL multiple (US)" },
                ]}
              />
              {ts.target.kind === "bracket" ? (
                <FormField label="Band rate">
                  {(id) => (
                    <PercentInput
                      id={id}
                      value={ts.target.kind === "bracket" ? ts.target.rate : 0}
                      onValueChange={(v) =>
                        set({ target: { kind: "bracket", rate: v ?? 0 } }, "Edit target", "tr")
                      }
                    />
                  )}
                </FormField>
              ) : null}
              {ts.target.kind === "income" ? (
                <FormField label="Income up to">
                  {(id) => (
                    <AmountInput
                      id={id}
                      value={
                        ts.target.kind === "income" ? ts.target.amount : { value: 0, basis: "real" }
                      }
                      onChange={(amount) =>
                        set({ target: { kind: "income", amount } }, "Edit target", "ti")
                      }
                    />
                  )}
                </FormField>
              ) : null}
              {ts.target.kind === "irmaa-tier" ? (
                <FormField label="Tier">
                  {(id) => (
                    <NumberInput
                      id={id}
                      decimals={0}
                      value={ts.target.kind === "irmaa-tier" ? ts.target.tier : 1}
                      onValueChange={(v) =>
                        set(
                          {
                            target: {
                              kind: "irmaa-tier",
                              tier: Math.min(6, Math.max(1, Math.round(v ?? 1))),
                            },
                          },
                          "Edit target",
                          "tt",
                        )
                      }
                    />
                  )}
                </FormField>
              ) : null}
              {ts.target.kind === "aca-fpl-multiple" ? (
                <FormField label="× FPL">
                  {(id) => (
                    <NumberInput
                      id={id}
                      decimals={1}
                      value={ts.target.kind === "aca-fpl-multiple" ? ts.target.multiple : 4}
                      onValueChange={(v) =>
                        set(
                          { target: { kind: "aca-fpl-multiple", multiple: v ?? 4 } },
                          "Edit target",
                          "tm",
                        )
                      }
                    />
                  )}
                </FormField>
              ) : null}
            </FieldGrid>
            <div className="flex flex-wrap gap-x-6 gap-y-2">
              {(["rothConversions", "withdrawalShielding", "gainHarvesting"] as const).map((k) => (
                <InlineSwitch
                  key={k}
                  label={
                    k === "rothConversions"
                      ? "Conversions"
                      : k === "withdrawalShielding"
                        ? "Withdrawal shielding"
                        : "Gain harvesting"
                  }
                  checked={ts.modules[k]}
                  onCheckedChange={(v) =>
                    set({ modules: { ...ts.modules, [k]: v } }, "Toggle module")
                  }
                />
              ))}
            </div>
            <FormField label="Convert from">
              {() => (
                <AccountListEditor
                  ids={ts.conversionSourceAccountIds}
                  onChange={(conversionSourceAccountIds) =>
                    set({ conversionSourceAccountIds }, "Edit conversion sources")
                  }
                />
              )}
            </FormField>
            <EnumField
              label="Convert into"
              value={ts.conversionDestinationAccountId ?? "auto"}
              onChange={(v) =>
                set(
                  { conversionDestinationAccountId: v === "auto" ? undefined : v },
                  "Edit conversion destination",
                )
              }
              options={[
                { value: "auto", label: "Automatic" },
                ...accounts.map((a) => ({ value: a.id, label: a.name })),
              ]}
            />
          </>
        ) : null}
      </div>
    </Card>
  );
}

// ------------------------------------------------------------------------------- monte carlo

export function MonteCarloSection() {
  const plan = usePlan();
  const update = useUpdatePlan();
  if (!plan) return null;
  const mc = plan.monteCarlo;
  const set = (v: Partial<MonteCarloSettings>, label: string, key?: string) =>
    update(
      (p) => ({ ...p, monteCarlo: { ...p.monteCarlo, ...v } }),
      label,
      key ? `mc:${key}` : undefined,
    );
  const d = mc.distributions;
  const series = ["stocks", "bonds", "inflation", "dividends", "crypto"] as const;
  return (
    <>
      <Card>
        <CardHeader eyebrow="Chance of success" title="Simulation method" />
        <div className="grid gap-3 p-4">
          <EnumField
            label="Market paths"
            value={mc.method}
            onChange={(method) => set({ method }, "Change method")}
            options={[
              {
                value: "historical-random-restart",
                label: "Historical, random start years",
                hint: "Real sequences of returns, shuffled starting points.",
              },
              {
                value: "historical-sequential",
                label: "Historical, every start year",
                hint: "One trial per historical start year; no looping.",
              },
              {
                value: "block-bootstrap",
                label: "Block bootstrap",
                hint: "Stitch random runs of consecutive years.",
              },
              {
                value: "normal",
                label: "Random (normal distributions)",
                hint: "Draw returns from the means and spreads below.",
              },
            ]}
          />
          <FieldGrid cols={3}>
            <FormField label="Trials" hint="1,000 is plenty for planning.">
              {(id) => (
                <NumberInput
                  id={id}
                  decimals={0}
                  value={mc.trials}
                  onValueChange={(v) =>
                    set(
                      { trials: Math.min(10_000, Math.max(1, Math.round(v ?? 1000))) },
                      "Edit trials",
                      "tr",
                    )
                  }
                />
              )}
            </FormField>
            {mc.method === "block-bootstrap" ? (
              <FormField label="Block length">
                {(id) => (
                  <NumberInput
                    id={id}
                    decimals={0}
                    suffix="yrs"
                    value={mc.blockLength}
                    onValueChange={(v) =>
                      set(
                        { blockLength: Math.min(30, Math.max(1, Math.round(v ?? 5))) },
                        "Edit block length",
                        "bl",
                      )
                    }
                  />
                )}
              </FormField>
            ) : null}
            {mc.method !== "normal" ? (
              <EnumField
                label="Data"
                value={mc.dataset}
                onChange={(dataset) => set({ dataset }, "Change dataset")}
                options={[
                  { value: "us-1928", label: "US since 1928" },
                  { value: "uk-1983", label: "UK since 1983 (US shares in sterling)" },
                ]}
              />
            ) : null}
          </FieldGrid>
          <FormField label="Random seed" help={HELP.seed}>
            {() => (
              <div className="flex flex-wrap items-center gap-2">
                <Segmented<"random" | "fixed">
                  aria-label="Seed"
                  size="sm"
                  value={mc.seed === null ? "random" : "fixed"}
                  onChange={(v) => set({ seed: v === "random" ? null : 42 }, "Change seed")}
                  options={[
                    { value: "random", label: "New each run" },
                    { value: "fixed", label: "Fixed" },
                  ]}
                />
                {mc.seed !== null ? (
                  <NumberInput
                    aria-label="Seed value"
                    decimals={0}
                    className="w-[120px]"
                    value={mc.seed}
                    locale="en-GB"
                    onValueChange={(v) =>
                      set({ seed: Math.max(0, Math.round(v ?? 0)) }, "Edit seed", "seed")
                    }
                  />
                ) : null}
              </div>
            )}
          </FormField>
          <div>
            <div className="mb-1.5 text-[12px] font-medium text-ink-2">Vary in each trial</div>
            <div className="flex flex-wrap gap-x-5 gap-y-2">
              {series.map((k) => (
                <InlineSwitch
                  key={k}
                  className="capitalize"
                  label={k}
                  checked={mc.vary[k]}
                  onCheckedChange={(v) =>
                    set({ vary: { ...mc.vary, [k]: v } }, "Toggle varied series")
                  }
                />
              ))}
            </div>
          </div>
        </div>
      </Card>
      {mc.method === "normal" ? (
        <Card>
          <CardHeader eyebrow="Random method" title="Distributions" />
          <div className="grid gap-2 p-4">
            <div className="grid grid-cols-[90px_1fr_1fr] gap-2 text-[11px] font-semibold tracking-wide text-ink-3 uppercase">
              <span />
              <span>Mean / yr</span>
              <span>Std. dev.</span>
            </div>
            {series.map((k) => (
              <div key={k} className="grid grid-cols-[90px_1fr_1fr] items-center gap-2">
                <span className="text-[12.5px] capitalize">{k}</span>
                <PercentInput
                  aria-label={`${k} mean`}
                  value={d[k].mean}
                  onValueChange={(v) =>
                    set(
                      { distributions: { ...d, [k]: { ...d[k], mean: v ?? 0 } } },
                      "Edit distribution",
                      `${k}m`,
                    )
                  }
                />
                <PercentInput
                  aria-label={`${k} standard deviation`}
                  value={d[k].stdDev}
                  onValueChange={(v) =>
                    set(
                      { distributions: { ...d, [k]: { ...d[k], stdDev: Math.max(0, v ?? 0) } } },
                      "Edit distribution",
                      `${k}s`,
                    )
                  }
                />
              </div>
            ))}
            <div className="mt-2 grid gap-2 sm:grid-cols-3">
              {(["stocksBonds", "stocksInflation", "bondsInflation"] as const).map((k) => (
                <FormField
                  key={k}
                  label={
                    k === "stocksBonds"
                      ? "Stocks ↔ bonds"
                      : k === "stocksInflation"
                        ? "Stocks ↔ inflation"
                        : "Bonds ↔ inflation"
                  }
                  hint="Correlation, −1 to 1"
                >
                  {(id) => (
                    <NumberInput
                      id={id}
                      decimals={2}
                      value={d.correlation[k]}
                      onValueChange={(v) =>
                        set(
                          {
                            distributions: {
                              ...d,
                              correlation: {
                                ...d.correlation,
                                [k]: Math.max(-1, Math.min(1, v ?? 0)),
                              },
                            },
                          },
                          "Edit correlation",
                          k,
                        )
                      }
                    />
                  )}
                </FormField>
              ))}
            </div>
            <FieldGrid>
              <EnumField<"normal" | "lognormal">
                label="Shape"
                value={mc.distributionShape ?? "normal"}
                onChange={(distributionShape) => set({ distributionShape }, "Edit shape")}
                options={[
                  { value: "normal", label: "Normal" },
                  { value: "lognormal", label: "Log-normal (no −100% years)" },
                ]}
              />
              <FormField
                label="Fat tails (degrees of freedom)"
                hint="Blank = none. Lower = more extreme years."
              >
                {(id) => (
                  <NumberInput
                    id={id}
                    decimals={1}
                    value={mc.fatTails?.degreesOfFreedom ?? null}
                    onValueChange={(v) =>
                      set(
                        {
                          fatTails: v === null ? undefined : { degreesOfFreedom: Math.max(2.5, v) },
                        },
                        "Edit fat tails",
                        "ft",
                      )
                    }
                  />
                )}
              </FormField>
            </FieldGrid>
          </div>
        </Card>
      ) : null}
      <Card>
        <CardHeader eyebrow="What counts as success" title="Success & outcomes" />
        <div className="grid gap-3 p-4">
          <EnumField<MonteCarloSettings["success"]["kind"]>
            label="A trial succeeds when"
            value={mc.success.kind}
            onChange={(k) =>
              set(
                {
                  success:
                    k === "liquid-floor"
                      ? { kind: k, floor: 0 }
                      : k === "end-floor"
                        ? { kind: k, floor: 0, metric: "liquidNetWorth" }
                        : { kind: k },
                },
                "Change success definition",
              )
            }
            options={[
              { value: "all-funded", label: "Every year’s spending is fully funded" },
              { value: "never-depleted", label: "Liquid savings never run out" },
              { value: "liquid-floor", label: "Liquid savings stay above a floor" },
              { value: "end-floor", label: "It ends with at least an amount" },
            ]}
          />
          {mc.success.kind === "liquid-floor" || mc.success.kind === "end-floor" ? (
            <FormField label="Amount (today’s money)">
              {(id) => (
                <CurrencyInput
                  id={id}
                  decimals={0}
                  value={
                    mc.success.kind === "liquid-floor" || mc.success.kind === "end-floor"
                      ? mc.success.floor
                      : 0
                  }
                  onValueChange={(v) =>
                    set(
                      {
                        success: {
                          ...(mc.success as { kind: "liquid-floor"; floor: number }),
                          floor: v ?? 0,
                        },
                      },
                      "Edit success floor",
                      "floor",
                    )
                  }
                />
              )}
            </FormField>
          ) : null}
          <EnumField
            label="Split statistics at"
            value={mc.splitAtMilestoneId ?? "none"}
            onChange={(v) =>
              set({ splitAtMilestoneId: v === "none" ? undefined : v }, "Edit split milestone")
            }
            options={[
              { value: "none", label: "Don’t split" },
              ...plan.milestones.map((m) => ({ value: m.id, label: m.name })),
            ]}
          />
          <div>
            <div className="mb-1.5 text-[12px] font-medium text-ink-2">Outcome categories</div>
            <ul className="flex flex-col gap-1">
              {mc.outcomeCategories.map((c, i) => (
                <li key={c.id} className="grid grid-cols-[1fr_auto_110px] items-center gap-2">
                  <Input
                    aria-label="Category name"
                    value={c.name}
                    onChange={(e) =>
                      set(
                        {
                          outcomeCategories: mc.outcomeCategories.map((x, j) =>
                            j === i ? { ...x, name: e.target.value } : x,
                          ),
                        },
                        "Rename category",
                        `oc${i}`,
                      )
                    }
                  />
                  <span className="text-[11.5px] text-ink-3">
                    {c.kind === "success" ? "ends with ≥" : "fails after"}
                  </span>
                  {c.kind === "success" ? (
                    <NumberInput
                      aria-label={`${c.name} threshold`}
                      decimals={1}
                      suffix="× spend"
                      value={c.threshold}
                      onValueChange={(v) =>
                        set(
                          {
                            outcomeCategories: mc.outcomeCategories.map((x, j) =>
                              j === i ? { ...x, threshold: v ?? 0 } : x,
                            ),
                          },
                          "Edit category",
                          `oct${i}`,
                        )
                      }
                    />
                  ) : (
                    <PercentInput
                      aria-label={`${c.name} threshold`}
                      decimals={0}
                      value={c.threshold}
                      onValueChange={(v) =>
                        set(
                          {
                            outcomeCategories: mc.outcomeCategories.map((x, j) =>
                              j === i ? { ...x, threshold: v ?? 0 } : x,
                            ),
                          },
                          "Edit category",
                          `oct${i}`,
                        )
                      }
                    />
                  )}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </Card>
    </>
  );
}

export function PlanStartingPoint() {
  const plan = usePlan();
  const update = useUpdatePlan();
  const finances = useEditorStore((s) => s.draft?.finances);
  if (!plan || !finances) return null;
  const sc = plan.startingConditions;
  return (
    <FormSection
      title="Starting point"
      description="A plan either follows your current finances, or freezes them at a date (useful for tracking progress against an original plan)."
    >
      <Segmented<"live" | "snapshot">
        aria-label="Starting point"
        value={sc.kind}
        onChange={(k) =>
          update(
            (p) => ({
              ...p,
              startingConditions: k === "live" ? { kind: "live" } : { kind: "snapshot", finances },
            }),
            k === "live" ? "Follow current finances" : "Freeze starting point",
          )
        }
        options={[
          { value: "live", label: "Follow current finances" },
          { value: "snapshot", label: "Fixed date" },
        ]}
      />
      {sc.kind === "snapshot" ? (
        <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-ink-2">
          Frozen as of <span className="num font-medium text-ink">{sc.finances.asOf}</span> ·{" "}
          {sc.finances.accounts.length} accounts
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              update(
                (p) => ({ ...p, startingConditions: { kind: "snapshot", finances } }),
                "Refresh snapshot",
              )
            }
          >
            <RotateCcw /> Re-freeze with today’s finances
          </Button>
        </div>
      ) : null}
    </FormSection>
  );
}
