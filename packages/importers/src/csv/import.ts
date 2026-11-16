/**
 * CSV importers: account balances, progress/net-worth history, and transactions summarised into
 * annual expense events.
 *
 * Every importer is a pure function with two stages so a UI can show a preview before applying:
 *   1. parse*  -> rows + issues + analysis (nothing touches a document)
 *   2. reconcile / apply* -> a new document (the input is never mutated)
 * `importCsvInto` wraps both and honours `dryRun`.
 */
import {
  ACCOUNT_TYPES,
  type ExpenseEventInput,
  type GlideworthDocument,
  type ProgressSnapshot,
  type ProgressSnapshotInput,
} from "@glideworth/core";
import type { CsvImportResult, CsvKind, CsvMapping, ImportIssue } from "../types.js";
import { slug } from "../util/ids.js";
import type { ColumnMapping, Field } from "./columns.js";
import {
  type CsvAnalysis,
  type CsvOptions,
  missingFieldsIssue,
  prepare,
  rowIssue,
} from "./table.js";

export type { CsvAnalysis, CsvOptions } from "./table.js";

/** Analyse a CSV without importing anything: delimiter, preset, columns, formats, sample rows. */
export function analyzeCsv(text: string, kind: CsvKind, options: CsvOptions = {}): CsvAnalysis {
  return prepare(text, kind, options).analysis;
}

// ---------------------------------------------------------------------------------------------
// Account balances
// ---------------------------------------------------------------------------------------------

export interface BalanceRow {
  /** 1-based line in the file (header = line 1). */
  line: number;
  name: string;
  /** Glideworth account type when recognised. */
  type?: string;
  /** Whether the row describes an asset account or a debt. */
  entity: "account" | "debt";
  balance: number;
  /** `YYYY-MM-DD`. */
  date?: string;
}

export interface BalancesParse {
  analysis: CsvAnalysis;
  rows: BalanceRow[];
  issues: ImportIssue[];
}

const TYPE_RULES: [RegExp, string][] = [
  [/\b(lifetime isa|lisa)\b/i, "uk-lisa"],
  [/\bisa\b/i, "uk-isa"],
  [/\bsipp\b/i, "uk-sipp"],
  [/\b(pension|workplace|retirement fund)\b/i, "uk-pension"],
  [/\b401\s?\(?k\)?\b/i, "401k"],
  [/\broth\s?ira\b/i, "roth-ira"],
  [/\bira\b/i, "traditional-ira"],
  [/\bhsa\b/i, "hsa"],
  [/\b529\b/i, "529"],
  [/\btfsa\b/i, "ca-tfsa"],
  [/\brrsp\b/i, "ca-rrsp"],
  [/\b(crypto|bitcoin|ethereum|coin)\b/i, "crypto"],
  [/\b(certificate|cd)\b/i, "certificate"],
  [/\bsavings?\b/i, "savings"],
  [/\b(check(ing)?|current|cash|depository)\b/i, "cash"],
  [/\b(brokerage|investment|invest|stocks?|taxable|trading|gia|general investment)\b/i, "taxable"],
];
const DEBT_RE = /\b(credit card|loan|mortgage|debt|liabilit|overdraft|student)/i;
const TYPE_SET = new Set<string>(ACCOUNT_TYPES);

export function csvAccountType(text: string): { type?: string; entity: "account" | "debt" } {
  const t = text.trim();
  if (t === "") return { entity: "account" };
  if (DEBT_RE.test(t)) return { entity: "debt" };
  if (TYPE_SET.has(t.toLowerCase())) return { type: t.toLowerCase(), entity: "account" };
  for (const [re, type] of TYPE_RULES) if (re.test(t)) return { type, entity: "account" };
  return { entity: "account" };
}

