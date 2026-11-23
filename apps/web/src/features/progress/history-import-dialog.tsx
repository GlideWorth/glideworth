/**
 * Balance-history import: paste or drop a sheet -> layout and formats -> map columns -> preview every cell and
 * what Merge or Replace would change -> import. All reading and planning is `@glideworth/importers` (the API
 * runs the same code), so the preview here is what the server will do.
 */
import type { GlideworthDocument } from "@glideworth/core";
import {
  balanceHistoryTemplate,
  type HistoryMode,
  type HistoryPlan,
  type HistoryPreview,
  type HistoryRow,
  type HistoryTarget,
  historyKeyLabel,
  historyTargets,
  matchHistoryColumns,
  planHistoryImport,
  previewHistory,
  readHistorySheet,
} from "@glideworth/importers";
import { AlertTriangle, ArrowLeftRight, Check, CircleAlert, Download, Info } from "lucide-react";
import { useMemo, useState } from "react";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Dialog, DialogContent } from "../../components/ui/dialog";
import { Segmented } from "../../components/ui/segmented";
import { Select, type SelectOption } from "../../components/ui/select";
import { SwitchField } from "../../components/ui/switch";
import { ScrollRegion } from "../../components/ui/table";
import { Textarea } from "../../components/ui/textarea";
import { cn } from "../../lib/cn";
import { formatDay } from "../../lib/format";
import { useFormat } from "../../lib/workspace";
import { FileDrop } from "../import/file-drop";
import { downloadText } from "../results/model";
import { todayIso } from "./progress-model";

export interface HistoryImportRequest {
  rows: HistoryRow[];
  mode: HistoryMode;
  updateCurrent: boolean;
  today: string;
  /** The plan the preview showed (offline workspaces apply it as is). */
  plan: HistoryPlan;
}

export interface HistoryImportOutcome {
  counts: HistoryPlan["counts"];
  currentBalances: boolean;
}

const STEPS = [
  { id: "source", label: "Paste or drop" },
  { id: "format", label: "Layout and format" },
  { id: "map", label: "Map columns" },
  { id: "preview", label: "Preview and import" },
] as const;
type StepId = (typeof STEPS)[number]["id"] | "done";

const SKIP = "__skip";
type Opt = string;

const DATE_FORMATS = [
  { value: "auto", label: "Detect from the dates" },
  { value: "YMD", label: "Year first (2024-01-31)" },
  { value: "MDY", label: "Month first (01/31/2024)" },
  { value: "DMY", label: "Day first (31/01/2024)" },
] as const;

