import { readFileSync } from "node:fs";
import {
  buildSimulationInput,
  type GlideworthDocument,
  migrateDocument,
  type ProjectionResult,
  SCHEMA_VERSION,
  simulate,
  ValidationError,
} from "@glideworth/core";
import { createSampleDocument } from "@glideworth/core/samples";
import { describe, expect, it } from "vitest";
import { runCli } from "../cli/run.js";
import {
  accountBalancesTable,
  buildCoverage,
  buildReportData,
  cashFlowTable,
  collectKeyPaths,
  exportDocument,
  importProjectionLab,
  parseCsv,
  parseExportedDocument,
  progressTable,
  tableToCsv,
  taxTable,
  yearByYearTable,
} from "../src/index.js";
import { renderMappingDoc } from "../src/projectionlab/mapping-doc.js";
import { buildSyntheticExport } from "./fixtures/projectionlab-synthetic.js";

const NOW = new Date("2026-11-15T12:00:00Z");

function sim(doc: GlideworthDocument): ProjectionResult {
  return simulate(buildSimulationInput(doc, doc.plans[0]!.id, { strict: false, trace: "off" }));
}

describe("JSON export", () => {
  it("stamps app, schema version and exportedAt", () => {
    const o = JSON.parse(exportDocument(createSampleDocument(), NOW));
    expect(o).toMatchObject({
      app: "glideworth",
      schemaVersion: SCHEMA_VERSION,
      exportedAt: NOW.toISOString(),
    });
  });

  it("round-trips exactly (modulo the exportedAt stamp)", () => {
    const doc = createSampleDocument();
    const parsed = parseExportedDocument(exportDocument(doc, NOW));
    expect(parsed.document).toEqual(migrateDocument(JSON.parse(JSON.stringify(doc))));
    expect(parsed.exportedAt).toBe(NOW.toISOString());
    expect(parsed.fromSchemaVersion).toBe(SCHEMA_VERSION);
    // Re-exporting the parsed document and parsing again changes nothing.
    const again = parseExportedDocument(exportDocument(parsed.document, NOW));
    expect(again.document).toEqual(parsed.document);
    expect(JSON.stringify(again.document)).toBe(JSON.stringify(parsed.document));
  });

  it("round-trips an imported ProjectionLab document exactly", () => {
    const { document } = importProjectionLab(buildSyntheticExport());
    const back = parseExportedDocument(exportDocument(document, NOW)).document;
    expect(back).toEqual(document);
    expect(JSON.stringify(back)).toBe(JSON.stringify(document));
  });

  it('reads an export written before the rename (app marker "cairn") and re-exports it as "glideworth"', () => {
    // Written by the pre-rename exporter (commit 2b53e65): the sample household with its first plan.
    const text = readFileSync(new URL("./fixtures/cairn-export-v1.json", import.meta.url), "utf8");
    expect(JSON.parse(text).app).toBe("cairn");
    const parsed = parseExportedDocument(text);
    expect(parsed.document.app).toBe("glideworth");
    expect(parsed.exportedAt).toBe("2026-11-15T12:00:00.000Z");
    expect(parsed.document.household.id).toBe("hh-sample");
    expect(parsed.document.plans).toHaveLength(1);
    const sample = createSampleDocument();
    expect(parsed.document.finances).toEqual(
      migrateDocument(JSON.parse(JSON.stringify(sample))).finances,
    );
    expect(JSON.parse(exportDocument(parsed.document, NOW)).app).toBe("glideworth");
  });

  it("imports an old export that names a removed dataset (uk-1871, us-1871) and tells the user", () => {
    // An export from before the dataset swap: the pre-rename fixture with its plan's dataset set to
    // the withdrawn ids, exactly as the old exporter wrote them.
    const text = readFileSync(new URL("./fixtures/cairn-export-v1.json", import.meta.url), "utf8");
    for (const [old, now] of [
      ["uk-1871", "uk-1983"],
      ["us-1871", "us-1928"],
    ] as const) {
      const raw = JSON.parse(text);
      raw.plans[0].monteCarlo.dataset = old;
      const { document } = parseExportedDocument(JSON.stringify(raw));
      const plan = document.plans[0]!;
      expect(plan.monteCarlo).toMatchObject({ dataset: now, replacedDataset: old });
      const r = simulate(buildSimulationInput(document, plan.id, { trace: "off" }));
      const note = r.warnings.find((w) => w.code === "DATASET_REPLACED");
      expect(note?.message).toMatch(/results will differ/);
      // Re-exporting writes the current id; the old one is never written again.
      expect(exportDocument(document, NOW)).not.toContain(`"dataset": "${old}"`);
    }
  });

  it("exporting never mutates the input", () => {
    const doc = createSampleDocument();
    const before = JSON.stringify(doc);
    exportDocument(doc, NOW);
    expect(JSON.stringify(doc)).toBe(before);
  });

  it("rejects garbage, newer schemas and ProjectionLab files with clear errors", () => {
    expect(() => parseExportedDocument("not json")).toThrow(ValidationError);
    expect(() => parseExportedDocument('{"app":"glideworth","schemaVersion":999}')).toThrow(
      /newer/,
    );
    expect(() => parseExportedDocument(JSON.stringify(buildSyntheticExport()))).toThrow(
      /ProjectionLab/,
    );
    expect(() => parseExportedDocument('{"app":"glideworth","schemaVersion":1}')).toThrow(
      ValidationError,
    );
  });
});

