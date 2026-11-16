/**
 * Pure helpers behind the import centre: grouping and searching the import report, merging an
 * imported document into an existing workspace, and the post-import review checklist.
 */
import { GlideworthDocument, JOINT } from "@glideworth/core";
import type {
  CoverageEntry,
  ImportCoverage,
  ImportIssue,
  ImportIssueCategory,
} from "@glideworth/importers";
import { countryLabel } from "../../lib/countries";
import { formatMonth, plural } from "../../lib/format";
import type { ImportChecklist } from "../../stores/prefs";

// ------------------------------------------------------------------------------------ report

export const CATEGORY_META: Record<
  ImportIssueCategory,
  { label: string; description: string; tone: "neutral" | "ochre" | "negative" | "accent" }
> = {
  approximated: {
    label: "Approximated",
    description: "Carried over, but Glideworth models it a little differently. Worth a look.",
    tone: "ochre",
  },
  unsupported: {
    label: "Not modelled yet",
    description:
      "Real planning content that has no home in Glideworth yet. It is listed so nothing is lost silently.",
    tone: "negative",
  },
  invalid: {
    label: "Invalid in the source",
    description: "Values that could not be read; a safe default or derivation was used.",
    tone: "negative",
  },
  unrecognised: {
    label: "Unrecognised",
    description: "Keys this importer does not know (newer export versions).",
    tone: "ochre",
  },
  defaulted: {
    label: "Defaults chosen",
    description: "Missing in the source; Glideworth filled in a default.",
    tone: "neutral",
  },
  dropped: {
    label: "Intentionally dropped",
    description: "Interface state, derived values and similar: nothing that changes your plan.",
    tone: "neutral",
  },
  info: { label: "Notes", description: "Everything else worth knowing.", tone: "neutral" },
};

export const CATEGORY_ORDER: ImportIssueCategory[] = [
  "approximated",
  "unsupported",
  "invalid",
  "unrecognised",
  "defaulted",
  "dropped",
  "info",
];

export interface IssueGroup {
  category: ImportIssueCategory;
  issues: ImportIssue[];
  /** Before filtering. */
  total: number;
}

function matches(hay: (string | undefined)[], q: string): boolean {
  if (!q) return true;
  const text = hay.filter(Boolean).join(" ").toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((t) => text.includes(t));
}

/** Group issues by category (fixed order), filtered by a free-text query and severity. */
export function groupIssues(
  issues: ImportIssue[],
  query = "",
  opts: { entityNames?: Record<string, string>; severity?: "all" | "warning" | "error" } = {},
): IssueGroup[] {
  const by = new Map<ImportIssueCategory, { all: ImportIssue[]; hit: ImportIssue[] }>();
  for (const i of issues) {
    const c = i.category ?? "info";
    const g = by.get(c) ?? { all: [], hit: [] };
    g.all.push(i);
    const sevOk =
      !opts.severity ||
      opts.severity === "all" ||
      (opts.severity === "warning" ? i.severity !== "info" : i.severity === "error");
    if (
      sevOk &&
      matches(
        [
          i.message,
          i.sourcePath,
          i.code,
          i.suggestedField,
          i.entityId && opts.entityNames?.[i.entityId],
        ],
        query,
      )
    )
      g.hit.push(i);
    by.set(c, g);
  }
  return CATEGORY_ORDER.filter((c) => by.has(c)).map((c) => ({
    category: c,
    issues: by.get(c)!.hit,
    total: by.get(c)!.all.length,
  }));
}

export const COVERAGE_META: Record<
  CoverageEntry["status"],
  { label: string; description: string }
> = {
  mapped: { label: "Mapped", description: "Carried into Glideworth." },
  ignored: {
    label: "Ignored",
    description: "Deliberately not carried over (no effect on the plan).",
  },
  unsupported: { label: "Not modelled", description: "No home in Glideworth yet." },
  unknown: { label: "Unknown", description: "Not recognised by the importer." },
};

