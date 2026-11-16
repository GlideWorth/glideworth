/** "How is this item taxed and why", tax by country/basis and the cross-border simplifications list. */
import { describe, expect, it } from "vitest";
import { simulate } from "../src/engine/simulate.js";
import { SimulationInput } from "../src/engine/types.js";
import {
  CROSS_BORDER_SIMPLIFICATIONS,
  crossBorderItems,
  crossBorderSimplificationsFor,
  explainItemTaxation,
  taxByCountry,
} from "../src/insights/crossborder-explain.js";

function mover(residency: unknown[] = [], people?: unknown[]) {
  return SimulationInput.parse({
    household: {
      id: "h",
      name: "Synthetic movers",
      planningMode: "individual",
      people: people ?? [
        { id: "me", name: "Alex", role: "primary", birthMonth: "1980-03", citizenships: ["GB"] },
      ],
      location: { country: "GB", region: "ENG" },
      currency: "GBP",
      locale: "en-GB",
    },
    finances: {
      asOf: "2026-04",
      accounts: [
        { id: "isa", name: "ISA", type: "uk-isa", owner: "me", balance: 40_000 },
        { id: "sipp", name: "SIPP", type: "uk-sipp", owner: "me", balance: 90_000 },
        { id: "debt-free", name: "Cash", type: "savings", owner: "me", balance: 10_000 },
      ],
      realAssets: [
        {
          id: "flat",
          name: "Flat",
          type: "rental-property",
          owner: "me",
          currentValue: 300_000,
          country: "GB",
          acquiredOn: "2012-06",
          behaviour: {
            rental: {
              enabled: true,
              income: { kind: "amountPerMonth", amount: { value: 1_200, basis: "real" } },
            },
          },
        },
      ],
      debts: [
        {
          id: "car",
          name: "Car loan",
          type: "auto-loan",
          owner: "me",
          balance: 5_000,
          interest: { apr: 0.06, method: "compound", compounding: "monthly" },
          monthlyPayment: { value: 300, basis: "nominal" },
        },
      ],
      fxRates: [{ from: "AED", to: "GBP", rate: 0.21, annualDrift: 0 }],
    },
    plan: {
      id: "p",
      householdId: "h",
      name: "Plan",
      tax: { mode: "estimate" },
      residency,
      income: [
        {
          id: "pay",
          name: "Dubai salary",
          type: "salary",
          owner: "me",
          amount: { value: 30_000, basis: "real" },
          frequency: "monthly",
          currency: "AED",
          country: "AE",
          range: {
            start: { kind: "date", date: "2027-01" },
            end: { kind: "date", date: "2030-01" },
          },
        },
      ],
      assumptions: {
        yearAlignment: { kind: "fiscal", startMonth: 4 },
        end: { kind: "ref", ref: { kind: "date", date: "2034-04" } },
      },
    },
    options: { trace: "summary" },
  });
}

const toUae = {
  id: "move-ae",
  from: { kind: "date", date: "2027-01" },
  location: { country: "AE" },
};

