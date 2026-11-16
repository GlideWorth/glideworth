import { buildSimulationInput, GlideworthDocument, simulate } from "@glideworth/core";
import { createSampleDocument, createUkSampleDocument } from "@glideworth/core/samples";
import { importProjectionLab } from "@glideworth/importers";
import { describe, expect, it } from "vitest";
import { buildSyntheticExport } from "../../../packages/importers/test/fixtures/projectionlab-synthetic";
import {
  buildImportChecklist,
  describePath,
  filterCoverage,
  groupIssues,
  mergeDocuments,
} from "../src/features/import/import-model";
import { rehome } from "../src/features/import/persist";

const pl = () => importProjectionLab(buildSyntheticExport(), { now: "2026-11-15T00:00:00Z" });

describe("import report model", () => {
  it("groups every issue by category with nothing hidden", () => {
    const r = pl();
    const groups = groupIssues(r.issues);
    expect(groups.reduce((s, g) => s + g.issues.length, 0)).toBe(r.issues.length);
    expect(groups.reduce((s, g) => s + g.total, 0)).toBe(r.issues.length);
    // Approximated first: the items most worth reviewing.
    expect(groups[0]!.category).toBe("approximated");
  });

  it("filters by free text across message, path and code while keeping totals", () => {
    const r = pl();
    const groups = groupIssues(r.issues, "broker");
    const hits = groups.flatMap((g) => g.issues);
    expect(hits.length).toBeGreaterThan(0);
    expect(
      hits.every((i) => `${i.message} ${i.sourcePath} ${i.code}`.toLowerCase().includes("broker")),
    ).toBe(true);
    expect(groups.reduce((s, g) => s + g.total, 0)).toBe(r.issues.length);
    expect(groupIssues(r.issues, "", { severity: "error" }).flatMap((g) => g.issues)).toHaveLength(
      0,
    );
  });

  it("filters the coverage table by status and text", () => {
    const { coverage } = pl().report;
    expect(filterCoverage(coverage).length).toBe(coverage.entries.length);
    const mapped = filterCoverage(coverage, "", "mapped");
    expect(mapped.every((e) => e.status === "mapped")).toBe(true);
    expect(
      filterCoverage(coverage, "income").every((e) =>
        /income/i.test(`${e.path}${e.target}${e.note}`),
      ),
    ).toBe(true);
  });

  it("describes source paths for humans", () => {
    expect(describePath("$.plans[1].income.events[2].amount")).toBe(
      "plans 2 › income › events 3 › amount",
    );
  });
});

describe("merge into existing data", () => {
  it("adds imported accounts and plans, remaps people, keeps the household and stays valid", () => {
    const existing = createUkSampleDocument();
    const incoming = pl().document;
    const out = mergeDocuments(existing, incoming);
    expect(out.errors).toEqual([]);
    const doc = out.document!;
    expect(GlideworthDocument.safeParse(doc).success).toBe(true);
    expect(doc.household).toEqual(existing.household);
    expect(doc.finances.accounts.length).toBe(
      existing.finances.accounts.length + incoming.finances.accounts.length,
    );
    expect(doc.plans.length).toBe(existing.plans.length + incoming.plans.length);
    expect(doc.plans.filter((p) => p.isMain)).toHaveLength(1);
    const people = new Set(doc.household.people.map((p) => p.id));
    for (const a of doc.finances.accounts)
      expect(a.owner === "joint" || people.has(a.owner)).toBe(true);
    expect(out.notes.some((n) => n.includes("not converted"))).toBe(
      incoming.household.currency !== existing.household.currency,
    );
    // Every merged plan still simulates.
    for (const p of doc.plans) {
      const r = simulate(buildSimulationInput(doc, p.id, { strict: false, trace: "off" }));
      expect(r.periods.length).toBeGreaterThan(0);
    }
  });

  it("warns when currencies differ", () => {
    const out = mergeDocuments(createUkSampleDocument(), createSampleDocument());
    expect(out.notes.some((n) => n.includes("USD") && n.includes("not converted"))).toBe(true);
  });

  it("renames clashing ids and every reference follows", () => {
    const existing = createSampleDocument();
    const out = mergeDocuments(existing, createSampleDocument());
    const doc = out.document!;
    const ids = doc.finances.accounts.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    const copy = doc.plans.find((p) => p.id.endsWith("-imported"))!;
    expect(copy).toBeDefined();
    const accountIds = new Set(ids);
    for (const f of copy.flows)
      if (f.kind === "contribution") expect(accountIds.has(f.accountId)).toBe(true);
    expect(out.notes.some((n) => n.includes("renamed"))).toBe(true);
  });
});

describe("replace and checklist", () => {
  it("rehomes a document onto the existing household id", () => {
    const d = rehome(pl().document, "hh-existing");
    expect(d.household.id).toBe("hh-existing");
    expect(d.plans.every((p) => p.householdId === "hh-existing")).toBe(true);
    expect(d.progress.every((s) => s.householdId === "hh-existing")).toBe(true);
  });

  it("builds a review checklist covering household, balances, each plan and the report", () => {
    const r = pl();
    const c = buildImportChecklist(r.document, {
      source: "ProjectionLab",
      issueCounts: r.report.issueCounts,
    });
    const ids = c.items.map((i) => i.id);
    expect(ids).toContain("household");
    expect(ids).toContain("balances");
    expect(ids).toContain("report");
    expect(ids.filter((i) => i.startsWith("plan:"))).toHaveLength(r.document.plans.length);
    expect(c.items.every((i) => !i.done)).toBe(true);
  });
});