export function filterCoverage(
  coverage: ImportCoverage,
  query = "",
  status: CoverageEntry["status"] | "all" = "all",
): CoverageEntry[] {
  return coverage.entries.filter(
    (e) => (status === "all" || e.status === status) && matches([e.path, e.target, e.note], query),
  );
}

/** Friendly entity names from the source path ("$.plans[1].income.events[2]" → "Plan 2 · income 3"). */
export function describePath(path: string): string {
  return path
    .replace(/^\$\.?/, "")
    .replace(/\[(\d+)\]/g, (_, n) => ` ${Number(n) + 1}`)
    .replace(/\./g, " › ");
}

// ------------------------------------------------------------------------------------ merge

export interface MergeOutcome {
  document: GlideworthDocument | null;
  notes: string[];
  errors: string[];
  added: { accounts: number; realAssets: number; debts: number; plans: number; snapshots: number };
}

const TEXT_KEYS = new Set(["name", "description", "notes", "note", "label", "title", "message"]);

function renameDeep(value: unknown, map: Map<string, string>, parentKey = ""): unknown {
  if (typeof value === "string")
    return !TEXT_KEYS.has(parentKey) && map.has(value) ? map.get(value) : value;
  if (Array.isArray(value)) return value.map((v) => renameDeep(v, map, parentKey));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[map.get(k) ?? k] = renameDeep(v, map, k);
    return out;
  }
  return value;
}

/**
 * Merge `incoming` into `existing`: keep the existing household (people, location, currency),
 * add the incoming accounts, property, debts, plans and snapshots. Ids that collide are renamed
 * and every reference follows; incoming people map onto the existing people by role.
 */
export function mergeDocuments(
  existing: GlideworthDocument,
  incoming: GlideworthDocument,
): MergeOutcome {
  const notes: string[] = [];
  const map = new Map<string, string>();
  const ex = existing.household;
  const exPrimary = ex.people.find((p) => p.role === "primary")!;
  const exPartner = ex.people.find((p) => p.role === "partner");
  for (const p of incoming.household.people) {
    const target = p.role === "partner" ? (exPartner ?? exPrimary) : exPrimary;
    if (p.id !== target.id) map.set(p.id, target.id);
    if (p.role === "partner" && !exPartner)
      notes.push(
        `${p.name} (partner in the import) has no counterpart in your household; their items now belong to ${exPrimary.name}.`,
      );
  }
  if (!exPartner && incoming.household.people.length > 1) map.set(JOINT, exPrimary.id);
  if (incoming.household.currency !== ex.currency)
    notes.push(
      `The import is in ${incoming.household.currency} but your household uses ${ex.currency}. Amounts are copied as they are, not converted.`,
    );
  if (incoming.finances.asOf !== existing.finances.asOf)
    notes.push(
      `Imported balances are as of ${incoming.finances.asOf}; yours are as of ${existing.finances.asOf}. The existing date is kept.`,
    );

  const taken = new Set<string>([
    ...existing.finances.accounts.map((a) => a.id),
    ...existing.finances.realAssets.map((a) => a.id),
    ...existing.finances.debts.map((a) => a.id),
    ...existing.plans.map((p) => p.id),
    ...existing.progress.map((s) => s.id),
  ]);
  let renamed = 0;
  const claim = (id: string) => {
    if (!taken.has(id)) {
      taken.add(id);
      return;
    }
    let n = 2;
    let next = `${id.slice(0, 54)}-imported`;
    while (taken.has(next)) next = `${id.slice(0, 54)}-imported-${n++}`;
    taken.add(next);
    map.set(id, next);
    renamed++;
  };
  for (const a of incoming.finances.accounts) claim(a.id);
  for (const a of incoming.finances.realAssets) claim(a.id);
  for (const d of incoming.finances.debts) claim(d.id);
  for (const p of incoming.plans) claim(p.id);

  const fin = renameDeep(incoming.finances, map) as GlideworthDocument["finances"];
  const plans = (renameDeep(incoming.plans, map) as GlideworthDocument["plans"]).map((p) => ({
    ...p,
    householdId: ex.id,
    isMain: false,
  }));
  const dates = new Set(existing.progress.map((s) => s.date));
  const snaps = (renameDeep(incoming.progress, map) as GlideworthDocument["progress"])
    .filter((s) => !dates.has(s.date))
    .map((s) => {
      let id = s.id;
      let n = 2;
      while (taken.has(id)) id = `${s.id.slice(0, 56)}-${n++}`;
      taken.add(id);
      return { ...s, id, householdId: ex.id };
    });
  const skipped = incoming.progress.length - snaps.length;
  if (skipped > 0)
    notes.push(`${skipped} imported snapshots fall on dates you already have; yours were kept.`);
  if (renamed > 0)
    notes.push(
      "Some imported ids clashed with yours and were renamed; every reference was updated.",
    );

  const candidate = {
    ...existing,
    finances: {
      ...existing.finances,
      accounts: [...existing.finances.accounts, ...fin.accounts],
      realAssets: [...existing.finances.realAssets, ...fin.realAssets],
      debts: [...existing.finances.debts, ...fin.debts],
    },
    plans: [...existing.plans, ...plans],
    progress: [...existing.progress, ...snaps].sort((a, b) => a.date.localeCompare(b.date)),
  };
  const parsed = GlideworthDocument.safeParse(candidate);
  const added = {
    accounts: fin.accounts.length,
    realAssets: fin.realAssets.length,
    debts: fin.debts.length,
    plans: plans.length,
    snapshots: snaps.length,
  };
  if (!parsed.success)
    return {
      document: null,
      notes,
      errors: parsed.error.issues.slice(0, 8).map((i) => `${i.path.join(".")}: ${i.message}`),
      added,
    };
  return { document: parsed.data, notes, errors: [], added };
}

