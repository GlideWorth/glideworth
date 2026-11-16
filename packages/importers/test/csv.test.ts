import { createSampleDocument } from "@glideworth/core/samples";
import { describe, expect, it } from "vitest";
import {
  analyzeCsv,
  applyExpenseSummary,
  applyProgressSnapshots,
  applyReconciliation,
  csvAccountType,
  detectDateFormat,
  detectDecimalSeparator,
  expenseTypeForCategory,
  importCsv,
  importCsvInto,
  matchPresets,
  PRESETS,
  parseAccountBalances,
  parseCsv,
  parseDate,
  parseNumber,
  parseProgressCsv,
  reconcileBalances,
  sniffDelimiter,
  summariseTransactions,
  toCsv,
} from "../src/index.js";

describe("CSV tokenizer", () => {
  it("handles quotes, escaped quotes, embedded delimiters and newlines", () => {
    const r = parseCsv('a,b,c\n"x, y","he said ""hi""","line1\nline2"\n');
    expect(r.rows).toEqual([
      ["a", "b", "c"],
      ["x, y", 'he said "hi"', "line1\nline2"],
    ]);
  });

  it("handles CRLF, a BOM, a missing final newline and blank lines", () => {
    const r = parseCsv("﻿a,b\r\n1,2\r\n\r\n3,4");
    expect(r.rows).toEqual([
      ["a", "b"],
      ["1", "2"],
      ["3", "4"],
    ]);
  });

  it("sniffs delimiters", () => {
    expect(sniffDelimiter("a;b;c\n1;2;3\n")).toBe(";");
    expect(sniffDelimiter("a\tb\tc\n1\t2\t3\n")).toBe("\t");
    expect(sniffDelimiter("a|b\n1|2\n")).toBe("|");
    expect(sniffDelimiter('a,b\n"1,5",2\n')).toBe(",");
    expect(parseCsv("a;b\n1,5;2").rows[1]).toEqual(["1,5", "2"]);
  });

  it("writes CSV with quoting and neutralises formula injection", () => {
    expect(
      toCsv([
        ["a", "b,c", 'd"e'],
        [1, null, true],
      ]),
    ).toBe('a,"b,c","d""e"\n1,,true\n');
    expect(toCsv([['=HYPERLINK("x")', "-5", "+1", "ok"]])).toBe(`"'=HYPERLINK(""x"")",-5,'+1,ok\n`);
  });
});

describe("number parsing", () => {
  it("en-GB / en-US: comma thousands, dot decimal", () => {
    for (const locale of ["en-GB", "en-US"] as const) {
      expect(parseNumber("1,234.56", { locale })).toBe(1234.56);
      expect(parseNumber("1,234,567", { locale })).toBe(1234567);
      expect(parseNumber("0.5", { locale })).toBe(0.5);
      expect(parseNumber(".5", { locale })).toBe(0.5);
    }
  });

  it("currency symbols, codes, spaces and signs", () => {
    expect(parseNumber("£1,234.50", { locale: "en-GB" })).toBe(1234.5);
    expect(parseNumber("$ 1 234.50", { locale: "en-US" })).toBe(1234.5);
    expect(parseNumber("GBP 99.99", { locale: "en-GB" })).toBe(99.99);
    expect(parseNumber("99.99 USD", { locale: "en-US" })).toBe(99.99);
    expect(parseNumber("-1,200.00", { locale: "en-GB" })).toBe(-1200);
    expect(parseNumber("−1,200.00", { locale: "en-GB" })).toBe(-1200);
    expect(parseNumber("(1,200.00)", { locale: "en-US" })).toBe(-1200);
    expect(parseNumber("1,200.00-", { locale: "en-US" })).toBe(-1200);
    expect(parseNumber("+15", { locale: "en-US" })).toBe(15);
    expect(parseNumber("120.00 DR", { locale: "en-GB" })).toBe(-120);
    expect(parseNumber("120.00 CR", { locale: "en-GB" })).toBe(120);
  });

  it("decimal-comma files", () => {
    expect(parseNumber("1.234,56", { decimalSeparator: "," })).toBe(1234.56);
    expect(parseNumber("1 234,56", { decimalSeparator: "," })).toBe(1234.56);
    expect(parseNumber("0,75", { decimalSeparator: "," })).toBe(0.75);
    expect(parseNumber("€ 12,5", { decimalSeparator: "," })).toBe(12.5);
  });

  it("auto locale picks the separator from the shape", () => {
    expect(parseNumber("1.234,56")).toBe(1234.56);
    expect(parseNumber("1,234.56")).toBe(1234.56);
    expect(parseNumber("12,5")).toBe(12.5);
    expect(parseNumber("1,234")).toBe(1234);
    expect(parseNumber("1.234.567")).toBe(1234567);
    expect(detectDecimalSeparator(["1.234,56", "12,5", "0,99"])).toBe(",");
    expect(detectDecimalSeparator(["1,234.56", "12.5"])).toBe(".");
    expect(detectDecimalSeparator(["100", "200"])).toBeUndefined();
  });

  it("rejects what is not a number", () => {
    for (const s of ["", "abc", "1,23,456", "12.3.4", "--5", "1e5x", "12,34", "-"]) {
      expect(parseNumber(s, { locale: "en-GB" }), s).toBeUndefined();
    }
  });
});

