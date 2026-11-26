/**
 * Withdrawals: the drawdown order (drag to reorder categories, accounts and assets), textbook
 * withdrawal strategies, flexible spending rules and risk-based guardrails.
 */
import {
  ACCOUNT_TYPE_INFO,
  DEFAULT_DRAWDOWN_ORDER,
  type DrawdownCategory,
  describeDrawdownCeiling,
  type DrawdownEntry,
  type FlexSpending,
  type Plan,
  type RiskGuardrails,
  type WithdrawalStrategy,
} from "@glideworth/core";
import { Plus, RotateCcw, X } from "lucide-react";
import {
  ActionMenu,
  ActionMenuContent,
  ActionMenuItem,
  ActionMenuLabel,
  ActionMenuSeparator,
  ActionMenuTrigger,
} from "../../../components/ui/action-menu";
import { Button } from "../../../components/ui/button";
import { Card, CardHeader } from "../../../components/ui/card";
import { HelpTip } from "../../../components/ui/help-tip";
import { AmountInput, NumberInput, PercentInput } from "../../../components/ui/number-input";
import { FieldGrid } from "../../../components/ui/sheet";
import { moveItem, SortableList } from "../../../components/ui/sortable-list";
import { SwitchField } from "../../../components/ui/switch";
import { DateRefField, EnumField, FormField } from "../components/form";
import { usePlan, useUpdatePlan } from "../components/plan-context";
import { useEditorStore } from "../state/doc-store";
import { DRAWDOWN_HINT, DRAWDOWN_LABEL, HELP } from "../state/labels";
import { deepEqual } from "../state/merge";

const ALL_CATEGORIES = Object.keys(DRAWDOWN_LABEL) as DrawdownCategory[];