// ------------------------------------------------------------------------------------ checklist

export function buildImportChecklist(
  doc: GlideworthDocument,
  opts: {
    source: string;
    issueCounts?: Partial<Record<ImportIssueCategory, number>>;
    planIds?: string[];
  },
  now = new Date(),
): ImportChecklist {
  const plans = opts.planIds ? doc.plans.filter((p) => opts.planIds!.includes(p.id)) : doc.plans;
  const items: ImportChecklist["items"] = [
    {
      id: "household",
      label: "Check people, location and currency",
      detail: `${doc.household.people.map((p) => p.name).join(" & ")} · ${countryLabel(doc.household.location.country)} · ${doc.household.currency}`,
      to: "/finances",
      done: false,
    },
    {
      id: "balances",
      label: "Confirm account balances",
      detail: `${plural(doc.finances.accounts.length, "account")}, balances as of ${formatMonth(doc.finances.asOf, doc.household.locale ?? "en-GB")}`,
      to: "/finances",
      done: false,
    },
    ...plans.slice(0, 6).map((p) => ({
      id: `plan:${p.id}`,
      label: `Review “${p.name}”`,
      detail: `${p.income.length} income · ${plural(p.expenses.length, "expense")} · ${plural(p.milestones.length, "milestone")} · ${plural(p.flows.length, "flow")}`,
      to: `/plans/${p.id}`,
      planId: p.id,
      done: false,
    })),
  ];
  const approx = opts.issueCounts?.approximated ?? 0;
  const unsupported = opts.issueCounts?.unsupported ?? 0;
  if (approx + unsupported > 0)
    items.push({
      id: "report",
      label: `Read the import report`,
      detail: [
        approx ? `${approx} approximated` : "",
        unsupported ? `${unsupported} not modelled yet` : "",
      ]
        .filter(Boolean)
        .join(", "),
      to: "/import",
      search: { tab: "projectionlab" },
      done: false,
    });
  const main = doc.plans.find((p) => p.isMain) ?? doc.plans[0];
  if (main)
    items.push({
      id: "chance",
      label: "Run chance of success on your main plan",
      detail: main.name,
      to: "/chance",
      planId: main.id,
      done: false,
    });
  return { source: opts.source, at: now.toISOString(), items };
}
