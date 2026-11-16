import {
  REAL_ASSET_TYPES,
  RealAsset,
  type RealAssetBehaviour,
  type RealAssetType,
} from "@glideworth/core";
import { Archive, Trash2 } from "lucide-react";
import { AppearancePicker } from "../../components/ui/appearance-picker";
import { Button } from "../../components/ui/button";
import { confirmAction } from "../../components/ui/confirm-dialog";
import { Input } from "../../components/ui/input";
import {
  AmountInput,
  CurrencyInput,
  NumberInput,
  PercentInput,
} from "../../components/ui/number-input";
import { Select } from "../../components/ui/select";
import { FieldGrid, FormSection, Sheet, SheetClose, SheetContent } from "../../components/ui/sheet";
import { SwitchField } from "../../components/ui/switch";
import { Textarea } from "../../components/ui/textarea";
import { useFormat } from "../../lib/workspace";
import { AcquisitionFields } from "../crossborder/asset-fields";
import { CurrencyPrompt, ItemCountryField } from "../crossborder/fields";
import { isCrossBorder } from "../crossborder/model";
import { CurrencySelect } from "../currency/fx";
import {
  AccountListEditor,
  AssetCostEditor,
  ChangeEditor,
  DateRefField,
  EnumField,
  FormField,
  OwnerSelect,
} from "../plan-editor/components/form";
import { newId } from "../plan-editor/state/defaults";
import { addMonths, monthsToPayoff, paymentFor } from "../plan-editor/state/finance-math";
import { HELP, REAL_ASSET_TYPES_LABEL } from "../plan-editor/state/labels";
import { type Issues, scopeIssues, useIssues } from "../plan-editor/state/validation";
import { updateFinances, useDraftDoc, useReferencePlan } from "./use-finances";

export function AssetSheet({ id, onClose }: { id: string | null; onClose: () => void }) {
  return (
    <Sheet open={!!id} onOpenChange={(o) => !o && onClose()}>
      {id ? <AssetSheetBody id={id} onClose={onClose} /> : null}
    </Sheet>
  );
}

