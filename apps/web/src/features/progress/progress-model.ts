/** Progress snapshots: build from current finances, CSV in/out, ranges, deflators. */
import {
  ACCOUNT_TYPE_INFO,
  type GlideworthDocument,
  type ProgressSnapshot,
  type ProjectionResult,
} from "@glideworth/core";
import { toCsv } from "../results/model";

export type SnapshotDraft = Omit<ProgressSnapshot, "id" | "householdId"> & { id?: string };

/** A snapshot of today's Current Finances (net worth, categories, per-entity balances). */
export function snapshotFromFinances(doc: GlideworthDocument, date: string): SnapshotDraft {
  const f = doc.finances;
  const byCategory: Record<string, number> = {};
  for (const a of f.accounts) {
    const c = ACCOUNT_TYPE_INFO[a.type].drawdown;
    byCategory[c] = (byCategory[c] ?? 0) + a.balance;
  }
  const realValue = f.realAssets.reduce((s, r) => s + r.currentValue, 0);
  if (realValue) byCategory["real-assets"] = realValue;
  const loans = f.realAssets.reduce((s, r) => s + (r.loan?.balance ?? 0), 0);
  const debt = f.debts.reduce((s, d) => s + d.balance, 0);
  if (loans) byCategory.loans = loans;
  if (debt) byCategory.debt = debt;
  const assets = f.accounts.reduce((s, a) => s + a.balance, 0) + realValue;
  const liabilities = loans + debt;
  return {
    date,
    source: "manual",
    netWorth: assets - liabilities,
    assets,
    liabilities,
    byCategory,
    accounts: f.accounts.map((a) => ({ accountId: a.id, balance: a.balance })),
    realAssets: f.realAssets.map((r) => ({
      assetId: r.id,
      value: r.currentValue,
      loanBalance: r.loan?.balance ?? 0,
    })),
    debts: f.debts.map((d) => ({ debtId: d.id, balance: d.balance })),
  };
}

export function currentMonth(): string {
  return todayIso().slice(0, 7);
}

export function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export const RANGES = [
  { id: "1m", label: "1M", months: 1 },
  { id: "3m", label: "3M", months: 3 },
  { id: "1y", label: "1Y", months: 12 },
  { id: "5y", label: "5Y", months: 60 },
  { id: "10y", label: "10Y", months: 120 },
  { id: "all", label: "All", months: null },
] as const;
export type RangeId = (typeof RANGES)[number]["id"];

