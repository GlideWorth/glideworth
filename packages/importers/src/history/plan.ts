/**
 * Plan a balance-history import against the snapshots a household already has. Pure: the same plan is worked
 * out in the browser (preview, offline workspaces) and by the API (dry run and apply).
 *
 * Rules (docs/progress-history-import.md):
 *  - Values land on the snapshot(s) for their date. A date with no snapshot gets a new one (`source: import`).
 *    Every snapshot already on that date that records the field is updated, so one date never shows two values.
 *  - Merge adds and updates values and leaves everything else alone. A blank cell changes nothing.
 *  - Replace also clears, for each mapped field, the saved values the file does not have between its first and
 *    last date: blank cells and dates missing from the file. Cells left out of the rows (errors the user chose
 *    to skip) are not cleared.
 *  - Totals move with the values: a change of N to an account moves assets and net worth by N (in the base
 *    currency), so totals that were the sum of the accounts stay the sum, and hand-entered totals keep whatever
 *    the per-account values did not cover. Totals given in the file win for their date.
 *  - A snapshot left with no values and zero totals is deleted.
 *  - An `auto` snapshot that the import changes becomes `import` (the daily automatic snapshot would otherwise
 *    overwrite it from current balances).
 *  - `updateCurrent`: values dated `today` also become the current balances. Off by default.
 */
import type { ProgressSnapshot } from "@glideworth/core";
import type { HistoryIssue, HistoryRow } from "./preview.js";
import {
  HISTORY_NOTE,
  type HistoryTarget,
  type HistoryTotal,
  historyKey,
  parseHistoryKey,
} from "./targets.js";

export type HistoryMode = "merge" | "replace";
export type SnapshotDraft = Omit<ProgressSnapshot, "id" | "householdId" | "createdAt">;

export interface PlanInput {
  existing: readonly ProgressSnapshot[];
  rows: readonly HistoryRow[];
  mode: HistoryMode;
  targets: readonly HistoryTarget[];
  /** `YYYY-MM-DD`. */
  today: string;
  updateCurrent?: boolean;
}

export interface HistoryChange {
  date: string;
  key: string;
  before: number | null;
  after: number | null;
  kind: "added" | "updated" | "removed";
}

export interface CurrentBalanceUpdate {
  accounts: { accountId: string; balance: number }[];
  realAssets: { assetId: string; currentValue?: number; loanBalance?: number }[];
  debts: { debtId: string; balance: number }[];
}

export interface HistoryPlan {
  create: SnapshotDraft[];
  /** Whole snapshots to store in place of the ones with the same id. */
  update: ProgressSnapshot[];
  /** Ids of snapshots to delete. */
  remove: string[];
  changes: HistoryChange[];
  counts: {
    added: number;
    updated: number;
    removed: number;
    unchanged: number;
    snapshotsCreated: number;
    snapshotsUpdated: number;
    snapshotsRemoved: number;
  };
  /** First and last date of the file. */
  range: { from: string; to: string } | null;
  /** New current balances (only with `updateCurrent` and a row dated today). */
  current: CurrentBalanceUpdate | null;
  /** Errors here mean the plan must not be applied. */
  issues: HistoryIssue[];
}

const EPS = 0.005;
const round = (n: number) => Math.round(n * 100) / 100;
const same = (a: number, b: number) => Math.abs(a - b) < EPS;

/** Values recorded in a snapshot, by key. */
export function snapshotValues(
  s: Pick<ProgressSnapshot, "accounts" | "realAssets" | "debts">,
): Map<string, number> {
  const m = new Map<string, number>();
  for (const a of s.accounts) m.set(historyKey("account", a.accountId), a.balance);
  for (const r of s.realAssets) {
    m.set(historyKey("asset", r.assetId), r.value);
    if (r.loanBalance) m.set(historyKey("loan", r.assetId), r.loanBalance);
  }
  for (const d of s.debts) m.set(historyKey("debt", d.debtId), d.balance);
  return m;
}

