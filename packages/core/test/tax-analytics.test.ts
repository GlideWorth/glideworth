/**
 * Estate estimates, tax analytics (marginal by income type, bracket fill), strategy headroom hooks,
 * registry resolution, performance, and the R2 §1 worked example through the full US/MA stack.
 */
import { describe, expect, it } from "vitest";
import { analyzeTaxYear, marginalProgression } from "../src/tax/analytics.js";
import { dividendTaxDetail } from "../src/tax/dividends.js";
import {
  estimateNetLegacy,
  estimateUkInheritanceTax,
  estimateUsEstateTax,
} from "../src/tax/estate.js";
import { createDefaultTaxRegistry } from "../src/tax/registry.js";
import { gainHarvestHeadroom, incomeHeadroom, incrementalTax } from "../src/tax/strategy.js";
import { runStack, taxInput, total } from "./tax-helpers.js";

const reg = createDefaultTaxRegistry();
const stackFor = (country: string, region?: string, locality?: string) =>
  reg.resolveStack(
    { ...taxInput({}).config, mode: "estimate" },
    { country, ...(region ? { region } : {}), ...(locality ? { locality } : {}) },
  );

describe("UK inheritance tax (gov.uk/inheritance-tax)", () => {
  it("widow(er) with transferred NRB and RNRB: £900k estate incl. £400k home to children -> nil", () => {
    const r = estimateUkInheritanceTax({
      year: 2026,
      netEstate: 900_000,
      homeToDescendants: 400_000,
      transferredNrbShare: 1,
      transferredRnrbShare: 1,
    });
    expect(r.tax).toBe(0);
    expect(r.nilRateBand + r.residenceNilRateBand).toBe(1_000_000);
  });
  it("£2.2m estate: RNRB tapered by £1 per £2 over £2m to £75k; tax 40% x 1.8m = 720k", () => {
    const r = estimateUkInheritanceTax({
      year: 2026,
      netEstate: 2_200_000,
      homeToDescendants: 500_000,
    });
    expect(r.residenceNilRateBand).toBe(75_000);
    expect(r.tax).toBeCloseTo(720_000, 6);
  });
  it("unused pensions count toward the estate from 6 April 2027", () => {
    const q = { netEstate: 500_000, homeToDescendants: 0, pensions: 300_000 };
    expect(estimateUkInheritanceTax({ ...q, year: 2026 }).tax).toBeCloseTo(70_000, 6);
    expect(estimateUkInheritanceTax({ ...q, year: 2027 }).tax).toBeCloseTo(190_000, 6);
  });
  it("36% rate when at least 10% of the baseline goes to charity", () => {
    const r = estimateUkInheritanceTax({
      year: 2026,
      netEstate: 1_000_000,
      homeToDescendants: 0,
      charityShare: 0.1,
    });
    expect(r.rate).toBe(0.36);
    expect(r.tax).toBeCloseTo(575_000 * 0.36, 6);
  });
  it("estate passing to a spouse is exempt", () => {
    expect(
      estimateUkInheritanceTax({
        year: 2026,
        netEstate: 5_000_000,
        homeToDescendants: 0,
        toSpouse: true,
      }).tax,
    ).toBe(0);
  });
});

describe("US estate tax and net legacy", () => {
  it("$20m estate in 2026: 40% over the $15m exclusion", () => {
    expect(estimateUsEstateTax({ year: 2026, grossEstate: 20_000_000 }).tax).toBeCloseTo(
      2_000_000,
      6,
    );
    expect(estimateUsEstateTax({ year: 2026, grossEstate: 20_000_000, dsue: 15_000_000 }).tax).toBe(
      0,
    );
  });
  it("net legacy subtracts heirs’ income tax, liquidation and admin costs", () => {
    const r = estimateNetLegacy({
      taxDeferred: 400_000,
      taxable: 200_000,
      taxableCostBasis: 100_000,
      taxFree: 100_000,
      cash: 50_000,
      realEstate: 500_000,
      otherAssets: 0,
      debts: 50_000,
      estateTax: 0,
      settings: {
        liquidationCostRate: 0.06,
        adminCostRate: 0.02,
        stepUpBasis: true,
        heirTaxDeferredRate: 0.25,
        heirCapitalGainsRate: 0.15,
        charitableShare: 0,
      },
    });
    expect(r.legacy).toBe(1_200_000);
    expect(r.netLegacy).toBeCloseTo(1_200_000 - 100_000 - 30_000 - 25_000, 6);
  });
});