describe("projection CSV tables", () => {
  const doc = createSampleDocument();
  const result = sim(doc);

  it("year-by-year: one row per period, labelled ages, real vs nominal", () => {
    const real = yearByYearTable(result, {
      basis: "real",
      labels: { [doc.household.people[0]!.id]: "Alex" },
    });
    expect(real.rows).toHaveLength(result.periods.length);
    expect(real.columns[0]).toMatchObject({ key: "year", label: "Year" });
    expect(real.columns.some((c) => c.label === "Age (Alex)")).toBe(true);
    const nominal = yearByYearTable(result, { basis: "nominal" });
    const nwIndex = real.columns.findIndex((c) => c.key === "netWorth");
    const last = result.periods.length - 1;
    const p = result.periods[last]!;
    expect(nominal.rows[last]![nwIndex]).toBeCloseTo(Math.round(p.totals.netWorth * 100) / 100, 2);
    expect(real.rows[last]![nwIndex]).toBeCloseTo(
      Math.round((p.totals.netWorth / p.priceIndex) * 100) / 100,
      2,
    );
    for (const row of real.rows) expect(row).toHaveLength(real.columns.length);
  });

  it("cash flow: totals reconcile with the per-source columns", () => {
    const t = cashFlowTable(result);
    expect(t.id).toBe("cash-flow");
    const idx = (k: string) => t.columns.findIndex((c) => c.key === k);
    const incomeCols = t.columns
      .map((c, i) => (c.key.startsWith("income:") ? i : -1))
      .filter((i) => i >= 0);
    for (const row of t.rows) {
      const parts = incomeCols.reduce((s, i) => s + (row[i] as number), 0);
      expect(parts).toBeCloseTo(row[idx("income")] as number, 1);
    }
    for (const row of t.rows) expect(row).toHaveLength(t.columns.length);
  });

  it("taxes: one column per jurisdiction/kind line", () => {
    const t = taxTable(result);
    expect(t.id).toBe("taxes");
    expect(t.columns.find((c) => c.key === "total")).toBeDefined();
    for (const row of t.rows) expect(row).toHaveLength(t.columns.length);
  });

  it("account balances: one column per account", () => {
    const t = accountBalancesTable(result, { labels: { [doc.finances.accounts[0]!.id]: "Named" } });
    expect(t.columns.some((c) => c.label === "Named")).toBe(true);
    expect(t.columns.length).toBe(
      1 + new Set(result.periods.flatMap((p) => p.accounts.map((a) => a.accountId))).size,
    );
  });

  it("tableToCsv produces parseable CSV with a label header", () => {
    const t = yearByYearTable(result);
    const csv = tableToCsv(t);
    const parsed = parseCsv(csv);
    expect(parsed.rows[0]).toEqual(t.columns.map((c) => c.label));
    expect(parsed.rows).toHaveLength(t.rows.length + 1);
    expect(parsed.rows[1]![0]).toBe(String(result.periods[0]!.year));
  });

  it("progress table", () => {
    const t = progressTable(doc);
    expect(t.rows).toHaveLength(doc.progress.length);
    expect(t.columns.map((c) => c.key).slice(0, 4)).toEqual([
      "date",
      "netWorth",
      "assets",
      "liabilities",
    ]);
    const csv = tableToCsv(t);
    expect(parseCsv(csv).rows[0]![0]).toBe("Date");
  });

  it("CSV cells that look like formulas are neutralised", () => {
    const t = progressTable({ ...doc, progress: [{ ...doc.progress[0]!, source: "manual" }] });
    t.rows[0]![t.rows[0]!.length - 1] = "=cmd()";
    expect(tableToCsv(t)).toContain("'=cmd()");
  });
});

