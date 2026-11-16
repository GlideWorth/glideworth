/** Regression tests for QA findings against packages/importers (docs/QA-FINDINGS.md I1, Q6). */
import { buildSimulationInput, simulate, toBasis } from "@glideworth/core";
import { createUkSampleDocument, UK_SAMPLE_PLAN_ID } from "@glideworth/core/samples";
import { describe, expect, it } from "vitest";
import { analyzeCsv, cashFlowTable, presetById, yearByYearTable } from "../src/index.js";

describe("I1: a generic Date/Account/Balance CSV is not labelled with a vendor preset", () => {
  it("is analysed as the generic balances layout", () => {
    const a = analyzeCsv("Account,Balance,Date\nSavings,100,2026-01-01\n", "account-balances");
    expect(a.preset?.id).toBe("generic-balances");
    expect(a.preset?.name).not.toMatch(/monarch/i);
    expect(a.presetCandidates.every((c) => !/monarch/i.test(c.name))).toBe(true);
    expect(a.columns).toMatchObject({ account: "Account", balance: "Balance", date: "Date" });
  });
  it("keeps the old preset id working as an alias", () => {
    expect(presetById("monarch-balances")?.id).toBe("generic-balances");
  });
});

describe("Q6: export ages and today's money", () => {
  const doc = createUkSampleDocument();
  const result = simulate(buildSimulationInput(doc, UK_SAMPLE_PLAN_ID, { trace: "off" }));

  it("labels each year with the age reached in it (60 in the year Sam turns 60)", () => {
    const t = yearByYearTable(result, { labels: { "p-sam": "Sam" } });
    const col = t.columns.findIndex((c) => c.label === "Age (Sam)");
    const row = t.rows.find((r) => r[0] === 2038)!;
    expect(row[col]).toBe(60);
    expect(t.rows.find((r) => r[0] === 2037)![col]).toBe(59);
  });

  it("flows read in today's money exactly as entered; balances use the end-of-year index", () => {
    const t = yearByYearTable(result);
    const exp = t.columns.findIndex((c) => c.key === "expenses");
    const nw = t.columns.findIndex((c) => c.key === "netWorth");
    const row = t.rows.find((r) => r[0] === 2030)!;
    expect(row[exp]).toBeCloseTo(31_600, 2);
    const p = result.periods.find((x) => x.year === 2030)!;
    expect(row[nw]).toBeCloseTo(toBasis(p.totals.netWorth, p, "real", "stock"), 2);
    const cf = cashFlowTable(result);
    const living = cf.columns.findIndex((c) => c.key === "expense:uk-living");
    expect(cf.rows.find((r) => r[0] === 2030)![living]).toBeCloseTo(27_600, 2);
  });
});
