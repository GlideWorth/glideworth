/**
 * The CPU-heavy half of the imports (security review finding 4): parsing, analysis, the dry-run preview and the
 * list of writes an apply would make. Pure: a task in, plain data out, so it runs the same in a worker thread
 * (production, `import-pool.ts`) and in-process (tests that inject fake importers). The request thread keeps
 * the cheap half: validating the request, reading the household, and writing the result in one transaction
 * (`services/imports.ts`).
 */
import type { GlideworthDocument, Plan, ProgressSnapshot } from "@glideworth/core";
import { migrateDocument } from "@glideworth/core";
import type { CsvImportRequest, ImportIssue } from "@glideworth/importers";
import type { ImportDeps } from "../deps.js";
import {
  checkImportSize,
  IMPORT_LIMITS,
  validationProbe,
  withFewerIssues,
} from "./import-limits.js";

export type ImportTask =
  | {
      op: "document";
      format: "glideworth" | "cairn" | "projectionlab" | "auto";
      data: unknown;
      dryRun: boolean;
      householdId?: string;
    }
  | { op: "csv-analyze"; text: string; kind: CsvImportRequest["kind"]; options?: unknown }
  | {
      op: "csv";
      doc: GlideworthDocument;
      text: string;
      request: CsvImportRequest;
      dryRun: boolean;
      replaceProgress: boolean;
    };

/** What an apply writes, worked out by comparing the household before and after the import. */
export interface ImportWrites {
  /** The new finances, when they differ. */
  finances?: GlideworthDocument["finances"];
  /** Snapshots that are new or differ (written with `replace`). */
  snapshots: ProgressSnapshot[];
  /** Snapshots to delete (CSV progress import in `replace` mode). */
  removeSnapshotIds: string[];
  /** Plans that exist and differ. */
  plans: Plan[];
}

export interface DocumentImportResult {
  op: "document";
  preview: {
    format: string;
    dryRun: boolean;
    householdId: string;
    issues: unknown[];
    stats: Record<string, number>;
    report?: unknown;
  };
  /** Blocking issues (apply only): the request answers 422 and writes nothing. */
  blocking?: unknown[];
  /** The validated document to store (apply without blocking issues only). */
  document?: GlideworthDocument;
}

export interface HouseholdImportResult {
  op: "csv";
  /** The response body of a dry run (and the base of an apply's). */
  preview: Record<string, unknown>;
  /** Blocking errors, at most 50 (apply only): the request answers 422 and writes nothing. */
  blocking?: ImportIssue[];
  /** Apply without blocking errors only. */
  writes?: ImportWrites;
}

export type ImportTaskResult =
  | DocumentImportResult
  | HouseholdImportResult
  | { op: "csv-analyze"; analysis: unknown };

/** Run one import task. Throws what the importers throw (the pool carries errors across the thread). */
export function runImportTask(task: ImportTask, deps: ImportDeps): ImportTaskResult {
  switch (task.op) {
    case "document":
      try {
        return documentImport(task, deps);
      } catch (err) {
        // At most IMPORT_LIMITS.issues validation problems cross the thread and reach the response.
        throw withFewerIssues(err);
      }
    case "csv-analyze":
      return {
        op: "csv-analyze",
        analysis: deps.analyzeCsv(task.text, task.kind, task.options as never),
      };
    case "csv":
      return csvImport(task, deps);
  }
}