describe("date parsing", () => {
  it("ISO, with times and separators", () => {
    expect(parseDate("2026-01-31")).toBe("2026-01-31");
    expect(parseDate("2026/1/5")).toBe("2026-01-05");
    expect(parseDate("2026-01-31T10:20:30Z")).toBe("2026-01-31");
    expect(parseDate("2026-01-31 10:20")).toBe("2026-01-31");
  });

  it("en-GB day-first vs en-US month-first", () => {
    expect(parseDate("03/04/2026", { locale: "en-GB" })).toBe("2026-04-03");
    expect(parseDate("03/04/2026", { locale: "en-US" })).toBe("2026-03-04");
    expect(parseDate("03/04/2026", { format: "DD/MM/YYYY" })).toBe("2026-04-03");
    expect(parseDate("03/04/2026", { format: "MM/DD/YYYY" })).toBe("2026-03-04");
    expect(parseDate("31.01.2026", { locale: "en-GB" })).toBe("2026-01-31");
    expect(parseDate("1-2-26", { locale: "en-GB" })).toBe("2026-02-01");
    expect(parseDate("1-2-99", { locale: "en-US" })).toBe("1999-01-02");
  });

  it("month names", () => {
    expect(parseDate("15 Jan 2026")).toBe("2026-01-15");
    expect(parseDate("5 September 2026")).toBe("2026-09-05");
    expect(parseDate("Jan 15, 2026")).toBe("2026-01-15");
    expect(parseDate("March 3rd, 2026")).toBe("2026-03-03");
  });

  it("rejects invalid dates", () => {
    expect(parseDate("31/02/2026", { locale: "en-GB" })).toBeUndefined();
    expect(parseDate("13/13/2026")).toBeUndefined();
    expect(parseDate("29/02/2025", { locale: "en-GB" })).toBeUndefined();
    expect(parseDate("29/02/2024", { locale: "en-GB" })).toBe("2024-02-29");
    expect(parseDate("soon")).toBeUndefined();
    expect(parseDate("")).toBeUndefined();
  });

  it("detects the format of a column", () => {
    expect(detectDateFormat(["13/01/2026", "02/03/2026"])).toEqual({
      format: "DD/MM/YYYY",
      ambiguous: false,
    });
    expect(detectDateFormat(["01/13/2026", "02/03/2026"])).toEqual({
      format: "MM/DD/YYYY",
      ambiguous: false,
    });
    expect(detectDateFormat(["01/02/2026", "03/04/2026"])).toEqual({
      format: "DD/MM/YYYY",
      ambiguous: true,
    });
    expect(detectDateFormat(["01/02/2026"], "en-US")).toEqual({
      format: "MM/DD/YYYY",
      ambiguous: true,
    });
    expect(detectDateFormat(["2026-01-02"])).toEqual({ format: "YYYY-MM-DD", ambiguous: false });
  });
});

