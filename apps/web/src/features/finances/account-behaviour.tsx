/**
 * Editor for AccountBehaviour (growth, dividends, bonds, fees, access, distributions...). Used for
 * an account's defaults in Current Finances and, with `patch`, for per-plan overrides where every
 * group shows whether it is inherited or overridden and can be reset.
 */
import {
  ACCOUNT_TYPE_INFO,
  type AccountBehaviour,
  type AccountBehaviourPatch,
  type AccountType,
  type DateRef,
} from "@glideworth/core";
import { RotateCcw } from "lucide-react";
import type { ReactNode } from "react";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { AmountInput, NumberInput, PercentInput } from "../../components/ui/number-input";
import { Segmented } from "../../components/ui/segmented";
import { Select } from "../../components/ui/select";
import { FieldGrid, FormSection } from "../../components/ui/sheet";
import { SwitchField } from "../../components/ui/switch";
import {
  DateRefField,
  EnumField,
  FormField,
  RateSpecEditor,
  SchedulePointsEditor,
  useScope,
} from "../plan-editor/components/form";
import { HELP } from "../plan-editor/state/labels";
import type { Issues } from "../plan-editor/state/validation";

type Key = keyof AccountBehaviour;

const GROUPS: { id: string; title: string; keys: Key[] }[] = [
  { id: "growth", title: "Growth & income", keys: ["growth", "dividends", "bondAllocation"] },
  { id: "fees", title: "Fees", keys: ["fees"] },
  {
    id: "access",
    title: "Access & withdrawals",
    keys: ["withdrawals", "liquid", "earlyWithdrawal", "isExcessCash"],
  },
  {
    id: "distributions",
    title: "Distributions",
    keys: ["distributions", "sepp", "ukDrawdownMethod", "taxFreeWithdrawalShare", "hsaCoverage"],
  },
  { id: "sim", title: "Simulation", keys: ["monteCarlo", "offsetForLoanId"] },
];

const NO_LOANS: { id: string; name: string }[] = [];

