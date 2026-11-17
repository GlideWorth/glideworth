/**
 * OFX and QIF bank files: balances (reconciled against current finances like the CSV balance
 * import) and transactions summarised into annual expense events (the CSV transaction pipeline).
 * Pure; dry run by default. Account numbers are masked to their last four digits.
 */
import type { GlideworthDocument } from "@glideworth/core";
import {
  applyExpenseSummary,
  applyReconciliation,
  type BalanceRow,
  expenseTypeLookup,
  isNonExpenseCategory,
  type Reconciliation,
  reconcileBalances,
  summariseTransactionRows,
  type TransactionOptions,
  type TransactionRow,
  type TransactionsSummary,
} from "../csv/import.js";
import type { ImportIssue } from "../types.js";
import { parseOfx } from "./ofx.js";
import { parseQif, type QifDateFormat } from "./qif.js";
import type { BankAccount, BankFileFormat, BankParse, BankTransaction } from "./types.js";
import { table } from "../util/read.js";

export * from "./ofx.js";
export * from "./qif.js";
export * from "./types.js";

/** Sniff the format: OFX has an OFX header or `<OFX>`; QIF starts with a `!Type:` / `!Account` line. */
export function detectBankFileFormat(text: string): BankFileFormat | null {
  const head = text.slice(0, 4000);
  if (/OFXHEADER:|<OFX>|<\?OFX/i.test(head)) return "ofx";
  if (/^﻿?!(Type:|Account|Option)/im.test(head)) return "qif";
  return null;
}

export interface BankFileOptions extends Pick<
  TransactionOptions,
  "annualise" | "categoryMap" | "excludeCategories"
> {
  format?: BankFileFormat | "auto";
  /** QIF only: date order (default: month-first unless the data proves day-first). */
  dateFormat?: QifDateFormat;
  /** QIF only: name for a file that has no `!Account` header. */
  accountName?: string;
  /** Category used when neither the file nor the payee names one. */
  uncategorised?: string;
}

export function parseBankFile(text: string, opts: BankFileOptions = {}): BankParse {
  const format = opts.format && opts.format !== "auto" ? opts.format : detectBankFileFormat(text);
  if (format === "ofx") return parseOfx(text);
  if (format === "qif")
    return parseQif(text, {
      ...(opts.dateFormat ? { dateFormat: opts.dateFormat } : {}),
      ...(opts.accountName ? { accountName: opts.accountName } : {}),
    });
  return {
    format: "ofx",
    accounts: [],
    transactions: [],
    issues: [
      {
        severity: "error",
        category: "invalid",
        sourcePath: "bank-file",
        message: "not an OFX or QIF file",
        code: "bank.unknown-format",
      },
    ],
  };
}

const TITLE: Record<string, string> = table({
  housing: "Housing",
  healthcare: "Healthcare",
  education: "Education",
  childcare: "Childcare",
  travel: "Travel",
  charity: "Charity",
  transportation: "Transport",
  insurance: "Insurance",
  entertainment: "Entertainment",
  personal: "Personal",
  pets: "Pets",
  "tax-payment": "Taxes",
  living: "Living costs",
});

const CARD_PAYMENT = /\b(payment|thank you|autopay|direct debit received)\b/i;

/** Classify bank transactions as spending rows (or excluded) for the shared summariser. */
export function bankSpendingRows(
  parsed: BankParse,
  opts: Pick<BankFileOptions, "excludeCategories" | "uncategorised" | "categoryMap"> = {},
): {
  rows: TransactionRow[];
  excluded: Map<string, { count: number; total: number }>;
  issues: ImportIssue[];
} {
  const issues: ImportIssue[] = [];
  const excluded = new Map<string, { count: number; total: number }>();
  const skip = (category: string, amount: number) => {
    const e = excluded.get(category) ?? { count: 0, total: 0 };
    e.count += 1;
    e.total += amount;
    excluded.set(category, e);
  };
  const excludedCats = new Set((opts.excludeCategories ?? []).map((c) => c.toLowerCase()));
  const rows: TransactionRow[] = [];
  const expenseTypeOf = expenseTypeLookup(opts.categoryMap);
  let inferred = 0;
  parsed.transactions.forEach((t: BankTransaction, i) => {
    if (t.statement === "investment") return;
    const card = t.statement === "card";
    if (t.transfer || t.type === "XFER") {
      skip("Transfers", -t.amount);
      return;
    }
    if (t.amount > 0) {
      // Money in: income on a bank account; a payment or a refund on a card.
      if (!card) {
        skip("Income", t.amount);
        return;
      }
      if (t.type === "PAYMENT" || CARD_PAYMENT.test(t.payee) || CARD_PAYMENT.test(t.memo)) {
        skip("Card payments", t.amount);
        return;
      }
    }
    let category = t.category?.trim();
    if (!category) {
      const type = expenseTypeOf(`${t.payee} ${t.memo}`);
      category = type === "other" ? (opts.uncategorised ?? "Uncategorised") : (TITLE[type] ?? type);
      inferred += 1;
    }
    if (isNonExpenseCategory(category) || excludedCats.has(category.toLowerCase())) {
      skip(category, -t.amount);
      return;
    }
    if (t.amount === 0) return;
    rows.push({ line: i + 1, date: t.date, spend: -t.amount, category, description: t.payee });
  });
  if (inferred > 0)
    issues.push({
      severity: "info",
      category: "approximated",
      sourcePath: `${parsed.format}:categories`,
      message: `${inferred} ${inferred === 1 ? "transaction had" : "transactions had"} no category; each was given one from the payee name`,
      code: "bank.inferred-category",
    });
  return { rows, excluded, issues };
}

