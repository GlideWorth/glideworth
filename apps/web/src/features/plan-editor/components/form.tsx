/**
 * Form building blocks for the input side: a labelled field with contextual help and inline
 * schema errors, plus the domain inputs every editor shares (owner, date reference with its
 * resolved meaning, change-over-time, rates, schedules, account routing, asset costs).
 */
import type {
  AccountRouting,
  AssetCost,
  Change,
  DateRef,
  Frequency,
  Milestone,
  Person,
  RateSpec,
} from "@glideworth/core";
import { ArrowDown, ArrowUp, Plus, X } from "lucide-react";
import { createContext, type ReactNode, useContext, useId } from "react";
import { Button } from "../../../components/ui/button";
import { DateRefPicker } from "../../../components/ui/date-ref-picker";
import { HelpTip } from "../../../components/ui/help-tip";
import {
  AmountInput,
  CurrencyInput,
  NumberInput,
  PercentInput,
} from "../../../components/ui/number-input";
import { Segmented } from "../../../components/ui/segmented";
import { Select } from "../../../components/ui/select";
import { cn } from "../../../lib/cn";
import { useFormat } from "../../../lib/workspace";
import { FREQUENCY_LABEL } from "../state/labels";
import { describeMonth, resolveRef, type TimeContext } from "../state/resolve";

// ------------------------------------------------------------------------------- scope

export interface EditorScope {
  people: Person[];
  milestones: Milestone[];
  accounts: { id: string; name: string; type: string }[];
  tctx: TimeContext | null;
}

const ScopeCtx = createContext<EditorScope>({
  people: [],
  milestones: [],
  accounts: [],
  tctx: null,
});
export const ScopeProvider = ScopeCtx.Provider;
export const useScope = () => useContext(ScopeCtx);

// ------------------------------------------------------------------------------- field

