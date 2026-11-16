/**
 * Command-line interface. `runCli` takes injected I/O so it is testable; `main.ts` wires Node.
 * Output is counts and key paths only: never source values (the inputs are private financial data).
 */
import { buildSimulationInput, simulate } from "@glideworth/core";
import type { ColumnMapping, Field } from "../src/csv/columns.js";
import {
  analyzeCsv,
  buildCoverage,
  buildReportData,
  type CsvKind,
  type CsvOptions,
  collectKeyPaths,
  exportDocument,
  importCsvInto,
  importProjectionLab,
  type ProjectionTableId,
  parseExportedDocument,
  progressTable,
  TABLE_BUILDERS,
  tableToCsv,
} from "../src/index.js";

export interface CliIo {
  readFile(path: string): string;
  writeFile(path: string, content: string): void;
  stdout(line: string): void;
  stderr(line: string): void;
  /** ISO timestamp for `exportedAt`; injected so the library stays clock-free. */
  now(): Date;
}

const HELP = `glideworth-import: ProjectionLab / CSV import and export for Glideworth

Usage (pnpm --filter @glideworth/importers cli <command> ...):
  import-projectionlab <file> --out <doc.json> [--report <report.json>] [--household-id <id>]
  coverage <file>                       key-path coverage summary of a ProjectionLab export
  export-json <doc.json> --out <file>   re-export a document (migrates older schema versions)
  analyze-csv <kind> <file> [--preset id] [--locale en-GB|en-US] [--column field=Header ...]
  import-csv <kind> <file> --doc <doc.json> [--apply --out <file>] [--plan <id>]
        [--preset id] [--locale en-GB|en-US] [--decimal ,|.] [--column field=Header ...]
        [--create-missing] [--annualise last-12-months|all|latest-full-year]
        kind: account-balances | progress-snapshots | transactions   (dry run unless --apply)
  export-csv <table> <doc.json> --out <file> [--plan <id>] [--basis real|nominal]
        table: year-by-year | cash-flow | taxes | account-balances | progress
  report <doc.json> --out <report.json> [--plan <id>] [--basis real|nominal]
`;

interface Parsed {
  positional: string[];
  flags: Map<string, string[]>;
}

const BOOLEAN_FLAGS = new Set(["apply", "create-missing", "help"]);

function parseArgs(args: string[]): Parsed {
  const positional: string[] = [];
  const flags = new Map<string, string[]>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("--")) {
      const name = a.slice(2);
      if (BOOLEAN_FLAGS.has(name)) flags.set(name, [...(flags.get(name) ?? []), "true"]);
      else {
        const v = args[i + 1];
        if (v === undefined || v.startsWith("--")) throw new Error(`--${name} needs a value`);
        flags.set(name, [...(flags.get(name) ?? []), v]);
        i += 1;
      }
    } else positional.push(a);
  }
  return { positional, flags };
}

const flag = (p: Parsed, name: string): string | undefined => p.flags.get(name)?.[0];

function need(p: Parsed, name: string): string {
  const v = flag(p, name);
  if (!v) throw new Error(`missing --${name}`);
  return v;
}

const KINDS: CsvKind[] = ["account-balances", "progress-snapshots", "transactions"];

function csvOptions(p: Parsed): CsvOptions {
  const columns: ColumnMapping = {};
  for (const c of p.flags.get("column") ?? []) {
    const eq = c.indexOf("=");
    if (eq < 1) throw new Error(`--column expects field=Header, got '${c}'`);
    columns[c.slice(0, eq) as Field] = c.slice(eq + 1);
  }
  const locale = flag(p, "locale");
  if (locale && locale !== "en-GB" && locale !== "en-US" && locale !== "auto")
    throw new Error("--locale must be en-GB, en-US or auto");
  const decimal = flag(p, "decimal");
  if (decimal && decimal !== "." && decimal !== ",") throw new Error("--decimal must be . or ,");
  return {
    preset: flag(p, "preset"),
    locale: locale as CsvOptions["locale"],
    decimalSeparator: decimal as CsvOptions["decimalSeparator"],
    columns,
  };
}