export function parseAccountBalances(text: string, options: CsvOptions = {}): BalancesParse {
  const p = prepare(text, "account-balances", options);
  const issues = [...p.analysis.issues];
  const missing = missingFieldsIssue(p.analysis);
  if (missing) return { analysis: p.analysis, rows: [], issues: [...issues, missing] };
  const rows: BalanceRow[] = [];
  p.rows.forEach((r, i) => {
    const line = i + 2;
    const name = p.cell(r, "account");
    if (name === "") {
      issues.push(rowIssue(line, "warning", "row has no account name; skipped", "csv.no-name"));
      return;
    }
    const balance = p.num(r, "balance");
    if (balance === undefined) {
      issues.push(
        rowIssue(
          line,
          "warning",
          `balance '${p.cell(r, "balance")}' is not a number; row skipped`,
          "csv.bad-number",
        ),
      );
      return;
    }
    const dateText = p.cell(r, "date");
    let date = p.date(r, "date");
    if (dateText !== "" && !date) {
      issues.push(
        rowIssue(
          line,
          "warning",
          `date '${dateText}' is not a valid date; row date ignored`,
          "csv.bad-date",
        ),
      );
    }
    date ??= options.defaultDate;
    const t = csvAccountType(p.cell(r, "accountType"));
    if (p.cell(r, "accountType") !== "" && !t.type && t.entity === "account") {
      issues.push(
        rowIssue(
          line,
          "info",
          `account type '${p.cell(r, "accountType")}' not recognised; will be 'other' if the account is new`,
          "csv.unknown-type",
          "defaulted",
        ),
      );
    }
    rows.push({ line, name, type: t.type, entity: t.entity, balance, date });
  });
  return { analysis: p.analysis, rows, issues };
}

export interface BalanceMatch {
  row: BalanceRow;
  entity: "account" | "debt";
  id: string;
  name: string;
  before: number;
  after: number;
  delta: number;
}

export interface Reconciliation {
  matched: BalanceMatch[];
  /** Rows with no matching account (new accounts when `createMissing`). */
  created: { row: BalanceRow; id: string; entity: "account" | "debt"; type: string }[];
  unmatched: BalanceRow[];
  /** Earlier rows for an account that has a later row in the file. */
  superseded: BalanceRow[];
  /** `YYYY-MM` of the newest dated row. */
  asOf?: string;
  totals: { before: number; after: number };
  issues: ImportIssue[];
}

const normName = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** Match rows against a document's accounts/debts and show before/after, without changing it. */
export function reconcileBalances(
  doc: GlideworthDocument,
  rows: BalanceRow[],
  opts: { accountMap?: Record<string, string>; createMissing?: boolean } = {},
): Reconciliation {
  const issues: ImportIssue[] = [];
  // Keep the newest row per name.
  const latest = new Map<string, BalanceRow>();
  const superseded: BalanceRow[] = [];
  for (const r of rows) {
    const k = normName(r.name);
    const cur = latest.get(k);
    if (!cur || (r.date ?? "") >= (cur.date ?? "")) {
      if (cur) superseded.push(cur);
      latest.set(k, r);
    } else superseded.push(r);
  }
  const accounts = new Map(doc.finances.accounts.map((a) => [normName(a.name), a]));
  const debts = new Map(doc.finances.debts.map((d) => [normName(d.name), d]));
  const byId = new Map<
    string,
    { entity: "account" | "debt"; id: string; name: string; balance: number }
  >();
  for (const a of doc.finances.accounts)
    byId.set(a.id, { entity: "account", id: a.id, name: a.name, balance: a.balance });
  for (const d of doc.finances.debts)
    byId.set(d.id, { entity: "debt", id: d.id, name: d.name, balance: d.balance });

  const matched: BalanceMatch[] = [];
  const created: Reconciliation["created"] = [];
  const unmatched: BalanceRow[] = [];
  const usedIds = new Set([...byId.keys()]);
  /** Per id stem: the next numeric suffix to try, so that many colliding names do not each count up from 2. */
  const nextSuffix = new Map<string, number>();
  let asOf: string | undefined;
  for (const r of latest.values()) {
    if (r.date && (!asOf || r.date.slice(0, 7) > asOf)) asOf = r.date.slice(0, 7);
    const mappedId = opts.accountMap?.[r.name] ?? opts.accountMap?.[normName(r.name)];
    let target = mappedId ? byId.get(mappedId) : undefined;
    if (mappedId && !target)
      issues.push({
        severity: "warning",
        category: "invalid",
        sourcePath: `csv:row:${r.line}`,
        message: `account map points to unknown id '${mappedId}'`,
        code: "csv.bad-map",
      });
    if (!target) {
      const a = accounts.get(normName(r.name));
      const d = debts.get(normName(r.name));
      const hit = r.entity === "debt" ? (d ?? a) : (a ?? d);
      if (hit) target = byId.get(hit.id);
    }
    if (target) {
      const after = target.entity === "debt" ? Math.abs(r.balance) : r.balance;
      matched.push({
        row: r,
        entity: target.entity,
        id: target.id,
        name: target.name,
        before: target.balance,
        after,
        delta: after - target.balance,
      });
      continue;
    }
    if (opts.createMissing) {
      const stem = slug(r.name, r.entity);
      let id = stem;
      let n = nextSuffix.get(stem) ?? 2;
      while (usedIds.has(id)) id = `${stem.slice(0, 56)}-${n++}`;
      nextSuffix.set(stem, n);
      usedIds.add(id);
      created.push({
        row: r,
        id,
        entity: r.entity,
        type: r.entity === "debt" ? "debt" : (r.type ?? "other"),
      });
    } else {
      unmatched.push(r);
      issues.push({
        severity: "warning",
        category: "invalid",
        sourcePath: `csv:row:${r.line}`,
        message: "no matching account; map it with `accountMap` or enable `createMissing`",
        code: "csv.unmatched",
      });
    }
  }
  const before = matched.reduce((s, m) => s + (m.entity === "debt" ? -m.before : m.before), 0);
  const after =
    matched.reduce((s, m) => s + (m.entity === "debt" ? -m.after : m.after), 0) +
    created.reduce(
      (s, c) => s + (c.entity === "debt" ? -Math.abs(c.row.balance) : c.row.balance),
      0,
    );
  return { matched, created, unmatched, superseded, asOf, totals: { before, after }, issues };
}

