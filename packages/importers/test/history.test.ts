/** Balance-history import: reading, matching, previewing, planning and exporting. Synthetic data only. */
import type { ProgressSnapshot } from "@glideworth/core";
import { createSampleDocument } from "@glideworth/core/samples";
import { describe, expect, it } from "vitest";
import {
  applyHistoryPlan,
  balanceHistoryTemplate,
  excelSerialToIso,
  exportBalanceHistory,
  type HistoryRow,
  type HistoryTarget,
  historyTargets,
  matchHistoryColumns,
  normaliseLabel,
  parseBalanceHistory,
  parseHistoryKey,
  planHistoryImport,
  previewHistory,
  readAmount,
  readDateCell,
  readHistorySheet,
  resolveDateFormat,
} from "../src/index.js";

const TODAY = "2026-11-23";
const doc = createSampleDocument();
const targets = historyTargets(doc.finances, doc.household.currency);

function parse(text: string, extra: Partial<Parameters<typeof parseBalanceHistory>[1]> = {}) {
  return parseBalanceHistory(text, { targets, today: TODAY, ...extra });
}

function snap(p: Partial<ProgressSnapshot> & { id: string; date: string }): ProgressSnapshot {
  return {
    householdId: "hh-sample",
    source: "manual",
    netWorth: 0,
    assets: 0,
    liabilities: 0,
    byCategory: {},
    accounts: [],
    realAssets: [],
    debts: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    ...p,
  };
}

describe("targets", () => {
  it("lists accounts, real assets, their loans and debts with unique labels", () => {
    expect(targets.map((t) => t.key)).toEqual([
      "account:acc-cash",
      "account:acc-brokerage",
      "account:acc-avery-401k",
      "account:acc-jordan-roth",
      "account:acc-hsa",
      "asset:ra-home",
      "loan:ra-home",
      "debt:debt-car",
    ]);
    expect(targets.find((t) => t.key === "loan:ra-home")).toMatchObject({
      label: "Home (loan)",
      side: "liability",
      category: "loans",
    });
  });

  it("adds the id to labels two targets would share", () => {
    const f = structuredClone(doc.finances);
    f.accounts[1]!.name = f.accounts[0]!.name;
    const t = historyTargets(f);
    expect(t[0]!.label).toBe(`${f.accounts[0]!.name} [acc-cash]`);
    expect(t[1]!.label).toBe(`${f.accounts[0]!.name} [acc-brokerage]`);
  });

  it("parses keys and refuses anything else", () => {
    expect(parseHistoryKey("account:acc-1")).toEqual({
      type: "entity",
      kind: "account",
      id: "acc-1",
    });
    expect(parseHistoryKey("netWorth")).toEqual({ type: "total", total: "netWorth" });
    expect(parseHistoryKey("note")).toEqual({ type: "note" });
    expect(parseHistoryKey("account:__proto__")).toBeUndefined();
    expect(parseHistoryKey("account:a b")).toBeUndefined();
    expect(parseHistoryKey("savings:x")).toBeUndefined();
  });
});