export function WithdrawalsSection() {
  const plan = usePlan();
  const update = useUpdatePlan();
  const finances = useEditorStore((s) => s.draft?.finances);
  if (!plan || !finances) return null;
  const order = plan.drawdown.order;
  const setDrawdown = (v: Partial<Plan["drawdown"]>, label: string, key?: string) =>
    update((p) => ({ ...p, drawdown: { ...p.drawdown, ...v } }), label, key);
  const accountName = (id: string) =>
    finances.accounts.find((a) => a.id === id)?.name ?? "Missing account";
  const preTax = finances.accounts.filter(
    (a) => ACCOUNT_TYPE_INFO[a.type]?.taxTreatment === "tax-deferred",
  );
  const label = (e: DrawdownEntry) => {
    switch (e.kind) {
      case "category":
        return DRAWDOWN_LABEL[e.category];
      case "account":
        return accountName(e.accountId);
      case "realAsset":
        return finances.realAssets.find((a) => a.id === e.assetId)?.name ?? "Missing asset";
      case "proportional":
        return `Together: ${e.accountIds.map(accountName).join(" + ")}`;
      case "fillToCeiling":
        return `Pre-tax up to the ${describeDrawdownCeiling(e.ceiling)}`;
    }
  };
  const hint = (e: DrawdownEntry) => {
    switch (e.kind) {
      case "category":
        return DRAWDOWN_HINT[e.category];
      case "account":
        return "This account specifically, ahead of its category";
      case "realAsset":
        return "Sold when reached (if “sell if needed” is on)";
      case "proportional":
        return "Drawn in the same year, in proportion to their balances";
      case "fillToCeiling":
        return "Only while taxable income stays under the ceiling, then the next entry";
    }
  };
  const key = (e: DrawdownEntry, i: number) => {
    switch (e.kind) {
      case "category":
        return `c:${e.category}`;
      case "account":
        return `a:${e.accountId}`;
      case "realAsset":
        return `r:${e.assetId}`;
      default:
        return `${e.kind}:${i}`;
    }
  };
  const replaceAt = (index: number, e: DrawdownEntry, what: string) =>
    setDrawdown({ order: order.map((x, i) => (i === index ? e : x)) }, what, `entry-${index}`);
  const missingCats = ALL_CATEGORIES.filter(
    (c) => !order.some((e) => e.kind === "category" && e.category === c),
  );
  const isDefault = deepEqual(order, DEFAULT_DRAWDOWN_ORDER);
  return (
    <>
      <Card>
        <CardHeader
          eyebrow="When spending exceeds income"
          title={
            <span className="flex items-center gap-1">
              Drawdown order <HelpTip>{HELP.drawdownOrder}</HelpTip>
            </span>
          }
          actions={
            <>
              {!isDefault ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    setDrawdown({ order: DEFAULT_DRAWDOWN_ORDER }, "Reset drawdown order")
                  }
                >
                  <RotateCcw /> Default
                </Button>
              ) : null}
              <ActionMenu>
                <ActionMenuTrigger asChild>
                  <Button size="sm">
                    <Plus /> Add
                  </Button>
                </ActionMenuTrigger>
                <ActionMenuContent>
                  {missingCats.length ? <ActionMenuLabel>Categories</ActionMenuLabel> : null}
                  {missingCats.map((c) => (
                    <ActionMenuItem
                      key={c}
                      onSelect={() =>
                        setDrawdown(
                          { order: [...order, { kind: "category", category: c }] },
                          "Add to drawdown",
                        )
                      }
                    >
                      {DRAWDOWN_LABEL[c]}
                    </ActionMenuItem>
                  ))}
                  <ActionMenuSeparator />
                  <ActionMenuLabel>Several accounts in one year</ActionMenuLabel>
                  <ActionMenuItem
                    disabled={preTax.length === 0}
                    onSelect={() =>
                      setDrawdown(
                        {
                          order: [
                            {
                              kind: "fillToCeiling",
                              ceiling: { kind: "bracket", rate: 0 },
                              accountIds: [],
                            },
                            ...order,
                          ],
                        },
                        "Add fill to a tax ceiling",
                      )
                    }
                  >
                    Pre-tax accounts up to a tax ceiling
                  </ActionMenuItem>
                  <ActionMenuItem
                    disabled={finances.accounts.length < 2}
                    onSelect={() =>
                      setDrawdown(
                        {
                          order: [
                            {
                              kind: "proportional",
                              accountIds: finances.accounts.slice(0, 2).map((a) => a.id),
                            },
                            ...order,
                          ],
                        },
                        "Add accounts drawn together",
                      )
                    }
                  >
                    Accounts drawn together (by balance)
                  </ActionMenuItem>
                  <ActionMenuSeparator />
                  <ActionMenuLabel>A specific account</ActionMenuLabel>
                  {finances.accounts
                    .filter((a) => !order.some((e) => e.kind === "account" && e.accountId === a.id))
                    .map((a) => (
                      <ActionMenuItem
                        key={a.id}
                        onSelect={() =>
                          setDrawdown(
                            { order: [{ kind: "account", accountId: a.id }, ...order] },
                            "Add account to drawdown",
                          )
                        }
                      >
                        {a.name}
                      </ActionMenuItem>
                    ))}
                  {finances.realAssets.length ? <ActionMenuLabel>An asset</ActionMenuLabel> : null}
                  {finances.realAssets
                    .filter((r) => !order.some((e) => e.kind === "realAsset" && e.assetId === r.id))
                    .map((r) => (
                      <ActionMenuItem
                        key={r.id}
                        onSelect={() =>
                          setDrawdown(
                            { order: [...order, { kind: "realAsset", assetId: r.id }] },
                            "Add asset to drawdown",
                          )
                        }
                      >
                        {r.name}
                      </ActionMenuItem>
                    ))}
                </ActionMenuContent>
              </ActionMenu>
            </>
          }
        />
        <div className="p-3 sm:p-4">
          <SortableList
            aria-label="Drawdown order"
            items={order}
            getId={(e) => key(e, order.indexOf(e))}
            getLabel={label}
            onReorder={(from, to) =>
              setDrawdown({ order: moveItem(order, from, to) }, "Reorder drawdown")
            }
            className="gap-1.5"
            renderItem={(e, { handle, index }) => (
              <div className="flex items-center gap-2 rounded-lg border border-border bg-surface py-1.5 pr-1.5 pl-1">
                {handle}
                <span className="num flex size-6 shrink-0 items-center justify-center rounded-full bg-surface-2 text-[11px] font-semibold text-ink-2">
                  {index + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-medium">{label(e)}</div>
                  <div className="truncate text-[11.5px] text-ink-3">{hint(e)}</div>
                  {e.kind === "proportional" || e.kind === "fillToCeiling" ? (
                    <BlendedEntryEditor
                      entry={e}
                      accounts={e.kind === "fillToCeiling" ? preTax : finances.accounts}
                      onChange={(next) => replaceAt(index, next, "Edit drawdown entry")}
                    />
                  ) : null}
                </div>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-7"
                  aria-label={`Remove ${label(e)}`}
                  onClick={() =>
                    setDrawdown(
                      { order: order.filter((_, i) => i !== index) },
                      "Remove from drawdown",
                    )
                  }
                >
                  <X />
                </Button>
              </div>
            )}
          />
          <p className="mt-2 text-[11.5px] text-ink-3">
            Anything not listed is drawn last, in the default category order. Account access rules
            (e.g. pensions from 57) always apply.
          </p>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <EnumField
              label="Within a category"
              value={plan.drawdown.withinCategory}
              onChange={(withinCategory) =>
                setDrawdown({ withinCategory }, "Change within-category rule")
              }
              options={[
                { value: "ordered", label: "One account at a time (list order)" },
                { value: "proportional", label: "Proportionally to balances" },
              ]}
            />
            <FormField
              label="Keep a cash buffer"
              hint="Don’t draw cash below this before using other accounts."
            >
              {(id) => (
                <AmountInput
                  id={id}
                  value={plan.drawdown.cashBuffer ?? { value: 0, basis: "real" }}
                  onChange={(cashBuffer) =>
                    setDrawdown(
                      { cashBuffer: cashBuffer.value ? cashBuffer : undefined },
                      "Edit cash buffer",
                      "buffer",
                    )
                  }
                />
              )}
            </FormField>
          </div>
          <SwitchField
            className="mt-3"
            label="Split withdrawals between partners"
            hint="Draw from each person’s accounts in proportion, to use both tax allowances."
            checked={plan.drawdown.splitByOwner}
            onCheckedChange={(splitByOwner) =>
              setDrawdown({ splitByOwner }, "Toggle split by owner")
            }
          />
        </div>
      </Card>
      <StrategyCard />
      <FlexCard />
      <GuardrailsCard />
    </>
  );
}