/** Apply a reconciliation: update balances, add new accounts/debts, move `asOf` forward. */
export function applyReconciliation(
  doc: GlideworthDocument,
  rec: Reconciliation,
  opts: { updateAsOf?: boolean } = {},
): GlideworthDocument {
  const next: GlideworthDocument = structuredClone(doc);
  const newBalance = new Map(rec.matched.map((m) => [m.id, m.after]));
  for (const a of next.finances.accounts) {
    const b = newBalance.get(a.id);
    if (b !== undefined) a.balance = b;
  }
  for (const d of next.finances.debts) {
    const b = newBalance.get(d.id);
    if (b !== undefined) d.balance = Math.max(0, b);
  }
  const owner = next.household.people.find((p) => p.role === "primary")?.id ?? "me";
  for (const c of rec.created) {
    if (c.entity === "debt") {
      next.finances.debts.push({
        id: c.id,
        name: c.row.name.slice(0, 120),
        type: "debt",
        owner,
        balance: Math.abs(c.row.balance),
        interest: { apr: 0, method: "compound", compounding: "monthly" },
        monthlyPayment: { value: 0, basis: "real" },
        behaviour: {
          paymentsStart: { kind: "planStart", offsetMonths: 0 },
          payFrom: { kind: "auto" },
          interestTaxDeductible: false,
        },
        archived: false,
      });
    } else {
      next.finances.accounts.push({
        id: c.id,
        name: c.row.name.slice(0, 120),
        type: c.type as (typeof next.finances.accounts)[number]["type"],
        owner,
        balance: c.row.balance,
        behaviour: defaultBehaviour() as (typeof next.finances.accounts)[number]["behaviour"],
        archived: false,
      });
    }
  }
  if ((opts.updateAsOf ?? true) && rec.asOf && rec.asOf > next.finances.asOf)
    next.finances.asOf = rec.asOf;
  return next;
}

function defaultBehaviour(): Record<string, unknown> {
  return {
    growth: { kind: "inherit" },
    dividends: { yield: { kind: "inherit" }, treatment: "auto", reinvest: "inherit" },
    fees: { kind: "none" },
    bondAllocation: { kind: "inherit" },
    withdrawals: { kind: "always" },
    liquid: "whenWithdrawable",
    earlyWithdrawal: { enabled: false, qualifiedAge: 59.5, penaltyRate: 0.1 },
    distributions: { kind: "none" },
    sepp: { method: "none" },
    monteCarlo: "auto",
    isExcessCash: false,
  };
}

// ---------------------------------------------------------------------------------------------
// Progress / net-worth history
// ---------------------------------------------------------------------------------------------

export interface ProgressParse {
  analysis: CsvAnalysis;
  snapshots: ProgressSnapshotInput[];
  issues: ImportIssue[];
}

const CATEGORY_FIELDS: [Field, string][] = [
  ["cash", "cash"],
  ["taxable", "taxable"],
  ["taxDeferred", "tax-deferred"],
  ["taxFree", "tax-free"],
  ["crypto", "crypto"],
  ["debt", "debt"],
  ["loans", "loans"],
];

