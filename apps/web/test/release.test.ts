import { buildSimulationInput, defaultsForCountry, simulate } from "@glideworth/core";
import { createUkSampleDocument } from "@glideworth/core/samples";
import { importBankFileInto } from "@glideworth/importers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "../src/components/ui/tooltip";
import { buildSankey } from "../src/features/cashflow/sankey";
import {
  DEFAULT_FX_VOLATILITY,
  fxVolatility,
  withFxVolatility,
} from "../src/features/chance/fx-risk";
import { NotificationCentre } from "../src/features/checkins/notification-centre";
import { bankApplyRequest } from "../src/features/import/bank-import";
import { countryDefaults } from "../src/features/plan-editor/state/defaults";
import {
  buildEntityIndex,
  cellValue,
  modeSeries,
  tableColumns,
} from "../src/features/results/model";
import { conv } from "../src/lib/money";
import {
  hasPartialPeriods,
  partialNote,
  periodLabel,
  periodShortLabel,
  periodSpan,
} from "../src/lib/period";

describe("W4-1: bank files are applied as previewed", () => {
  const dayFirst =
    "!Account\nNHousehold Current\nTBank\n^\n!Type:Bank\nD03/02/2026\nT-40.00\nLGroceries\n^\nD04/02/2026\nT-60.00\nLGroceries\n^\n";
  it("a day-first QIF sends its date order to the server", () => {
    const req = bankApplyRequest({
      text: dayFirst,
      format: "qif",
      dateFormat: "DD/MM/YYYY",
      balances: false,
      createMissing: false,
      planId: "uk-plan-main",
      excluded: [],
    });
    expect(req).toMatchObject({ dateFormat: "DD/MM/YYYY", planId: "uk-plan-main", dryRun: false });
    // The browser preview reads the same file with the same option as the server will.
    const o = importBankFileInto(createUkSampleDocument(), dayFirst, { dateFormat: "DD/MM/YYYY" });
    expect(o.summary.range).toEqual({ from: "2026-02-03", to: "2026-02-04" });
  });
  it("detection and OFX files send no date order", () => {
    const base = { text: "", balances: true, createMissing: true, planId: undefined, excluded: [] };
    expect(bankApplyRequest({ ...base, format: "qif", dateFormat: "auto" })).not.toHaveProperty(
      "dateFormat",
    );
    expect(
      bankApplyRequest({ ...base, format: "ofx", dateFormat: "DD/MM/YYYY" }),
    ).not.toHaveProperty("dateFormat");
  });
});

// ------------------------------------------------------------------------------------------------
// Partial plan years, Monte Carlo FX control, country defaults, notification bell
// ------------------------------------------------------------------------------------------------

vi.mock("../src/lib/workspace", async (orig) => ({
  ...(await orig<typeof import("../src/lib/workspace")>()),
  useWorkspace: () => ({ data: { source: "api" } }),
}));
vi.mock("../src/lib/access", () => ({ useAccess: () => ({ canWrite: true, loading: false }) }));
vi.mock("../src/lib/api", async (orig) => {
  const real = await orig<typeof import("../src/lib/api")>();
  return {
    ...real,
    api: { ...real.api, listNotifications: async () => ({ items: [], unread: 0 }) },
  };
});