const RULES: { value: WithdrawalStrategy["rule"]["kind"]; label: string; hint: string }[] = [
  {
    value: "initial-percent",
    label: "Initial % (the 4% rule)",
    hint: "A % of the starting portfolio, then rising with inflation.",
  },
  {
    value: "fixed-percent",
    label: "Fixed % of portfolio",
    hint: "The same % of whatever the portfolio is worth each year.",
  },
  { value: "fixed-amount", label: "Fixed amount", hint: "A set amount each year." },
  { value: "one-over-n", label: "1/N", hint: "Divide the portfolio by the years remaining." },
  { value: "vpw", label: "Variable % (VPW)", hint: "Bogleheads VPW table by age and allocation." },
  {
    value: "ratcheting",
    label: "Ratcheting",
    hint: "Raise spending after strong years; never cut.",
  },
  {
    value: "clyatt-95",
    label: "Clyatt 95%",
    hint: "A % of the portfolio, but at least 95% of last year.",
  },
  {
    value: "guyton-klinger",
    label: "Guyton–Klinger",
    hint: "Guardrails: cut or raise when the rate drifts.",
  },
];

function defaultRule(kind: WithdrawalStrategy["rule"]["kind"]): WithdrawalStrategy["rule"] {
  switch (kind) {
    case "fixed-amount":
      return { kind, amount: { value: 30_000, basis: "real" }, inflationAdjust: true };
    case "one-over-n":
      return { kind };
    case "vpw":
      return { kind };
    case "ratcheting":
      return { kind, rate: 0.04, threshold: 0.5, raise: 0.1, cooldownYears: 3 };
    case "clyatt-95":
      return { kind, rate: 0.04, minShareOfPrevious: 0.95 };
    case "guyton-klinger":
      return { kind, rate: 0.045, guardrail: 0.2, adjustment: 0.1 };
    default:
      return { kind, rate: 0.04 } as WithdrawalStrategy["rule"];
  }
}