export function parseProgressCsv(
  text: string,
  householdId: string,
  options: CsvOptions = {},
): ProgressParse {
  const p = prepare(text, "progress-snapshots", options);
  const issues = [...p.analysis.issues];
  const missing = missingFieldsIssue(p.analysis);
  if (missing) return { analysis: p.analysis, snapshots: [], issues: [...issues, missing] };
  const byDate = new Map<string, ProgressSnapshotInput>();
  p.rows.forEach((r, i) => {
    const line = i + 2;
    const date = p.date(r, "date");
    if (!date) {
      issues.push(
        rowIssue(
          line,
          "warning",
          `date '${p.cell(r, "date")}' is not a valid date; row skipped`,
          "csv.bad-date",
        ),
      );
      return;
    }
    let netWorth = p.num(r, "netWorth");
    const assets = p.num(r, "assets");
    const debt = p.num(r, "debt");
    const loans = p.num(r, "loans");
    let liabilities = p.num(r, "liabilities");
    if (liabilities === undefined && (debt !== undefined || loans !== undefined))
      liabilities = (debt ?? 0) + (loans ?? 0);
    if (netWorth === undefined) {
      if (assets === undefined || liabilities === undefined) {
        issues.push(
          rowIssue(
            line,
            "warning",
            "row has no net worth (and not both assets and liabilities); skipped",
            "csv.no-networth",
          ),
        );
        return;
      }
      netWorth = assets - Math.abs(liabilities);
      issues.push(
        rowIssue(
          line,
          "info",
          "net worth derived as assets minus liabilities",
          "csv.derived-networth",
          "defaulted",
        ),
      );
    }
    const byCategory: Record<string, number> = {};
    for (const [f, cat] of CATEGORY_FIELDS) {
      const v = p.num(r, f);
      if (v !== undefined) byCategory[cat] = v;
    }
    const liab = Math.abs(liabilities ?? 0);
    if (byDate.has(date))
      issues.push(
        rowIssue(
          line,
          "info",
          `duplicate date ${date}; the later row wins`,
          "csv.duplicate-date",
          "info",
        ),
      );
    byDate.set(date, {
      id: `progress-${date}`,
      householdId,
      date,
      source: "import",
      netWorth,
      assets: assets ?? netWorth + liab,
      liabilities: liab,
      byCategory,
    });
  });
  return {
    analysis: p.analysis,
    snapshots: [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)),
    issues,
  };
}

/** Merge snapshots into a document (same-date entries are replaced). */
export function applyProgressSnapshots(
  doc: GlideworthDocument,
  snapshots: ProgressSnapshotInput[],
  opts: { mode?: "merge" | "replace" } = {},
): GlideworthDocument {
  const next: GlideworthDocument = structuredClone(doc);
  const incoming = snapshots.map((s) => ({
    accounts: [],
    realAssets: [],
    debts: [],
    byCategory: {},
    source: "import" as const,
    ...s,
  })) as ProgressSnapshot[];
  if (opts.mode === "replace") next.progress = incoming;
  else {
    const dates = new Set(incoming.map((s) => s.date));
    next.progress = [...next.progress.filter((s) => !dates.has(s.date)), ...incoming];
  }
  next.progress.sort((a, b) => a.date.localeCompare(b.date));
  return next;
}

// ---------------------------------------------------------------------------------------------
// Transactions -> annual expense events
// ---------------------------------------------------------------------------------------------

type ExpenseType = ExpenseEventInput["type"];

export interface TransactionOptions extends CsvOptions {
  /**
   * How an annual figure is derived per category:
   *  - last-12-months (default): the 12 months ending at the newest transaction
   *  - all: total / number of years spanned by the data (partial years are annualised)
   *  - latest-full-year: the last calendar year that has 12 months of data
   */
  annualise?: "last-12-months" | "all" | "latest-full-year";
  /** Category text -> Glideworth expense type. Overrides the built-in keyword rules (case-insensitive). */
  categoryMap?: Record<string, ExpenseType>;
  /** Category texts to leave out entirely (case-insensitive), in addition to transfers/income. */
  excludeCategories?: string[];
  /** Used when a row has no category. */
  uncategorised?: string;
}

export interface TransactionRow {
  line: number;
  date: string;
  /** Positive = money spent, negative = refund. */
  spend: number;
  category: string;
  description: string;
}

export interface CategorySummary {
  category: string;
  expenseType: ExpenseType;
  spendingType: "essential" | "discretionary";
  count: number;
  total: number;
  byYear: Record<string, number>;
  /** The annualised figure used for the event. */
  annual: number;
}

export interface ExpenseSummary {
  analysis: CsvAnalysis;
  /** Inclusive date range of the transactions that were counted. */
  range?: { from: string; to: string };
  months: number;
  categories: CategorySummary[];
  /** Counted as neither spending nor income (transfers, payments, income). */
  excluded: { category: string; count: number; total: number }[];
  totalAnnual: number;
  transactions: number;
  events: ExpenseEventInput[];
  issues: ImportIssue[];
}