function AssetSheetBody({ id, onClose }: { id: string; onClose: () => void }) {
  const doc = useDraftDoc();
  const f = useFormat();
  const asset = doc?.finances.realAssets.find((r) => r.id === id);
  const issues = useIssues(RealAsset, asset);
  const plan = useReferencePlan();
  if (!doc || !asset) return null;
  const update = (fn: (a: RealAsset) => RealAsset, label: string, coalesce?: string) =>
    updateFinances(
      (fin) => ({ ...fin, realAssets: fin.realAssets.map((a) => (a.id === id ? fn(a) : a)) }),
      label,
      coalesce ? `${id}:${coalesce}` : undefined,
    );
  const remove = async () => {
    if (
      !(await confirmAction({
        title: `Delete ${asset.name}?`,
        description: "Its loan is removed too. You can undo this.",
        confirmLabel: "Delete",
      }))
    )
      return;
    onClose();
    updateFinances(
      (fin) => ({ ...fin, realAssets: fin.realAssets.filter((a) => a.id !== id) }),
      `Delete ${asset.name}`,
    );
  };
  const equity = asset.currentValue - (asset.loan?.balance ?? 0);
  const crossBorder = isCrossBorder(doc, plan);
  const m = (v: number) => (asset.currency ? f.moneyIn(v, asset.currency) : f.money(v));

  return (
    <SheetContent
      eyebrow="Property & possessions"
      title={asset.name || "Untitled asset"}
      description={`Equity ${m(equity)}${asset.loan ? ` · loan ${m(asset.loan.balance)}` : ""}`}
      width={620}
      footer={
        <>
          <Button variant="ghost" size="sm" className="text-negative" onClick={remove}>
            <Trash2 /> Delete
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => update((a) => ({ ...a, archived: !a.archived }), "Archive asset")}
          >
            <Archive /> {asset.archived ? "Restore" : "Archive"}
          </Button>
          <SheetClose asChild>
            <Button variant="primary" className="ml-auto">
              Done
            </Button>
          </SheetClose>
        </>
      }
    >
      <FormSection title="Details">
        <FieldGrid>
          <FormField label="Name" error={issues.get("name")}>
            {(fid) => (
              <Input
                id={fid}
                value={asset.name}
                onChange={(e) =>
                  update((a) => ({ ...a, name: e.target.value }), "Rename asset", "name")
                }
              />
            )}
          </FormField>
          <EnumField<RealAssetType>
            label="Type"
            value={asset.type}
            onChange={(type) => update((a) => ({ ...a, type }), "Change asset type")}
            options={REAL_ASSET_TYPES.map((t) => ({
              value: t,
              label: REAL_ASSET_TYPES_LABEL[t] ?? t,
            }))}
          />
          <FormField label="Owner" error={issues.get("owner")}>
            {(fid) => (
              <OwnerSelect
                id={fid}
                value={asset.owner}
                onChange={(owner) => update((a) => ({ ...a, owner }), "Change owner")}
              />
            )}
          </FormField>
          <EnumField<RealAssetBehaviour["usage"]>
            label="Used as"
            help="A primary residence can qualify for tax relief on sale; investment property unlocks rental income."
            value={asset.behaviour.usage}
            onChange={(usage) =>
              update((a) => ({ ...a, behaviour: { ...a.behaviour, usage } }), "Change usage")
            }
            options={[
              { value: "primary-residence", label: "Main home" },
              { value: "personal", label: "Personal use" },
              { value: "investment", label: "Investment / let" },
            ]}
          />
          <ItemCountryField
            value={asset.country}
            inherited={doc.household.location.country}
            inheritedWhy="household"
            onChange={(country) => update((a) => ({ ...a, country }), "Change asset country")}
            help="Where it is. Rent and gains on property are usually taxed there even after you move away."
          />
          <FormField
            label="Currency"
            hint={
              asset.currency ? "The value, loan and running costs are in this currency." : undefined
            }
          >
            {(fid) => (
              <CurrencySelect
                id={fid}
                value={asset.currency}
                base={doc.household.currency}
                onChange={(currency) =>
                  update((a) => ({ ...a, currency }), "Change asset currency")
                }
              />
            )}
          </FormField>
          <div className="sm:col-span-2">
            <CurrencyPrompt
              what="This asset"
              country={asset.country ?? doc.household.location.country}
              currency={asset.currency}
              onUseCurrency={(currency) =>
                update((a) => ({ ...a, currency }), "Change asset currency")
              }
            />
          </div>
          <FormField label="Current value" error={issues.get("currentValue")}>
            {(fid) => (
              <CurrencyInput
                id={fid}
                currency={asset.currency}
                value={asset.currentValue}
                onValueChange={(v) =>
                  update((a) => ({ ...a, currentValue: v ?? 0 }), "Update value", "value")
                }
              />
            )}
          </FormField>
          <FormField
            label="Purchase price"
            hint="Used for capital gains when sold."
            error={issues.get("purchasePrice")}
          >
            {(fid) => (
              <CurrencyInput
                id={fid}
                currency={asset.currency}
                value={asset.purchasePrice ?? null}
                onValueChange={(v) =>
                  update(
                    (a) => ({ ...a, purchasePrice: v ?? undefined }),
                    "Update purchase price",
                    "price",
                  )
                }
              />
            )}
          </FormField>
        </FieldGrid>
        {crossBorder ? (
          <AcquisitionFields
            acquiredOn={asset.acquiredOn}
            valuations={asset.valuations ?? []}
            currency={asset.currency}
            country={asset.country ?? doc.household.location.country}
            onChange={(patch, label, key) => update((a) => ({ ...a, ...patch }), label, key)}
          />
        ) : null}
      </FormSection>

      <FormSection
        title="Mortgage or loan"
        description="Secured lending on this asset. Payments come out of cash flow automatically; don’t add them as expenses."
      >
        <SwitchField
          label="Financed"
          checked={!!asset.loan}
          onCheckedChange={(on) =>
            update(
              (a) => ({
                ...a,
                loan: on
                  ? {
                      id: newId("loan"),
                      balance: Math.round(a.currentValue * 0.6),
                      interest: { apr: 0.045, method: "compound", compounding: "monthly" },
                      monthlyPayment: { value: 1000, basis: "nominal" },
                    }
                  : undefined,
              }),
              on ? "Add loan" : "Remove loan",
            )
          }
        />
        {asset.loan ? (
          <LoanEditor
            loan={asset.loan}
            issues={scopeIssues(issues, "loan")}
            onChange={(loan) => update((a) => ({ ...a, loan }), "Edit loan", "loan")}
            asOf={doc.finances.asOf}
          />
        ) : null}
      </FormSection>

      <FormSection title="Value over time">
        <ChangeEditor
          label="Appreciation"
          help={HELP.appreciation}
          value={asset.behaviour.appreciation}
          onChange={(appreciation) =>
            update(
              (a) => ({ ...a, behaviour: { ...a.behaviour, appreciation } }),
              "Edit appreciation",
              "appr",
            )
          }
        />
      </FormSection>

      <AssetBehaviourSections
        behaviour={asset.behaviour}
        onChange={(behaviour, label, key) => update((a) => ({ ...a, behaviour }), label, key)}
      />

      <FormSection title="Notes & appearance">
        <Textarea
          aria-label="Notes"
          value={asset.notes ?? ""}
          onChange={(e) =>
            update((a) => ({ ...a, notes: e.target.value || undefined }), "Edit notes", "notes")
          }
        />
        <AppearancePicker
          value={asset.appearance}
          onChange={(appearance) => update((a) => ({ ...a, appearance }), "Change appearance")}
        />
      </FormSection>
    </SheetContent>
  );
}