/** Balance rows for `reconcileBalances` (accounts with a known balance only). */
export function bankBalanceRows(parsed: BankParse): BalanceRow[] {
  return parsed.accounts
    .filter((a): a is BankAccount & { balance: number } => a.balance !== undefined)
    .map((a, i) => ({
      line: i + 1,
      name: a.name,
      ...(a.type ? { type: a.type } : {}),
      entity: a.entity,
      balance: a.balance,
      ...(a.balanceDate ? { date: a.balanceDate } : {}),
    }));
}

export interface BankFileSummary {
  format: BankFileFormat;
  accounts: BankAccount[];
  balances: BalanceRow[];
  summary: TransactionsSummary;
  issues: ImportIssue[];
}

/** Parse a bank file and summarise it: balances per account and annual spending per category. */
export function summariseBankFile(text: string, opts: BankFileOptions = {}): BankFileSummary {
  const parsed = parseBankFile(text, opts);
  const spending = bankSpendingRows(parsed, opts);
  const issues = [...parsed.issues, ...spending.issues];
  const summary = summariseTransactionRows(spending.rows, spending.excluded, [...issues], opts);
  for (const e of summary.events)
    e.notes = `${parsed.format.toUpperCase()} file. ${e.notes ?? ""}`.trim();
  return {
    format: parsed.format,
    accounts: parsed.accounts,
    balances: bankBalanceRows(parsed),
    summary,
    issues: summary.issues,
  };
}

export interface BankImportRequest extends BankFileOptions {
  /** Update balances (match by name or `accountMap`, optionally create missing accounts). */
  balances?: { accountMap?: Record<string, string>; createMissing?: boolean } | false;
  /** Add the annual expense summary to this plan. */
  transactionsToPlanId?: string;
}

export interface BankImportOutcome {
  format: BankFileFormat;
  dryRun: boolean;
  accounts: BankAccount[];
  reconciliation?: Reconciliation;
  summary: TransactionsSummary;
  issues: ImportIssue[];
  document: GlideworthDocument;
}

/** Preview and (unless `dryRun`, the default) apply an OFX or QIF file to a document. */
export function importBankFileInto(
  doc: GlideworthDocument,
  text: string,
  request: BankImportRequest = {},
  opts: { dryRun?: boolean } = {},
): BankImportOutcome {
  const dryRun = opts.dryRun ?? true;
  const s = summariseBankFile(text, request);
  const issues = [...s.issues];
  const base = doc.household.currency;
  for (const a of s.accounts)
    if (a.currency && a.currency !== base)
      issues.push({
        severity: "info",
        category: "info",
        sourcePath: `${s.format}:${a.key}`,
        message: `${a.name} is in ${a.currency}; new accounts keep that currency (add an FX rate to ${base})`,
        code: "bank.foreign-currency",
      });
  const rec =
    request.balances === false
      ? undefined
      : reconcileBalances(doc, s.balances, request.balances ?? {});
  if (rec) issues.push(...rec.issues);
  const blocked = issues.some((i) => i.severity === "error");
  let next = doc;
  if (!dryRun && !blocked) {
    if (rec) {
      next = applyReconciliation(next, rec);
      // New accounts from a foreign-currency statement keep the statement's currency.
      const currencyByName = new Map(
        s.accounts.filter((a) => a.currency).map((a) => [a.name, a.currency!]),
      );
      // Looked up by id, not searched: one file can create tens of thousands of accounts.
      const byId = new Map<string, { currency?: string }>();
      for (const x of next.finances.accounts) if (!byId.has(x.id)) byId.set(x.id, x);
      const debtById = new Map<string, { currency?: string }>();
      for (const x of next.finances.debts) if (!debtById.has(x.id)) debtById.set(x.id, x);
      for (const c of rec.created) {
        const cur = currencyByName.get(c.row.name);
        if (!cur || cur === base) continue;
        const acc = byId.get(c.id);
        if (acc) acc.currency = cur;
        const debt = debtById.get(c.id);
        if (debt) debt.currency = cur;
      }
    }
    if (request.transactionsToPlanId)
      next = applyExpenseSummary(next, request.transactionsToPlanId, s.summary);
  }
  return {
    format: s.format,
    dryRun,
    accounts: s.accounts,
    ...(rec ? { reconciliation: rec } : {}),
    summary: s.summary,
    issues,
    document: next,
  };
}
