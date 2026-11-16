/**
 * Guided ProjectionLab migration: choose the export → review (counts + full report) → choose how
 * to bring it in (replace or merge) → import → land on the dashboard with a review checklist.
 * The file is parsed in this browser with @glideworth/importers; only the converted Glideworth document is
 * sent to your own Glideworth server.
 */
import type { GlideworthDocument } from "@glideworth/core";
import {
  detectProjectionLabExport,
  type ImportResult,
  importProjectionLab,
} from "@glideworth/importers";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CircleAlert,
  FileJson,
  GitMerge,
  Loader2,
  Replace,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { Button } from "../../components/ui/button";
import { Card, CardBody, CardHeader } from "../../components/ui/card";
import { toast } from "../../components/ui/toaster";
import { cn } from "../../lib/cn";
import { formatMonth } from "../../lib/format";
import { useFormat, useWorkspace } from "../../lib/workspace";
import { usePrefs } from "../../stores/prefs";
import { FileDrop, formatBytes, type PickedFile } from "./file-drop";
import { buildImportChecklist, mergeDocuments } from "./import-model";
import { persistWorkspace } from "./persist";
import { CountsTable, ImportReportView, IssueTally } from "./report-view";

type Step = "choose" | "review" | "import";
type Mode = "replace" | "merge";

interface Parsed {
  file: PickedFile;
  result: ImportResult;
}

export function ProjectionLabImport() {
  const [step, setStep] = useState<Step>("choose");
  const [parsed, setParsed] = useState<Parsed | null>(null);
  const [error, setError] = useState<ReactNode>(null);
  const [parsing, setParsing] = useState(false);
  const f = useFormat();
  const lastImport = usePrefs((s) => s.lastImport);

  const onFile = (file: PickedFile) => {
    setError(null);
    setParsing(true);
    // Let the spinner paint before the (synchronous) conversion.
    setTimeout(() => {
      try {
        let raw: unknown;
        try {
          raw = JSON.parse(file.text);
        } catch {
          throw new Error(
            "That file is not valid JSON. Choose the .json file ProjectionLab exported.",
          );
        }
        if (!detectProjectionLabExport(raw)) {
          const app = raw && typeof raw === "object" ? (raw as { app?: unknown }).app : undefined;
          // 'cairn': backups written before the rename.
          const isBackup = app === "glideworth" || app === "cairn";
          setError(
            isBackup ? (
              <>
                This is a Glideworth backup, not a ProjectionLab export.{" "}
                <Link to="/import" search={{ tab: "backup" }} className="font-medium underline">
                  Restore it from Backup & export
                </Link>
                .
              </>
            ) : (
              'This does not look like a ProjectionLab export (it needs "meta", "today" and "plans").'
            ),
          );
          setParsing(false);
          return;
        }
        const result = importProjectionLab(raw, { now: new Date().toISOString() });
        setParsed({ file, result });
        setStep("review");
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setParsing(false);
      }
    }, 30);
  };

  return (
    <div className="flex flex-col gap-5">
      <Stepper step={step} onStep={(s) => parsed && setStep(s)} />
      {step === "choose" ? (
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)] [&>*]:min-w-0">
          <div className="flex flex-col gap-3">
            <FileDrop
              accept=".json,application/json"
              title="Choose your ProjectionLab export"
              hint="The JSON file from ProjectionLab’s data export. Up to 25 MB."
              onFile={onFile}
              busy={parsing}
            />
            {parsing ? (
              <p className="flex items-center gap-2 text-[12.5px] text-ink-2" aria-live="polite">
                <Loader2 className="size-3.5 animate-spin" /> Reading and converting in this
                browser…
              </p>
            ) : null}
            {error ? (
              <p
                role="alert"
                className="flex items-start gap-2 rounded-lg bg-negative-soft px-3 py-2 text-[12.5px] text-negative"
              >
                <CircleAlert className="mt-0.5 size-4 shrink-0" /> <span>{error}</span>
              </p>
            ) : null}
          </div>
          <aside
            aria-label="About this import"
            className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-4 text-[12.5px] leading-relaxed text-ink-2"
          >
            <div className="flex items-center gap-2 font-semibold text-ink">
              <ShieldCheck className="size-4 text-accent" /> Private by design
            </div>
            <p>
              The file is read and converted{" "}
              <strong className="text-ink">entirely in this browser</strong>. Nothing is uploaded
              while you review. When you choose Import, only the converted plan is saved, to{" "}
              <strong className="text-ink">your own Glideworth server</strong>.
            </p>
            <div className="font-semibold text-ink">What comes across</div>
            <ul className="list-disc space-y-0.5 pl-4">
              <li>People, location and currency</li>
              <li>Accounts, property and debts with their balances</li>
              <li>
                Every plan: income, expenses, milestones, savings flows, withdrawal and tax settings
              </li>
              <li>Your net-worth history</li>
            </ul>
            <p>
              You will see exactly what mapped, what was approximated and what Glideworth cannot
              model yet before anything is saved.
            </p>
          </aside>
          {lastImport ? (
            <Card className="lg:col-span-2">
              <CardHeader
                eyebrow="Previous import"
                title={`${lastImport.fileName} · ${new Date(lastImport.at).toLocaleString(f.locale, { dateStyle: "medium", timeStyle: "short" })}`}
                actions={<IssueTally counts={lastImport.issueCounts} locale={f.locale} />}
              />
              <CardBody>
                <ImportReportView issues={lastImport.issues} locale={f.locale} />
              </CardBody>
            </Card>
          ) : null}
        </div>
      ) : null}
      {step === "review" && parsed ? (
        <Review parsed={parsed} onBack={() => setStep("choose")} onNext={() => setStep("import")} />
      ) : null}
      {step === "import" && parsed ? (
        <ImportStep parsed={parsed} onBack={() => setStep("review")} />
      ) : null}
    </div>
  );
}