export function HistoryImportDialog({
  open,
  onOpenChange,
  doc,
  onImport,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  doc: GlideworthDocument;
  onImport: (r: HistoryImportRequest) => Promise<HistoryImportOutcome>;
}) {
  const f = useFormat();
  const today = todayIso();
  const targets = useMemo(
    () => historyTargets(doc.finances, doc.household.currency),
    [doc.finances, doc.household.currency],
  );
  const [step, setStep] = useState<StepId>("source");
  const [text, setText] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [delimiter, setDelimiter] = useState<"auto" | "," | ";" | "\t" | "|">("auto");
  const [layout, setLayout] = useState<"auto" | "rows" | "columns" | "long">("auto");
  const [dateFormat, setDateFormat] = useState<"auto" | "YMD" | "MDY" | "DMY">("auto");
  const [decimal, setDecimal] = useState<"auto" | "." | ",">("auto");
  const [periodDay, setPeriodDay] = useState<"end" | "start">("end");
  const [userMapping, setUserMapping] = useState<{ sig: string; keys: (string | null)[] } | null>(
    null,
  );
  const [mode, setMode] = useState<HistoryMode>("merge");
  const [skipInvalid, setSkipInvalid] = useState(false);
  const [updateCurrent, setUpdateCurrent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<HistoryImportOutcome | null>(null);

  const sheet = useMemo(
    () => readHistorySheet(text, { delimiter, layout }),
    [text, delimiter, layout],
  );
  const matches = useMemo(() => matchHistoryColumns(sheet.headers, targets), [sheet, targets]);
  const sig = sheet.headers.join("\u0000");
  const mapping =
    userMapping && userMapping.sig === sig ? userMapping.keys : matches.map((m) => m.key);
  const preview = useMemo(
    () =>
      previewHistory(sheet, mapping, targets, {
        today,
        dateFormat,
        decimalSeparator: decimal,
        periodDay,
      }),
    [sheet, mapping, targets, today, dateFormat, decimal, periodDay],
  );
  const plan = useMemo(
    () =>
      planHistoryImport({
        existing: doc.progress,
        rows: preview.rows,
        mode,
        targets,
        today,
        updateCurrent,
      }),
    [doc.progress, preview.rows, mode, targets, today, updateCurrent],
  );

  const reset = () => {
    setStep("source");
    setText("");
    setFileName(null);
    setDelimiter("auto");
    setLayout("auto");
    setDateFormat("auto");
    setDecimal("auto");
    setPeriodDay("end");
    setUserMapping(null);
    setMode("merge");
    setSkipInvalid(false);
    setUpdateCurrent(false);
    setError(null);
    setOutcome(null);
  };

  const datesUndecided =
    preview.dateFormat.ambiguous || (preview.dateFormat.conflict && dateFormat === "auto");
  const hasToday = preview.rows.some((r) => r.date === today);
  const totalChanges = plan.counts.added + plan.counts.updated + plan.counts.removed;
  const blockers: string[] = [];
  if (preview.blocked)
    blockers.push(
      ...preview.issues.filter((i) => i.severity === "error").map((i) => sentence(i.message)),
    );
  if (plan.issues.some((i) => i.severity === "error"))
    blockers.push(
      ...plan.issues.filter((i) => i.severity === "error").map((i) => sentence(i.message)),
    );
  if (preview.counts.errors > 0 && !skipInvalid)
    blockers.push(
      `${preview.counts.errors} flagged cell${preview.counts.errors === 1 ? "" : "s"}: fix ${preview.counts.errors === 1 ? "it" : "them"} in your sheet, or import the clean cells and skip the flagged ones.`,
    );
  if (mode === "replace" && preview.counts.badDates > 0)
    blockers.push(
      "Replace needs every date to be readable: a row with an unreadable date might hold values Replace would clear. Fix the dates or use Merge.",
    );

  const doImport = async () => {
    setBusy(true);
    setError(null);
    try {
      const out = await onImport({
        rows: preview.rows,
        mode,
        updateCurrent: updateCurrent && hasToday,
        today,
        plan,
      });
      setOutcome(out);
      setStep("done");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const index = STEPS.findIndex((s) => s.id === step);
  const canEnter = (id: StepId): boolean => {
    if (id === "source") return true;
    if (!text.trim() || sheet.records.length === 0) return false;
    if (id === "format") return true;
    if (datesUndecided) return false;
    if (id === "map") return true;
    return mapping.some((k) => k !== null);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
    >
      <DialogContent
        title="Import balance history"
        description="Balances per account over time, from a spreadsheet. Nothing is saved until the last step."
        className="w-[min(96vw,920px)] p-4 sm:p-5"
      >
        {step !== "done" ? (
          <nav aria-label="Import steps" className="mb-4">
            <ol className="flex flex-wrap gap-1.5">
              {STEPS.map((s, i) => {
                const current = s.id === step;
                const reachable = i <= index || (i === index + 1 && canEnter(s.id));
                return (
                  <li key={s.id}>
                    <button
                      type="button"
                      aria-current={current ? "step" : undefined}
                      disabled={!reachable || current}
                      onClick={() => setStep(s.id)}
                      className={cn(
                        "flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] font-medium pointer-coarse:min-h-11",
                        current
                          ? "border-accent bg-accent-soft text-accent"
                          : i < index
                            ? "border-border bg-surface text-ink-2 hover:bg-surface-2"
                            : "border-border bg-surface text-ink-3",
                        "disabled:cursor-default",
                      )}
                    >
                      <span
                        aria-hidden
                        className={cn(
                          "flex size-4 items-center justify-center rounded-full text-[10px]",
                          i < index ? "bg-accent text-accent-ink" : "bg-surface-2",
                        )}
                      >
                        {i < index ? <Check className="size-3" /> : i + 1}
                      </span>
                      {s.label}
                    </button>
                  </li>
                );
              })}
            </ol>
          </nav>
        ) : null}

        {step === "source" ? (
          <SourceStep
            text={text}
            fileName={fileName}
            onText={(t, name) => {
              setText(t);
              setFileName(name);
              setUserMapping(null);
            }}
            onTemplate={(layoutChoice) =>
              downloadText(
                `glideworth-balance-history-template.csv`,
                balanceHistoryTemplate(targets, { layout: layoutChoice }),
              )
            }
          />
        ) : null}

        {step === "format" ? (
          <FormatStep
            sheet={sheet}
            preview={preview}
            delimiter={delimiter}
            setDelimiter={setDelimiter}
            setLayout={(l) => {
              setLayout(l);
              setUserMapping(null);
            }}
            dateFormat={dateFormat}
            setDateFormat={setDateFormat}
            decimal={decimal}
            setDecimal={setDecimal}
            periodDay={periodDay}
            setPeriodDay={setPeriodDay}
            locale={f.locale}
          />
        ) : null}

        {step === "map" ? (
          <MapStep
            headers={sheet.headers}
            records={sheet.records.map((r) => r.cells)}
            matches={matches}
            mapping={mapping}
            targets={targets}
            preview={preview}
            onChange={(i, key) => {
              const next = [...mapping];
              next[i] = key;
              setUserMapping({ sig, keys: next });
            }}
          />
        ) : null}

        {step === "preview" ? (
          <PreviewStep
            preview={preview}
            plan={plan}
            targets={targets}
            headers={sheet.headers}
            mode={mode}
            setMode={setMode}
            skipInvalid={skipInvalid}
            setSkipInvalid={setSkipInvalid}
            hasToday={hasToday}
            updateCurrent={updateCurrent}
            setUpdateCurrent={setUpdateCurrent}
            money={(v) => f.money(v)}
            locale={f.locale}
          />
        ) : null}

        {step === "done" && outcome ? (
          <div className="flex flex-col gap-3" role="status">
            <p className="flex items-center gap-2 text-[14px] font-semibold text-positive">
              <Check className="size-4" aria-hidden /> Imported.
            </p>
            <p className="text-ink-2">
              {outcome.counts.added} value{outcome.counts.added === 1 ? "" : "s"} added,{" "}
              {outcome.counts.updated} updated, {outcome.counts.removed} removed (
              {outcome.counts.snapshotsCreated} snapshot
              {outcome.counts.snapshotsCreated === 1 ? "" : "s"} created,{" "}
              {outcome.counts.snapshotsUpdated} updated, {outcome.counts.snapshotsRemoved} deleted).
              {outcome.currentBalances ? " Current balances were updated from today's row." : ""}
            </p>
            {skipInvalid && preview.counts.errors > 0 ? (
              <p className="text-ink-2">
                {preview.counts.errors} flagged cell
                {preview.counts.errors === 1 ? " was" : "s were"} skipped. Fix{" "}
                {preview.counts.errors === 1 ? "it" : "them"} in your sheet and import it again with
                Merge: what is already saved stays, and the fixed cells are added.
              </p>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={reset}>
                Import another
              </Button>
              <Button
                variant="primary"
                onClick={() => {
                  reset();
                  onOpenChange(false);
                }}
              >
                Done
              </Button>
            </div>
          </div>
        ) : null}

        {step !== "done" ? (
          <div className="mt-4 flex flex-col gap-2 border-t border-border pt-3">
            {error ? (
              <p role="alert" className="text-[12.5px] text-negative">
                {error}
              </p>
            ) : null}
            {step === "preview" && blockers.length ? (
              <ul className="flex flex-col gap-1 text-[12.5px] text-negative" aria-live="polite">
                {blockers.slice(0, 4).map((b) => (
                  <li key={b} className="flex gap-1.5">
                    <CircleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden /> {b}
                  </li>
                ))}
              </ul>
            ) : null}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Button
                variant="ghost"
                disabled={index <= 0}
                onClick={() => setStep(STEPS[Math.max(0, index - 1)]!.id)}
              >
                Back
              </Button>
              {step === "preview" ? (
                <Button
                  variant="primary"
                  disabled={busy || blockers.length > 0 || totalChanges === 0}
                  onClick={doImport}
                >
                  {busy
                    ? "Importing…"
                    : totalChanges === 0
                      ? "Nothing to change"
                      : `Import ${totalChanges} change${totalChanges === 1 ? "" : "s"}`}
                </Button>
              ) : (
                <Button
                  variant="primary"
                  disabled={!canEnter(STEPS[index + 1]!.id)}
                  onClick={() => setStep(STEPS[index + 1]!.id)}
                >
                  Continue
                </Button>
              )}
            </div>
            {step === "format" && datesUndecided ? (
              <p className="text-right text-[11.5px] text-ink-3">
                Choose the date format to continue.
              </p>
            ) : null}
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function sentence(s: string): string {
  const t = s.charAt(0).toUpperCase() + s.slice(1);
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

// ------------------------------------------------------------------------------------------------ step 1

function SourceStep({
  text,
  fileName,
  onText,
  onTemplate,
}: {
  text: string;
  fileName: string | null;
  onText: (text: string, fileName: string | null) => void;
  onTemplate: (layout: "rows" | "columns") => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <label className="flex flex-col gap-1">
        <span className="text-[12px] font-medium text-ink-2">
          Paste cells from your spreadsheet
        </span>
        <Textarea
          value={fileName ? "" : text}
          placeholder={
            "Date\tSavings\tBrokerage\n2024-01-31\t12,500\t48,200\n2024-02-29\t12,900\t49,100"
          }
          onChange={(e) => onText(e.target.value, null)}
          className="min-h-[140px] font-mono text-[12px]"
          spellCheck={false}
        />
      </label>
      <div className="flex items-center gap-3 text-[11.5px] text-ink-3" aria-hidden>
        <span className="h-px flex-1 bg-border" /> or <span className="h-px flex-1 bg-border" />
      </div>
      <FileDrop
        accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values,text/plain"
        title={fileName ? `Loaded ${fileName}` : "Drop a CSV or TSV file"}
        hint="A date column and one column per account works best; dates across the top and one row per account and date work too."
        maxChars={{
          chars: 5_000_000,
          message: (size) => `That file is ${size}; the limit is about 5 MB of text.`,
        }}
        onFile={(file) => onText(file.text, file.name)}
        className="[&_label]:py-6"
      />
      <div className="flex flex-wrap items-center gap-2 rounded-md bg-surface-2 px-3 py-2 text-[12.5px] text-ink-2">
        <Info className="size-4 shrink-0 text-ink-3" aria-hidden />
        <span className="min-w-0 flex-1">
          Start from a template that already lists your accounts. A blank cell means no value; 0
          means a zero balance.
        </span>
        <Button size="sm" variant="secondary" onClick={() => onTemplate("rows")}>
          <Download /> Template
        </Button>
      </div>
      {text.trim() ? (
        <p className="text-[12px] text-ink-3" role="status">
          {text.split(/\r\n|\n|\r/).filter((l) => l.trim()).length} lines ready.
        </p>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ step 2

const DELIMITER_LABEL: Record<string, string> = {
  ",": "Comma",
  ";": "Semicolon",
  "\t": "Tab",
  "|": "Pipe",
};
const LAYOUT_LABEL = {
  rows: "Dates in rows",
  columns: "Dates in columns",
  long: "One row per value",
};

function FormatStep({
  sheet,
  preview,
  delimiter,
  setDelimiter,
  setLayout,
  dateFormat,
  setDateFormat,
  decimal,
  setDecimal,
  periodDay,
  setPeriodDay,
  locale,
}: {
  sheet: ReturnType<typeof readHistorySheet>;
  preview: HistoryPreview;
  delimiter: "auto" | "," | ";" | "\t" | "|";
  setDelimiter: (d: "auto" | "," | ";" | "\t" | "|") => void;
  setLayout: (l: "auto" | "rows" | "columns" | "long") => void;
  dateFormat: "auto" | "YMD" | "MDY" | "DMY";
  setDateFormat: (d: "auto" | "YMD" | "MDY" | "DMY") => void;
  decimal: "auto" | "." | ",";
  setDecimal: (d: "auto" | "." | ",") => void;
  periodDay: "end" | "start";
  setPeriodDay: (p: "end" | "start") => void;
  locale: string;
}) {
  const df = preview.dateFormat;
  const firstNumeric = sheet.records.find((r) =>
    /^\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}/.test(r.rawDate),
  )?.rawDate;
  const readAs = (fmt: "MDY" | "DMY") => {
    if (!firstNumeric) return "";
    const [a, b, y] = firstNumeric.split(/[/.-]/).map((x) => Number(x)) as [number, number, number];
    const year = y < 100 ? (y < 70 ? 2000 + y : 1900 + y) : y;
    const [m, d] = fmt === "MDY" ? [a, b] : [b, a];
    const iso = `${year}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    return Number.isNaN(Date.parse(`${iso}T00:00:00Z`)) || m > 12
      ? "not a date"
      : formatDay(iso, locale);
  };
  return (
    <div className="flex flex-col gap-4">
      <p className="text-ink-2" role="status">
        Read {sheet.records.length} {sheet.layout === "long" ? "rows" : "dates"} and{" "}
        {sheet.headers.length} {sheet.layout === "columns" ? "rows of accounts" : "columns"}.
      </p>

      <fieldset className="flex flex-col gap-1.5">
        <legend className="mb-1 text-[12px] font-medium text-ink-2">Layout</legend>
        <div className="flex flex-wrap items-center gap-2">
          <Segmented
            aria-label="Layout"
            value={sheet.layout}
            onChange={(v) => setLayout(v)}
            options={(["rows", "columns", "long"] as const).map((l) => ({
              value: l,
              label: `${LAYOUT_LABEL[l]}${l === sheet.detectedLayout ? " (detected)" : ""}`,
            }))}
          />
          {sheet.layout !== "long" ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setLayout(sheet.layout === "rows" ? "columns" : "rows")}
            >
              <ArrowLeftRight /> Swap rows and columns
            </Button>
          ) : null}
        </div>
      </fieldset>

      <div className="grid gap-3 sm:grid-cols-3">
        <label className="flex flex-col gap-1">
          <span className="text-[12px] font-medium text-ink-2">Separator</span>
          <Select
            aria-label="Separator"
            value={delimiter}
            onValueChange={setDelimiter}
            options={[
              { value: "auto", label: `Detect (${DELIMITER_LABEL[sheet.delimiter]})` },
              { value: ",", label: "Comma" },
              { value: ";", label: "Semicolon" },
              { value: "\t", label: "Tab" },
              { value: "|", label: "Pipe" },
            ]}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[12px] font-medium text-ink-2">Date format</span>
          <Select
            aria-label="Date format"
            value={dateFormat}
            onValueChange={setDateFormat}
            options={DATE_FORMATS.map((d) => ({
              ...d,
              label:
                d.value === "auto" && df.detected
                  ? `Detect (${df.detected === "MDY" ? "month first" : "day first"})`
                  : d.label,
            }))}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[12px] font-medium text-ink-2">Number format</span>
          <Select
            aria-label="Number format"
            value={decimal}
            onValueChange={setDecimal}
            options={[
              {
                value: "auto",
                label: `Detect (${preview.decimal.used === "," ? "1.234,56" : "1,234.56"})`,
              },
              { value: ".", label: "1,234.56" },
              { value: ",", label: "1.234,56" },
            ]}
          />
        </label>
      </div>

      {df.ambiguous || (df.conflict && dateFormat === "auto") ? (
        <div
          role="alert"
          className="flex flex-col gap-2 rounded-md border border-ochre/40 bg-ochre-soft px-3 py-2.5"
        >
          <p className="flex items-start gap-2 text-[13px] text-ink">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-ochre" aria-hidden />
            {df.conflict
              ? "Some dates only work month-first and others only day-first. Choose how to read them; the ones that do not fit will be flagged."
              : `Every date fits both month-first and day-first, so Glideworth will not guess.${df.suggestion ? ` They run in order as ${df.suggestion === "MDY" ? "month first" : "day first"}.` : ""}`}
          </p>
          {firstNumeric ? (
            <div className="flex flex-wrap gap-2">
              {(["MDY", "DMY"] as const).map((fmt) => (
                <Button
                  key={fmt}
                  size="sm"
                  variant={df.suggestion === fmt ? "primary" : "secondary"}
                  onClick={() => setDateFormat(fmt)}
                >
                  {firstNumeric} is {readAs(fmt)}
                </Button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
      {preview.decimal.ambiguous && decimal === "auto" ? (
        <p className="flex items-start gap-2 text-[12.5px] text-ink-2">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-ochre" aria-hidden />
          Numbers like “1,234” could mean one thousand or one point two. They are read as{" "}
          {preview.decimal.used === "," ? "1.234" : "1234"}; choose the number format if that is
          wrong.
        </p>
      ) : null}
      {preview.hasPeriodDates ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[12px] font-medium text-ink-2">
            Months and years without a day are dated
          </span>
          <Segmented
            aria-label="Day for month-only dates"
            size="sm"
            value={periodDay}
            onChange={setPeriodDay}
            options={[
              { value: "end", label: "on their last day" },
              { value: "start", label: "on their first day" },
            ]}
          />
        </div>
      ) : null}

      <div>
        <p className="mb-1 text-[12px] font-medium text-ink-2">How the dates read</p>
        <ScrollRegion label="Dates as read" className="rounded-md border border-border">
          <table className="w-full text-[12.5px]">
            <thead>
              <tr className="border-b border-border text-left text-[11px] uppercase tracking-wider text-ink-3">
                <th className="px-2 py-1.5 font-semibold">In the file</th>
                <th className="px-2 py-1.5 font-semibold">Read as</th>
              </tr>
            </thead>
            <tbody>
              {preview.records.slice(0, 6).map((r) => (
                <tr key={r.dateRef} className="border-b border-border last:border-0">
                  <td className="px-2 py-1 font-mono">{r.rawDate || "(blank)"}</td>
                  <td className={cn("px-2 py-1", r.dateStatus === "error" && "text-negative")}>
                    {r.date ? formatDay(r.date, locale) : sentence(r.dateMessage ?? "not a date")}
                    {r.dateStatus === "info" && r.dateMessage ? (
                      <span className="ml-1 text-ink-3">({r.dateMessage})</span>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollRegion>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ step 3

function targetOptions(targets: readonly HistoryTarget[]): SelectOption<Opt>[] {
  const group = {
    account: "Accounts",
    asset: "Real assets",
    loan: "Loans",
    debt: "Debts",
  } as const;
  return [
    { value: SKIP, label: "Skip this column" },
    ...(["account", "asset", "loan", "debt"] as const).flatMap((k) =>
      targets
        .filter((t) => t.kind === k)
        .map((t) => ({
          value: t.key,
          label: t.label,
          group: group[k],
          ...(t.archived ? { hint: "Archived" } : t.currency ? { hint: `In ${t.currency}` } : {}),
        })),
    ),
    { value: "netWorth", label: "Net worth", group: "Totals" },
    { value: "assets", label: "Total assets", group: "Totals" },
    { value: "liabilities", label: "Total liabilities", group: "Totals" },
    { value: "note", label: "Note", group: "Other" },
  ];
}

function MapStep({
  headers,
  records,
  matches,
  mapping,
  targets,
  preview,
  onChange,
}: {
  headers: string[];
  records: string[][];
  matches: ReturnType<typeof matchHistoryColumns>;
  mapping: readonly (string | null)[];
  targets: readonly HistoryTarget[];
  preview: HistoryPreview;
  onChange: (i: number, key: string | null) => void;
}) {
  const options = useMemo(() => targetOptions(targets), [targets]);
  const mapped = mapping.filter((k) => k !== null).length;
  const dup = new Set(
    preview.issues.filter((i) => i.code === "history.mapping.duplicate").map((i) => i.key),
  );
  return (
    <div className="flex flex-col gap-3">
      <p className="text-ink-2" role="status">
        {mapped} of {headers.length} columns mapped. Columns are matched to your accounts by name;
        check the ones marked “Check”, and skip anything that is not a balance.
      </p>
      <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
        {headers.map((h, i) => {
          const m = matches[i]!;
          const key = mapping[i] ?? null;
          const auto = key !== null && key === m.key;
          const samples = records
            .map((r) => r[i] ?? "")
            .filter((v) => v.trim())
            .slice(0, 3);
          const id = `map-${i}`;
          return (
            <li
              key={id}
              className="grid gap-2 px-3 py-2.5 sm:grid-cols-[minmax(0,1fr)_minmax(0,260px)] sm:items-center"
            >
              <div className="min-w-0">
                <label htmlFor={id} className="block truncate font-medium text-ink">
                  {h}
                </label>
                <span className="block truncate text-[11.5px] text-ink-3">
                  {samples.length ? samples.join(" · ") : "No values"}
                </span>
              </div>
              <div className="flex min-w-0 items-center gap-2">
                <Select
                  id={id}
                  value={key ?? SKIP}
                  onValueChange={(v) => onChange(i, v === SKIP ? null : v)}
                  options={options}
                  className="min-w-0 flex-1"
                />
                {key && dup.has(key) ? (
                  <Badge tone="negative">Used twice</Badge>
                ) : key === null ? (
                  <Badge>Skipped</Badge>
                ) : auto && m.confidence >= 0.95 ? (
                  <Badge tone="accent">Matched</Badge>
                ) : auto ? (
                  <Badge tone="ochre" title={`${Math.round(m.confidence * 100)}% match`}>
                    Check
                  </Badge>
                ) : (
                  <Badge tone="accent">Chosen</Badge>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ step 4

type View = "all" | "flagged" | "changed";

function PreviewStep({
  preview,
  plan,
  targets,
  headers,
  mode,
  setMode,
  skipInvalid,
  setSkipInvalid,
  hasToday,
  updateCurrent,
  setUpdateCurrent,
  money,
  locale,
}: {
  preview: HistoryPreview;
  plan: HistoryPlan;
  targets: readonly HistoryTarget[];
  headers: string[];
  mode: HistoryMode;
  setMode: (m: HistoryMode) => void;
  skipInvalid: boolean;
  setSkipInvalid: (b: boolean) => void;
  hasToday: boolean;
  updateCurrent: boolean;
  setUpdateCurrent: (b: boolean) => void;
  money: (v: number) => string;
  locale: string;
}) {
  const [view, setView] = useState<View>("all");
  const cols = preview.mapping
    .map((k, i) => ({ k, i }))
    .filter((c): c is { k: string; i: number } => c.k !== null);
  const changeAt = useMemo(
    () => new Map(plan.changes.map((c) => [`${c.date}\u0000${c.key}`, c])),
    [plan.changes],
  );
  const removedOnly = plan.changes.filter(
    (c) => c.kind === "removed" && !preview.rows.some((r) => r.date === c.date),
  );
  const rows = preview.records.filter((r) => {
    if (view === "flagged")
      return (
        r.dateStatus === "error" ||
        r.cells.some((c) => c.status === "error" || c.status === "warning")
      );
    if (view === "changed")
      return !!r.date && cols.some((c) => changeAt.has(`${r.date}\u0000${c.k}`));
    return true;
  });
  const shown = rows.slice(0, 200);
  const entityTargets = targets.filter((t) => !t.archived).length;
  const partial = plan.create.filter(
    (s) =>
      s.accounts.length + s.realAssets.length + s.debts.length < entityTargets &&
      s.accounts.length + s.realAssets.length + s.debts.length > 0,
  ).length;
  const warnings = preview.issues.filter((i) => i.severity !== "error");
  return (
    <div className="flex flex-col gap-4">
      <fieldset className="flex flex-col gap-1.5">
        <legend className="mb-1 text-[12px] font-medium text-ink-2">How to import</legend>
        <Segmented
          aria-label="Import mode"
          value={mode}
          onChange={setMode}
          options={[
            { value: "merge", label: "Merge" },
            { value: "replace", label: "Replace" },
          ]}
        />
        <p className="text-[12.5px] text-ink-3">
          {mode === "merge"
            ? "Adds and updates the values in the file. Everything else stays as it is, and a blank cell changes nothing."
            : "Also clears, for each mapped column, saved values the file does not have between its first and last date (blank cells and missing dates). Other accounts and other dates stay."}
        </p>
      </fieldset>

      <dl
        className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-md border border-border bg-surface-2 px-3 py-2.5 sm:grid-cols-4"
        aria-live="polite"
      >
        {[
          ["Added", plan.counts.added, "text-positive"],
          ["Updated", plan.counts.updated, "text-ochre"],
          ["Removed", plan.counts.removed, "text-negative"],
          ["Unchanged", plan.counts.unchanged, "text-ink-2"],
        ].map(([label, n, tone]) => (
          <div key={label as string}>
            <dt className="text-[11px] font-semibold uppercase tracking-wider text-ink-3">
              {label}
            </dt>
            <dd className={cn("num text-[18px] font-semibold", tone as string)}>{n}</dd>
          </div>
        ))}
        <div className="col-span-2 text-[12px] text-ink-3 sm:col-span-4">
          {plan.range
            ? `${formatDay(plan.range.from, locale)} to ${formatDay(plan.range.to, locale)}. `
            : ""}
          Snapshots: {plan.counts.snapshotsCreated} new, {plan.counts.snapshotsUpdated} changed,{" "}
          {plan.counts.snapshotsRemoved} deleted.
          {preview.counts.errors ? ` ${preview.counts.errors} flagged.` : ""}
          {preview.counts.warnings ? ` ${preview.counts.warnings} with a note.` : ""}
        </div>
      </dl>

      {preview.counts.errors > 0 ? (
        <SwitchField
          label="Import the clean cells now and skip the flagged ones"
          hint="Flagged cells are left out, never cleared. Fix them in your sheet and import it again with Merge."
          checked={skipInvalid}
          onCheckedChange={setSkipInvalid}
        />
      ) : null}
      {hasToday ? (
        <SwitchField
          label="Also update current balances from today's row"
          hint="Off: history only. On: the values dated today also become your current balances, which plans start from."
          checked={updateCurrent}
          onCheckedChange={setUpdateCurrent}
        />
      ) : null}
      {partial > 0 ? (
        <p className="flex items-start gap-2 text-[12.5px] text-ink-2">
          <Info className="mt-0.5 size-4 shrink-0 text-ink-3" aria-hidden />
          {partial} new date{partial === 1 ? "" : "s"} record{partial === 1 ? "s" : ""} only some of
          your accounts; {partial === 1 ? "its" : "their"} net worth counts only the accounts in the
          file. Nothing is estimated for the others.
        </p>
      ) : null}
      {warnings.length ? (
        <ul className="flex flex-col gap-1 text-[12.5px] text-ink-2">
          {warnings.map((w) => (
            <li key={w.code + (w.key ?? "")} className="flex items-start gap-2">
              <Info className="mt-0.5 size-4 shrink-0 text-ink-3" aria-hidden />{" "}
              {sentence(w.message)}
            </li>
          ))}
        </ul>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <Segmented
          aria-label="Rows to show"
          size="sm"
          value={view}
          onChange={setView}
          options={[
            { value: "all", label: `All (${preview.records.length})` },
            { value: "flagged", label: "Flagged" },
            { value: "changed", label: "Changes" },
          ]}
        />
        <Legend />
      </div>
      <ScrollRegion
        label="Preview of every cell"
        className="max-h-[360px] overflow-y-auto rounded-md border border-border"
      >
        <table className="w-full border-collapse text-[12.5px]">
          <thead className="sticky top-0 z-[1] bg-surface">
            <tr className="border-b border-border">
              <th
                scope="col"
                className="sticky left-0 bg-surface px-2 py-1.5 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-3"
              >
                Date
              </th>
              {cols.map((c) => (
                <th
                  key={c.i}
                  scope="col"
                  className="whitespace-nowrap px-2 py-1.5 text-right text-[11px] font-semibold uppercase tracking-wider text-ink-3"
                >
                  {historyKeyLabel(c.k, targets)}
                  {headers[c.i] !== historyKeyLabel(c.k, targets) ? (
                    <span className="block font-normal normal-case tracking-normal text-ink-3">
                      from “{headers[c.i]}”
                    </span>
                  ) : null}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.dateRef} className="border-b border-border last:border-0">
                <th
                  scope="row"
                  className={cn(
                    "sticky left-0 whitespace-nowrap bg-surface px-2 py-1 text-left font-normal",
                    r.dateStatus === "error" && "bg-negative-soft text-negative",
                  )}
                >
                  {r.date ? formatDay(r.date, locale) : r.rawDate || "(blank)"}
                  {r.dateStatus === "error" ? (
                    <span className="block text-[11px]">
                      {r.dateRef}: {r.dateMessage}
                    </span>
                  ) : null}
                </th>
                {cols.map((c) => {
                  const cell = r.cells[c.i]!;
                  const change = r.date ? changeAt.get(`${r.date}\u0000${c.k}`) : undefined;
                  return (
                    <PreviewCellView
                      key={c.i}
                      cell={cell}
                      change={change}
                      money={money}
                      isNote={c.k === "note"}
                    />
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollRegion>
      {rows.length > shown.length ? (
        <p className="text-[12px] text-ink-3">
          Showing the first {shown.length} of {rows.length} rows.
        </p>
      ) : null}
      {removedOnly.length ? (
        <p className="text-[12.5px] text-ink-2">
          Replace also clears {removedOnly.length} saved value{removedOnly.length === 1 ? "" : "s"}{" "}
          on dates that are not in the file:{" "}
          {removedOnly
            .slice(0, 6)
            .map((c) => `${historyKeyLabel(c.key, targets)} on ${formatDay(c.date, locale)}`)
            .join(", ")}
          {removedOnly.length > 6 ? "…" : "."}
        </p>
      ) : null}
    </div>
  );
}

function Legend() {
  const item = (cls: string, label: string) => (
    <span className="flex items-center gap-1">
      <span aria-hidden className={cn("inline-block size-2.5 rounded-sm", cls)} /> {label}
    </span>
  );
  return (
    <div className="flex flex-wrap gap-3 text-[11.5px] text-ink-3">
      {item("bg-positive/30", "Added")}
      {item("bg-ochre-soft border border-ochre/40", "Updated")}
      {item("bg-negative-soft border border-negative/40", "Flagged or removed")}
    </div>
  );
}

function PreviewCellView({
  cell,
  change,
  money,
  isNote,
}: {
  cell: HistoryPreview["records"][number]["cells"][number];
  change: HistoryPlan["changes"][number] | undefined;
  money: (v: number) => string;
  isNote: boolean;
}) {
  if (isNote)
    return <td className="max-w-[200px] truncate px-2 py-1 text-ink-2">{cell.text ?? ""}</td>;
  if (cell.status === "error")
    return (
      <td
        className="bg-negative-soft px-2 py-1 text-right text-negative"
        title={`${cell.ref}: ${cell.message ?? ""}`}
      >
        <span className="inline-flex items-center gap-1">
          <CircleAlert className="size-3" aria-hidden />
          <span className="font-mono">{cell.raw.trim() || "?"}</span>
        </span>
        <span className="sr-only">
          {" "}
          flagged, {cell.ref}: {cell.message}
        </span>
      </td>
    );
  if (cell.status === "skipped") return <td className="px-2 py-1 text-right text-ink-3">—</td>;
  const value = cell.value;
  const label =
    value === null || value === undefined
      ? change?.kind === "removed"
        ? `cleared (was ${money(change.before!)})`
        : ""
      : money(value);
  const tone =
    change?.kind === "added"
      ? "bg-positive/15"
      : change?.kind === "updated"
        ? "bg-ochre-soft"
        : change?.kind === "removed"
          ? "bg-negative-soft text-negative line-through"
          : "";
  const note =
    change?.kind === "updated" && change.before !== null
      ? `was ${money(change.before)}`
      : cell.status === "warning"
        ? (cell.message ?? "")
        : "";
  return (
    <td
      className={cn("num whitespace-nowrap px-2 py-1 text-right", tone)}
      title={note || undefined}
    >
      {cell.status === "warning" ? (
        <AlertTriangle className="mr-1 inline size-3 text-ochre" aria-hidden />
      ) : null}
      {label || <span className="text-ink-3">blank</span>}
      {note ? <span className="sr-only"> ({note})</span> : null}
      {change && change.kind !== "removed" ? (
        <span className="sr-only"> ({change.kind})</span>
      ) : null}
    </td>
  );
}