describe("reading the sheet", () => {
  it("detects comma, tab and semicolon delimiters", () => {
    expect(readHistorySheet("Date,A,B\n2024-01-31,1,2\n").delimiter).toBe(",");
    expect(readHistorySheet("Date\tA\tB\n2024-01-31\t1\t2\n").delimiter).toBe("\t");
    expect(readHistorySheet("Date;A;B\n31/01/2024;1,5;2\n").delimiter).toBe(";");
  });

  it("reads dates down the rows", () => {
    const s = readHistorySheet("Date,Savings,Brokerage\n2024-01-31,100,200\n2024-02-29,110,\n");
    expect(s.layout).toBe("rows");
    expect(s.headers).toEqual(["Savings", "Brokerage"]);
    expect(s.records.map((r) => r.rawDate)).toEqual(["2024-01-31", "2024-02-29"]);
    expect(s.records[1]!.cells).toEqual(["110", ""]);
    expect(s.records[1]!.refs).toEqual(["B3", "C3"]);
  });

  it("detects dates across the columns and can be turned back by hand", () => {
    const text = "Account,Jan 2024,Feb 2024,Mar 2024\nSavings,100,110,120\nBrokerage,200,210,220\n";
    const s = readHistorySheet(text);
    expect(s.layout).toBe("columns");
    expect(s.headers).toEqual(["Savings", "Brokerage"]);
    expect(s.records.map((r) => [r.rawDate, ...r.cells])).toEqual([
      ["Jan 2024", "100", "200"],
      ["Feb 2024", "110", "210"],
      ["Mar 2024", "120", "220"],
    ]);
    expect(s.records[0]!.refs).toEqual(["B2", "B3"]);
    const forced = readHistorySheet(text, { layout: "rows" });
    expect(forced.layout).toBe("rows");
    expect(forced.detectedLayout).toBe("columns");
  });

  it("finds the date column when it is not the first", () => {
    const s = readHistorySheet("Savings,Date,Brokerage\n100,2024-01-31,200\n");
    expect(s.dateLabel).toBe("Date");
    expect(s.headers).toEqual(["Savings", "Brokerage"]);
  });

  it("pivots a long file (date, account, balance)", () => {
    const s = readHistorySheet(
      "Date,Account,Balance\n2024-01-31,Savings,100\n2024-01-31,Brokerage,200\n2024-02-29,Savings,110\n",
    );
    expect(s.layout).toBe("long");
    expect(s.headers).toEqual(["Savings", "Brokerage"]);
    expect(s.records).toHaveLength(3);
    expect(s.records[2]!.cells).toEqual(["110", ""]);
    expect(s.records[2]!.refs).toEqual(["C4", ""]);
  });

  it("names the columns of a file without a header row", () => {
    const s = readHistorySheet("2024-01-31,100,200\n2024-02-29,110,210\n");
    expect(s.headerless).toBe(true);
    expect(s.headers).toEqual(["Column B", "Column C"]);
    expect(s.records).toHaveLength(2);
  });
});

describe("dates", () => {
  it("reads ISO, month names, months, years and spreadsheet serials", () => {
    expect(readDateCell("2024-01-31")).toEqual({ kind: "exact", iso: "2024-01-31", how: "iso" });
    expect(readDateCell("2024/1/5")).toEqual({ kind: "exact", iso: "2024-01-05", how: "iso" });
    expect(readDateCell("2024-01-31T00:00:00")).toMatchObject({ iso: "2024-01-31" });
    expect(readDateCell("15 Jan 2024")).toMatchObject({ iso: "2024-01-15" });
    expect(readDateCell("Jan 15, 2024")).toMatchObject({ iso: "2024-01-15" });
    expect(readDateCell("Jan 2024")).toEqual({ kind: "month", year: 2024, month: 1 });
    expect(readDateCell("January 2024")).toEqual({ kind: "month", year: 2024, month: 1 });
    expect(readDateCell("Jan-24")).toEqual({ kind: "month", year: 2024, month: 1 });
    expect(readDateCell("2024-01")).toEqual({ kind: "month", year: 2024, month: 1 });
    expect(readDateCell("01/2024")).toEqual({ kind: "month", year: 2024, month: 1 });
    expect(readDateCell("2023")).toEqual({ kind: "year", year: 2023 });
    expect(readDateCell("45322")).toEqual({ kind: "exact", iso: "2024-01-31", how: "serial" });
    expect(readDateCell("45322", false)).toEqual({ kind: "invalid" });
    expect(readDateCell("2024-02-30")).toEqual({ kind: "invalid" });
    expect(readDateCell("")).toEqual({ kind: "blank" });
    expect(readDateCell("soon")).toEqual({ kind: "invalid" });
  });

  it("converts Excel serials in the 1900 system", () => {
    expect(excelSerialToIso(45292)).toBe("2024-01-01");
    expect(excelSerialToIso(36526)).toBe("2000-01-01");
  });

  it("decides month-first or day-first from the column, never from one cell", () => {
    const us = ["01/31/2024", "02/29/2024", "03/05/2024"].map((s) => readDateCell(s));
    expect(resolveDateFormat(us)).toMatchObject({ format: "MDY", ambiguous: false });
    const eu = ["31/01/2024", "29/02/2024", "05/03/2024"].map((s) => readDateCell(s));
    expect(resolveDateFormat(eu)).toMatchObject({ format: "DMY", ambiguous: false });
  });

  it("flags a column that fits both readings, with a suggestion but no guess", () => {
    const amb = ["01/02/2024", "01/03/2024", "01/04/2024"].map((s) => readDateCell(s));
    const r = resolveDateFormat(amb);
    expect(r).toMatchObject({ format: null, ambiguous: true, suggestion: "DMY" });
    expect(resolveDateFormat(amb, "MDY")).toMatchObject({ format: "MDY", ambiguous: false });
  });

  it("flags a column whose dates contradict each other", () => {
    const mixed = ["13/01/2024", "01/13/2024"].map((s) => readDateCell(s));
    expect(resolveDateFormat(mixed)).toMatchObject({ conflict: true, format: null });
  });
});

