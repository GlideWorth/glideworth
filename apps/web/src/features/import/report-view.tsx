/**
 * The full import report: per-entity counts, every issue grouped by what happened to it (mapped,
 * approximated, not modelled, dropped...), and the key-path coverage table. Searchable; nothing
 * is hidden: filtered groups say how many of their items are showing.
 */
import type {
  CoverageEntry,
  ImportCount,
  ImportCoverage,
  ImportIssue,
  ImportIssueCategory,
} from "@glideworth/importers";
import { ChevronRight, Search } from "lucide-react";
import { useDeferredValue, useMemo, useState } from "react";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Segmented } from "../../components/ui/segmented";
import { ScrollRegion } from "../../components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../components/ui/tabs";
import { cn } from "../../lib/cn";
import {
  CATEGORY_META,
  COVERAGE_META,
  describePath,
  filterCoverage,
  groupIssues,
} from "./import-model";

const ENTITY_LABEL: Record<string, string> = {
  people: "People",
  accounts: "Accounts",
  realAssets: "Property & assets",
  debts: "Debts",
  plans: "Plans",
  income: "Income events",
  expenses: "Expenses",
  flows: "Savings flows",
  milestones: "Milestones",
  progress: "Progress snapshots",
};

export function CountsTable({
  counts,
  locale,
}: {
  counts: Record<string, ImportCount>;
  locale: string;
}) {
  const nf = new Intl.NumberFormat(locale);
  return (
    <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-3 lg:grid-cols-5">
      {Object.entries(counts).map(([k, c]) => {
        const short = c.imported < c.source;
        return (
          <div key={k} className="bg-surface px-3 py-2.5">
            <div className="text-[11.5px] text-ink-3">{ENTITY_LABEL[k] ?? k}</div>
            <div className="num mt-0.5 flex items-baseline gap-1.5">
              <span className="text-[18px] font-semibold text-ink">{nf.format(c.imported)}</span>
              <span
                className={cn("text-[11.5px]", short ? "font-medium text-ochre" : "text-ink-3")}
              >
                {short
                  ? `of ${nf.format(c.source)} found`
                  : c.source === c.imported
                    ? "all found"
                    : ""}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function IssueTally({
  counts,
  locale,
}: {
  counts: Partial<Record<ImportIssueCategory, number>>;
  locale: string;
}) {
  const nf = new Intl.NumberFormat(locale);
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label="Issues by kind">
      {(Object.keys(CATEGORY_META) as ImportIssueCategory[])
        .filter((c) => (counts[c] ?? 0) > 0)
        .map((c) => (
          <li key={c}>
            <Badge tone={CATEGORY_META[c].tone}>
              <span className="num font-semibold">{nf.format(counts[c] ?? 0)}</span>{" "}
              {CATEGORY_META[c].label.toLowerCase()}
            </Badge>
          </li>
        ))}
    </ul>
  );
}

export function ImportReportView({
  issues,
  coverage,
  entityNames,
  locale,
}: {
  issues: ImportIssue[];
  coverage?: ImportCoverage;
  entityNames?: Record<string, string>;
  locale: string;
}) {
  return (
    <Tabs defaultValue="issues" className="flex flex-col gap-3">
      <TabsList aria-label="Report sections" className="overflow-x-auto">
        <TabsTrigger value="issues">
          What needs a look <span className="num ml-1 text-ink-3">{issues.length}</span>
        </TabsTrigger>
        {coverage ? (
          <TabsTrigger value="coverage">
            Every field in the file{" "}
            <span className="num ml-1 text-ink-3">{coverage.entries.length}</span>
          </TabsTrigger>
        ) : null}
      </TabsList>
      <TabsContent value="issues">
        <IssueList issues={issues} entityNames={entityNames} locale={locale} />
      </TabsContent>
      {coverage ? (
        <TabsContent value="coverage">
          <CoverageTable coverage={coverage} locale={locale} />
        </TabsContent>
      ) : null}
    </Tabs>
  );
}

function IssueList({
  issues,
  entityNames,
  locale,
}: {
  issues: ImportIssue[];
  entityNames?: Record<string, string>;
  locale: string;
}) {
  const [q, setQ] = useState("");
  const [severity, setSeverity] = useState<"all" | "warning">("all");
  const dq = useDeferredValue(q);
  const groups = useMemo(
    () => groupIssues(issues, dq, { entityNames, severity }),
    [issues, dq, entityNames, severity],
  );
  const showing = groups.reduce((s, g) => s + g.issues.length, 0);
  const nf = new Intl.NumberFormat(locale);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-ink-3" />
          <Input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search messages, fields, codes…"
            aria-label="Search the import report"
            className="pl-8"
          />
        </div>
        <Segmented
          aria-label="Severity"
          size="sm"
          value={severity}
          onChange={setSeverity}
          options={[
            { value: "all", label: "Everything" },
            { value: "warning", label: "Warnings only" },
          ]}
        />
      </div>
      <p className="text-[12px] text-ink-3" aria-live="polite">
        Showing {nf.format(showing)} of {nf.format(issues.length)} items.
      </p>
      {issues.length === 0 ? (
        <p className="rounded-lg border border-border bg-surface px-4 py-6 text-center text-[13px] text-ink-2">
          Everything in the file mapped cleanly. Nothing needs a look.
        </p>
      ) : null}
      <div className="flex flex-col gap-2">
        {groups.map((g) => (
          <details
            key={g.category}
            open={
              g.category === "approximated" ||
              g.category === "unsupported" ||
              g.category === "invalid" ||
              !!dq
            }
            className="group overflow-hidden rounded-lg border border-border bg-surface"
          >
            <summary className="flex cursor-pointer list-none items-center gap-2.5 px-4 py-2.5 select-none hover:bg-surface-2 [&::-webkit-details-marker]:hidden">
              <ChevronRight
                className="size-3.5 text-ink-3 transition-transform group-open:rotate-90"
                aria-hidden
              />
              <span className="text-[13px] font-semibold text-ink">
                {CATEGORY_META[g.category].label}
              </span>
              <Badge tone={CATEGORY_META[g.category].tone}>
                <span className="num">
                  {g.issues.length === g.total
                    ? nf.format(g.total)
                    : `${nf.format(g.issues.length)} of ${nf.format(g.total)}`}
                </span>
              </Badge>
              <span className="hidden min-w-0 flex-1 truncate text-[12px] text-ink-3 md:inline">
                {CATEGORY_META[g.category].description}
              </span>
            </summary>
            {g.issues.length ? (
              <ul className="divide-y divide-border border-t border-border">
                {g.issues.slice(0, 400).map((i, idx) => (
                  // oxlint-disable-next-line react/no-array-index-key -- issues have no id; order is stable
                  <li key={`${i.sourcePath}-${idx}`} className="flex gap-3 px-4 py-2">
                    <span
                      role="img"
                      aria-label={i.severity}
                      className={cn(
                        "mt-1.5 size-1.5 shrink-0 rounded-full",
                        i.severity === "error"
                          ? "bg-negative"
                          : i.severity === "warning"
                            ? "bg-ochre"
                            : "bg-ink-3",
                      )}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="text-[13px] text-ink">{capitalise(i.message)}</p>
                      <p className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[11.5px] text-ink-3">
                        <span title={i.sourcePath} className="break-all font-mono">
                          {describePath(i.sourcePath)}
                        </span>
                        {i.entityId && entityNames?.[i.entityId] ? (
                          <span>→ {entityNames[i.entityId]}</span>
                        ) : null}
                        {i.suggestedField ? <span>would need: {i.suggestedField}</span> : null}
                      </p>
                    </div>
                  </li>
                ))}
                {g.issues.length > 400 ? (
                  <li className="px-4 py-2 text-[12px] text-ink-3">
                    {nf.format(g.issues.length - 400)} more: narrow the search to see them.
                  </li>
                ) : null}
              </ul>
            ) : (
              <p className="border-t border-border px-4 py-2 text-[12px] text-ink-3">
                No matches in this group.
              </p>
            )}
          </details>
        ))}
      </div>
    </div>
  );
}

function capitalise(s: string) {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}

const PAGE = 150;

function CoverageTable({ coverage, locale }: { coverage: ImportCoverage; locale: string }) {
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<CoverageEntry["status"] | "all">("all");
  const [limit, setLimit] = useState(PAGE);
  const dq = useDeferredValue(q);
  const rows = useMemo(() => filterCoverage(coverage, dq, status), [coverage, dq, status]);
  const nf = new Intl.NumberFormat(locale);
  const pct = (n: number) => (coverage.total ? Math.round((n / coverage.total) * 100) : 0);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex h-2 overflow-hidden rounded-full bg-surface-3" aria-hidden>
        <span className="bg-accent" style={{ width: `${pct(coverage.mapped)}%` }} />
        <span className="bg-ink-3/40" style={{ width: `${pct(coverage.ignored)}%` }} />
        <span className="bg-ochre" style={{ width: `${pct(coverage.unsupported)}%` }} />
        <span className="bg-negative" style={{ width: `${pct(coverage.unknown)}%` }} />
      </div>
      <p className="text-[12.5px] text-ink-2">
        {nf.format(coverage.total)} distinct fields in the file:{" "}
        <strong>{nf.format(coverage.mapped)}</strong> mapped, {nf.format(coverage.ignored)} ignored
        on purpose, {nf.format(coverage.unsupported)} not modelled yet
        {coverage.unknown ? `, ${nf.format(coverage.unknown)} unknown` : ""}.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-ink-3" />
          <Input
            type="search"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setLimit(PAGE);
            }}
            placeholder="Search field paths and notes…"
            aria-label="Search fields"
            className="pl-8"
          />
        </div>
        <Segmented
          aria-label="Field status"
          size="sm"
          value={status}
          onChange={(s) => {
            setStatus(s);
            setLimit(PAGE);
          }}
          options={[
            { value: "all", label: "All" },
            { value: "mapped", label: "Mapped" },
            { value: "unsupported", label: "Not modelled" },
            { value: "ignored", label: "Ignored" },
          ]}
        />
      </div>
      <ScrollRegion
        label="Table, scrolls sideways if it does not fit"
        className="rounded-lg border border-border bg-surface"
      >
        <table className="w-full border-collapse text-[12.5px]">
          <caption className="sr-only">How each field in the export was handled</caption>
          <thead>
            <tr className="border-b border-border text-left">
              <th
                scope="col"
                className="px-3 py-2 text-[11px] font-semibold tracking-wider text-ink-3 uppercase"
              >
                Field in the file
              </th>
              <th
                scope="col"
                className="px-3 py-2 text-[11px] font-semibold tracking-wider text-ink-3 uppercase"
              >
                Status
              </th>
              <th
                scope="col"
                className="px-3 py-2 text-[11px] font-semibold tracking-wider text-ink-3 uppercase"
              >
                In Glideworth / why
              </th>
              <th
                scope="col"
                className="px-3 py-2 text-right text-[11px] font-semibold tracking-wider text-ink-3 uppercase"
              >
                Seen
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, limit).map((e) => (
              <tr key={e.path} className="border-b border-border/70 last:border-b-0 align-top">
                <td className="max-w-[340px] px-3 py-1.5 font-mono text-[11.5px] break-all text-ink-2">
                  {e.path}
                </td>
                <td className="px-3 py-1.5 whitespace-nowrap">
                  <Badge
                    tone={
                      e.status === "mapped"
                        ? "accent"
                        : e.status === "unsupported"
                          ? "ochre"
                          : e.status === "unknown"
                            ? "negative"
                            : "neutral"
                    }
                  >
                    {COVERAGE_META[e.status].label}
                  </Badge>
                </td>
                <td className="px-3 py-1.5 text-ink-2">{e.target ?? e.note ?? "—"}</td>
                <td className="num px-3 py-1.5 text-right text-ink-3">
                  {nf.format(e.occurrences)}
                </td>
              </tr>
            ))}
            {rows.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-3 py-6 text-center text-ink-3">
                  No fields match.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </ScrollRegion>
      {rows.length > limit ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setLimit((l) => l + PAGE * 2)}
          className="self-start"
        >
          Show more ({nf.format(rows.length - limit)} remaining)
        </Button>
      ) : null}
    </div>
  );
}