describe("explainItemTaxation", () => {
  it("UK rental flat while living in the UAE: UK taxes the rent at source, the UAE taxes nothing, treaty Art. 6 cited", () => {
    const input = mover([toUae]);
    const e = explainItemTaxation(input, "flat", 2028);
    expect(e.kind).toBe("realAsset");
    expect(e.country).toBe("GB");
    expect(e.residence).toEqual([{ personId: "me", country: "AE", months: 12 }]);
    const rent = e.treatments.find((t) => t.category === "rental")!;
    expect(rent.sourceTaxes).toBe(true);
    expect(rent.treaty?.name).toMatch(/UK-UAE/);
    expect(rent.steps.join(" ")).toMatch(/Art\. 6/);
    expect(e.warnings).toEqual([]);
    expect(e.summary).toMatch(/United Kingdom taxes the rent/);
  });

  it("UK pension while living in the UAE: residence-only under the treaty, so the UK does not tax it", () => {
    const e = explainItemTaxation(mover([toUae]), "sipp", 2028);
    const p = e.treatments.find((t) => t.category === "private-pension")!;
    expect(p.sourceTaxes).toBe(false);
    expect(p.wrapper?.recognised).toBe(true);
  });

  it("a split year reports both residences with their months", () => {
    const e = explainItemTaxation(mover([toUae]), "flat", 2027);
    // Fiscal year 2026/27 (labelled 2026) has Apr-Dec in GB; 2027 is Apr 2027-Mar 2028 entirely in AE.
    const e2026 = explainItemTaxation(mover([toUae]), "flat", 2026);
    expect(e.residence.map((r) => r.country)).toEqual(["AE"]);
    expect(e2026.residence.map((r) => r.country).sort()).toEqual(["AE", "GB"]);
    expect(e2026.residence.reduce((s, r) => s + r.months, 0)).toBe(12);
  });

  it("with a projection result, residences come from the result", () => {
    const input = mover([toUae]);
    const result = simulate(input);
    const e = explainItemTaxation(input, "flat", result.periods[1]!.year, result);
    expect(e.residence[0]!.country).toBe("AE");
  });

  it("an unknown treaty pair and an unrecognised foreign wrapper are warnings", () => {
    const input = mover([
      { id: "nz", from: { kind: "date", date: "2027-01" }, location: { country: "NZ" } },
    ]);
    const isa = explainItemTaxation(input, "isa", 2028);
    expect(isa.warnings.some((w) => /No New Zealand-United Kingdom treaty/.test(w))).toBe(true);
    expect(isa.warnings.some((w) => /does not recognise/.test(w))).toBe(true);
  });

  it("US citizens abroad get the citizenship note; debts are explained as untaxed; unknown ids throw", () => {
    const input = mover(
      [],
      [{ id: "me", name: "Jo", role: "primary", birthMonth: "1980-03", citizenships: ["US"] }],
    );
    expect(explainItemTaxation(input, "isa", 2028).citizenship).toMatch(/US/);
    expect(explainItemTaxation(input, "car", 2028).summary).toMatch(/not taxed/);
    expect(() => explainItemTaxation(input, "nope", 2028)).toThrow(/no account/);
  });

  it("a never-moved household: domestic items are taxed only at home", () => {
    const input = mover([]);
    const e = explainItemTaxation(input, "isa", 2028);
    expect(e.treatments.every((t) => t.residence === "GB" && t.source === "GB")).toBe(true);
    expect(e.summary).toMatch(/taxed only in United Kingdom/);
  });
});

describe("taxByCountry and crossBorderItems", () => {
  it("single-country plans report residence tax of the home country only", () => {
    const input = mover([]);
    input.plan.income = [];
    const r = simulate(input);
    const t = taxByCountry(r, "real", "GB");
    expect(t.crossBorder).toBe(false);
    expect(t.lifetime.length).toBeGreaterThan(0);
    expect(new Set(t.lifetime.map((x) => `${x.country}|${x.basis}`))).toEqual(
      new Set(["GB|residence"]),
    );
  });

  it("a move produces source tax in the UK and lists the foreign items", () => {
    const input = mover([toUae]);
    const r = simulate(input);
    const t = taxByCountry(r, "real", "GB");
    expect(t.crossBorder).toBe(true);
    expect(t.lifetime.some((x) => x.country === "GB" && x.basis === "source")).toBe(true);
    const total = t.lifetime.reduce((s, x) => s + x.amount, 0);
    expect(total).toBeCloseTo(r.summary.lifetimeTaxesReal, 0);
    const items = crossBorderItems(input, r).map((i) => i.id);
    expect(items).toContain("flat");
    expect(items).toContain("pay");
  });

  it("simplifications list the general caveats then each country", () => {
    expect(CROSS_BORDER_SIMPLIFICATIONS.some((s) => /statutory residence/.test(s))).toBe(true);
    const list = crossBorderSimplificationsFor(["GB", "AE"]);
    expect(list.some((s) => s.startsWith("United Kingdom:"))).toBe(true);
    expect(list.some((s) => s.startsWith("United Arab Emirates:"))).toBe(true);
  });
});

describe("plan diff of residency changes", () => {
  it("reads as moves, not JSON", async () => {
    const { diffPlans } = await import("../src/insights/diff.js");
    const { applyPlanPatch } = await import("../src/insights/patch.js");
    const { relocationScenario } = await import("../src/insights/crossborder.js");
    const input = mover([]);
    const t = relocationScenario(input, {
      to: { country: "AE" },
      month: "2028-01",
      returnMonth: "2031-01",
    });
    const d = diffPlans(input.plan, applyPlanPatch(input.plan, t.patch));
    const text = d.changes.map((c) => c.description).join(" | ");
    expect(text).toMatch(/Everyone moves to United Arab Emirates from/);
    expect(text).toMatch(/moves to United Kingdom/);
    expect(text).not.toMatch(/\{"id"/);
  });
});
