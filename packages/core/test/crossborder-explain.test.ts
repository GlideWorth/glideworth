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

function household(country = "GB", people?: unknown[]) {
  return SimulationInput.parse({
    household: {
      id: "h",
      name: "Synthetic household",
      planningMode: "individual",
      people: people ?? [
        { id: "me", name: "Alex", role: "primary", birthMonth: "1980-03", citizenships: ["GB"] },
      ],
      location: country === "GB" ? { country: "GB", region: "ENG" } : { country },
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

describe("explainItemTaxation", () => {
  it("UK rental flat while living in the UAE: UK taxes the rent at source, the UAE taxes nothing, treaty Art. 6 cited", () => {
    const input = household("AE");
    const e = explainItemTaxation(input, "flat", 2028);
    expect(e.kind).toBe("realAsset");
    expect(e.country).toBe("GB");
    expect(e.residence).toBe("AE");
    const rent = e.treatments.find((t) => t.category === "rental")!;
    expect(rent.sourceTaxes).toBe(true);
    expect(rent.treaty?.name).toMatch(/UK-UAE/);
    expect(rent.steps.join(" ")).toMatch(/Art\. 6/);
    expect(e.warnings).toEqual([]);
    expect(e.summary).toMatch(/United Kingdom taxes the rent/);
  });

  it("UK pension while living in the UAE: residence-only under the treaty, so the UK does not tax it", () => {
    const e = explainItemTaxation(household("AE"), "sipp", 2028);
    const p = e.treatments.find((t) => t.category === "private-pension")!;
    expect(p.sourceTaxes).toBe(false);
    expect(p.wrapper?.recognised).toBe(true);
  });

  it("an unknown treaty pair and an unrecognised foreign wrapper are warnings", () => {
    const input = household("NZ");
    const isa = explainItemTaxation(input, "isa", 2028);
    expect(isa.warnings.some((w) => /No New Zealand-United Kingdom treaty/.test(w))).toBe(true);
    expect(isa.warnings.some((w) => /does not recognise/.test(w))).toBe(true);
  });

  it("US citizens abroad get the citizenship note; debts are explained as untaxed; unknown ids throw", () => {
    const input = household("GB", [
      { id: "me", name: "Jo", role: "primary", birthMonth: "1980-03", citizenships: ["US"] },
    ]);
    expect(explainItemTaxation(input, "isa", 2028).citizenship).toMatch(/US/);
    expect(explainItemTaxation(input, "car", 2028).summary).toMatch(/not taxed/);
    expect(() => explainItemTaxation(input, "nope", 2028)).toThrow(/no account/);
  });

  it("domestic items are taxed only at home", () => {
    const input = household();
    const e = explainItemTaxation(input, "isa", 2028);
    expect(e.treatments.every((t) => t.residence === "GB" && t.source === "GB")).toBe(true);
    expect(e.summary).toMatch(/taxed only in United Kingdom/);
  });
});

describe("taxByCountry and crossBorderItems", () => {
  it("single-country plans report residence tax of the home country only", () => {
    const input = household();
    input.plan.income = [];
    const r = simulate(input);
    const t = taxByCountry(r, "real", "GB");
    expect(t.crossBorder).toBe(false);
    expect(t.lifetime.length).toBeGreaterThan(0);
    expect(new Set(t.lifetime.map((x) => `${x.country}|${x.basis}`))).toEqual(
      new Set(["GB|residence"]),
    );
  });

  it("a UAE resident with UK items pays source tax in the UK; the foreign items are listed", () => {
    const input = household("AE");
    const r = simulate(input);
    const t = taxByCountry(r, "real", "GB");
    expect(t.crossBorder).toBe(true);
    expect(t.lifetime.some((x) => x.country === "GB" && x.basis === "source")).toBe(true);
    const total = t.lifetime.reduce((s, x) => s + x.amount, 0);
    expect(total).toBeCloseTo(r.summary.lifetimeTaxesReal, 0);
    const items = crossBorderItems(input).map((i) => i.id);
    expect(items.sort()).toEqual(["flat", "isa", "sipp"]);
  });

  it("simplifications list the general caveats then each country", () => {
    expect(CROSS_BORDER_SIMPLIFICATIONS.some((s) => /statutory residence/.test(s))).toBe(true);
    const list = crossBorderSimplificationsFor(["GB", "AE"]);
    expect(list.some((s) => s.startsWith("United Kingdom:"))).toBe(true);
    expect(list.some((s) => s.startsWith("United Arab Emirates:"))).toBe(true);
  });
});
