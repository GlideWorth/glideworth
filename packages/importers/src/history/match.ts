/** Match the column headers of a balance-history file to accounts, real assets, loans and debts. */
import { HISTORY_NOTE, type HistoryTarget, type HistoryTotal } from "./targets.js";

export type MatchReason = "id" | "exact" | "alias" | "fuzzy" | "total" | "note" | "none";

export interface ColumnMatch {
  /** The column's header as it appears in the file. */
  header: string;
  /** A target key, a total (`netWorth`, `assets`, `liabilities`), `note`, or null (skip the column). */
  key: string | null;
  /** 0-1. 1 is an exact name or id; below about 0.8 the user should check it. */
  confidence: number;
  reason: MatchReason;
  /** Other plausible targets, best first (for the mapping dropdown). */
  alternatives: { key: string; confidence: number }[];
}

/** Lower case, accents and punctuation removed, `&` read as `and`, words separated by single spaces. */
export function normaliseLabel(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Words that say nothing about which account a column is. */
const NOISE = new Set([
  "balance",
  "balances",
  "bal",
  "value",
  "values",
  "amount",
  "current",
  "account",
  "acct",
  "acc",
  "the",
  "my",
  "usd",
  "gbp",
  "eur",
  "cad",
  "aud",
  "nzd",
  "chf",
  "jpy",
  "inr",
]);

function core(norm: string): string {
  const words = norm.split(" ").filter((w) => w && !NOISE.has(w));
  return words.join(" ");
}

const TOTALS: Record<string, HistoryTotal> = {
  "net worth": "netWorth",
  networth: "netWorth",
  nw: "netWorth",
  "total net worth": "netWorth",
  assets: "assets",
  "total assets": "assets",
  liabilities: "liabilities",
  "total liabilities": "liabilities",
  debts: "liabilities",
  "total debts": "liabilities",
  "total debt": "liabilities",
};
const NOTES = new Set(["note", "notes", "comment", "comments", "memo", "description"]);

function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>();
  const t = s.replace(/ /g, "");
  for (let i = 0; i < t.length - 1; i++) {
    const g = t.slice(i, i + 2);
    m.set(g, (m.get(g) ?? 0) + 1);
  }
  return m;
}

/** Sørensen-Dice similarity of character bigrams, 0-1. */
export function similarity(a: string, b: string): number {
  if (a === b) return a ? 1 : 0;
  const x = bigrams(a);
  const y = bigrams(b);
  let total = 0;
  let shared = 0;
  for (const v of x.values()) total += v;
  for (const v of y.values()) total += v;
  for (const [g, n] of x) shared += Math.min(n, y.get(g) ?? 0);
  return total ? (2 * shared) / total : 0;
}

function tokenDice(a: string, b: string): number {
  const x = new Set(a.split(" ").filter(Boolean));
  const y = new Set(b.split(" ").filter(Boolean));
  if (!x.size || !y.size) return 0;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared++;
  return (2 * shared) / (x.size + y.size);
}

/** How well a header names a target, 0-1, with the reason. */
export function scoreHeader(
  header: string,
  t: HistoryTarget,
): { score: number; reason: MatchReason } {
  const idMatch = /\[([A-Za-z0-9_-]{1,64})\]\s*$/.exec(header);
  if (idMatch) {
    if (idMatch[1] !== t.id) return { score: 0, reason: "none" };
    // `Home (loan) [house]` and `Home [house]` share an id: the label decides which one.
    const isLoanHeader = /\(loan\)|\bloan\b|\bmortgage\b/i.test(header);
    if ((t.kind === "loan") !== isLoanHeader) return { score: 0, reason: "none" };
    return { score: 1, reason: "id" };
  }
  const h = normaliseLabel(header);
  if (!h) return { score: 0, reason: "none" };
  if (h === normaliseLabel(t.label)) return { score: 1, reason: "exact" };
  const name = normaliseLabel(t.name);
  const loanWords = /\b(loan|mortgage|heloc)\b/;
  if (t.kind === "loan") {
    if (!loanWords.test(h)) return { score: 0, reason: "none" };
    const rest = h.replace(loanWords, " ").replace(/\s+/g, " ").trim();
    if (!rest) return { score: 0.7, reason: "alias" };
    if (rest === name || core(rest) === core(name)) return { score: 0.97, reason: "alias" };
    return fuzzy(core(rest), core(name), 0.9);
  }
  if (t.kind === "asset" && loanWords.test(h) && !loanWords.test(name))
    return { score: 0, reason: "none" };
  if (h === name) return { score: 0.99, reason: "exact" };
  const ch = core(h);
  const cn = core(name);
  if (ch && ch === cn) return { score: 0.95, reason: "alias" };
  if (t.id.toLowerCase() === h.replace(/ /g, "-") || normaliseLabel(t.id) === h)
    return { score: 0.95, reason: "id" };
  return fuzzy(ch || h, cn || name, 0.92);
}

function fuzzy(a: string, b: string, cap: number): { score: number; reason: MatchReason } {
  if (!a || !b) return { score: 0, reason: "none" };
  const tokens = tokenDice(a, b);
  const chars = similarity(a, b);
  // A header that contains the whole name (or the name the whole header) is a strong hint.
  const contains =
    ` ${a} `.includes(` ${b} `) || ` ${b} `.includes(` ${a} `)
      ? 0.8 + 0.1 * (Math.min(a.length, b.length) / Math.max(a.length, b.length))
      : 0;
  const score = Math.min(cap, Math.max(tokens * 0.9, chars * 0.9, contains));
  return { score: Math.round(score * 100) / 100, reason: score > 0 ? "fuzzy" : "none" };
}

/** Below this a column is left unmapped (the user can still pick a target). */
export const MATCH_THRESHOLD = 0.6;

/**
 * Match every header to at most one target, and every target to at most one header (best scores first).
 * Totals and a note column are recognised by name. Archived targets are matched only by an exact name or id.
 */
export function matchHistoryColumns(
  headers: readonly string[],
  targets: readonly HistoryTarget[],
): ColumnMatch[] {
  type Cand = { col: number; key: string; score: number; reason: MatchReason };
  const cands: Cand[] = [];
  const perCol: Cand[][] = headers.map(() => []);
  headers.forEach((header, col) => {
    for (const t of targets) {
      const { score, reason } = scoreHeader(header, t);
      if (score <= 0) continue;
      if (t.archived && score < 0.99) continue;
      const c = { col, key: t.key, score, reason };
      perCol[col]!.push(c);
      if (score >= MATCH_THRESHOLD) cands.push(c);
    }
    const n = normaliseLabel(header);
    const total = TOTALS[n];
    if (total) cands.push({ col, key: total, score: 0.98, reason: "total" });
    else if (NOTES.has(n)) cands.push({ col, key: HISTORY_NOTE, score: 0.98, reason: "note" });
  });
  cands.sort((a, b) => b.score - a.score || a.col - b.col);
  const byCol = new Map<number, Cand>();
  const used = new Set<string>();
  for (const c of cands) {
    if (byCol.has(c.col) || used.has(c.key)) continue;
    byCol.set(c.col, c);
    used.add(c.key);
  }
  return headers.map((header, col) => {
    const pick = byCol.get(col);
    const alternatives = perCol[col]!.filter((c) => c.key !== pick?.key && c.score >= 0.3)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .map((c) => ({ key: c.key, confidence: c.score }));
    return pick
      ? { header, key: pick.key, confidence: pick.score, reason: pick.reason, alternatives }
      : { header, key: null, confidence: 0, reason: "none" as const, alternatives };
  });
}