describe("column detection and presets", () => {
  it("detects columns by alias regardless of case and punctuation", () => {
    const a = analyzeCsv(
      "Account Name,Balance (GBP),As Of\nISA,100,2026-01-01\n",
      "account-balances",
    );
    expect(a.columns).toEqual({ account: "Account Name", balance: "Balance (GBP)", date: "As Of" });
    expect(a.missing).toEqual([]);
  });

  it("reports missing required columns", () => {
    const a = analyzeCsv("foo,bar\n1,2\n", "account-balances");
    expect(a.missing).toContain("account");
    const p = parseAccountBalances("foo,bar\nx,y\n");
    expect(p.rows).toEqual([]);
    expect(p.issues.some((i) => i.code === "csv.missing-columns" && i.severity === "error")).toBe(
      true,
    );
  });

  it("a mapping override beats detection and presets", () => {
    const csv = "Pot,Total,Value\nISA,1,100\n";
    const a = analyzeCsv(csv, "account-balances", {
      columns: { account: "Pot", balance: "Value" },
    });
    expect(a.columns).toMatchObject({ account: "Pot", balance: "Value" });
    const rows = parseAccountBalances(csv, { columns: { account: "pot", balance: "VALUE" } }).rows;
    expect(rows).toEqual([
      { line: 2, name: "ISA", entity: "account", balance: 100, type: undefined, date: undefined },
    ]);
  });

  it("warns about an override pointing at a missing header", () => {
    const a = analyzeCsv("a,b\n1,2\n", "account-balances", { columns: { account: "nope" } });
    expect(a.issues.some((i) => i.code === "csv.column")).toBe(true);
  });

  it("falls back to content sniffing for date and money columns", () => {
    const a = analyzeCsv(
      "thing,x,y\nISA,2026-01-01,1500.50\nSIPP,2026-01-01,2000\n",
      "account-balances",
    );
    expect(a.columns.date).toBe("x");
    expect(a.columns.balance).toBe("y");
    expect(a.confidence.date).toBeLessThan(1);
  });

  it("every preset matches its own signature, and signatures are distinct enough to pick the right one", () => {
    for (const p of PRESETS) {
      const headers = Object.values(p.columns) as string[];
      const full = [...new Set([...headers, ...p.signature])];
      const matches = matchPresets(full, p.kind);
      expect(
        matches.map((m) => m.id),
        p.id,
      ).toContain(p.id);
    }
    expect(
      matchPresets(
        ["Transaction ID", "Date", "Time", "Type", "Name", "Category", "Amount", "Currency"],
        "transactions",
      )[0]!.id,
    ).toBe("monzo");
    expect(
      matchPresets(
        [
          "Date",
          "Merchant",
          "Category",
          "Account",
          "Original Statement",
          "Notes",
          "Amount",
          "Tags",
        ],
        "transactions",
      )[0]!.id,
    ).toBe("monarch-transactions");
  });

  it("applies a preset automatically and reports it", () => {
    const csv =
      'Account,Flag,Date,Payee,Category Group/Category,Category,Memo,Outflow,Inflow,Cleared\nCurrent,,01/02/2026,Shop,Food: Groceries,Groceries,,"£12.50",,Cleared\n';
    const a = analyzeCsv(csv, "transactions");
    expect(a.preset?.id).toBe("ynab-register");
    expect(a.columns).toMatchObject({ debit: "Outflow", credit: "Inflow", category: "Category" });
    const none = analyzeCsv(csv, "transactions", { preset: "none" });
    expect(none.preset).toBeUndefined();
  });
});