export function rangeStart(id: RangeId, latest: string): string | null {
  const r = RANGES.find((x) => x.id === id);
  if (!r?.months) return null;
  const d = new Date(`${latest}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - r.months);
  return d.toISOString().slice(0, 10);
}

export function snapshotsCsv(snaps: ProgressSnapshot[], accountNames: Map<string, string>): string {
  const accIds = [...new Set(snaps.flatMap((s) => s.accounts.map((a) => a.accountId)))];
  const header = [
    "date",
    "netWorth",
    "assets",
    "liabilities",
    "source",
    "note",
    ...accIds.map((id) => `account:${accountNames.get(id) ?? id}`),
  ];
  const rows = snaps.map((s) => [
    s.date,
    s.netWorth,
    s.assets,
    s.liabilities,
    s.source,
    s.note ?? "",
    ...accIds.map((id) => s.accounts.find((a) => a.accountId === id)?.balance ?? null),
  ]);
  return toCsv(header, rows);
}

/** Minimal RFC 4180 parser (quotes, escaped quotes, CRLF). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (q) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      if (row.some((x) => x.trim() !== "")) rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim() !== "")) rows.push(row);
  return rows;
}

export interface CsvImport {
  drafts: SnapshotDraft[];
  errors: string[];
}

/**
 * Import snapshots from CSV with a header row. Recognised columns (case-insensitive): date,
 * netWorth / net worth, assets, liabilities / debts, note. Net worth is derived when missing.
 */
export function importSnapshotsCsv(text: string): CsvImport {
  const rows = parseCsv(text);
  const errors: string[] = [];
  if (rows.length < 2)
    return { drafts: [], errors: ["The file needs a header row and at least one data row."] };
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");
  const header = rows[0]!.map(norm);
  const col = (...names: string[]) => header.findIndex((h) => names.includes(h));
  const iDate = col("date", "asof");
  const iNw = col("networth");
  const iA = col("assets", "totalassets");
  const iL = col("liabilities", "debts", "debt", "totalliabilities");
  const iNote = col("note", "notes");
  if (iDate < 0) return { drafts: [], errors: ['No "date" column found.'] };
  if (iNw < 0 && (iA < 0 || iL < 0))
    return {
      drafts: [],
      errors: ['Need a "netWorth" column, or both "assets" and "liabilities".'],
    };
  const num = (s: string | undefined) => {
    if (s === undefined || s.trim() === "") return null;
    const n = Number(s.replace(/[^\d.\-eE]/g, ""));
    return Number.isFinite(n) ? n : null;
  };
  const drafts: SnapshotDraft[] = [];
  rows.slice(1).forEach((r, k) => {
    const line = k + 2;
    const raw = (r[iDate] ?? "").trim();
    const date = /^\d{4}-\d{2}-\d{2}$/.test(raw)
      ? raw
      : /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(raw)
        ? (() => {
            const [d, m, y] = raw.split("/");
            return `${y}-${m!.padStart(2, "0")}-${d!.padStart(2, "0")}`;
          })()
        : null;
    if (!date) {
      errors.push(`Line ${line}: date "${raw}" is not YYYY-MM-DD or DD/MM/YYYY.`);
      return;
    }
    const a = num(r[iA]);
    const l = num(r[iL]);
    const nw = num(r[iNw]) ?? (a !== null && l !== null ? a - l : null);
    if (nw === null) {
      errors.push(`Line ${line}: no net worth.`);
      return;
    }
    drafts.push({
      date,
      source: "import",
      netWorth: nw,
      assets: a ?? Math.max(nw, 0),
      liabilities: l ?? Math.max(0, (a ?? nw) - nw),
      byCategory: {},
      accounts: [],
      realAssets: [],
      debts: [],
      ...(iNote >= 0 && r[iNote] ? { note: r[iNote]! } : {}),
    });
  });
  return { drafts, errors };
}

/** End-of-period date for each projected year (for overlaying on a time axis). */
export function projectionPoints(
  result: ProjectionResult,
): { date: string; nominal: number; priceIndex: number }[] {
  return result.periods.map((p) => {
    const [y, m] = p.startMonth.split("-").map(Number);
    const end = new Date(Date.UTC(y!, m! - 1 + p.months, 0));
    return {
      date: end.toISOString().slice(0, 10),
      nominal: p.totals.netWorth,
      priceIndex: p.priceIndex,
    };
  });
}

/** Deflator to today's money (plan reference month) at any date, using the plan's inflation path. */
export function deflatorFor(result: ProjectionResult | undefined): (date: string) => number {
  if (!result?.periods.length) return () => 1;
  const pts = projectionPoints(result);
  const ref = result.meta.referenceMonth;
  const [ry, rm] = ref.split("-").map(Number);
  const refT = Date.UTC(ry!, rm! - 1, 1);
  const infl = result.periods[0]!.market.inflation;
  return (date: string) => {
    const t = Date.parse(`${date}T00:00:00Z`);
    if (t <= refT) return (1 + infl) ** ((t - refT) / (365.25 * 864e5));
    const next = pts.findIndex((p) => Date.parse(`${p.date}T00:00:00Z`) >= t);
    if (next < 0) return pts.at(-1)!.priceIndex;
    const prev = next === 0 ? { date: ref.concat("-01"), priceIndex: 1 } : pts[next - 1]!;
    const t0 = Date.parse(`${prev.date}T00:00:00Z`);
    const t1 = Date.parse(`${pts[next]!.date}T00:00:00Z`);
    const w = t1 > t0 ? (t - t0) / (t1 - t0) : 1;
    return prev.priceIndex + (pts[next]!.priceIndex - prev.priceIndex) * w;
  };
}
