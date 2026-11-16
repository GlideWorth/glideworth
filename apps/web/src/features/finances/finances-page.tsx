/**
 * Current Finances: who the household is and what it owns and owes today. Every "now" plan starts
 * from here. Edits apply instantly (autosaved, undoable) and the net-worth summary updates as you
 * type.
 */

import {
  ACCOUNT_TYPE_INFO,
  type Account,
  type AccountCategory,
  type AccountType,
  DEBT_TYPES,
  type Debt,
  REAL_ASSET_TYPES,
  type RealAssetType,
} from "@glideworth/core";
import {
  Car,
  Command,
  CreditCard,
  Home,
  Landmark,
  MapPin,
  MoreHorizontal,
  PiggyBank,
  Plus,
  UserRound,
  Wallet,
} from "lucide-react";
import { type ReactNode, useCallback, useMemo, useState } from "react";
import { Page } from "../../components/layout/app-shell";
import {
  ActionMenu,
  ActionMenuContent,
  ActionMenuItem,
  ActionMenuLabel,
  ActionMenuSeparator,
  ActionMenuTrigger,
  ActionSubMenu,
} from "../../components/ui/action-menu";
import { AppearanceDot, appearanceColor } from "../../components/ui/appearance-picker";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardHeader } from "../../components/ui/card";
import { EmptyState } from "../../components/ui/empty-state";
import { Input } from "../../components/ui/input";
import { Kbd, modKey } from "../../components/ui/kbd";
import { CurrencyInput } from "../../components/ui/number-input";
import { moveItem, SortableList } from "../../components/ui/sortable-list";
import { toast } from "../../components/ui/toaster";
import { Tooltip } from "../../components/ui/tooltip";
import { cn } from "../../lib/cn";
import { countryLabel } from "../../lib/countries";
import { formatMonth } from "../../lib/format";
import { financesInBase, toBase } from "../../lib/fx-math";
import { useFormat, useWorkspace } from "../../lib/workspace";
import { useUi } from "../../stores/ui";
import { FxRatesEditor, foreignCurrencies } from "../currency/fx";
import {
  ConflictBanner,
  EditorFrame,
  SaveIndicator,
  UndoRedo,
} from "../plan-editor/components/editor-chrome";
import { ScopeProvider } from "../plan-editor/components/form";
import { openPalette } from "../plan-editor/components/palette-store";
import { newAccount, newDebt, newId, newRealAsset } from "../plan-editor/state/defaults";
import { undo, useEditorStore } from "../plan-editor/state/doc-store";
import { addMonths, monthsToPayoff, netWorth, ownerLabel } from "../plan-editor/state/finance-math";
import { type Intent, useConsumeIntent } from "../plan-editor/state/intent";
import {
  ACCOUNT_CATEGORY_LABEL,
  accountTypeGroups,
  DEBT_TYPES_LABEL,
  DRAWDOWN_LABEL,
  REAL_ASSET_TYPES_LABEL,
} from "../plan-editor/state/labels";
import { AccountSheet } from "./account-sheet";
import { AssetSheet } from "./asset-sheet";
import { DebtSheet } from "./debt-sheet";
import { COUNTRIES, HouseholdSheet } from "./household-sheet";
import { updateFinances, useDraftDoc, useFinanceScope } from "./use-finances";

type Editing = { kind: "account" | "asset" | "debt"; id: string } | { kind: "household" } | null;

export function FinancesPage() {
  return (
    <EditorFrame>
      <FinancesContent />
    </EditorFrame>
  );
}

