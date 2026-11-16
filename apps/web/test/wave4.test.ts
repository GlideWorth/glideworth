import { ACCOUNT_TYPE_INFO, type Household } from "@glideworth/core";
import { createUkSampleDocument } from "@glideworth/core/samples";
import { describe, expect, it } from "vitest";
import { measureOfRef } from "../src/features/builder/builder-model";
import { foreignCurrencies, hasPair } from "../src/features/currency/fx";
import { describeRejection } from "../src/features/plan-editor/state/sync";
import { buildPlanFromTemplate } from "../src/features/plans/templates";
import { describeAction } from "../src/features/settings/people-section";
import { resolveStack } from "../src/features/taxes/tax-notes";
import { ApiRequestError } from "../src/lib/api";
import {
  COUNTRY_LIST,
  groupedAccountTypes,
  planSettingsFor,
  simplificationsFor,
} from "../src/lib/countries";
import { financesInBase, fxRateToBase, toBase } from "../src/lib/fx-math";

const household = (country: string, region?: string): Household =>
  ({
    ...createUkSampleDocument().household,
    location: { country, ...(region ? { region } : {}) },
  }) as Household;

describe("countries come from core", () => {
  it("offers every supported country, with regions where tax depends on them", () => {
    expect(COUNTRY_LIST.map((c) => c.code)).toEqual([
      "GB",
      "US",
      "CA",
      "AU",
      "DE",
      "NL",
      "FR",
      "ES",
      "IL",
      "IE",
      "NZ",
      "AE",
      "XX",
    ]);
    for (const c of ["GB", "US", "CA", "ES"])
      expect(COUNTRY_LIST.find((x) => x.code === c)?.regionAffectsTax).toBe(true);
    expect(COUNTRY_LIST.find((x) => x.code === "US")!.regions!.length).toBeGreaterThan(50);
  });
  it("a UK household gets the UK tax stack, the GB default history and the April tax year", () => {
    const d = planSettingsFor(household("GB", "ENG"));
    expect(d.tax?.mode).toBe("estimate");
    expect(d.monteCarlo?.dataset).toBe("us-1928");
    expect(d.assumptions?.yearAlignment).toEqual({ kind: "fiscal", startMonth: 4 });
    const ctx = { household: household("GB", "ENG"), finances: createUkSampleDocument().finances };
    const plan = buildPlanFromTemplate("work-save-retire", ctx, { id: "p", name: "P" });
    expect(plan.tax.mode).toBe("estimate");
    expect(plan.monteCarlo.dataset).toBe("us-1928");
    expect(resolveStack(plan.tax, ctx.household.location)).toMatchObject({ ok: true, ids: ["uk"] });
  });
  it("each other supported country gets its own estimate", () => {
    for (const [c, id] of [
      ["DE", "de"],
      ["NL", "nl"],
      ["FR", "fr"],
      ["IL", "il"],
      ["IE", "ie"],
      ["NZ", "nz"],
    ] as const) {
      const h = household(c);
      const d = planSettingsFor(h);
      expect(d.tax?.mode, c).toBe("estimate");
      expect(resolveStack({ mode: "estimate", jurisdictions: [] }, h.location)).toMatchObject({
        ok: true,
        ids: [id],
      });
      expect(simplificationsFor(id).length, c).toBeGreaterThan(0);
    }
    expect(
      resolveStack({ mode: "estimate", jurisdictions: [] }, { country: "ES", region: "MD" }),
    ).toMatchObject({
      ok: true,
      ids: ["es:MD"],
    });
    expect(resolveStack({ mode: "estimate", jurisdictions: [] }, { country: "XX" }).ok).toBe(false);
  });
  it("groups account types by country with the household first, then any-country types", () => {
    const g = groupedAccountTypes("FR");
    expect(g[0]!.country).toBe("FR");
    expect(g[0]!.types).toEqual(expect.arrayContaining(["fr-pea", "fr-assurance-vie", "fr-per"]));
    expect(g.at(-1)!.country).toBeNull();
    const all = g.flatMap((x) => x.types);
    for (const t of [
      "de-bav",
      "de-riester",
      "de-ruerup",
      "nl-pension",
      "es-plan-pensiones",
      "il-pension",
      "il-keren-hishtalmut",
      "ie-pension",
      "nz-kiwisaver",
    ])
      expect(all).toContain(t);
    expect(new Set(all).size).toBe(Object.keys(ACCOUNT_TYPE_INFO).length);
  });
});

describe("multi-currency helpers", () => {
  const rates = [{ from: "USD", to: "GBP", rate: 0.8, annualDrift: 0 }];
  it("converts through a direct or an inverse pair", () => {
    expect(fxRateToBase("USD", "GBP", rates)).toBe(0.8);
    expect(fxRateToBase("GBP", "USD", rates)).toBeCloseTo(1.25, 10);
    expect(fxRateToBase(undefined, "GBP", rates)).toBe(1);
    expect(fxRateToBase("EUR", "GBP", rates)).toBeNull();
    expect(toBase(100, "USD", "GBP", rates)).toBe(80);
    expect(hasPair(rates, "USD", "GBP")).toBe(true);
  });
  it("totals current finances in the base currency", () => {
    const doc = createUkSampleDocument();
    const fin = {
      ...doc.finances,
      fxRates: rates,
      accounts: [{ ...doc.finances.accounts[0]!, balance: 1000, currency: "USD" }],
    };
    expect(financesInBase(fin, "GBP").accounts[0]!.balance).toBe(800);
    expect(foreignCurrencies({ household: doc.household, finances: fin })).toEqual(["USD"]);
  });
});

describe("server refusals are explained where the edit is", () => {
  it("names the item a validation issue points at", () => {
    const plan = { income: [{ name: "Salary", amount: { value: -5 } }] };
    const e = new ApiRequestError(400, "VALIDATION", "request validation failed", [
      { path: ["income", 0, "amount", "value"], message: "amount must not be negative" },
    ]);
    const r = describeRejection(e, plan);
    expect(r.issues[0]).toMatchObject({
      label: "income › Salary › amount › value",
      message: "amount must not be negative",
    });
  });
  it("explains reserved keys and view-only roles", () => {
    expect(
      describeRejection(new ApiRequestError(400, "INVALID_TOKEN", "unsafe key __proto__"), {})
        .issues[0]!.label,
    ).toBe("Reserved name");
    expect(
      describeRejection(new ApiRequestError(403, "FORBIDDEN", "forbidden"), {}).issues[0]!.message,
    ).toMatch(/view-only/);
  });
});

describe("small labels", () => {
  it("audit actions read as sentences", () => {
    expect(describeAction("PATCH /api/v1/plans/:id/expenses/:itemId")).toBe(
      "Changed plans › expenses",
    );
    expect(describeAction("mcp:apply_change_set")).toBe("MCP tool apply change set");
  });
  it("custom chart series know their measure", () => {
    expect(measureOfRef("metric:netWorth")).toBe("stock");
    expect(measureOfRef("metric:spending")).toBe("flow");
    expect(measureOfRef("acct:a:closing")).toBe("stock");
    expect(measureOfRef("acct:a:contributions")).toBe("flow");
    expect(measureOfRef("taxkind:income")).toBe("flow");
  });
});
