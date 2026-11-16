/**
 * Bank files (OFX / QFX / QIF): balances reconciled against Current finances and transactions
 * summarised into yearly spending. Previewed in this browser with the same importer the server
 * uses (`importBankFileInto`), then applied atomically by `POST /households/{id}/import/bank-file`.
 */
import { type BankImportOutcome, importBankFileInto } from "@glideworth/importers";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ArrowRight, CircleAlert, Landmark, Loader2, RotateCcw } from "lucide-react";
import { useMemo, useState } from "react";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardBody, CardHeader } from "../../components/ui/card";
import { Field } from "../../components/ui/input";
import { Select } from "../../components/ui/select";
import { SwitchField } from "../../components/ui/switch";
import { Table, TBody, TD, TH, THead, TR } from "../../components/ui/table";
import { toast } from "../../components/ui/toaster";
import { useAccess } from "../../lib/access";
import { ApiRequestError, api, type BankFileRequest } from "../../lib/api";
import { formatMoney } from "../../lib/format";
import { useActivePlan, useFormat, useWorkspace } from "../../lib/workspace";
import { FileDrop, formatBytes, type PickedFile } from "./file-drop";

/**
 * The apply request, built from the same choices as the in-browser preview so the server reads the
 * file exactly as previewed (in particular a day-first QIF date order).
 */
export function bankApplyRequest(c: {
  text: string;
  format: "ofx" | "qif";
  dateFormat: "auto" | "MM/DD/YYYY" | "DD/MM/YYYY";
  balances: boolean;
  createMissing: boolean;
  planId: string | undefined;
  excluded: string[];
}): BankFileRequest {
  return {
    text: c.text,
    format: c.format,
    ...(c.format === "qif" && c.dateFormat !== "auto" ? { dateFormat: c.dateFormat } : {}),
    balances: c.balances ? { createMissing: c.createMissing } : false,
    ...(c.planId ? { planId: c.planId } : {}),
    ...(c.excluded.length ? { excludeCategories: c.excluded } : {}),
    dryRun: false,
  };
}

export function BankFileImport() {
  const [file, setFile] = useState<PickedFile | null>(null);
  return file ? (
    <BankWorkbench key={file.name} file={file} onReset={() => setFile(null)} />
  ) : (
    <div className="flex flex-col gap-4">
      <p className="max-w-2xl text-[13px] text-ink-2">
        Download a statement from your bank or card provider as OFX, QFX (Quicken) or QIF.
        Glideworth updates the matching balances and turns the transactions into yearly spending by
        category. Account numbers are masked to their last four digits; transfers, income and card
        payments are not counted as spending.
      </p>
      <FileDrop
        accept=".ofx,.qfx,.qif,application/x-ofx,application/vnd.intu.qfx"
        title="Choose an OFX, QFX or QIF file"
        hint="Read in this browser; nothing is saved until you apply it."
        onFile={setFile}
      />
    </div>
  );
}

