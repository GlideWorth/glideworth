/**
 * Backup & export: full JSON backup, CSV tables for any plan, and restore from a backup.
 * Shared by the Import & export centre and Settings → Data.
 */
import { buildSimulationInput, type GlideworthDocument } from "@glideworth/core";
import {
  parseExportedDocument,
  progressTable,
  TABLE_BUILDERS,
  tableToCsv,
} from "@glideworth/importers";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ArchiveRestore, Download, FileDown, Loader2, Table2 } from "lucide-react";
import { useState } from "react";
import { downloadBackup, saveFile } from "../../components/command/actions";
import { Button } from "../../components/ui/button";
import { Card, CardBody, CardHeader } from "../../components/ui/card";
import { confirmAction } from "../../components/ui/confirm-dialog";
import { Field } from "../../components/ui/input";
import { Segmented } from "../../components/ui/segmented";
import { Select } from "../../components/ui/select";
import { toast } from "../../components/ui/toaster";
import { formatMonth, plural } from "../../lib/format";
import { useActivePlan, useFormat, useWorkspace } from "../../lib/workspace";
import { useUi } from "../../stores/ui";
import { runSimulation } from "../../workers/sim-client";
import { FileDrop, type PickedFile } from "./file-drop";
import { persistWorkspace } from "./persist";

const TABLES: { id: keyof typeof TABLE_BUILDERS | "progress"; label: string; hint: string }[] = [
  {
    id: "year-by-year",
    label: "Year by year",
    hint: "Net worth, income, spending, taxes per year",
  },
  { id: "cash-flow", label: "Cash flow", hint: "Every inflow and outflow per year" },
  { id: "taxes", label: "Taxes", hint: "Tax by jurisdiction and kind" },
  { id: "account-balances", label: "Account balances", hint: "Closing balance of every account" },
  { id: "progress", label: "Progress history", hint: "Your recorded snapshots" },
];

