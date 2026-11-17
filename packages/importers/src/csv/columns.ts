/** Column auto-detection (header aliases + content sniffing) and budgeting-tool presets. */
import type { CsvKind, CsvLocale } from "../types.js";
import { type DateFormat, detectDecimalSeparator, parseDate, parseNumber } from "./locale.js";
import { table } from "../util/read.js";

/** Logical fields a CSV column can play. */
export type Field =
  | "date"
  | "account"
  | "accountType"
  | "balance"
  | "amount"
  | "debit"
  | "credit"
  | "category"
  | "description"
  | "type"
  | "netWorth"
  | "assets"
  | "liabilities"
  | "cash"
  | "taxable"
  | "taxDeferred"
  | "taxFree"
  | "crypto"
  | "debt"
  | "loans";

/** Logical field -> header text as it appears in the file. */
export type ColumnMapping = Partial<Record<Field, string>>;

export const norm = (h: string): string => h.toLowerCase().replace(/[^a-z0-9]+/g, "");

const ALIASES: Record<Field, string[]> = {
  date: [
    "date",
    "transactiondate",
    "postingdate",
    "posteddate",
    "bookingdate",
    "valuedate",
    "asof",
    "asofdate",
    "day",
    "datetime",
    "timestamp",
  ],
  account: ["account", "accountname", "accounttitle", "name", "accountnickname", "holding"],
  accountType: ["accounttype", "type", "kind", "class", "subtype", "accountcategory"],
  balance: [
    "balance",
    "currentbalance",
    "closingbalance",
    "value",
    "currentvalue",
    "marketvalue",
    "amount",
    "total",
  ],
  amount: ["amount", "value", "transactionamount", "amountgbp", "amountusd", "amounteur", "sum"],
  debit: [
    "debit",
    "debitamount",
    "moneyout",
    "paidout",
    "withdrawal",
    "withdrawals",
    "outflow",
    "spent",
    "out",
  ],
  credit: [
    "credit",
    "creditamount",
    "moneyin",
    "paidin",
    "deposit",
    "deposits",
    "inflow",
    "received",
    "in",
  ],
  category: [
    "category",
    "categoryname",
    "spendingcategory",
    "budgetcategory",
    "categorygroup",
    "parentcategory",
    "label",
    "labels",
  ],
  description: [
    "description",
    "payee",
    "merchant",
    "counterparty",
    "memo",
    "narrative",
    "details",
    "reference",
    "transactiondescription",
    "originaldescription",
    "name",
    "note",
  ],
  type: ["transactiontype", "type", "drcr", "creditdebit", "debitcredit"],
  netWorth: ["networth", "netvalue", "totalnetworth", "net"],
  assets: ["assets", "totalassets"],
  liabilities: ["liabilities", "totalliabilities", "totaldebt"],
  cash: ["cash", "savings", "cashandsavings"],
  taxable: ["taxable", "investments", "brokerage", "taxableinvestments"],
  taxDeferred: ["taxdeferred", "retirement", "pension", "pensions", "taxdeferredretirement"],
  taxFree: ["taxfree", "isa", "roth"],
  crypto: ["crypto", "cryptocurrency"],
  debt: ["debt", "debts", "creditcards"],
  loans: ["loans", "mortgages", "loan"],
};

/** Fields considered per kind, in claim order (earlier fields win a contested header). */
const KIND_FIELDS: Record<CsvKind, Field[]> = {
  "account-balances": ["date", "account", "accountType", "balance"],
  "progress-snapshots": [
    "date",
    "netWorth",
    "assets",
    "liabilities",
    "cash",
    "taxable",
    "taxDeferred",
    "taxFree",
    "crypto",
    "debt",
    "loans",
  ],
  transactions: ["date", "debit", "credit", "amount", "category", "description", "account", "type"],
};

export interface DetectedColumns {
  mapping: ColumnMapping;
  /** Per-field confidence 0..1 (exact header match 1, content-only match lower). */
  confidence: Partial<Record<Field, number>>;
  unmapped: string[];
}