describe("amounts", () => {
  it("reads both number formats, currency symbols and negatives", () => {
    expect(readAmount("1,234.56", ".")).toEqual({ kind: "value", value: 1234.56 });
    expect(readAmount("1.234,56", ",")).toEqual({ kind: "value", value: 1234.56 });
    expect(readAmount("1 234,56", ",")).toEqual({ kind: "value", value: 1234.56 });
    expect(readAmount("$1,234", ".")).toEqual({ kind: "value", value: 1234 });
    expect(readAmount("€ 1.234,56", ",")).toEqual({ kind: "value", value: 1234.56 });
    expect(readAmount("(1,500.00)", ".")).toEqual({ kind: "value", value: -1500 });
    expect(readAmount("-1500", ".")).toEqual({ kind: "value", value: -1500 });
    expect(readAmount("£-25", ".")).toEqual({ kind: "value", value: -25 });
  });

  it("keeps blank apart from zero", () => {
    expect(readAmount("", ".")).toEqual({ kind: "blank" });
    expect(readAmount("   ", ".")).toEqual({ kind: "blank" });
    expect(readAmount("0", ".")).toEqual({ kind: "value", value: 0 });
    expect(readAmount("$ -", ".")).toEqual({ kind: "value", value: 0, dash: true });
  });

  it("refuses spreadsheet errors and text", () => {
    expect(readAmount("#N/A", ".")).toEqual({ kind: "invalid", reason: "error-marker" });
    expect(readAmount("#REF!", ".")).toEqual({ kind: "invalid", reason: "error-marker" });
    expect(readAmount("n/a", ".")).toEqual({ kind: "invalid", reason: "error-marker" });
    expect(readAmount("lots", ".")).toEqual({ kind: "invalid", reason: "unreadable" });
    expect(readAmount("5%", ".")).toEqual({ kind: "invalid", reason: "unreadable" });
    expect(readAmount("1.234.56", ".")).toEqual({ kind: "invalid", reason: "unreadable" });
  });
});

describe("matching columns", () => {
  it("normalises labels", () => {
    expect(normaliseLabel("  Avery 401(k) – Balance ")).toBe("avery 401 k balance");
    expect(normaliseLabel("Café & Co")).toBe("cafe and co");
  });

  it("matches exact, noisy and fuzzy headers with confidence", () => {
    const m = matchHistoryColumns(
      [
        "High-yield savings",
        "Joint Brokerage Balance",
        "Avery 401k",
        "Jordan Roth",
        "Home",
        "Home mortgage",
        "Car loan",
        "Net worth",
        "Notes",
        "Holiday fund",
      ],
      targets,
    );
    const pick = Object.fromEntries(m.map((x) => [x.header, [x.key, x.reason]]));
    expect(pick["High-yield savings"]).toEqual(["account:acc-cash", "exact"]);
    expect(pick["Joint Brokerage Balance"]).toEqual(["account:acc-brokerage", "alias"]);
    expect(pick["Avery 401k"]![0]).toBe("account:acc-avery-401k");
    expect(pick["Jordan Roth"]![0]).toBe("account:acc-jordan-roth");
    expect(pick.Home).toEqual(["asset:ra-home", "exact"]);
    expect(pick["Home mortgage"]).toEqual(["loan:ra-home", "alias"]);
    expect(pick["Car loan"]).toEqual(["debt:debt-car", "exact"]);
    expect(pick["Net worth"]).toEqual(["netWorth", "total"]);
    expect(pick.Notes).toEqual(["note", "note"]);
    expect(pick["Holiday fund"]).toEqual([null, "none"]);
    for (const x of m) if (x.reason === "exact") expect(x.confidence).toBeGreaterThanOrEqual(0.99);
  });

  it("gives each target to one column only, the best one", () => {
    const m = matchHistoryColumns(["Savings", "High-yield savings"], targets);
    expect(m[1]!.key).toBe("account:acc-cash");
    expect(m[0]!.key).toBeNull();
    expect(m[0]!.alternatives[0]?.key).toBe("account:acc-cash");
  });

  it("uses an [id] suffix when names are shared", () => {
    const m = matchHistoryColumns(["Anything [acc-hsa]", "Home (loan) [ra-home]"], targets);
    expect(m.map((x) => x.key)).toEqual(["account:acc-hsa", "loan:ra-home"]);
  });
});

