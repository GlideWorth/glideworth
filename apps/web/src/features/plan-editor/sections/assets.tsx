/**
 * Property & debts in a plan: per-plan overrides of real-asset behaviour (sale, rental, costs,
 * appreciation) and of debt payments, include/exclude, and assets bought during the plan
 * (with financing and repeat purchases, e.g. a car every 8 years).
 */
import {
  type Debt,
  type DebtBehaviour,
  PlannedRealAsset,
  REAL_ASSET_TYPES,
  type RealAsset,
  RealAssetBehaviour,
  type RealAssetType,
} from "@glideworth/core";
import { CalendarPlus, Home, RotateCcw, SlidersHorizontal, Trash2 } from "lucide-react";
import { useState } from "react";
import {
  ActionMenu,
  ActionMenuContent,
  ActionMenuItem,
  ActionMenuTrigger,
} from "../../../components/ui/action-menu";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { Card, CardHeader } from "../../../components/ui/card";
import { EmptyState } from "../../../components/ui/empty-state";
import { Input } from "../../../components/ui/input";
import { AmountInput, NumberInput, PercentInput } from "../../../components/ui/number-input";
import {
  FieldGrid,
  FormSection,
  Sheet,
  SheetClose,
  SheetContent,
} from "../../../components/ui/sheet";
import { Switch, SwitchField } from "../../../components/ui/switch";
import { useFormat } from "../../../lib/workspace";
import { AssetBehaviourSections } from "../../finances/asset-sheet";
import {
  AccountListEditor,
  ChangeEditor,
  DateRefField,
  EnumField,
  FormField,
  OwnerSelect,
} from "../components/form";
import { usePlan, useUpdatePlan } from "../components/plan-context";
import { newId } from "../state/defaults";
import { useEditorStore } from "../state/doc-store";
import { HELP, REAL_ASSET_TYPES_LABEL } from "../state/labels";
import { deepEqual } from "../state/merge";
import { useIssues } from "../state/validation";