export function AccountBehaviourEditor({
  type,
  value,
  onChange,
  patch,
  onResetKeys,
  inheritGrowth,
  inheritDividend,
  issues,
  loans = NO_LOANS,
}: {
  type: AccountType;
  /** Effective behaviour (account default merged with any plan patch). */
  value: AccountBehaviour;
  onChange: (next: AccountBehaviour, changed: Key[]) => void;
  /** When editing plan overrides: the current patch. */
  patch?: AccountBehaviourPatch;
  onResetKeys?: (keys: Key[]) => void;
  inheritGrowth: string;
  inheritDividend: string;
  issues?: Issues;
  loans?: { id: string; name: string }[];
}) {
  const info = ACCOUNT_TYPE_INFO[type];
  const set = <K extends Key>(k: K, v: AccountBehaviour[K]) => onChange({ ...value, [k]: v }, [k]);
  const isUkPension = ["uk-sipp", "uk-workplace-pension", "uk-pension"].includes(type);
  const isUsRetirement = info.country === "US" && info.category === "retirement";
  const err = (p: string) => issues?.under(`behaviour.${p}`) ?? issues?.under(p);

  const header = (g: (typeof GROUPS)[number]) => {
    if (!patch) return undefined;
    const overridden = g.keys.filter((k) => k in patch && patch[k] !== undefined);
    return overridden.length ? (
      <div className="flex items-center gap-1">
        <Badge tone="ochre">Overridden in this plan</Badge>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => onResetKeys?.(overridden)}
          aria-label={`Reset ${g.title} to account default`}
        >
          <RotateCcw /> Reset
        </Button>
      </div>
    ) : (
      <Badge>Account default</Badge>
    );
  };
  const group = (id: string, children: ReactNode, description?: string) => {
    const g = GROUPS.find((x) => x.id === id)!;
    return (
      <FormSection title={g.title} description={description} aside={header(g)}>
        {children}
      </FormSection>
    );
  };

  return (
    <div>
      {group(
        "growth",
        <>
          <RateSpecEditor
            label={info.assetClass === "cash" ? "Interest rate" : "Growth rate"}
            help="Price growth before dividends. “Plan default” follows the plan’s assumptions."
            value={value.growth}
            onChange={(growth) => set("growth", growth)}
            inherit={inheritGrowth}
            defaultSeries={
              info.assetClass === "crypto"
                ? "crypto"
                : info.assetClass === "cash"
                  ? "us-cash"
                  : "us-stocks"
            }
          />
          {info.assetClass !== "cash" ? (
            <>
              <RateSpecEditor
                label="Dividend yield"
                value={value.dividends.yield}
                onChange={(y) => set("dividends", { ...value.dividends, yield: y })}
                inherit={inheritDividend}
                defaultSeries="us-dividends"
              />
              <FieldGrid>
                <EnumField
                  label="Dividend tax treatment"
                  help="“Auto” lets the tax model decide (e.g. UK dividend allowance, US qualified dividends)."
                  value={value.dividends.treatment}
                  onChange={(treatment) => set("dividends", { ...value.dividends, treatment })}
                  options={[
                    { value: "auto", label: "Auto" },
                    { value: "tax-free", label: "Tax-free" },
                    { value: "qualified", label: "Qualified (US)" },
                    { value: "ordinary", label: "Ordinary income" },
                    { value: "municipal", label: "Municipal bonds (US)" },
                    { value: "treasury", label: "Treasuries (US)" },
                    { value: "ca-eligible", label: "Eligible (Canada)" },
                    { value: "ca-non-eligible", label: "Non-eligible (Canada)" },
                    { value: "au-franked", label: "Franked (Australia)" },
                    { value: "au-unfranked", label: "Unfranked (Australia)" },
                  ]}
                />
                <EnumField<"inherit" | "yes" | "no">
                  label="Reinvest dividends"
                  value={
                    value.dividends.reinvest === "inherit"
                      ? "inherit"
                      : value.dividends.reinvest
                        ? "yes"
                        : "no"
                  }
                  onChange={(v) =>
                    set("dividends", {
                      ...value.dividends,
                      reinvest: v === "inherit" ? "inherit" : v === "yes",
                    })
                  }
                  options={[
                    { value: "inherit", label: "Plan default" },
                    { value: "yes", label: "Reinvest" },
                    { value: "no", label: "Pay out to cash flow" },
                  ]}
                />
              </FieldGrid>
              {value.dividends.treatment === "au-franked" ||
              value.dividends.treatment === "qualified" ? (
                <FormField
                  label={
                    value.dividends.treatment === "au-franked" ? "Share franked" : "Share qualified"
                  }
                >
                  {(id) => (
                    <PercentInput
                      id={id}
                      className="w-[120px]"
                      value={value.dividends.qualifiedShare ?? 1}
                      onValueChange={(v) =>
                        set("dividends", { ...value.dividends, qualifiedShare: v ?? undefined })
                      }
                    />
                  )}
                </FormField>
              ) : null}
              <BondAllocationEditor
                value={value.bondAllocation}
                onChange={(b) => set("bondAllocation", b)}
              />
            </>
          ) : null}
        </>,
      )}

      {group(
        "fees",
        <FormField
          label="Annual fee"
          help="Platform and fund charges. % of balance is the usual way they are quoted."
          error={err("fees")}
        >
          {(id) => (
            <div className="flex flex-wrap items-center gap-1.5">
              <Select<AccountBehaviour["fees"]["kind"]>
                id={id}
                value={value.fees.kind}
                onValueChange={(k) =>
                  set(
                    "fees",
                    k === "none"
                      ? { kind: "none" }
                      : k === "amount"
                        ? { kind: "amount", amount: { value: 0, basis: "real" } }
                        : { kind: k, rate: 0.0025 },
                  )
                }
                options={[
                  { value: "none", label: "No fee" },
                  { value: "percentOfBalance", label: "% of balance" },
                  { value: "percentOfEarnings", label: "% of earnings" },
                  { value: "amount", label: "Fixed amount / yr" },
                ]}
                className="w-[160px]"
              />
              {value.fees.kind === "percentOfBalance" || value.fees.kind === "percentOfEarnings" ? (
                <PercentInput
                  aria-label="Fee rate"
                  decimals={3}
                  className="w-[120px]"
                  value={value.fees.rate}
                  onValueChange={(rate) =>
                    set("fees", {
                      kind: (value.fees as { kind: "percentOfBalance" }).kind,
                      rate: rate ?? 0,
                    })
                  }
                />
              ) : value.fees.kind === "amount" ? (
                <div className="min-w-[220px] flex-1">
                  <AmountInput
                    value={value.fees.amount}
                    onChange={(amount) => set("fees", { kind: "amount", amount })}
                  />
                </div>
              ) : null}
            </div>
          )}
        </FormField>,
      )}

      {group(
        "access",
        <>
          <WithdrawalRuleEditor value={value.withdrawals} onChange={(w) => set("withdrawals", w)} />
          <EnumField
            label="Counts as liquid"
            help={HELP.liquid}
            value={value.liquid}
            onChange={(liquid) => set("liquid", liquid)}
            options={[
              { value: "whenWithdrawable", label: "When withdrawals are allowed" },
              { value: "always", label: "Always" },
              { value: "afterQualifiedAge", label: "After the qualifying age" },
              { value: "never", label: "Never" },
            ]}
          />
          <SwitchField
            label="Early-withdrawal penalty"
            hint="Charge a penalty on withdrawals before the qualifying age."
            checked={value.earlyWithdrawal.enabled}
            onCheckedChange={(enabled) =>
              set("earlyWithdrawal", { ...value.earlyWithdrawal, enabled })
            }
          />
          <FieldGrid>
            <FormField
              label="Qualifying age"
              help={HELP.qualifiedAge}
              error={err("earlyWithdrawal.qualifiedAge")}
            >
              {(id) => (
                <NumberInput
                  id={id}
                  decimals={1}
                  suffix="yrs"
                  value={value.earlyWithdrawal.qualifiedAge}
                  onValueChange={(v) =>
                    set("earlyWithdrawal", { ...value.earlyWithdrawal, qualifiedAge: v ?? 0 })
                  }
                />
              )}
            </FormField>
            {value.earlyWithdrawal.enabled ? (
              <FormField label="Penalty rate" error={err("earlyWithdrawal.penaltyRate")}>
                {(id) => (
                  <PercentInput
                    id={id}
                    value={value.earlyWithdrawal.penaltyRate}
                    onValueChange={(v) =>
                      set("earlyWithdrawal", { ...value.earlyWithdrawal, penaltyRate: v ?? 0 })
                    }
                  />
                )}
              </FormField>
            ) : null}
          </FieldGrid>
          {info.category === "cash" ? (
            <SwitchField
              label="Spend this first in a shortfall"
              hint={HELP.excessCash}
              checked={value.isExcessCash}
              onCheckedChange={(isExcessCash) => set("isExcessCash", isExcessCash)}
            />
          ) : null}
        </>,
      )}

      {info.taxTreatment === "tax-deferred" || info.category === "health" || isUkPension
        ? group(
            "distributions",
            <>
              {isUkPension || info.country === "GB" ? (
                <FieldGrid>
                  <EnumField<"ufpls" | "pcls">
                    label="Tax-free cash"
                    help={HELP.ufpls}
                    value={value.ukDrawdownMethod ?? "ufpls"}
                    onChange={(ukDrawdownMethod) => set("ukDrawdownMethod", ukDrawdownMethod)}
                    options={[
                      { value: "ufpls", label: "UFPLS: 25% of each withdrawal" },
                      { value: "pcls", label: "PCLS: lump sum up front" },
                    ]}
                  />
                  <FormField label="Tax-free share" error={err("taxFreeWithdrawalShare")}>
                    {(id) => (
                      <PercentInput
                        id={id}
                        value={value.taxFreeWithdrawalShare ?? 0.25}
                        onValueChange={(v) => set("taxFreeWithdrawalShare", v ?? undefined)}
                      />
                    )}
                  </FormField>
                </FieldGrid>
              ) : null}
              {type === "hsa" ? (
                <EnumField<"self" | "family">
                  label="HSA coverage"
                  value={value.hsaCoverage ?? "self"}
                  onChange={(hsaCoverage) => set("hsaCoverage", hsaCoverage)}
                  options={[
                    { value: "self", label: "Self-only (individual limit)" },
                    { value: "family", label: "Family (higher limit)" },
                  ]}
                />
              ) : null}
              {info.taxTreatment === "tax-deferred" && !isUkPension ? (
                <DistributionEditor
                  value={value.distributions}
                  onChange={(d) => set("distributions", d)}
                  country={info.country}
                />
              ) : null}
              {isUsRetirement && info.taxTreatment === "tax-deferred" ? (
                <SeppEditor value={value.sepp} onChange={(s) => set("sepp", s)} />
              ) : null}
            </>,
          )
        : null}

      {group(
        "sim",
        <>
          <EnumField<"auto" | "fixed">
            label="In Chance of Success"
            help={HELP.monteCarloTreatment}
            value={value.monteCarlo}
            onChange={(monteCarlo) => set("monteCarlo", monteCarlo)}
            options={[
              { value: "auto", label: "Vary with the markets" },
              { value: "fixed", label: "Keep fixed rates" },
            ]}
          />
          {info.category === "cash" && loans.length ? (
            <FormField
              label="Offset against a loan"
              help="UK/AU offset mortgages: this balance reduces the interest charged on the loan."
            >
              {(id) => (
                <Select
                  id={id}
                  value={value.offsetForLoanId ?? "none"}
                  onValueChange={(v) => set("offsetForLoanId", v === "none" ? undefined : v)}
                  options={[
                    { value: "none", label: "Not an offset account" },
                    ...loans.map((l) => ({ value: l.id, label: l.name })),
                  ]}
                />
              )}
            </FormField>
          ) : null}
        </>,
      )}
    </div>
  );
}