const NON_EXPENSE_CATEGORY =
  /^(transfers?|internal transfers?|credit card payments?|payments?|income|salary|paycheck|pay|wages|interest income|dividends?|investments?|savings?|refunds? income|reimbursements?|opening balance|starting balance)\b|^(transfer|income)\s*[:/-]/i;

const TYPE_KEYWORDS: [RegExp, ExpenseType][] = [
  [
    /\b(rent|mortgage|housing|home|council tax|property|hoa|utilit|electric|gas bill|water|internet|broadband)/i,
    "housing",
  ],
  [/\b(health|medical|doctor|dentist|pharmacy|hospital|optic|prescription)/i, "healthcare"],
  [/\b(school|tuition|education|course|student|books)/i, "education"],
  [/\b(child ?care|nursery|daycare|kids|baby)/i, "childcare"],
  [/\b(travel|holiday|vacation|flight|airline|hotel|airbnb|cruise)/i, "travel"],
  [/\b(charity|donation|giving|gift aid)/i, "charity"],
  [
    /\b(transport|fuel|petrol|gas station|car|auto|taxi|uber|parking|train|bus|tfl|commut)/i,
    "transportation",
  ],
  [/\b(insurance)/i, "insurance"],
  [
    /\b(entertain|cinema|movie|music|streaming|subscription|hobb|games?|gym|sport|fitness)/i,
    "entertainment",
  ],
  [/\b(clothing|clothes|shopping|personal|beauty|hair|cosmetic)/i, "personal"],
  [/\b(pets?|vet)\b/i, "pets"],
  [/\b(tax|hmrc|irs)\b/i, "tax-payment"],
  [
    /\b(grocer|food|dining|restaurant|supermarket|cafe|coffee|takeaway|bills?|household|living|general)/i,
    "living",
  ],
];
const DISCRETIONARY = new Set<ExpenseType>([
  "travel",
  "entertainment",
  "personal",
  "charity",
  "wedding",
  "pets",
]);
const DISCRETIONARY_WORDS =
  /\b(dining|restaurant|coffee|takeaway|bars?|pubs?|shopping|hobb|gifts?)/i;

/** Category texts that are never spending (transfers, card payments, income, savings...). */
export function isNonExpenseCategory(category: string): boolean {
  return NON_EXPENSE_CATEGORY.test(category);
}

export function expenseTypeForCategory(
  category: string,
  map: Record<string, ExpenseType> = {},
): ExpenseType {
  return expenseTypeLookup(map)(category);
}

/**
 * `expenseTypeForCategory` for many categories against one `categoryMap`. The map comes from the
 * request and can be large, so it is indexed by lower-cased text once (the first of two keys that
 * differ only in case wins) and not scanned again for every transaction.
 */
export function expenseTypeLookup(
  map: Record<string, ExpenseType> = {},
): (category: string) => ExpenseType {
  const mapped = new Map<string, ExpenseType>();
  for (const [k, v] of Object.entries(map)) {
    const lower = k.toLowerCase();
    if (!mapped.has(lower)) mapped.set(lower, v);
  }
  return (category) => {
    const hit = mapped.get(category.toLowerCase());
    if (hit !== undefined) return hit;
    for (const [re, t] of TYPE_KEYWORDS) if (re.test(category)) return t;
    return "other";
  };
}

function monthIndex(date: string): number {
  return Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7)) - 1;
}