export function AssetsSection() {
  const plan = usePlan();
  const update = useUpdatePlan();
  const finances = useEditorStore((s) => s.draft?.finances);
  const f = useFormat();
  const [open, setOpen] = useState<{ kind: "asset" | "debt" | "planned"; id: string } | null>(null);
  if (!plan || !finances) return null;
  const toggle = (id: string, name: string, on: boolean) =>
    update(
      (p) => ({
        ...p,
        excludedIds: on ? p.excludedIds.filter((x) => x !== id) : [...p.excludedIds, id],
      }),
      on ? `Include ${name}` : `Exclude ${name}`,
    );
  const addPlanned = (type: RealAssetType) => {
    const a = PlannedRealAsset.parse({
      id: newId("ra"),
      name: type === "house" ? "Next home" : (REAL_ASSET_TYPES_LABEL[type] ?? "Asset"),
      type,
      owner: plan.income[0]?.owner ?? "joint",
      behaviour:
        type === "car"
          ? { appreciation: { kind: "rate", rate: -0.15 } }
          : type === "house"
            ? { usage: "primary-residence" }
            : {},
      purchase: {
        at: { kind: "planStart", offsetMonths: 24 },
        price: { value: type === "car" ? 20_000 : 350_000, basis: "real" },
      },
    });
    update((p) => ({ ...p, plannedRealAssets: [...p.plannedRealAssets, a] }), `Plan ${a.name}`);
    setOpen({ kind: "planned", id: a.id });
  };
  const row = (id: string, name: string, sub: string, overrides: number) => {
    const included = !plan.excludedIds.includes(id);
    return (
      <li key={id} className="flex items-center gap-3 px-3 py-2 sm:px-4">
        <Switch
          size="sm"
          aria-label={`Include ${name}`}
          checked={included}
          onCheckedChange={(on) => toggle(id, name, on)}
        />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium">{name}</div>
          <div className="truncate text-[11.5px] text-ink-3">{sub}</div>
        </div>
        {!included ? (
          <Badge>Excluded</Badge>
        ) : overrides ? (
          <Badge tone="ochre">
            {overrides} override{overrides > 1 ? "s" : ""}
          </Badge>
        ) : null}
        <Button
          size="icon"
          variant="ghost"
          className="size-7"
          disabled={!included}
          aria-label={`${name} in this plan`}
          onClick={() =>
            setOpen({ kind: finances.debts.some((d) => d.id === id) ? "debt" : "asset", id })
          }
        >
          <SlidersHorizontal />
        </Button>
      </li>
    );
  };
  return (
    <>
      <Card>
        <CardHeader eyebrow="From current finances" title="Property, possessions & debts" />
        {finances.realAssets.length + finances.debts.length === 0 ? (
          <EmptyState compact icon={Home} title="Nothing to adjust yet">
            Add your home, car or debts in Current Finances. Then sell, rent out or overpay them
            differently in each plan here.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-border">
            {finances.realAssets
              .filter((r) => !r.archived)
              .map((r) =>
                row(
                  r.id,
                  r.name,
                  `${REAL_ASSET_TYPES_LABEL[r.type]} · ${f.money(r.currentValue)}${r.loan ? ` · loan ${f.money(r.loan.balance)}` : ""}`,
                  Object.keys(plan.realAssetSettings[r.id] ?? {}).length,
                ),
              )}
            {finances.debts
              .filter((d) => !d.archived)
              .map((d) =>
                row(
                  d.id,
                  d.name,
                  `Debt · ${f.money(d.balance)} at ${f.percent(d.interest.apr, 2)}`,
                  Object.keys(plan.debtSettings[d.id] ?? {}).length,
                ),
              )}
          </ul>
        )}
      </Card>
      <Card>
        <CardHeader
          eyebrow="Bought during the plan"
          title="Planned purchases"
          actions={
            <ActionMenu>
              <ActionMenuTrigger asChild>
                <Button size="sm">
                  <CalendarPlus /> Plan a purchase
                </Button>
              </ActionMenuTrigger>
              <ActionMenuContent>
                {REAL_ASSET_TYPES.map((t) => (
                  <ActionMenuItem key={t} onSelect={() => addPlanned(t)}>
                    {REAL_ASSET_TYPES_LABEL[t]}
                  </ActionMenuItem>
                ))}
              </ActionMenuContent>
            </ActionMenu>
          }
        />
        {plan.plannedRealAssets.length === 0 ? (
          <EmptyState compact icon={CalendarPlus} title="Future homes, cars and big purchases">
            Buying a bigger home in five years, or a new car every eight: plan the purchase, how
            it’s paid for, and whether it repeats.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-border">
            {plan.plannedRealAssets.map((a) => (
              <li key={a.id} className="flex items-center gap-3 px-3 py-2 sm:px-4">
                <button
                  type="button"
                  className="group min-w-0 flex-1 text-left"
                  onClick={() => setOpen({ kind: "planned", id: a.id })}
                >
                  <div className="truncate text-[13px] font-medium group-hover:text-accent">
                    {a.name}
                  </div>
                  <div className="truncate text-[11.5px] text-ink-3">
                    {REAL_ASSET_TYPES_LABEL[a.type]} · {f.money(a.purchase.price.value)}
                    {a.behaviour.recurrence
                      ? ` · every ${a.behaviour.recurrence.yearsBetween} yrs`
                      : ""}
                  </div>
                </button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-7"
                  aria-label={`Remove ${a.name}`}
                  onClick={() =>
                    update(
                      (p) => ({
                        ...p,
                        plannedRealAssets: p.plannedRealAssets.filter((x) => x.id !== a.id),
                      }),
                      `Remove ${a.name}`,
                    )
                  }
                >
                  <Trash2 />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <AssetOverrideSheet
        id={open?.kind === "asset" ? open.id : null}
        onClose={() => setOpen(null)}
      />
      <DebtOverrideSheet
        id={open?.kind === "debt" ? open.id : null}
        onClose={() => setOpen(null)}
      />
      <PlannedAssetSheet
        id={open?.kind === "planned" ? open.id : null}
        onClose={() => setOpen(null)}
      />
    </>
  );
}

function AssetOverrideSheet({ id, onClose }: { id: string | null; onClose: () => void }) {
  const plan = usePlan();
  const update = useUpdatePlan();
  const asset = useEditorStore((s) => s.draft?.finances.realAssets.find((r) => r.id === id)) as
    | RealAsset
    | undefined;
  const content =
    plan && asset
      ? (() => {
          const patch = plan.realAssetSettings[asset.id] ?? {};
          const eff = RealAssetBehaviour.parse({ ...asset.behaviour, ...patch });
          const write = (next: RealAssetBehaviour, label: string, key?: string) =>
            update(
              (p) => {
                const np: Record<string, unknown> = {};
                for (const k of Object.keys(next) as (keyof RealAssetBehaviour)[])
                  if (!deepEqual(next[k], asset.behaviour[k])) np[k] = next[k];
                const settings = { ...p.realAssetSettings };
                if (Object.keys(np).length) settings[asset.id] = np;
                else delete settings[asset.id];
                return { ...p, realAssetSettings: settings };
              },
              label,
              key ? `${asset.id}:${key}` : undefined,
            );
          return (
            <SheetContent
              eyebrow={`In “${plan.name}”`}
              title={asset.name}
              description="Overrides for this plan only, e.g. sell the house at retirement, or let it out."
              width={620}
              footer={
                <>
                  {Object.keys(patch).length ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        update((p) => {
                          const s = { ...p.realAssetSettings };
                          delete s[asset.id];
                          return { ...p, realAssetSettings: s };
                        }, "Reset asset overrides")
                      }
                    >
                      <RotateCcw /> Reset to defaults
                    </Button>
                  ) : null}
                  <SheetClose asChild>
                    <Button variant="primary" className="ml-auto">
                      Done
                    </Button>
                  </SheetClose>
                </>
              }
            >
              <FormSection title="Value over time">
                <ChangeEditor
                  label="Appreciation"
                  help={HELP.appreciation}
                  value={eff.appreciation}
                  onChange={(appreciation) =>
                    write({ ...eff, appreciation }, "Override appreciation", "appr")
                  }
                />
              </FormSection>
              <AssetBehaviourSections
                behaviour={eff}
                onChange={(b, label, key) => write(b, label, key)}
              />
            </SheetContent>
          );
        })()
      : null;
  return (
    <Sheet open={!!id} onOpenChange={(o) => !o && onClose()}>
      {content}
    </Sheet>
  );
}

function DebtOverrideSheet({ id, onClose }: { id: string | null; onClose: () => void }) {
  const plan = usePlan();
  const update = useUpdatePlan();
  const debt = useEditorStore((s) => s.draft?.finances.debts.find((d) => d.id === id)) as
    | Debt
    | undefined;
  const content =
    plan && debt
      ? (() => {
          const patch = plan.debtSettings[debt.id] ?? {};
          const eff: DebtBehaviour = { ...debt.behaviour, ...patch };
          const set = (v: Partial<DebtBehaviour>, label: string, key?: string) =>
            update(
              (p) => ({
                ...p,
                debtSettings: {
                  ...p.debtSettings,
                  [debt.id]: { ...(p.debtSettings[debt.id] ?? {}), ...v },
                },
              }),
              label,
              key ? `${debt.id}:${key}` : undefined,
            );
          return (
            <SheetContent
              eyebrow={`In “${plan.name}”`}
              title={debt.name}
              width={560}
              footer={
                <>
                  {Object.keys(patch).length ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        update((p) => {
                          const s = { ...p.debtSettings };
                          delete s[debt.id];
                          return { ...p, debtSettings: s };
                        }, "Reset debt overrides")
                      }
                    >
                      <RotateCcw /> Reset to defaults
                    </Button>
                  ) : null}
                  <SheetClose asChild>
                    <Button variant="primary" className="ml-auto">
                      Done
                    </Button>
                  </SheetClose>
                </>
              }
            >
              <FormSection title="Payments in this plan">
                <SwitchField
                  label="Different monthly payment"
                  hint="To overpay regularly, a debt Flow is often clearer."
                  checked={!!eff.monthlyPaymentOverride}
                  onCheckedChange={(on) =>
                    set(
                      { monthlyPaymentOverride: on ? debt.monthlyPayment : undefined },
                      "Toggle payment override",
                    )
                  }
                />
                {eff.monthlyPaymentOverride ? (
                  <FormField label="Monthly payment">
                    {(fid) => (
                      <AmountInput
                        id={fid}
                        value={eff.monthlyPaymentOverride!}
                        onChange={(monthlyPaymentOverride) =>
                          set({ monthlyPaymentOverride }, "Override payment", "pay")
                        }
                      />
                    )}
                  </FormField>
                ) : null}
                <DateRefField
                  label="Payments start"
                  value={eff.paymentsStart}
                  allowNever={false}
                  onChange={(paymentsStart) => set({ paymentsStart }, "Override payment start")}
                />
                <EnumField<"auto" | "accounts">
                  label="Paid from"
                  value={eff.payFrom.kind}
                  onChange={(k) =>
                    set(
                      {
                        payFrom:
                          k === "auto" ? { kind: "auto" } : { kind: "accounts", accountIds: [] },
                      },
                      "Override paid from",
                    )
                  }
                  options={[
                    { value: "auto", label: "Cash flow (automatic)" },
                    { value: "accounts", label: "Specific accounts" },
                  ]}
                />
                {eff.payFrom.kind === "accounts" ? (
                  <AccountListEditor
                    ids={eff.payFrom.accountIds}
                    onChange={(accountIds) =>
                      set({ payFrom: { kind: "accounts", accountIds } }, "Override paid from")
                    }
                  />
                ) : null}
                <SwitchField
                  label="Written off at a point in time"
                  checked={!!eff.forgiveness}
                  onCheckedChange={(on) =>
                    set(
                      {
                        forgiveness: on
                          ? { at: { kind: "planStart", offsetMonths: 12 * 25 }, taxable: false }
                          : undefined,
                      },
                      "Override forgiveness",
                    )
                  }
                />
                {eff.forgiveness ? (
                  <DateRefField
                    label="Written off at"
                    value={eff.forgiveness.at}
                    allowNever={false}
                    onChange={(at) =>
                      set({ forgiveness: { ...eff.forgiveness!, at } }, "Override forgiveness")
                    }
                  />
                ) : null}
              </FormSection>
            </SheetContent>
          );
        })()
      : null;
  return (
    <Sheet open={!!id} onOpenChange={(o) => !o && onClose()}>
      {content}
    </Sheet>
  );
}

function PlannedAssetSheet({ id, onClose }: { id: string | null; onClose: () => void }) {
  const plan = usePlan();
  const update = useUpdatePlan();
  const a = plan?.plannedRealAssets.find((x) => x.id === id);
  const issues = useIssues(PlannedRealAsset, a);
  if (!plan || !a)
    return (
      <Sheet open={false} onOpenChange={() => onClose()}>
        {null}
      </Sheet>
    );
  const set = (fn: (x: PlannedRealAsset) => PlannedRealAsset, label: string, key?: string) =>
    update(
      (p) => ({
        ...p,
        plannedRealAssets: p.plannedRealAssets.map((x) => (x.id === a.id ? fn(x) : x)),
      }),
      label,
      key ? `${a.id}:${key}` : undefined,
    );
  const pur = a.purchase;
  const b = a.behaviour;
  return (
    <Sheet open={!!id} onOpenChange={(o) => !o && onClose()}>
      <SheetContent
        eyebrow="Planned purchase"
        title={a.name}
        width={640}
        footer={
          <>
            {issues.count ? (
              <span className="text-[12px] text-negative">{issues.count} to fix</span>
            ) : null}
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
                  value={a.name}
                  onChange={(e) => set((x) => ({ ...x, name: e.target.value }), "Rename", "name")}
                />
              )}
            </FormField>
            <EnumField
              label="Type"
              value={a.type}
              onChange={(type) => set((x) => ({ ...x, type }), "Change type")}
              options={REAL_ASSET_TYPES.map((t) => ({
                value: t,
                label: REAL_ASSET_TYPES_LABEL[t] ?? t,
              }))}
            />
            <FormField label="Owner">
              {(fid) => (
                <OwnerSelect
                  id={fid}
                  value={a.owner}
                  onChange={(owner) => set((x) => ({ ...x, owner }), "Change owner")}
                />
              )}
            </FormField>
          </FieldGrid>
        </FormSection>
        <FormSection title="Purchase">
          <DateRefField
            label="Buy at"
            value={pur.at}
            allowNever={false}
            onChange={(at) =>
              set((x) => ({ ...x, purchase: { ...x.purchase, at } }), "Edit purchase date")
            }
          />
          <FieldGrid>
            <FormField label="Price" error={issues.under("purchase.price")}>
              {(fid) => (
                <AmountInput
                  id={fid}
                  value={pur.price}
                  onChange={(price) =>
                    set(
                      (x) => ({ ...x, purchase: { ...x.purchase, price } }),
                      "Edit price",
                      "price",
                    )
                  }
                />
              )}
            </FormField>
            <FormField label="Deposit" hint="Blank = paid in full.">
              {(fid) => (
                <AmountInput
                  id={fid}
                  value={pur.downPayment ?? { value: 0, basis: "real" }}
                  onChange={(downPayment) =>
                    set(
                      (x) => ({ ...x, purchase: { ...x.purchase, downPayment } }),
                      "Edit deposit",
                      "dep",
                    )
                  }
                />
              )}
            </FormField>
          </FieldGrid>
          <SwitchField
            label="Financed"
            hint="A mortgage or loan for the rest of the price."
            checked={!!pur.financing}
            onCheckedChange={(on) =>
              set(
                (x) => ({
                  ...x,
                  purchase: {
                    ...x.purchase,
                    financing: on
                      ? {
                          id: newId("loan"),
                          interest: { apr: 0.045, method: "compound", compounding: "monthly" },
                          monthlyPayment: { value: 1200, basis: "nominal" },
                        }
                      : undefined,
                  },
                }),
                on ? "Add financing" : "Remove financing",
              )
            }
          />
          {pur.financing ? (
            <FieldGrid>
              <FormField label="Interest rate (APR)">
                {(fid) => (
                  <PercentInput
                    id={fid}
                    decimals={3}
                    value={pur.financing!.interest.apr}
                    onValueChange={(v) =>
                      set(
                        (x) => ({
                          ...x,
                          purchase: {
                            ...x.purchase,
                            financing: {
                              ...x.purchase.financing!,
                              interest: { ...x.purchase.financing!.interest, apr: v ?? 0 },
                            },
                          },
                        }),
                        "Edit financing",
                        "apr",
                      )
                    }
                  />
                )}
              </FormField>
              <FormField label="Monthly payment">
                {(fid) => (
                  <AmountInput
                    id={fid}
                    value={pur.financing!.monthlyPayment}
                    onChange={(monthlyPayment) =>
                      set(
                        (x) => ({
                          ...x,
                          purchase: {
                            ...x.purchase,
                            financing: { ...x.purchase.financing!, monthlyPayment },
                          },
                        }),
                        "Edit financing",
                        "pay",
                      )
                    }
                  />
                )}
              </FormField>
            </FieldGrid>
          ) : null}
          <FormField
            label="Pay from accounts"
            hint="Where the deposit or cash price comes from. Blank = cash flow and drawdown order."
          >
            {() => (
              <AccountListEditor
                ids={pur.fundFromAccountIds}
                onChange={(fundFromAccountIds) =>
                  set(
                    (x) => ({ ...x, purchase: { ...x.purchase, fundFromAccountIds } }),
                    "Edit funding",
                  )
                }
              />
            )}
          </FormField>
        </FormSection>
        <FormSection title="Repeat purchase">
          <SwitchField
            label="Buy again periodically"
            hint="E.g. replace the car every 8 years; the old one is sold each time."
            checked={!!b.recurrence}
            onCheckedChange={(on) =>
              set(
                (x) => ({
                  ...x,
                  behaviour: {
                    ...x.behaviour,
                    recurrence: on
                      ? {
                          yearsBetween: 8,
                          scalingRate: 0,
                          until: { kind: "planEnd", offsetMonths: 0 },
                          keepLast: true,
                        }
                      : undefined,
                  },
                }),
                on ? "Add repeat" : "Remove repeat",
              )
            }
          />
          {b.recurrence ? (
            <>
              <FieldGrid>
                <FormField label="Years between">
                  {(fid) => (
                    <NumberInput
                      id={fid}
                      decimals={0}
                      suffix="yrs"
                      value={b.recurrence!.yearsBetween}
                      onValueChange={(v) =>
                        set(
                          (x) => ({
                            ...x,
                            behaviour: {
                              ...x.behaviour,
                              recurrence: {
                                ...x.behaviour.recurrence!,
                                yearsBetween: Math.max(0, v ?? 0),
                              },
                            },
                          }),
                          "Edit repeat",
                          "rep",
                        )
                      }
                    />
                  )}
                </FormField>
                <FormField label="Price change each time">
                  {(fid) => (
                    <PercentInput
                      id={fid}
                      value={b.recurrence!.scalingRate}
                      onValueChange={(v) =>
                        set(
                          (x) => ({
                            ...x,
                            behaviour: {
                              ...x.behaviour,
                              recurrence: { ...x.behaviour.recurrence!, scalingRate: v ?? 0 },
                            },
                          }),
                          "Edit repeat",
                          "rep",
                        )
                      }
                    />
                  )}
                </FormField>
              </FieldGrid>
              <DateRefField
                label="Until"
                value={b.recurrence.until}
                onChange={(until) =>
                  set(
                    (x) => ({
                      ...x,
                      behaviour: {
                        ...x.behaviour,
                        recurrence: { ...x.behaviour.recurrence!, until },
                      },
                    }),
                    "Edit repeat",
                  )
                }
              />
              <SwitchField
                label="Keep the last one"
                checked={b.recurrence.keepLast}
                onCheckedChange={(keepLast) =>
                  set(
                    (x) => ({
                      ...x,
                      behaviour: {
                        ...x.behaviour,
                        recurrence: { ...x.behaviour.recurrence!, keepLast },
                      },
                    }),
                    "Edit repeat",
                  )
                }
              />
            </>
          ) : null}
        </FormSection>
        <FormSection title="Value over time">
          <ChangeEditor
            label="Appreciation"
            help={HELP.appreciation}
            value={b.appreciation}
            onChange={(appreciation) =>
              set(
                (x) => ({ ...x, behaviour: { ...x.behaviour, appreciation } }),
                "Edit appreciation",
                "appr",
              )
            }
          />
        </FormSection>
        <AssetBehaviourSections
          behaviour={b}
          onChange={(behaviour, label, key) => set((x) => ({ ...x, behaviour }), label, key)}
        />
      </SheetContent>
    </Sheet>
  );
}