function FinancesContent() {
  const ws = useWorkspace();
  const doc = useDraftDoc();
  const ready = useEditorStore((s) => s.ready);
  const scope = useFinanceScope();
  const [editing, setEditing] = useState<Editing>(null);

  const addAccount = useCallback((type: AccountType) => {
    const d = useEditorStore.getState().draft;
    if (!d) return;
    const a = newAccount(type, { household: d.household, finances: d.finances });
    updateFinances((f) => ({ ...f, accounts: [...f.accounts, a] }), `Add ${a.name}`);
    setEditing({ kind: "account", id: a.id });
  }, []);
  const addAsset = useCallback((type: RealAssetType, financed = false) => {
    const d = useEditorStore.getState().draft;
    if (!d) return;
    const a = newRealAsset(type, { household: d.household, finances: d.finances }, financed);
    updateFinances((f) => ({ ...f, realAssets: [...f.realAssets, a] }), `Add ${a.name}`);
    setEditing({ kind: "asset", id: a.id });
  }, []);
  const addDebt = useCallback((type: Debt["type"]) => {
    const d = useEditorStore.getState().draft;
    if (!d) return;
    const x = newDebt(type, { household: d.household, finances: d.finances });
    updateFinances((f) => ({ ...f, debts: [...f.debts, x] }), `Add ${x.name}`);
    setEditing({ kind: "debt", id: x.id });
  }, []);

  useConsumeIntent((i: Intent) => {
    if (i.kind === "add-account") addAccount(i.type);
    else if (i.kind === "add-asset") addAsset(i.type, i.financed);
    else if (i.kind === "add-debt") addDebt(i.type);
    else if (i.kind === "edit-household") setEditing({ kind: "household" });
    else return false;
    return true;
  }, ready);

  if (!doc)
    return (
      <Page title="Current finances">
        {ws.isLoading ? <div className="h-40 animate-pulse rounded-xl bg-surface-2" /> : null}
      </Page>
    );
  const { finances } = doc;

  return (
    <ScopeProvider value={scope}>
      <Page
        title="Current finances"
        description="Where you stand today. Every plan that follows your live finances starts from these balances."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <SaveIndicator keys={["household"]} />
            <UndoRedo />
            <Tooltip content="Command palette">
              <Button
                variant="secondary"
                size="sm"
                onClick={openPalette}
                aria-label="Open command palette"
              >
                <Command /> <Kbd className="border-none bg-transparent">{modKey}K</Kbd>
              </Button>
            </Tooltip>
          </div>
        }
      >
        <ConflictBanner entity="household" what="Your finances" />
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.55fr)]">
          <HouseholdCard onEdit={() => setEditing({ kind: "household" })} />
          <NetWorthCard />
        </div>
        <AccountsCard
          accounts={finances.accounts}
          onOpen={(id) => setEditing({ kind: "account", id })}
          onAdd={addAccount}
        />
        <div className="grid gap-5 xl:grid-cols-2">
          <AssetsCard onOpen={(id) => setEditing({ kind: "asset", id })} onAdd={addAsset} />
          <DebtsCard
            onOpen={(id) => setEditing({ kind: "debt", id })}
            onOpenAsset={(id) => setEditing({ kind: "asset", id })}
            onAdd={addDebt}
            onAddMortgage={() => addAsset("house", true)}
          />
        </div>
        <FxRatesCard />
      </Page>
      <AccountSheet
        id={editing?.kind === "account" ? editing.id : null}
        onClose={() => setEditing(null)}
      />
      <AssetSheet
        id={editing?.kind === "asset" ? editing.id : null}
        onClose={() => setEditing(null)}
      />
      <DebtSheet
        id={editing?.kind === "debt" ? editing.id : null}
        onClose={() => setEditing(null)}
      />
      <HouseholdSheet open={editing?.kind === "household"} onClose={() => setEditing(null)} />
    </ScopeProvider>
  );
}

// ------------------------------------------------------------------------------------ household

function HouseholdCard({ onEdit }: { onEdit: () => void }) {
  const readOnly = useUi((s) => s.readOnly);
  const doc = useDraftDoc()!;
  const f = useFormat();
  const h = doc.household;
  const asOfYear = Number(doc.finances.asOf.slice(0, 4));
  return (
    <Card>
      <CardHeader
        eyebrow="Household"
        title={h.name}
        actions={
          <Button size="sm" onClick={onEdit}>
            {readOnly ? "View" : "Edit"}
          </Button>
        }
      />
      <div className="flex flex-col gap-3 p-4">
        <ul className="flex flex-col gap-2">
          {h.people.map((p, i) => (
            <li key={p.id} className="flex items-center gap-3">
              <AppearanceDot
                appearance={p.appearance}
                fallbackIndex={i}
                fallbackIcon={UserRound}
                size={30}
              />
              <div className="min-w-0">
                <div className="truncate font-medium">{p.name}</div>
                <div className="num text-[12px] text-ink-3">
                  Born {formatMonth(p.birthMonth, f.locale)} ·{" "}
                  {asOfYear - Number(p.birthMonth.slice(0, 4))} this year
                </div>
              </div>
            </li>
          ))}
        </ul>
        {h.dependents.length ? (
          <div className="text-[12px] text-ink-2">
            Dependants: {h.dependents.map((d) => d.name).join(", ")}
          </div>
        ) : null}
        <div className="flex flex-wrap gap-1.5">
          <Badge>
            <MapPin className="size-3" />
            {COUNTRIES.find((c) => c.value === h.location.country)?.label ?? h.location.country}
            {h.location.region ? ` · ${h.location.region}` : ""}
          </Badge>
          <Badge>{h.currency}</Badge>
          <Badge>{h.locale}</Badge>
          <Badge>{h.planningMode === "couple" ? "Couple" : "Individual"}</Badge>
        </div>
      </div>
    </Card>
  );
}

// ------------------------------------------------------------------------------------ net worth

const CATEGORY_ORDER = [
  "cash",
  "taxable",
  "tax-free",
  "tax-deferred",
  "crypto",
  "hsa",
  "education",
  "real-assets",
] as const;

