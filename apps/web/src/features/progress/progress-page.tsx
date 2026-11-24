import type { GlideworthDocument, ProgressSnapshot } from "@glideworth/core";
import { useQueryClient } from "@tanstack/react-query";
import { applyHistoryPlan } from "@glideworth/importers";
import { Camera, Download, Pencil, Plus, Trash2, Upload, Wallet } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { Chart } from "../../components/charts/echarts";
import { categoryColor, slotColor } from "../../components/charts/palette";
import { EmptyState, ErrorState } from "../../components/charts/states";
import {
  axisStyle,
  baseOption,
  type ChartTokens,
  escapeHtml,
  tooltipHeader,
  tooltipRow,
} from "../../components/charts/tokens";
import { Page } from "../../components/layout/app-shell";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardBody, CardHeader } from "../../components/ui/card";
import { confirmAction } from "../../components/ui/confirm-dialog";
import { Dialog, DialogContent } from "../../components/ui/dialog";
import { Field, Input } from "../../components/ui/input";
import { CurrencyInput } from "../../components/ui/number-input";
import { Segmented } from "../../components/ui/segmented";
import { Select } from "../../components/ui/select";
import { Stat } from "../../components/ui/stat";
import { Table, TBody, TD, TH, THead, TR } from "../../components/ui/table";
import { api } from "../../lib/api";
import { isDemo } from "../../lib/demo";
import { formatDay, formatMoney, formatSigned } from "../../lib/format";
import { conv as toToday } from "../../lib/money";
import type { Workspace } from "../../lib/workspace";
import { useFormat, useProjection } from "../../lib/workspace";
import { driftSentence, storedTotalDrift } from "../dashboard/dashboard-view";
import { useAnalysis } from "../results/use-analysis";
import { AccountHistory } from "./account-history";
import { HistoryExportDialog } from "./history-export-dialog";
import {
  HistoryImportDialog,
  type HistoryImportOutcome,
  type HistoryImportRequest,
} from "./history-import-dialog";
import {
  deflatorFor,
  projectionPoints,
  RANGES,
  type RangeId,
  rangeStart,
  type SnapshotDraft,
  snapshotFromFinances,
  todayIso,
} from "./progress-model";
import { type BalanceUpdate, UpdateBalancesSheet } from "./update-balances-sheet";