function StrategyCard() {
  const plan = usePlan();
  const update = useUpdatePlan();
  if (!plan) return null;
  const ws = plan.withdrawalStrategy;
  const retire = plan.milestones.find((m) => m.kind === "retirement");
  const set = (v: Partial<WithdrawalStrategy>, label: string, key?: string) =>
    update((p) => ({ ...p, withdrawalStrategy: { ...p.withdrawalStrategy!, ...v } }), label, key);
  const rule = ws?.rule;
  return (
    <Card>
      <CardHeader
        eyebrow="For comparison"
        title={
          <span className="flex items-center gap-1">
            Withdrawal strategy <HelpTip>{HELP.withdrawalStrategy}</HelpTip>
          </span>
        }
      />
      <div className="p-4">
        <SwitchField
          label="Use a withdrawal strategy"
          hint="From the start date, spending is set by the rule instead of your expenses."
          checked={!!ws?.enabled}
          onCheckedChange={(on) =>
            update(
              (p) => ({
                ...p,
                withdrawalStrategy: p.withdrawalStrategy
                  ? { ...p.withdrawalStrategy, enabled: on }
                  : {
                      enabled: on,
                      start: retire
                        ? { kind: "milestone", milestoneId: retire.id, offsetMonths: 0 }
                        : { kind: "planStart", offsetMonths: 0 },
                      rule: defaultRule("initial-percent"),
                      bounds: {},
                      incomeHandling: "reduce-withdrawals",
                      treatAsSpending: false,
                    },
              }),
              on ? "Enable withdrawal strategy" : "Disable withdrawal strategy",
            )
          }
        />
        {ws?.enabled && rule ? (
          <div className="mt-3 grid gap-3">
            <EnumField
              label="Rule"
              value={rule.kind}
              onChange={(k) => set({ rule: defaultRule(k) }, "Change rule")}
              options={RULES}
              hint={RULES.find((r) => r.value === rule.kind)?.hint}
            />
            <DateRefField
              label="From"
              value={ws.start}
              allowNever={false}
              onChange={(start) => set({ start }, "Edit start")}
            />
            <FieldGrid cols={3}>
              {"rate" in rule ? (
                <FormField label="Rate">
                  {(id) => (
                    <PercentInput
                      id={id}
                      value={rule.rate}
                      onValueChange={(v) =>
                        set(
                          { rule: { ...rule, rate: v ?? 0 } as WithdrawalStrategy["rule"] },
                          "Edit rate",
                          "rate",
                        )
                      }
                    />
                  )}
                </FormField>
              ) : null}
              {rule.kind === "fixed-amount" ? (
                <FormField label="Amount per year" className="sm:col-span-2">
                  {(id) => (
                    <AmountInput
                      id={id}
                      value={rule.amount}
                      onChange={(amount) =>
                        set({ rule: { ...rule, amount } }, "Edit amount", "amt")
                      }
                    />
                  )}
                </FormField>
              ) : null}
              {rule.kind === "ratcheting" ? (
                <>
                  <FormField label="Ratchet when up by">
                    {(id) => (
                      <PercentInput
                        id={id}
                        value={rule.threshold}
                        onValueChange={(v) =>
                          set({ rule: { ...rule, threshold: v ?? 0 } }, "Edit rule", "th")
                        }
                      />
                    )}
                  </FormField>
                  <FormField label="Raise by">
                    {(id) => (
                      <PercentInput
                        id={id}
                        value={rule.raise}
                        onValueChange={(v) =>
                          set({ rule: { ...rule, raise: v ?? 0 } }, "Edit rule", "raise")
                        }
                      />
                    )}
                  </FormField>
                  <FormField label="Cooldown">
                    {(id) => (
                      <NumberInput
                        id={id}
                        decimals={0}
                        suffix="yrs"
                        value={rule.cooldownYears}
                        onValueChange={(v) =>
                          set(
                            { rule: { ...rule, cooldownYears: Math.max(0, Math.round(v ?? 0)) } },
                            "Edit rule",
                            "cd",
                          )
                        }
                      />
                    )}
                  </FormField>
                </>
              ) : null}
              {rule.kind === "clyatt-95" ? (
                <FormField label="Floor vs last year">
                  {(id) => (
                    <PercentInput
                      id={id}
                      value={rule.minShareOfPrevious}
                      onValueChange={(v) =>
                        set(
                          { rule: { ...rule, minShareOfPrevious: v ?? 0.95 } },
                          "Edit rule",
                          "min",
                        )
                      }
                    />
                  )}
                </FormField>
              ) : null}
              {rule.kind === "guyton-klinger" ? (
                <>
                  <FormField label="Guardrail band">
                    {(id) => (
                      <PercentInput
                        id={id}
                        value={rule.guardrail}
                        onValueChange={(v) =>
                          set({ rule: { ...rule, guardrail: v ?? 0 } }, "Edit rule", "g")
                        }
                      />
                    )}
                  </FormField>
                  <FormField label="Adjustment">
                    {(id) => (
                      <PercentInput
                        id={id}
                        value={rule.adjustment}
                        onValueChange={(v) =>
                          set({ rule: { ...rule, adjustment: v ?? 0 } }, "Edit rule", "adj")
                        }
                      />
                    )}
                  </FormField>
                </>
              ) : null}
              {rule.kind === "vpw" ? (
                <FormField label="Stock share" hint="Blank = from your allocation.">
                  {(id) => (
                    <PercentInput
                      id={id}
                      value={rule.stockShare ?? null}
                      onValueChange={(v) =>
                        set({ rule: { ...rule, stockShare: v ?? undefined } }, "Edit rule", "ss")
                      }
                    />
                  )}
                </FormField>
              ) : null}
            </FieldGrid>
            <FieldGrid>
              <FormField label="Floor" hint="Never spend less than this.">
                {(id) => (
                  <AmountInput
                    id={id}
                    value={ws.bounds.floor ?? { value: 0, basis: "real" }}
                    onChange={(floor) =>
                      set(
                        { bounds: { ...ws.bounds, floor: floor.value ? floor : undefined } },
                        "Edit floor",
                        "floor",
                      )
                    }
                  />
                )}
              </FormField>
              <FormField label="Ceiling" hint="Never spend more than this.">
                {(id) => (
                  <AmountInput
                    id={id}
                    value={ws.bounds.ceiling ?? { value: 0, basis: "real" }}
                    onChange={(ceiling) =>
                      set(
                        { bounds: { ...ws.bounds, ceiling: ceiling.value ? ceiling : undefined } },
                        "Edit ceiling",
                        "ceil",
                      )
                    }
                  />
                )}
              </FormField>
            </FieldGrid>
            <EnumField
              label="Other income (pensions etc.)"
              value={ws.incomeHandling}
              onChange={(incomeHandling) => set({ incomeHandling }, "Edit income handling")}
              options={[
                { value: "reduce-withdrawals", label: "Reduces what is withdrawn" },
                { value: "increase-spending", label: "Is spent on top" },
              ]}
            />
            <SwitchField
              label="Treat the amount as desired spending"
              checked={ws.treatAsSpending}
              onCheckedChange={(treatAsSpending) =>
                set({ treatAsSpending }, "Toggle treat as spending")
              }
            />
          </div>
        ) : null}
      </div>
    </Card>
  );
}