describe("preview", () => {
  it("flags every problem cell and keeps the clean ones", () => {
    const p = parse(
      [
        "Date,High-yield savings,Joint brokerage,Car loan,Home",
        "2024-01-31,1000,#N/A,-5000,300000",
        "2024-02-29,,0,-4900,-1",
        "2024-02-30,5,5,5,5",
        "2099-01-01,5,5,5,5",
      ].join("\n"),
    );
    const r = p.preview.records;
    expect(r[0]!.cells.map((c) => c.status)).toEqual(["value", "error", "value", "value"]);
    expect(r[0]!.cells[1]!.ref).toBe("C2");
    expect(r[0]!.cells[2]!.value).toBe(5000);
    expect(r[1]!.cells.map((c) => c.status)).toEqual(["blank", "value", "value", "error"]);
    expect(r[1]!.cells[3]!.code).toBe("history.value.negative");
    expect(r[2]!.dateStatus).toBe("error");
    expect(r[3]!.dateCode).toBe("history.date.future");
    expect(p.preview.counts).toMatchObject({
      dates: 2,
      values: 5,
      blanks: 1,
      errors: 4,
      badDates: 2,
    });
    expect(p.preview.issues.map((i) => i.code)).toContain("history.value.liability-sign");
    expect(p.preview.blocked).toBe(false);
    expect(p.preview.rows).toEqual([
      {
        date: "2024-01-31",
        values: { "account:acc-cash": 1000, "debt:debt-car": 5000, "asset:ra-home": 300000 },
      },
      {
        date: "2024-02-29",
        values: { "account:acc-cash": null, "account:acc-brokerage": 0, "debt:debt-car": 4900 },
      },
    ]);
  });

  it("warns on a single negative debt and reads its size", () => {
    const p = parse("Date,Car loan\n2024-01-31,5000\n2024-02-29,-4900\n");
    const c = p.preview.records[1]!.cells[0]!;
    expect(c).toMatchObject({
      status: "warning",
      value: 4900,
      code: "history.value.liability-sign",
    });
  });

  it("blocks ambiguous dates until a format is chosen", () => {
    const text = "Date,High-yield savings\n01/02/2024,1\n01/03/2024,2\n01/04/2024,3\n";
    const p = parse(text);
    expect(p.preview.blocked).toBe(true);
    expect(p.preview.issues[0]!.code).toBe("history.date.ambiguous");
    expect(p.preview.rows).toEqual([]);
    const us = parse(text, { dateFormat: "MDY" });
    expect(us.preview.blocked).toBe(false);
    expect(us.preview.rows.map((r) => r.date)).toEqual(["2024-01-02", "2024-01-03", "2024-01-04"]);
    const eu = parse(text, { dateFormat: "DMY" });
    expect(eu.preview.rows.map((r) => r.date)).toEqual(["2024-02-01", "2024-03-01", "2024-04-01"]);
  });

  it("reads a decimal-comma file and dates months at their end (or start)", () => {
    const text = "Datum;High-yield savings\nJan 2024;1.234,56\nFeb 2024;2.000,00\n";
    const p = parse(text);
    expect(p.preview.decimal.used).toBe(",");
    expect(p.preview.hasPeriodDates).toBe(true);
    expect(p.preview.rows).toEqual([
      { date: "2024-01-31", values: { "account:acc-cash": 1234.56 } },
      { date: "2024-02-29", values: { "account:acc-cash": 2000 } },
    ]);
    const start = parse(text, { periodDay: "start" });
    expect(start.preview.rows.map((r) => r.date)).toEqual(["2024-01-01", "2024-02-01"]);
  });

  it("dates the current month today rather than in the future", () => {
    const p = parse("Date,High-yield savings\nNov 2026,10\n");
    expect(p.preview.rows[0]!.date).toBe(TODAY);
    expect(p.preview.records[0]!.dateCode).toBe("history.date.period-today");
  });

  it("warns when the number format is a guess", () => {
    const p = parse('Date,High-yield savings\n2024-01-31,"1,234"\n');
    expect(p.preview.issues.map((i) => i.code)).toContain("history.number.ambiguous");
    expect(p.preview.rows[0]!.values["account:acc-cash"]).toBe(1234);
    const comma = parse('Date,High-yield savings\n2024-01-31,"1,234"\n', { decimalSeparator: "," });
    expect(comma.preview.rows[0]!.values["account:acc-cash"]).toBe(1.234);
  });

  it("combines rows that share a date and flags conflicting values", () => {
    const p = parse(
      "Date,High-yield savings,Joint brokerage\n2024-01-31,100,\n2024-01-31,,200\n2024-02-29,5,1\n2024-02-29,6,1\n",
    );
    expect(p.preview.rows[0]).toEqual({
      date: "2024-01-31",
      values: { "account:acc-cash": 100, "account:acc-brokerage": 200 },
    });
    expect(p.preview.rows[1]).toEqual({
      date: "2024-02-29",
      values: { "account:acc-brokerage": 1 },
    });
    expect(p.preview.records[2]!.cells[0]!.code).toBe("history.value.conflict");
    expect(p.preview.records[3]!.cells[0]!.code).toBe("history.value.conflict");
  });

  it("honours explicit column choices and refuses a target mapped twice", () => {
    const p = parse("Date,Pot,Other\n2024-01-31,1,2\n", {
      columns: { pot: "account:acc-hsa", Other: "skip" },
    });
    expect(p.preview.mapping).toEqual(["account:acc-hsa", null]);
    const twice = previewHistory(
      readHistorySheet("Date,A,B\n2024-01-31,1,2\n"),
      ["account:acc-hsa", "account:acc-hsa"],
      targets,
      { today: TODAY },
    );
    expect(twice.blocked).toBe(true);
    expect(twice.issues[0]!.code).toBe("history.mapping.duplicate");
  });

  it("reads a long file into one row per date", () => {
    const p = parse(
      "Date,Account,Balance\n2024-01-31,High-yield savings,100\n2024-01-31,Car loan,900\n2024-02-29,High-yield savings,110\n",
    );
    expect(p.sheet.layout).toBe("long");
    expect(p.preview.rows).toEqual([
      { date: "2024-01-31", values: { "account:acc-cash": 100, "debt:debt-car": 900 } },
      { date: "2024-02-29", values: { "account:acc-cash": 110, "debt:debt-car": null } },
    ]);
    expect(p.preview.counts.blanks).toBe(0);
  });

  it("reads Excel serial dates in the date column", () => {
    const p = parse("Date,High-yield savings\n45322,100\n");
    expect(p.preview.rows[0]!.date).toBe("2024-01-31");
    expect(p.preview.records[0]!.dateCode).toBe("history.date.serial");
  });
});

