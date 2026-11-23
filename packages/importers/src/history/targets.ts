/**
 * What a balance-history column can map to: an account balance, a real asset's value, the balance of a real
 * asset's loan, or a debt balance. Plus the three totals and a note, for files that carry them.
 *
 * A target is addressed by a key: `account:<id>`, `asset:<id>`, `loan:<id>` (the real asset's id), `debt:<id>`,
 * `netWorth`, `assets`, `liabilities` or `note`.
 */
import { ACCOUNT_TYPE_INFO, type CurrentFinances } from "@glideworth/core";

export type HistoryEntityKind = "account" | "asset" | "loan" | "debt";
export type HistoryTotal = "netWorth" | "assets" | "liabilities";
export const HISTORY_TOTALS: readonly HistoryTotal[] = ["netWorth", "assets", "liabilities"];
export const HISTORY_NOTE = "note";

export interface HistoryTarget {
  /** `account:<id>`, `asset:<id>`, `loan:<id>` or `debt:<id>`. */
  key: string;
  kind: HistoryEntityKind;
  /** The account, real asset (for `asset` and `loan`) or debt id. */
  id: string;
  /** The entity's own name (the real asset's name for a loan). */
  name: string;
  /** A column header that is unique among the targets: used by templates and exports, and matched exactly. */
  label: string;
  /** Assets add to net worth; loans and debts are amounts owed (stored as positive numbers). */
  side: "asset" | "liability";
  /** The snapshot `byCategory` bucket the value counts towards. */
  category: string;
  /** Currency of the value, when it is not the household's. */
  currency?: string;
  /** Base-currency units per unit of `currency` (1 for base-currency items or a missing rate). */
  rate: number;
  archived: boolean;
}

/** A key's parts: an entity, a total, the note, or undefined when the key is not valid. */
export type ParsedHistoryKey =
  | { type: "entity"; kind: HistoryEntityKind; id: string }
  | { type: "total"; total: HistoryTotal }
  | { type: "note" };

const ENTITY_KEY = /^(account|asset|loan|debt):([A-Za-z0-9_-]{1,64})$/;

export function parseHistoryKey(key: string): ParsedHistoryKey | undefined {
  if (key === HISTORY_NOTE) return { type: "note" };
  if ((HISTORY_TOTALS as readonly string[]).includes(key))
    return { type: "total", total: key as HistoryTotal };
  const m = ENTITY_KEY.exec(key);
  if (!m || Object.hasOwn(Object.prototype, m[2]!)) return undefined;
  return { type: "entity", kind: m[1] as HistoryEntityKind, id: m[2]! };
}

export function historyKey(kind: HistoryEntityKind, id: string): string {
  return `${kind}:${id}`;
}

/** Base-currency units per unit of `currency`; 1 when it is the base or no pair exists. */
export function rateToBase(
  rates: CurrentFinances["fxRates"] | undefined,
  currency: string | undefined,
  base: string | undefined,
): number {
  if (!currency || !base || currency === base) return 1;
  const direct = rates?.find((r) => r.from === currency && r.to === base);
  if (direct) return direct.rate;
  const inverse = rates?.find((r) => r.from === base && r.to === currency);
  return inverse && inverse.rate ? 1 / inverse.rate : 1;
}

/**
 * Every account, real asset, real-asset loan and debt in a household's current finances, in display order.
 * Labels are the names, with ` (loan)` for a loan and ` [id]` added where two targets would share a label.
 */
export function historyTargets(
  finances: Pick<CurrentFinances, "accounts" | "realAssets" | "debts"> &
    Partial<Pick<CurrentFinances, "fxRates">>,
  baseCurrency?: string,
): HistoryTarget[] {
  const out: Omit<HistoryTarget, "label">[] = [];
  const rate = (c: string | undefined) => rateToBase(finances.fxRates, c, baseCurrency);
  for (const a of finances.accounts)
    out.push({
      key: historyKey("account", a.id),
      kind: "account",
      id: a.id,
      name: a.name,
      side: "asset",
      category: ACCOUNT_TYPE_INFO[a.type]?.drawdown ?? "cash",
      ...(a.currency ? { currency: a.currency } : {}),
      rate: rate(a.currency),
      archived: a.archived ?? false,
    });
  for (const r of finances.realAssets) {
    out.push({
      key: historyKey("asset", r.id),
      kind: "asset",
      id: r.id,
      name: r.name,
      side: "asset",
      category: "real-assets",
      ...(r.currency ? { currency: r.currency } : {}),
      rate: rate(r.currency),
      archived: r.archived ?? false,
    });
    if (r.loan)
      out.push({
        key: historyKey("loan", r.id),
        kind: "loan",
        id: r.id,
        name: r.name,
        side: "liability",
        category: "loans",
        ...(r.currency ? { currency: r.currency } : {}),
        rate: rate(r.currency),
        archived: r.archived ?? false,
      });
  }
  for (const d of finances.debts)
    out.push({
      key: historyKey("debt", d.id),
      kind: "debt",
      id: d.id,
      name: d.name,
      side: "liability",
      category: "debt",
      ...(d.currency ? { currency: d.currency } : {}),
      rate: rate(d.currency),
      archived: d.archived ?? false,
    });
  const base = (t: Omit<HistoryTarget, "label">) =>
    t.kind === "loan" ? `${t.name} (loan)` : t.name;
  const seen = new Map<string, number>();
  for (const t of out) {
    const k = base(t).trim().toLowerCase();
    seen.set(k, (seen.get(k) ?? 0) + 1);
  }
  return out.map((t) => {
    const b = base(t).trim();
    return { ...t, label: (seen.get(b.toLowerCase()) ?? 0) > 1 ? `${b} [${t.id}]` : b };
  });
}

/** Human-readable name for a key (a target's label, or the total's name). */
export function historyKeyLabel(key: string, targets: readonly HistoryTarget[]): string {
  const t = targets.find((x) => x.key === key);
  if (t) return t.label;
  if (key === "netWorth") return "Net worth";
  if (key === "assets") return "Assets";
  if (key === "liabilities") return "Liabilities";
  if (key === HISTORY_NOTE) return "Note";
  return key;
}
