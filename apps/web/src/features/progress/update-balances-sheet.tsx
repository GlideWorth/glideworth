/**
 * Quick-entry sheet: type today's balance for every account, property and debt, and record a
 * progress snapshot in one go. Only changed rows are sent. Goes through the household balances
 * endpoint (which can also move "as of" and records the snapshot atomically).
 */
import { ACCOUNT_TYPE_INFO, type GlideworthDocument } from "@glideworth/core";
import { useMemo, useState } from "react";
import { Button } from "../../components/ui/button";
import { Field, Input } from "../../components/ui/input";
import { CurrencyInput } from "../../components/ui/number-input";
import { FormSection, Sheet, SheetContent } from "../../components/ui/sheet";
import { formatMonth, formatSigned } from "../../lib/format";
import { useFormat } from "../../lib/workspace";
import { currentMonth } from "./progress-model";

export interface BalanceUpdate {
  accounts: { accountId: string; balance: number }[];
  realAssets: { assetId: string; currentValue: number }[];
  debts: { debtId: string; balance: number }[];
  asOf?: string;
  note?: string;
}

type Draft = Record<string, number | null>;

export function UpdateBalancesSheet({
  open,
  onOpenChange,
  doc,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  doc: GlideworthDocument;
  onSubmit: (u: BalanceUpdate) => Promise<void>;
}) {
  const f = useFormat();
  const fin = doc.finances;
  const initial = useMemo(() => {
    const d: Draft = {};
    for (const a of fin.accounts) d[`a:${a.id}`] = a.balance;
    for (const r of fin.realAssets) d[`r:${r.id}`] = r.currentValue;
    for (const x of fin.debts) d[`d:${x.id}`] = x.balance;
    return d;
  }, [fin]);
  const [draft, setDraft] = useState<Draft>(initial);
  const [moveAsOf, setMoveAsOf] = useState(true);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const month = currentMonth();
  const changed = (k: string) =>
    draft[k] !== undefined && draft[k] !== null && draft[k] !== initial[k];
  const nChanged = Object.keys(initial).filter(changed).length;
  const set = (k: string, v: number | null) => setDraft((d) => ({ ...d, [k]: v }));
  const num = (k: string) => (draft[k] ?? initial[k] ?? 0) as number;

  const netWorth = (d: (k: string) => number) =>
    fin.accounts.reduce((s, a) => s + d(`a:${a.id}`), 0) +
    fin.realAssets.reduce((s, r) => s + d(`r:${r.id}`) - (r.loan?.balance ?? 0), 0) -
    fin.debts.reduce((s, x) => s + d(`d:${x.id}`), 0);
  const before = netWorth((k) => initial[k] ?? 0);
  const after = netWorth(num);

  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      await onSubmit({
        accounts: fin.accounts
          .filter((a) => changed(`a:${a.id}`))
          .map((a) => ({ accountId: a.id, balance: num(`a:${a.id}`) })),
        realAssets: fin.realAssets
          .filter((r) => changed(`r:${r.id}`))
          .map((r) => ({ assetId: r.id, currentValue: Math.max(0, num(`r:${r.id}`)) })),
        debts: fin.debts
          .filter((x) => changed(`d:${x.id}`))
          .map((x) => ({ debtId: x.id, balance: Math.max(0, num(`d:${x.id}`)) })),
        ...(moveAsOf && fin.asOf !== month ? { asOf: month } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      onOpenChange(false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const rows = (title: string, items: { key: string; name: string; sub?: string }[]) =>
    items.length ? (
      <FormSection title={title}>
        <div className="grid gap-2">
          {items.map((it) => (
            <div key={it.key} className="grid grid-cols-[minmax(0,1fr)_150px] items-center gap-3">
              <div className="min-w-0">
                <div className="truncate text-[13px] font-medium">{it.name}</div>
                {it.sub ? <div className="truncate text-[11.5px] text-ink-3">{it.sub}</div> : null}
              </div>
              <CurrencyInput
                aria-label={`${it.name} balance`}
                value={draft[it.key] ?? null}
                onValueChange={(v) => set(it.key, v)}
                className={changed(it.key) ? "border-accent" : ""}
              />
            </div>
          ))}
        </div>
      </FormSection>
    ) : null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        eyebrow="Progress"
        title="Update balances"
        description="Enter today's balances. They update your current finances and record a snapshot."
        footer={
          <>
            <div className="mr-auto text-[12px] text-ink-2">
              {nChanged} changed · net worth{" "}
              <span className="num font-semibold">{f.money(after)}</span>
              {after !== before ? (
                <span className={after > before ? "text-positive" : "text-negative"}>
                  {" "}
                  ({formatSigned(after - before, (v) => f.money(v))})
                </span>
              ) : null}
            </div>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={submit} disabled={busy}>
              Save and record snapshot
            </Button>
          </>
        }
      >
        {rows(
          "Accounts",
          fin.accounts
            .filter((a) => !a.archived)
            .map((a) => ({
              key: `a:${a.id}`,
              name: a.name,
              sub: ACCOUNT_TYPE_INFO[a.type]?.label ?? a.type,
            })),
        )}
        {rows(
          "Property and other assets",
          fin.realAssets
            .filter((r) => !r.archived)
            .map((r) => ({
              key: `r:${r.id}`,
              name: r.name,
              sub: r.loan?.balance
                ? `Current value · loan ${f.money(r.loan.balance)} (change it in Current finances)`
                : "Current value",
            })),
        )}
        {rows(
          "Debts",
          fin.debts
            .filter((x) => !x.archived)
            .map((x) => ({ key: `d:${x.id}`, name: x.name, sub: "Balance owed" })),
        )}
        <FormSection title="Snapshot">
          <Field label="Note (optional)">
            {(id) => (
              <Input
                id={id}
                value={note}
                maxLength={500}
                onChange={(e) => setNote(e.target.value)}
              />
            )}
          </Field>
          {fin.asOf !== month ? (
            <label className="flex items-start gap-2 text-[12.5px]">
              <input
                type="checkbox"
                checked={moveAsOf}
                onChange={(e) => setMoveAsOf(e.target.checked)}
                className="mt-0.5 accent-[var(--accent)]"
              />
              <span>
                Move the “as of” date of your current finances from{" "}
                {formatMonth(fin.asOf, f.locale)} to {formatMonth(month, f.locale)}
                <span className="block text-[11.5px] text-ink-3">
                  Plans that follow current finances start from this month.
                </span>
              </span>
            </label>
          ) : null}
          {err ? <div className="text-[12px] text-negative">{err}</div> : null}
        </FormSection>
      </SheetContent>
    </Sheet>
  );
}