export function FormField({
  label,
  help,
  hint,
  error,
  children,
  className,
  inline = false,
}: {
  label: ReactNode;
  help?: ReactNode;
  hint?: ReactNode;
  error?: string;
  children: (id: string) => ReactNode;
  className?: string;
  inline?: boolean;
}) {
  const id = useId();
  return (
    <div
      className={cn(
        "flex min-w-0 gap-1",
        inline ? "flex-row items-center justify-between gap-3" : "flex-col",
        className,
      )}
      data-invalid={error ? "" : undefined}
    >
      <div className="flex items-center gap-1">
        <label htmlFor={id} className="text-[12px] font-medium text-ink-2">
          {label}
        </label>
        {help ? (
          <HelpTip label={`About ${typeof label === "string" ? label : "this field"}`}>
            {help}
          </HelpTip>
        ) : null}
      </div>
      <div className={cn("min-w-0", error && "[&_input]:text-negative [&>div]:border-negative/60")}>
        {children(id)}
      </div>
      {error ? (
        <p role="alert" className="text-[11.5px] font-medium text-negative">
          {error}
        </p>
      ) : hint ? (
        <p className="text-[11.5px] text-ink-3">{hint}</p>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------------------- owner

export function OwnerSelect({
  value,
  onChange,
  id,
  allowJoint = true,
}: {
  value: string;
  onChange: (v: string) => void;
  id?: string;
  allowJoint?: boolean;
}) {
  const { people } = useScope();
  const options = [
    ...people.map((p) => ({ value: p.id, label: p.name })),
    ...(allowJoint && people.length > 1 ? [{ value: "joint", label: "Joint" }] : []),
  ];
  const known = options.some((o) => o.value === value);
  return (
    <Select
      id={id}
      value={known ? value : undefined}
      placeholder="Choose owner"
      onValueChange={onChange}
      options={options}
    />
  );
}

export function FrequencySelect({
  value,
  onChange,
  id,
  allowOnce = true,
}: {
  value: Frequency;
  onChange: (v: Frequency) => void;
  id?: string;
  allowOnce?: boolean;
}) {
  return (
    <Select<Frequency>
      id={id}
      value={value}
      onValueChange={onChange}
      options={(Object.keys(FREQUENCY_LABEL) as Frequency[])
        .filter((f) => allowOnce || f !== "once")
        .map((f) => ({ value: f, label: FREQUENCY_LABEL[f] }))}
    />
  );
}

// ------------------------------------------------------------------------------- date refs

export function DateRefField({
  label,
  value,
  onChange,
  allowNever = true,
  help,
  error,
  excludeMilestoneId,
}: {
  label: string;
  value: DateRef;
  onChange: (v: DateRef) => void;
  allowNever?: boolean;
  help?: ReactNode;
  error?: string;
  excludeMilestoneId?: string;
}) {
  const { people, milestones, tctx } = useScope();
  const f = useFormat();
  const ms = milestones.filter((m) => m.id !== excludeMilestoneId);
  const resolved = tctx ? resolveRef(value, tctx) : null;
  const hint =
    value.kind === "never"
      ? "Never"
      : resolved !== null && tctx
        ? `≈ ${describeMonth(resolved, tctx, f.locale)}`
        : value.kind === "milestone"
          ? "Resolves when the plan is simulated"
          : undefined;
  return (
    <FormField label={label} help={help} hint={hint} error={error}>
      {() => (
        <DateRefPicker
          aria-label={label}
          value={value}
          onChange={onChange}
          people={people}
          milestones={ms}
          allowNever={allowNever}
        />
      )}
    </FormField>
  );
}

// ------------------------------------------------------------------------------- schedules

type PointKind = "percent" | "money" | "multiplier";

export function SchedulePointsEditor<P extends { at: DateRef }>({
  points,
  onChange,
  getValue,
  setValue,
  kind,
  make,
  label = "Point",
}: {
  points: P[];
  onChange: (p: P[]) => void;
  getValue: (p: P) => number;
  setValue: (p: P, v: number) => P;
  kind: PointKind;
  make: () => P;
  label?: string;
}) {
  const { people, milestones, tctx } = useScope();
  const f = useFormat();
  return (
    <div className="flex flex-col gap-2">
      <ol className="flex flex-col gap-1.5">
        {points.map((p, i) => {
          const r = tctx ? resolveRef(p.at, tctx) : null;
          return (
            // oxlint-disable-next-line react/no-array-index-key -- schedule points have no ids
            <li key={i} className="rounded-md border border-border bg-surface-2/50 p-2">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="num w-5 text-[11px] text-ink-3">{i + 1}</span>
                <DateRefPicker
                  aria-label={`${label} ${i + 1} time`}
                  value={p.at}
                  onChange={(at) => onChange(points.map((x, j) => (j === i ? { ...x, at } : x)))}
                  people={people}
                  milestones={milestones}
                  allowNever={false}
                />
                <div className="w-[120px]">
                  {kind === "percent" ? (
                    <PercentInput
                      aria-label={`${label} ${i + 1} value`}
                      value={getValue(p)}
                      onValueChange={(v) =>
                        onChange(points.map((x, j) => (j === i ? setValue(x, v ?? 0) : x)))
                      }
                    />
                  ) : kind === "money" ? (
                    <CurrencyInput
                      aria-label={`${label} ${i + 1} value`}
                      value={getValue(p)}
                      onValueChange={(v) =>
                        onChange(points.map((x, j) => (j === i ? setValue(x, v ?? 0) : x)))
                      }
                    />
                  ) : (
                    <NumberInput
                      aria-label={`${label} ${i + 1} value`}
                      suffix="×"
                      decimals={3}
                      value={getValue(p)}
                      onValueChange={(v) =>
                        onChange(points.map((x, j) => (j === i ? setValue(x, v ?? 0) : x)))
                      }
                    />
                  )}
                </div>
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={`Remove ${label.toLowerCase()} ${i + 1}`}
                  disabled={points.length <= 1}
                  onClick={() => onChange(points.filter((_, j) => j !== i))}
                  className="ml-auto size-7"
                >
                  <X />
                </Button>
              </div>
              {r !== null && tctx ? (
                <div className="mt-1 pl-6 text-[11px] text-ink-3">
                  ≈ {describeMonth(r, tctx, f.locale)}
                </div>
              ) : null}
            </li>
          );
        })}
      </ol>
      <Button
        size="sm"
        variant="ghost"
        className="self-start"
        onClick={() => onChange([...points, make()])}
      >
        <Plus /> Add {label.toLowerCase()}
      </Button>
    </div>
  );
}

// ------------------------------------------------------------------------------- change over time

export function ChangeEditor({
  value,
  onChange,
  label = "Change over time",
  help,
}: {
  value: Change;
  onChange: (c: Change) => void;
  label?: string;
  help?: ReactNode;
}) {
  const startRef: DateRef = { kind: "planStart", offsetMonths: 0 };
  const switchKind = (k: Change["kind"]) => {
    if (k === value.kind) return;
    if (k === "none") onChange({ kind: "none" });
    else if (k === "inflation") onChange({ kind: "inflation", plus: 0 });
    else if (k === "rate") onChange({ kind: "rate", rate: 0.02 });
    else
      onChange({
        kind: "schedule",
        valueKind: "multiplier",
        interpolation: "step",
        points: [
          { at: startRef, value: 1 },
          { at: { kind: "planStart", offsetMonths: 120 }, value: 1.2 },
        ],
      });
  };
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-1">
        <span className="text-[12px] font-medium text-ink-2">{label}</span>
        {help ? <HelpTip>{help}</HelpTip> : null}
      </div>
      <Segmented<Change["kind"]>
        aria-label={label}
        size="sm"
        value={value.kind}
        onChange={switchKind}
        options={[
          { value: "inflation", label: "With inflation" },
          { value: "rate", label: "Fixed rate" },
          { value: "none", label: "Flat" },
          { value: "schedule", label: "Custom schedule" },
        ]}
      />
      {value.kind === "inflation" ? (
        <div className="flex items-center gap-2 text-[12.5px] text-ink-2">
          <span>Inflation</span>
          <PercentInput
            aria-label="Above inflation"
            className="w-[110px]"
            value={value.plus}
            onValueChange={(v) => onChange({ kind: "inflation", plus: v ?? 0 })}
            prefix={value.plus >= 0 ? "+" : undefined}
          />
          <span>a year</span>
        </div>
      ) : value.kind === "rate" ? (
        <div className="flex items-center gap-2 text-[12.5px] text-ink-2">
          <PercentInput
            aria-label="Change per year"
            className="w-[110px]"
            value={value.rate}
            onValueChange={(v) => onChange({ kind: "rate", rate: v ?? 0 })}
          />
          <span>a year, regardless of inflation</span>
        </div>
      ) : value.kind === "none" ? (
        <p className="text-[12px] text-ink-3">
          Stays at exactly this amount every year (it loses value to inflation).
        </p>
      ) : (
        <div className="flex flex-col gap-2 rounded-lg border border-border p-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <Select<"multiplier" | "amount" | "rate">
              aria-label="Schedule values are"
              value={value.valueKind}
              onValueChange={(valueKind) => onChange({ ...value, valueKind })}
              options={[
                {
                  value: "multiplier",
                  label: "Multiplier of the amount",
                  hint: "1.2 = 20% more than the entered amount",
                },
                { value: "amount", label: "Exact amounts", hint: "In the amount’s basis" },
                {
                  value: "rate",
                  label: "Growth rate per year",
                  hint: "Rate in force from each point",
                },
              ]}
              className="w-[210px]"
            />
            <Segmented<"step" | "linear">
              aria-label="Between points"
              size="sm"
              value={value.interpolation}
              onChange={(interpolation) => onChange({ ...value, interpolation })}
              options={[
                { value: "step", label: "Step", title: "Hold each value until the next point" },
                { value: "linear", label: "Linear", title: "Blend smoothly between points" },
              ]}
            />
          </div>
          <SchedulePointsEditor
            points={value.points}
            onChange={(points) => onChange({ ...value, points })}
            getValue={(p) => p.value}
            setValue={(p, v) => ({ ...p, value: v })}
            kind={
              value.valueKind === "rate"
                ? "percent"
                : value.valueKind === "amount"
                  ? "money"
                  : "multiplier"
            }
            make={() => ({
              at: { kind: "planStart", offsetMonths: 12 * (value.points.length * 5) },
              value: 1,
            })}
          />
          <p className="text-[11.5px] text-ink-3">
            Steps take effect at each point you add; the live preview shows the result as you edit.
          </p>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------------------- rate specs

export const HISTORICAL_SERIES = [
  { value: "us-stocks", label: "US stocks" },
  { value: "us-bonds", label: "US bonds" },
  { value: "us-cash", label: "US cash" },
  { value: "us-inflation", label: "US inflation" },
  { value: "us-dividends", label: "US dividends" },
  { value: "crypto", label: "Crypto" },
] as const;

export function RateSpecEditor({
  value,
  onChange,
  label,
  help,
  inherit,
  defaultSeries = "us-stocks",
  allowNone = true,
}: {
  value: RateSpec | { kind: "inherit" };
  onChange: (v: RateSpec | { kind: "inherit" }) => void;
  label: string;
  help?: ReactNode;
  /** When set, offers "Plan default" showing this description. */
  inherit?: string;
  defaultSeries?: (typeof HISTORICAL_SERIES)[number]["value"];
  allowNone?: boolean;
}) {
  const kinds = [
    ...(inherit !== undefined ? [{ value: "inherit", label: "Plan default" }] : []),
    { value: "fixed", label: "Fixed" },
    { value: "schedule", label: "Over time" },
    { value: "historical", label: "Historical" },
    ...(allowNone ? [{ value: "none", label: "None" }] : []),
  ] as { value: RateSpec["kind"] | "inherit"; label: string }[];
  const switchKind = (k: RateSpec["kind"] | "inherit") => {
    if (k === value.kind) return;
    const rate = value.kind === "fixed" ? value.rate : 0.05;
    if (k === "inherit") onChange({ kind: "inherit" });
    else if (k === "none") onChange({ kind: "none" });
    else if (k === "fixed") onChange({ kind: "fixed", rate });
    else if (k === "schedule")
      onChange({
        kind: "schedule",
        interpolation: "step",
        points: [
          { at: { kind: "planStart", offsetMonths: 0 }, rate },
          { at: { kind: "planStart", offsetMonths: 120 }, rate: rate / 2 },
        ],
      });
    else onChange({ kind: "historical", series: defaultSeries, startYear: 1966 });
  };
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <span className="text-[12.5px] font-medium text-ink">{label}</span>
          {help ? <HelpTip>{help}</HelpTip> : null}
        </div>
        <Segmented
          aria-label={`${label}: type`}
          size="sm"
          value={value.kind}
          onChange={switchKind}
          options={kinds}
        />
      </div>
      {value.kind === "inherit" ? (
        <p className="text-[12px] text-ink-3">Uses the plan’s assumption: {inherit}</p>
      ) : value.kind === "fixed" ? (
        <PercentInput
          aria-label={`${label} rate`}
          className="w-[130px]"
          value={value.rate}
          onValueChange={(v) => onChange({ kind: "fixed", rate: v ?? 0 })}
          suffix="% / yr"
        />
      ) : value.kind === "schedule" ? (
        <div className="flex flex-col gap-2 rounded-lg border border-border p-2.5">
          <Segmented<"step" | "linear">
            aria-label="Between points"
            size="sm"
            value={value.interpolation}
            onChange={(interpolation) => onChange({ ...value, interpolation })}
            options={[
              { value: "step", label: "Step" },
              { value: "linear", label: "Linear" },
            ]}
          />
          <SchedulePointsEditor
            points={value.points}
            onChange={(points) => onChange({ ...value, points })}
            getValue={(p) => p.rate}
            setValue={(p, rate) => ({ ...p, rate })}
            kind="percent"
            make={() => ({
              at: { kind: "planStart", offsetMonths: 12 * 5 * value.points.length },
              rate: 0.03,
            })}
          />
        </div>
      ) : value.kind === "historical" ? (
        <div className="flex flex-wrap items-end gap-2">
          <FormField label="Series">
            {(id) => (
              <Select
                id={id}
                value={value.series}
                onValueChange={(series) => onChange({ ...value, series })}
                options={HISTORICAL_SERIES.map((s) => ({ ...s }))}
                className="w-[150px]"
              />
            )}
          </FormField>
          <FormField label="Start year">
            {(id) => (
              <NumberInput
                id={id}
                decimals={0}
                className="w-[96px]"
                value={value.startYear}
                onValueChange={(v) => onChange({ ...value, startYear: Math.round(v ?? 1966) })}
                locale="en-GB"
              />
            )}
          </FormField>
          <FormField label="Loop from" help="When the data runs out, continue from this year.">
            {(id) => (
              <NumberInput
                id={id}
                decimals={0}
                className="w-[96px]"
                value={value.loopYear ?? null}
                onValueChange={(v) =>
                  onChange({ ...value, loopYear: v === null ? undefined : Math.round(v) })
                }
                locale="en-GB"
              />
            )}
          </FormField>
        </div>
      ) : (
        <p className="text-[12px] text-ink-3">No growth.</p>
      )}
    </div>
  );
}

// ------------------------------------------------------------------------------- asset costs

export function AssetCostEditor({
  value,
  onChange,
  label,
  help,
  allowMonthly = true,
}: {
  value: AssetCost;
  onChange: (v: AssetCost) => void;
  label: string;
  help?: ReactNode;
  allowMonthly?: boolean;
}) {
  return (
    <FormField label={label} help={help}>
      {(id) => (
        <div className="flex flex-wrap items-center gap-1.5">
          <Select<AssetCost["kind"]>
            id={id}
            value={value.kind}
            onValueChange={(k) =>
              onChange(
                k === "none"
                  ? { kind: "none" }
                  : k === "percentOfValue"
                    ? { kind: "percentOfValue", rate: 0.01 }
                    : { kind: k, amount: { value: 0, basis: "real" } },
              )
            }
            options={[
              { value: "none", label: "None" },
              { value: "percentOfValue", label: "% of value / yr" },
              { value: "amountPerYear", label: "Amount / yr" },
              ...(allowMonthly
                ? [{ value: "amountPerMonth" as const, label: "Amount / month" }]
                : []),
            ]}
            className="w-[150px]"
          />
          {value.kind === "percentOfValue" ? (
            <PercentInput
              aria-label={`${label} rate`}
              className="w-[110px]"
              value={value.rate}
              onValueChange={(v) => onChange({ kind: "percentOfValue", rate: v ?? 0 })}
            />
          ) : value.kind === "amountPerYear" || value.kind === "amountPerMonth" ? (
            <div className="min-w-[220px] flex-1">
              <AmountInput
                value={value.amount}
                onChange={(amount) => onChange({ kind: value.kind, amount })}
              />
            </div>
          ) : null}
        </div>
      )}
    </FormField>
  );
}

// ------------------------------------------------------------------------------- account routing

export function AccountRoutingEditor({
  value,
  onChange,
  autoLabel,
  label,
  help,
  error,
}: {
  value: AccountRouting;
  onChange: (v: AccountRouting) => void;
  autoLabel: string;
  label: string;
  help?: ReactNode;
  error?: string;
}) {
  const { accounts } = useScope();
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <span className="text-[12px] font-medium text-ink-2">{label}</span>
          {help ? <HelpTip>{help}</HelpTip> : null}
        </div>
        <Segmented<"auto" | "accounts">
          aria-label={label}
          size="sm"
          value={value.kind}
          onChange={(k) =>
            onChange(
              k === "auto"
                ? { kind: "auto" }
                : { kind: "accounts", accountIds: accounts[0] ? [accounts[0].id] : [] },
            )
          }
          options={[
            { value: "auto", label: autoLabel },
            { value: "accounts", label: "Specific accounts" },
          ]}
        />
      </div>
      {value.kind === "accounts" ? (
        <AccountListEditor
          ids={value.accountIds}
          onChange={(accountIds) => onChange({ kind: "accounts", accountIds })}
        />
      ) : null}
      {error ? <p className="text-[11.5px] font-medium text-negative">{error}</p> : null}
    </div>
  );
}

export function AccountListEditor({
  ids,
  onChange,
}: {
  ids: string[];
  onChange: (ids: string[]) => void;
}) {
  const { accounts } = useScope();
  const remaining = accounts.filter((a) => !ids.includes(a.id));
  const move = (i: number, d: number) => {
    const out = [...ids];
    const [x] = out.splice(i, 1);
    out.splice(i + d, 0, x!);
    onChange(out);
  };
  return (
    <div className="flex flex-col gap-1.5">
      <ol className="flex flex-col gap-1">
        {ids.map((id, i) => (
          <li
            key={id}
            className="flex items-center gap-2 rounded-md border border-border px-2 py-1"
          >
            <span className="num w-4 text-[11px] text-ink-3">{i + 1}</span>
            <span className="min-w-0 flex-1 truncate text-[12.5px]">
              {accounts.find((a) => a.id === id)?.name ?? (
                <span className="text-negative">Missing account</span>
              )}
            </span>
            <Button
              size="icon"
              variant="ghost"
              className="size-6"
              aria-label="Move up"
              disabled={i === 0}
              onClick={() => move(i, -1)}
            >
              <ArrowUp />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="size-6"
              aria-label="Move down"
              disabled={i === ids.length - 1}
              onClick={() => move(i, 1)}
            >
              <ArrowDown />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="size-6"
              aria-label="Remove"
              onClick={() => onChange(ids.filter((x) => x !== id))}
            >
              <X />
            </Button>
          </li>
        ))}
      </ol>
      {remaining.length ? (
        <Select
          aria-label="Add account"
          value={undefined}
          placeholder="Add an account…"
          onValueChange={(id) => onChange([...ids, id])}
          options={remaining.map((a) => ({ value: a.id, label: a.name }))}
          className="max-w-[260px]"
        />
      ) : null}
    </div>
  );
}

/** Generic labelled select bound to an enum. */
export function EnumField<V extends string>({
  label,
  value,
  onChange,
  options,
  help,
  hint,
  error,
  className,
}: {
  label: string;
  value: V;
  onChange: (v: V) => void;
  options: { value: V; label: string; hint?: string }[];
  help?: ReactNode;
  hint?: ReactNode;
  error?: string;
  className?: string;
}) {
  return (
    <FormField label={label} help={help} hint={hint} error={error} className={className}>
      {(id) => <Select<V> id={id} value={value} onValueChange={onChange} options={options} />}
    </FormField>
  );
}