describe("planning an import", () => {
  const cash = "account:acc-cash";
  const broker = "account:acc-brokerage";
  const car = "debt:debt-car";
  const plan = (
    existing: ProgressSnapshot[],
    rows: HistoryRow[],
    extra: Partial<Parameters<typeof planHistoryImport>[0]> = {},
  ) => planHistoryImport({ existing, rows, mode: "merge", targets, today: TODAY, ...extra });

  it("creates snapshots for new dates with totals from the values", () => {
    const p = plan(
      [],
      [{ date: "2024-01-31", values: { [cash]: 1000, [broker]: 2000.5, [car]: 300 } }],
    );
    expect(p.create).toHaveLength(1);
    expect(p.create[0]).toMatchObject({
      date: "2024-01-31",
      source: "import",
      assets: 3000.5,
      liabilities: 300,
      netWorth: 2700.5,
      byCategory: { cash: 1000, taxable: 2000.5, debt: 300 },
      accounts: [
        { accountId: "acc-cash", balance: 1000 },
        { accountId: "acc-brokerage", balance: 2000.5 },
      ],
      debts: [{ debtId: "debt-car", balance: 300 }],
    });
    expect(p.counts).toMatchObject({ added: 3, updated: 0, removed: 0, snapshotsCreated: 1 });
  });

  it("updates an existing snapshot and moves its totals by the change", () => {
    const existing = [
      snap({
        id: "s1",
        date: "2024-01-31",
        assets: 10000,
        liabilities: 500,
        netWorth: 9500,
        accounts: [{ accountId: "acc-cash", balance: 1000 }],
      }),
    ];
    const p = plan(existing, [{ date: "2024-01-31", values: { [cash]: 1500, [broker]: 100 } }]);
    expect(p.update).toHaveLength(1);
    expect(p.update[0]).toMatchObject({
      id: "s1",
      assets: 10600,
      liabilities: 500,
      netWorth: 10100,
    });
    expect(p.changes).toEqual([
      { date: "2024-01-31", key: broker, before: null, after: 100, kind: "added" },
      { date: "2024-01-31", key: cash, before: 1000, after: 1500, kind: "updated" },
    ]);
  });

  it("is idempotent: the same rows a second time change nothing", () => {
    const rows: HistoryRow[] = [
      { date: "2024-01-31", values: { [cash]: 1000, [car]: 300 } },
      { date: "2024-02-29", values: { [cash]: 1100, [car]: null } },
    ];
    const first = plan([], rows);
    const after = applyHistoryPlan([], first, "hh-sample", (_d, i) => `n${i}`);
    const second = plan(after, rows);
    expect(second.counts).toMatchObject({ added: 0, updated: 0, removed: 0, unchanged: 3 });
    expect(second.create).toEqual([]);
    expect(second.update).toEqual([]);
    expect(second.remove).toEqual([]);
    const again = plan(after, rows, { mode: "replace" });
    expect(again.update).toEqual([]);
    expect(again.remove).toEqual([]);
  });

  it("merge leaves blanks and other dates alone; replace clears them inside the file's range only", () => {
    const existing = [
      snap({
        id: "a",
        date: "2023-12-31",
        accounts: [{ accountId: "acc-cash", balance: 1 }],
        assets: 1,
        netWorth: 1,
      }),
      snap({
        id: "b",
        date: "2024-02-15",
        accounts: [
          { accountId: "acc-cash", balance: 50 },
          { accountId: "acc-hsa", balance: 70 },
        ],
        assets: 120,
        netWorth: 120,
      }),
      snap({
        id: "c",
        date: "2024-02-29",
        accounts: [{ accountId: "acc-cash", balance: 9 }],
        assets: 9,
        netWorth: 9,
      }),
      snap({
        id: "d",
        date: "2024-03-31",
        accounts: [{ accountId: "acc-cash", balance: 3 }],
        assets: 3,
        netWorth: 3,
      }),
    ];
    const rows: HistoryRow[] = [
      { date: "2024-01-31", values: { [cash]: 100 } },
      { date: "2024-02-29", values: { [cash]: null } },
      { date: "2024-03-31", values: { [cash]: 3 } },
    ];
    const merge = plan(existing, rows);
    expect(merge.counts).toMatchObject({ added: 1, updated: 0, removed: 0, unchanged: 1 });
    expect(merge.remove).toEqual([]);

    const replace = plan(existing, rows, { mode: "replace" });
    expect(replace.counts).toMatchObject({ added: 1, removed: 2, unchanged: 1 });
    // 2024-02-15 is inside the range and missing from the file: its cash value goes, the HSA value stays.
    const b = replace.update.find((s) => s.id === "b")!;
    expect(b.accounts).toEqual([{ accountId: "acc-hsa", balance: 70 }]);
    expect(b).toMatchObject({ assets: 70, netWorth: 70 });
    // 2024-02-29 had only the cash value: the snapshot is deleted.
    expect(replace.remove).toEqual(["c"]);
    // 2023-12-31 is before the range and untouched.
    expect(replace.update.find((s) => s.id === "a")).toBeUndefined();
  });

  it("replace never clears a value whose cell was skipped (left out of the row)", () => {
    const existing = [
      snap({
        id: "x",
        date: "2024-01-31",
        accounts: [{ accountId: "acc-cash", balance: 5 }],
        assets: 5,
        netWorth: 5,
      }),
    ];
    const p = plan(existing, [{ date: "2024-01-31", values: { [broker]: 7 } }], {
      mode: "replace",
    });
    expect(p.update[0]!.accounts).toEqual([
      { accountId: "acc-cash", balance: 5 },
      { accountId: "acc-brokerage", balance: 7 },
    ]);
  });

  it("updates every snapshot on a date that records the field", () => {
    const existing = [
      snap({
        id: "m",
        date: "2024-01-31",
        accounts: [{ accountId: "acc-cash", balance: 1 }],
        assets: 1,
        netWorth: 1,
      }),
      snap({
        id: "auto",
        date: "2024-01-31",
        source: "auto",
        accounts: [{ accountId: "acc-cash", balance: 2 }],
        assets: 2,
        netWorth: 2,
      }),
    ];
    const p = plan(existing, [{ date: "2024-01-31", values: { [cash]: 10, [broker]: 4 } }]);
    expect(p.update.map((s) => [s.id, s.source, s.assets])).toEqual([
      ["m", "manual", 14],
      ["auto", "import", 10],
    ]);
    expect(p.counts.updated).toBe(1);
  });

  it("lets totals in the file win for their date", () => {
    const p = plan([], [{ date: "2024-01-31", values: { [cash]: 100, netWorth: 5000 } }]);
    expect(p.create[0]).toMatchObject({ netWorth: 5000, assets: 5000, liabilities: 0 });
    const totalsOnly = plan(
      [],
      [{ date: "2024-01-31", values: { assets: 900, liabilities: 100 } }],
    );
    expect(totalsOnly.create[0]).toMatchObject({
      netWorth: 800,
      assets: 900,
      liabilities: 100,
      accounts: [],
    });
  });

  it("replace with a totals column deletes totals-only snapshots the file skips", () => {
    const existing = [snap({ id: "t", date: "2024-01-15", netWorth: 10, assets: 10 })];
    const p = plan(
      existing,
      [
        { date: "2024-01-01", values: { netWorth: 1 } },
        { date: "2024-02-01", values: { netWorth: 2 } },
      ],
      { mode: "replace" },
    );
    expect(p.remove).toEqual(["t"]);
  });

  it("converts foreign-currency values into the base currency for totals", () => {
    const f = structuredClone(doc.finances);
    f.accounts[0]!.currency = "EUR";
    f.fxRates = [{ from: "EUR", to: "USD", rate: 1.1 }] as typeof f.fxRates;
    const t = historyTargets(f, "USD");
    const p = planHistoryImport({
      existing: [],
      rows: [{ date: "2024-01-31", values: { [cash]: 100 } }],
      mode: "merge",
      targets: t,
      today: TODAY,
    });
    expect(p.create[0]).toMatchObject({
      assets: 110,
      accounts: [{ accountId: "acc-cash", balance: 100 }],
    });
  });

  it("handles a real asset and its loan in one entry", () => {
    const p = plan(
      [],
      [{ date: "2024-01-31", values: { "asset:ra-home": 400000, "loan:ra-home": 250000 } }],
    );
    expect(p.create[0]).toMatchObject({
      realAssets: [{ assetId: "ra-home", value: 400000, loanBalance: 250000 }],
      assets: 400000,
      liabilities: 250000,
      netWorth: 150000,
      byCategory: { "real-assets": 400000, loans: 250000 },
    });
  });

  it("refuses bad rows: future dates, unknown targets, negative debts, conflicts", () => {
    const p = plan(
      [],
      [
        { date: "2099-01-01", values: { [cash]: 1 } },
        { date: "2024-01-31", values: { "account:nope": 1, [car]: -5 } },
        { date: "2024-02-29", values: { [cash]: 1 } },
        { date: "2024-02-29", values: { [cash]: 2 } },
      ],
    );
    expect(p.issues.map((i) => i.code)).toEqual([
      "history.date.future",
      "history.key.unknown",
      "history.value.negative",
      "history.value.conflict",
    ]);
    expect(p.create).toEqual([]);
    // Messages never carry stored values.
    for (const i of p.issues) expect(i.message).not.toMatch(/\d{2,}/);
  });

  it("updates current balances from today's row only when asked", () => {
    const rows: HistoryRow[] = [
      {
        date: TODAY,
        values: { [cash]: 42, "asset:ra-home": 500000, "loan:ra-home": 200000, [car]: 10 },
      },
    ];
    expect(plan([], rows).current).toBeNull();
    expect(plan([], rows, { updateCurrent: true }).current).toEqual({
      accounts: [{ accountId: "acc-cash", balance: 42 }],
      realAssets: [{ assetId: "ra-home", currentValue: 500000, loanBalance: 200000 }],
      debts: [{ debtId: "debt-car", balance: 10 }],
    });
    const old = plan([], [{ date: "2024-01-31", values: { [cash]: 1 } }], { updateCurrent: true });
    expect(old.current).toBeNull();
    expect(old.issues.map((i) => i.code)).toEqual(["history.current.no-today"]);
  });
});