/** Aggregate bank/budget transactions into per-category annual spending. Pure; changes nothing. */
export function summariseTransactions(
  text: string,
  options: TransactionOptions = {},
): ExpenseSummary {
  const p = prepare(text, "transactions", options);
  const issues = [...p.analysis.issues];
  const empty = (extra: ImportIssue[]): ExpenseSummary => ({
    analysis: p.analysis,
    months: 0,
    categories: [],
    excluded: [],
    totalAnnual: 0,
    transactions: 0,
    events: [],
    issues: [...issues, ...extra],
  });
  const missing = missingFieldsIssue(p.analysis);
  if (missing) return empty([missing]);

  const preset = p.preset;
  const hasSplit = p.idx.debit !== undefined || p.idx.credit !== undefined;
  const nonExpenseTypes = new Set((preset?.nonExpenseTypes ?? []).map((t) => t.toLowerCase()));
  // Sign convention for a single signed `amount` column.
  let outflow: "negative" | "positive" = preset?.outflow ?? "negative";
  if (!hasSplit && !preset?.outflow) {
    let neg = 0;
    let pos = 0;
    for (const r of p.rows.slice(0, 500)) {
      const v = p.num(r, "amount");
      if (v === undefined) continue;
      if (v < 0) neg += 1;
      else if (v > 0) pos += 1;
    }
    outflow = neg === 0 && pos > 0 ? "positive" : "negative";
    if (neg === 0 && pos > 0) {
      issues.push({
        severity: "info",
        category: "defaulted",
        sourcePath: "csv:amount",
        message: "all amounts are positive; read as money spent",
        code: "csv.sign",
      });
    }
  }
  const excludedCats = new Set((options.excludeCategories ?? []).map((c) => c.toLowerCase()));
  const rows: TransactionRow[] = [];
  const excludedMap = new Map<string, { count: number; total: number }>();
  const skip = (category: string, amount: number): void => {
    const e = excludedMap.get(category) ?? { count: 0, total: 0 };
    e.count += 1;
    e.total += amount;
    excludedMap.set(category, e);
  };
  p.rows.forEach((r, i) => {
    const line = i + 2;
    const date = p.date(r, "date");
    if (!date) {
      issues.push(
        rowIssue(
          line,
          "warning",
          `date '${p.cell(r, "date")}' is not a valid date; row skipped`,
          "csv.bad-date",
        ),
      );
      return;
    }
    let spend: number | undefined;
    if (hasSplit) {
      const debit = p.num(r, "debit");
      const credit = p.num(r, "credit");
      if (debit === undefined && credit === undefined && p.idx.amount === undefined) {
        issues.push(
          rowIssue(
            line,
            "warning",
            "row has neither a debit nor a credit amount; skipped",
            "csv.no-amount",
          ),
        );
        return;
      }
      spend =
        (debit !== undefined ? Math.abs(debit) : 0) - (credit !== undefined ? Math.abs(credit) : 0);
      if (debit === undefined && credit === undefined) spend = undefined;
    }
    if (spend === undefined) {
      const amount = p.num(r, "amount");
      if (amount === undefined) {
        issues.push(
          rowIssue(
            line,
            "warning",
            `amount '${p.cell(r, "amount")}' is not a number; row skipped`,
            "csv.bad-number",
          ),
        );
        return;
      }
      spend = outflow === "negative" ? -amount : amount;
    }
    const category = p.cell(r, "category") || options.uncategorised || "Uncategorised";
    const type = p.cell(r, "type").toLowerCase();
    if (
      nonExpenseTypes.has(type) ||
      NON_EXPENSE_CATEGORY.test(category) ||
      excludedCats.has(category.toLowerCase())
    ) {
      skip(category, spend);
      return;
    }
    if (spend === 0) return;
    rows.push({ line, date, spend, category, description: p.cell(r, "description") });
  });
  return { analysis: p.analysis, ...summariseTransactionRows(rows, excludedMap, issues, options) };
}

/** Spending rows (from CSV, OFX or QIF) -> per-category annual figures and expense events. */
export type TransactionsSummary = Omit<ExpenseSummary, "analysis">;

/**
 * Aggregate parsed spending rows into per-category annual spending (shared by the CSV, OFX and QIF
 * importers). `excluded` lists categories counted as neither spending nor income.
 */