const STEPS: { id: Step; label: string }[] = [
  { id: "choose", label: "Choose file" },
  { id: "review", label: "Review" },
  { id: "import", label: "Import" },
];

function Stepper({ step, onStep }: { step: Step; onStep: (s: Step) => void }) {
  const at = STEPS.findIndex((s) => s.id === step);
  return (
    <ol className="flex items-center gap-2 text-[12.5px]" aria-label="Import steps">
      {STEPS.map((s, i) => (
        <li key={s.id} className="flex items-center gap-2">
          {i > 0 ? <span className="h-px w-6 bg-border-strong sm:w-10" aria-hidden /> : null}
          <button
            type="button"
            disabled={i > at}
            onClick={() => onStep(s.id)}
            aria-current={i === at ? "step" : undefined}
            className={cn(
              "flex items-center gap-1.5 rounded-full px-1 py-0.5 font-medium",
              i === at ? "text-ink" : i < at ? "text-accent hover:underline" : "text-ink-3",
            )}
          >
            <span
              className={cn(
                "flex size-5 items-center justify-center rounded-full border text-[10.5px]",
                i < at && "border-accent bg-accent text-accent-ink",
                i === at && "border-accent text-accent",
                i > at && "border-border-strong",
              )}
            >
              {i < at ? <Check className="size-3" /> : i + 1}
            </span>
            {s.label}
          </button>
        </li>
      ))}
    </ol>
  );
}

function entityNames(doc: GlideworthDocument): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of doc.finances.accounts) out[a.id] = a.name;
  for (const a of doc.finances.realAssets) out[a.id] = a.name;
  for (const d of doc.finances.debts) out[d.id] = d.name;
  for (const p of doc.plans) {
    out[p.id] = p.name;
    for (const x of [...p.income, ...p.expenses, ...p.milestones, ...p.flows])
      out[x.id] = `${p.name} › ${x.name}`;
  }
  return out;
}

function Review({
  parsed,
  onBack,
  onNext,
}: {
  parsed: Parsed;
  onBack: () => void;
  onNext: () => void;
}) {
  const f = useFormat();
  const { result, file } = parsed;
  const doc = result.document;
  const names = useMemo(() => entityNames(doc), [doc]);
  const errors = result.issues.filter((i) => i.severity === "error").length;
  return (
    <div className="flex flex-col gap-5">
      <Card>
        <CardBody className="flex flex-col gap-4">
          <div className="flex flex-wrap items-start gap-3">
            <div className="flex size-9 items-center justify-center rounded-lg bg-surface-2 text-ink-2">
              <FileJson className="size-4" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[14px] font-semibold">{file.name}</div>
              <div className="text-[12px] text-ink-3">
                {formatBytes(file.size, f.locale)}
                {result.report.source.version
                  ? ` · ProjectionLab export v${result.report.source.version}`
                  : ""}{" "}
                · balances as of {formatMonth(doc.finances.asOf, f.locale)} ·{" "}
                {doc.household.people.map((p) => p.name).join(" & ")} · {doc.household.currency}
              </div>
            </div>
            <IssueTally counts={result.report.issueCounts} locale={f.locale} />
          </div>
          <CountsTable counts={result.report.counts} locale={f.locale} />
          {errors ? (
            <p
              role="alert"
              className="rounded-lg bg-negative-soft px-3 py-2 text-[12.5px] text-negative"
            >
              {errors} blocking {errors === 1 ? "error" : "errors"}: this file cannot be imported
              until they are fixed.
            </p>
          ) : null}
        </CardBody>
      </Card>
      <Card>
        <CardHeader
          eyebrow="Import report"
          title="Everything in the file, accounted for"
          actions={
            <span className="hidden text-[12px] text-ink-3 sm:inline">
              Nothing has been saved yet
            </span>
          }
        />
        <CardBody>
          <ImportReportView
            issues={result.issues}
            coverage={result.report.coverage}
            entityNames={names}
            locale={f.locale}
          />
        </CardBody>
      </Card>
      <div className="sticky bottom-0 z-10 -mx-4 flex items-center gap-2 border-t border-border bg-bg px-4 py-3 sm:-mx-6 sm:px-6 md:bottom-0">
        <Button variant="ghost" onClick={onBack}>
          <ArrowLeft /> Choose another file
        </Button>
        <Button variant="primary" className="ml-auto" onClick={onNext} disabled={errors > 0}>
          Continue <ArrowRight />
        </Button>
      </div>
    </div>
  );
}