function BondAllocationEditor({
  value,
  onChange,
}: {
  value: AccountBehaviour["bondAllocation"];
  onChange: (v: AccountBehaviour["bondAllocation"]) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[12.5px] font-medium">Bond allocation</span>
        <Segmented<AccountBehaviour["bondAllocation"]["kind"]>
          aria-label="Bond allocation"
          size="sm"
          value={value.kind}
          onChange={(k) =>
            onChange(
              k === "fixed"
                ? { kind: "fixed", share: 0.4 }
                : k === "schedule"
                  ? {
                      kind: "schedule",
                      interpolation: "linear",
                      points: [
                        { at: { kind: "planStart", offsetMonths: 0 }, value: 0.2 },
                        { at: { kind: "planEnd", offsetMonths: 0 }, value: 0.6 },
                      ],
                    }
                  : { kind: k },
            )
          }
          options={[
            { value: "inherit", label: "Plan default" },
            { value: "none", label: "All stocks" },
            { value: "fixed", label: "Fixed" },
            { value: "schedule", label: "Glide path" },
          ]}
        />
      </div>
      {value.kind === "fixed" ? (
        <PercentInput
          aria-label="Bond share"
          className="w-[120px]"
          value={value.share}
          onValueChange={(share) => onChange({ kind: "fixed", share: share ?? 0 })}
        />
      ) : value.kind === "schedule" ? (
        <SchedulePointsEditor
          points={value.points}
          onChange={(points) => onChange({ ...value, points })}
          getValue={(p) => p.value}
          setValue={(p, v) => ({ ...p, value: v })}
          kind="percent"
          make={() => ({ at: { kind: "planStart", offsetMonths: 120 }, value: 0.4 })}
        />
      ) : null}
    </div>
  );
}