export function summariseTransactionRows(
  rows: TransactionRow[],
  excludedMap: Map<string, { count: number; total: number }>,
  issues: ImportIssue[],
  options: Pick<TransactionOptions, "annualise" | "categoryMap"> = {},
): TransactionsSummary {
  if (rows.length === 0)
    return {
      months: 0,
      categories: [],
      excluded: [...excludedMap].map(([category, v]) => ({ category, ...v })),
      totalAnnual: 0,
      transactions: 0,
      events: [],
      issues,
    };

  const dates = rows.map((r) => r.date).sort();
  const from = dates[0]!;
  const to = dates[dates.length - 1]!;
  const months = monthIndex(to) - monthIndex(from) + 1;
  const mode = options.annualise ?? "last-12-months";
  const endIdx = monthIndex(to);
  const years = new Map<string, Set<number>>();
  for (const r of rows) {
    const y = r.date.slice(0, 4);
    if (!years.has(y)) years.set(y, new Set());
    years.get(y)!.add(Number(r.date.slice(5, 7)));
  }
  const fullYears = [...years]
    .filter(([, m]) => m.size === 12)
    .map(([y]) => y)
    .sort();
  let factor = 1;
  let inWindow: (d: string) => boolean = () => true;
  if (mode === "last-12-months") {
    inWindow = (d) => monthIndex(d) > endIdx - 12;
    factor = months >= 12 ? 1 : 12 / months;
    if (months < 12)
      issues.push({
        severity: "info",
        category: "approximated",
        sourcePath: "csv:range",
        message: `data spans ${months} month(s); annual figures are scaled up from that`,
        code: "csv.short-range",
      });
  } else if (mode === "latest-full-year") {
    const y = fullYears[fullYears.length - 1];
    if (y) inWindow = (d) => d.startsWith(y);
    else {
      factor = 12 / months;
      issues.push({
        severity: "warning",
        category: "approximated",
        sourcePath: "csv:range",
        message: "no full calendar year in the data; all rows annualised instead",
        code: "csv.no-full-year",
      });
    }
  } else {
    factor = 12 / months;
  }

  const expenseTypeOf = expenseTypeLookup(options.categoryMap);
  const byCat = new Map<string, CategorySummary>();
  for (const r of rows) {
    let c = byCat.get(r.category);
    if (!c) {
      const expenseType = expenseTypeOf(r.category);
      c = {
        category: r.category,
        expenseType,
        spendingType:
          DISCRETIONARY.has(expenseType) || DISCRETIONARY_WORDS.test(r.category)
            ? "discretionary"
            : "essential",
        count: 0,
        total: 0,
        byYear: {},
        annual: 0,
      };
      byCat.set(r.category, c);
    }
    c.count += 1;
    c.total += r.spend;
    const y = r.date.slice(0, 4);
    c.byYear[y] = (c.byYear[y] ?? 0) + r.spend;
    if (inWindow(r.date)) c.annual += r.spend * factor;
  }
  const categories = [...byCat.values()]
    .filter((c) => c.annual > 0 || c.total > 0)
    .sort((a, b) => b.annual - a.annual);
  const owner = "me";
  const events: ExpenseEventInput[] = categories
    .filter((c) => c.annual > 0)
    .map((c) => ({
      id: `import-${slug(c.category, "expense")}`,
      name: c.category.slice(0, 120),
      type: c.expenseType,
      owner,
      amount: { value: Math.round(c.annual * 100) / 100, basis: "real" as const },
      frequency: "yearly" as const,
      range: {
        start: { kind: "planStart" as const, offsetMonths: 0 },
        end: { kind: "planEnd" as const, offsetMonths: 0 },
        endInclusive: false,
      },
      spendingType: c.spendingType,
      notes: `Imported from ${c.count} transactions (${from} to ${to}).`,
    })) as ExpenseEventInput[];
  return {
    range: { from, to },
    months,
    categories,
    excluded: [...excludedMap]
      .map(([category, v]) => ({ category, ...v }))
      .sort((a, b) => b.count - a.count),
    totalAnnual: categories.reduce((s, c) => s + Math.max(0, c.annual), 0),
    transactions: rows.length,
    events,
    issues,
  };
}

/** Add the summary's events to a plan (ids are made unique; existing events are untouched). */
export function applyExpenseSummary(
  doc: GlideworthDocument,
  planId: string,
  summary: Pick<ExpenseSummary, "events">,
  opts: { owner?: string } = {},
): GlideworthDocument {
  const next: GlideworthDocument = structuredClone(doc);
  const plan = next.plans.find((p) => p.id === planId);
  if (!plan) throw new Error(`plan '${planId}' not found`);
  const owner = opts.owner ?? next.household.people.find((p) => p.role === "primary")?.id ?? "me";
  const used = new Set([...plan.income.map((e) => e.id), ...plan.expenses.map((e) => e.id)]);
  /** Per event id: the next numeric suffix to try (see `reconcileBalances`). */
  const nextSuffix = new Map<string, number>();
  for (const e of summary.events) {
    let id = e.id;
    let n = nextSuffix.get(e.id) ?? 2;
    while (used.has(id)) id = `${e.id.slice(0, 60)}-${n++}`;
    nextSuffix.set(e.id, n);
    used.add(id);
    plan.expenses.push({ ...e, id, owner } as (typeof plan.expenses)[number]);
  }
  return next;
}

// ---------------------------------------------------------------------------------------------
// One entry point with dry-run, and the original `importCsv` contract
// ---------------------------------------------------------------------------------------------

export type CsvImportRequest =
  | {
      kind: "account-balances";
      options?: CsvOptions & { accountMap?: Record<string, string>; createMissing?: boolean };
    }
  | { kind: "progress-snapshots"; options?: CsvOptions & { mode?: "merge" | "replace" } }
  | { kind: "transactions"; planId: string; options?: TransactionOptions };