function BankWorkbench({ file, onReset }: { file: PickedFile; onReset: () => void }) {
  const { data: ws } = useWorkspace();
  const { plan } = useActivePlan();
  const access = useAccess();
  const f = useFormat();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const doc = ws?.doc;
  const [balances, setBalances] = useState(true);
  const [createMissing, setCreateMissing] = useState(false);
  const [spending, setSpending] = useState(true);
  const [planId, setPlanId] = useState<string | undefined>(plan?.id);
  const [dateFormat, setDateFormat] = useState<"auto" | "MM/DD/YYYY" | "DD/MM/YYYY">("auto");
  const [excluded, setExcluded] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const preview = useMemo((): { o?: BankImportOutcome; error?: string } => {
    if (!doc) return {};
    try {
      return {
        o: importBankFileInto(
          doc,
          file.text,
          {
            ...(dateFormat !== "auto" ? { dateFormat } : {}),
            balances: balances ? { createMissing } : false,
            ...(spending && planId ? { transactionsToPlanId: planId } : {}),
            excludeCategories: excluded,
          },
          { dryRun: true },
        ),
      };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }, [doc, file.text, balances, createMissing, spending, planId, excluded, dateFormat]);
  const o = preview.o;
  const blocking = (o?.issues ?? []).filter((i) => i.severity === "error");
  const online = ws?.source === "api";
  const canApply =
    !!o &&
    blocking.length === 0 &&
    online &&
    access.canWrite &&
    (balances || (spending && !!planId));
  const money = (v: number, currency?: string) =>
    formatMoney(v, { locale: f.locale, currency: currency ?? f.currency });

  const apply = async () => {
    if (!doc || !o) return;
    setBusy(true);
    try {
      await api.importBankFile(
        doc.household.id,
        bankApplyRequest({
          text: file.text,
          format: o.format,
          dateFormat,
          balances,
          createMissing,
          planId: spending ? planId : undefined,
          excluded,
        }),
      );
      await qc.invalidateQueries({ queryKey: ["workspace"] });
      await qc.invalidateQueries({ queryKey: ["snapshots"] });
      const rec = o.reconciliation;
      toast({
        title: `${o.format.toUpperCase()} file imported`,
        description: [
          rec
            ? `${rec.matched.length} ${rec.matched.length === 1 ? "balance" : "balances"} updated`
            : null,
          rec?.created.length ? `${rec.created.length} added` : null,
          spending && planId ? `${o.summary.events.length} yearly expenses added` : null,
        ]
          .filter(Boolean)
          .join(", "),
        tone: "positive",
        action: {
          label: "View",
          onClick: () =>
            void navigate({ to: spending && planId ? `/plans/${planId}` : "/finances" }),
        },
      });
      onReset();
    } catch (e) {
      toast({
        title: "Import failed",
        description:
          e instanceof ApiRequestError && e.code === "IMPORT_FAILED"
            ? `${e.message}. Nothing was changed.`
            : e instanceof Error
              ? e.message
              : String(e),
        tone: "negative",
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <Card>
        <CardHeader
          eyebrow={o ? `${o.format.toUpperCase()} file` : "Bank file"}
          title={file.name}
          actions={
            <>
              <span className="text-[12px] text-ink-3">{formatBytes(file.size, f.locale)}</span>
              <Button size="sm" variant="ghost" onClick={onReset}>
                <RotateCcw /> Choose another
              </Button>
            </>
          }
        />
        <CardBody className="flex flex-col gap-4">
          {preview.error ? (
            <p
              role="alert"
              className="flex gap-2 rounded-lg bg-negative-soft px-3 py-2 text-[12.5px] text-negative"
            >
              <CircleAlert className="mt-0.5 size-4 shrink-0" /> {preview.error}
            </p>
          ) : null}
          <div className="grid gap-4 md:grid-cols-2">
            <div className="flex flex-col gap-3">
              <SwitchField
                label="Update balances"
                hint="Match accounts by name and set their balance from the statement."
                checked={balances}
                onCheckedChange={setBalances}
              />
              {balances ? (
                <SwitchField
                  label="Add accounts that are not in Glideworth yet"
                  hint="Otherwise they are listed and skipped."
                  checked={createMissing}
                  onCheckedChange={setCreateMissing}
                />
              ) : null}
            </div>
            <div className="flex flex-col gap-3">
              <SwitchField
                label="Turn transactions into yearly spending"
                hint="One expense per category, added to a plan."
                checked={spending}
                onCheckedChange={setSpending}
              />
              {spending ? (
                <Field label="Add spending to">
                  {(id) => (
                    <Select
                      id={id}
                      value={planId}
                      onValueChange={setPlanId}
                      placeholder="Choose a plan"
                      options={(doc?.plans ?? []).map((p) => ({ value: p.id, label: p.name }))}
                    />
                  )}
                </Field>
              ) : null}
              {o?.format === "qif" ? (
                <Field
                  label="Date order"
                  hint="QIF files do not say; Glideworth guesses month-first unless days exceed 12."
                >
                  {(id) => (
                    <Select
                      id={id}
                      value={dateFormat}
                      onValueChange={setDateFormat}
                      options={[
                        { value: "auto", label: "Detect" },
                        { value: "MM/DD/YYYY", label: "Month / day / year" },
                        { value: "DD/MM/YYYY", label: "Day / month / year" },
                      ]}
                    />
                  )}
                </Field>
              ) : null}
            </div>
          </div>
        </CardBody>
      </Card>

      {o ? (
        <>
          <Card>
            <CardHeader
              eyebrow="Found in the file"
              title={`${o.accounts.length} ${o.accounts.length === 1 ? "account" : "accounts"}`}
            />
            <Table>
              <THead>
                <TR>
                  <TH>Account</TH>
                  <TH>Type</TH>
                  <TH numeric>Balance</TH>
                  <TH numeric>In Glideworth</TH>
                </TR>
              </THead>
              <TBody>
                {o.accounts.map((a) => {
                  const match = o.reconciliation?.matched.find((m) => m.row.name === a.name);
                  const created = o.reconciliation?.created.find((c) => c.row.name === a.name);
                  return (
                    <TR key={a.key}>
                      <TD>
                        <span className="flex items-center gap-2">
                          <Landmark className="size-3.5 text-ink-3" /> {a.name}
                          {a.currency && a.currency !== doc?.household.currency ? (
                            <Badge>{a.currency}</Badge>
                          ) : null}
                        </span>
                      </TD>
                      <TD className="text-ink-2">
                        {a.entity === "debt" ? "Debt" : (a.type ?? "Account")}
                      </TD>
                      <TD numeric>
                        {a.balance !== undefined ? money(a.balance, a.currency) : "—"}
                      </TD>
                      <TD numeric className="text-ink-2">
                        {!balances
                          ? "Not updated"
                          : match
                            ? `${money(match.before)} → ${money(match.after)}`
                            : created
                              ? "Will be added"
                              : "Skipped (no match)"}
                      </TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          </Card>

          {spending ? (
            <Card>
              <CardHeader
                eyebrow={
                  o.summary.range
                    ? `${o.summary.transactions} transactions · ${o.summary.range.from} to ${o.summary.range.to}`
                    : `${o.summary.transactions} transactions`
                }
                title={`Spending: ${money(o.summary.totalAnnual)} a year`}
              />
              {o.summary.categories.length === 0 ? (
                <CardBody className="text-ink-3">No spending found.</CardBody>
              ) : (
                <Table>
                  <THead>
                    <TR>
                      <TH>Category</TH>
                      <TH numeric>A year</TH>
                      <TH numeric>Include</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {o.summary.categories.map((c) => (
                      <TR key={c.category}>
                        <TD>{c.category}</TD>
                        <TD numeric>{money(c.annual)}</TD>
                        <TD numeric>
                          <input
                            type="checkbox"
                            aria-label={`Include ${c.category}`}
                            className="accent-[var(--accent)]"
                            checked={!excluded.includes(c.category)}
                            onChange={(e) =>
                              setExcluded((x) =>
                                e.target.checked
                                  ? x.filter((y) => y !== c.category)
                                  : [...x, c.category],
                              )
                            }
                          />
                        </TD>
                      </TR>
                    ))}
                    {excluded
                      .filter((x) => !o.summary.categories.some((c) => c.category === x))
                      .map((x) => (
                        <TR key={x}>
                          <TD className="text-ink-3">{x}</TD>
                          <TD numeric className="text-ink-3">
                            excluded
                          </TD>
                          <TD numeric>
                            <input
                              type="checkbox"
                              aria-label={`Include ${x}`}
                              className="accent-[var(--accent)]"
                              checked={false}
                              onChange={() => setExcluded((e) => e.filter((y) => y !== x))}
                            />
                          </TD>
                        </TR>
                      ))}
                  </TBody>
                </Table>
              )}
              {o.summary.excluded.length ? (
                <CardBody className="pt-2 text-[12px] text-ink-3">
                  Not counted as spending:{" "}
                  {o.summary.excluded.map((x) => `${x.category} (${x.count})`).join(", ")}.
                </CardBody>
              ) : null}
            </Card>
          ) : null}

          {o.issues.length ? (
            <Card>
              <CardHeader
                eyebrow="Check"
                title={`${o.issues.length} ${o.issues.length === 1 ? "note" : "notes"}`}
              />
              <CardBody className="flex flex-col gap-1.5">
                {o.issues.slice(0, 20).map((i) => (
                  <div
                    key={`${i.code}-${i.sourcePath}-${i.message}`}
                    className="flex gap-2 text-[12.5px]"
                  >
                    <Badge
                      tone={
                        i.severity === "error"
                          ? "negative"
                          : i.severity === "warning"
                            ? "ochre"
                            : "neutral"
                      }
                    >
                      {i.severity}
                    </Badge>
                    <span>{i.message}</span>
                  </div>
                ))}
              </CardBody>
            </Card>
          ) : null}
        </>
      ) : null}

      <div className="flex items-center justify-end gap-3">
        {!online ? (
          <span className="text-[12px] text-ink-3">The server is offline; preview only.</span>
        ) : !access.canWrite ? (
          <span className="text-[12px] text-ink-3">View only: you cannot import.</span>
        ) : null}
        <Button variant="primary" onClick={apply} disabled={!canApply || busy}>
          {busy ? <Loader2 className="animate-spin" /> : <ArrowRight />} Apply import
        </Button>
      </div>
    </div>
  );
}