/** Order of preference for the snapshot that receives new values on a date: the user's own first, then newest. */
function primaryOf(list: readonly Working[]): Working {
  return [...list].sort((a, b) => {
    const ua = a.snap.source === "auto" ? 1 : 0;
    const ub = b.snap.source === "auto" ? 1 : 0;
    if (ua !== ub) return ua - ub;
    const ca = "createdAt" in a.snap ? (a.snap.createdAt ?? "") : "";
    const cb = "createdAt" in b.snap ? (b.snap.createdAt ?? "") : "";
    return cb.localeCompare(ca);
  })[0]!;
}

interface Working {
  snap: ProgressSnapshot | SnapshotDraft;
  isNew: boolean;
  touched: boolean;
  original?: string;
  totalsGiven: Partial<Record<HistoryTotal, number>>;
  /** Something in it was cleared (only then may an emptied snapshot be deleted). */
  cleared?: boolean;
}

function validateRows(input: PlanInput, issues: HistoryIssue[]): Map<string, HistoryRow> {
  const byKey = new Map(input.targets.map((t) => [t.key, t]));
  const rows = new Map<string, HistoryRow>();
  for (const r of input.rows) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date) || Number.isNaN(Date.parse(`${r.date}T00:00:00Z`))) {
      issues.push({
        severity: "error",
        code: "history.date.invalid",
        message: "not a YYYY-MM-DD date",
        date: r.date,
      });
      continue;
    }
    if (r.date > input.today) {
      issues.push({
        severity: "error",
        code: "history.date.future",
        message: "is in the future",
        date: r.date,
      });
      continue;
    }
    let row = rows.get(r.date);
    if (!row) {
      row = { date: r.date, values: {} };
      rows.set(r.date, row);
    }
    if (r.note) row.note = row.note ? `${row.note}; ${r.note}`.slice(0, 500) : r.note.slice(0, 500);
    for (const [k, v] of Object.entries(r.values)) {
      const p = parseHistoryKey(k);
      if (!p || p.type === "note" || (p.type === "entity" && !byKey.has(k))) {
        issues.push({
          severity: "error",
          code: "history.key.unknown",
          message: "unknown account, asset or debt",
          date: r.date,
          key: k,
        });
        continue;
      }
      if (v !== null && (typeof v !== "number" || !Number.isFinite(v))) {
        issues.push({
          severity: "error",
          code: "history.value.invalid",
          message: "not a number",
          date: r.date,
          key: k,
        });
        continue;
      }
      const t = byKey.get(k);
      if (
        v !== null &&
        v < 0 &&
        (t?.side === "liability" || t?.kind === "asset" || k === "assets" || k === "liabilities")
      ) {
        issues.push({
          severity: "error",
          code: "history.value.negative",
          message:
            t?.side === "liability"
              ? "debts and loans are amounts owed: give a positive number"
              : "cannot be negative",
          date: r.date,
          key: k,
        });
        continue;
      }
      const prev = row.values[k];
      if (prev !== undefined && prev !== null && v !== null && !same(prev, v)) {
        issues.push({
          severity: "error",
          code: "history.value.conflict",
          message: "two different values for the same date",
          date: r.date,
          key: k,
        });
        continue;
      }
      if (prev === undefined || prev === null) row.values[k] = v;
    }
  }
  return rows;
}