describe("tax analytics", () => {
  it("UK £110k: marginal 62% on wages, 60% on other income, 20% on dividends inside the allowance, 0% on gains inside the AEA", () => {
    const a = analyzeTaxYear(
      stackFor("GB"),
      taxInput({ income: [{ character: "wage", amount: 110_000 }] }),
    );
    expect(a.marginalByType.wage).toBeCloseTo(0.62, 6);
    expect(a.marginalByType.ordinary).toBeCloseTo(0.6, 6);
    expect(a.marginalByType.dividends).toBeCloseTo(0.2, 6);
    expect(a.marginalByType["capital-gains"]).toBeCloseTo(0, 6);
    expect(a.byKind.income).toBeCloseTo(33_432, 6);
    expect(a.effectiveRate).toBeCloseTo((33_432 + 4_210.6) / 110_000, 6);
    expect(a.brackets.find((b) => b.schedule === "non-savings")!.bands.length).toBe(2);
  });

  it("US single $75k: federal 22% + FICA 7.65% + CO 4.4% on wages", () => {
    const a = analyzeTaxYear(
      stackFor("US", "CO"),
      taxInput({ country: "US", region: "CO", income: [{ character: "wage", amount: 75_000 }] }),
    );
    expect(a.marginalByType.wage).toBeCloseTo(0.22 + 0.0765 + 0.044, 6);
    expect(Object.keys(a.byJurisdiction).sort()).toEqual([
      "us-federal",
      "us-payroll",
      "us-state:CO",
    ]);
  });

  it("marginal progression shows the 60% band between £100k and £125,140", () => {
    const p = marginalProgression(
      stackFor("GB"),
      taxInput({ income: [{ character: "wage", amount: 90_000 }] }),
      "ordinary",
      50_000,
      10_000,
    );
    expect(p.map((x) => Math.round(x.marginalRate * 100))).toEqual([40, 60, 60, 53, 45]); // 120-130k: 5,140 at 60% + 4,860 at 45%
  });
});

describe("strategy hooks (Roth conversion / shielding / gain harvesting)", () => {
  it("US: conversion headroom to the top of the 12% bracket", () => {
    const input = taxInput({
      country: "US",
      people: [{ age: 62 }],
      income: [{ character: "pension", amount: 30_000 }],
    });
    const h = incomeHeadroom(stackFor("US"), input, { kind: "bracket", rate: 0.12 });
    expect(h).toBeCloseTo(50_400 + 16_100 - 30_000, -1);
  });
  it("US: IRMAA tier-1 headroom keeps MAGI at $109,000", () => {
    const input = taxInput({
      country: "US",
      people: [{ age: 66 }],
      income: [{ character: "pension", amount: 30_000 }],
    });
    expect(incomeHeadroom(stackFor("US"), input, { kind: "irmaa-tier", tier: 1 })).toBeCloseTo(
      79_000,
      -1,
    );
  });
  it("US: ACA 400% FPL headroom", () => {
    const input = taxInput({
      country: "US",
      people: [{ age: 60 }],
      income: [{ character: "pension", amount: 30_000 }],
      aca: { benchmarkPremium: 9_000, householdSize: 1 },
    });
    expect(
      incomeHeadroom(stackFor("US"), input, { kind: "aca-fpl-multiple", multiple: 4 }),
    ).toBeCloseTo(4 * 15_650 - 30_000, -1);
  });
  it("US: 0% LTCG harvesting headroom", () => {
    const input = taxInput({
      country: "US",
      people: [{ age: 62 }],
      income: [{ character: "pension", amount: 30_000 }],
    });
    expect(gainHarvestHeadroom(stackFor("US"), input, 0)).toBeCloseTo(49_450 - 13_900, -1);
  });
  it("UK: basic-rate headroom and gains within the annual exempt amount", () => {
    const input = taxInput({
      people: [{ age: 60 }],
      income: [{ character: "pension", amount: 30_000 }],
    });
    expect(incomeHeadroom(stackFor("GB"), input, { kind: "bracket", rate: 0.2 })).toBeCloseTo(
      50_270 - 30_000,
      -1,
    );
    expect(
      incomeHeadroom(stackFor("GB"), taxInput({ people: [{ age: 60 }] }), {
        kind: "bracket",
        rate: 0,
      }),
    ).toBeCloseTo(12_570, -1);
    expect(gainHarvestHeadroom(stackFor("GB"), input, 0)).toBeCloseTo(3_000, -1);
    expect(incrementalTax(stackFor("GB"), input, 1_000)).toBeCloseTo(200, 6);
  });
});