/** Auto-detect which header plays which field. Explicit `overrides` always win. */
export function detectColumns(
  headers: string[],
  rows: string[][],
  kind: CsvKind,
  overrides: ColumnMapping = {},
): DetectedColumns {
  const mapping: ColumnMapping = { ...overrides };
  const confidence: Partial<Record<Field, number>> = {};
  const claimed = new Set<string>();
  for (const f of Object.keys(overrides) as Field[]) {
    const h = overrides[f];
    if (h !== undefined) {
      claimed.add(norm(h));
      confidence[f] = 1;
    }
  }
  const normHeaders = headers.map(norm);

  for (const field of KIND_FIELDS[kind]) {
    if (mapping[field] !== undefined) continue;
    const aliases = ALIASES[field];
    // Exact alias match, strongest alias first.
    let found = -1;
    for (const a of aliases) {
      const i = normHeaders.findIndex(
        (h, idx) => h === a && !claimed.has(h) && headers[idx] !== "",
      );
      if (i >= 0) {
        found = i;
        break;
      }
    }
    // Prefix match for `Amount (GBP)`-style headers.
    if (
      found < 0 &&
      (field === "amount" || field === "balance" || field === "debit" || field === "credit")
    ) {
      const base = field === "balance" ? "balance" : field;
      found = normHeaders.findIndex((h) => h.startsWith(base) && !claimed.has(h));
      if (found >= 0) confidence[field] = 0.8;
    }
    if (found >= 0) {
      mapping[field] = headers[found]!;
      claimed.add(normHeaders[found]!);
      confidence[field] ??= 1;
    }
  }

  // The first non-blank cells of every column, collected in one pass over the rows: sniffing each
  // column over all rows would cost columns x rows, and both come from the file.
  let samples: string[][] | undefined;
  const columnSample = (i: number): string[] => {
    if (!samples) {
      samples = headers.map(() => []);
      let wanted = headers.length;
      for (const r of rows) {
        if (wanted === 0) break;
        const width = Math.min(r.length, headers.length);
        for (let c = 0; c < width; c++) {
          const s = samples[c]!;
          if (s.length >= SAMPLE_SIZE || r[c]!.trim() === "") continue;
          s.push(r[c]!);
          if (s.length === SAMPLE_SIZE) wanted -= 1;
        }
      }
    }
    return samples[i]!;
  };
  // Content sniffing for a date column when no header matched.
  if (KIND_FIELDS[kind].includes("date") && mapping.date === undefined) {
    const idx = headers.findIndex(
      (h, i) => !claimed.has(norm(h)) && looksLikeDates(columnSample(i)),
    );
    if (idx >= 0) {
      mapping.date = headers[idx]!;
      claimed.add(norm(headers[idx]!));
      confidence.date = 0.6;
    }
  }
  // Content sniffing for the money column.
  const moneyField: Field | undefined =
    kind === "account-balances" ? "balance" : kind === "progress-snapshots" ? "netWorth" : "amount";
  if (
    mapping[moneyField] === undefined &&
    !(kind === "transactions" && (mapping.debit || mapping.credit))
  ) {
    const idx = headers.findIndex(
      (h, i) => !claimed.has(norm(h)) && looksLikeNumbers(columnSample(i)),
    );
    if (idx >= 0) {
      mapping[moneyField] = headers[idx]!;
      claimed.add(norm(headers[idx]!));
      confidence[moneyField] = 0.5;
    }
  }
  const used = new Set(Object.values(mapping).map((h) => norm(h ?? "")));
  return { mapping, confidence, unmapped: headers.filter((h) => !used.has(norm(h))) };
}

const SAMPLE_SIZE = 30;

function sample(values: string[]): string[] {
  return values.filter((v) => v.trim() !== "").slice(0, SAMPLE_SIZE);
}

export function looksLikeDates(values: string[]): boolean {
  const s = sample(values);
  return s.length > 0 && s.filter((v) => parseDate(v) !== undefined).length / s.length >= 0.9;
}

export function looksLikeNumbers(values: string[]): boolean {
  const s = sample(values);
  if (s.length === 0) return false;
  const dec = detectDecimalSeparator(s);
  return (
    s.filter((v) => parseNumber(v, { decimalSeparator: dec }) !== undefined).length / s.length >=
    0.9
  );
}

// ---------------------------------------------------------------------------------------------
// Presets: header signatures of common budgeting-tool / bank exports.
// ---------------------------------------------------------------------------------------------

export interface CsvPreset {
  id: string;
  name: string;
  kind: CsvKind;
  /** Normalised headers that must all be present for the preset to match. */
  signature: string[];
  /** Header text -> field, using the exact headers of the tool. */
  columns: ColumnMapping;
  locale: CsvLocale;
  dateFormat?: DateFormat;
  /** Transactions: sign convention of `amount`. */
  outflow?: "negative" | "positive";
  /** Transactions: values of the `type` column that mean income / transfers (ignored as expenses). */
  nonExpenseTypes?: string[];
  /** A layout shared by many tools (not one vendor's signature): never named after a vendor. */
  generic?: boolean;
}

/** Old preset ids that still resolve (stored mappings, API callers). */
export const PRESET_ALIASES: Readonly<Record<string, string>> = table({
  "monarch-balances": "generic-balances",
  // Preset ids from before the rename to Glideworth.
  "cairn-accounts": "glideworth-accounts",
  "cairn-progress": "glideworth-progress",
});