function FlexCard() {
  const plan = usePlan();
  const update = useUpdatePlan();
  if (!plan) return null;
  const fx = plan.flexSpending;
  const set = (v: Partial<FlexSpending>, label: string, key?: string) =>
    update((p) => ({ ...p, flexSpending: { ...p.flexSpending, ...v } }), label, key);
  return (
    <Card>
      <CardHeader
        eyebrow="Spend less in bad years"
        title={
          <span className="flex items-center gap-1">
            Flexible spending <HelpTip>{HELP.flex}</HelpTip>
          </span>
        }
      />
      <div className="p-4">
        <SwitchField
          label="Flex spending with the markets"
          checked={fx.enabled}
          onCheckedChange={(enabled) =>
            set({ enabled }, enabled ? "Enable flexible spending" : "Disable flexible spending")
          }
        />
        {fx.enabled ? (
          <div className="mt-3 grid gap-3">
            <FieldGrid>
              <EnumField
                label="What flexes"
                value={fx.scope}
                onChange={(scope) => set({ scope }, "Edit flex scope")}
                options={[
                  { value: "discretionary", label: "Flexible spending only" },
                  { value: "all", label: "All spending" },
                ]}
              />
              <EnumField
                label="Between rules"
                value={fx.interpolation}
                onChange={(interpolation) => set({ interpolation }, "Edit flex interpolation")}
                options={[
                  { value: "step", label: "Step" },
                  { value: "linear", label: "Gradual" },
                ]}
              />
            </FieldGrid>
            <ol className="flex flex-col gap-1.5">
              {fx.rules.map((r, i) => (
                <li
                  // oxlint-disable-next-line react/no-array-index-key -- rules have no ids
                  key={i}
                  className="flex flex-wrap items-center gap-2 rounded-lg border border-border px-2.5 py-1.5 text-[12.5px]"
                >
                  When markets are down
                  <PercentInput
                    aria-label="Drawdown from peak"
                    className="w-[96px]"
                    value={r.drawdown}
                    onValueChange={(v) =>
                      set(
                        {
                          rules: fx.rules.map((x, j) => (j === i ? { ...x, drawdown: v ?? 0 } : x)),
                        },
                        "Edit flex rule",
                        `r${i}d`,
                      )
                    }
                    decimals={0}
                  />
                  from their peak, cut by
                  <PercentInput
                    aria-label="Cut"
                    className="w-[96px]"
                    value={r.cut}
                    onValueChange={(v) =>
                      set(
                        { rules: fx.rules.map((x, j) => (j === i ? { ...x, cut: v ?? 0 } : x)) },
                        "Edit flex rule",
                        `r${i}c`,
                      )
                    }
                    decimals={0}
                  />
                  <Button
                    size="icon"
                    variant="ghost"
                    className="ml-auto size-7"
                    aria-label="Remove rule"
                    onClick={() =>
                      set({ rules: fx.rules.filter((_, j) => j !== i) }, "Remove flex rule")
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
              onClick={() =>
                set({ rules: [...fx.rules, { drawdown: 0.35, cut: 0.5 }] }, "Add flex rule")
              }
            >
              <Plus /> Add rule
            </Button>
            <SwitchField
              label="Only during a window"
              checked={!!fx.window}
              onCheckedChange={(on) =>
                set(
                  {
                    window: on
                      ? {
                          start: { kind: "planStart", offsetMonths: 0 },
                          end: { kind: "planEnd", offsetMonths: 0 },
                          endInclusive: false,
                        }
                      : undefined,
                  },
                  "Toggle flex window",
                )
              }
            />
            {fx.window ? (
              <FieldGrid>
                <DateRefField
                  label="From"
                  value={fx.window.start}
                  allowNever={false}
                  onChange={(start) =>
                    set({ window: { ...fx.window!, start } }, "Edit flex window")
                  }
                />
                <DateRefField
                  label="Until"
                  value={fx.window.end}
                  onChange={(end) => set({ window: { ...fx.window!, end } }, "Edit flex window")}
                />
              </FieldGrid>
            ) : null}
          </div>
        ) : null}
      </div>
    </Card>
  );
}

function GuardrailsCard() {
  const plan = usePlan();
  const update = useUpdatePlan();
  if (!plan) return null;
  const g = plan.riskGuardrails;
  const retire = plan.milestones.find((m) => m.kind === "retirement");
  const set = (v: Partial<RiskGuardrails>, label: string, key?: string) =>
    update((p) => ({ ...p, riskGuardrails: { ...p.riskGuardrails!, ...v } }), label, key);
  return (
    <Card>
      <CardHeader
        eyebrow="Adjust spending to stay on track"
        title={
          <span className="flex items-center gap-1">
            Risk-based guardrails{" "}
            <HelpTip>
              Each year, if the chance of success drifts outside the band, spending steps down or
              up. Evaluated from one shared set of simulations.
            </HelpTip>
          </span>
        }
      />
      <div className="p-4">
        <SwitchField
          label="Use guardrails"
          checked={!!g?.enabled}
          onCheckedChange={(on) =>
            update(
              (p) => ({
                ...p,
                riskGuardrails: p.riskGuardrails
                  ? { ...p.riskGuardrails, enabled: on }
                  : {
                      enabled: on,
                      start: retire
                        ? { kind: "milestone", milestoneId: retire.id, offsetMonths: 0 }
                        : { kind: "planStart", offsetMonths: 0 },
                      targetSuccess: 0.8,
                      lowerGuardrail: 0.7,
                      upperGuardrail: 0.95,
                      adjustmentStep: 0.1,
                      scope: "discretionary",
                    },
              }),
              on ? "Enable guardrails" : "Disable guardrails",
            )
          }
        />
        {g?.enabled ? (
          <div className="mt-3 grid gap-3">
            <DateRefField
              label="From"
              value={g.start}
              allowNever={false}
              onChange={(start) => set({ start }, "Edit guardrail start")}
            />
            <FieldGrid cols={3}>
              <FormField label="Lower guardrail">
                {(id) => (
                  <PercentInput
                    id={id}
                    decimals={0}
                    value={g.lowerGuardrail}
                    onValueChange={(v) => set({ lowerGuardrail: v ?? 0 }, "Edit guardrails", "lo")}
                  />
                )}
              </FormField>
              <FormField label="Target">
                {(id) => (
                  <PercentInput
                    id={id}
                    decimals={0}
                    value={g.targetSuccess}
                    onValueChange={(v) => set({ targetSuccess: v ?? 0 }, "Edit guardrails", "t")}
                  />
                )}
              </FormField>
              <FormField label="Upper guardrail">
                {(id) => (
                  <PercentInput
                    id={id}
                    decimals={0}
                    value={g.upperGuardrail}
                    onValueChange={(v) => set({ upperGuardrail: v ?? 0 }, "Edit guardrails", "hi")}
                  />
                )}
              </FormField>
              <FormField label="Step size">
                {(id) => (
                  <PercentInput
                    id={id}
                    decimals={0}
                    value={g.adjustmentStep}
                    onValueChange={(v) => set({ adjustmentStep: v ?? 0 }, "Edit guardrails", "st")}
                  />
                )}
              </FormField>
              <EnumField
                label="Adjusts"
                value={g.scope}
                onChange={(scope) => set({ scope }, "Edit guardrails")}
                options={[
                  { value: "discretionary", label: "Flexible spending" },
                  { value: "all", label: "All spending" },
                ]}
              />
            </FieldGrid>
            {g.lowerGuardrail >= g.upperGuardrail ? (
              <p className="text-[12px] text-negative">
                The lower guardrail must be below the upper one.
              </p>
            ) : null}
            <div className="flex flex-wrap items-center gap-1.5 text-[12px] text-ink-3">
              Presets
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  set(
                    { lowerGuardrail: 0.7, targetSuccess: 0.8, upperGuardrail: 0.95 },
                    "Guardrail preset",
                  )
                }
              >
                Balanced 70–95%
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  set(
                    { lowerGuardrail: 0.8, targetSuccess: 0.9, upperGuardrail: 0.99 },
                    "Guardrail preset",
                  )
                }
              >
                Cautious 80–99%
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </Card>
  );
}

/**
 * Settings of a blended drawdown entry: which accounts, and for a fill entry its ceiling. A
 * proportional entry keeps at least two accounts; a fill entry with none ticked uses every pre-tax
 * account.
 */
function BlendedEntryEditor({
  entry,
  accounts,
  onChange,
}: {
  entry: Extract<DrawdownEntry, { kind: "proportional" | "fillToCeiling" }>;
  accounts: { id: string; name: string }[];
  onChange: (e: DrawdownEntry) => void;
}) {
  const ids = entry.accountIds;
  const toggle = (id: string) => {
    const next = ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
    if (entry.kind === "proportional" && next.length < 2) return;
    onChange({ ...entry, accountIds: next });
  };
  return (
    <div className="mt-2 flex flex-col gap-2">
      {entry.kind === "fillToCeiling" ? (
        <div className="grid gap-2 sm:grid-cols-2">
          <EnumField<"bracket" | "income">
            label="Ceiling"
            value={entry.ceiling.kind}
            onChange={(k) =>
              onChange({
                ...entry,
                ceiling:
                  k === "bracket"
                    ? { kind: "bracket", rate: 0 }
                    : { kind: "income", amount: { value: 50_000, basis: "real" } },
              })
            }
            options={[
              { value: "bracket", label: "Top of a tax band" },
              { value: "income", label: "A taxable income I choose" },
            ]}
          />
          {entry.ceiling.kind === "bracket" ? (
            <FormField
              label="Band rate"
              hint="0% = the tax-free allowance; e.g. 20% = the UK basic-rate band, 12% = the US 12% bracket. Per person where income is taxed individually."
            >
              {(id) => (
                <PercentInput
                  id={id}
                  value={entry.ceiling.kind === "bracket" ? entry.ceiling.rate : 0}
                  onValueChange={(rate) =>
                    onChange({ ...entry, ceiling: { kind: "bracket", rate: rate ?? 0 } })
                  }
                />
              )}
            </FormField>
          ) : (
            <FormField
              label="Taxable income up to"
              hint="Each year, per person where taxed individually."
            >
              {(id) => (
                <AmountInput
                  id={id}
                  value={
                    entry.ceiling.kind === "income"
                      ? entry.ceiling.amount
                      : { value: 0, basis: "real" }
                  }
                  onChange={(amount) => onChange({ ...entry, ceiling: { kind: "income", amount } })}
                />
              )}
            </FormField>
          )}
        </div>
      ) : null}
      <div className="flex flex-wrap gap-1" role="group" aria-label="Accounts in this entry">
        {accounts.map((a) => (
          <Button
            key={a.id}
            size="sm"
            variant={ids.includes(a.id) ? "subtle" : "ghost"}
            aria-pressed={ids.includes(a.id)}
            onClick={() => toggle(a.id)}
          >
            {a.name}
          </Button>
        ))}
      </div>
      {entry.kind === "fillToCeiling" && ids.length === 0 ? (
        <p className="text-[11.5px] text-ink-3">None ticked: every pre-tax account.</p>
      ) : null}
    </div>
  );
}
