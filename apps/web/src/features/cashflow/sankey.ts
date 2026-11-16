/**
 * Sankey graph from the ProjectionResult ledger for one year or a range of years. The ledger is
 * the single source of truth: every link is a recorded money movement (from → to).
 *
 * Accounts can be both a source (withdrawal) and a destination (contribution) in the same span,
 * so nodes are split by side (`@in` / `@out`) to keep the graph acyclic.
 */
import type { LedgerNode, PeriodResult, ProjectionResult, ValueBasis } from "@glideworth/core";
import type { FlowRole } from "../../components/charts/palette";
import type { YearViewOptions } from "../../lib/money";
import { CATEGORY_LABEL, categoryName, conv, type EntityIndex } from "../results/model";

export type SankeyGrouping = "detail" | "grouped";

export interface SankeyNodeSpec {
  key: string;
  label: string;
  role: FlowRole;
  /** Column hint: 0 sources, 1 pool, 2 destinations. */
  depth: number;
}
export interface SankeyLinkSpec {
  source: string;
  target: string;
  value: number;
}
export interface SankeyGraph {
  nodes: SankeyNodeSpec[];
  links: SankeyLinkSpec[];
  totals: {
    inflow: number;
    taxes: number;
    spending: number;
    saved: number;
    withdrawn: number;
    debt: number;
  };
}

const POOL = "pool";

function nodeRole(n: LedgerNode, side: "src" | "dst"): FlowRole {
  switch (n.kind) {
    case "income":
      return "income";
    case "account":
      return side === "src" ? "withdrawal" : "savings";
    case "tax":
      return "tax";
    case "expense":
      return "expense";
    case "debt":
    case "asset":
      return "debt";
    case "growth":
      return "growth";
    case "shortfall":
      return "shortfall";
    default:
      return "pool";
  }
}

function groupedKey(
  n: LedgerNode,
  side: "src" | "dst",
  p: PeriodResult,
  index: EntityIndex,
): { key: string; label: string } {
  switch (n.kind) {
    case "income":
      if (n.id.startsWith("income:dividends:"))
        return { key: "g:inc:investment", label: "Dividends & interest" };
      {
        const line = p.income.find((l) => `income:${l.sourceId}` === n.id);
        const k = line?.sourceKind ?? "income";
        const label =
          k === "benefit"
            ? "Benefits & state pension"
            : k === "pension"
              ? "Pensions"
              : k === "rental"
                ? "Rental income"
                : "Earned & other income";
        return { key: `g:inc:${label}`, label };
      }
    case "account": {
      const meta = n.refId ? index.accounts.get(n.refId) : undefined;
      const cat = meta?.category ?? "taxable";
      return side === "src"
        ? { key: `g:wd:${cat}`, label: `From ${CATEGORY_LABEL[cat].toLowerCase()}` }
        : { key: `g:sv:${cat}`, label: `Saved: ${CATEGORY_LABEL[cat].toLowerCase()}` };
    }
    case "expense": {
      const line = p.expenses.find((e) => `expense:${e.sourceId}` === n.id);
      const cat = line?.category ?? "other";
      return { key: `g:exp:${cat}`, label: categoryName(cat) };
    }
    case "tax":
      return { key: "g:tax", label: "Taxes" };
    case "debt":
    case "asset":
      return { key: "g:debt", label: "Debt & loan payments" };
    default:
      return { key: n.id, label: n.label };
  }
}

export function buildSankey(
  result: ProjectionResult,
  from: number,
  to: number,
  basis: ValueBasis,
  grouping: SankeyGrouping,
  index: EntityIndex,
  view: YearViewOptions = {},
): SankeyGraph {
  const nodes = new Map<string, SankeyNodeSpec>();
  const links = new Map<string, number>();
  const totals = { inflow: 0, taxes: 0, spending: 0, saved: 0, withdrawn: 0, debt: 0 };
  const lo = Math.max(0, Math.min(from, to));
  const hi = Math.min(result.periods.length - 1, Math.max(from, to));
  // A partial year is only annualised when it is shown alone: a range is an actual total.
  const yearView = lo === hi ? view : {};
  for (let i = lo; i <= hi; i++) {
    const p = result.periods[i]!;
    const byId = new Map(p.ledgerNodes.map((n) => [n.id, n]));
    const resolve = (id: string, side: "src" | "dst"): SankeyNodeSpec => {
      const n = byId.get(id) ?? { id, kind: id === POOL ? "pool" : "external", label: id };
      if (n.kind === "pool") return { key: POOL, label: "Available cash", role: "pool", depth: 1 };
      const role = nodeRole(n as LedgerNode, side);
      const depth = side === "src" ? 0 : 2;
      if (grouping === "grouped") {
        const g = groupedKey(n as LedgerNode, side, p, index);
        return { key: `${g.key}@${side}`, label: g.label, role, depth };
      }
      const label =
        n.kind === "account" && n.refId
          ? (index.accounts.get(n.refId)?.name ?? n.label)
          : n.kind === "shortfall"
            ? "Unfunded (shortfall)"
            : n.label;
      return { key: `${n.id}@${side}`, label, role, depth };
    };
    for (const e of p.ledger) {
      if (!(e.amount > 0.005)) continue;
      const v = conv(p, e.amount, basis, "flow", yearView);
      const s = resolve(e.from, "src");
      const t = resolve(e.to, "dst");
      if (s.key === t.key) continue;
      nodes.set(s.key, s);
      nodes.set(t.key, t);
      const k = `${s.key}→${t.key}`;
      links.set(k, (links.get(k) ?? 0) + v);
      // Money in = everything leaving a source node (income, an account, a sale, the shortfall),
      // whether it passes through the pool or goes straight to its destination (an employer pension
      // contribution, a bill paid from an account). Account-to-account transfers are internal.
      if (e.kind !== "transfer" && s.depth === 0) {
        totals.inflow += v;
        if (s.role === "withdrawal") totals.withdrawn += v;
      }
      switch (e.kind) {
        case "tax":
          totals.taxes += v;
          break;
        case "expense":
          totals.spending += v;
          break;
        case "contribution":
        case "leftover":
          totals.saved += v;
          break;
        case "debt-payment":
        case "purchase":
          // Loan repayments and asset purchases share the "Debt & loan payments" node.
          totals.debt += v;
          break;
        default:
          break;
      }
    }
  }
  return {
    nodes: [...nodes.values()],
    links: [...links.entries()]
      .map(([k, value]) => {
        const [source, target] = k.split("→") as [string, string];
        return { source, target, value };
      })
      .filter((l) => l.value > 0.5),
    totals,
  };
}