function NetWorthCard() {
  const doc = useDraftDoc()!;
  const readOnly = useUi((s) => s.readOnly);
  const f = useFormat();
  const nw = useMemo(
    () => netWorth(financesInBase(doc.finances, doc.household.currency), doc.household),
    [doc.finances, doc.household],
  );
  const parts = CATEGORY_ORDER.map((c, i) => ({
    c,
    v: nw.byCategory[c] ?? 0,
    color: `var(--chart-${(i % 8) + 1})`,
  })).filter((x) => x.v > 0);
  const total = Math.max(1, nw.assets);
  const owners = Object.entries(nw.byOwner).filter(([, v]) => Math.abs(v) > 0.5);
  return (
    <Card>
      <CardHeader
        eyebrow="Live summary"
        title="Net worth"
        actions={
          <div className="flex items-center gap-1.5 text-[12px] text-ink-3">
            <label htmlFor="fin-asof">Balances as of</label>
            <Input
              id="fin-asof"
              disabled={readOnly}
              type="month"
              className="h-7 w-[140px] text-[12px]"
              value={doc.finances.asOf}
              onChange={(e) =>
                e.target.value &&
                updateFinances(
                  (x) => ({ ...x, asOf: e.target.value }),
                  "Change as-of month",
                  "asOf",
                )
              }
            />
          </div>
        }
      />
      <div className="flex flex-col gap-4 p-4">
        <div className="flex flex-wrap items-end gap-x-8 gap-y-3">
          <div>
            <div className="display num text-[34px] leading-none font-semibold" aria-live="polite">
              {f.money(nw.netWorth)}
            </div>
            <div className="mt-1.5 text-[12px] text-ink-3">Liquid {f.money(nw.liquid)}</div>
          </div>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-[12.5px]">
            <dt className="text-ink-3">Assets</dt>
            <dd className="num text-right">{f.money(nw.assets)}</dd>
            <dt className="text-ink-3">Liabilities</dt>
            <dd className="num text-right text-negative">
              {nw.liabilities ? `−${f.money(nw.liabilities)}` : f.money(0)}
            </dd>
          </dl>
        </div>
        <div>
          <div
            className="flex h-2.5 w-full overflow-hidden rounded-full bg-surface-2"
            role="img"
            aria-label="Assets by category"
          >
            {parts.map((p) => (
              <div
                key={p.c}
                style={{ width: `${(p.v / total) * 100}%`, background: p.color }}
                className="h-full transition-[width] duration-300 first:rounded-l-full last:rounded-r-full"
              />
            ))}
          </div>
          {nw.liabilities > 0 ? (
            <div
              className="mt-1 flex h-1.5 w-full overflow-hidden rounded-full bg-surface-2"
              role="img"
              aria-label="Liabilities relative to assets"
            >
              <div
                className="h-full rounded-full bg-negative/70 transition-[width] duration-300"
                style={{ width: `${Math.min(100, (nw.liabilities / total) * 100)}%` }}
              />
            </div>
          ) : null}
          <ul className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-[12px] sm:grid-cols-3">
            {parts.map((p) => (
              <li key={p.c} className="flex items-center gap-1.5">
                <span className="size-2 shrink-0 rounded-sm" style={{ background: p.color }} />
                <span className="min-w-0 flex-1 truncate text-ink-2">{DRAWDOWN_LABEL[p.c]}</span>
                <span className="num text-ink">{f.money(p.v, true)}</span>
              </li>
            ))}
          </ul>
        </div>
        {doc.household.people.length > 1 && owners.length ? (
          <div className="flex flex-wrap gap-x-5 gap-y-1 border-t border-border pt-3 text-[12px]">
            {owners.map(([o, v]) => (
              <span key={o} className="text-ink-3">
                {ownerLabel(doc.household, o)}{" "}
                <span className="num ml-1 text-ink">{f.money(v, true)}</span>
              </span>
            ))}
          </div>
        ) : null}
      </div>
    </Card>
  );
}

// ------------------------------------------------------------------------------------ accounts

const CATEGORY_ICON: Record<AccountCategory, typeof Wallet> = {
  cash: Wallet,
  investment: Landmark,
  retirement: PiggyBank,
  education: Landmark,
  health: Landmark,
  other: Wallet,
};
const CAT_ORDER: AccountCategory[] = [
  "cash",
  "investment",
  "retirement",
  "education",
  "health",
  "other",
];

