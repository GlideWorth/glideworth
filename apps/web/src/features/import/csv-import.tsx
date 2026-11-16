/**
 * CSV imports: account balances, net-worth history, and bank/budget transactions summarised into
 * yearly expenses. Column mapping with presets, locale/number-format detection, and a dry-run
 * preview of exactly what would change, all computed in this browser before anything is saved.
 */
import type { ExpenseEvent, GlideworthDocument } from "@glideworth/core";
import {
  type CsvImportOutcome,
  type CsvKind,
  type CsvOptions,
  type Field,
  importCsvInto,
  PRESETS,
  type TransactionOptions,
} from "@glideworth/importers";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ArrowRight, CircleAlert, FileSpreadsheet, Loader2, RotateCcw, Wand2 } from "lucide-react";
import { type ReactNode, useDeferredValue, useMemo, useState } from "react";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardBody, CardHeader } from "../../components/ui/card";
import { ScrollRegion } from "../../components/ui/table";
import { Field as FormField } from "../../components/ui/input";
import { Segmented } from "../../components/ui/segmented";
import { Select } from "../../components/ui/select";
import { SwitchField } from "../../components/ui/switch";
import { toast } from "../../components/ui/toaster";
import { api } from "../../lib/api";
import { cn } from "../../lib/cn";
import { formatMoney, plural } from "../../lib/format";
import { useActivePlan, useFormat, useWorkspace } from "../../lib/workspace";
import { FileDrop, formatBytes, type PickedFile } from "./file-drop";
import { CATEGORY_META } from "./import-model";

const KINDS: { value: CsvKind; label: string; description: string }[] = [
  {
    value: "account-balances",
    label: "Account balances",
    description:
      "One row per account with its balance (e.g. a monthly statement export). Updates Current finances.",
  },
  {
    value: "progress-snapshots",
    label: "Net-worth history",
    description: "Dated net-worth totals, optionally split by category. Backfills Progress.",
  },
  {
    value: "transactions",
    label: "Transactions → spending",
    description:
      "A bank or budgeting-app export. Summarised into yearly spending by category and added to a plan.",
  },
];

const FIELDS: Record<CsvKind, { field: Field; label: string; required?: boolean }[]> = {
  "account-balances": [
    { field: "account", label: "Account name", required: true },
    { field: "balance", label: "Balance", required: true },
    { field: "accountType", label: "Account type" },
    { field: "date", label: "Date" },
  ],
  "progress-snapshots": [
    { field: "date", label: "Date", required: true },
    { field: "netWorth", label: "Net worth", required: true },
    { field: "assets", label: "Assets" },
    { field: "liabilities", label: "Liabilities" },
    { field: "cash", label: "Cash" },
    { field: "taxable", label: "Taxable" },
    { field: "taxDeferred", label: "Tax-deferred" },
    { field: "taxFree", label: "Tax-free" },
    { field: "crypto", label: "Crypto" },
    { field: "debt", label: "Debt" },
    { field: "loans", label: "Loans" },
  ],
  transactions: [
    { field: "date", label: "Date", required: true },
    { field: "amount", label: "Amount (signed)" },
    { field: "debit", label: "Money out" },
    { field: "credit", label: "Money in" },
    { field: "category", label: "Category" },
    { field: "description", label: "Description" },
    { field: "account", label: "Account" },
    { field: "type", label: "Type" },
  ],
};

const NONE = "__none__";
const AUTO = "auto";

export function CsvImport({ initialKind = "account-balances" }: { initialKind?: CsvKind }) {
  const [kind, setKind] = useState<CsvKind>(initialKind);
  const [file, setFile] = useState<PickedFile | null>(null);
  return (
    <div className="flex flex-col gap-5">
      <fieldset>
        <legend className="mb-2 text-[13px] font-semibold text-ink">What is in the file?</legend>
        <div className="grid gap-2 md:grid-cols-3">
          {KINDS.map((k) => (
            <label
              key={k.value}
              className={cn(
                "flex cursor-pointer flex-col gap-1 rounded-xl border bg-surface p-3.5 transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-focus/30",
                kind === k.value
                  ? "border-accent ring-1 ring-accent"
                  : "border-border hover:border-border-strong",
              )}
            >
              <input
                type="radio"
                name="csv-kind"
                className="sr-only"
                checked={kind === k.value}
                onChange={() => {
                  setKind(k.value);
                }}
              />
              <span className="text-[13.5px] font-semibold text-ink">{k.label}</span>
              <span className="text-[12px] leading-relaxed text-ink-2">{k.description}</span>
            </label>
          ))}
        </div>
      </fieldset>
      {file ? (
        <CsvWorkbench
          key={`${kind}:${file.name}`}
          kind={kind}
          file={file}
          onReset={() => setFile(null)}
        />
      ) : (
        <FileDrop
          accept=".csv,.tsv,.txt,text/csv"
          title="Choose a CSV file"
          hint="Comma, semicolon or tab separated. Read in this browser; nothing is saved until you apply it."
          onFile={setFile}
        />
      )}
    </div>
  );
}