describe("account balances", () => {
  const doc = () => createSampleDocument();
  const csv = [
    "Name,Type,Balance,Date",
    'Cash Buffer,Savings,"£12,000.50",15/11/2026',
    "Stocks and Shares ISA,ISA,45000,15/11/2026",
    "Brand New Pot,Crypto,500,15/11/2026",
    'Credit Card,Credit card,"(1,200.00)",15/11/2026',
    "Broken,Savings,lots,15/11/2026",
  ].join("\n");

  it("parses rows with locale-aware numbers and dates, and reports bad rows", () => {
    const p = parseAccountBalances(csv, { locale: "en-GB" });
    expect(p.rows).toHaveLength(4);
    expect(p.rows[0]).toMatchObject({
      name: "Cash Buffer",
      type: "savings",
      balance: 12000.5,
      date: "2026-11-15",
      entity: "account",
    });
    expect(p.rows[1]).toMatchObject({ type: "uk-isa" });
    expect(p.rows[3]).toMatchObject({ entity: "debt", balance: -1200 });
    expect(p.issues.find((i) => i.sourcePath === "csv:row:6")?.code).toBe("csv.bad-number");
    expect(p.analysis.dateFormat).toBe("DD/MM/YYYY");
  });

  it("the same file read as en-US swaps day and month", () => {
    const us = parseAccountBalances("Name,Balance,Date\nA,1,03/04/2026\n", { locale: "en-US" });
    const gb = parseAccountBalances("Name,Balance,Date\nA,1,03/04/2026\n", { locale: "en-GB" });
    expect(us.rows[0]!.date).toBe("2026-03-04");
    expect(gb.rows[0]!.date).toBe("2026-04-03");
  });

  it("decimal-comma balances", () => {
    const p = parseAccountBalances("Name;Balance;Date\nKonto;1.234,56;31.01.2026\n", {
      locale: "auto",
    });
    expect(p.analysis.delimiter).toBe(";");
    expect(p.analysis.decimalSeparator).toBe(",");
    expect(p.rows[0]).toMatchObject({ balance: 1234.56, date: "2026-01-31" });
  });

  it("infers account types from text", () => {
    expect(csvAccountType("Lifetime ISA").type).toBe("uk-lisa");
    expect(csvAccountType("Stocks & Shares ISA").type).toBe("uk-isa");
    expect(csvAccountType("SIPP").type).toBe("uk-sipp");
    expect(csvAccountType("Roth IRA").type).toBe("roth-ira");
    expect(csvAccountType("401(k)").type).toBe("401k");
    expect(csvAccountType("Checking").type).toBe("cash");
    expect(csvAccountType("Brokerage").type).toBe("taxable");
    expect(csvAccountType("Mortgage").entity).toBe("debt");
    expect(csvAccountType("taxable").type).toBe("taxable");
    expect(csvAccountType("???").type).toBeUndefined();
  });

  it("reconciles against the document without changing it (preview)", () => {
    const d = doc();
    const before = JSON.stringify(d);
    const p = parseAccountBalances(
      `Name,Balance,Date\n${d.finances.accounts[0]!.name},5000,15/11/2026\nNobody,1,15/11/2026\n`,
      { locale: "en-GB" },
    );
    const rec = reconcileBalances(d, p.rows);
    expect(rec.matched).toHaveLength(1);
    expect(rec.matched[0]).toMatchObject({
      id: d.finances.accounts[0]!.id,
      after: 5000,
      delta: 5000 - d.finances.accounts[0]!.balance,
    });
    expect(rec.unmatched).toHaveLength(1);
    expect(rec.issues.some((i) => i.code === "csv.unmatched")).toBe(true);
    expect(rec.asOf).toBe("2026-11");
    expect(JSON.stringify(d)).toBe(before);
  });

  it("matches by name ignoring case and punctuation, and by explicit map", () => {
    const d = doc();
    const a = d.finances.accounts[0]!;
    const rows = parseAccountBalances(
      `Name,Balance\n${a.name.toUpperCase()}!,1\nMy Label,2\n`,
    ).rows;
    const rec = reconcileBalances(d, rows, {
      accountMap: { "My Label": d.finances.accounts[1]!.id },
    });
    expect(rec.matched.map((m) => m.id)).toEqual([a.id, d.finances.accounts[1]!.id]);
    const bad = reconcileBalances(d, rows, { accountMap: { "My Label": "zzz" } });
    expect(bad.issues.some((i) => i.code === "csv.bad-map")).toBe(true);
  });

  it("keeps the newest row per account when a history is supplied", () => {
    const d = doc();
    const a = d.finances.accounts[0]!;
    const rows = parseAccountBalances(
      `Name,Balance,Date\n${a.name},1,2026-01-01\n${a.name},3,2026-03-01\n${a.name},2,2026-02-01\n`,
    ).rows;
    const rec = reconcileBalances(d, rows);
    expect(rec.matched).toHaveLength(1);
    expect(rec.matched[0]!.after).toBe(3);
    expect(rec.superseded).toHaveLength(2);
  });

  it("applies: updates balances, adds new accounts and debts, moves asOf forward", () => {
    const d = doc();
    const p = parseAccountBalances(csv.replace("Cash Buffer", d.finances.accounts[0]!.name), {
      locale: "en-GB",
    });
    const rec = reconcileBalances(d, p.rows, { createMissing: true });
    const next = applyReconciliation(d, rec);
    expect(next.finances.accounts[0]!.balance).toBe(12000.5);
    expect(next.finances.accounts.find((a) => a.name === "Brand New Pot")).toMatchObject({
      type: "crypto",
      balance: 500,
    });
    expect(next.finances.debts.find((x) => x.name === "Credit Card")).toMatchObject({
      balance: 1200,
    });
    expect(next.finances.asOf).toBe("2026-11");
    // The input is never mutated.
    expect(d.finances.accounts[0]!.balance).not.toBe(12000.5);
    expect(next.finances.accounts).toHaveLength(d.finances.accounts.length + 2);
  });

  it("importCsvInto is a dry run by default and applies only on request", () => {
    const d = doc();
    const text = `Name,Balance,Date\n${d.finances.accounts[0]!.name},777,2026-12-01\n`;
    const dry = importCsvInto(d, text, { kind: "account-balances" });
    expect(dry.dryRun).toBe(true);
    expect(dry.document).toBe(d);
    expect(dry.reconciliation?.matched[0]?.after).toBe(777);
    const live = importCsvInto(d, text, { kind: "account-balances" }, { dryRun: false });
    expect(live.document.finances.accounts[0]!.balance).toBe(777);
    expect(live.document.finances.asOf).toBe("2026-12");
  });

  it("a file with unmappable columns is never applied", () => {
    const d = doc();
    const out = importCsvInto(d, "x,y\n1,2\n", { kind: "account-balances" }, { dryRun: false });
    expect(out.document).toBe(d);
    expect(out.issues.some((i) => i.severity === "error")).toBe(true);
  });
});