function AddAccountMenu({
  onAdd,
  label = "Add account",
  variant = "secondary",
}: {
  onAdd: (t: AccountType) => void;
  label?: string;
  variant?: "secondary" | "primary";
}) {
  const country = useDraftDoc()?.household.location.country ?? "GB";
  const groups = accountTypeGroups(country);
  return (
    <ActionMenu>
      <ActionMenuTrigger asChild>
        <Button size="sm" variant={variant}>
          <Plus /> {label}
        </Button>
      </ActionMenuTrigger>
      <ActionMenuContent>
        {groups.slice(0, 2).map((g, gi) => (
          <div key={g.label}>
            {gi ? <ActionMenuSeparator /> : null}
            <ActionMenuLabel>{g.label}</ActionMenuLabel>
            {g.types.map((t) => (
              <ActionMenuItem key={t} onSelect={() => onAdd(t)}>
                {ACCOUNT_TYPE_INFO[t].label}
              </ActionMenuItem>
            ))}
          </div>
        ))}
        <ActionMenuSeparator />
        {groups.slice(2).map((g) => (
          <ActionSubMenu key={g.label} label={g.label}>
            {g.types.map((t) => (
              <ActionMenuItem key={t} onSelect={() => onAdd(t)}>
                {ACCOUNT_TYPE_INFO[t].label}
              </ActionMenuItem>
            ))}
          </ActionSubMenu>
        ))}
      </ActionMenuContent>
    </ActionMenu>
  );
}

function AccountsCard({
  accounts,
  onOpen,
  onAdd,
}: {
  accounts: Account[];
  onOpen: (id: string) => void;
  onAdd: (t: AccountType) => void;
}) {
  const readOnly = useUi((s) => s.readOnly);
  const f = useFormat();
  const doc = useDraftDoc()!;
  const [showArchived, setShowArchived] = useState(false);
  const visible = accounts.filter((a) => showArchived || !a.archived);
  const inBase = (a: Account) =>
    toBase(a.balance, a.currency, doc.household.currency, doc.finances.fxRates);
  const total = accounts.filter((a) => !a.archived).reduce((s, a) => s + inBase(a), 0);
  const archivedCount = accounts.filter((a) => a.archived).length;
  const gb = doc.household.location.country === "GB";
  const quick: AccountType[] = gb
    ? ["cash", "savings", "uk-isa", "uk-sipp", "uk-workplace-pension"]
    : ["cash", "savings", "taxable", "401k", "roth-ira"];

  const reorderWithin = (cat: AccountCategory, from: number, to: number) => {
    updateFinances((fin) => {
      const inCat = fin.accounts.filter(
        (a) => ACCOUNT_TYPE_INFO[a.type].category === cat && (showArchived || !a.archived),
      );
      const moved = moveItem(inCat, from, to);
      const slots = fin.accounts.map((a, i) => (inCat.includes(a) ? i : -1)).filter((i) => i >= 0);
      const next = [...fin.accounts];
      slots.forEach((slot, k) => {
        next[slot] = moved[k]!;
      });
      return { ...fin, accounts: next };
    }, "Reorder accounts");
  };

  return (
    <Card>
      <CardHeader
        eyebrow="Savings, investments & pensions"
        title={
          <span className="flex items-baseline gap-2">
            Accounts{" "}
            <span className="num text-[12.5px] font-normal text-ink-3">{f.money(total)}</span>
          </span>
        }
        actions={
          <>
            {archivedCount ? (
              <Button size="sm" variant="ghost" onClick={() => setShowArchived((v) => !v)}>
                {showArchived ? "Hide archived" : `Show archived (${archivedCount})`}
              </Button>
            ) : null}
            {readOnly ? null : <AddAccountMenu onAdd={onAdd} />}
          </>
        }
      />
      {visible.length === 0 ? (
        <EmptyState
          icon={PiggyBank}
          title="Add the accounts you hold today"
          action={
            readOnly
              ? null
              : quick.map((t) => (
                  <Button
                    key={t}
                    size="sm"
                    variant={t === quick[0] ? "primary" : "secondary"}
                    onClick={() => onAdd(t)}
                  >
                    <Plus /> {ACCOUNT_TYPE_INFO[t].label}
                  </Button>
                ))
          }
        >
          Start with your current account and savings, then{" "}
          {gb ? "ISAs and pensions (SIPP, workplace)" : "investment and retirement accounts"}. A
          balance and an owner are enough; tax treatment and access rules come from the account type
          and you can refine them later.
        </EmptyState>
      ) : (
        <div className="divide-y divide-border">
          {CAT_ORDER.map((cat) => {
            const items = visible.filter((a) => ACCOUNT_TYPE_INFO[a.type].category === cat);
            if (!items.length) return null;
            const Icon = CATEGORY_ICON[cat];
            const sub = items.filter((a) => !a.archived).reduce((s, a) => s + inBase(a), 0);
            return (
              <section
                key={cat}
                aria-label={ACCOUNT_CATEGORY_LABEL[cat]}
                className="px-3 py-3 sm:px-4"
              >
                <div className="mb-2 flex items-center justify-between px-1">
                  <h3 className="flex items-center gap-1.5 text-[12px] font-semibold text-ink-2">
                    <Icon className="size-3.5 text-ink-3" /> {ACCOUNT_CATEGORY_LABEL[cat]}
                  </h3>
                  <span className="num text-[12px] text-ink-3">{f.money(sub)}</span>
                </div>
                <SortableList
                  aria-label={`${ACCOUNT_CATEGORY_LABEL[cat]} accounts`}
                  items={items}
                  getId={(a) => a.id}
                  getLabel={(a) => a.name}
                  onReorder={(from, to) => reorderWithin(cat, from, to)}
                  className="gap-1.5"
                  renderItem={(a, { handle }) => (
                    <AccountRow account={a} handle={handle} onOpen={() => onOpen(a.id)} />
                  )}
                />
              </section>
            );
          })}
        </div>
      )}
    </Card>
  );
}