describe("export and template", () => {
  const history = [
    snap({
      id: "e1",
      date: "2024-01-31",
      accounts: [{ accountId: "acc-cash", balance: 1000 }],
      debts: [{ debtId: "debt-car", balance: 300 }],
      assets: 1000,
      liabilities: 300,
      netWorth: 700,
      note: "first, with a comma",
    }),
    snap({
      id: "e2",
      date: "2024-02-29",
      accounts: [
        { accountId: "acc-cash", balance: 1100.25 },
        { accountId: "acc-brokerage", balance: 50 },
      ],
      assets: 1150.25,
      netWorth: 1150.25,
    }),
  ];

  it("exports one row per date with the accounts in the target order", () => {
    expect(exportBalanceHistory(history, targets)).toBe(
      [
        "Date,High-yield savings,Joint brokerage,Car loan,Net worth,Assets,Liabilities,Note",
        '2024-01-31,1000,,300,700,1000,300,"first, with a comma"',
        "2024-02-29,1100.25,50,,1150.25,1150.25,0,",
        "",
      ].join("\n"),
    );
  });

  it("exports dates as columns, tab separated, for the chosen accounts", () => {
    const out = exportBalanceHistory(history, targets, {
      layout: "columns",
      delimiter: "\t",
      keys: ["account:acc-cash"],
      totals: false,
    });
    expect(out).toBe("Date\t2024-01-31\t2024-02-29\nHigh-yield savings\t1000\t1100.25\n");
  });

  it("round-trips: importing an export changes nothing", () => {
    for (const layout of ["rows", "columns"] as const) {
      const text = exportBalanceHistory(history, targets, { layout });
      const p = parse(text);
      expect(p.preview.blocked).toBe(false);
      expect(p.preview.counts.errors).toBe(0);
      const planned = planHistoryImport({
        existing: history,
        rows: p.preview.rows,
        mode: "replace",
        targets,
        today: TODAY,
      });
      expect(planned.create).toEqual([]);
      expect(planned.update).toEqual([]);
      expect(planned.remove).toEqual([]);
    }
  });

  it("writes a template that lists the accounts and maps back exactly", () => {
    const t = balanceHistoryTemplate(targets);
    expect(t).toBe(
      "Date,High-yield savings,Joint brokerage,Avery 401(k),Jordan Roth IRA,Family HSA,Home,Home (loan),Car loan\n",
    );
    const m = matchHistoryColumns(
      readHistorySheet(`${t}2024-01-31,1,2,3,4,5,6,7,8\n`).headers,
      targets,
    );
    expect(m.map((x) => x.key)).toEqual(targets.map((x) => x.key));
    expect(m.every((x) => x.confidence === 1)).toBe(true);
    expect(balanceHistoryTemplate(targets, { layout: "columns" }).split("\n")[0]).toBe("Date");
  });
});

describe("targets in a household with no loans or debts", () => {
  it("still matches and plans", () => {
    const t: HistoryTarget[] = historyTargets({
      accounts: doc.finances.accounts,
      realAssets: [],
      debts: [],
    });
    const p = parseBalanceHistory("Date,Family HSA\n2024-01-31,10\n", { targets: t, today: TODAY });
    expect(p.preview.rows).toEqual([{ date: "2024-01-31", values: { "account:acc-hsa": 10 } }]);
  });
});