describe("progress snapshots", () => {
  const hh = "household-1";

  it("parses net worth history with categories", () => {
    const csv = [
      "Date,Net Worth,Assets,Liabilities,Cash,Taxable,Pension",
      '31/01/2026,"£100,000","£130,000","£30,000",5000,20000,60000',
      "28/02/2026,105000,131000,26000,6000,21000,61000",
    ].join("\n");
    const p = parseProgressCsv(csv, hh, { locale: "en-GB" });
    expect(p.snapshots).toHaveLength(2);
    expect(p.snapshots[0]).toMatchObject({
      id: "progress-2026-01-31",
      householdId: hh,
      date: "2026-01-31",
      source: "import",
      netWorth: 100000,
      assets: 130000,
      liabilities: 30000,
      byCategory: { cash: 5000, taxable: 20000, "tax-deferred": 60000 },
    });
  });

  it("derives net worth from assets and liabilities, and liabilities from debt + loans", () => {
    const p = parseProgressCsv("Date,Assets,Debt,Loans\n2026-01-01,100,10,20\n", hh);
    expect(p.snapshots[0]).toMatchObject({ netWorth: 70, assets: 100, liabilities: 30 });
    expect(p.issues.some((i) => i.code === "csv.derived-networth")).toBe(true);
  });

  it("a net-worth-only file derives assets", () => {
    const p = parseProgressCsv("Date,Net Worth\n2026-01-01,500\n", hh);
    expect(p.snapshots[0]).toMatchObject({ netWorth: 500, assets: 500, liabilities: 0 });
    expect(p.analysis.preset?.id).toBe("networth-tracker");
  });

  it("skips bad rows with issues and lets a duplicate date win", () => {
    const p = parseProgressCsv(
      "Date,Net Worth\nnot a date,1\n2026-01-01,5\n2026-01-01,6\n2026-02-01,\n",
      hh,
    );
    expect(p.snapshots).toHaveLength(1);
    expect(p.snapshots[0]!.netWorth).toBe(6);
    expect(p.issues.filter((i) => i.severity === "warning")).toHaveLength(2);
    expect(p.issues.some((i) => i.code === "csv.duplicate-date")).toBe(true);
  });

  it("merges into a document by date, or replaces", () => {
    const d = createSampleDocument();
    const incoming = parseProgressCsv(
      "Date,Net Worth\n2030-01-01,1\n2030-02-01,2\n",
      d.household.id,
    ).snapshots;
    const merged = applyProgressSnapshots(d, incoming);
    expect(merged.progress.length).toBe(d.progress.length + 2);
    const again = applyProgressSnapshots(merged, [{ ...incoming[0]!, netWorth: 99 }]);
    expect(again.progress.length).toBe(merged.progress.length);
    expect(again.progress.find((s) => s.date === "2030-01-01")!.netWorth).toBe(99);
    const replaced = applyProgressSnapshots(d, incoming, { mode: "replace" });
    expect(replaced.progress).toHaveLength(2);
    expect(replaced.progress.map((s) => s.date)).toEqual(["2030-01-01", "2030-02-01"]);
  });

  it("importCsvInto dry run leaves the document alone", () => {
    const d = createSampleDocument();
    const dry = importCsvInto(d, "Date,Net Worth\n2031-01-01,1\n", { kind: "progress-snapshots" });
    expect(dry.document).toBe(d);
    expect(dry.snapshots).toHaveLength(1);
    const live = importCsvInto(
      d,
      "Date,Net Worth\n2031-01-01,1\n",
      { kind: "progress-snapshots" },
      { dryRun: false },
    );
    expect(live.document.progress.some((s) => s.date === "2031-01-01")).toBe(true);
  });
});

