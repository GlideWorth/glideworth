/**
 * Bank files (OFX / QFX / QIF): balances reconciled against Current finances and transactions
 * summarised into yearly spending. Previewed in this browser with the same importer the server
 * uses (`importBankFileInto`), then applied atomically by `POST /households/{id}/import/bank-file`.
 */
import { type BankImportOutcome, importBankFileInto } from "@glideworth/importers";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ArrowRight, CircleAlert, Landmark, Loader2, RotateCcw, TriangleAlert } from "lucide-react";
import { useMemo, useState } from "react";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardBody, CardHeader } from "../../components/ui/card";
import { Field } from "../../components/ui/input";
import { NumberInput } from "../../components/ui/number-input";
import { Select } from "../../components/ui/select";
import { SwitchField } from "../../components/ui/switch";
import { Table, TBody, TD, TH, THead, TR } from "../../components/ui/table";
import { toast } from "../../components/ui/toaster";
import { useAccess } from "../../lib/access";
import { ApiRequestError, api, type BankFileRequest } from "../../lib/api";
import { formatDay, formatMoney, plural } from "../../lib/format";
import { makeFormatter, useActivePlan, useFormat } from "../../lib/workspace";
import { hasPair } from "../currency/fx";
import { FileDrop, formatBytes, type PickedFile } from "./file-drop";
import { persistWorkspace } from "./persist";
import { useImportTarget } from "./starter";

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
  fxRates?: { from: string; to: string; rate: number }[];
}): BankFileRequest {
  return {
    text: c.text,
    format: c.format,
    ...(c.format === "qif" && c.dateFormat !== "auto" ? { dateFormat: c.dateFormat } : {}),
    balances: c.balances ? { createMissing: c.createMissing } : false,
    ...(c.planId ? { planId: c.planId } : {}),
    ...(c.excluded.length ? { excludeCategories: c.excluded } : {}),
    ...(c.fxRates?.length ? { fxRates: c.fxRates } : {}),
    dryRun: false,
  };
}

/**
 * Spending follows the plan the user picked, or the plan already open. The choice is not frozen at
 * the moment the file is chosen: the household may still be loading then, and an unset id would
 * drop every included expense.
 */
export function spendingPlanId(
  picked: string | undefined,
  active: string | undefined,
): string | undefined {
  return picked ?? active;
}

/** The server refuses a bank file over 2,000,000 characters (`MAX_BANK_FILE_CHARS` in the API). */
export const BANK_FILE_LIMIT = {
  chars: 2_000_000,
  message: (size: string) =>
    `That file is ${size}. Bank files can be up to 2 MB; export a shorter date range from your bank and try again.`,
};

/** An importer note in this screen's words (the API's wording names request fields). */
export function bankIssueText(i: { code?: string; message: string }): string {
  if (i.code === "csv.unmatched")
    return "No account in Glideworth matches this one, so its balance is skipped. Turn on “Add accounts that are not in Glideworth yet” to add it.";
  if (i.code === "qif.date-order")
    return "Dates were read month first (US style). If your bank writes the day first, set Date order to “Day / month / year”.";
  return i.message;
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
        hint="Up to 2 MB. Read in this browser; nothing is saved until you apply it."
        maxChars={BANK_FILE_LIMIT}
        onFile={setFile}
      />
    </div>
  );
}

