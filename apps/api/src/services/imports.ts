import type { Actor, GlideworthDocument } from "@glideworth/core";
import { z } from "zod";
import { type ImportDeps, importDeps } from "../deps.js";
import { ApiError } from "../errors.js";
import { checkImportSize, checkPlanCount } from "../jobs/import-limits.js";
import { type ImportPool, sharedImportPool } from "../jobs/import-pool.js";
import { historyTargets } from "@glideworth/importers";
import {
  type DocumentImportResult,
  type HistoryParseResult,
  type HouseholdImportResult,
  type ImportTask,
  type ImportTaskResult,
  type ImportWrites,
  runImportTask,
} from "../jobs/import-task.js";
import type { ServiceCtx } from "./context.js";
import type { BalanceHistoryImportBody, BalanceHistoryImportResult } from "./history.js";
import type { HouseholdsService } from "./households.js";
import type { PlansService } from "./plans.js";

export const ImportBody = z
  .object({
    format: z
      .enum(["glideworth", "cairn", "projectionlab", "auto"])
      .default("auto")
      .describe(
        "'glideworth' = a Glideworth export ('cairn', its name before the rename, is accepted too); 'projectionlab' = a ProjectionLab export file.",
      ),
    data: z.unknown().describe("The parsed JSON document."),
    mode: z
      .enum(["create", "replace", "merge"])
      .default("create")
      .describe(
        "'create' fails with 409 if the household id exists. 'replace' makes the document the household (plans and snapshots not in it are removed). 'merge' updates the household and the plans in the document and keeps everything else. In both, existing plans keep their version history and the import is recorded as a new 'imported' version.",
      ),
    dryRun: z
      .boolean()
      .default(false)
      .describe("Validate and report issues/stats without writing anything."),
    householdId: z
      .string()
      .optional()
      .describe("ProjectionLab only: id to give the imported household."),
  })
  .meta({ id: "ImportRequest" });
export type ImportBody = z.infer<typeof ImportBody>;

/** Options shared by the CSV importers (see @glideworth/importers `CsvOptions`). */
const CsvOptionsBody = z
  .object({
    preset: z
      .string()
      .optional()
      .describe("A bank/app preset id, 'auto' (default: match by headers) or 'none'."),
    locale: z.enum(["en-GB", "en-US", "auto"]).optional(),
    delimiter: z.enum([",", ";", "\t", "|"]).optional(),
    decimalSeparator: z.enum([".", ","]).optional(),
    dateFormat: z.enum(["YYYY-MM-DD", "DD/MM/YYYY", "MM/DD/YYYY", "auto"]).optional(),
    defaultDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe("Date for rows that carry none."),
    columns: z
      .record(z.string(), z.string())
      .optional()
      .describe(
        "Explicit mapping of logical field (date, account, balance, netWorth, amount...) to header text.",
      ),
    accountMap: z
      .record(z.string(), z.string())
      .optional()
      .describe("account-balances: CSV account label -> Glideworth account id."),
    createMissing: z
      .boolean()
      .optional()
      .describe("account-balances: create accounts that do not exist yet."),
    mode: z
      .enum(["merge", "replace"])
      .optional()
      .describe("progress-snapshots: merge (default) or replace history."),
    outflow: z
      .enum(["negative", "positive"])
      .optional()
      .describe(
        "transactions: sign of money spent in a single Amount column. Overrides the preset and the sign read from the data (csv.sign-inferred / csv.sign-unknown).",
      ),
  })
  .meta({ id: "CsvImportOptions" });

export const CsvImportBody = z
  .object({
    text: z.string().max(10_000_000).describe("CSV text."),
    kind: z.enum(["account-balances", "progress-snapshots", "transactions"]),
    options: CsvOptionsBody.optional(),
    planId: z
      .string()
      .optional()
      .describe("transactions: the plan that receives the summarised expense events."),
    dryRun: z
      .boolean()
      .default(true)
      .describe(
        "true (default) = preview only: analysis, issues and a reconciliation, nothing is written.",
      ),
  })
  .meta({ id: "CsvImportRequest" });
export type CsvImportBody = z.infer<typeof CsvImportBody>;

export const CsvAnalyzeBody = z
  .object({
    text: z.string().max(10_000_000),
    kind: z.enum(["account-balances", "progress-snapshots", "transactions"]),
    options: CsvOptionsBody.optional(),
  })
  .meta({ id: "CsvAnalyzeRequest" });
export type CsvAnalyzeBody = z.infer<typeof CsvAnalyzeBody>;

/** Imports one workspace may have running at once; more are `429 RATE_LIMITED` (security review finding 4). */
const MAX_IMPORTS_PER_WORKSPACE = 2;

/**
 * Where import tasks run: the process's worker pool (default), or `"inline"` (in-process; tests). Fake
 * importers (`ctx.imports` replaced in tests) always run in-process: a worker thread only has the real ones.
 */