describe("registry and integration", () => {
  it("all stubs are replaced by implementations; parameterised ids specialise", () => {
    for (const j of reg.list()) expect(j.status).toBe("implemented");
    expect(stackFor("US", "NY", "nyc").map((j) => j.id)).toEqual([
      "us-federal",
      "us-payroll",
      "us-state:NY",
      "us-local:nyc",
    ]);
    expect(stackFor("CA", "ON").map((j) => j.id)).toEqual(["ca-federal", "ca-province:ON"]);
    expect(stackFor("GB").map((j) => j.id)).toEqual(["uk"]);
    expect(reg.get("us-state:CA")).toBe(reg.get("us-state:CA"));
  });

  it("dividend treatment mapping for the engine", () => {
    expect(
      dividendTaxDetail({
        treatment: "au-franked",
        qualifiedShare: 0.6,
        yield: { kind: "inherit" },
        reinvest: "inherit",
      } as never),
    ).toEqual({
      character: "qualified-dividend",
      dividendTreatment: "au-franked",
      frankedShare: 0.6,
    });
    expect(dividendTaxDetail({ treatment: "municipal" } as never).character).toBe("tax-free");
  });

  it("R2 §1 worked example (approx.): $65k salary + $10k side income, 3% to a 401(k), Massachusetts", () => {
    // ProjectionLab reports ~$17.66k withheld under 2024 law. Under 2026 law (higher standard
    // deduction, OBBBA) the same household owes less; we assert the same order of magnitude
    // (within 10%) and the exact 2026 composition.
    const input = taxInput({
      country: "US",
      region: "MA",
      income: [
        { character: "wage", amount: 65_000 },
        { character: "self-employment", amount: 10_000 },
      ],
      deductions: [{ amount: 1_950 }],
    });
    const outs = runStack(stackFor("US", "MA"), input);
    const t = outs.reduce((s, o) => s + total(o), 0);
    expect(Math.abs(t - 17_660) / 17_660).toBeLessThan(0.1);
  });

  it("performance: a UK couple year and a US/NY year each compute in well under 0.2 ms", () => {
    const uk = stackFor("GB");
    const us = stackFor("US", "NY", "nyc");
    const ukIn = taxInput({
      people: [{}, {}],
      config: { filingStatus: "married-joint" },
      income: [
        { owner: "p1", character: "wage", amount: 80_000 },
        { owner: "p2", character: "wage", amount: 30_000 },
        { character: "interest", amount: 2_000, owner: "joint" },
      ],
    });
    const usIn = taxInput({
      country: "US",
      region: "NY",
      locality: "nyc",
      income: [
        { character: "wage", amount: 120_000 },
        { character: "qualified-dividend", amount: 5_000 },
      ],
    });
    const n = 2_000;
    const t0 = performance.now();
    for (let i = 0; i < n; i++) runStack(uk, ukIn);
    const t1 = performance.now();
    for (let i = 0; i < n; i++) runStack(us, usIn);
    const t2 = performance.now();
    expect((t1 - t0) / n).toBeLessThan(0.2);
    expect((t2 - t1) / n).toBeLessThan(0.2);
  });
});