export function planHistoryImport(input: PlanInput): HistoryPlan {
  const issues: HistoryIssue[] = [];
  const rows = validateRows(input, issues);
  const byKey = new Map(input.targets.map((t) => [t.key, t]));
  const dates = [...rows.keys()].sort();
  const range = dates.length ? { from: dates[0]!, to: dates.at(-1)! } : null;
  const empty: HistoryPlan = {
    create: [],
    update: [],
    remove: [],
    changes: [],
    counts: {
      added: 0,
      updated: 0,
      removed: 0,
      unchanged: 0,
      snapshotsCreated: 0,
      snapshotsUpdated: 0,
      snapshotsRemoved: 0,
    },
    range,
    current: null,
    issues,
  };
  if (issues.some((i) => i.severity === "error") || !range) return empty;

  // Mapped fields: every key that appears in any row (a blank cell counts).
  const mapped = new Set<string>();
  for (const r of rows.values()) for (const k of Object.keys(r.values)) mapped.add(k);

  // Working copies, grouped by date.
  const byDate = new Map<string, Working[]>();
  const all: Working[] = [];
  for (const s of input.existing) {
    const w: Working = {
      snap: s,
      isNew: false,
      touched: false,
      original: JSON.stringify(s),
      totalsGiven: {},
    };
    all.push(w);
    const list = byDate.get(s.date) ?? [];
    list.push(w);
    byDate.set(s.date, list);
  }
  const ensureMutable = (w: Working) => {
    if (!w.touched) {
      w.snap = structuredClone(w.snap);
      w.touched = true;
    }
    return w.snap;
  };

  const changes: HistoryChange[] = [];
  let unchanged = 0;

  /** Set (or with null, clear) a value on a working snapshot and move its totals. */
  const write = (w: Working, key: string, value: number | null) => {
    const t = byKey.get(key);
    const p = parseHistoryKey(key);
    if (!t || !p || p.type !== "entity") return;
    const s = ensureMutable(w);
    const before = snapshotValues(s).get(key) ?? null;
    const delta = (value ?? 0) - (before ?? 0);
    if (value === null) w.cleared = true;
    switch (p.kind) {
      case "account": {
        const i = s.accounts.findIndex((a) => a.accountId === p.id);
        if (value === null) {
          if (i >= 0) s.accounts.splice(i, 1);
        } else if (i >= 0) s.accounts[i] = { accountId: p.id, balance: value };
        else s.accounts.push({ accountId: p.id, balance: value });
        break;
      }
      case "debt": {
        const i = s.debts.findIndex((d) => d.debtId === p.id);
        if (value === null) {
          if (i >= 0) s.debts.splice(i, 1);
        } else if (i >= 0) s.debts[i] = { debtId: p.id, balance: value };
        else s.debts.push({ debtId: p.id, balance: value });
        break;
      }
      case "asset":
      case "loan": {
        const i = s.realAssets.findIndex((r) => r.assetId === p.id);
        const next = {
          ...(i >= 0 ? s.realAssets[i]! : { assetId: p.id, value: 0, loanBalance: 0 }),
        };
        if (p.kind === "asset") next.value = value ?? 0;
        else next.loanBalance = value ?? 0;
        // Clearing one half of an entry whose other half is empty removes the entry.
        const drop = value === null && (p.kind === "asset" ? !next.loanBalance : !next.value);
        if (drop) {
          if (i >= 0) s.realAssets.splice(i, 1);
        } else if (i >= 0) s.realAssets[i] = next;
        else s.realAssets.push(next);
        break;
      }
    }
    const base = delta * t.rate;
    if (t.side === "asset") {
      s.assets = round(s.assets + base);
      s.netWorth = round(s.netWorth + base);
    } else {
      s.liabilities = round(s.liabilities + base);
      s.netWorth = round(s.netWorth - base);
    }
    const cat = t.category as keyof ProgressSnapshot["byCategory"];
    const nextCat = round((s.byCategory[cat] ?? 0) + base);
    if (Math.abs(nextCat) < EPS) delete s.byCategory[cat];
    else s.byCategory[cat] = nextCat;
  };

  const newSnapshot = (date: string): Working => {
    const w: Working = {
      snap: {
        date,
        source: "import",
        netWorth: 0,
        assets: 0,
        liabilities: 0,
        byCategory: {},
        accounts: [],
        realAssets: [],
        debts: [],
      },
      isNew: true,
      touched: true,
      totalsGiven: {},
    };
    all.push(w);
    byDate.set(date, [w]);
    return w;
  };

  // 1. Values in the file.
  for (const date of dates) {
    const row = rows.get(date)!;
    for (const [key, value] of Object.entries(row.values)) {
      const p = parseHistoryKey(key)!;
      const list = byDate.get(date) ?? [];
      if (p.type === "total") {
        if (value === null) continue;
        const w = list.length ? primaryOf(list) : newSnapshot(date);
        w.totalsGiven[p.total] = value;
        continue;
      }
      const holders = list.filter((w) => snapshotValues(w.snap).has(key));
      if (value === null) {
        if (input.mode !== "replace") continue;
        for (const w of holders) {
          const before = snapshotValues(w.snap).get(key)!;
          write(w, key, null);
          changes.push({ date, key, before, after: null, kind: "removed" });
        }
        continue;
      }
      if (holders.length === 0) {
        const w = list.length ? primaryOf(list) : newSnapshot(date);
        write(w, key, value);
        changes.push({ date, key, before: null, after: value, kind: "added" });
        continue;
      }
      let changed = false;
      for (const w of holders) {
        const before = snapshotValues(w.snap).get(key)!;
        if (same(before, value)) continue;
        write(w, key, value);
        if (!changed) changes.push({ date, key, before, after: value, kind: "updated" });
        changed = true;
      }
      if (!changed) unchanged++;
    }
    if (row.note) {
      const list = byDate.get(date) ?? [];
      const w = list.length ? primaryOf(list) : newSnapshot(date);
      if (w.snap.note !== row.note) ensureMutable(w).note = row.note;
    }
  }

  // 2. Replace: clear mapped fields on dates in range that the file does not have.
  if (input.mode === "replace") {
    const totalsMapped = [...mapped].some((k) => parseHistoryKey(k)?.type === "total");
    for (const w of all) {
      const d = w.snap.date;
      if (w.isNew || d < range.from || d > range.to || rows.has(d)) continue;
      const vals = snapshotValues(w.snap);
      for (const key of mapped) {
        if (!vals.has(key)) continue;
        write(w, key, null);
        changes.push({ date: d, key, before: vals.get(key)!, after: null, kind: "removed" });
      }
      // A totals-only snapshot (no per-account values) on a date the file skips is cleared too.
      const s = w.snap;
      if (totalsMapped && !s.accounts.length && !s.realAssets.length && !s.debts.length) {
        ensureMutable(w);
        w.cleared = true;
      }
    }
  }

  // 3. Totals given in the file win for their date.
  for (const w of all) {
    const g = w.totalsGiven;
    if (g.netWorth === undefined && g.assets === undefined && g.liabilities === undefined) continue;
    const s = ensureMutable(w);
    const before = { netWorth: s.netWorth, assets: s.assets, liabilities: s.liabilities };
    if (g.assets !== undefined) s.assets = g.assets;
    if (g.liabilities !== undefined) s.liabilities = g.liabilities;
    if (g.netWorth !== undefined) {
      s.netWorth = g.netWorth;
      if (g.assets === undefined && g.liabilities === undefined) {
        // Net worth only: keep liabilities from the values, never let assets go negative.
        s.assets = round(Math.max(0, g.netWorth + s.liabilities));
        s.liabilities = round(s.assets - g.netWorth);
      } else if (g.assets === undefined) s.assets = round(g.netWorth + s.liabilities);
      else if (g.liabilities === undefined) s.liabilities = round(s.assets - g.netWorth);
    } else s.netWorth = round(s.assets - s.liabilities);
    for (const k of ["netWorth", "assets", "liabilities"] as const) {
      if (g[k] === undefined) continue;
      const prev = w.isNew ? null : (before[k] as number);
      if (prev !== null && same(prev, s[k])) {
        unchanged++;
        continue;
      }
      changes.push({
        date: s.date,
        key: k,
        before: prev,
        after: s[k],
        kind: prev === null ? "added" : "updated",
      });
    }
  }

  // 4. Collect the writes.
  const create: SnapshotDraft[] = [];
  const update: ProgressSnapshot[] = [];
  const remove: string[] = [];
  const replaceRemovesTotalsOnly = (w: Working) =>
    input.mode === "replace" &&
    !rows.has(w.snap.date) &&
    w.snap.date >= range.from &&
    w.snap.date <= range.to &&
    [...mapped].some((k) => parseHistoryKey(k)?.type === "total");
  for (const w of all) {
    if (!w.touched) continue;
    const s = w.snap;
    const emptyEntries = !s.accounts.length && !s.realAssets.length && !s.debts.length;
    const zero = Math.abs(s.assets) < EPS && Math.abs(s.liabilities) < EPS;
    if (w.isNew) {
      if (!(emptyEntries && zero && w.totalsGiven.netWorth === undefined))
        create.push(s as SnapshotDraft);
      continue;
    }
    const id = (s as ProgressSnapshot).id;
    if (w.cleared && emptyEntries && (zero || replaceRemovesTotalsOnly(w))) {
      remove.push(id);
      if (replaceRemovesTotalsOnly(w) && !zero)
        changes.push({
          date: s.date,
          key: "netWorth",
          before: s.netWorth,
          after: null,
          kind: "removed",
        });
      continue;
    }
    if (JSON.stringify(s) === w.original) continue;
    if (s.source === "auto") s.source = "import";
    update.push(s as ProgressSnapshot);
  }

  // 5. Today's values become current balances when asked.
  let current: CurrentBalanceUpdate | null = null;
  const todayRow = rows.get(input.today);
  if (input.updateCurrent && todayRow) {
    const c: CurrentBalanceUpdate = { accounts: [], realAssets: [], debts: [] };
    const assets = new Map<
      string,
      { assetId: string; currentValue?: number; loanBalance?: number }
    >();
    for (const [key, v] of Object.entries(todayRow.values)) {
      if (v === null) continue;
      const p = parseHistoryKey(key);
      if (!p || p.type !== "entity") continue;
      if (p.kind === "account") c.accounts.push({ accountId: p.id, balance: v });
      else if (p.kind === "debt") c.debts.push({ debtId: p.id, balance: v });
      else {
        const a = assets.get(p.id) ?? { assetId: p.id };
        if (p.kind === "asset") a.currentValue = v;
        else a.loanBalance = v;
        assets.set(p.id, a);
      }
    }
    c.realAssets = [...assets.values()];
    if (c.accounts.length || c.realAssets.length || c.debts.length) current = c;
  } else if (input.updateCurrent && !todayRow)
    issues.push({
      severity: "info",
      code: "history.current.no-today",
      message: "the file has no row dated today, so current balances are left as they are",
    });

  changes.sort((a, b) => a.date.localeCompare(b.date) || a.key.localeCompare(b.key));
  const count = (k: HistoryChange["kind"]) =>
    changes.filter((c) => c.kind === k && c.key !== HISTORY_NOTE).length;
  return {
    create,
    update,
    remove,
    changes,
    counts: {
      added: count("added"),
      updated: count("updated"),
      removed: count("removed"),
      unchanged,
      snapshotsCreated: create.length,
      snapshotsUpdated: update.length,
      snapshotsRemoved: remove.length,
    },
    range,
    current,
    issues,
  };
}

/** Apply a plan to a list of snapshots in memory (offline workspaces). `newId` names created snapshots. */
export function applyHistoryPlan(
  existing: readonly ProgressSnapshot[],
  plan: HistoryPlan,
  householdId: string,
  newId: (draft: SnapshotDraft, index: number) => string,
): ProgressSnapshot[] {
  const gone = new Set(plan.remove);
  const replaced = new Map(plan.update.map((s) => [s.id, s]));
  const kept = existing.filter((s) => !gone.has(s.id)).map((s) => replaced.get(s.id) ?? s);
  const created = plan.create.map(
    (d, i) => ({ ...d, id: newId(d, i), householdId }) as ProgressSnapshot,
  );
  return [...kept, ...created].sort((a, b) => a.date.localeCompare(b.date));
}