function AccountRow({
  account: a,
  handle,
  onOpen,
}: {
  account: Account;
  handle: ReactNode;
  onOpen: () => void;
}) {
  const readOnly = useUi((s) => s.readOnly);
  const doc = useDraftDoc()!;
  const f = useFormat();
  const info = ACCOUNT_TYPE_INFO[a.type];
  const idx = doc.finances.accounts.indexOf(a);
  const basis =
    a.costBasis !== undefined
      ? `basis ${f.moneyIn(a.costBasis, a.currency ?? f.currency, true)}`
      : a.contributionBasis !== undefined
        ? `contrib. ${f.moneyIn(a.contributionBasis, a.currency ?? f.currency, true)}`
        : null;
  return (
    <div
      className={cn(
        "group flex items-center gap-2 rounded-lg border border-border bg-surface py-1.5 pr-1.5 pl-1 transition-colors hover:border-border-strong",
        a.archived && "opacity-60",
      )}
    >
      {handle}
      <AppearanceDot
        appearance={a.appearance}
        fallbackIndex={idx}
        size={26}
        fallbackIcon={CATEGORY_ICON[info.category]}
      />
      <button
        type="button"
        onClick={onOpen}
        className="min-w-0 flex-1 rounded text-left outline-offset-2"
      >
        <div className="truncate text-[13px] font-medium text-ink group-hover:text-accent">
          {a.name}
        </div>
        <div className="truncate text-[11.5px] text-ink-3">
          {info.label} · {ownerLabel(doc.household, a.owner)}
          {a.institution ? ` · ${a.institution}` : ""}
          {a.currency ? ` · ${a.currency}` : ""}
          {(a.jurisdiction ?? info.country ?? doc.household.location.country) !==
          doc.household.location.country
            ? ` · in ${countryLabel(a.jurisdiction ?? info.country!)}`
            : ""}
          {a.archived ? " · archived" : ""}
        </div>
      </button>
      {basis ? (
        <span className="num hidden text-[11.5px] text-ink-3 md:inline">{basis}</span>
      ) : null}
      <CurrencyInput
        aria-label={`${a.name} balance`}
        decimals={0}
        currency={a.currency}
        disabled={readOnly}
        className="w-[118px] sm:w-[140px]"
        value={a.balance}
        onValueChange={(v) =>
          updateFinances(
            (fin) => ({
              ...fin,
              accounts: fin.accounts.map((x) => (x.id === a.id ? { ...x, balance: v ?? 0 } : x)),
            }),
            `Update ${a.name} balance`,
            `${a.id}:balance`,
          )
        }
      />
      <RowMenu
        name={a.name}
        onOpen={onOpen}
        onDuplicate={() =>
          updateFinances(
            (fin) => ({
              ...fin,
              accounts: [
                ...fin.accounts,
                { ...structuredClone(a), id: newId("acc"), name: `${a.name} (copy)` },
              ],
            }),
            `Duplicate ${a.name}`,
          )
        }
        archived={a.archived}
        onArchive={() =>
          updateFinances(
            (fin) => ({
              ...fin,
              accounts: fin.accounts.map((x) =>
                x.id === a.id ? { ...x, archived: !x.archived } : x,
              ),
            }),
            a.archived ? `Restore ${a.name}` : `Archive ${a.name}`,
          )
        }
        onDelete={() => {
          updateFinances(
            (fin) => ({ ...fin, accounts: fin.accounts.filter((x) => x.id !== a.id) }),
            `Delete ${a.name}`,
          );
          toast({
            title: `Deleted ${a.name}`,
            action: { label: "Undo", onClick: () => void undo() },
          });
        }}
      />
    </div>
  );
}