describe("printable report data", () => {
  const doc = createSampleDocument();
  const result = sim(doc);
  const report = buildReportData(doc, doc.plans[0]!.id, result, { tableEvery: 10 });

  it("is plain JSON data (survives a JSON round trip unchanged)", () => {
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  });

  it("carries household, plan, period, key figures and milestones", () => {
    expect(report.title).toContain(doc.plans[0]!.name);
    expect(report.household.currency).toBe(doc.household.currency);
    expect(report.plan.id).toBe(doc.plans[0]!.id);
    expect(report.period).toEqual({ start: result.meta.startMonth, end: result.meta.endMonth });
    expect(report.keyFigures.map((k) => k.id)).toEqual(
      expect.arrayContaining([
        "success",
        "startNetWorth",
        "endNetWorth",
        "lifetimeTaxes",
        "retirementYear",
      ]),
    );
    expect(report.milestones).toHaveLength(result.milestones.length);
  });

  it("series are one point per period; the table is thinned but keeps the last year", () => {
    expect(report.series.find((s) => s.id === "netWorth")!.points).toHaveLength(
      result.periods.length,
    );
    const years = report.table.rows.map((r) => r[0]);
    expect(years[0]).toBe(result.periods[0]!.year);
    expect(years[years.length - 1]).toBe(result.periods[result.periods.length - 1]!.year);
    expect(report.table.rows.length).toBeLessThan(result.periods.length);
  });

  it("lists current finances with totals, income, expenses and assumptions", () => {
    expect(report.currentFinances.accounts).toHaveLength(doc.finances.accounts.length);
    expect(report.currentFinances.totals.netWorth).toBeCloseTo(
      report.currentFinances.totals.accounts +
        report.currentFinances.totals.realAssets -
        report.currentFinances.totals.loans -
        report.currentFinances.totals.debts,
    );
    expect(report.income).toHaveLength(doc.plans[0]!.income.length);
    expect(report.expenses).toHaveLength(doc.plans[0]!.expenses.length);
    expect(report.assumptions.find((a) => a.label === "Inflation")!.value).toMatch(/%/);
  });

  it("never claims certainty: standing caveats are always present", () => {
    expect(report.caveats.length).toBeGreaterThanOrEqual(3);
    expect(report.caveats.join(" ")).toMatch(/not .*advice/i);
  });

  it("rejects an unknown plan", () => {
    expect(() => buildReportData(doc, "nope", result)).toThrow(/not found/);
  });

  it("nominal basis changes the series", () => {
    const nominal = buildReportData(doc, doc.plans[0]!.id, result, { basis: "nominal" });
    const last = result.periods[result.periods.length - 1]!;
    expect(nominal.series[0]!.points.at(-1)!.value).toBeCloseTo(last.totals.netWorth);
  });
});

describe("mapping document", () => {
  it("docs/projectionlab-mapping.md is up to date with the coverage rules", () => {
    const generated = renderMappingDoc(
      buildCoverage(collectKeyPaths(buildSyntheticExport())),
      "4.6.0",
    );
    const committed = readFileSync(
      new URL("../docs/projectionlab-mapping.md", import.meta.url),
      "utf8",
    );
    expect(committed).toBe(generated);
  });

  it("lists every key path of the synthetic (= real structure) export, with a status, and no values", () => {
    const paths = collectKeyPaths(buildSyntheticExport());
    const committed = readFileSync(
      new URL("../docs/projectionlab-mapping.md", import.meta.url),
      "utf8",
    );
    for (const p of paths.keys()) expect(committed.includes(`\`${p}\``), p).toBe(true);
    for (const secret of ["Alex Sample", "Sam Sample", "SYNTHETIC-API-KEY", "Rental Flat"])
      expect(committed).not.toContain(secret);
    expect(committed).toMatch(/\| 1135 \| \d+ \| \d+ \| \d+ \| 0 \|/);
  });
});