describe("transactions -> annual expense events", () => {
  const generic = [
    "Date,Description,Amount,Category",
    "2025-12-01,Landlord,-1000.00,Rent",
    "2025-12-03,Tesco,-82.10,Groceries",
    "2026-01-01,Landlord,-1000.00,Rent",
    "2026-01-03,Tesco,-91.90,Groceries",
    "2026-01-04,Employer,3000.00,Salary",
    "2026-01-05,Savings,-500.00,Transfer",
    "2026-01-09,Cinema,-12.00,Entertainment",
    "2026-01-10,Refund,10.00,Entertainment",
    "2026-01-11,Mystery,-5.00,",
  ].join("\n");

  it("aggregates spend by category, excluding income and transfers, netting refunds", () => {
    const s = summariseTransactions(generic, { annualise: "all" });
    expect(s.transactions).toBe(7);
    const cat = Object.fromEntries(s.categories.map((c) => [c.category, c]));
    expect(cat.Rent!.total).toBe(2000);
    expect(cat.Groceries!.total).toBeCloseTo(174);
    expect(cat.Entertainment!.total).toBe(2);
    expect(cat.Uncategorised!.total).toBe(5);
    expect(s.excluded.map((e) => e.category).sort()).toEqual(["Salary", "Transfer"]);
    expect(s.range).toEqual({ from: "2025-12-01", to: "2026-01-11" });
    expect(s.months).toBe(2);
  });

  it("a statement without a category column counts money in as income, not as negative spending", () => {
    // A plain bank statement: before the fix the salary netted the spending to £0 a year.
    const statement = [
      "Date,Description,Amount,Balance",
      "2026-10-01,Salary,3200.00,5200.00",
      "2026-10-03,Groceries,-84.20,5115.80",
      "2026-10-15,Rent,-1200.00,3915.80",
      "2026-10-31,Interest,1.25,3917.05",
    ].join("\n");
    const s = summariseTransactions(statement, { annualise: "all" });
    expect(s.categories.map((c) => [c.category, c.total])).toEqual([["Uncategorised", 1284.2]]);
    expect(s.totalAnnual).toBeCloseTo(1284.2 * 12);
    expect(s.excluded).toEqual([{ category: "Income", count: 2, total: 3201.25 }]);
  });

  it("annualises by the span of the data, or the last 12 months, or the latest full year", () => {
    const all = summariseTransactions(generic, { annualise: "all" });
    expect(all.categories.find((c) => c.category === "Rent")!.annual).toBe(12000);
    const last = summariseTransactions(generic);
    expect(last.categories.find((c) => c.category === "Rent")!.annual).toBe(12000);
    expect(last.issues.some((i) => i.code === "csv.short-range")).toBe(true);

    const full = ["Date,Amount,Category"];
    for (let m = 1; m <= 12; m++) full.push(`2025-${String(m).padStart(2, "0")}-15,-100,Rent`);
    full.push("2026-01-15,-999,Rent");
    const s = summariseTransactions(full.join("\n"), { annualise: "latest-full-year" });
    expect(s.categories[0]!.annual).toBe(1200);
    expect(s.categories[0]!.byYear).toEqual({ "2025": 1200, "2026": 999 });
    const l12 = summariseTransactions(full.join("\n"));
    expect(l12.categories[0]!.annual).toBe(1100 + 999);
  });

  it("builds expense events: real basis, yearly, planStart..planEnd, mapped types", () => {
    const s = summariseTransactions(generic, { annualise: "all" });
    const rent = s.events.find((e) => e.name === "Rent")!;
    expect(rent).toMatchObject({
      type: "housing",
      frequency: "yearly",
      amount: { value: 12000, basis: "real" },
      spendingType: "essential",
      range: { start: { kind: "planStart" }, end: { kind: "planEnd" }, endInclusive: false },
    });
    expect(s.events.find((e) => e.name === "Groceries")!.type).toBe("living");
    expect(s.events.find((e) => e.name === "Entertainment")).toMatchObject({
      type: "entertainment",
      spendingType: "discretionary",
    });
    expect(s.events.find((e) => e.name === "Uncategorised")!.type).toBe("other");
    expect(s.totalAnnual).toBeCloseTo(
      s.events.reduce((t, e) => t + e.amount!.value, 0),
      0,
    );
  });

  it("category map and exclusions override the defaults", () => {
    const s = summariseTransactions(generic, {
      annualise: "all",
      categoryMap: { rent: "living" },
      excludeCategories: ["Entertainment"],
    });
    expect(s.events.find((e) => e.name === "Rent")!.type).toBe("living");
    expect(s.events.some((e) => e.name === "Entertainment")).toBe(false);
    expect(expenseTypeForCategory("Dining out")).toBe("living");
    expect(expenseTypeForCategory("Council Tax")).toBe("housing");
    expect(expenseTypeForCategory("Holiday flights")).toBe("travel");
    expect(expenseTypeForCategory("Zzz")).toBe("other");
  });

  it("all-positive amounts are read as spending", () => {
    const s = summariseTransactions(
      "Date,Amount,Category\n2026-01-01,10,Food\n2026-02-01,20,Food\n",
      {
        annualise: "all",
      },
    );
    expect(s.categories[0]!.total).toBe(30);
    expect(s.issues.some((i) => i.code === "csv.sign")).toBe(true);
  });

  it("separate debit/credit columns (UK bank statement preset, dd/mm/yyyy)", () => {
    const csv = [
      "Transaction Date,Transaction Type,Sort Code,Account Number,Transaction Description,Debit Amount,Credit Amount,Balance",
      '31/01/2026,DEB,00-00-00,123,TESCO,"£45.50",,1000',
      '01/02/2026,DEB,00-00-00,123,SHELL,"£60.00",,940',
      '02/02/2026,CR,00-00-00,123,SALARY,,"£2,000.00",2940',
    ].join("\n");
    const s = summariseTransactions(csv, { annualise: "all" });
    expect(s.analysis.preset?.id).toBe("uk-bank-debit-credit");
    expect(s.analysis.dateFormat).toBe("DD/MM/YYYY");
    // The salary credit is income, not negative spending (it used to net the spending to nothing).
    expect(s.range).toEqual({ from: "2026-01-31", to: "2026-02-01" });
    expect(s.transactions).toBe(2);
    expect(s.categories.map((c) => [c.category, c.total])).toEqual([["Uncategorised", 105.5]]);
    expect(s.excluded).toEqual([{ category: "Income", count: 1, total: 2000 }]);
  });

  it("YNAB register export (outflow/inflow columns)", () => {
    const csv = [
      "Account,Flag,Date,Payee,Category Group/Category,Category Group,Category,Memo,Outflow,Inflow,Cleared",
      "Checking,,01/15/2026,Shop,Food: Groceries,Food,Groceries,,$50.00,$0.00,Cleared",
      "Checking,,01/20/2026,Boss,Inflow: Ready to Assign,Inflow,Ready to Assign,,$0.00,$3000.00,Cleared",
    ].join("\n");
    const s = summariseTransactions(csv, { annualise: "all" });
    expect(s.analysis.preset?.id).toBe("ynab-register");
    expect(s.analysis.dateFormat).toBe("MM/DD/YYYY");
    expect(s.categories.find((c) => c.category === "Groceries")!.total).toBe(50);
    expect(s.transactions).toBeGreaterThanOrEqual(1);
  });

  it("Monarch, Mint and Copilot sign conventions come from the preset", () => {
    const monarch =
      "Date,Merchant,Category,Account,Original Statement,Notes,Amount,Tags\n2026-01-01,Shop,Groceries,Chk,SHOP,,-25.00,\n2026-01-02,Boss,Paychecks,Chk,PAY,,1000.00,\n";
    expect(
      summariseTransactions(monarch, { annualise: "all" }).categories.map((c) => [
        c.category,
        c.total,
      ]),
    ).toEqual([["Groceries", 25]]);
    const mint =
      "Date,Description,Original Description,Amount,Transaction Type,Category,Account Name,Labels,Notes\n1/1/2026,Shop,SHOP,25.00,debit,Groceries,Chk,,\n1/2/2026,Refund,REFUND,10.00,credit,Groceries,Chk,,\n";
    const m = summariseTransactions(mint, { annualise: "all" });
    expect(m.analysis.preset?.id).toBe("mint-transactions");
    expect(m.categories[0]).toMatchObject({ category: "Groceries", total: 25 });
    const copilot =
      "date,name,amount,status,category,parent category,excluded,tags,type,account,account mask,note,recurring\n2026-01-01,Shop,25.00,posted,Groceries,Food,false,,regular,Chk,1234,,\n2026-01-02,Boss,3000.00,posted,Income,,false,,income,Chk,1234,,\n";
    const c = summariseTransactions(copilot, { annualise: "all" });
    expect(c.analysis.preset?.id).toBe("copilot-transactions");
    expect(c.categories).toHaveLength(1);
    expect(c.categories[0]).toMatchObject({ category: "Groceries", total: 25 });
  });

  it("Monzo export (en-GB dates, negative outflow, pot transfers ignored)", () => {
    const csv = [
      "Transaction ID,Date,Time,Type,Name,Emoji,Category,Amount,Currency,Local amount,Local currency,Notes and #tags,Address,Receipt,Description,Category split,Money Out,Money In",
      "tx_1,13/01/2026,10:00:00,Card payment,Tesco,,Groceries,-12.50,GBP,-12.50,GBP,,,,TESCO,,-12.50,",
      "tx_2,14/01/2026,10:00:00,Pot transfer,Holiday Pot,,Savings,-100.00,GBP,-100.00,GBP,,,,POT,,-100.00,",
    ].join("\n");
    const s = summariseTransactions(csv, { annualise: "all" });
    expect(s.analysis.preset?.id).toBe("monzo");
    expect(s.categories.map((c) => c.category)).toEqual(["Groceries"]);
    expect(s.excluded.map((e) => e.category)).toEqual(["Savings"]);
  });

  it("bad rows are skipped with row-numbered issues; missing columns block the summary", () => {
    const s = summariseTransactions(
      "Date,Amount,Category\nnope,1,X\n2026-01-01,abc,X\n2026-01-02,5,X\n",
      {
        annualise: "all",
      },
    );
    expect(s.transactions).toBe(1);
    expect(s.issues.map((i) => i.sourcePath)).toEqual(
      expect.arrayContaining(["csv:row:2", "csv:row:3"]),
    );
    const bad = summariseTransactions("foo,bar\n1,2\n");
    expect(bad.issues.some((i) => i.code === "csv.missing-columns")).toBe(true);
    expect(bad.events).toEqual([]);
  });

  it("applies events to a plan (unique ids, existing events untouched) and dry-runs by default", () => {
    const d = createSampleDocument();
    const planId = d.plans[0]!.id;
    const dry = importCsvInto(d, generic, {
      kind: "transactions",
      planId,
      options: { annualise: "all" },
    });
    expect(dry.document).toBe(d);
    const live = importCsvInto(
      d,
      generic,
      { kind: "transactions", planId, options: { annualise: "all" } },
      { dryRun: false },
    );
    const added = live.document.plans[0]!.expenses.length - d.plans[0]!.expenses.length;
    expect(added).toBe(live.summary!.events.length);
    const twice = applyExpenseSummary(live.document, planId, live.summary!);
    const ids = twice.plans[0]!.expenses.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(() => applyExpenseSummary(d, "missing", live.summary!)).toThrow();
  });
});