function RowMenu({
  name,
  onOpen,
  onDuplicate,
  onArchive,
  onDelete,
  archived,
}: {
  name: string;
  onOpen: () => void;
  onDuplicate?: () => void;
  onArchive?: () => void;
  onDelete: () => void;
  archived?: boolean;
}) {
  return (
    <ActionMenu>
      <ActionMenuTrigger asChild>
        <Button size="icon" variant="ghost" className="size-7" aria-label={`Actions for ${name}`}>
          <MoreHorizontal />
        </Button>
      </ActionMenuTrigger>
      <ActionMenuContent>
        <ActionMenuItem onSelect={onOpen}>Edit details</ActionMenuItem>
        {onDuplicate ? <ActionMenuItem onSelect={onDuplicate}>Duplicate</ActionMenuItem> : null}
        {onArchive ? (
          <ActionMenuItem onSelect={onArchive}>{archived ? "Restore" : "Archive"}</ActionMenuItem>
        ) : null}
        <ActionMenuSeparator />
        <ActionMenuItem tone="negative" onSelect={onDelete}>
          Delete
        </ActionMenuItem>
      </ActionMenuContent>
    </ActionMenu>
  );
}

// ------------------------------------------------------------------------------------ assets & debts

const ASSET_ICON: Partial<Record<RealAssetType, typeof Home>> = {
  house: Home,
  "rental-property": Home,
  car: Car,
  motorcycle: Car,
};

function AssetsCard({
  onOpen,
  onAdd,
}: {
  onOpen: (id: string) => void;
  onAdd: (t: RealAssetType, financed?: boolean) => void;
}) {
  const readOnly = useUi((s) => s.readOnly);
  const doc = useDraftDoc()!;
  const f = useFormat();
  const assets = doc.finances.realAssets;
  const total = assets
    .filter((a) => !a.archived)
    .reduce(
      (s, a) =>
        s + toBase(a.currentValue, a.currency, doc.household.currency, doc.finances.fxRates),
      0,
    );
  const menu = (
    <ActionMenu>
      <ActionMenuTrigger asChild>
        <Button size="sm">
          <Plus /> Add asset
        </Button>
      </ActionMenuTrigger>
      <ActionMenuContent>
        <ActionMenuItem onSelect={() => onAdd("house", true)} hint="Property with a mortgage">
          Home with mortgage
        </ActionMenuItem>
        <ActionMenuSeparator />
        {REAL_ASSET_TYPES.map((t) => (
          <ActionMenuItem key={t} onSelect={() => onAdd(t)}>
            {REAL_ASSET_TYPES_LABEL[t]}
          </ActionMenuItem>
        ))}
      </ActionMenuContent>
    </ActionMenu>
  );
  return (
    <Card>
      <CardHeader
        eyebrow="Property & possessions"
        title={
          <span className="flex items-baseline gap-2">
            Real assets{" "}
            <span className="num text-[12.5px] font-normal text-ink-3">{f.money(total)}</span>
          </span>
        }
        actions={readOnly ? null : menu}
      />
      {assets.length === 0 ? (
        <EmptyState
          compact
          icon={Home}
          title="Your home, car and other valuables"
          action={
            readOnly ? null : (
              <Button size="sm" onClick={() => onAdd("house", true)}>
                <Plus /> Add your home
              </Button>
            )
          }
        >
          Add property with its mortgage so repayments, running costs and equity are modelled for
          you. No need to add the mortgage as an expense.
        </EmptyState>
      ) : (
        <SortableList
          aria-label="Real assets"
          className="gap-1.5 p-3 sm:p-4"
          items={assets}
          getId={(a) => a.id}
          getLabel={(a) => a.name}
          onReorder={(from, to) =>
            updateFinances(
              (fin) => ({ ...fin, realAssets: moveItem(fin.realAssets, from, to) }),
              "Reorder assets",
            )
          }
          renderItem={(a, { handle, index }) => (
            <div
              className={cn(
                "group flex items-center gap-2 rounded-lg border border-border py-1.5 pr-1.5 pl-1 hover:border-border-strong",
                a.archived && "opacity-60",
              )}
            >
              {handle}
              <AppearanceDot
                appearance={a.appearance}
                fallbackIndex={index + 2}
                size={26}
                fallbackIcon={ASSET_ICON[a.type] ?? Landmark}
              />
              <button
                type="button"
                onClick={() => onOpen(a.id)}
                className="min-w-0 flex-1 text-left"
              >
                <div className="truncate text-[13px] font-medium group-hover:text-accent">
                  {a.name}
                </div>
                <div className="truncate text-[11.5px] text-ink-3">
                  {REAL_ASSET_TYPES_LABEL[a.type]} · {ownerLabel(doc.household, a.owner)}
                  {a.loan
                    ? ` · loan ${f.moneyIn(a.loan.balance, a.currency ?? f.currency, true)}`
                    : ""}
                  {a.currency ? ` · ${a.currency}` : ""}
                  {a.country && a.country !== doc.household.location.country
                    ? ` · in ${countryLabel(a.country)}`
                    : ""}
                </div>
              </button>
              <CurrencyInput
                aria-label={`${a.name} value`}
                decimals={0}
                currency={a.currency}
                disabled={readOnly}
                className="w-[118px] sm:w-[140px]"
                value={a.currentValue}
                onValueChange={(v) =>
                  updateFinances(
                    (fin) => ({
                      ...fin,
                      realAssets: fin.realAssets.map((x) =>
                        x.id === a.id ? { ...x, currentValue: Math.max(0, v ?? 0) } : x,
                      ),
                    }),
                    `Update ${a.name} value`,
                    `${a.id}:value`,
                  )
                }
              />
              <RowMenu
                name={a.name}
                onOpen={() => onOpen(a.id)}
                archived={a.archived}
                onArchive={() =>
                  updateFinances(
                    (fin) => ({
                      ...fin,
                      realAssets: fin.realAssets.map((x) =>
                        x.id === a.id ? { ...x, archived: !x.archived } : x,
                      ),
                    }),
                    "Archive asset",
                  )
                }
                onDelete={() =>
                  updateFinances(
                    (fin) => ({ ...fin, realAssets: fin.realAssets.filter((x) => x.id !== a.id) }),
                    `Delete ${a.name}`,
                  )
                }
              />
            </div>
          )}
        />
      )}
    </Card>
  );
}