export function BackupCard() {
  const { data: ws } = useWorkspace();
  const f = useFormat();
  const doc = ws?.doc;
  return (
    <Card>
      <CardHeader eyebrow="Backup" title="Everything, in one file" />
      <CardBody className="flex flex-col gap-3 text-[13px] text-ink-2">
        <p>
          A JSON file with your household, current finances, every plan, your progress history and
          settings. Restore it here, or keep it as an archive.
        </p>
        {doc ? (
          <p className="text-[12px] text-ink-3">
            {plural(doc.plans.length, "plan")} · {plural(doc.finances.accounts.length, "account")} ·{" "}
            {plural(doc.progress.length, "snapshot")} · balances as of{" "}
            {formatMonth(doc.finances.asOf, f.locale)}
          </p>
        ) : null}
        <div>
          <Button variant="primary" onClick={() => void downloadBackup(ws)} disabled={!ws}>
            <Download /> Download backup
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}

export function TablesCard() {
  const { data: ws } = useWorkspace();
  const { plan } = useActivePlan();
  const globalBasis = useUi((s) => s.basis);
  const [planId, setPlanId] = useState<string | undefined>(plan?.id);
  const [basis, setBasis] = useState(globalBasis);
  const [busy, setBusy] = useState<string | null>(null);
  const doc = ws?.doc;

  const exportTable = async (id: (typeof TABLES)[number]["id"]) => {
    if (!doc) return;
    setBusy(id);
    try {
      const stamp = new Date().toISOString().slice(0, 10);
      if (id === "progress") {
        saveFile(`glideworth-progress-${stamp}.csv`, tableToCsv(progressTable(doc)), "text/csv");
        return;
      }
      const p = doc.plans.find((x) => x.id === planId) ?? doc.plans[0];
      if (!p) throw new Error("There is no plan to export.");
      const { result } = await runSimulation(
        buildSimulationInput(doc, p.id, { trace: "off", strict: false }),
      );
      const labels = Object.fromEntries([
        ...doc.household.people.map((x) => [x.id, x.name]),
        ...doc.finances.accounts.map((a) => [a.id, a.name]),
      ]);
      const table = TABLE_BUILDERS[id](result, { basis, labels });
      const slug = p.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
      saveFile(`glideworth-${slug}-${id}-${basis}-${stamp}.csv`, tableToCsv(table), "text/csv");
    } catch (e) {
      toast({
        title: "Export failed",
        description: e instanceof Error ? e.message : String(e),
        tone: "negative",
      });
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card>
      <CardHeader eyebrow="Spreadsheets" title="Tables as CSV" />
      <CardBody className="flex flex-col gap-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Plan">
            {(id) => (
              <Select
                id={id}
                value={planId ?? plan?.id}
                onValueChange={setPlanId}
                options={(doc?.plans ?? []).map((p) => ({ value: p.id, label: p.name }))}
                placeholder="No plans"
              />
            )}
          </Field>
          <Field label="Amounts in">
            {() => (
              <Segmented
                aria-label="Amounts in"
                value={basis}
                onChange={setBasis}
                options={[
                  { value: "real", label: "Today's money" },
                  { value: "nominal", label: "Future money" },
                ]}
              />
            )}
          </Field>
        </div>
        <ul className="grid gap-2 sm:grid-cols-2">
          {TABLES.map((t) => (
            <li key={t.id}>
              <button
                type="button"
                disabled={!doc || !!busy}
                onClick={() => void exportTable(t.id)}
                className="flex w-full items-center gap-3 rounded-lg border border-border bg-surface px-3 py-2.5 text-left transition-colors hover:border-accent/50 hover:bg-accent-soft/30 disabled:opacity-60"
              >
                <Table2 className="size-4 shrink-0 text-ink-3" aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] font-medium text-ink">{t.label}</span>
                  <span className="block truncate text-[11.5px] text-ink-3">{t.hint}</span>
                </span>
                {busy === t.id ? (
                  <Loader2 className="size-4 animate-spin text-accent" />
                ) : (
                  <FileDown className="size-4 text-ink-3" aria-hidden />
                )}
              </button>
            </li>
          ))}
        </ul>
      </CardBody>
    </Card>
  );
}

export function RestoreCard() {
  const { data: ws } = useWorkspace();
  const f = useFormat();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onFile = async (file: PickedFile) => {
    setError(null);
    let doc: GlideworthDocument;
    let exportedAt: string | undefined;
    try {
      const parsed = parseExportedDocument(file.text);
      doc = parsed.document;
      exportedAt = parsed.exportedAt;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return;
    }
    const when = exportedAt
      ? new Intl.DateTimeFormat(f.locale, { dateStyle: "medium", timeStyle: "short" }).format(
          new Date(exportedAt),
        )
      : "an unknown date";
    const ok = await confirmAction({
      title: "Restore this backup?",
      description: `${file.name} (saved ${when}): ${plural(doc.plans.length, "plan")}, ${plural(doc.finances.accounts.length, "account")}, ${plural(doc.progress.length, "snapshot")}. ${
        ws?.source === "api" ? "Your current data will be replaced." : ""
      }`,
      confirmLabel: "Restore",
      tone: ws?.source === "api" ? "danger" : "primary",
    });
    if (!ok) return;
    setBusy(true);
    try {
      await persistWorkspace(qc, doc);
      toast({
        title: "Backup restored",
        description: `${plural(doc.plans.length, "plan")} restored.`,
        tone: "positive",
      });
      await navigate({ to: "/" });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader
        eyebrow="Restore"
        title={
          <span className="flex items-center gap-2">
            <ArchiveRestore className="size-4 text-ink-3" /> From a Glideworth backup
          </span>
        }
      />
      <CardBody className="flex flex-col gap-3">
        <FileDrop
          accept=".json,application/json"
          title="Choose a Glideworth backup"
          hint="Older backups are upgraded automatically. You will be asked to confirm before anything is replaced."
          onFile={(f) => void onFile(f)}
          busy={busy}
        />
        {error ? (
          <p role="alert" className="text-[12.5px] text-negative">
            {error}
          </p>
        ) : null}
      </CardBody>
    </Card>
  );
}