function summariseIssues(io: CliIo, issues: { severity: string; category?: string }[]): void {
  const by = new Map<string, number>();
  for (const i of issues)
    by.set(
      `${i.severity}/${i.category ?? "info"}`,
      (by.get(`${i.severity}/${i.category ?? "info"}`) ?? 0) + 1,
    );
  io.stdout(
    `issues: ${issues.length}${by.size > 0 ? ` (${[...by].map(([k, v]) => `${k}=${v}`).join(", ")})` : ""}`,
  );
}

function pickPlan(
  doc: { plans: { id: string; isMain: boolean }[] },
  requested: string | undefined,
): string {
  const id = requested ?? doc.plans.find((p) => p.isMain)?.id ?? doc.plans[0]?.id;
  if (!id) throw new Error("document has no plans");
  return id;
}

/** Returns the process exit code. */
export async function runCli(argv: string[], io: CliIo): Promise<number> {
  try {
    const p = parseArgs(argv);
    const [cmd, ...rest] = p.positional;
    if (!cmd || flag(p, "help") || cmd === "help") {
      io.stdout(HELP);
      return cmd ? 0 : 1;
    }
    switch (cmd) {
      case "import-projectionlab": {
        const file = rest[0];
        if (!file) throw new Error("import-projectionlab needs an input file");
        const raw = JSON.parse(io.readFile(file)) as unknown;
        const result = importProjectionLab(raw, { householdId: flag(p, "household-id") });
        io.writeFile(need(p, "out"), exportDocument(result.document, io.now()));
        const reportPath = flag(p, "report");
        if (reportPath) io.writeFile(reportPath, JSON.stringify(result.report, null, 2));
        io.stdout(
          `imported: ${Object.entries(result.report.counts)
            .map(([k, c]) => `${k}=${c.imported}/${c.source}`)
            .join(" ")}`,
        );
        const c = result.report.coverage;
        io.stdout(
          `key paths: ${c.total} (mapped ${c.mapped}, ignored ${c.ignored}, unsupported ${c.unsupported}, unknown ${c.unknown})`,
        );
        summariseIssues(io, result.issues);
        return 0;
      }
      case "coverage": {
        const file = rest[0];
        if (!file) throw new Error("coverage needs an input file");
        const cov = buildCoverage(collectKeyPaths(JSON.parse(io.readFile(file)) as unknown));
        io.stdout(
          `key paths: ${cov.total} (mapped ${cov.mapped}, ignored ${cov.ignored}, unsupported ${cov.unsupported}, unknown ${cov.unknown})`,
        );
        for (const path of cov.unaccountedPaths) io.stdout(`unaccounted: ${path}`);
        return cov.unknown === 0 ? 0 : 2;
      }
      case "export-json": {
        const file = rest[0];
        if (!file) throw new Error("export-json needs a document");
        const { document } = parseExportedDocument(io.readFile(file));
        io.writeFile(need(p, "out"), exportDocument(document, io.now()));
        io.stdout("exported document");
        return 0;
      }
      case "analyze-csv": {
        const [kind, file] = rest;
        if (!KINDS.includes(kind as CsvKind) || !file)
          throw new Error(`analyze-csv <${KINDS.join("|")}> <file>`);
        const a = analyzeCsv(io.readFile(file), kind as CsvKind, csvOptions(p));
        io.stdout(
          `delimiter=${JSON.stringify(a.delimiter)} rows=${a.rowCount} preset=${a.preset?.id ?? "none"} locale=${a.locale} dateFormat=${a.dateFormat} decimal=${a.decimalSeparator}`,
        );
        for (const [f, h] of Object.entries(a.columns))
          io.stdout(`column ${f} <- ${JSON.stringify(h)}`);
        if (a.missing.length > 0) io.stdout(`missing: ${a.missing.join(", ")}`);
        return a.missing.length > 0 ? 2 : 0;
      }
      case "import-csv": {
        const [kind, file] = rest;
        if (!KINDS.includes(kind as CsvKind) || !file)
          throw new Error(`import-csv <${KINDS.join("|")}> <file> --doc <doc.json>`);
        const { document } = parseExportedDocument(io.readFile(need(p, "doc")));
        const apply = flag(p, "apply") === "true";
        const o = csvOptions(p);
        const text = io.readFile(file);
        const outcome =
          kind === "account-balances"
            ? importCsvInto(
                document,
                text,
                { kind, options: { ...o, createMissing: flag(p, "create-missing") === "true" } },
                { dryRun: !apply },
              )
            : kind === "progress-snapshots"
              ? importCsvInto(document, text, { kind, options: o }, { dryRun: !apply })
              : importCsvInto(
                  document,
                  text,
                  {
                    kind: "transactions",
                    planId: pickPlan(document, flag(p, "plan")),
                    options: { ...o, annualise: flag(p, "annualise") as "all" | undefined },
                  },
                  { dryRun: !apply },
                );
        io.stdout(
          `${apply ? "applied" : "dry run"}: ${kind}, ${outcome.analysis.rowCount} rows, preset=${outcome.analysis.preset?.id ?? "none"}`,
        );
        if (outcome.reconciliation) {
          const r = outcome.reconciliation;
          io.stdout(
            `matched=${r.matched.length} created=${r.created.length} unmatched=${r.unmatched.length}`,
          );
        }
        if (outcome.snapshots) io.stdout(`snapshots=${outcome.snapshots.length}`);
        if (outcome.summary)
          io.stdout(
            `transactions=${outcome.summary.transactions} categories=${outcome.summary.categories.length} events=${outcome.summary.events.length}`,
          );
        summariseIssues(io, outcome.issues);
        if (apply) io.writeFile(need(p, "out"), exportDocument(outcome.document, io.now()));
        return outcome.issues.some((i) => i.severity === "error") ? 2 : 0;
      }
      case "export-csv": {
        const [table, file] = rest;
        if (!table || !file) throw new Error("export-csv <table> <doc.json> --out <file>");
        const { document } = parseExportedDocument(io.readFile(file));
        const basis = (flag(p, "basis") ?? "real") as "real" | "nominal";
        if (table === "progress") {
          io.writeFile(need(p, "out"), tableToCsv(progressTable(document)));
          io.stdout(`wrote progress (${document.progress.length} rows)`);
          return 0;
        }
        if (!(table in TABLE_BUILDERS)) throw new Error(`unknown table '${table}'`);
        const planId = pickPlan(document, flag(p, "plan"));
        const result = simulate(
          buildSimulationInput(document, planId, { strict: false, trace: "off" }),
        );
        const labels = Object.fromEntries([
          ...document.household.people.map((x) => [x.id, x.name]),
          ...document.finances.accounts.map((a) => [a.id, a.name]),
        ]);
        const t = TABLE_BUILDERS[table as ProjectionTableId](result, { basis, labels });
        io.writeFile(need(p, "out"), tableToCsv(t));
        io.stdout(`wrote ${table} (${t.rows.length} rows)`);
        return 0;
      }
      case "report": {
        const file = rest[0];
        if (!file) throw new Error("report <doc.json> --out <file>");
        const { document } = parseExportedDocument(io.readFile(file));
        const planId = pickPlan(document, flag(p, "plan"));
        const result = simulate(
          buildSimulationInput(document, planId, { strict: false, trace: "off" }),
        );
        const data = buildReportData(document, planId, result, {
          basis: (flag(p, "basis") ?? "real") as "real" | "nominal",
        });
        io.writeFile(need(p, "out"), JSON.stringify(data, null, 2));
        io.stdout(
          `wrote report (${data.table.rows.length} table rows, ${data.warnings.length} warnings)`,
        );
        return 0;
      }
      default:
        io.stderr(`unknown command '${cmd}'`);
        io.stdout(HELP);
        return 1;
    }
  } catch (e) {
    io.stderr(`error: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}