function DebtsCard({
  onOpen,
  onOpenAsset,
  onAdd,
  onAddMortgage,
}: {
  onOpen: (id: string) => void;
  onOpenAsset: (id: string) => void;
  onAdd: (t: Debt["type"]) => void;
  onAddMortgage: () => void;
}) {
  const readOnly = useUi((s) => s.readOnly);
  const doc = useDraftDoc()!;
  const f = useFormat();
  const debts = doc.finances.debts;
  const loans = doc.finances.realAssets.filter((r) => r.loan && !r.archived);
  const total =
    debts
      .filter((d) => !d.archived)
      .reduce(
        (s, d) => s + toBase(d.balance, d.currency, doc.household.currency, doc.finances.fxRates),
        0,
      ) +
    loans.reduce(
      (s, r) =>
        s + toBase(r.loan!.balance, r.currency, doc.household.currency, doc.finances.fxRates),
      0,
    );
  const payoff = (balance: number, apr: number, payment: number) => {
    const m = monthsToPayoff(balance, apr, payment);
    return m === null
      ? "never at this payment"
      : `paid off ${formatMonth(addMonths(doc.finances.asOf, m), f.locale)}`;
  };
  const menu = (
    <ActionMenu>
      <ActionMenuTrigger asChild>
        <Button size="sm">
          <Plus /> Add debt
        </Button>
      </ActionMenuTrigger>
      <ActionMenuContent>
        <ActionMenuItem onSelect={onAddMortgage} hint="Mortgages live on the property they secure">
          Mortgage
        </ActionMenuItem>
        <ActionMenuSeparator />
        {DEBT_TYPES.map((t) => (
          <ActionMenuItem key={t} onSelect={() => onAdd(t)}>
            {DEBT_TYPES_LABEL[t]}
          </ActionMenuItem>
        ))}
      </ActionMenuContent>
    </ActionMenu>
  );
  return (
    <Card>
      <CardHeader
        eyebrow="What you owe"
        title={
          <span className="flex items-baseline gap-2">
            Debts{" "}
            <span className="num text-[12.5px] font-normal text-negative">
              {total ? `−${f.money(total)}` : f.money(0)}
            </span>
          </span>
        }
        actions={readOnly ? null : menu}
      />
      {debts.length === 0 && loans.length === 0 ? (
        <EmptyState
          compact
          icon={CreditCard}
          title="No debts — or none added yet"
          action={
            readOnly ? null : (
              <Button size="sm" onClick={() => onAdd("credit-card")}>
                <Plus /> Add a debt
              </Button>
            )
          }
        >
          Credit cards, student loans, car finance and personal loans. Repayments come out of cash
          flow automatically, and you can plan overpayments as Flows.
        </EmptyState>
      ) : (
        <div className="flex flex-col gap-1.5 p-3 sm:p-4">
          {loans.map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => onOpenAsset(r.id)}
              className="group flex items-center gap-2 rounded-lg border border-dashed border-border px-2.5 py-1.5 text-left hover:border-border-strong"
            >
              <Home className="size-4 text-ink-3" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-medium group-hover:text-accent">
                  {r.name} mortgage
                </div>
                <div className="truncate text-[11.5px] text-ink-3">
                  {f.percent(r.loan!.interest.apr, 2)} · {f.money(r.loan!.monthlyPayment.value)}/mo
                  · {payoff(r.loan!.balance, r.loan!.interest.apr, r.loan!.monthlyPayment.value)}
                </div>
              </div>
              <span className="num text-[13px] text-negative">−{f.money(r.loan!.balance)}</span>
            </button>
          ))}
          <SortableList
            aria-label="Debts"
            className="gap-1.5"
            items={debts}
            getId={(d) => d.id}
            getLabel={(d) => d.name}
            onReorder={(from, to) =>
              updateFinances(
                (fin) => ({ ...fin, debts: moveItem(fin.debts, from, to) }),
                "Reorder debts",
              )
            }
            renderItem={(d, { handle, index }) => (
              <div
                className={cn(
                  "group flex items-center gap-2 rounded-lg border border-border py-1.5 pr-1.5 pl-1 hover:border-border-strong",
                  d.archived && "opacity-60",
                )}
              >
                {handle}
                <span
                  className="size-2 shrink-0 rounded-full"
                  style={{ background: appearanceColor(d.appearance?.color, index + 3) }}
                />
                <button
                  type="button"
                  onClick={() => onOpen(d.id)}
                  className="min-w-0 flex-1 text-left"
                >
                  <div className="truncate text-[13px] font-medium group-hover:text-accent">
                    {d.name}
                  </div>
                  <div className="truncate text-[11.5px] text-ink-3">
                    {f.percent(d.interest.apr, 2)} ·{" "}
                    {f.moneyIn(d.monthlyPayment.value, d.currency ?? f.currency)}/mo ·{" "}
                    {payoff(d.balance, d.interest.apr, d.monthlyPayment.value)}
                    {d.country && d.country !== doc.household.location.country
                      ? ` · ${countryLabel(d.country)}`
                      : ""}
                  </div>
                </button>
                <CurrencyInput
                  aria-label={`${d.name} balance`}
                  decimals={0}
                  currency={d.currency}
                  disabled={readOnly}
                  className="w-[118px] sm:w-[140px]"
                  value={d.balance}
                  onValueChange={(v) =>
                    updateFinances(
                      (fin) => ({
                        ...fin,
                        debts: fin.debts.map((x) =>
                          x.id === d.id ? { ...x, balance: Math.max(0, v ?? 0) } : x,
                        ),
                      }),
                      `Update ${d.name}`,
                      `${d.id}:balance`,
                    )
                  }
                />
                <RowMenu
                  name={d.name}
                  onOpen={() => onOpen(d.id)}
                  archived={d.archived}
                  onArchive={() =>
                    updateFinances(
                      (fin) => ({
                        ...fin,
                        debts: fin.debts.map((x) =>
                          x.id === d.id ? { ...x, archived: !x.archived } : x,
                        ),
                      }),
                      "Archive debt",
                    )
                  }
                  onDelete={() =>
                    updateFinances(
                      (fin) => ({ ...fin, debts: fin.debts.filter((x) => x.id !== d.id) }),
                      `Delete ${d.name}`,
                    )
                  }
                />
              </div>
            )}
          />
        </div>
      )}
    </Card>
  );
}