describe("legacy importCsv", () => {
  it("maps account balances with an accountMap and reports unmapped accounts", () => {
    const r = importCsv('Name,Balance,Date\nISA,"1,000.50",15/01/2026\nOther,5,15/01/2026\n', {
      kind: "account-balances",
      balanceColumn: "Balance",
      accountColumn: "Name",
      dateColumn: "Date",
      accountMap: { ISA: "acc-isa" },
      dateFormat: "DD/MM/YYYY",
    });
    expect(r.rows).toEqual([{ accountId: "acc-isa", date: "2026-01-15", balance: 1000.5 }]);
    expect(r.issues.some((i) => i.code === "csv.unmapped")).toBe(true);
  });

  it("honours decimal and date format overrides", () => {
    const r = importCsv("Name;Balance;Date\nA;1.234,5;03/04/2026\n", {
      kind: "account-balances",
      balanceColumn: "Balance",
      accountColumn: "Name",
      dateColumn: "Date",
      decimalSeparator: ",",
      dateFormat: "MM/DD/YYYY",
    });
    expect(r.rows[0]).toMatchObject({ balance: 1234.5, date: "2026-03-04" });
  });

  it("progress kind", () => {
    const r = importCsv("Date,NW\n2026-01-01,10\n", {
      kind: "progress-snapshots",
      dateColumn: "Date",
      balanceColumn: "NW",
    });
    expect(r.rows).toEqual([{ accountId: "net-worth", date: "2026-01-01", balance: 10 }]);
  });
});
