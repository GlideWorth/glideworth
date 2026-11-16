import type { GlideworthDocument } from "@glideworth/core";

/**
 * What happened to a piece of source data. Every importer reports what it could not map instead of
 * silently dropping data.
 *  - dropped:       intentionally not carried over (UI state, derived values, secrets).
 *  - approximated:  carried over, but Glideworth's model differs; the message says how.
 *  - unsupported:   real planning content with no home in the Glideworth schema yet.
 *  - unrecognised:  a key the importer does not know (future export versions).
 *  - warning/info:  anything else worth telling the user (dangling references, defaults chosen).
 */
export type ImportIssueCategory =
  | "dropped"
  | "approximated"
  | "unsupported"
  | "unrecognised"
  | "defaulted"
  | "invalid"
  | "info";

/** Every importer reports what it could not map instead of silently dropping data. */
export interface ImportIssue {
  severity: "info" | "warning" | "error";
  /** Path into the SOURCE document (`$.plans[0].income.events[2].amount`) or `csv:row:3`. */
  sourcePath: string;
  message: string;
  category?: ImportIssueCategory;
  /** Stable machine code, e.g. `pl.unsupported.tapFund`. */
  code?: string;
  /** Id of the Glideworth entity this concerns, when there is one. */
  entityId?: string;
  /** For `unsupported`: the optional Glideworth schema field that would give this data a home. */
  suggestedField?: string;
}

/** How one source key path (array indexes collapsed to `[]`) was accounted for. */
export type CoverageStatus = "mapped" | "ignored" | "unsupported" | "unknown";

export interface CoverageEntry {
  /** Normalised key path, e.g. `$.plans[].income.events[].amount`. */
  path: string;
  status: CoverageStatus;
  /** Glideworth destination for `mapped` paths (documentation only). */
  target?: string;
  /** Why an `ignored`/`unsupported` path is not carried over, or a note on how it is approximated. */
  note?: string;
  /** Number of concrete occurrences in the source. */
  occurrences: number;
}

export interface ImportCoverage {
  total: number;
  mapped: number;
  ignored: number;
  unsupported: number;
  /** Paths no rule recognised. Must be 0 for a fully accounted import. */
  unknown: number;
  entries: CoverageEntry[];
  unaccountedPaths: string[];
}

export interface ImportCount {
  /** Entities found in the source. */
  source: number;
  /** Entities written to the Glideworth document. */
  imported: number;
}

export interface ImportReport {
  source: { format: "projectionlab"; version?: string; schema?: string };
  /** Per-entity source vs imported counts. */
  counts: Record<string, ImportCount>;
  issues: ImportIssue[];
  issueCounts: Record<ImportIssueCategory, number>;
  coverage: ImportCoverage;
}

export interface ImportResult {
  document: GlideworthDocument;
  issues: ImportIssue[];
  /** Flat counts for the reconciliation preview (`plans`, `accounts`, `income`, ...). */
  stats: Record<string, number>;
  /** Structured report: per-entity counts, issue tallies and the key-path coverage table. */
  report: ImportReport;
}

// ---------------------------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------------------------

export type CsvKind = "account-balances" | "progress-snapshots" | "transactions";
export type CsvLocale = "en-GB" | "en-US";

/** Column mapping for CSV imports. Values are header names (case-insensitive) in the file. */
export interface CsvMapping {
  kind: CsvKind;
  dateColumn?: string;
  accountColumn?: string;
  /** Account balances: the balance column. Progress: the net worth column. */
  balanceColumn?: string;
  /** Account balances: account type column. */
  typeColumn?: string;
  /** Map CSV account labels to Glideworth account ids (unmapped rows become issues). */
  accountMap?: Record<string, string>;
  decimalSeparator?: "." | ",";
  dateFormat?: "YYYY-MM-DD" | "DD/MM/YYYY" | "MM/DD/YYYY";
}

export interface CsvImportResult {
  rows: { accountId: string; date: string; balance: number }[];
  issues: ImportIssue[];
}