/** Household exchange rates (`CurrentFinances.fxRates`): saved with the rest of Current finances. */
function FxRatesCard() {
  const doc = useDraftDoc()!;
  const f = useFormat();
  const readOnly = useUi((s) => s.readOnly);
  const plans = useEditorStore((s) => s.draft?.plans ?? []);
  const base = doc.household.currency;
  const inUse = foreignCurrencies(doc, plans);
  const rates = doc.finances.fxRates ?? [];
  const [open, setOpen] = useState(false);
  if (!inUse.length && !rates.length && !open)
    return (
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius-card)] border border-dashed border-border px-4 py-3 text-[12.5px] text-ink-2">
        <span>
          Hold money in another currency? Set an account, property, debt or income to its own
          currency and add an exchange rate to {base}.
        </span>
        {readOnly ? null : (
          <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
            <Plus /> Exchange rates
          </Button>
        )}
      </div>
    );
  return (
    <Card>
      <CardHeader
        eyebrow="Currencies"
        title={`Exchange rates to ${base}`}
        actions={
          inUse.length ? (
            <span className="text-[12px] text-ink-3">In use: {inUse.join(", ")}</span>
          ) : null
        }
      />
      <div className="p-4">
        <FxRatesEditor
          rates={rates}
          base={base}
          inUse={inUse}
          disabled={readOnly}
          onChange={(fxRates) =>
            updateFinances(
              (fin) => ({ ...fin, fxRates: fxRates.length ? fxRates : undefined }),
              "Edit exchange rates",
              "fx",
            )
          }
        />
        <p className="mt-3 text-[11.5px] text-ink-3">
          Rates as of {formatMonth(doc.finances.asOf, f.locale)}. Plans move them by the drift each
          year (a plan can override a pair, in either direction, in its Assumptions). Monte Carlo
          follows the same path unless you turn on exchange-rate risk in Chance of success. Saved
          with the rest of Current finances; changes made through the API’s FX routes appear here
          after a refresh.
        </p>
      </div>
    </Card>
  );
}