function useSnapshotActions() {
  const qc = useQueryClient();
  const { workspace } = useAnalysis();
  const hh = workspace?.doc.household.id;
  const live = workspace?.source === "api" && !!hh;
  const local = (fn: (list: ProgressSnapshot[]) => ProgressSnapshot[]) =>
    qc.setQueryData<Workspace>(["workspace"], (ws) =>
      ws ? { ...ws, doc: { ...ws.doc, progress: fn(ws.doc.progress) } } : ws,
    );
  const refresh = () => qc.invalidateQueries({ queryKey: ["workspace"] });
  const toSnap = (d: SnapshotDraft, id?: string): ProgressSnapshot => ({
    ...d,
    id: id ?? d.id ?? `snap-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    householdId: hh ?? "local",
  });
  return {
    live,
    async save(d: SnapshotDraft, existingId?: string) {
      if (live) {
        const { id: _drop, ...body } = d;
        if (existingId) await api.replaceSnapshot(hh!, existingId, body);
        else await api.createSnapshot(hh!, body);
        await refresh();
      } else
        local((l) =>
          existingId
            ? l.map((s) => (s.id === existingId ? toSnap(d, existingId) : s))
            : [...l, toSnap(d)],
        );
    },
    async remove(id: string) {
      if (live) {
        await api.deleteSnapshot(hh!, id);
        await refresh();
      } else local((l) => l.filter((s) => s.id !== id));
    },
    async recordNow(draft: SnapshotDraft) {
      if (live) {
        await api.recordCurrentSnapshot(hh!, { date: draft.date });
        await refresh();
      } else local((l) => [...l, toSnap(draft)]);
    },
    async updateBalances(doc: GlideworthDocument, u: BalanceUpdate) {
      if (live) {
        await api.updateBalances(hh!, {
          accounts: u.accounts,
          realAssets: u.realAssets,
          debts: u.debts,
          ...(u.asOf ? { asOf: u.asOf } : {}),
          recordSnapshot: true,
          ...(u.note ? { snapshotNote: u.note } : {}),
        });
        await qc.invalidateQueries({ queryKey: ["workspace"] });
        return;
      }
      // Offline sample: apply to this session's workspace and record the snapshot locally.
      const acc = new Map(u.accounts.map((a) => [a.accountId, a.balance]));
      const ast = new Map(u.realAssets.map((a) => [a.assetId, a.currentValue]));
      const dbt = new Map(u.debts.map((d) => [d.debtId, d.balance]));
      const finances = {
        ...doc.finances,
        ...(u.asOf ? { asOf: u.asOf } : {}),
        accounts: doc.finances.accounts.map((a) =>
          acc.has(a.id) ? { ...a, balance: acc.get(a.id)! } : a,
        ),
        realAssets: doc.finances.realAssets.map((a) =>
          ast.has(a.id) ? { ...a, currentValue: ast.get(a.id)! } : a,
        ),
        debts: doc.finances.debts.map((d) =>
          dbt.has(d.id) ? { ...d, balance: dbt.get(d.id)! } : d,
        ),
      };
      const snap = {
        ...snapshotFromFinances({ ...doc, finances }, todayIso()),
        ...(u.note ? { note: u.note } : {}),
      };
      qc.setQueryData<Workspace>(["workspace"], (ws) =>
        ws
          ? { ...ws, doc: { ...ws.doc, finances, progress: [...ws.doc.progress, toSnap(snap)] } }
          : ws,
      );
    },
    /** Balance-history import: the server re-plans and writes; offline, the previewed plan is applied here. */
    async importHistory(r: HistoryImportRequest): Promise<HistoryImportOutcome> {
      if (live) {
        const out = await api.importBalanceHistory(hh!, {
          rows: r.rows,
          mode: r.mode,
          dryRun: false,
          updateCurrentBalances: r.updateCurrent,
          today: r.today,
        });
        await qc.invalidateQueries({ queryKey: ["workspace"] });
        return { counts: out.counts, currentBalances: out.currentBalances !== null };
      }
      const c = r.updateCurrent ? r.plan.current : null;
      qc.setQueryData<Workspace>(["workspace"], (ws) => {
        if (!ws) return ws;
        const stamp = Date.now().toString(36);
        const progress = applyHistoryPlan(
          ws.doc.progress,
          r.plan,
          ws.doc.household.id,
          (_d, i) => `snap-${stamp}-${i}`,
        );
        if (!c) return { ...ws, doc: { ...ws.doc, progress } };
        const acc = new Map(c.accounts.map((a) => [a.accountId, a.balance]));
        const dbt = new Map(c.debts.map((d) => [d.debtId, d.balance]));
        const ast = new Map(c.realAssets.map((a) => [a.assetId, a]));
        const f = ws.doc.finances;
        const finances = {
          ...f,
          accounts: f.accounts.map((a) => (acc.has(a.id) ? { ...a, balance: acc.get(a.id)! } : a)),
          debts: f.debts.map((d) => (dbt.has(d.id) ? { ...d, balance: dbt.get(d.id)! } : d)),
          realAssets: f.realAssets.map((a) => {
            const u = ast.get(a.id);
            if (!u) return a;
            return {
              ...a,
              ...(u.currentValue !== undefined ? { currentValue: u.currentValue } : {}),
              ...(u.loanBalance !== undefined && a.loan
                ? { loan: { ...a.loan, balance: u.loanBalance } }
                : {}),
            };
          }),
        };
        return { ...ws, doc: { ...ws.doc, progress, finances } };
      });
      return { counts: r.plan.counts, currentBalances: !!c };
    },
  };
}

function SnapshotDialog({
  open,
  onOpenChange,
  initial,
  onSave,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  initial: SnapshotDraft;
  onSave: (d: SnapshotDraft) => Promise<void>;
}) {
  const [d, setD] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const f = useFormat();
  const key = `${initial.date}${initial.netWorth}`;
  const [k, setK] = useState(key);
  if (k !== key) {
    setK(key);
    setD(initial);
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={initial.id ? "Edit snapshot" : "Add a snapshot"}
        description={`Amounts in ${f.currency}, as they were on the date.`}
      >
        <form
          className="flex flex-col gap-3"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setErr(null);
            try {
              await onSave({ ...d, netWorth: d.assets - d.liabilities });
              onOpenChange(false);
            } catch (x) {
              setErr(x instanceof Error ? x.message : String(x));
            } finally {
              setBusy(false);
            }
          }}
        >
          <Field label="Date">
            {(id) => (
              <Input
                id={id}
                type="date"
                required
                value={d.date}
                onChange={(e) => setD({ ...d, date: e.target.value })}
              />
            )}
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Assets">
              {(id) => (
                <CurrencyInput
                  id={id}
                  value={d.assets}
                  onValueChange={(v) => setD({ ...d, assets: v ?? 0 })}
                />
              )}
            </Field>
            <Field label="Liabilities">
              {(id) => (
                <CurrencyInput
                  id={id}
                  min={0}
                  value={d.liabilities}
                  onValueChange={(v) => setD({ ...d, liabilities: v ?? 0 })}
                />
              )}
            </Field>
          </div>
          <div className="text-[12.5px] text-ink-2">
            Net worth:{" "}
            <span className="num font-semibold">{f.money(d.assets - d.liabilities)}</span>
          </div>
          <Field label="Note">
            {(id) => (
              <Input
                id={id}
                value={d.note ?? ""}
                maxLength={500}
                onChange={(e) => setD({ ...d, note: e.target.value })}
              />
            )}
          </Field>
          {err ? <div className="text-[12px] text-negative">{err}</div> : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={busy}>
              Save
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

type Series = "netWorth" | "assetsLiabilities" | "account";

export function ProgressView() {
  const { doc, plan, workspace, basis, index } = useAnalysis();
  const f = useFormat();
  const actions = useSnapshotActions();
  const [range, setRange] = useState<RangeId>("all");
  const [view, setView] = useState<Series>("netWorth");
  const [overlayPlan, setOverlayPlan] = useState<string>("");
  const [account, setAccount] = useState<string>("");
  const [editing, setEditing] = useState<{ draft: SnapshotDraft; id?: string } | null>(null);
  const [balancesOpen, setBalancesOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [actionError, setActionError] = useState<unknown>(null);
  const overlayId = overlayPlan || plan?.id;
  const overlay = useProjection(overlayId);
  const proj = overlay.data?.result;
  const deflate = useMemo(() => deflatorFor(proj), [proj]);
  const conv = useCallback(
    (date: string, v: number) => toToday({ priceIndex: deflate(date) }, v, basis, "stock"),
    [basis, deflate],
  );

  const snaps = useMemo(
    () => [...(doc?.progress ?? [])].sort((a, b) => a.date.localeCompare(b.date)),
    [doc],
  );
  const latest = snaps.at(-1);
  const from = latest ? rangeStart(range, latest.date) : null;
  const shown = snaps.filter((s) => !from || s.date >= from);
  const accountIds = [...new Set(snaps.flatMap((s) => s.accounts.map((a) => a.accountId)))];
  const acct = account || accountIds[0] || "";
  const first = shown[0];
  const change =
    first && latest ? conv(latest.date, latest.netWorth) - conv(first.date, first.netWorth) : 0;
  const drifted = doc
    ? shown.flatMap((s) => {
        const drift = storedTotalDrift(doc, s);
        return drift ? [{ snap: s, drift }] : [];
      })
    : [];

  const run = async (p: Promise<void>) => {
    setActionError(null);
    try {
      await p;
    } catch (e) {
      setActionError(e);
    }
  };

  const build = useCallback(
    (t: ChartTokens) => {
      const money = (v: number) =>
        formatMoney(v, { locale: f.locale, currency: f.currency, compact: true });
      const pts = (pick: (s: ProgressSnapshot) => number | null) =>
        shown.map((s) => {
          const v = pick(s);
          return [s.date, v === null ? null : conv(s.date, v)];
        });
      const series: object[] = [];
      if (view === "netWorth") {
        series.push({
          name: "Net worth (actual)",
          type: "line",
          data: pts((s) => s.netWorth),
          color: t.accent,
          lineStyle: { width: 2.25 },
          symbol: "circle",
          symbolSize: 7,
          itemStyle: { color: t.accent, borderColor: t.surface, borderWidth: 1.5 },
        });
        if (proj) {
          const lo = from ?? first?.date ?? "0000";
          const hi = latest ? latest.date : "9999";
          const startFin = doc?.plans.find((x) => x.id === overlayId)?.startingConditions;
          const fin = startFin?.kind === "snapshot" ? startFin.finances : doc?.finances;
          const startNw = fin
            ? fin.accounts.reduce((a, x) => a + x.balance, 0) +
              fin.realAssets.reduce((a, r) => a + r.currentValue - (r.loan?.balance ?? 0), 0) -
              fin.debts.reduce((a, d) => a + d.balance, 0)
            : null;
          const pp = [
            ...(startNw !== null
              ? [{ date: `${proj.meta.startMonth}-01`, nominal: startNw, priceIndex: 1 }]
              : []),
            ...projectionPoints(proj),
          ].filter((p) => p.date >= lo && p.date <= `${Number(hi.slice(0, 4)) + 3}${hi.slice(4)}`);
          series.push({
            name: `Projected (${overlay.data?.result.meta.planId === plan?.id ? plan?.name : (doc?.plans.find((x) => x.id === overlayId)?.name ?? "plan")})`,
            type: "line",
            data: pp.map((p) => [p.date, toToday(p, p.nominal, basis, "stock")]),
            color: t.ink3,
            lineStyle: { width: 1.5, type: "dashed" },
            symbol: "none",
          });
        }
      } else if (view === "assetsLiabilities") {
        series.push(
          {
            name: "Assets",
            type: "line",
            data: pts((s) => s.assets),
            color: slotColor(t.theme, 2),
            symbol: "circle",
            symbolSize: 6,
            lineStyle: { width: 2 },
          },
          {
            name: "Liabilities",
            type: "line",
            data: pts((s) => s.liabilities),
            color: t.negative,
            symbol: "circle",
            symbolSize: 6,
            lineStyle: { width: 2, type: "dashed" },
          },
        );
      } else {
        const meta = index.accounts.get(acct);
        series.push({
          name: meta?.name ?? acct,
          type: "line",
          data: pts((s) => s.accounts.find((a) => a.accountId === acct)?.balance ?? null),
          color: meta ? categoryColor(t.theme, meta.category) : t.accent,
          symbol: "circle",
          symbolSize: 6,
          connectNulls: false,
          lineStyle: { width: 2 },
          areaStyle: { opacity: 0.12 },
        });
      }
      const ax = axisStyle(t);
      return {
        ...baseOption(t),
        legend: { ...baseOption(t).legend, show: series.length > 1 },
        grid: { ...baseOption(t).grid, top: series.length > 1 ? 34 : 14 },
        tooltip: {
          ...baseOption(t).tooltip,
          axisPointer: { type: "line", lineStyle: { color: t.ink3 } },
          formatter: (
            ps: {
              axisValueLabel: string;
              seriesName: string;
              value: [string, number | null];
              color: string;
            }[],
          ) => {
            const date = ps[0]?.value[0] ?? "";
            const snap = shown.find((s) => s.date === date);
            return `${tooltipHeader(new Intl.DateTimeFormat(f.locale, { dateStyle: "medium", timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`)))}${ps
              .filter((p) => p.value[1] !== null)
              .map((p) =>
                tooltipRow(
                  p.color,
                  p.seriesName,
                  formatMoney(p.value[1]!, { locale: f.locale, currency: f.currency }),
                ),
              )
              .join(
                "",
              )}${snap?.note ? `<div style="opacity:.7;margin-top:2px">${escapeHtml(snap.note)}</div>` : ""}`;
          },
        },
        xAxis: { type: "time", ...ax, splitLine: { show: false }, ...(from ? { min: from } : {}) },
        yAxis: {
          type: "value",
          ...ax,
          axisLabel: { ...ax.axisLabel, formatter: money },
          scale: true,
        },
        series,
      };
    },
    [
      shown,
      view,
      proj,
      from,
      first,
      latest,
      basis,
      conv,
      f,
      acct,
      index,
      overlay.data,
      plan,
      doc,
      overlayId,
    ],
  );

  return (
    <Page
      title="Progress"
      description="Actual net worth over time, against what your plan expected."
      actions={
        <>
          {!actions.live ? (
            <Badge tone="ochre">
              {isDemo() ? "Demo · changes are not saved" : "Offline sample · changes are not saved"}
            </Badge>
          ) : null}
          <Button
            size="sm"
            variant="secondary"
            onClick={() =>
              setEditing({
                draft: {
                  date: todayIso(),
                  source: "manual",
                  netWorth: 0,
                  assets: 0,
                  liabilities: 0,
                  byCategory: {},
                  accounts: [],
                  realAssets: [],
                  debts: [],
                },
              })
            }
          >
            <Plus /> Add
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={!doc}
            onClick={() => setBalancesOpen(true)}
          >
            <Wallet /> Update balances
          </Button>
          <Button
            size="sm"
            variant="primary"
            disabled={!doc}
            onClick={() => doc && run(actions.recordNow(snapshotFromFinances(doc, todayIso())))}
          >
            <Camera /> Record from current finances
          </Button>
        </>
      }
    >
      {actionError ? <ErrorState error={actionError} title="Could not save" /> : null}
      {snaps.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Camera className="size-5" />}
            title="No snapshots yet"
            action={
              <Button
                variant="primary"
                size="sm"
                disabled={!doc}
                onClick={() => doc && run(actions.recordNow(snapshotFromFinances(doc, todayIso())))}
              >
                Record today's net worth
              </Button>
            }
          >
            Record your net worth regularly (or import a CSV) to see how reality tracks against your
            plan.
          </EmptyState>
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-x-4 sm:gap-x-6 gap-y-4 rounded-[var(--radius-card)] border border-border bg-surface px-5 py-4 shadow-card md:grid-cols-4">
            <Stat
              label="Latest net worth"
              value={latest ? f.money(conv(latest.date, latest.netWorth), true) : "—"}
              sub={latest ? formatDay(latest.date, f.locale) : undefined}
            />
            <Stat
              label={`Change (${RANGES.find((r) => r.id === range)?.label})`}
              value={formatSigned(change, (v) => f.money(v, true), f.money(0))}
              tone={change >= 0 ? "positive" : "negative"}
              sub={first ? `since ${formatDay(first.date, f.locale)}` : undefined}
            />
            <Stat
              label="Snapshots"
              value={snaps.length}
              sub={`${formatDay(snaps[0]!.date, f.locale)} → ${formatDay(latest!.date, f.locale)}`}
            />
            <Stat
              label="Values in"
              value={basis === "real" ? "Today's" : "Actual"}
              sub={basis === "real" ? "Deflated with plan inflation" : "As recorded"}
            />
          </div>
          {drifted.length ? (
            <div className="flex flex-col gap-1 text-[12.5px] text-ink-2" role="note">
              {drifted.slice(0, 2).map((d) => (
                <p key={d.snap.id}>
                  {driftSentence(formatDay(d.snap.date, f.locale), d.drift, (n) => f.money(n))}
                </p>
              ))}
              {drifted.length > 2 ? (
                <p>And {drifted.length - 2} other dates with the same kind of gap.</p>
              ) : null}
              <p>Re-valuing a stored snapshot is not done automatically.</p>
            </div>
          ) : null}
          <Card>
            <CardHeader
              eyebrow="History"
              title={
                view === "netWorth"
                  ? "Net worth vs plan"
                  : view === "assetsLiabilities"
                    ? "Assets and liabilities"
                    : "Account balance"
              }
              actions={
                <Segmented
                  aria-label="Range"
                  size="sm"
                  value={range}
                  onChange={setRange}
                  options={RANGES.map((r) => ({ value: r.id, label: r.label }))}
                />
              }
            />
            <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2">
              <Segmented
                aria-label="Series"
                size="sm"
                value={view}
                onChange={setView}
                options={[
                  { value: "netWorth", label: "Net worth" },
                  { value: "assetsLiabilities", label: "Assets & debts" },
                  ...(accountIds.length
                    ? [{ value: "account" as const, label: "Per account" }]
                    : []),
                ]}
              />
              {view === "netWorth" && doc ? (
                <Select
                  aria-label="Overlay plan"
                  value={overlayId}
                  onValueChange={setOverlayPlan}
                  options={doc.plans.map((p) => ({
                    value: p.id,
                    label: `Projected: ${p.name}${p.startingConditions.kind === "snapshot" ? " (fixed date)" : ""}`,
                  }))}
                  className="w-[230px]"
                />
              ) : null}
              {view === "account" ? (
                <Select
                  aria-label="Account"
                  value={acct}
                  onValueChange={setAccount}
                  options={accountIds.map((id) => ({
                    value: id,
                    label: index.accounts.get(id)?.name ?? id,
                  }))}
                  className="w-[220px]"
                />
              ) : null}
            </div>
            <CardBody>
              <Chart
                build={build}
                height={320}
                ariaLabel="Recorded net worth history with the projected plan overlaid. The snapshot table below lists the same values."
              />
              {view === "netWorth" &&
              proj &&
              doc?.plans.find((p) => p.id === overlayId)?.startingConditions.kind !== "snapshot" ? (
                <p className="mt-1 text-[11.5px] text-ink-3">
                  Tip: a fixed-date plan keeps its starting point frozen, so actuals can be compared
                  with what was expected at the time.
                </p>
              ) : null}
            </CardBody>
          </Card>
        </>
      )}

      {shown.length ? (
        <AccountHistory
          snaps={shown}
          index={index}
          locale={f.locale}
          currency={f.currency}
          conv={conv}
        />
      ) : null}

      <Card>
        <CardHeader
          eyebrow="Snapshots"
          title="Recorded values"
          actions={
            <>
              <Button
                size="sm"
                variant="secondary"
                disabled={!doc}
                onClick={() => setImportOpen(true)}
              >
                <Upload /> Import history
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={!doc}
                onClick={() => setExportOpen(true)}
              >
                <Download /> Export
              </Button>
            </>
          }
        />
        <div className="max-h-[420px] overflow-y-auto">
          <Table>
            <THead>
              <TR>
                <TH>Date</TH>
                <TH numeric>Net worth</TH>
                <TH numeric>Assets</TH>
                <TH numeric>Liabilities</TH>
                <TH numeric>Change</TH>
                <TH>Source</TH>
                <TH>Note</TH>
                <TH className="w-[72px]">
                  <span className="sr-only">Actions</span>
                </TH>
              </TR>
            </THead>
            <TBody>
              {[...snaps].reverse().map((s, i, arr) => {
                const prev = arr[i + 1];
                const d = prev ? s.netWorth - prev.netWorth : null;
                const drift = doc ? storedTotalDrift(doc, s) : null;
                return (
                  <TR key={s.id}>
                    <TD className="num whitespace-nowrap">{formatDay(s.date, f.locale)}</TD>
                    <TD numeric className="font-medium">
                      <div>{f.money(s.netWorth)}</div>
                      {drift ? (
                        <div className="text-[11px] font-normal text-ochre">
                          <span className="sr-only">
                            {driftSentence(formatDay(s.date, f.locale), drift, (n) => f.money(n))}
                          </span>
                          <span aria-hidden>Not at today’s rates</span>
                        </div>
                      ) : null}
                    </TD>
                    <TD numeric>{f.money(s.assets)}</TD>
                    <TD numeric>{f.money(s.liabilities)}</TD>
                    <TD
                      numeric
                      className={
                        d === null ? "text-ink-3" : d >= 0 ? "text-positive" : "text-negative"
                      }
                    >
                      {d === null ? "—" : formatSigned(d, (v) => f.money(v), "—")}
                    </TD>
                    <TD className="text-ink-2">{s.source}</TD>
                    <TD className="max-w-[220px] truncate text-ink-2">{s.note}</TD>
                    <TD>
                      <div className="flex gap-0.5">
                        <Button
                          size="icon"
                          variant="ghost"
                          aria-label={`Edit snapshot ${s.date}`}
                          onClick={() => setEditing({ draft: { ...s }, id: s.id })}
                        >
                          <Pencil />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          aria-label={`Delete snapshot ${s.date}`}
                          onClick={async () => {
                            const ok = await confirmAction({
                              title: `Delete the snapshot from ${formatDay(s.date, f.locale)}?`,
                              description: "It is removed from your history for good.",
                              confirmLabel: "Delete snapshot",
                            });
                            if (ok) run(actions.remove(s.id));
                          }}
                        >
                          <Trash2 />
                        </Button>
                      </div>
                    </TD>
                  </TR>
                );
              })}
            </TBody>
          </Table>
        </div>
        <div className="border-t border-border px-4 py-2 text-[11.5px] text-ink-3">
          Import history from a spreadsheet: a date column and one column per account (or net worth
          totals). A blank cell means no value; 0 is a zero balance.
          {workspace?.source === "api" ? " Saved to your Glideworth server." : ""}
        </div>
      </Card>
      {doc && balancesOpen ? (
        <UpdateBalancesSheet
          open={balancesOpen}
          onOpenChange={setBalancesOpen}
          doc={doc}
          onSubmit={(u) => actions.updateBalances(doc, u)}
        />
      ) : null}
      {doc && importOpen ? (
        <HistoryImportDialog
          open={importOpen}
          onOpenChange={setImportOpen}
          doc={doc}
          onImport={actions.importHistory}
        />
      ) : null}
      {doc && exportOpen ? (
        <HistoryExportDialog open={exportOpen} onOpenChange={setExportOpen} doc={doc} />
      ) : null}
      {editing ? (
        <SnapshotDialog
          open={!!editing}
          onOpenChange={(o) => !o && setEditing(null)}
          initial={{ ...editing.draft, ...(editing.id ? { id: editing.id } : {}) }}
          onSave={(d) => actions.save(d, editing.id)}
        />
      ) : null}
    </Page>
  );
}
