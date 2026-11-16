/**
 * QIF (Quicken Interchange Format). Reads `!Type:Bank|CCard|Cash|Oth A|Oth L` sections and
 * `!Account` headers (name, type, balance). Each record is a set of lines ending with `^`:
 * `D` date, `T`/`U` amount, `P` payee, `M` memo, `L` category (`[Account]` = transfer).
 * Dates are month-first (US Quicken) unless the file proves day-first or `dateFormat` says so;
 * the two-digit year forms `1/5'26` and `01/05/26` are accepted.
 */
import type { ImportIssue } from "../types.js";
import type { BankAccount, BankParse, BankTransaction } from "./types.js";

export type QifDateFormat = "auto" | "MM/DD/YYYY" | "DD/MM/YYYY";

interface RawDate {
  a: number;
  b: number;
  y: number;
}

function splitDate(s: string): RawDate | undefined {
  const t = s.trim().replace(/\s+/g, "");
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
  if (iso) return { a: Number(iso[2]), b: Number(iso[3]), y: Number(iso[1]) };
  const m = /^(\d{1,2})[/.-](\d{1,2})(?:[/.-]|')(\d{2}|\d{4})$/.exec(t);
  if (!m) return undefined;
  let y = Number(m[3]);
  if (m[3]!.length === 2) y += y < 70 ? 2000 : 1900;
  return { a: Number(m[1]), b: Number(m[2]), y };
}

const pad = (n: number) => String(n).padStart(2, "0");

function toIso(d: RawDate, dayFirst: boolean): string | undefined {
  const month = dayFirst ? d.b : d.a;
  const day = dayFirst ? d.a : d.b;
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  return `${d.y}-${pad(month)}-${pad(day)}`;
}

const amount = (s: string): number | undefined => {
  const t = s
    .trim()
    .replace(/,(?=\d{3}\b)/g, "")
    .replace(/,/g, ".");
  const v = Number(t);
  return t !== "" && Number.isFinite(v) ? v : undefined;
};

const SECTION: Record<
  string,
  { statement: BankTransaction["statement"]; entity: "account" | "debt"; type?: string }
> = {
  bank: { statement: "bank", entity: "account", type: "cash" },
  cash: { statement: "cash", entity: "account", type: "cash" },
  ccard: { statement: "card", entity: "debt" },
  "oth a": { statement: "bank", entity: "account", type: "other" },
  "oth l": { statement: "card", entity: "debt" },
  invst: { statement: "investment", entity: "account", type: "taxable" },
};

export function parseQif(
  text: string,
  opts: { dateFormat?: QifDateFormat; accountName?: string } = {},
): BankParse {
  const issues: ImportIssue[] = [];
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  const accounts: BankAccount[] = [];
  type Rec = {
    fields: Map<string, string>;
    line: number;
    account: BankAccount;
    section: (typeof SECTION)[string];
  };
  const records: Rec[] = [];
  let section: (typeof SECTION)[string] | null = null;
  let current: BankAccount | null = null;
  let inAccountHeader = false;
  let header = new Map<string, string>();
  let fields = new Map<string, string>();
  let recordLine = 0;
  // The file is untrusted and this runs on the API's request thread: accounts are looked up by
  // name in a map, because a file can declare hundreds of thousands of them.
  const byName = new Map<string, BankAccount>();
  const account = (name: string, sec: (typeof SECTION)[string], balance?: number): BankAccount => {
    const existing = byName.get(name);
    if (existing) return existing;
    const a: BankAccount = {
      key: `qif:${accounts.length}`,
      name,
      entity: sec.entity,
      ...(sec.type ? { type: sec.type } : {}),
      ...(balance !== undefined
        ? { balance: sec.entity === "debt" ? Math.abs(balance) : balance }
        : {}),
    };
    accounts.push(a);
    byName.set(name, a);
    return a;
  };
  lines.forEach((raw, i) => {
    const line = raw.trimEnd();
    if (line === "") return;
    if (line.startsWith("!")) {
      const h = line.slice(1).toLowerCase();
      if (h === "account") {
        inAccountHeader = true;
        header = new Map();
        return;
      }
      if (h.startsWith("type:")) {
        const kind = h.slice(5).trim();
        section = SECTION[kind] ?? null;
        if (!section) {
          issues.push({
            severity: "info",
            category: "unsupported",
            sourcePath: `qif:line:${i + 1}`,
            message: `QIF section '${line.slice(6)}' is not imported`,
            code: "qif.section",
          });
          return;
        }
        if (!current || current.entity !== section.entity)
          current = account(
            opts.accountName ?? (section.entity === "debt" ? "Credit card" : "Bank account"),
            section,
          );
      }
      return;
    }
    const code = line[0]!;
    const value = line.slice(1).trim();
    if (inAccountHeader) {
      if (code === "^") {
        inAccountHeader = false;
        const t = (header.get("T") ?? "bank").toLowerCase();
        const sec = SECTION[t] ?? SECTION.bank!;
        const bal = header.has("$")
          ? amount(header.get("$")!)
          : header.has("B")
            ? amount(header.get("B")!)
            : undefined;
        current = account(header.get("N") || `Account ${accounts.length + 1}`, sec, bal);
      } else header.set(code, value);
      return;
    }
    if (!section) return;
    if (code === "^") {
      if (fields.size > 0 && current)
        records.push({ fields, line: recordLine, account: current, section });
      fields = new Map();
      return;
    }
    if (fields.size === 0) recordLine = i + 1;
    // Split lines (S/E/$) repeat; keep the first category, sum nothing else.
    if (!fields.has(code)) fields.set(code, value);
  });
  // Date convention: day-first when any date's first part exceeds 12, or when asked.
  const raws = records.map((r) => splitDate(r.fields.get("D") ?? ""));
  const dayFirst =
    opts.dateFormat === "DD/MM/YYYY" ||
    (opts.dateFormat !== "MM/DD/YYYY" && raws.some((d) => d && d.a > 12));
  const ambiguous = opts.dateFormat === undefined || opts.dateFormat === "auto";
  if (ambiguous && !dayFirst && raws.some((d) => d && d.a <= 12 && d.b <= 12))
    issues.push({
      severity: "info",
      category: "defaulted",
      sourcePath: "qif:dates",
      message:
        "dates read month-first (US Quicken); pass dateFormat DD/MM/YYYY for day-first files",
      code: "qif.date-order",
    });
  const transactions: BankTransaction[] = [];
  /** Signed opening balance per account key (from an "Opening Balance" record). */
  const openings = new Map<string, number>();
  /** Per account key: the sum of its transactions and the date of the newest one, in one pass. */
  const ledgers = new Map<string, { sum: number; last: string }>();
  records.forEach((r, k) => {
    const d = raws[k];
    const date = d ? toIso(d, dayFirst) : undefined;
    const amt = amount(r.fields.get("T") ?? r.fields.get("U") ?? "");
    if (!date || amt === undefined) {
      issues.push({
        severity: "warning",
        category: "invalid",
        sourcePath: `qif:line:${r.line}`,
        message: "record without a valid date or amount; skipped",
        code: "qif.bad-record",
      });
      return;
    }
    const L = r.fields.get("L") ?? "";
    const transfer = /^\[.*\]$/.test(L);
    const payee = r.fields.get("P") ?? "";
    // An opening-balance record sets the starting balance; it is not a transaction.
    if (/^opening balance$/i.test(payee)) {
      openings.set(r.account.key, (openings.get(r.account.key) ?? 0) + amt);
      return;
    }
    const ledger = ledgers.get(r.account.key);
    if (!ledger) ledgers.set(r.account.key, { sum: 0 + amt, last: date });
    else {
      ledger.sum += amt;
      if (date > ledger.last) ledger.last = date;
    }
    transactions.push({
      accountKey: r.account.key,
      date,
      amount: amt,
      type: r.section.statement.toUpperCase(),
      payee,
      memo: r.fields.get("M") ?? "",
      ...(L && !transfer ? { category: L } : {}),
      ...(transfer ? { transfer: true } : {}),
      statement: r.section.statement,
    });
  });
  // With an opening balance the ledger is complete: closing = opening + every transaction (signed).
  // A balance from an `!Account` header is already the current balance and is kept as it is.
  for (const a of accounts) {
    const opening = openings.get(a.key);
    const ledger = ledgers.get(a.key);
    const last = ledger?.last;
    if (opening !== undefined) {
      const signed = opening + (ledger?.sum ?? 0);
      a.balance = a.entity === "debt" ? Math.max(0, -signed) : signed;
    }
    if (a.balance !== undefined && last && !a.balanceDate) a.balanceDate = last;
  }
  return { format: "qif", accounts, transactions, issues };
}
