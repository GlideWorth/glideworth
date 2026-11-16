import type { ImportIssue } from "../types.js";

export type BankFileFormat = "ofx" | "qif";

/** An account found in a bank file. Account numbers are masked to their last four digits. */
export interface BankAccount {
  /** Stable key within the file (links transactions to their account). */
  key: string;
  name: string;
  /** Glideworth account type when the file says (checking -> cash, savings, investment -> taxable). */
  type?: string;
  entity: "account" | "debt";
  currency?: string;
  /** Closing / ledger balance (debts as a positive amount owed). */
  balance?: number;
  /** `YYYY-MM-DD` the balance is valid for. */
  balanceDate?: string;
}

/** A transaction as recorded in the file: `amount` is signed (negative = money out). */
export interface BankTransaction {
  accountKey: string;
  date: string;
  amount: number;
  /** OFX TRNTYPE (DEBIT, CREDIT, XFER, PAYMENT...) or QIF account type; upper case. */
  type: string;
  payee: string;
  memo: string;
  /** Category from the file (QIF `L`, non-standard OFX `CATEGORY`). */
  category?: string;
  /** QIF `[Account]` categories: a transfer to another account. */
  transfer?: boolean;
  statement: "bank" | "card" | "investment" | "cash";
}

export interface BankParse {
  format: BankFileFormat;
  accounts: BankAccount[];
  transactions: BankTransaction[];
  issues: ImportIssue[];
}