export const PRESETS: CsvPreset[] = [
  {
    id: "ynab-register",
    name: "YNAB register export",
    kind: "transactions",
    signature: ["account", "date", "payee", "category", "outflow", "inflow"],
    columns: {
      account: "Account",
      date: "Date",
      description: "Payee",
      category: "Category",
      debit: "Outflow",
      credit: "Inflow",
    },
    locale: "en-US",
  },
  {
    id: "monarch-transactions",
    name: "Monarch Money transactions",
    kind: "transactions",
    signature: ["date", "merchant", "category", "account", "originalstatement", "amount"],
    columns: {
      date: "Date",
      description: "Merchant",
      category: "Category",
      account: "Account",
      amount: "Amount",
    },
    locale: "en-US",
    outflow: "negative",
  },
  {
    id: "mint-transactions",
    name: "Mint transactions",
    kind: "transactions",
    signature: [
      "date",
      "description",
      "originaldescription",
      "amount",
      "transactiontype",
      "category",
      "accountname",
    ],
    columns: {
      date: "Date",
      description: "Description",
      category: "Category",
      account: "Account Name",
      amount: "Amount",
      type: "Transaction Type",
    },
    locale: "en-US",
    outflow: "positive",
    nonExpenseTypes: ["credit"],
  },
  {
    id: "copilot-transactions",
    name: "Copilot Money transactions",
    kind: "transactions",
    signature: [
      "date",
      "name",
      "amount",
      "status",
      "category",
      "parentcategory",
      "excluded",
      "type",
      "account",
    ],
    columns: {
      date: "date",
      description: "name",
      category: "category",
      account: "account",
      amount: "amount",
      type: "type",
    },
    locale: "en-US",
    outflow: "positive",
    nonExpenseTypes: ["income", "internal transfer"],
  },
  {
    id: "actual-budget",
    name: "Actual Budget transactions",
    kind: "transactions",
    signature: ["account", "date", "payee", "notes", "category", "amount"],
    columns: {
      account: "Account",
      date: "Date",
      description: "Payee",
      category: "Category",
      amount: "Amount",
    },
    locale: "en-US",
    outflow: "negative",
  },
  {
    id: "monzo",
    name: "Monzo transactions",
    kind: "transactions",
    signature: ["transactionid", "date", "time", "type", "name", "category", "amount", "currency"],
    columns: {
      date: "Date",
      description: "Name",
      category: "Category",
      amount: "Amount",
      type: "Type",
    },
    locale: "en-GB",
    dateFormat: "DD/MM/YYYY",
    outflow: "negative",
    nonExpenseTypes: ["pot transfer", "faster payment received", "bacs credit"],
  },
  {
    id: "starling",
    name: "Starling Bank transactions",
    kind: "transactions",
    signature: ["date", "counterparty", "reference", "type", "spendingcategory"],
    columns: {
      date: "Date",
      description: "Counter Party",
      category: "Spending Category",
      type: "Type",
    },
    locale: "en-GB",
    dateFormat: "DD/MM/YYYY",
    outflow: "negative",
  },
  {
    id: "uk-bank-debit-credit",
    name: "UK bank statement (Debit / Credit columns)",
    kind: "transactions",
    signature: ["transactiondate", "transactiondescription", "debitamount", "creditamount"],
    columns: {
      date: "Transaction Date",
      description: "Transaction Description",
      debit: "Debit Amount",
      credit: "Credit Amount",
      type: "Transaction Type",
    },
    locale: "en-GB",
    dateFormat: "DD/MM/YYYY",
  },
  {
    // A plain Date/Account/Balance file: Monarch Money exports exactly this, but so do spreadsheets
    // and most trackers, so the preset is labelled generically ('monarch-balances' is an alias).
    id: "generic-balances",
    name: "Account balances (Date, Account, Balance)",
    kind: "account-balances",
    signature: ["date", "balance", "account"],
    columns: { date: "Date", balance: "Balance", account: "Account" },
    locale: "en-US",
    generic: true,
  },
  {
    id: "glideworth-accounts",
    name: "Glideworth account balances",
    kind: "account-balances",
    signature: ["name", "type", "balance", "date"],
    columns: { account: "name", accountType: "type", balance: "balance", date: "date" },
    locale: "en-GB",
  },
  {
    id: "glideworth-progress",
    name: "Glideworth progress export",
    kind: "progress-snapshots",
    signature: ["date", "networth", "assets", "liabilities"],
    columns: { date: "date", netWorth: "netWorth", assets: "assets", liabilities: "liabilities" },
    locale: "en-GB",
  },
  {
    id: "networth-tracker",
    name: "Generic net-worth tracker (Date, Net Worth)",
    kind: "progress-snapshots",
    signature: ["date", "networth"],
    columns: { date: "Date", netWorth: "Net Worth" },
    locale: "en-US",
  },
];

/** Presets that fit the given headers for a kind, best (most specific) first. */
export function matchPresets(headers: string[], kind: CsvKind): CsvPreset[] {
  const have = new Set(headers.map(norm));
  // Most specific first; a vendor preset beats a generic layout with the same signature length.
  return PRESETS.filter((p) => p.kind === kind && p.signature.every((s) => have.has(s))).sort(
    (a, b) => b.signature.length - a.signature.length || Number(!!a.generic) - Number(!!b.generic),
  );
}

export function presetById(id: string): CsvPreset | undefined {
  const real = PRESET_ALIASES[id] ?? id;
  return PRESETS.find((p) => p.id === real);
}