function ImportStep({ parsed, onBack }: { parsed: Parsed; onBack: () => void }) {
  const { data: ws } = useWorkspace();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const setPrefs = usePrefs((s) => s.set);
  const hasData = ws?.source === "api";
  const [mode, setMode] = useState<Mode>("replace");
  const [busy, setBusy] = useState(false);
  const incoming = parsed.result.document;
  const merge = useMemo(
    () => (hasData && ws ? mergeDocuments(ws.doc, incoming) : null),
    [hasData, ws, incoming],
  );
  const target: GlideworthDocument | null = mode === "merge" ? (merge?.document ?? null) : incoming;
  const offline = ws?.source === "sample" && !ws.firstRun;

  const run = async () => {
    if (!target) return;
    setBusy(true);
    try {
      // Merge goes through the server's `merge` mode: plans not in the file are kept untouched, and
      // every plan keeps its version history either way.
      const out = await persistWorkspace(qc, target, { mode });
      const importedPlanIds =
        mode === "merge"
          ? target.plans.slice(ws!.doc.plans.length).map((p) => p.id)
          : target.plans.map((p) => p.id);
      setPrefs({
        importChecklist: buildImportChecklist(target, {
          source: `ProjectionLab (${parsed.file.name})`,
          issueCounts: parsed.result.report.issueCounts,
          planIds: importedPlanIds,
        }),
        lastImport: {
          source: "projectionlab",
          fileName: parsed.file.name,
          at: new Date().toISOString(),
          issues: parsed.result.issues,
          issueCounts: parsed.result.report.issueCounts,
        },
      });
      toast({
        title: `Imported ${importedPlanIds.length} ${importedPlanIds.length === 1 ? "plan" : "plans"}`,
        description:
          out.where === "server"
            ? "Saved to your Glideworth server. Work through the review list on the dashboard."
            : "The server is offline, so the import lives in this browser for now.",
        tone: "positive",
      });
      await navigate({ to: "/" });
    } catch (e) {
      toast({
        title: "Import failed",
        description: e instanceof Error ? e.message : String(e),
        tone: "negative",
      });
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      {hasData ? (
        <fieldset className="grid gap-3 md:grid-cols-2">
          <legend className="mb-2 text-[13px] font-semibold text-ink">
            You already have data in Glideworth. How should this come in?
          </legend>
          <ModeCard
            selected={mode === "replace"}
            onSelect={() => setMode("replace")}
            icon={<Replace className="size-4" />}
            title="Replace my data"
            body={`Your current household, ${ws!.doc.plans.length} ${ws!.doc.plans.length === 1 ? "plan" : "plans"} and history are replaced by the import. Best for a clean migration.`}
          />
          <ModeCard
            selected={mode === "merge"}
            onSelect={() => setMode("merge")}
            icon={<GitMerge className="size-4" />}
            title="Merge into my data"
            body="Keep your household and plans, and add the imported accounts, property, debts, plans and history alongside them."
            disabled={!merge?.document}
          />
        </fieldset>
      ) : null}
      <Card>
        <CardHeader
          eyebrow="What will happen"
          title={mode === "merge" ? "Merge" : hasData ? "Replace" : "Create"}
        />
        <CardBody className="flex flex-col gap-3 text-[13px] text-ink-2">
          {mode === "merge" && merge ? (
            <>
              <ul className="grid gap-1 sm:grid-cols-2">
                <li>
                  Add <Count n={merge.added.plans} one="plan" /> (none becomes main)
                </li>
                <li>
                  Add <Count n={merge.added.accounts} one="account" />,{" "}
                  <Count n={merge.added.realAssets} one="asset" /> and{" "}
                  <Count n={merge.added.debts} one="debt" />
                </li>
                <li>
                  Add <Count n={merge.added.snapshots} one="history snapshot" />
                </li>
                <li>Keep your people, location, currency and settings</li>
              </ul>
              {merge.notes.map((n) => (
                <p
                  key={n}
                  className="flex items-start gap-2 rounded-md bg-ochre-soft px-3 py-2 text-[12.5px] text-ochre"
                >
                  <CircleAlert className="mt-0.5 size-3.5 shrink-0" /> {n}
                </p>
              ))}
              {merge.errors.length ? (
                <div
                  role="alert"
                  className="rounded-md bg-negative-soft px-3 py-2 text-[12.5px] text-negative"
                >
                  These cannot be merged automatically; choose Replace instead:
                  <ul className="mt-1 list-disc pl-4">
                    {merge.errors.map((e) => (
                      <li key={e}>{e}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </>
          ) : (
            <ul className="grid gap-1 sm:grid-cols-2">
              <li>
                <Count n={incoming.plans.length} one="plan" />, main plan “
                {(incoming.plans.find((p) => p.isMain) ?? incoming.plans[0])?.name ?? "—"}”
              </li>
              <li>
                <Count n={incoming.finances.accounts.length} one="account" />,{" "}
                <Count n={incoming.finances.realAssets.length} one="asset" />,{" "}
                <Count n={incoming.finances.debts.length} one="debt" />
              </li>
              <li>
                <Count n={incoming.progress.length} one="history snapshot" />
              </li>
              <li>
                Household: {incoming.household.people.map((p) => p.name).join(" & ")} ·{" "}
                {incoming.household.currency}
              </li>
              {hasData ? (
                <li className="text-negative sm:col-span-2">
                  Your current data is replaced in one step. Download a backup first if you might
                  want it back.
                </li>
              ) : null}
            </ul>
          )}
          {offline ? (
            <p className="rounded-md bg-ochre-soft px-3 py-2 text-[12.5px] text-ochre">
              The Glideworth server is not reachable: the import will live in this browser only
              until it is.
            </p>
          ) : null}
          <p className="flex items-center gap-2 text-[12px] text-ink-3">
            <Sparkles className="size-3.5" /> Plans are created at version 1; afterwards every
            change is versioned and undoable.
          </p>
        </CardBody>
      </Card>
      <div className="flex items-center gap-2">
        <Button variant="ghost" onClick={onBack} disabled={busy}>
          <ArrowLeft /> Back to the report
        </Button>
        <Button
          variant={mode === "replace" && hasData ? "danger" : "primary"}
          size="lg"
          className="ml-auto"
          onClick={() => void run()}
          disabled={busy || !target}
        >
          {busy ? <Loader2 className="animate-spin" /> : null}
          {mode === "merge" ? "Merge into my data" : hasData ? "Replace and import" : "Import"}
        </Button>
      </div>
    </div>
  );
}

function ModeCard({
  selected,
  onSelect,
  icon,
  title,
  body,
  disabled,
}: {
  selected: boolean;
  onSelect: () => void;
  icon: ReactNode;
  title: string;
  body: string;
  disabled?: boolean;
}) {
  return (
    <label
      className={cn(
        "flex cursor-pointer gap-3 rounded-xl border bg-surface p-4 transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-focus/30",
        selected ? "border-accent ring-1 ring-accent" : "border-border hover:border-border-strong",
        disabled && "cursor-not-allowed opacity-50",
      )}
    >
      <input
        type="radio"
        name="import-mode"
        className="sr-only"
        checked={selected}
        onChange={onSelect}
        disabled={disabled}
      />
      <span
        className={cn(
          "flex size-8 shrink-0 items-center justify-center rounded-lg",
          selected ? "bg-accent text-accent-ink" : "bg-surface-2 text-ink-2",
        )}
      >
        {icon}
      </span>
      <span>
        <span className="block text-[13.5px] font-semibold text-ink">{title}</span>
        <span className="mt-0.5 block text-[12.5px] leading-relaxed text-ink-2">{body}</span>
      </span>
    </label>
  );
}

/** A bold count with its noun, singular or plural: "1 debt", "4 assets". */
function Count({ n, one }: { n: number; one: string }) {
  return (
    <>
      <strong className="num text-ink">{n.toLocaleString()}</strong> {n === 1 ? one : `${one}s`}
    </>
  );
}
