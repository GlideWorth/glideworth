/** Export balance history: pick accounts and a layout, then copy or download (CSV or TSV). */
import type { GlideworthDocument } from "@glideworth/core";
import { exportBalanceHistory, historyTargets, snapshotValues } from "@glideworth/importers";
import { Copy, Download, Info } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "../../components/ui/button";
import { Dialog, DialogContent } from "../../components/ui/dialog";
import { Segmented } from "../../components/ui/segmented";
import { SwitchField } from "../../components/ui/switch";
import { toast } from "../../components/ui/toaster";
import { formatDay } from "../../lib/format";
import { useFormat } from "../../lib/workspace";
import { driftSentence, storedTotalDrift } from "../dashboard/dashboard-view";
import { downloadText } from "../results/model";
import { todayIso } from "./progress-model";

export function HistoryExportDialog({
  open,
  onOpenChange,
  doc,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  doc: GlideworthDocument;
}) {
  const f = useFormat();
  const targets = useMemo(
    () => historyTargets(doc.finances, doc.household.currency),
    [doc.finances, doc.household.currency],
  );
  const drifted = useMemo(
    () =>
      doc.progress.flatMap((s) => {
        const drift = storedTotalDrift(doc, s);
        return drift ? [{ date: s.date, drift }] : [];
      }),
    [doc],
  );
  const recorded = useMemo(() => {
    const s = new Set<string>();
    for (const snap of doc.progress) for (const k of snapshotValues(snap).keys()) s.add(k);
    return s;
  }, [doc.progress]);
  const [picked, setPicked] = useState<Set<string>>(
    () => new Set(targets.filter((t) => recorded.has(t.key) || !t.archived).map((t) => t.key)),
  );
  const [layout, setLayout] = useState<"rows" | "columns">("rows");
  const [format, setFormat] = useState<"csv" | "tsv">("csv");
  const [totals, setTotals] = useState(true);

  const keys = targets.filter((t) => picked.has(t.key)).map((t) => t.key);
  const text = useMemo(
    () =>
      exportBalanceHistory(doc.progress, targets, {
        keys,
        layout,
        delimiter: format === "tsv" ? "\t" : ",",
        totals,
        currency: doc.household.currency,
      }),
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- keys is derived from picked
    [doc.progress, doc.household.currency, targets, picked, layout, format, totals],
  );
  const toggle = (key: string) =>
    setPicked((p) => {
      const n = new Set(p);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });
  const nothing = keys.length === 0 && !totals;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Export balance history"
        description="One value per account and date. The file imports back unchanged, so you can edit it in a spreadsheet and import it again."
        className="w-[min(96vw,640px)]"
      >
        <div className="flex flex-col gap-4">
          <fieldset>
            <legend className="mb-1.5 flex w-full items-center justify-between text-[12px] font-medium text-ink-2">
              <span>Accounts, assets and debts</span>
              <span className="flex gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setPicked(new Set(targets.map((t) => t.key)))}
                >
                  All
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setPicked(new Set())}>
                  None
                </Button>
              </span>
            </legend>
            <ul className="grid max-h-[220px] gap-1 overflow-y-auto rounded-md border border-border p-2 sm:grid-cols-2">
              {targets.map((t) => (
                <li key={t.key}>
                  <label className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 hover:bg-surface-2 pointer-coarse:min-h-11">
                    <input
                      type="checkbox"
                      className="size-4 accent-[var(--color-accent)]"
                      checked={picked.has(t.key)}
                      onChange={() => toggle(t.key)}
                    />
                    <span className="min-w-0 flex-1 truncate">{t.label}</span>
                    {!recorded.has(t.key) ? (
                      <span className="text-[11px] text-ink-3">no history</span>
                    ) : null}
                  </label>
                </li>
              ))}
            </ul>
          </fieldset>
          <div className="flex flex-wrap items-center gap-3">
            <Segmented
              aria-label="Layout"
              value={layout}
              onChange={setLayout}
              options={[
                { value: "rows", label: "Dates in rows" },
                { value: "columns", label: "Dates in columns" },
              ]}
            />
            <Segmented
              aria-label="File format"
              value={format}
              onChange={setFormat}
              options={[
                { value: "csv", label: "CSV" },
                { value: "tsv", label: "TSV (pastes into spreadsheets)" },
              ]}
            />
          </div>
          <SwitchField
            label="Include net worth, assets and liabilities"
            checked={totals}
            onCheckedChange={setTotals}
          />
          <p className="text-[12px] text-ink-3" role="status">
            {doc.progress.length
              ? `${new Set(doc.progress.map((s) => s.date)).size} dates, ${keys.length} account${keys.length === 1 ? "" : "s"}. A Currency column records ${doc.household.currency}.`
              : "No history yet: the file will hold the headers only."}
          </p>
          {drifted.length ? (
            <div className="flex items-start gap-2 text-[12.5px] text-ink-2" role="note">
              <Info className="mt-0.5 size-4 shrink-0 text-ink-3" aria-hidden />
              <div className="flex flex-col gap-1">
                <p>
                  The file keeps each snapshot’s recorded net worth. Re-valuing those totals is a
                  separate decision and is not done here.
                </p>
                {drifted.slice(0, 3).map((d) => (
                  <p key={d.date}>{driftSentence(formatDay(d.date, f.locale), d.drift, f.money)}</p>
                ))}
                {drifted.length > 3 ? (
                  <p>And {drifted.length - 3} other dates with the same kind of gap.</p>
                ) : null}
              </div>
            </div>
          ) : null}
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              variant="secondary"
              disabled={nothing}
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(text);
                  toast({ title: "Copied", description: "Paste it into a spreadsheet." });
                } catch {
                  toast({ title: "Could not copy", description: "Download the file instead." });
                }
              }}
            >
              <Copy /> Copy
            </Button>
            <Button
              variant="primary"
              disabled={nothing}
              onClick={() =>
                downloadText(
                  `glideworth-balance-history-${todayIso()}.${format}`,
                  text,
                  format === "tsv" ? "text/tab-separated-values;charset=utf-8" : undefined,
                )
              }
            >
              <Download /> Download
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
