import type { Actor, GlideworthDocument } from "@glideworth/core";
import { migrateDocument } from "@glideworth/core";
import type { BankImportRequest, QifDateFormat, TransactionOptions } from "@glideworth/importers";
import { z } from "zod";
import { ApiError } from "../errors.js";
import type { ServiceCtx } from "./context.js";
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

/**
 * Largest bank file the import accepts, in characters (2 MB of text; years of statements fit). The
 * file is parsed on the request thread, so its size bounds how long one import can hold the server
 * (security review finding 4). The MCP bank-file tools declare the same limit.
 */
export const MAX_BANK_FILE_CHARS = 2_000_000;
const BANK_FILE_TOO_LARGE = `the file is larger than the 2 MB limit (${MAX_BANK_FILE_CHARS.toLocaleString("en-US")} characters); export a shorter date range`;

export const BankFileImportBody = z
  .object({
    text: z
      .string()
      .max(MAX_BANK_FILE_CHARS, BANK_FILE_TOO_LARGE)
      .describe(
        "The OFX / QFX / QIF file contents. At most 2 MB of text (2,000,000 characters); a larger file is a `400 VALIDATION`.",
      ),
    format: z.enum(["ofx", "qif", "auto"]).default("auto").describe("'auto' sniffs the header."),
    dateFormat: z
      .enum(["auto", "MM/DD/YYYY", "DD/MM/YYYY", "MDY", "DMY", "YMD"])
      .optional()
      .describe(
        "QIF only: date order. 'DD/MM/YYYY' (alias 'DMY') for day-first files, 'MM/DD/YYYY' (alias 'MDY') for month-first; 'auto' (default) reads month-first unless a day above 12 proves day-first. ISO dates (YYYY-MM-DD, alias 'YMD') are always recognised.",
      ),
    accountName: z
      .string()
      .max(120)
      .optional()
      .describe("QIF only: name for a file without an !Account header."),
    balances: z
      .union([
        z.literal(false),
        z.object({
          accountMap: z
            .record(z.string(), z.string())
            .optional()
            .describe("File account name -> Glideworth account id."),
          createMissing: z
            .boolean()
            .optional()
            .describe("Create accounts / debts that do not exist yet."),
        }),
      ])
      .optional()
      .describe("Update balances from the file (default: match by name). `false` skips balances."),
    planId: z.string().optional().describe("Add the annual expense summary to this plan."),
    annualise: z
      .union([z.enum(["last-12-months", "all", "latest-full-year"]), z.boolean()])
      .optional()
      .describe(
        "How each category's yearly figure is derived: 'last-12-months' (default; a shorter file is scaled up), 'all' (total over the whole span, scaled to a year) or 'latest-full-year'. The legacy boolean maps true to 'all' and false to 'last-12-months'.",
      ),
    categoryMap: z
      .record(z.string(), z.string())
      .optional()
      .describe("Payee/category text -> expense type."),
    excludeCategories: z.array(z.string()).max(100).optional(),
    dryRun: z
      .boolean()
      .default(true)
      .describe("true (default) = preview only: nothing is written."),
  })
  .meta({ id: "BankFileImportRequest" });
export type BankFileImportBody = z.infer<typeof BankFileImportBody>;

type Annualise = NonNullable<TransactionOptions["annualise"]>;

/** The route accepts the importer's vocabulary and short aliases; the importer only understands its own. */
export function bankDateFormat(v: BankFileImportBody["dateFormat"]): QifDateFormat | undefined {
  if (v === undefined) return undefined;
  if (v === "DMY") return "DD/MM/YYYY";
  if (v === "MDY") return "MM/DD/YYYY";
  // ISO dates are recognised whatever the setting; YMD leaves the order of slash dates to detection.
  if (v === "YMD") return "auto";
  return v;
}

export function bankAnnualise(v: BankFileImportBody["annualise"]): Annualise | undefined {
  if (v === undefined) return undefined;
  if (typeof v === "boolean") return v ? "all" : "last-12-months";
  return v;
}

export class ImportsService {
  constructor(
    private readonly ctx: ServiceCtx,
    private readonly households: HouseholdsService,
    private readonly plans: PlansService,
  ) {}

  /** Import a whole workspace (Glideworth export or ProjectionLab JSON). */
  import(body: ImportBody, actor: Actor) {
    let format = body.format;
    if (format === "auto")
      format = this.ctx.imports.detectProjectionLabExport(body.data)
        ? "projectionlab"
        : "glideworth";
    let document: GlideworthDocument;
    let issues: unknown[] = [];
    let stats: Record<string, number> = {};
    let report: unknown;
    if (format === "projectionlab") {
      const r = this.ctx.imports.importProjectionLab(
        body.data,
        body.householdId ? { householdId: body.householdId } : {},
      );
      document = r.document;
      issues = r.issues;
      stats = r.stats;
      report = r.report;
    } else {
      document = migrateDocument(body.data);
      stats = {
        plans: document.plans.length,
        accounts: document.finances.accounts.length,
        snapshots: document.progress.length,
      };
    }
    const preview = {
      format,
      dryRun: body.dryRun,
      householdId: document.household.id,
      issues,
      stats,
      ...(report ? { report } : {}),
    };
    if (body.dryRun) return { ...preview, imported: false };
    if (issues.some((i) => (i as { severity?: string }).severity === "error"))
      throw new ApiError(
        422,
        "IMPORT_FAILED",
        "the import has blocking errors; run with dryRun=true to inspect them",
        { issues },
      );
    this.households.importDocument(document, actor, body.mode);
    return { ...preview, imported: true };
  }