export type ImportRunnerOption = ImportPool | "inline";

export class ImportsService {
  private inFlight = 0;

  constructor(
    private readonly ctx: ServiceCtx,
    private readonly households: HouseholdsService,
    private readonly plans: PlansService,
    private readonly runner: ImportRunnerOption = sharedImportPool(),
  ) {}

  /** Imports waiting for or running in a worker thread. */
  busy(): boolean {
    return this.inFlight > 0;
  }

  /**
   * Hand the CPU-heavy part to a worker thread and wait for it; the event loop keeps serving other requests
   * (security review finding 4). Limits: see `ImportPool` and `MAX_IMPORTS_PER_WORKSPACE`.
   */
  private async run<T extends ImportTaskResult>(task: ImportTask): Promise<T> {
    if (this.inFlight >= MAX_IMPORTS_PER_WORKSPACE)
      throw new ApiError(
        429,
        "RATE_LIMITED",
        `this workspace already has ${MAX_IMPORTS_PER_WORKSPACE} imports running; try again when one finishes`,
        { retryAfterSeconds: 5 },
      );
    this.inFlight++;
    try {
      const deps = this.ctx.imports;
      if (this.runner === "inline" || deps !== importDeps) return runImportTask(task, deps) as T;
      return (await this.runner.run(task)) as T;
    } finally {
      this.inFlight--;
    }
  }

  /** Import a whole workspace (Glideworth export or ProjectionLab JSON). */
  async import(body: ImportBody, actor: Actor) {
    // Cheap bounds on the request thread, before the document is copied to a worker (security review pass 3).
    checkImportSize(body.data);
    if (body.format !== "projectionlab") checkPlanCount(body.data);
    const r = await this.run<DocumentImportResult>({
      op: "document",
      format: body.format,
      data: body.data,
      dryRun: body.dryRun,
      ...(body.householdId ? { householdId: body.householdId } : {}),
    });
    if (body.dryRun) return { ...r.preview, imported: false };
    if (r.blocking)
      throw new ApiError(
        422,
        "IMPORT_FAILED",
        "the import has blocking errors; run with dryRun=true to inspect them",
        { issues: r.blocking },
      );
    // Snapshots go in through the bulk path: `importDocument` reads and validates the household once per
    // snapshot, so many snapshots of a household with many accounts took time proportional to their product
    // (security review pass 3). Same outcome in one transaction: a snapshot id that exists is a conflict, except
    // in `merge`, which replaces it.
    const document = r.document!;
    this.households.db.transaction(() => {
      this.households.importDocument({ ...document, progress: [] }, actor, body.mode, {
        validated: true,
      });
      if (document.progress.length > 0)
        this.households.bulkImportSnapshots(
          document.household.id,
          document.progress,
          body.mode === "merge" ? "replace" : "error",
        );
    });
    return { ...r.preview, imported: true };
  }

  /** Detect delimiter, preset, columns and formats of a CSV without importing anything. */
  async analyzeCsv(body: CsvAnalyzeBody) {
    const r = await this.run<{ op: "csv-analyze"; analysis: unknown }>({
      op: "csv-analyze",
      text: body.text,
      kind: body.kind,
      ...(body.options ? { options: body.options } : {}),
    });
    return r.analysis as ReturnType<ImportDeps["analyzeCsv"]>;
  }

  /**
   * CSV import into a household: account balances, progress/net-worth history or transactions
   * (summarised into annual expense events on `planId`). `dryRun` (the default) previews only.
   * Applying is atomic: finances, snapshots and the plan are written in one transaction.
   */
  importCsv(householdId: string, body: CsvImportBody, actor: Actor) {
    const doc = this.households.getDocument(householdId);
    const request =
      body.kind === "transactions"
        ? { kind: body.kind, planId: this.requirePlan(body.planId), options: body.options as never }
        : ({ kind: body.kind, options: body.options } as never);
    return this.applyHousehold(
      householdId,
      doc,
      {
        op: "csv",
        doc,
        text: body.text,
        request,
        dryRun: body.dryRun,
        replaceProgress: body.options?.mode === "replace",
      },
      actor,
      "the CSV has blocking errors; run with dryRun=true to inspect them",
    );
  }