/** Running costs, rental, sale and liquidation: shared by Current Finances and plan overrides. */
export function AssetBehaviourSections({
  behaviour: b,
  onChange,
}: {
  behaviour: RealAssetBehaviour;
  onChange: (b: RealAssetBehaviour, label: string, coalesce?: string) => void;
}) {
  const set = <K extends keyof RealAssetBehaviour>(k: K, v: RealAssetBehaviour[K], label: string) =>
    onChange({ ...b, [k]: v }, label, k);
  return (
    <>
      <FormSection
        title="Running costs"
        description="These flow into your cash flow automatically."
      >
        <AssetCostEditor
          label="Maintenance"
          value={b.maintenance}
          onChange={(v) => set("maintenance", v, "Edit maintenance")}
        />
        <AssetCostEditor
          label="Insurance"
          value={b.insurance}
          onChange={(v) => set("insurance", v, "Edit insurance")}
        />
        <AssetCostEditor
          label="Improvements"
          value={b.improvements}
          onChange={(v) => set("improvements", v, "Edit improvements")}
        />
        <AssetCostEditor
          label="Service charge / HOA"
          value={b.hoa}
          onChange={(v) => set("hoa", v, "Edit service charge")}
        />
        <SwitchField
          label="Property tax"
          hint="Annual tax on the property’s value (US-style). UK council tax is better entered as a housing expense."
          checked={!!b.propertyTax}
          onCheckedChange={(on) =>
            set(
              "propertyTax",
              on
                ? {
                    cost: { kind: "percentOfValue", rate: 0.01 },
                    assessedValue: { kind: "marketValue" },
                    reassessment: { kind: "auto" },
                  }
                : undefined,
              "Toggle property tax",
            )
          }
        />
        {b.propertyTax ? (
          <div className="grid gap-3 rounded-lg border border-border p-3">
            <AssetCostEditor
              label="Tax"
              value={b.propertyTax.cost}
              onChange={(cost) =>
                set("propertyTax", { ...b.propertyTax!, cost }, "Edit property tax")
              }
            />
            <FieldGrid>
              <EnumField<"marketValue" | "specific">
                label="Assessed on"
                value={b.propertyTax.assessedValue.kind}
                onChange={(k) =>
                  set(
                    "propertyTax",
                    {
                      ...b.propertyTax!,
                      assessedValue:
                        k === "marketValue"
                          ? { kind: "marketValue" }
                          : { kind: "specific", amount: 0 },
                    },
                    "Edit assessment",
                  )
                }
                options={[
                  { value: "marketValue", label: "Market value" },
                  { value: "specific", label: "A specific assessed value" },
                ]}
              />
              {b.propertyTax.assessedValue.kind === "specific" ? (
                <FormField label="Assessed value">
                  {(id) => (
                    <CurrencyInput
                      id={id}
                      value={(b.propertyTax!.assessedValue as { amount: number }).amount}
                      onValueChange={(v) =>
                        set(
                          "propertyTax",
                          {
                            ...b.propertyTax!,
                            assessedValue: { kind: "specific", amount: Math.max(0, v ?? 0) },
                          },
                          "Edit assessed value",
                        )
                      }
                    />
                  )}
                </FormField>
              ) : null}
              <EnumField<"auto" | "default" | "capped" | "ratcheting">
                label="Reassessment"
                help="Some places cap how fast the assessed value may rise (e.g. California Prop 13). “Auto” applies known rules for your location."
                value={b.propertyTax.reassessment.kind}
                onChange={(k) =>
                  set(
                    "propertyTax",
                    {
                      ...b.propertyTax!,
                      reassessment:
                        k === "capped" || k === "ratcheting"
                          ? { kind: k, maxGrowth: 0.02 }
                          : { kind: k },
                    },
                    "Edit reassessment",
                  )
                }
                options={[
                  { value: "auto", label: "Auto for location" },
                  { value: "default", label: "Follows market value" },
                  { value: "capped", label: "Capped growth" },
                  { value: "ratcheting", label: "Ratcheting cap" },
                ]}
              />
              {b.propertyTax.reassessment.kind === "capped" ||
              b.propertyTax.reassessment.kind === "ratcheting" ? (
                <FormField label="Max growth / yr">
                  {(id) => (
                    <PercentInput
                      id={id}
                      value={(b.propertyTax!.reassessment as { maxGrowth: number }).maxGrowth}
                      onValueChange={(v) =>
                        set(
                          "propertyTax",
                          {
                            ...b.propertyTax!,
                            reassessment: {
                              kind: (b.propertyTax!.reassessment as { kind: "capped" }).kind,
                              maxGrowth: v ?? 0,
                            },
                          },
                          "Edit cap",
                        )
                      }
                    />
                  )}
                </FormField>
              ) : null}
            </FieldGrid>
          </div>
        ) : null}
      </FormSection>

      <FormSection title="Rental income">
        <SwitchField
          label="Let this out"
          hint="Rental income is taxed and counts as passive income."
          checked={!!b.rental?.enabled}
          onCheckedChange={(on) =>
            set(
              "rental",
              {
                enabled: on,
                income: b.rental?.income ?? { kind: "percentOfValue", rate: 0.05 },
                occupancy: b.rental?.occupancy ?? 1,
                rentedShare: b.rental?.rentedShare ?? 1,
                management: b.rental?.management ?? { kind: "none" },
                taxSettings: b.rental?.taxSettings ?? {
                  selfEmployment: false,
                  estimateDeductions: true,
                  qbiDeduction: false,
                  buildingValue: 0,
                  classification: "residential",
                  taxNetIncomeOnly: false,
                },
                countsAsPassiveIncome: b.rental?.countsAsPassiveIncome ?? true,
              },
              on ? "Enable rental" : "Disable rental",
            )
          }
        />
        {b.rental?.enabled ? (
          <div className="grid gap-3 rounded-lg border border-border p-3">
            <FormField label="Rent">
              {(id) => (
                <div className="flex flex-wrap items-center gap-1.5">
                  <Select<"percentOfValue" | "amountPerYear" | "amountPerMonth">
                    id={id}
                    value={b.rental!.income.kind}
                    onValueChange={(k) =>
                      set(
                        "rental",
                        {
                          ...b.rental!,
                          income:
                            k === "percentOfValue"
                              ? { kind: k, rate: 0.05 }
                              : {
                                  kind: k,
                                  amount: {
                                    value: k === "amountPerMonth" ? 1200 : 14_400,
                                    basis: "real",
                                  },
                                },
                        },
                        "Edit rent",
                      )
                    }
                    options={[
                      { value: "amountPerMonth", label: "Per month" },
                      { value: "amountPerYear", label: "Per year" },
                      { value: "percentOfValue", label: "% of value / yr" },
                    ]}
                    className="w-[150px]"
                  />
                  {b.rental!.income.kind === "percentOfValue" ? (
                    <PercentInput
                      aria-label="Gross yield"
                      className="w-[110px]"
                      value={b.rental!.income.rate}
                      onValueChange={(v) =>
                        set(
                          "rental",
                          { ...b.rental!, income: { kind: "percentOfValue", rate: v ?? 0 } },
                          "Edit rent",
                        )
                      }
                    />
                  ) : (
                    <div className="min-w-[220px] flex-1">
                      <AmountInput
                        value={b.rental!.income.amount}
                        onChange={(amount) =>
                          set(
                            "rental",
                            {
                              ...b.rental!,
                              income: {
                                kind: (b.rental!.income as { kind: "amountPerYear" }).kind,
                                amount,
                              },
                            },
                            "Edit rent",
                          )
                        }
                      />
                    </div>
                  )}
                </div>
              )}
            </FormField>
            <FieldGrid>
              <FormField label="Occupancy" help="Share of the year it is let (allow for voids).">
                {(id) => (
                  <PercentInput
                    id={id}
                    value={b.rental!.occupancy}
                    onValueChange={(v) =>
                      set("rental", { ...b.rental!, occupancy: v ?? 1 }, "Edit occupancy")
                    }
                  />
                )}
              </FormField>
              <FormField
                label="Share rented"
                help="For lodgers / house hacking: the rest counts as personal use."
              >
                {(id) => (
                  <PercentInput
                    id={id}
                    value={b.rental!.rentedShare}
                    onValueChange={(v) =>
                      set("rental", { ...b.rental!, rentedShare: v ?? 1 }, "Edit share rented")
                    }
                  />
                )}
              </FormField>
            </FieldGrid>
            <AssetCostEditor
              label="Letting / management fees"
              value={b.rental!.management}
              onChange={(management) =>
                set("rental", { ...b.rental!, management }, "Edit management")
              }
            />
            <SwitchField
              label="Tax net income only"
              hint="Common outside the US: tax rent after allowable costs."
              checked={b.rental!.taxSettings.taxNetIncomeOnly}
              onCheckedChange={(v) =>
                set(
                  "rental",
                  { ...b.rental!, taxSettings: { ...b.rental!.taxSettings, taxNetIncomeOnly: v } },
                  "Edit rental tax",
                )
              }
            />
            <SwitchField
              label="Estimate deductions (US)"
              hint="Depreciation, mortgage interest and running costs."
              checked={b.rental!.taxSettings.estimateDeductions}
              onCheckedChange={(v) =>
                set(
                  "rental",
                  {
                    ...b.rental!,
                    taxSettings: { ...b.rental!.taxSettings, estimateDeductions: v },
                  },
                  "Edit rental tax",
                )
              }
            />
            <SwitchField
              label="Counts as passive income"
              checked={b.rental!.countsAsPassiveIncome}
              onCheckedChange={(v) =>
                set("rental", { ...b.rental!, countsAsPassiveIncome: v }, "Edit rental")
              }
            />
          </div>
        ) : null}
      </FormSection>

      <FormSection title="Selling">
        <SwitchField
          label="Planned sale"
          checked={!!b.sale}
          onCheckedChange={(on) =>
            set(
              "sale",
              on
                ? {
                    at: { kind: "planStart", offsetMonths: 120 },
                    brokerFeeRate: 0.02,
                    gainReduction: 0,
                    proceedsTo: { kind: "auto" },
                  }
                : undefined,
              on ? "Plan a sale" : "Remove sale",
            )
          }
        />
        {b.sale ? (
          <div className="grid gap-3 rounded-lg border border-border p-3">
            <DateRefField
              label="Sell at"
              value={b.sale.at}
              onChange={(at) => set("sale", { ...b.sale!, at }, "Edit sale date")}
              allowNever={false}
            />
            <FieldGrid>
              <FormField
                label="Selling costs"
                help="Agent and legal fees as a share of the sale price."
              >
                {(id) => (
                  <PercentInput
                    id={id}
                    value={b.sale!.brokerFeeRate}
                    onValueChange={(v) =>
                      set("sale", { ...b.sale!, brokerFeeRate: v ?? 0 }, "Edit selling costs")
                    }
                  />
                )}
              </FormField>
              <FormField
                label="Extra gain relief"
                help="Share of the gain exempt beyond automatic reliefs (e.g. partial lettings relief)."
              >
                {(id) => (
                  <PercentInput
                    id={id}
                    value={b.sale!.gainReduction}
                    onValueChange={(v) =>
                      set("sale", { ...b.sale!, gainReduction: v ?? 0 }, "Edit gain relief")
                    }
                  />
                )}
              </FormField>
            </FieldGrid>
            <EnumField<"auto" | "accounts">
              label="Proceeds go to"
              value={b.sale.proceedsTo.kind}
              onChange={(k) =>
                set(
                  "sale",
                  {
                    ...b.sale!,
                    proceedsTo:
                      k === "auto" ? { kind: "auto" } : { kind: "accounts", accountIds: [] },
                  },
                  "Edit proceeds",
                )
              }
              options={[
                { value: "auto", label: "Cash flow (then your Flows)" },
                { value: "accounts", label: "Specific accounts" },
              ]}
            />
            {b.sale.proceedsTo.kind === "accounts" ? (
              <AccountListEditor
                ids={b.sale.proceedsTo.accountIds}
                onChange={(accountIds) =>
                  set(
                    "sale",
                    { ...b.sale!, proceedsTo: { kind: "accounts", accountIds } },
                    "Edit proceeds",
                  )
                }
              />
            ) : null}
          </div>
        ) : null}
        <SwitchField
          label="Sell if needed"
          hint={HELP.liquidate}
          checked={b.liquidateIfNeeded}
          onCheckedChange={(v) => set("liquidateIfNeeded", v, "Toggle sell if needed")}
        />
        <SwitchField
          label="Exclude loan from liquid net worth"
          checked={b.excludeLoanFromLiquidNetWorth}
          onCheckedChange={(v) => set("excludeLoanFromLiquidNetWorth", v, "Toggle loan exclusion")}
        />
      </FormSection>
    </>
  );
}

