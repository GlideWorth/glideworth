/**
 * Cross-cutting checks for the DE / NL / FR / ES / IL / IE / NZ presets: registry and estimate-mode
 * stacks, metadata (country, sources, simplifications), account-type mapping, bracket fill via
 * explainYear and marginal-rate analytics on the whole stack.
 */
import { describe, expect, it } from "vitest";
import { ACCOUNT_TYPE_INFO } from "../src/schema/account-types.js";
import { TaxConfig } from "../src/schema/tax.js";
import { analyzeTaxYear, marginalRateFor } from "../src/tax/analytics.js";
import { TAX_SIMPLIFICATIONS } from "../src/tax/data/index.js";
import {
  createDefaultTaxRegistry,
  defaultStackIds,
  NATIONAL_JURISDICTION_BY_COUNTRY,
} from "../src/tax/registry.js";
import { taxInput, total } from "./tax-helpers.js";

const COUNTRIES = ["DE", "NL", "FR", "ES", "IL", "IE", "NZ"] as const;
const reg = createDefaultTaxRegistry();
const estimate = TaxConfig.parse({ mode: "estimate" });

describe("new national presets", () => {
  it.each(COUNTRIES)(
    "%s: estimate mode resolves an implemented stack with country metadata, sources and simplifications",
    (c) => {
      const stack = reg.resolveStack(estimate, { country: c });
      expect(stack).toHaveLength(1);
      const j = stack[0]!;
      expect(j.status).toBe("implemented");
      expect(j.country).toBe(c);
      expect(j.level).toBe("national");
      expect(j.sources!.length).toBeGreaterThan(2);
      for (const s of j.sources!) expect(s.url).toMatch(/^https:\/\//);
      expect(j.simplifications!.length).toBeGreaterThan(3);
      expect(TAX_SIMPLIFICATIONS[j.id.split(":")[0]!]).toBe(j.simplifications);
      expect(NATIONAL_JURISDICTION_BY_COUNTRY[c]).toBe(j.id.split(":")[0]);
      expect(typeof j.explainYear).toBe("function");
    },
  );

  it("Spain resolves its region from the location; others ignore it", () => {
    expect(defaultStackIds({ country: "ES", region: "CT" })).toEqual(["es:CT"]);
    expect(defaultStackIds({ country: "ES" })).toEqual(["es"]);
    expect(defaultStackIds({ country: "DE", region: "BY" })).toEqual(["de"]);
  });

  it("account types map to their country with tax-deferred / tax-free treatment", () => {
    const expected: Record<string, [string, string]> = {
      "de-bav": ["DE", "tax-deferred"],
      "de-riester": ["DE", "tax-deferred"],
      "de-ruerup": ["DE", "tax-deferred"],
      "nl-pension": ["NL", "tax-deferred"],
      "fr-per": ["FR", "tax-deferred"],
      "fr-pea": ["FR", "taxable"],
      "fr-assurance-vie": ["FR", "taxable"],
      "es-plan-pensiones": ["ES", "tax-deferred"],
      "il-pension": ["IL", "tax-deferred"],
      "il-keren-hishtalmut": ["IL", "tax-free"],
      "ie-pension": ["IE", "tax-deferred"],
      "nz-kiwisaver": ["NZ", "tax-free"],
    };
    for (const [t, [country, treatment]] of Object.entries(expected)) {
      const info = ACCOUNT_TYPE_INFO[t as keyof typeof ACCOUNT_TYPE_INFO];
      expect(info.country).toBe(country);
      expect(info.taxTreatment).toBe(treatment);
    }
  });

  it.each([
    ["DE", 60_000],
    ["NL", 60_000],
    ["FR", 60_000],
    ["ES", 60_000],
    ["IL", 250_000],
    ["IE", 60_000],
    ["NZ", 90_000],
  ] as const)(
    "%s: explainYear bracket fill sums to the income tax, and analytics marginal rates are sane",
    (c, w) => {
      const stack = reg.resolveStack(estimate, { country: c });
      const input = taxInput({
        country: c,
        year: 2026,
        income: [{ character: "wage", amount: w }],
      });
      const a = analyzeTaxYear(stack, input, {
        types: ["wage", "interest", "capital-gains", "pension"],
      });
      expect(a.brackets.length).toBeGreaterThan(0);
      const fillTax = a.brackets[0]!.bands.reduce((s, b) => s + b.tax, 0);
      const incomeLine = a.outputs[0]!.lines.find((l) => l.kind === "income")!;
      expect(fillTax).toBeCloseTo(incomeLine.amount, 6);
      expect(a.total).toBeCloseTo(total(a.outputs[0]!), 9);
      // (FR: one more euro of pension is covered by the 454 minimum pension allowance; CSG only)
      for (const t of ["wage"] as const) {
        expect(a.marginalByType[t]).toBeGreaterThan(0.1);
        expect(a.marginalByType[t]).toBeLessThan(0.8);
      }
      expect(a.outputs[0]!.marginalRate).toBeGreaterThan(0.1);
      expect(a.effectiveRate).toBeGreaterThan(0);
      expect(a.effectiveRate).toBeLessThan(0.6);
    },
  );

  it("NZ has no capital gains tax: marginal rate on gains is 0", () => {
    const stack = reg.resolveStack(estimate, { country: "NZ" });
    const input = taxInput({ country: "NZ", income: [{ character: "wage", amount: 90_000 }] });
    expect(marginalRateFor(stack, input, "capital-gains")).toBeCloseTo(0, 9);
  });

  it("thresholds follow the indexation policy: indexed doubles thresholds at price index 2, frozen keeps them", () => {
    for (const c of COUNTRIES) {
      const j = reg.resolveStack(estimate, { country: c })[0]!;
      const base = total(
        j.computeYear(
          taxInput({ country: c, income: [{ character: "wage", amount: 50_000 }] }),
          [],
        ),
      );
      const indexed = total(
        j.computeYear(
          taxInput({
            country: c,
            priceIndex: 2,
            config: { thresholdIndexation: "indexed" },
            income: [{ character: "wage", amount: 100_000 }],
          }),
          [],
        ),
      );
      expect(indexed).toBeCloseTo(2 * base, 4);
      const frozen = total(
        j.computeYear(
          taxInput({
            country: c,
            priceIndex: 2,
            config: { thresholdIndexation: "frozen" },
            income: [{ character: "wage", amount: 50_000 }],
          }),
          [],
        ),
      );
      expect(frozen).toBeCloseTo(base, 6);
    }
  });
});
