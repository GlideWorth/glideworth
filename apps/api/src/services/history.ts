/**
 * Balance-history import (per-account balances over time). The request either carries rows already mapped to
 * accounts (what the web app sends after its preview) or the raw text of a CSV/TSV file, which is read, matched
 * and checked in the import thread with the same code the web app runs (`@glideworth/importers`).
 */
import { z } from "zod";

const IsoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");

export const HistoryKey = z
  .string()
  .regex(
    /^((account|asset|loan|debt):[A-Za-z0-9_-]{1,64}|netWorth|assets|liabilities)$/,
    "account:<id>, asset:<id>, loan:<realAssetId>, debt:<id>, netWorth, assets or liabilities",
  )
  .describe(
    "What a value is: `account:<id>`, `asset:<realAssetId>` (its value), `loan:<realAssetId>` (its loan balance), `debt:<id>`, or a total (`netWorth`, `assets`, `liabilities`).",
  );

export const HistoryRowBody = z.object({
  date: IsoDay,
  values: z
    .record(HistoryKey, z.number().finite().nullable())
    .describe(
      "Value per key in major units. `null` = a blank cell (no value; Replace clears a saved value). A key left out = not in the file (never cleared). Debts and loans are amounts owed: positive numbers.",
    ),
  note: z.string().max(500).optional(),
});

export const HistoryParseOptions = z
  .object({
    delimiter: z.enum(["auto", ",", ";", "\t", "|"]).optional(),
    layout: z
      .enum(["auto", "rows", "columns", "long"])
      .optional()
      .describe(
        "rows = one row per date; columns = one column per date; long = one row per date and account.",
      ),
    dateFormat: z
      .enum(["auto", "YMD", "MDY", "DMY"])
      .optional()
      .describe(
        "How to read all-numeric dates such as 03/04/2024. `auto` decides from the column and reports an ambiguous column as an error instead of guessing.",
      ),
    decimalSeparator: z.enum(["auto", ".", ","]).optional(),
    periodDay: z
      .enum(["end", "start"])
      .optional()
      .describe("Day a month-only or year-only date stands for (default: the last day)."),
    columns: z
      .record(z.string().max(200), z.union([HistoryKey, z.literal("note"), z.literal("skip")]))
      .optional()
      .describe("Header text -> key, `note` or `skip`. Overrides the automatic match."),
  })
  .meta({ id: "BalanceHistoryParseOptions" });

export const BalanceHistoryImportBody = z
  .object({
    mode: z
      .enum(["merge", "replace"])
      .default("merge")
      .describe(
        "merge: add and update values, keep everything else. replace: also clear, for each key in the import, saved values the import does not have between its first and last date.",
      ),
    dryRun: z
      .boolean()
      .default(true)
      .describe("true (the default) returns the preview diff and writes nothing."),
    updateCurrentBalances: z
      .boolean()
      .default(false)
      .describe("Values dated today also become the household's current balances."),
    today: IsoDay.optional().describe(
      "The caller's date (time zones); must be within a day of the server's. Dates after it are refused.",
    ),
    rows: z.array(HistoryRowBody).max(5000).optional().describe("Mapped values, one row per date."),
    text: z
      .string()
      .max(5_000_000)
      .optional()
      .describe("Instead of rows: the CSV/TSV text (or cells pasted from a spreadsheet)."),
    options: HistoryParseOptions.optional().describe("With `text`: how to read it."),
    skipInvalid: z
      .boolean()
      .default(false)
      .describe(
        "With `text`: import the clean cells and leave out cells with errors (a left-out cell is never cleared).",
      ),
  })
  .refine((b) => (b.rows === undefined) !== (b.text === undefined), {
    message: "give either `rows` or `text`",
  })
  .refine((b) => (b.rows ?? []).reduce((n, r) => n + Object.keys(r.values).length, 0) <= 200_000, {
    message: "at most 200,000 values per import",
  })
  .meta({
    id: "BalanceHistoryImport",
    examples: [
      {
        mode: "merge",
        dryRun: true,
        rows: [
          { date: "2026-01-31", values: { "account:acc-cash": 31250.4, "debt:debt-car": 8120 } },
          { date: "2026-02-28", values: { "account:acc-cash": 32010, "debt:debt-car": null } },
        ],
      },
    ],
  });
export type BalanceHistoryImportBody = z.infer<typeof BalanceHistoryImportBody>;

const Issue = z.object({
  severity: z.enum(["error", "warning", "info"]),
  code: z.string(),
  message: z.string(),
  ref: z.string().optional(),
  date: z.string().optional(),
  key: z.string().optional(),
});

export const BalanceHistoryImportResult = z
  .object({
    dryRun: z.boolean(),
    applied: z.boolean(),
    mode: z.enum(["merge", "replace"]),
    blocked: z.boolean().describe("True when errors stop the import (see `issues`)."),
    range: z.object({ from: z.string(), to: z.string() }).nullable(),
    counts: z.object({
      added: z.number().int(),
      updated: z.number().int(),
      removed: z.number().int(),
      unchanged: z.number().int(),
      snapshotsCreated: z.number().int(),
      snapshotsUpdated: z.number().int(),
      snapshotsRemoved: z.number().int(),
    }),
    changes: z
      .array(
        z.object({
          date: z.string(),
          key: z.string(),
          label: z.string(),
          before: z.number().nullable(),
          after: z.number().nullable(),
          kind: z.enum(["added", "updated", "removed"]),
        }),
      )
      .describe("Value changes, oldest first (at most 500; see `changesTruncated`)."),
    changesTruncated: z.boolean(),
    currentBalances: z
      .object({ accounts: z.number().int(), realAssets: z.number().int(), debts: z.number().int() })
      .nullable()
      .describe("Current balances set from today's values (updateCurrentBalances)."),
    issues: z.array(Issue),
    parse: z
      .object({
        layout: z.string(),
        delimiter: z.string(),
        dateFormat: z.string().nullable(),
        dateFormatAmbiguous: z.boolean(),
        dateFormatSuggestion: z.string().optional(),
        decimalSeparator: z.string(),
        columns: z.array(
          z.object({
            header: z.string(),
            key: z.string().nullable(),
            confidence: z.number(),
            alternatives: z.array(z.string()),
          }),
        ),
        counts: z.object({
          dates: z.number().int(),
          values: z.number().int(),
          blanks: z.number().int(),
          errors: z.number().int(),
          warnings: z.number().int(),
        }),
      })
      .optional()
      .describe("With `text`: how the file was read."),
  })
  .meta({ id: "BalanceHistoryImportResult" });
export type BalanceHistoryImportResult = z.infer<typeof BalanceHistoryImportResult>;