describe("partial plan years are labelled and can be annualised", () => {
  const doc = createUkSampleDocument();
  const plan = doc.plans[0]!;
  // Start in August so the first period is 5 months under calendar alignment.
  const input = buildSimulationInput(
    {
      ...doc,
      finances: { ...doc.finances, asOf: "2026-08" },
      plans: [
        { ...plan, assumptions: { ...plan.assumptions, yearAlignment: { kind: "calendar" } } },
      ],
    },
    plan.id,
    { trace: "off" },
  );
  const r = simulate(input);
  const first = r.periods[0]!;
  const index = buildEntityIndex(doc, plan);

  it("labels a partial year everywhere with its months", () => {
    expect(first.months).toBe(5);
    expect(hasPartialPeriods(r.periods)).toBe(true);
    expect(periodSpan(first)).toBe("Aug–Dec");
    expect(periodLabel(first)).toBe("2026 (Aug–Dec, 5 months)");
    expect(periodLabel(first, { annualise: true })).toBe("2026 (5 months, annualised)");
    expect(periodShortLabel(first)).toBe("2026*");
    expect(periodShortLabel(r.periods[1]!)).toBe("2027");
    expect(partialNote(r.periods[1]!)).toBeNull();
    expect(partialNote(first)).toMatch(/only 5 months/);
    expect(tableColumns(r, index).find((c) => c.id === "months")?.defaultOn).toBe(true);
  });

  it("annualises flows of a partial year (never balances), in the chart, table and Sankey", () => {
    const spend = conv(first, first.totals.spending, "real", "flow");
    expect(conv(first, first.totals.spending, "real", "flow", { annualise: true })).toBeCloseTo(
      (spend * 12) / 5,
      6,
    );
    expect(conv(first, first.totals.netWorth, "real", "stock", { annualise: true })).toBe(
      conv(first, first.totals.netWorth, "real", "stock"),
    );
    // A full year is unchanged.
    const y2 = r.periods[1]!;
    expect(conv(y2, y2.totals.spending, "real", "flow", { annualise: true })).toBe(
      conv(y2, y2.totals.spending, "real", "flow"),
    );
    const pal = { theme: "light" as const, surface: "#fff", ink: "#000", negative: "#f00" };
    const actual = modeSeries(r, "cashFlow", "real", index, pal);
    const ann = modeSeries(r, "cashFlow", "real", index, pal, { annualise: true });
    const c0 = actual.series.find((s) => s.id === "contributions")!.values[0]!;
    expect(ann.series.find((s) => s.id === "contributions")!.values[0]).toBeCloseTo(
      (c0 * 12) / 5,
      6,
    );
    const col = tableColumns(r, index).find((c) => c.id === "spending")!;
    expect(cellValue(col, first, "real", { annualise: true })).toBeCloseTo((spend * 12) / 5, 6);
    const one = buildSankey(r, 0, 0, "real", "grouped", index, { annualise: true });
    expect(one.totals.spending).toBeCloseTo(
      (buildSankey(r, 0, 0, "real", "grouped", index).totals.spending * 12) / 5,
      4,
    );
    // A range is an actual total: never annualised.
    const range = buildSankey(r, 0, 1, "real", "grouped", index, { annualise: true });
    expect(range.totals.spending).toBeCloseTo(
      buildSankey(r, 0, 1, "real", "grouped", index).totals.spending,
      6,
    );
  });
});

describe("Monte Carlo exchange-rate risk control", () => {
  it("turns sampling on and off per currency, keeping other pairs", () => {
    let fx = withFxVolatility(undefined, "USD", "GBP", DEFAULT_FX_VOLATILITY);
    expect(fx).toEqual({
      pairs: [{ from: "USD", to: "GBP", volatility: DEFAULT_FX_VOLATILITY }],
      correlation: 0,
    });
    fx = withFxVolatility(fx, "EUR", "GBP", 0.07);
    expect(fxVolatility(fx, "EUR", "GBP")).toBe(0.07);
    fx = withFxVolatility(fx, "USD", "GBP", 0.12);
    expect(fx!.pairs).toHaveLength(2);
    expect(fxVolatility(fx, "USD", "GBP")).toBe(0.12);
    fx = withFxVolatility(fx, "USD", "GBP", null);
    fx = withFxVolatility(fx, "EUR", "GBP", null);
    expect(fx).toBeUndefined();
    // A pair quoted base -> foreign is recognised too.
    expect(
      fxVolatility(
        { pairs: [{ from: "GBP", to: "USD", volatility: 0.1 }], correlation: 0 },
        "USD",
        "GBP",
      ),
    ).toBe(0.1);
  });
});

describe("W4-5: the editor’s country defaults come from core", () => {
  it.each(["GB", "US", "CA", "AU", "DE", "NL", "FR", "ES", "IL", "IE", "NZ"])("%s", (c) => {
    const core = defaultsForCountry(c);
    const web = countryDefaults(c);
    expect(web.retirementAge).toBe(core.suggestedRetirementAge);
    expect(web.statePensionAge).toBe(core.statePension?.startAge ?? 67);
    expect(web.statePensionAmount).toBe(core.statePension?.annualAmount ?? null);
    expect(web.preferredSavingsTypes[0]).toBe(
      core.accountTypes.taxFree ??
        core.accountTypes.personalPension ??
        core.accountTypes.workplacePension,
    );
  });
});

describe("the notification bell is always reachable (phones too)", () => {
  it("renders with nothing unread", async () => {
    const qc = new QueryClient();
    render(
      createElement(
        QueryClientProvider,
        { client: qc },
        createElement(TooltipProvider, null, createElement(NotificationCentre)),
      ),
    );
    expect(await screen.findByRole("button", { name: "Notifications" })).toBeTruthy();
  });
});

describe("service worker precache placeholders", () => {
  it("public/sw.js carries the placeholders the build fills (vite.config.ts serviceWorkerManifest)", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const sw = readFileSync(resolve(__dirname, "../public/sw.js"), "utf8");
    const config = readFileSync(resolve(__dirname, "../vite.config.ts"), "utf8");
    for (const token of ["/*__PRECACHE__*/ []", "/*__WARM__*/ []", "/*__BUILD__*/ 'dev'"]) {
      expect(sw).toContain(token);
      expect(config).toContain(token);
    }
    expect(sw).toMatch(/SHELL = \[[^\]]*\.\.\.PRECACHE,?\s*\]/);
  });
});