function WithdrawalRuleEditor({
  value,
  onChange,
}: {
  value: AccountBehaviour["withdrawals"];
  onChange: (v: AccountBehaviour["withdrawals"]) => void;
}) {
  const { milestones } = useScope();
  const defaultRef: DateRef = milestones[0]
    ? { kind: "milestone", milestoneId: milestones[0].id, offsetMonths: 0 }
    : { kind: "planStart", offsetMonths: 60 };
  return (
    <div className="grid gap-2">
      <EnumField<AccountBehaviour["withdrawals"]["kind"]>
        label="Withdrawals allowed"
        value={value.kind}
        onChange={(k) =>
          onChange(
            k === "from" || k === "until"
              ? { kind: k, ref: "ref" in value ? value.ref : defaultRef }
              : { kind: k },
          )
        }
        options={[
          { value: "always", label: "Any time" },
          { value: "afterQualifiedAge", label: "From the qualifying age" },
          { value: "from", label: "From a date or milestone" },
          { value: "until", label: "Until a date or milestone" },
          { value: "never", label: "Never (hold to the end)" },
        ]}
      />
      {value.kind === "from" || value.kind === "until" ? (
        <DateRefField
          label={value.kind === "from" ? "Allowed from" : "Allowed until"}
          value={value.ref}
          onChange={(ref) => onChange({ kind: value.kind as "from", ref })}
          allowNever={false}
        />
      ) : null}
    </div>
  );
}