function CsvWorkbench({
  kind,
  file,
  onReset,
}: {
  kind: CsvKind;
  file: PickedFile;
  onReset: () => void;
}) {
  const { data: ws } = useWorkspace();
  const { plan } = useActivePlan();
  const f = useFormat();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const doc = ws?.doc;
  const [preset, setPreset] = useState<string>(AUTO);
  const [locale, setLocale] = useState<"auto" | "en-GB" | "en-US">("auto");
  const [decimal, setDecimal] = useState<"auto" | "." | ",">("auto");
  const [dateFormat, setDateFormat] = useState<"auto" | "YYYY-MM-DD" | "DD/MM/YYYY" | "MM/DD/YYYY">(
    "auto",
  );
  const [columns, setColumns] = useState<Partial<Record<Field, string>>>({});
  const [createMissing, setCreateMissing] = useState(true);
  const [accountMap, setAccountMap] = useState<Record<string, string>>({});
  const [planId, setPlanId] = useState<string | undefined>(plan?.id);
  const [annualise, setAnnualise] =
    useState<NonNullable<TransactionOptions["annualise"]>>("last-12-months");
  const [excluded, setExcluded] = useState<string[]>([]);
  const [progressMode, setProgressMode] = useState<"merge" | "replace">("merge");
  const [busy, setBusy] = useState(false);

  const options: CsvOptions = {
    preset,
    locale,
    ...(decimal !== "auto" ? { decimalSeparator: decimal } : {}),
    dateFormat,
    columns: Object.fromEntries(Object.entries(columns).filter(([, v]) => v && v !== NONE)),
    defaultDate: new Date().toISOString().slice(0, 10),
  };
  const deferred = useDeferredValue(
    JSON.stringify([options, createMissing, accountMap, planId, annualise, excluded, progressMode]),
  );
  const outcome = useMemo((): { o?: CsvImportOutcome; error?: string } => {
    if (!doc) return {};
    // Inputs travel through one serialised, deferred value so typing never blocks the preview.
    const [options, createMissing, accountMap, planId, annualise, excluded, progressMode] =
      JSON.parse(deferred) as [
        CsvOptions,
        boolean,
        Record<string, string>,
        string | undefined,
        NonNullable<TransactionOptions["annualise"]>,
        string[],
        "merge" | "replace",
      ];
    try {
      const o =
        kind === "account-balances"
          ? importCsvInto(
              doc,
              file.text,
              { kind, options: { ...options, createMissing, accountMap } },
              { dryRun: false },
            )
          : kind === "progress-snapshots"
            ? importCsvInto(
                doc,
                file.text,
                { kind, options: { ...options, mode: progressMode } },
                { dryRun: false },
              )
            : importCsvInto(
                doc,
                file.text,
                {
                  kind,
                  planId: planId ?? doc.plans[0]?.id ?? "",
                  options: { ...options, annualise, excludeCategories: excluded },
                },
                { dryRun: !planId && !doc.plans[0] },
              );
      return { o };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }, [doc, file.text, kind, deferred]);
  const o = outcome.o;
  const a = o?.analysis;
  const blocking = (o?.issues ?? []).filter((i) => i.severity === "error");
  const canApply =
    !!o && !!a && a.missing.length === 0 && blocking.length === 0 && ws?.source === "api";

  const apply = async () => {
    if (!o || !doc || !ws) return;
    setBusy(true);
    try {
      const hh = doc.household.id;
      let summary = "";
      if (kind === "account-balances" && o.reconciliation) {
        const rec = o.reconciliation;
        const next = o.document;
        for (const c of rec.created) {
          const item =
            c.entity === "debt"
              ? next.finances.debts.find((d) => d.id === c.id)
              : next.finances.accounts.find((x) => x.id === c.id);
          if (item)
            await api.createFinanceItem(hh, c.entity === "debt" ? "debts" : "accounts", item);
        }
        await api.updateBalances(hh, {
          ...(rec.asOf && rec.asOf > doc.finances.asOf ? { asOf: rec.asOf } : {}),
          accounts: rec.matched
            .filter((m) => m.entity === "account")
            .map((m) => ({ accountId: m.id, balance: m.after })),
          debts: rec.matched
            .filter((m) => m.entity === "debt")
            .map((m) => ({ debtId: m.id, balance: m.after })),
        });
        summary = `${rec.matched.length} ${rec.matched.length === 1 ? "balance" : "balances"} updated${rec.created.length ? `, ${rec.created.length} ${rec.created.length === 1 ? "account" : "accounts"} added` : ""}`;
      } else if (kind === "progress-snapshots" && o.snapshots) {
        await api.importSnapshots(
          hh,
          o.snapshots.map(({ householdId: _h, id: _i, ...s }) => s) as never,
          progressMode === "replace" ? "replace" : "skip",
        );
        summary = `${plural(o.snapshots.length, "snapshot")} added to Progress`;
      } else if (kind === "transactions" && o.summary) {
        const pid = planId ?? doc.plans[0]?.id;
        const target = o.document.plans.find((p) => p.id === pid);
        const before = new Set(doc.plans.find((p) => p.id === pid)?.expenses.map((e) => e.id));
        const added = (target?.expenses ?? []).filter((e) => !before.has(e.id));
        for (const e of added) await api.addPlanItem(pid!, "expenses", e satisfies ExpenseEvent);
        summary = `${added.length} yearly expenses added to “${target?.name ?? "the plan"}”`;
      }
      await qc.invalidateQueries({ queryKey: ["workspace"] });
      await qc.invalidateQueries({ queryKey: ["snapshots"] });
      toast({
        title: "CSV imported",
        description: summary,
        tone: "positive",
        action: {
          label: "View",
          onClick: () =>
            void navigate({
              to:
                kind === "progress-snapshots"
                  ? "/progress"
                  : kind === "transactions"
                    ? `/plans/${planId}`
                    : "/finances",
            }),
        },
      });
      onReset();
    } catch (e) {
      toast({
        title: "Import failed",
        description: e instanceof Error ? e.message : String(e),
        tone: "negative",
      });
    } finally {
      setBusy(false);
    }
  };

  const presets = PRESETS.filter((p) => p.kind === kind).sort(
    (x, y) => Number(!!x.generic) - Number(!!y.generic),
  );
  const fields = FIELDS[kind];
  const headerOptions = [
    { value: NONE, label: "— Not in file —" },
    ...(a?.headers ?? []).map((h) => ({ value: h, label: h })),
  ];
  const roleOf = (h: string) => fields.find((x) => a?.columns[x.field] === h)?.label;

  return (
    <div className="flex flex-col gap-5">
      <Card>
        <CardHeader
          eyebrow="1 · Columns"
          title={
            <span className="flex items-center gap-2">
              <FileSpreadsheet className="size-4 text-ink-3" /> {file.name}
              <span className="text-[12px] font-normal text-ink-3">
                {formatBytes(file.size, f.locale)} · {a?.rowCount ?? 0} rows
              </span>
            </span>
          }
          actions={
            <Button size="sm" variant="ghost" onClick={onReset}>
              <RotateCcw /> Another file
            </Button>
          }
        />
        <CardBody className="flex flex-col gap-4">
          {outcome.error ? <ErrorNote>{outcome.error}</ErrorNote> : null}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <FormField
              label="Preset"
              hint={
                a?.preset
                  ? `Detected: ${a.preset.name}${PRESETS.find((x) => x.id === a.preset?.id)?.generic ? " (a common layout, not a specific app)" : ""}`
                  : "No preset matched the headers."
              }
            >
              {(id) => (
                <Select
                  id={id}
                  value={preset}
                  onValueChange={setPreset}
                  options={[
                    { value: AUTO, label: "Detect automatically" },
                    { value: "none", label: "No preset" },
                    ...presets.map((p) => ({
                      value: p.id,
                      label: p.name,
                      group: p.generic ? "Common layouts" : "App exports",
                    })),
                  ]}
                />
              )}
            </FormField>
            <FormField
              label="Number format"
              hint={
                a
                  ? `Reading ${a.decimalSeparator === "," ? "1.234,56 (decimal comma)" : "1,234.56 (decimal point)"}`
                  : undefined
              }
            >
              {(id) => (
                <Select
                  id={id}
                  value={decimal}
                  onValueChange={setDecimal}
                  options={[
                    { value: "auto", label: "Detect" },
                    { value: ".", label: "1,234.56" },
                    { value: ",", label: "1.234,56" },
                  ]}
                />
              )}
            </FormField>
            <FormField
              label="Dates"
              hint={
                a
                  ? a.ambiguousDates
                    ? `Ambiguous: read as ${a.dateFormat}`
                    : `Reading ${a.dateFormat}`
                  : undefined
              }
            >
              {(id) => (
                <Select
                  id={id}
                  value={dateFormat}
                  onValueChange={setDateFormat}
                  options={[
                    { value: "auto", label: "Detect" },
                    { value: "YYYY-MM-DD", label: "2026-03-31" },
                    { value: "DD/MM/YYYY", label: "31/03/2026 (day first)" },
                    { value: "MM/DD/YYYY", label: "03/31/2026 (month first)" },
                  ]}
                />
              )}
            </FormField>
            <FormField label="Locale fallback" hint="Used when the data alone cannot tell.">
              {(id) => (
                <Select
                  id={id}
                  value={locale}
                  onValueChange={setLocale}
                  options={[
                    { value: "auto", label: "Detect" },
                    { value: "en-GB", label: "UK style" },
                    { value: "en-US", label: "US style" },
                  ]}
                />
              )}
            </FormField>
          </div>
          <div>
            <div className="mb-2 flex items-center gap-2 text-[12.5px] font-semibold text-ink">
              <Wand2 className="size-3.5 text-accent" /> Column mapping
              <span className="font-normal text-ink-3">
                Detected automatically; change anything that is wrong.
              </span>
            </div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {fields.map((x) => (
                <FormField
                  key={x.field}
                  label={`${x.label}${x.required ? " *" : ""}`}
                  error={a?.missing.includes(x.field) ? "Required: choose a column" : undefined}
                  hint={
                    a?.columns[x.field] && (a.confidence[x.field] ?? 1) < 0.9
                      ? "Guessed from the values"
                      : undefined
                  }
                >
                  {(id) => (
                    <Select
                      id={id}
                      value={columns[x.field] ?? a?.columns[x.field] ?? NONE}
                      onValueChange={(v) => setColumns((c) => ({ ...c, [x.field]: v }))}
                      options={headerOptions}
                    />
                  )}
                </FormField>
              ))}
            </div>
          </div>
          {a?.sample.length ? (
            <ScrollRegion
              label="Table, scrolls sideways if it does not fit"
              className="rounded-lg border border-border"
            >
              <table className="w-full border-collapse text-[12px]">
                <caption className="sr-only">
                  First rows of the file and the role of each column
                </caption>
                <thead>
                  <tr className="border-b border-border bg-surface-2/60">
                    {a.headers.map((h) => (
                      <th
                        key={h}
                        scope="col"
                        className="px-2.5 py-1.5 text-left align-bottom font-medium text-ink-2"
                      >
                        <div className="whitespace-nowrap">{h}</div>
                        {roleOf(h) ? (
                          <Badge tone="accent" className="mt-0.5">
                            {roleOf(h)}
                          </Badge>
                        ) : (
                          <span className="text-[10.5px] text-ink-3">ignored</span>
                        )}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {a.sample.map((r, i) => (
                    // oxlint-disable-next-line react/no-array-index-key -- preview rows
                    <tr key={i} className="border-b border-border/70 last:border-b-0">
                      {a.headers.map((h, j) => (
                        <td
                          key={h}
                          className={cn(
                            "num px-2.5 py-1 whitespace-nowrap",
                            roleOf(h) ? "text-ink" : "text-ink-3",
                          )}
                        >
                          {r[j]}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </ScrollRegion>
          ) : null}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          eyebrow="2 · Dry run"
          title="What would change"
          actions={<Badge>Nothing saved yet</Badge>}
        />
        <CardBody className="flex flex-col gap-4">
          {kind === "transactions" && doc ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <FormField label="Add the yearly expenses to">
                {(id) => (
                  <Select
                    id={id}
                    value={planId}
                    onValueChange={setPlanId}
                    placeholder="Choose a plan"
                    options={doc.plans.map((p) => ({ value: p.id, label: p.name }))}
                  />
                )}
              </FormField>
              <FormField label="Yearly figure from">
                {(id) => (
                  <Select
                    id={id}
                    value={annualise}
                    onValueChange={setAnnualise}
                    options={[
                      { value: "last-12-months", label: "The last 12 months" },
                      { value: "latest-full-year", label: "The latest full calendar year" },
                      { value: "all", label: "An average over all the data" },
                    ]}
                  />
                )}
              </FormField>
            </div>
          ) : null}
          {kind === "account-balances" ? (
            <SwitchField
              label="Add accounts that do not exist yet"
              hint="Otherwise unmatched rows are skipped (or map them to an account below)."
              checked={createMissing}
              onCheckedChange={setCreateMissing}
            />
          ) : null}
          {kind === "progress-snapshots" ? (
            <Segmented
              aria-label="Existing snapshots on the same date"
              value={progressMode}
              onChange={setProgressMode}
              options={[
                { value: "merge", label: "Keep my existing snapshots" },
                { value: "replace", label: "Overwrite same-date snapshots" },
              ]}
            />
          ) : null}
          {o && doc ? (
            <Preview
              o={o}
              doc={doc}
              locale={f.locale}
              currency={f.currency}
              accountMap={accountMap}
              setAccountMap={setAccountMap}
              excluded={excluded}
              setExcluded={setExcluded}
            />
          ) : null}
          {(o?.issues ?? []).length ? <CsvIssues issues={o!.issues} /> : null}
          {ws?.source !== "api" ? (
            <p className="rounded-md bg-ochre-soft px-3 py-2 text-[12.5px] text-ochre">
              The Glideworth server is not reachable, so this preview cannot be applied right now.
            </p>
          ) : null}
        </CardBody>
      </Card>
      <div className="flex items-center gap-2">
        <Button variant="ghost" onClick={onReset} disabled={busy}>
          Cancel
        </Button>
        <Button
          variant="primary"
          size="lg"
          className="ml-auto"
          disabled={!canApply || busy}
          onClick={() => void apply()}
        >
          {busy ? <Loader2 className="animate-spin" /> : null}
          Apply import <ArrowRight />
        </Button>
      </div>
    </div>
  );
}

function ErrorNote({ children }: { children: ReactNode }) {
  return (
    <p
      role="alert"
      className="flex items-start gap-2 rounded-lg bg-negative-soft px-3 py-2 text-[12.5px] text-negative"
    >
      <CircleAlert className="mt-0.5 size-4 shrink-0" /> <span>{children}</span>
    </p>
  );
}

function Preview({
  o,
  doc,
  locale,
  currency,
  accountMap,
  setAccountMap,
  excluded,
  setExcluded,
}: {
  o: CsvImportOutcome;
  doc: GlideworthDocument;
  locale: string;
  currency: string;
  accountMap: Record<string, string>;
  setAccountMap: (m: Record<string, string>) => void;
  excluded: string[];
  setExcluded: (c: string[]) => void;
}) {
  const money = (v: number) => formatMoney(v, { locale, currency });
  const nf = new Intl.NumberFormat(locale);
  if (o.analysis.missing.length)
    return (
      <p className="text-[12.5px] text-ink-2">Map the required columns above to see the preview.</p>
    );
  if (o.reconciliation) {
    const r = o.reconciliation;
    const all = [...doc.finances.accounts, ...doc.finances.debts];
    return (
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap gap-x-6 gap-y-1 text-[12.5px] text-ink-2">
          <span>
            <strong className="num text-ink">{nf.format(r.matched.length)}</strong> matched
          </span>
          <span>
            <strong className="num text-ink">{nf.format(r.created.length)}</strong> new
          </span>
          <span>
            <strong className="num text-ink">{nf.format(r.unmatched.length)}</strong> skipped
          </span>
          {r.superseded.length ? (
            <span>{nf.format(r.superseded.length)} older rows ignored (newest wins)</span>
          ) : null}
          <span className="ml-auto">
            Net of these accounts: <span className="num">{money(r.totals.before)}</span> →{" "}
            <strong className="num text-ink">{money(r.totals.after)}</strong>
          </span>
        </div>
        <ScrollRegion
          label="Table, scrolls sideways if it does not fit"
          className="rounded-lg border border-border"
        >
          <table className="w-full border-collapse text-[12.5px]">
            <thead>
              <tr className="border-b border-border text-left text-[11px] tracking-wider text-ink-3 uppercase">
                <th scope="col" className="px-3 py-1.5 font-semibold">
                  Row
                </th>
                <th scope="col" className="px-3 py-1.5 font-semibold">
                  Glideworth account
                </th>
                <th scope="col" className="px-3 py-1.5 text-right font-semibold">
                  Before
                </th>
                <th scope="col" className="px-3 py-1.5 text-right font-semibold">
                  After
                </th>
              </tr>
            </thead>
            <tbody>
              {r.matched.map((m) => (
                <tr key={m.id} className="border-b border-border/70">
                  <td className="px-3 py-1.5 text-ink-2">{m.row.name}</td>
                  <td className="px-3 py-1.5">{m.name}</td>
                  <td className="num px-3 py-1.5 text-right text-ink-3">{money(m.before)}</td>
                  <td className="num px-3 py-1.5 text-right">
                    {money(m.after)}{" "}
                    <span
                      className={cn(
                        "text-[11px]",
                        m.delta >= 0 ? "text-positive" : "text-negative",
                      )}
                    >
                      {m.delta >= 0 ? "+" : "−"}
                      {money(Math.abs(m.delta))}
                    </span>
                  </td>
                </tr>
              ))}
              {r.created.map((c) => (
                <tr key={c.id} className="border-b border-border/70">
                  <td className="px-3 py-1.5 text-ink-2">{c.row.name}</td>
                  <td className="px-3 py-1.5">
                    <Badge tone="accent">New</Badge> {c.entity === "debt" ? "debt" : c.type}
                  </td>
                  <td className="num px-3 py-1.5 text-right text-ink-3">—</td>
                  <td className="num px-3 py-1.5 text-right">{money(c.row.balance)}</td>
                </tr>
              ))}
              {r.unmatched.map((u) => (
                <tr key={u.line} className="border-b border-border/70 last:border-b-0">
                  <td className="px-3 py-1.5 text-ink-2">{u.name}</td>
                  <td className="px-3 py-1" colSpan={3}>
                    <Select
                      aria-label={`Map “${u.name}” to an account`}
                      value={accountMap[u.name]}
                      placeholder="Skip this row, or map it to…"
                      onValueChange={(v) => setAccountMap({ ...accountMap, [u.name]: v })}
                      options={all.map((x) => ({ value: x.id, label: x.name }))}
                      className="max-w-[320px]"
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollRegion>
      </div>
    );
  }
  if (o.snapshots) {
    const s = o.snapshots;
    return (
      <div className="flex flex-col gap-2 text-[12.5px] text-ink-2">
        <p>
          <strong className="num text-ink">{nf.format(s.length)}</strong>{" "}
          {s.length === 1 ? "snapshot" : "snapshots"}
          {s.length ? (
            <>
              {" "}
              from <span className="num">{s[0]!.date}</span> to{" "}
              <span className="num">{s.at(-1)!.date}</span>, net worth{" "}
              <span className="num">{money(s[0]!.netWorth)}</span> →{" "}
              <strong className="num text-ink">{money(s.at(-1)!.netWorth)}</strong>
            </>
          ) : null}
          .
        </p>
        <MiniSpark values={s.map((x) => x.netWorth)} />
      </div>
    );
  }
  if (o.summary) {
    const sm = o.summary;
    return (
      <div className="flex flex-col gap-3">
        <p className="text-[12.5px] text-ink-2">
          {nf.format(sm.transactions)} transactions
          {sm.range ? (
            <>
              {" "}
              from <span className="num">{sm.range.from}</span> to{" "}
              <span className="num">{sm.range.to}</span>
            </>
          ) : null}{" "}
          → <strong className="num text-ink">{money(sm.totalAnnual)}</strong> a year across{" "}
          {sm.categories.length} categories. Untick a category to leave it out.
        </p>
        <ScrollRegion
          label="Table, scrolls sideways if it does not fit"
          className="rounded-lg border border-border"
        >
          <table className="w-full border-collapse text-[12.5px]">
            <thead>
              <tr className="border-b border-border text-left text-[11px] tracking-wider text-ink-3 uppercase">
                <th scope="col" className="w-8 px-3 py-1.5">
                  <span className="sr-only">Include</span>
                </th>
                <th scope="col" className="px-3 py-1.5 font-semibold">
                  Category
                </th>
                <th scope="col" className="px-3 py-1.5 font-semibold">
                  Becomes
                </th>
                <th scope="col" className="px-3 py-1.5 text-right font-semibold">
                  Transactions
                </th>
                <th scope="col" className="px-3 py-1.5 text-right font-semibold">
                  Per year
                </th>
              </tr>
            </thead>
            <tbody>
              {[
                ...sm.categories,
                ...excluded.map((c) => ({ category: c, excludedByUser: true }) as const),
              ].map((c) =>
                "excludedByUser" in c ? (
                  <tr key={`x-${c.category}`} className="border-b border-border/70 text-ink-3">
                    <td className="px-3 py-1.5">
                      <input
                        type="checkbox"
                        checked={false}
                        aria-label={`Include ${c.category}`}
                        onChange={() => setExcluded(excluded.filter((e) => e !== c.category))}
                      />
                    </td>
                    <td className="px-3 py-1.5 line-through">{c.category}</td>
                    <td className="px-3 py-1.5" colSpan={3}>
                      left out
                    </td>
                  </tr>
                ) : (
                  <tr key={c.category} className="border-b border-border/70">
                    <td className="px-3 py-1.5">
                      <input
                        type="checkbox"
                        checked
                        aria-label={`Include ${c.category}`}
                        onChange={() => setExcluded([...excluded, c.category])}
                      />
                    </td>
                    <td className="px-3 py-1.5">{c.category}</td>
                    <td className="px-3 py-1.5 text-ink-2">
                      {c.expenseType} · {c.spendingType}
                    </td>
                    <td className="num px-3 py-1.5 text-right text-ink-3">{nf.format(c.count)}</td>
                    <td className="num px-3 py-1.5 text-right font-medium">{money(c.annual)}</td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        </ScrollRegion>
        {sm.excluded.length ? (
          <p className="text-[12px] text-ink-3">
            Not counted as spending:{" "}
            {sm.excluded.map((e) => `${e.category} (${nf.format(e.count)})`).join(", ")}.
          </p>
        ) : null}
      </div>
    );
  }
  return null;
}

function MiniSpark({ values }: { values: number[] }) {
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const w = 320;
  const h = 48;
  const pts = values.map(
    (v, i) =>
      `${(i / (values.length - 1)) * w},${h - ((v - min) / (max - min || 1)) * (h - 4) - 2}`,
  );
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      className="h-12 w-full max-w-[320px] text-accent"
      role="img"
      aria-label="Net worth over the imported history"
    >
      <polyline
        points={pts.join(" ")}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

function CsvIssues({ issues }: { issues: CsvImportOutcome["issues"] }) {
  const [open, setOpen] = useState(false);
  const shown = open ? issues : issues.slice(0, 5);
  return (
    <div className="rounded-lg border border-border">
      <div className="flex items-center justify-between border-b border-border px-3 py-2 text-[12.5px] font-semibold">
        Notes from the reader <Badge>{issues.length}</Badge>
      </div>
      <ul className="divide-y divide-border">
        {shown.map((i, idx) => (
          // oxlint-disable-next-line react/no-array-index-key -- issues have no id
          <li key={idx} className="flex gap-2 px-3 py-1.5 text-[12.5px]">
            <span
              className={cn(
                "mt-1.5 size-1.5 shrink-0 rounded-full",
                i.severity === "error"
                  ? "bg-negative"
                  : i.severity === "warning"
                    ? "bg-ochre"
                    : "bg-ink-3",
              )}
              role="img"
              aria-label={i.severity}
            />
            <span className="text-ink-2">
              <span className="font-mono text-[11.5px] text-ink-3">
                {i.sourcePath.replace("csv:row:", "row ")}
              </span>{" "}
              {i.message}
              {i.category ? (
                <span className="text-ink-3"> · {CATEGORY_META[i.category].label}</span>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
      {issues.length > 5 ? (
        <button
          type="button"
          className="w-full px-3 py-1.5 text-left text-[12px] text-accent hover:underline"
          onClick={() => setOpen(!open)}
        >
          {open ? "Show fewer" : `Show all ${issues.length}`}
        </button>
      ) : null}
    </div>
  );
}