  /**
   * Balance-history import: rows already mapped (the web app), or CSV/TSV text read in the import thread with
   * the same code the web app runs. Planning and writing happen in `HouseholdsService.importBalanceHistory`.
   */
  async importBalanceHistory(
    householdId: string,
    body: BalanceHistoryImportBody,
    actor: Actor,
  ): Promise<BalanceHistoryImportResult> {
    const today = this.households.resolveToday(body.today);
    const input = {
      mode: body.mode,
      dryRun: body.dryRun,
      updateCurrent: body.updateCurrentBalances,
      today,
    };
    if (body.rows)
      return this.households.importBalanceHistory(
        householdId,
        { ...input, rows: body.rows },
        actor,
      );
    const { household, finances } = this.households.get(householdId);
    const o = body.options ?? {};
    const r = await this.run<HistoryParseResult>({
      op: "history-parse",
      text: body.text ?? "",
      options: {
        targets: historyTargets(finances, household.currency),
        today,
        ...(o.delimiter ? { delimiter: o.delimiter } : {}),
        ...(o.layout ? { layout: o.layout } : {}),
        ...(o.dateFormat ? { dateFormat: o.dateFormat } : {}),
        ...(o.decimalSeparator ? { decimalSeparator: o.decimalSeparator } : {}),
        ...(o.periodDay ? { periodDay: o.periodDay } : {}),
        ...(o.columns ? { columns: o.columns } : {}),
      },
    });
    const issues = [...r.issues];
    if (body.mode === "replace" && r.badDates > 0)
      issues.unshift({
        severity: "error",
        code: "history.replace.bad-dates",
        message:
          "Replace needs every date to be readable: a row whose date could not be read might hold values Replace would clear",
      });
    const cellsBlock = !r.blocked && r.cellErrors > 0 && !body.skipInvalid;
    if (cellsBlock)
      issues.push({
        severity: "error",
        code: "history.cells.invalid",
        message: `${r.cellErrors} cell${r.cellErrors === 1 ? " has" : "s have"} errors (listed with their cell references); fix them, or pass skipInvalid=true to import the rest`,
      });
    // Skipped cells are reported, but they no longer stop the import.
    for (const i of r.cellIssues)
      issues.push(
        body.skipInvalid && i.severity === "error"
          ? { ...i, severity: "warning", message: `skipped: ${i.message}` }
          : i,
      );
    const out = this.households.importBalanceHistory(
      householdId,
      { ...input, rows: r.rows },
      actor,
      {
        issues,
        blocked: r.blocked || cellsBlock || (r.badDates > 0 && body.mode === "replace"),
      },
    );
    return { ...out, parse: r.parse };
  }

  private requirePlan(planId: string | undefined): string {
    if (!planId) throw new ApiError(400, "VALIDATION", "kind 'transactions' needs `planId`");
    return planId;
  }

  /** Run a CSV task, then (apply) write its result unless the household changed meanwhile. */
  private async applyHousehold(
    householdId: string,
    before: GlideworthDocument,
    task: Extract<ImportTask, { op: "csv" }>,
    actor: Actor,
    blockingMessage: string,
  ): Promise<Record<string, unknown>> {
    const stamp = task.dryRun ? "" : this.stamp(householdId, before);
    const r = await this.run<HouseholdImportResult>(task);
    if (task.dryRun) return r.preview;
    if (r.blocking)
      throw new ApiError(422, "IMPORT_FAILED", blockingMessage, { issues: r.blocking });
    const changes = this.applyWrites(householdId, stamp, r.writes!, actor);
    return { ...r.preview, applied: true, changes };
  }

  /** The household as the import saw it (its version, plans and snapshots). */
  private stamp(householdId: string, doc: GlideworthDocument): string {
    return JSON.stringify([
      this.households.version(householdId),
      doc.household,
      doc.finances,
      doc.plans.map((p) => [p.id, p.version]),
      doc.progress,
    ]);
  }

  /**
   * Write an import's result atomically. The import was worked out on a copy read before the worker ran; if
   * the household changed since, nothing is written (409, run it again).
   */
  private applyWrites(householdId: string, stamp: string, writes: ImportWrites, actor: Actor) {
    const changes = {
      finances: false,
      snapshots: { created: 0, replaced: 0, removed: 0 },
      plans: [] as string[],
    };
    this.households.db.transaction(() => {
      if (this.stamp(householdId, this.households.getDocument(householdId)) !== stamp)
        throw new ApiError(
          409,
          "VERSION_CONFLICT",
          "the household changed while the import was being prepared; nothing was written. Run the import again",
        );
      if (writes.finances) {
        this.households.replaceCurrent(
          householdId,
          { finances: writes.finances },
          undefined,
          actor,
        );
        changes.finances = true;
      }
      if (writes.snapshots.length) {
        const r = this.households.bulkImportSnapshots(
          householdId,
          writes.snapshots as never,
          "replace",
        );
        changes.snapshots.created = r.created;
        changes.snapshots.replaced = r.replaced;
      }
      for (const id of writes.removeSnapshotIds) {
        this.households.deleteSnapshot(householdId, id);
        changes.snapshots.removed++;
      }
      for (const p of writes.plans) {
        this.plans.write(p.id, () => p, { actor, message: "CSV import" });
        changes.plans.push(p.id);
      }
    });
    return changes;
  }
}