function DistributionEditor({
  value,
  onChange,
  country,
}: {
  value: AccountBehaviour["distributions"];
  onChange: (v: AccountBehaviour["distributions"]) => void;
  country?: string;
}) {
  const rules = [
    { value: "us-rmd", label: "US required minimum distributions" },
    { value: "us-inherited-10-year", label: "US inherited: 10-year rule" },
    { value: "us-inherited-stretch", label: "US inherited: stretch" },
    { value: "ca-rrif-minimum", label: "Canada RRIF minimum" },
    { value: "au-minimum-drawdown", label: "Australia minimum drawdown" },
  ] as const;
  const defaultRule =
    country === "CA" ? "ca-rrif-minimum" : country === "AU" ? "au-minimum-drawdown" : "us-rmd";
  return (
    <div className="grid gap-2">
      <EnumField<AccountBehaviour["distributions"]["kind"]>
        label="Required distributions"
        help="Forced withdrawals from tax-deferred accounts (RMDs, RRIF minimums), or your own schedule."
        value={value.kind}
        onChange={(k) =>
          onChange(
            k === "none"
              ? { kind: "none" }
              : k === "required"
                ? { kind: "required", rule: defaultRule, alreadyTakenThisYear: 0 }
                : {
                    kind: "custom",
                    basis: "real",
                    points: [{ at: { kind: "planStart", offsetMonths: 0 }, value: 1000 }],
                  },
          )
        }
        options={[
          { value: "none", label: "None" },
          { value: "required", label: "Jurisdiction rule" },
          { value: "custom", label: "Custom schedule" },
        ]}
      />
      {value.kind === "required" ? (
        <FieldGrid>
          <EnumField
            label="Rule"
            value={value.rule}
            onChange={(rule) => onChange({ ...value, rule })}
            options={rules.map((r) => ({ ...r }))}
          />
          <FormField label="Already taken this year">
            {(id) => (
              <NumberInput
                id={id}
                decimals={0}
                value={value.alreadyTakenThisYear}
                onValueChange={(v) =>
                  onChange({ ...value, alreadyTakenThisYear: Math.max(0, v ?? 0) })
                }
              />
            )}
          </FormField>
        </FieldGrid>
      ) : value.kind === "custom" ? (
        <SchedulePointsEditor
          points={value.points}
          onChange={(points) => onChange({ ...value, points })}
          getValue={(p) => p.value}
          setValue={(p, v) => ({ ...p, value: v })}
          kind="money"
          label="Distribution"
          make={() => ({
            at: { kind: "planStart", offsetMonths: 12 * value.points.length },
            value: 1000,
          })}
        />
      ) : null}
    </div>
  );
}

function SeppEditor({
  value,
  onChange,
}: {
  value: AccountBehaviour["sepp"];
  onChange: (v: AccountBehaviour["sepp"]) => void;
}) {
  return (
    <div className="grid gap-2">
      <EnumField<AccountBehaviour["sepp"]["method"]>
        label="72(t) SEPP"
        help="Substantially equal periodic payments: penalty-free early withdrawals from IRAs and 401(k)s."
        value={value.method}
        onChange={(method) => onChange({ ...value, method })}
        options={[
          { value: "none", label: "Not used" },
          { value: "rmd", label: "RMD method" },
          { value: "fixed-amortization", label: "Fixed amortisation" },
          { value: "fixed-annuitization", label: "Fixed annuitisation" },
          { value: "custom", label: "Custom amount" },
        ]}
      />
      {value.method !== "none" ? (
        <>
          <DateRefField
            label="SEPP starts"
            value={value.start ?? { kind: "planStart", offsetMonths: 0 }}
            onChange={(start) => onChange({ ...value, start })}
            allowNever={false}
          />
          {value.method === "fixed-amortization" || value.method === "fixed-annuitization" ? (
            <FormField label="Interest rate">
              {(id) => (
                <PercentInput
                  id={id}
                  className="w-[120px]"
                  value={value.interestRate ?? 0.05}
                  onValueChange={(v) => onChange({ ...value, interestRate: v ?? undefined })}
                />
              )}
            </FormField>
          ) : null}
          {value.method === "custom" ? (
            <FormField label="Amount per year">
              {(id) => (
                <AmountInput
                  id={id}
                  value={value.customAmount ?? { value: 0, basis: "nominal" }}
                  onChange={(customAmount) => onChange({ ...value, customAmount })}
                />
              )}
            </FormField>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