export function LoanEditor({
  loan,
  onChange,
  issues,
  asOf,
}: {
  loan: NonNullable<RealAsset["loan"]>;
  onChange: (l: NonNullable<RealAsset["loan"]>) => void;
  issues: Issues;
  asOf: string;
}) {
  return (
    <InterestPaymentFields
      balance={loan.balance}
      interest={loan.interest}
      payment={loan.monthlyPayment}
      issues={issues}
      asOf={asOf}
      onChange={(v) => onChange({ ...loan, ...v })}
      termEnd={loan.termEnd}
      onTermEnd={(termEnd) => onChange({ ...loan, termEnd })}
    />
  );
}

/** Balance, APR, payment and a derived payoff (editable: changing years re-solves the payment). */
export function InterestPaymentFields({
  balance,
  interest,
  payment,
  onChange,
  issues,
  asOf,
  termEnd,
  onTermEnd,
}: {
  balance: number;
  interest: NonNullable<RealAsset["loan"]>["interest"];
  payment: NonNullable<RealAsset["loan"]>["monthlyPayment"];
  onChange: (v: {
    balance?: number;
    interest?: NonNullable<RealAsset["loan"]>["interest"];
    monthlyPayment?: NonNullable<RealAsset["loan"]>["monthlyPayment"];
  }) => void;
  issues: Issues;
  asOf: string;
  termEnd?: NonNullable<RealAsset["loan"]>["termEnd"];
  onTermEnd?: (t: NonNullable<RealAsset["loan"]>["termEnd"]) => void;
}) {
  const f = useFormat();
  const months = monthsToPayoff(balance, interest.apr, payment.value, interest.compounding);
  const payoff = months === null ? null : addMonths(asOf, months);
  const minPayment = balance * (interest.apr / 12);
  return (
    <div className="grid gap-3">
      <FieldGrid>
        <FormField label="Balance outstanding" error={issues.get("balance")}>
          {(id) => (
            <CurrencyInput
              id={id}
              value={balance}
              onValueChange={(v) => onChange({ balance: Math.max(0, v ?? 0) })}
            />
          )}
        </FormField>
        <FormField label="Interest rate (APR)" error={issues.under("interest.apr")}>
          {(id) => (
            <PercentInput
              id={id}
              decimals={3}
              value={interest.apr}
              onValueChange={(v) => onChange({ interest: { ...interest, apr: v ?? 0 } })}
            />
          )}
        </FormField>
        <FormField label="Monthly payment" help={HELP.basis} error={issues.under("monthlyPayment")}>
          {(id) => (
            <AmountInput
              id={id}
              value={payment}
              onChange={(monthlyPayment) => onChange({ monthlyPayment })}
            />
          )}
        </FormField>
        <FormField
          label="Years to pay off"
          help="Edit this to work out the payment needed."
          hint={
            months === null
              ? `Payment doesn’t cover interest (min ${f.money(minPayment)}/mo)`
              : payoff
                ? `Paid off ≈ ${new Intl.DateTimeFormat(f.locale, { month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${payoff}-01T00:00:00Z`))}`
                : undefined
          }
        >
          {(id) => (
            <NumberInput
              id={id}
              decimals={1}
              suffix="yrs"
              value={months === null ? null : Math.round((months / 12) * 10) / 10}
              onValueChange={(v) => {
                if (v === null || v <= 0) return;
                onChange({
                  monthlyPayment: {
                    ...payment,
                    value:
                      Math.round(
                        paymentFor(
                          balance,
                          interest.apr,
                          Math.round(v * 12),
                          interest.compounding,
                        ) * 100,
                      ) / 100,
                  },
                });
              }}
            />
          )}
        </FormField>
      </FieldGrid>
      <FieldGrid>
        <EnumField<"simple" | "compound">
          label="Interest"
          value={interest.method}
          onChange={(method) => onChange({ interest: { ...interest, method } })}
          options={[
            { value: "compound", label: "Compound" },
            { value: "simple", label: "Simple" },
          ]}
        />
        <EnumField<"daily" | "monthly" | "annually">
          label="Compounding"
          value={interest.compounding}
          onChange={(compounding) => onChange({ interest: { ...interest, compounding } })}
          options={[
            { value: "monthly", label: "Monthly" },
            { value: "daily", label: "Daily" },
            { value: "annually", label: "Annually" },
          ]}
        />
      </FieldGrid>
      {onTermEnd ? (
        <SwitchField
          label="Fixed term end"
          hint="E.g. an interest-only mortgage that must be repaid at the end of its term."
          checked={!!termEnd}
          onCheckedChange={(on) =>
            onTermEnd(
              on
                ? { kind: "date", date: payoff ?? addMonths(asOf, 300), offsetMonths: 0 }
                : undefined,
            )
          }
        />
      ) : null}
      {onTermEnd && termEnd ? (
        <DateRefField label="Term ends" value={termEnd} onChange={onTermEnd} allowNever={false} />
      ) : null}
    </div>
  );
}