describe("CLI", () => {
  function makeIo(files: Record<string, string>) {
    const out: string[] = [];
    const err: string[] = [];
    const written: Record<string, string> = {};
    return {
      io: {
        readFile: (p: string) => {
          const f = files[p] ?? written[p];
          if (f === undefined) throw new Error(`ENOENT ${p}`);
          return f;
        },
        writeFile: (p: string, c: string) => {
          written[p] = c;
        },
        stdout: (l: string) => out.push(l),
        stderr: (l: string) => err.push(l),
        now: () => NOW,
      },
      out,
      err,
      written,
    };
  }

  it("import-projectionlab writes a valid document and a report, printing counts only", async () => {
    const { io, out, written } = makeIo({ "in.json": JSON.stringify(buildSyntheticExport()) });
    const code = await runCli(
      ["import-projectionlab", "in.json", "--out", "doc.json", "--report", "report.json"],
      io,
    );
    expect(code).toBe(0);
    const parsed = parseExportedDocument(written["doc.json"]!);
    expect(parsed.document.plans).toHaveLength(3);
    const report = JSON.parse(written["report.json"]!);
    expect(report.coverage.unknown).toBe(0);
    const text = out.join("\n");
    expect(text).toContain("plans=3/3");
    expect(text).toContain("unknown 0");
    for (const s of ["Alex", "Sam Sample", "Rental Flat", "SYNTHETIC-API-KEY"])
      expect(text).not.toContain(s);
    expect(written["doc.json"]).not.toContain("SYNTHETIC-API-KEY");
  });

  it("coverage exits non-zero when keys are unaccounted", async () => {
    const raw = buildSyntheticExport() as Record<string, unknown>;
    raw.brandNew = 1;
    const { io, out } = makeIo({ "in.json": JSON.stringify(raw) });
    expect(await runCli(["coverage", "in.json"], io)).toBe(2);
    expect(out.join("\n")).toContain("unaccounted: $.brandNew");
  });

  it("export-json re-exports a document", async () => {
    const { io, written } = makeIo({ "d.json": exportDocument(createSampleDocument(), NOW) });
    expect(await runCli(["export-json", "d.json", "--out", "o.json"], io)).toBe(0);
    expect(parseExportedDocument(written["o.json"]!).document.plans).toHaveLength(2);
  });

  it("import-csv is a dry run unless --apply, and writes the document when applied", async () => {
    const doc = createSampleDocument();
    const csv = `Name,Balance,Date\n${doc.finances.accounts[0]!.name},4242,2030-01-01\n`;
    const files = { "d.json": exportDocument(doc, NOW), "a.csv": csv };
    const dry = makeIo(files);
    expect(
      await runCli(["import-csv", "account-balances", "a.csv", "--doc", "d.json"], dry.io),
    ).toBe(0);
    expect(dry.written).toEqual({});
    expect(dry.out.join("\n")).toContain("dry run");
    const live = makeIo(files);
    expect(
      await runCli(
        [
          "import-csv",
          "account-balances",
          "a.csv",
          "--doc",
          "d.json",
          "--apply",
          "--out",
          "n.json",
        ],
        live.io,
      ),
    ).toBe(0);
    expect(
      parseExportedDocument(live.written["n.json"]!).document.finances.accounts[0]!.balance,
    ).toBe(4242);
  });

  it("analyze-csv shows the detected columns and exits 2 when required ones are missing", async () => {
    const ok = makeIo({ "a.csv": "Name,Balance,Date\nA,1,2026-01-01\n" });
    expect(await runCli(["analyze-csv", "account-balances", "a.csv"], ok.io)).toBe(0);
    expect(ok.out.join("\n")).toContain('column balance <- "Balance"');
    const bad = makeIo({ "a.csv": "x,y\n1,2\n" });
    expect(await runCli(["analyze-csv", "account-balances", "a.csv"], bad.io)).toBe(2);
    const mapped = makeIo({ "a.csv": "x,y\nIsa,2\n" });
    expect(
      await runCli(
        [
          "analyze-csv",
          "account-balances",
          "a.csv",
          "--column",
          "account=x",
          "--column",
          "balance=y",
        ],
        mapped.io,
      ),
    ).toBe(0);
  });

  it("export-csv writes a projection table and the progress table", async () => {
    const files = { "d.json": exportDocument(createSampleDocument(), NOW) };
    const a = makeIo(files);
    expect(
      await runCli(
        ["export-csv", "year-by-year", "d.json", "--out", "y.csv", "--basis", "nominal"],
        a.io,
      ),
    ).toBe(0);
    expect(parseCsv(a.written["y.csv"]!).rows[0]![0]).toBe("Year");
    const b = makeIo(files);
    expect(await runCli(["export-csv", "progress", "d.json", "--out", "p.csv"], b.io)).toBe(0);
    expect(parseCsv(b.written["p.csv"]!).rows[0]![0]).toBe("Date");
    const c = makeIo(files);
    expect(await runCli(["report", "d.json", "--out", "r.json"], c.io)).toBe(0);
    expect(JSON.parse(c.written["r.json"]!).caveats.length).toBeGreaterThan(0);
  });

  it("errors: unknown command, missing flags, unknown table", async () => {
    const a = makeIo({});
    expect(await runCli(["frobnicate"], a.io)).toBe(1);
    expect(await runCli([], a.io)).toBe(1);
    expect(await runCli(["import-projectionlab", "in.json"], a.io)).toBe(1);
    expect(a.err.join("\n")).toMatch(/unknown command/);
    const b = makeIo({ "d.json": exportDocument(createSampleDocument(), NOW) });
    expect(await runCli(["export-csv", "nonsense", "d.json", "--out", "x"], b.io)).toBe(1);
    expect(b.err.join("\n")).toMatch(/unknown table/);
  });
});