export interface CsvImportOutcome {
  kind: CsvKind;
  dryRun: boolean;
  analysis: CsvAnalysis;
  issues: ImportIssue[];
  /** Kind-specific preview. */
  reconciliation?: Reconciliation;
  snapshots?: ProgressSnapshotInput[];
  summary?: ExpenseSummary;
  /** The resulting document: unchanged when `dryRun`. */
  document: GlideworthDocument;
}

/** Parse, preview and (unless `dryRun`, the default) apply a CSV to a document. */
export function importCsvInto(
  doc: GlideworthDocument,
  text: string,
  request: CsvImportRequest,
  opts: { dryRun?: boolean } = {},
): CsvImportOutcome {
  const dryRun = opts.dryRun ?? true;
  if (request.kind === "account-balances") {
    const o = request.options ?? {};
    const parsed = parseAccountBalances(text, o);
    const rec = reconcileBalances(doc, parsed.rows, {
      accountMap: o.accountMap,
      createMissing: o.createMissing,
    });
    const blocked = parsed.issues.some((i) => i.severity === "error");
    return {
      kind: request.kind,
      dryRun,
      analysis: parsed.analysis,
      issues: [...parsed.issues, ...rec.issues],
      reconciliation: rec,
      document: dryRun || blocked ? doc : applyReconciliation(doc, rec),
    };
  }
  if (request.kind === "progress-snapshots") {
    const o = request.options ?? {};
    const parsed = parseProgressCsv(text, doc.household.id, o);
    const blocked = parsed.issues.some((i) => i.severity === "error");
    return {
      kind: request.kind,
      dryRun,
      analysis: parsed.analysis,
      issues: parsed.issues,
      snapshots: parsed.snapshots,
      document:
        dryRun || blocked ? doc : applyProgressSnapshots(doc, parsed.snapshots, { mode: o.mode }),
    };
  }
  const summary = summariseTransactions(text, request.options);
  const blocked = summary.issues.some((i) => i.severity === "error");
  return {
    kind: request.kind,
    dryRun,
    analysis: summary.analysis,
    issues: summary.issues,
    summary,
    document: dryRun || blocked ? doc : applyExpenseSummary(doc, request.planId, summary),
  };
}

const DATE_FORMAT_TO_LOCALE = {
  "YYYY-MM-DD": undefined,
  "DD/MM/YYYY": "en-GB",
  "MM/DD/YYYY": "en-US",
} as const;

function mappingToColumns(m: CsvMapping): ColumnMapping {
  const cols: ColumnMapping = {};
  if (m.dateColumn) cols.date = m.dateColumn;
  if (m.accountColumn) cols.account = m.accountColumn;
  if (m.typeColumn) cols.accountType = m.typeColumn;
  if (m.balanceColumn)
    cols[m.kind === "progress-snapshots" ? "netWorth" : "balance"] = m.balanceColumn;
  return cols;
}

/**
 * Original entry point: parse a CSV with an explicit column mapping into
 * `{accountId, date, balance}` rows. Unmapped accounts become issues. New code should prefer
 * `parseAccountBalances` / `parseProgressCsv` / `importCsvInto`.
 */
export function importCsv(text: string, mapping: CsvMapping): CsvImportResult {
  const options: CsvOptions = {
    columns: mappingToColumns(mapping),
    decimalSeparator: mapping.decimalSeparator,
    dateFormat: mapping.dateFormat,
    locale: mapping.dateFormat ? (DATE_FORMAT_TO_LOCALE[mapping.dateFormat] ?? "auto") : "auto",
    preset: "none",
  };
  if (mapping.kind === "progress-snapshots") {
    const parsed = parseProgressCsv(text, "household", options);
    return {
      rows: parsed.snapshots.map((s) => ({
        accountId: "net-worth",
        date: s.date,
        balance: s.netWorth,
      })),
      issues: parsed.issues,
    };
  }
  if (mapping.kind === "transactions") {
    return {
      rows: [],
      issues: [
        {
          severity: "error",
          category: "invalid",
          sourcePath: "csv",
          message: "use summariseTransactions for transactions",
          code: "csv.use-summarise",
        },
      ],
    };
  }
  const parsed = parseAccountBalances(text, options);
  const issues = [...parsed.issues];
  const rows: CsvImportResult["rows"] = [];
  for (const r of parsed.rows) {
    const id = mapping.accountMap ? mapping.accountMap[r.name] : slug(r.name, "account");
    if (!id) {
      issues.push(
        rowIssue(
          r.line,
          "warning",
          `account '${r.name}' is not in accountMap; row skipped`,
          "csv.unmapped",
        ),
      );
      continue;
    }
    rows.push({ accountId: id, date: r.date ?? "", balance: r.balance });
  }
  return { rows, issues };
}