  /** Detect delimiter, preset, columns and formats of a CSV without importing anything. */
  analyzeCsv(body: CsvAnalyzeBody) {
    return this.ctx.imports.analyzeCsv(body.text, body.kind, body.options as never);
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
    const out = this.ctx.imports.importCsvInto(doc, body.text, request, { dryRun: body.dryRun });
    const base = {
      kind: out.kind,
      dryRun: out.dryRun,
      applied: false,
      analysis: { ...out.analysis, sample: out.analysis.sample.slice(0, 10) },
      issues: out.issues.slice(0, 200),
      issueCount: out.issues.length,
      ...(out.reconciliation ? { reconciliation: out.reconciliation } : {}),
      ...(out.snapshots
        ? { snapshots: { count: out.snapshots.length, first: out.snapshots.slice(0, 20) } }
        : {}),
      ...(out.summary ? { summary: { ...out.summary, issues: undefined } } : {}),
    };
    if (body.dryRun) return base;
    if (out.issues.some((i) => i.severity === "error"))
      throw new ApiError(
        422,
        "IMPORT_FAILED",
        "the CSV has blocking errors; run with dryRun=true to inspect them",
        {
          issues: out.issues.filter((i) => i.severity === "error").slice(0, 50),
        },
      );
    const changes = this.applyDocument(
      householdId,
      doc,
      out.document,
      actor,
      body.options?.mode === "replace",
    );
    return { ...base, applied: true, changes };
  }

  /**
   * OFX / QFX / QIF import into a household: balances (reconciled like the CSV balance import) and spending
   * (summarised into annual expense events on `planId`). `dryRun` (the default) previews only. Account numbers
   * are already masked to their last four digits by the parser.
   */
  importBankFile(householdId: string, body: BankFileImportBody, actor: Actor) {
    // The route and MCP schemas refuse this first; no other caller may hand the parser a larger file either.
    if (body.text.length > MAX_BANK_FILE_CHARS)
      throw new ApiError(413, "PAYLOAD_TOO_LARGE", BANK_FILE_TOO_LARGE);
    const doc = this.households.getDocument(householdId);
    if (body.planId) this.plans.get(body.planId);
    const dateFormat = bankDateFormat(body.dateFormat);
    const annualise = bankAnnualise(body.annualise);
    const request: BankImportRequest = {
      format: body.format,
      ...(dateFormat ? { dateFormat } : {}),
      ...(body.accountName ? { accountName: body.accountName } : {}),
      ...(annualise ? { annualise } : {}),
      ...(body.categoryMap
        ? { categoryMap: body.categoryMap as BankImportRequest["categoryMap"] }
        : {}),
      ...(body.excludeCategories ? { excludeCategories: body.excludeCategories } : {}),
      ...(body.balances !== undefined ? { balances: body.balances } : {}),
      ...(body.planId ? { transactionsToPlanId: body.planId } : {}),
    };
    const out = this.ctx.imports.importBankFileInto(doc, body.text, request, {
      dryRun: body.dryRun,
    });
    const base = {
      format: out.format,
      dryRun: out.dryRun,
      applied: false,
      accounts: out.accounts,
      issues: out.issues.slice(0, 200),
      issueCount: out.issues.length,
      ...(out.reconciliation ? { reconciliation: out.reconciliation } : {}),
      summary: { ...out.summary, issues: undefined },
    };
    if (body.dryRun) return base;
    if (out.issues.some((i) => i.severity === "error"))
      throw new ApiError(
        422,
        "IMPORT_FAILED",
        "the file has blocking errors; run with dryRun=true to inspect them",
        {
          issues: out.issues.filter((i) => i.severity === "error").slice(0, 50),
        },
      );
    const changes = this.applyDocument(householdId, doc, out.document, actor, false);
    return { ...base, applied: true, changes };
  }

  private requirePlan(planId: string | undefined): string {
    if (!planId) throw new ApiError(400, "VALIDATION", "kind 'transactions' needs `planId`");
    return planId;
  }

  /** Write the differences between two versions of a household document, atomically. */
  private applyDocument(
    householdId: string,
    before: GlideworthDocument,
    after: GlideworthDocument,
    actor: Actor,
    replaceProgress: boolean,
  ) {
    const changes = {
      finances: false,
      snapshots: { created: 0, replaced: 0, removed: 0 },
      plans: [] as string[],
    };
    this.households.db.transaction(() => {
      if (JSON.stringify(before.finances) !== JSON.stringify(after.finances)) {
        this.households.replaceCurrent(householdId, { finances: after.finances }, undefined, actor);
        changes.finances = true;
      }
      const known = new Map(before.progress.map((s) => [s.id, JSON.stringify(s)]));
      const items = after.progress.filter((s) => known.get(s.id) !== JSON.stringify(s));
      if (items.length) {
        const r = this.households.bulkImportSnapshots(householdId, items, "replace");
        changes.snapshots.created = r.created;
        changes.snapshots.replaced = r.replaced;
      }
      if (replaceProgress) {
        const keep = new Set(after.progress.map((s) => s.id));
        for (const s of before.progress)
          if (!keep.has(s.id)) {
            this.households.deleteSnapshot(householdId, s.id);
            changes.snapshots.removed++;
          }
      }
      for (const p of after.plans) {
        const was = before.plans.find((x) => x.id === p.id);
        if (was && JSON.stringify(was) !== JSON.stringify(p)) {
          this.plans.write(p.id, () => p, { actor, message: "CSV import" });
          changes.plans.push(p.id);
        }
      }
    });
    return changes;
  }
}