function documentImport(
  task: Extract<ImportTask, { op: "document" }>,
  deps: ImportDeps,
): DocumentImportResult {
  let format = task.format;
  if (format === "auto")
    format = deps.detectProjectionLabExport(task.data) ? "projectionlab" : "glideworth";
  let document: GlideworthDocument;
  let issues: unknown[] = [];
  let stats: Record<string, number> = {};
  let report: unknown;
  if (format === "projectionlab") {
    const r = deps.importProjectionLab(
      task.data,
      task.householdId ? { householdId: task.householdId } : {},
    );
    document = r.document;
    issues = r.issues;
    stats = r.stats;
    report = r.report;
  } else {
    // A probe first, so a document that is mostly invalid fails cheaply (see `validationProbe`). The request
    // thread has already checked the size, depth and plan count.
    migrateDocument(validationProbe(task.data, checkImportSize(task.data)));
    document = migrateDocument(task.data);
    stats = {
      plans: document.plans.length,
      accounts: document.finances.accounts.length,
      snapshots: document.progress.length,
    };
  }
  // A crafted export can carry one note per value; the response lists the first ones (`stats.issues` and
  // `report.issueCounts` count them all).
  const listed = issues.slice(0, IMPORT_LIMITS.notes);
  const preview = {
    format,
    dryRun: task.dryRun,
    householdId: document.household.id,
    issues: listed,
    stats,
    ...(report ? { report: { ...(report as object), issues: listed } } : {}),
  };
  if (task.dryRun) return { op: "document", preview };
  if (issues.some((i) => (i as { severity?: string }).severity === "error"))
    return { op: "document", preview, blocking: listed };
  // Validated here so the request thread can store it as is. A Glideworth document is already the output of
  // `migrateDocument`, which gives the same document when run again.
  return {
    op: "document",
    preview,
    document: format === "projectionlab" ? migrateDocument(document) : document,
  };
}

function csvImport(task: Extract<ImportTask, { op: "csv" }>, deps: ImportDeps) {
  const out = deps.importCsvInto(task.doc, task.text, task.request, { dryRun: task.dryRun });
  const preview = {
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
  return finishHousehold("csv", task, preview, out.issues, out.document, task.replaceProgress);
}

function finishHousehold(
  op: "csv",
  task: { doc: GlideworthDocument; dryRun: boolean },
  preview: Record<string, unknown>,
  issues: ImportIssue[],
  after: GlideworthDocument,
  replaceProgress: boolean,
): HouseholdImportResult {
  if (task.dryRun) return { op, preview };
  const errors = issues.filter((i) => i.severity === "error");
  if (errors.length) return { op, preview, blocking: errors.slice(0, 50) };
  return { op, preview, writes: diffDocuments(task.doc, after, replaceProgress) };
}

/** The writes that turn `before` into `after` (finances, snapshots, existing plans). */
function diffDocuments(
  before: GlideworthDocument,
  after: GlideworthDocument,
  replaceProgress: boolean,
): ImportWrites {
  const known = new Map(before.progress.map((s) => [s.id, JSON.stringify(s)]));
  const keep = new Set(after.progress.map((s) => s.id));
  const wasPlans = new Map(before.plans.map((p) => [p.id, p]));
  const plans: Plan[] = [];
  for (const p of after.plans) {
    const was = wasPlans.get(p.id);
    if (was && JSON.stringify(was) !== JSON.stringify(p)) plans.push(p);
  }
  return {
    ...(JSON.stringify(before.finances) !== JSON.stringify(after.finances)
      ? { finances: after.finances }
      : {}),
    snapshots: after.progress.filter((s) => known.get(s.id) !== JSON.stringify(s)),
    removeSnapshotIds: replaceProgress
      ? before.progress.filter((s) => !keep.has(s.id)).map((s) => s.id)
      : [],
    plans,
  };
}

/** An error crossing the thread boundary as plain data (see `reviveImportError` in import-pool.ts). */
export interface SerializedImportError {
  name: string;
  message: string;
  code?: string;
  details?: unknown;
  /** ZodError: its issues (answered as 400 VALIDATION). */
  issues?: unknown[];
}

export function serializeImportError(err: unknown): SerializedImportError {
  if (!(err instanceof Error)) return { name: "Error", message: "unknown error" };
  const e = err as Error & { code?: unknown; details?: unknown; issues?: unknown };
  const out: SerializedImportError = { name: e.name, message: e.message };
  if (typeof e.code === "string") out.code = e.code;
  if (e.details !== undefined) out.details = plain(e.details);
  if (e.name === "ZodError" && Array.isArray(e.issues)) out.issues = plain(e.issues) as unknown[];
  return out;
}

/** Structured-clone safe copy (drops functions, BigInts and cycles rather than failing the post). */
function plain(v: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(v)) as unknown;
  } catch {
    return undefined;
  }
}