function BankWorkbench({ file, onReset }: { file: PickedFile; onReset: () => void }) {
  const { ws, doc, reachable } = useImportTarget();
  const { plan } = useActivePlan();
  const access = useAccess();
  const workspaceFormat = useFormat();
  const f =
    ws?.firstRun && doc
      ? makeFormatter({
          locale: doc.settings?.locale ?? doc.household.locale,
          currency: doc.household.currency,
        })
      : workspaceFormat;
  const qc = useQueryClient();
  const navigate = useNavigate();
  const base = doc?.household.currency ?? f.currency;
  const [balances, setBalances] = useState(true);
  const [createMissing, setCreateMissing] = useState(false);
  const [spending, setSpending] = useState(true);
  const [pickedPlanId, setPickedPlanId] = useState<string | undefined>(undefined);
  const planId = spendingPlanId(pickedPlanId, plan?.id);
  // A new workspace has no saved plan yet, so spending lands on the blank plan this import creates.
  const chosenPlanId = planId ?? doc?.plans[0]?.id;
  const [dateFormat, setDateFormat] = useState<"auto" | "MM/DD/YYYY" | "DD/MM/YYYY">("auto");
  const [excluded, setExcluded] = useState<string[]>([]);
  const [rateInput, setRateInput] = useState<Record<string, number | null>>({});
  const [busy, setBusy] = useState(false);
  const proposedRates = useMemo(
    () =>
      Object.entries(rateInput).flatMap(([from, rate]) =>
        rate !== null && rate > 0 ? [{ from, to: base, rate }] : [],
      ),
    [rateInput, base],
  );

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
            ...(spending && chosenPlanId ? { transactionsToPlanId: chosenPlanId } : {}),
            excludeCategories: excluded,
            ...(proposedRates.length ? { fxRates: proposedRates } : {}),
          },
          { dryRun: true },
        ),
      };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }, [
    doc,
    file.text,
    balances,
    createMissing,
    spending,
    chosenPlanId,
    excluded,
    dateFormat,
    proposedRates,
  ]);
  const o = preview.o;
  const needingRate = useMemo(() => {
    if (!o || !doc) return [];
    const codes = new Set<string>();
    for (const a of o.accounts) if (a.currency && a.currency !== base) codes.add(a.currency);
    for (const e of o.summary.events) if (e.currency && e.currency !== base) codes.add(e.currency);
    return [...codes].filter((c) => !hasPair(doc.finances.fxRates ?? [], c, base)).sort();
  }, [o, doc, base]);
  const fxRates = needingRate.flatMap((c) => {
    const rate = rateInput[c];
    return rate !== null && rate !== undefined && rate > 0 ? [{ from: c, to: base, rate }] : [];
  });
  const ratesReady = needingRate.every((c) => (rateInput[c] ?? 0) > 0);
  const blocking = (o?.issues ?? []).filter((i) => i.severity === "error");
  const offline = !!ws && !reachable;
  const canApply =
    !!o &&
    blocking.length === 0 &&
    ratesReady &&
    reachable &&
    access.canWrite &&
    (balances || (spending && !!chosenPlanId));
  const money = (v: number, currency?: string) =>
    formatMoney(v, { locale: f.locale, currency: currency ?? f.currency });

  const apply = async () => {
    if (!doc || !o) return;
    setBusy(true);
    try {
      if (ws?.firstRun) {
        // Same choices as the preview, written onto the blank plan and created on the server.
        const applied = importBankFileInto(
          doc,
          file.text,
          {
            ...(dateFormat !== "auto" ? { dateFormat } : {}),
            balances: balances ? { createMissing } : false,
            ...(spending && chosenPlanId ? { transactionsToPlanId: chosenPlanId } : {}),
            excludeCategories: excluded,
            ...(fxRates.length ? { fxRates } : {}),
          },
          { dryRun: false },
        );
        const block = applied.issues.find((i) => i.severity === "error");
        if (block) throw new Error(block.message);
        await persistWorkspace(qc, applied.document);
      } else {
        await api.importBankFile(
          doc.household.id,
          bankApplyRequest({
            text: file.text,
            format: o.format,
            dateFormat,
            balances,
            createMissing,
            planId: spending ? chosenPlanId : undefined,
            excluded,
            fxRates,
          }),
        );
      }
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
          spending && chosenPlanId ? `${o.summary.events.length} yearly expenses added` : null,
        ]
          .filter(Boolean)
          .join(", "),
        tone: "positive",
        action: {
          label: "View",
          onClick: () =>
            void navigate({
              to: spending && chosenPlanId ? `/plans/${chosenPlanId}` : "/finances",
            }),
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
                      value={chosenPlanId ?? ""}
                      onValueChange={setPickedPlanId}
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
                    ? `${plural(o.summary.transactions, "transaction")} · ${formatDay(o.summary.range.from, f.locale)} to ${formatDay(o.summary.range.to, f.locale)}`
                    : plural(o.summary.transactions, "transaction")
                }
                title={(() => {
                  const currencies = [
                    ...new Set(o.summary.categories.map((c) => c.currency ?? base)),
                  ];
                  return currencies.length === 1
                    ? `Spending: ${money(o.summary.totalAnnual, currencies[0] === base ? undefined : currencies[0])} a year`
                    : "Spending by category";
                })()}
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
                        <TD numeric>{money(c.annual, c.currency)}</TD>
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
                    <span>{bankIssueText(i)}</span>
                  </div>
                ))}
              </CardBody>
            </Card>
          ) : null}
        </>
      ) : null}

      {needingRate.length ? (
        <div
          role="alert"
          className="flex flex-col gap-3 rounded-lg border border-ochre/40 bg-ochre-soft px-3 py-3 text-[13px] text-ochre"
        >
          <div className="flex gap-2">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" />
            <p>
              {needingRate.length === 1
                ? `${needingRate[0]} has no exchange rate to ${base}.`
                : `${needingRate.join(", ")} have no exchange rate to ${base}.`}{" "}
              Enter one before applying. Without it the plan cannot be simulated, and that money is
              left out of net worth. The rate is saved with your other exchange rates.
            </p>
          </div>
          {needingRate.map((c) => (
            <label key={c} className="flex flex-wrap items-center gap-2 text-ink">
              <span className="text-[12.5px] font-medium">1 {c} equals</span>
              <NumberInput
                aria-label={`${c} to ${base} exchange rate`}
                decimals={4}
                className="w-36"
                value={rateInput[c] ?? null}
                onValueChange={(v) => setRateInput((prev) => ({ ...prev, [c]: v }))}
              />
              <span className="text-[12.5px] font-medium">{base}</span>
            </label>
          ))}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-end gap-3">
        {offline ? (
          <span className="text-[12px] text-ink-3">The server is offline; preview only.</span>
        ) : ws?.firstRun ? (
          <span className="text-[12px] text-ink-3">
            Nothing is set up yet. Applying this import creates your plan.
          </span>
        ) : !access.canWrite ? (
          <span className="text-[12px] text-ink-3">View only: you cannot import.</span>
        ) : !ratesReady ? (
          <span className="text-[12px] text-ochre">
            Enter{" "}
            {needingRate.length === 1
              ? `a ${needingRate[0]} to ${base} rate`
              : "the missing exchange rates"}{" "}
            to apply.
          </span>
        ) : null}
        <Button variant="primary" onClick={apply} disabled={!canApply || busy}>
          {busy ? <Loader2 className="animate-spin" /> : <ArrowRight />} Apply import
        </Button>
      </div>
    </div>
  );
}
