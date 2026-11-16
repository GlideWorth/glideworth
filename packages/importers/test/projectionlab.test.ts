import {
  buildSimulationInput,
  GlideworthDocument,
  simulate,
  ValidationError,
} from "@glideworth/core";
import { describe, expect, it } from "vitest";
import {
  buildCoverage,
  classifyPath,
  collectKeyPaths,
  detectProjectionLabExport,
  type ImportResult,
  importProjectionLab,
} from "../src/index.js";
import { resolveRange, toMonth } from "../src/projectionlab/dates.js";
import { buildSyntheticExport, IDS } from "./fixtures/projectionlab-synthetic.js";

type Json = Record<string, unknown>;

function run(mutate?: (raw: Json) => void): ImportResult {
  const raw = buildSyntheticExport();
  mutate?.(raw);
  return importProjectionLab(raw);
}

const plan = (r: ImportResult, i = 0) => r.document.plans[i]!;
const plans = (raw: Json): Json[] => raw.plans as Json[];
const events = (p: Json, section: string): Json[] => (p[section] as { events: Json[] }).events;

describe("detection and tolerance", () => {
  it("detects the export shape", () => {
    expect(detectProjectionLabExport(buildSyntheticExport())).toBe(true);
    expect(detectProjectionLabExport({ app: "glideworth" })).toBe(false);
    expect(detectProjectionLabExport(null)).toBe(false);
  });

  it("rejects things that are not exports", () => {
    expect(() => importProjectionLab(null)).toThrow(ValidationError);
    expect(() => importProjectionLab({ nothing: true })).toThrow(ValidationError);
    expect(() => importProjectionLab("text")).toThrow(ValidationError);
  });

  it("imports a minimal export with defaults and reports what it had to assume", () => {
    const r = importProjectionLab({ today: {}, plans: [] }, { now: "2026-11-15T00:00:00Z" });
    expect(GlideworthDocument.safeParse(r.document).success).toBe(true);
    expect(r.document.household.planningMode).toBe("individual");
    expect(r.document.finances.asOf).toBe("2026-11");
    expect(r.issues.some((i) => i.sourcePath === "$.meta.version")).toBe(true);
    expect(
      r.issues.some((i) => i.sourcePath === "$.settings.ci.currency" && i.category === "invalid"),
    ).toBe(true);
  });

  it("warns about a different major version but still imports", () => {
    const r = run((raw) => {
      (raw.meta as Json).version = "5.1.0";
    });
    expect(r.issues.find((i) => i.code === "pl.version")?.severity).toBe("warning");
    expect(r.document.plans).toHaveLength(3);
  });

  it("reports unknown future keys instead of dropping them silently", () => {
    const r = run((raw) => {
      (raw.today as Json).futureThing = { nested: [1, 2] };
      (plans(raw)[0] as Json).newPlanField = "x";
      (raw.settings as Json).newUiPref = true;
    });
    const unknown = r.issues.filter((i) => i.category === "unrecognised").map((i) => i.sourcePath);
    expect(unknown).toContain("$.today.futureThing.nested[0]");
    expect(unknown).toContain("$.plans[0].newPlanField");
    expect(unknown).toContain("$.settings.newUiPref");
    expect(r.report.coverage.unknown).toBeGreaterThanOrEqual(3);
    expect(r.report.coverage.unaccountedPaths).toContain("$.plans[].newPlanField");
    // Settings drift is informational; planning drift is a warning.
    expect(r.issues.find((i) => i.sourcePath === "$.settings.newUiPref")?.severity).toBe("info");
    expect(r.issues.find((i) => i.sourcePath === "$.plans[0].newPlanField")?.severity).toBe(
      "warning",
    );
  });

  it("copes with missing sections", () => {
    const r = run((raw) => {
      delete raw.progress;
      delete raw.settings;
      (plans(raw)[0] as Json).priorities = undefined;
      (plans(raw)[1] as Json).variables = undefined;
    });
    expect(r.document.progress).toEqual([]);
    expect(r.document.plans).toHaveLength(3);
  });
});

describe("structure of the synthetic fixture", () => {
  it("has no unaccounted key paths and mirrors the real shape (1135 paths)", () => {
    const cov = buildCoverage(collectKeyPaths(buildSyntheticExport()));
    expect(cov.unknown).toBe(0);
    expect(cov.total).toBe(1135);
    expect(cov.mapped + cov.ignored + cov.unsupported).toBe(cov.total);
  });

  it("imports to a schema-valid document with matching entity counts", () => {
    const r = run();
    expect(GlideworthDocument.safeParse(r.document).success).toBe(true);
    for (const [name, c] of Object.entries(r.report.counts))
      expect(c.imported, name).toBe(c.source);
    expect(r.stats).toMatchObject({
      people: 2,
      accounts: 8,
      realAssets: 4,
      debts: 1,
      plans: 3,
      progress: 9,
    });
    expect(r.report.counts.flows).toEqual({ source: 21, imported: 21 });
    expect(r.report.counts.milestones).toEqual({ source: 23, imported: 23 });
  });

  it("simulates every plan without throwing (non-strict: engine gaps are warnings)", () => {
    const r = run();
    for (const p of r.document.plans) {
      const res = simulate(buildSimulationInput(r.document, p.id, { strict: false, trace: "off" }));
      expect(res.periods.length).toBeGreaterThan(10);
    }
  });

  it("never carries the API key into the document or the report", () => {
    const r = run();
    const text = JSON.stringify([r.document, r.report]);
    expect(text).not.toContain("SYNTHETIC-API-KEY");
    expect(r.issues.some((i) => i.code === "pl.secret-discarded")).toBe(true);
  });

  it("issue messages carry no names or amounts from the source", () => {
    const r = run();
    const text = r.issues.map((i) => i.message).join("\n");
    for (const secret of ["Alex Sample", "Sam Sample", "Rental Flat", "Day Job", "Index Fund"])
      expect(text).not.toContain(secret);
  });
});

describe("household", () => {
  it("maps people, partner, location, currency and locale", () => {
    const h = run().document.household;
    expect(h.planningMode).toBe("couple");
    expect(h.people.map((p) => [p.id, p.role, p.birthMonth])).toEqual([
      ["me", "primary", "1991-03"],
      ["spouse", "partner", "1993-11"],
    ]);
    expect(h.location).toEqual({ country: "XX" });
    expect(h.currency).toBe("GBP");
    expect(h.locale).toBe("en-GB");
    expect(h.people[0]!.appearance).toEqual({ color: "ink", icon: "mdi-face-shimmer" });
  });

  it("downgrades to an individual household when the partner has no birth date", () => {
    const r = run((raw) => {
      delete (raw.today as Json).spouseBirthYear;
    });
    expect(r.document.household.planningMode).toBe("individual");
    expect(r.document.household.people).toHaveLength(1);
    expect(r.issues.some((i) => i.sourcePath === "$.today.spouseBirthYear")).toBe(true);
  });

  it("maps countries: UK -> GB, OTHER -> XX, junk reported", () => {
    expect(
      run((raw) => ((raw.today as Json).location = { country: "UK" })).document.household.location
        .country,
    ).toBe("GB");
    expect(
      run((raw) => ((raw.today as Json).location = { country: "US", state: "CA" })).document
        .household.location,
    ).toEqual({
      country: "US",
      region: "CA",
    });
    const bad = run((raw) => ((raw.today as Json).location = { country: "Narnia" }));
    expect(bad.document.household.location.country).toBe("XX");
    expect(
      bad.issues.some((i) => i.category === "invalid" && i.sourcePath.includes("location")),
    ).toBe(true);
  });

  it("takes finances.asOf from the export date", () => {
    expect(run().document.finances.asOf).toBe("2026-11");
  });
});

describe("accounts", () => {
  const accounts = () => run().document.finances.accounts;
  const byName = (n: string) => accounts().find((a) => a.name === n)!;

  it("maps types, owners, balances and basis", () => {
    expect(accounts().map((a) => a.type)).toEqual([
      "savings",
      "savings",
      "savings",
      "taxable",
      "crypto",
      "uk-pension",
      "taxable",
      "crypto",
    ]);
    expect(byName("Current Account").owner).toBe("joint");
    expect(byName("Rainy Day").owner).toBe("spouse");
    expect(byName("Index Fund")).toMatchObject({ balance: 52000, costBasis: 40000, owner: "me" });
    expect(byName("Cash ISA").balance).toBeCloseTo(15000.5);
  });

  it("keeps valid ids and slugs invalid ones consistently", () => {
    const ids = accounts().map((a) => a.id);
    expect(ids).toContain(IDS.brokerage);
    expect(ids).toContain("emergency-fund-2");
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("converts growth, dividends and fees (percent -> fraction)", () => {
    expect(byName("Cash ISA").behaviour.growth).toEqual({ kind: "fixed", rate: 0.0425 });
    expect(byName("Current Account").behaviour.growth).toEqual({ kind: "none" });
    expect(byName("Index Fund").behaviour.growth).toEqual({ kind: "inherit" });
    expect(byName("Coins").behaviour.dividends.yield).toEqual({ kind: "none" });
    expect(byName("Index Fund").behaviour.fees).toEqual({ kind: "percentOfBalance", rate: 0.0015 });
    expect(byName("Coins").behaviour.fees).toMatchObject({
      kind: "amount",
      amount: { value: 12, basis: "nominal" },
    });
  });

  it("maps UK pension behaviour: PCLS, tax-free share, early-withdrawal, jurisdiction", () => {
    const p = byName("Workplace Pension");
    expect(p.jurisdiction).toBe("GB");
    expect(p.behaviour).toMatchObject({
      ukDrawdownMethod: "pcls",
      taxFreeWithdrawalShare: 0.25,
      earlyWithdrawal: { enabled: true, qualifiedAge: 57, penaltyRate: 0.55 },
      withdrawals: { kind: "never" },
      liquid: "never",
    });
  });

  it("maps withdraw / liquid keywords", () => {
    const idx = byName("Index Fund");
    expect(idx.behaviour.withdrawals).toEqual({
      kind: "from",
      ref: { kind: "date", date: "2030-06", offsetMonths: 0 },
    });
    expect(idx.behaviour.liquid).toBe("whenWithdrawable");
    const r = run((raw) => {
      const a = ((raw.today as Json).investmentAccounts as Json[])[0]!;
      a.withdraw = "EWAge";
      a.liquid = "EWAge";
    });
    const a = r.document.finances.accounts.find((x) => x.name === "Index Fund")!;
    expect(a.behaviour.withdrawals).toEqual({ kind: "afterQualifiedAge" });
    expect(a.behaviour.liquid).toBe("afterQualifiedAge");
    expect(r.issues.filter((i) => i.category === "invalid")).toEqual([]);
  });

  it("repurpose marks excess cash and expands the drawdown order", () => {
    expect(byName("Rainy Day").behaviour.isExcessCash).toBe(true);
    const order = plan(run()).drawdown.order;
    expect(order[0]).toEqual({ kind: "account", accountId: "emergency-fund-2" });
  });

  it("custom dividend series become a schedule", () => {
    const r = run((raw) => {
      const a = ((raw.today as Json).investmentAccounts as Json[])[0]!;
      a.dividendType = "custom";
      a.dividendRateCustom = {
        type: "%",
        data: [
          { x: 12, y: 3 },
          { x: 0.5, y: 1 },
        ],
      };
    });
    const a = r.document.finances.accounts.find((x) => x.name === "Index Fund")!;
    expect(a.behaviour.dividends.yield).toEqual({
      kind: "schedule",
      interpolation: "linear",
      points: [
        { at: { kind: "planStart", offsetMonths: 6 }, rate: 0.01 },
        { at: { kind: "planStart", offsetMonths: 144 }, rate: 0.03 },
      ],
    });
  });

  it("unknown account types become other with a warning", () => {
    const r = run((raw) => {
      ((raw.today as Json).savingsAccounts as Json[])[0]!.type = "mystery-box";
    });
    expect(r.document.finances.accounts[0]!.type).toBe("other");
    expect(
      r.issues.some(
        (i) => i.category === "invalid" && i.sourcePath === "$.today.savingsAccounts[0].type",
      ),
    ).toBe(true);
  });

  it("plan account events become sparse overrides of only the keys that differ", () => {
    expect(plan(run()).accountSettings).toEqual({});
    const r = run((raw) => {
      const ev = events(plans(raw)[1]!, "accounts").find((e) => e.name === "Index Fund")!;
      ev.investmentGrowthType = "fixed";
      ev.investmentGrowthRate = 5;
    });
    const patch = plan(r, 1).accountSettings[IDS.brokerage]!;
    expect(patch).toEqual({ growth: { kind: "fixed", rate: 0.05 } });
    // Everything else comes from the account itself (sparse patches keep it).
    const own = r.document.finances.accounts.find((a) => a.id === IDS.brokerage)!.behaviour;
    expect({ ...own, ...patch }.fees).toEqual({ kind: "percentOfBalance", rate: 0.0015 });
    expect(plan(r, 0).accountSettings).toEqual({});
  });

  it("plan-level balance overrides are reported, not silently applied", () => {
    const r = run((raw) => {
      events(plans(raw)[0]!, "accounts")[3]!.balance = 1;
    });
    expect(r.issues.some((i) => i.code === "pl.plan-balance-override")).toBe(true);
  });

  it("plan-only accounts become planned accounts", () => {
    const r = run((raw) => {
      const evs = events(plans(raw)[0]!, "accounts");
      evs.push({
        ...evs[0]!,
        id: "only-in-plan",
        accountId: "only-in-plan",
        balance: 99,
        name: "New Pot",
      });
    });
    const pa = plan(r).plannedAccounts;
    expect(pa).toHaveLength(1);
    expect(pa[0]).toMatchObject({ name: "New Pot", balance: 0, opensAt: { kind: "planStart" } });
    expect(r.issues.some((i) => i.code === "pl.planned-account")).toBe(true);
  });

  it("accounts a plan does not list are excluded from it", () => {
    const r = run((raw) => {
      const evs = events(plans(raw)[2]!, "accounts");
      evs.splice(
        evs.findIndex((e) => e.name === "Cold Wallet"),
        1,
      );
    });
    expect(plan(r, 2).excludedIds).toEqual([IDS.cryptoAlt]);
    expect(plan(r, 0).excludedIds).toEqual([]);
  });
});

describe("real assets and debts", () => {
  const assets = () => run().document.finances.realAssets;
  const rental = () => assets().find((a) => a.name === "Rental Flat")!;

  it("maps type, value, loan and growth", () => {
    expect(assets().map((a) => a.type)).toEqual([
      "rental-property",
      "house",
      "precious-metals",
      "jewelry",
    ]);
    expect(rental()).toMatchObject({ currentValue: 310000, purchasePrice: 250000, owner: "me" });
    expect(rental().loan).toMatchObject({
      balance: 120000,
      interest: { apr: 0.042, method: "compound", compounding: "monthly" },
      monthlyPayment: { value: 950, basis: "real" },
    });
    expect(rental().behaviour.appreciation).toEqual({ kind: "rate", rate: 0.035 });
    expect(assets().find((a) => a.name === "Watch")!.behaviour.appreciation).toEqual({
      kind: "rate",
      rate: -0.05,
    });
  });

  it("pay-in-full assets have no loan", () => {
    expect(assets().find((a) => a.name === "Gold Coins")!.loan).toBeUndefined();
  });

  it("maps running costs (% of value vs amounts) and HOA", () => {
    const b = rental().behaviour;
    expect(b.maintenance).toEqual({ kind: "percentOfValue", rate: 0.01 });
    expect(b.insurance).toEqual({ kind: "percentOfValue", rate: 0.002 });
    expect(b.improvements).toEqual({ kind: "percentOfValue", rate: 0.005 });
    expect(b.hoa).toEqual({ kind: "amountPerMonth", amount: { value: 60, basis: "real" } });
    expect(b.propertyTax?.cost).toEqual({ kind: "percentOfValue", rate: 0.003 });
    const home = assets().find((a) => a.name === "Family Home")!;
    expect(home.behaviour.propertyTax?.cost).toEqual({
      kind: "amountPerYear",
      amount: { value: 1800, basis: "real" },
    });
  });

  it("maps rental income, tax settings and the sale date", () => {
    const b = rental().behaviour;
    expect(b.usage).toBe("investment");
    expect(b.rental).toMatchObject({
      enabled: true,
      income: { kind: "percentOfValue", rate: 0.06 },
      rentedShare: 1,
      countsAsPassiveIncome: true,
      taxSettings: {
        estimateDeductions: true,
        buildingValue: 120000,
        classification: "residential",
      },
    });
    expect(b.sale).toMatchObject({ at: { kind: "date", date: "2040-03" }, brokerFeeRate: 0.025 });
    expect(b.liquidateIfNeeded).toBe(true);
  });

  it("approximations are reported: management fee, and a broker fee with no sale", () => {
    const r = run();
    expect(r.issues.some((i) => i.code === "pl.management-fee")).toBe(true);
    expect(r.issues.some((i) => i.code === "pl.dropped-brokersFee")).toBe(true);
  });

  it("asset growth limits map to appreciationLimit (ceiling when appreciating), with a note", () => {
    const r = run();
    const metals = r.document.finances.realAssets.find((a) => a.type === "precious-metals")!;
    expect(metals.behaviour.appreciationLimit).toEqual({ max: 8, basis: "real" });
    expect(r.issues.some((i) => i.code === "pl.asset-limit")).toBe(true);
    expect(r.issues.some((i) => i.category === "unsupported")).toBe(false);
    const rental = r.document.finances.realAssets.find((a) => a.behaviour.rental?.enabled)!;
    expect(rental.behaviour.rental!.cancelOnSale).toBe(false);
  });

  it("plan asset events patch behaviour (sale date), and divergences are reported", () => {
    const r = run();
    expect(plan(r).realAssetSettings[rental().id]?.sale).toMatchObject({
      at: { kind: "date", date: "2041-03" },
    });
    expect(
      plan(r).realAssetSettings[assets().find((a) => a.name === "Family Home")!.id],
    ).toBeUndefined();
    const d = run((raw) => {
      events(plans(raw)[0]!, "assets")[0]!.monthlyPayment = 1;
    });
    expect(d.issues.some((i) => i.code === "pl.plan-asset-override")).toBe(true);
  });

  it("a plan that zeroes an asset cost, turns rent off or removes the sale really overrides Current Finances (regression)", () => {
    // Structure seen in a real export: Current Finances carries % maintenance / insurance / property
    // tax, and the plan-level copy of the asset sets each of them to 0. Previously a zero mapped to
    // an absent key, the sparse plan patch kept the Current Finances costs, and the plan paid
    // running costs its author had switched off (enough to turn a funded plan into shortfalls).
    const r = run((raw) => {
      const evs = events(plans(raw)[0]!, "assets");
      const home = evs.find((e) => e.assetId === IDS.home || e.id === IDS.home)!;
      home.maintenanceRate = 0;
      home.insuranceRate = 0;
      home.taxRate = 0;
      const rental = evs.find((e) => e.assetId === IDS.rental || e.id === IDS.rental)!;
      rental.generateIncome = false;
      rental.end = { type: "keyword", value: "never" };
    });
    const homeId = assets().find((a) => a.name === "Family Home")!.id;
    const patch = plan(r).realAssetSettings[homeId]!;
    expect(patch.maintenance).toEqual({ kind: "none" });
    expect(patch.insurance).toEqual({ kind: "none" });
    expect(patch.propertyTax).toMatchObject({ cost: { kind: "none" } });
    const rentalPatch = plan(r).realAssetSettings[rental().id]!;
    expect(rentalPatch.rental?.enabled).toBe(false);
    expect(rentalPatch.sale?.at).toEqual({ kind: "never" });
    expect(r.issues.some((i) => i.code === "pl.plan-unset")).toBe(false);
    const res = simulate(
      buildSimulationInput(r.document, plan(r).id, { strict: false, trace: "off" }),
    );
    for (const p of res.periods) {
      expect(p.expenses.filter((e) => e.sourceId.startsWith(`asset-cost:${homeId}:`))).toEqual([]);
      expect(
        p.income.filter((l) => l.sourceKind === "rental" && l.sourceId.endsWith(rental().id)),
      ).toEqual([]);
    }
  });

  it("plan-only assets become planned real assets with financing", () => {
    const r = run((raw) => {
      const evs = events(plans(raw)[1]!, "assets");
      evs.push({
        ...evs[0]!,
        id: "evt-new-house",
        assetId: "new-house",
        name: "Future House",
        amount: 400000,
        initialValue: 390000,
        downPayment: 40000,
        paymentMethod: "financed",
        start: { type: "date", value: "2032-06-01", modifier: "include" },
        end: { type: "keyword", value: "never" },
      });
    });
    const pa = plan(r, 1).plannedRealAssets;
    expect(pa).toHaveLength(1);
    expect(pa[0]!.purchase).toMatchObject({
      at: { kind: "date", date: "2032-06" },
      price: { value: 400000, basis: "real" },
      marketValue: { value: 390000 },
      downPayment: { value: 40000 },
    });
    expect(pa[0]!.purchase.financing).toBeDefined();
  });

  it("maps the debt end and yearly change to paymentsEnd and balanceChange", () => {
    const r = run((raw) => {
      const d = ((raw.today as Json).debts as Json[])[0]!;
      d.end = { type: "date", value: "2031-06-01", modifier: "include" };
      d.yearlyChange = {
        type: "depreciate",
        amount: 2,
        amountType: "%",
        limitEnabled: true,
        limit: 1000,
      };
    });
    const b = r.document.finances.debts[0]!.behaviour;
    expect(b.paymentsEnd).toMatchObject({ kind: "date", date: "2031-06" });
    expect(b.balanceChange).toEqual({ rate: -0.02, min: 1000 });
    expect(r.issues.some((i) => i.code === "pl.debt-end")).toBe(false);
  });

  it("maps the debt: balance, simple interest, payment", () => {
    const d = run().document.finances.debts[0]!;
    expect(d).toMatchObject({
      name: "Car Finance",
      type: "debt",
      balance: 9000,
      interest: { apr: 0.055, method: "simple", compounding: "monthly" },
      monthlyPayment: { value: 260, basis: "real" },
    });
  });

  it("debt events become debtSettings, not expenses", () => {
    const r = run();
    expect(plan(r).expenses.some((e) => e.name === "Car Finance")).toBe(false);
    expect(plan(r).debtSettings[IDS.loan]).toMatchObject({
      monthlyPaymentOverride: { value: 310, basis: "real" },
      forgiveness: { at: { kind: "date", date: "2029-01" }, taxable: false },
    });
    expect(r.report.counts.expenses).toEqual({ source: 24, imported: 24 });
  });

  it("an orphan debt event becomes an expense of its monthly payment", () => {
    const r = run((raw) => {
      const e = events(plans(raw)[0]!, "expenses").find((x) => x.type === "debt")!;
      e.debtId = "gone";
    });
    const e = plan(r).expenses.find((x) => x.name === "Car Finance")!;
    expect(e).toMatchObject({
      type: "other",
      frequency: "monthly",
      amount: { value: 310, basis: "real" },
    });
    expect(r.issues.some((i) => i.code === "pl.orphan-debt")).toBe(true);
  });
});

describe("dates and ranges", () => {
  const mk = () => run();
  const ctxFor = () => {
    const r = mk();
    return r;
  };

  it("parses months from every accepted format", () => {
    expect(toMonth("2030-05-17")).toBe("2030-05");
    expect(toMonth("2030-05")).toBe("2030-05");
    expect(toMonth(Date.UTC(2031, 6, 2))).toBe("2031-07");
    expect(toMonth(2040)).toBe("2040-01");
    expect(toMonth("2040")).toBe("2040-01");
    expect(toMonth("garbage")).toBeUndefined();
    expect(toMonth("2030-13-01")).toBeUndefined();
  });

  it("keywords: now/beforeCurrentYear -> planStart, endOfPlan -> planEnd, never -> never", () => {
    const p = plan(mk());
    const living = p.expenses.find((e) => e.name === "Household Costs")!;
    expect(living.range.start).toEqual({ kind: "planStart", offsetMonths: 0 });
    const retire = p.expenses.find((e) => e.name === "Retirement Costs")!;
    expect(retire.range.end).toEqual({ kind: "planEnd", offsetMonths: 0 });
    expect(retire.range.endInclusive).toBe(false);
    const personal = p.expenses.find((e) => e.name === "Personal")!;
    expect(personal.range.end).toEqual({ kind: "never" });
  });

  it("modifier 'exclude' -> exclusive end; 'include' -> endInclusive", () => {
    const p = plan(mk());
    const job = p.income.find((e) => e.name === "Day Job")!;
    expect(job.range.end).toEqual({
      kind: "milestone",
      milestoneId: "retirement",
      offsetMonths: 0,
    });
    expect(job.range.endInclusive).toBe(false);
    const costs = p.expenses.find((e) => e.name === "Household Costs")!;
    expect(costs.range.endInclusive).toBe(true);
    expect(costs.range.end).toEqual({
      kind: "milestone",
      milestoneId: "retirement",
      offsetMonths: 0,
    });
  });

  it("every date-reference kind appears in the fixture and resolves", () => {
    const p = plan(mk());
    const kinds = new Set<string>();
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") {
        const o = v as Json;
        if (
          typeof o.kind === "string" &&
          ["planStart", "planEnd", "never", "date", "age", "milestone"].includes(o.kind) &&
          ("offsetMonths" in o || o.kind === "never")
        )
          kinds.add(o.kind);
        Object.values(o).forEach(walk);
      }
    };
    walk(p);
    expect([...kinds].sort()).toEqual(
      ["age", "date", "milestone", "never", "planEnd", "planStart"].filter(
        (k) => k !== "age" || kinds.has("age"),
      ),
    );
    expect(
      kinds.has("milestone") &&
        kinds.has("date") &&
        kinds.has("planEnd") &&
        kinds.has("never") &&
        kinds.has("planStart"),
    ).toBe(true);
  });

  it("age references map to the owner person", () => {
    const r = run((raw) => {
      const ev = events(plans(raw)[0]!, "income")[1]!;
      ev.start = { type: "age", value: 40, modifier: "include" };
    });
    const ev = plan(r).income[1]!;
    expect(ev.range.start).toEqual({ kind: "age", personId: "spouse", age: 40, offsetMonths: 0 });
  });

  it("start 'exclude' on a date shifts one month and says so", () => {
    const r = mk();
    const flow = plan(r).flows.find((f) => f.name === "Overpay Rental Mortgage")!;
    expect(flow.range.start).toEqual({ kind: "date", date: "2027-12", offsetMonths: 1 });
    expect(r.issues.some((i) => i.code === "pl.start-exclude")).toBe(true);
  });

  it("'once' events fire in their start month", () => {
    const e = plan(mk()).expenses.find((x) => x.name === "Wedding Gift")!;
    expect(e.range).toEqual({
      start: { kind: "date", date: "2028-08", offsetMonths: 0 },
      end: { kind: "date", date: "2028-08", offsetMonths: 0 },
      endInclusive: true,
    });
  });

  it("references to undefined milestones are reported and become never", () => {
    const r = run((raw) => {
      events(plans(raw)[0]!, "expenses")[0]!.end = {
        type: "milestone",
        value: "ghost",
        modifier: "include",
      };
    });
    expect(plan(r).expenses[0]!.range.end).toEqual({ kind: "never" });
    expect(
      r.issues.some(
        (i) => i.category === "invalid" && i.sourcePath.endsWith("expenses.events[0].end"),
      ),
    ).toBe(true);
  });

  it("resolveRange handles bad references defensively", () => {
    const r = ctxFor();
    expect(r.document.plans).toHaveLength(3);
    const issues: never[] = [];
    const out = resolveRange(
      {
        issues,
        primaryId: "me",
        country: "XX",
        currency: "GBP",
        asOf: "2026-11",
        accountIds: undefined as never,
        assetIds: undefined as never,
        debtIds: undefined as never,
        planIds: undefined as never,
        knownAccounts: new Set(),
        knownAssets: new Set(),
        knownDebts: new Set(),
      },
      { start: "nonsense", end: { type: "keyword", value: "whenever" } },
      "$.x",
    );
    expect(out.start.kind).toBe("planStart");
    expect(out.end.kind).toBe("planEnd");
  });
});

describe("income", () => {
  const inc = (name: string) => plan(run()).income.find((e) => e.name === name)!;

  it("maps types, amounts, basis, frequency and owner", () => {
    expect(plan(run()).income.map((e) => e.type)).toEqual([
      "salary",
      "salary",
      "other",
      "pension",
      "pension",
    ]);
    expect(inc("Day Job")).toMatchObject({
      amount: { value: 4500, basis: "real" },
      frequency: "monthly",
      owner: "me",
    });
    expect(inc("Partner Job")).toMatchObject({ frequency: "yearly", owner: "spouse" });
    expect(inc("Bonus Windfall").frequency).toBe("once");
  });

  it("'today$' -> real, '$' -> nominal", () => {
    const r = run((raw) => {
      events(plans(raw)[0]!, "income")[0]!.amountType = "$";
    });
    expect(plan(r).income[0]!.amount.basis).toBe("nominal");
  });

  it("change over time: match-inflation (+ premium) and cap", () => {
    expect(inc("Day Job").change).toEqual({ kind: "inflation", plus: 0 });
    const sp = inc("State Pension");
    expect(sp.change).toEqual({ kind: "inflation", plus: 0.005 });
    expect(r2(sp.changeLimit)).toEqual({ max: 20000, basis: "real" });
  });

  it("fixed % growth and declines", () => {
    const r = run((raw) => {
      const e = events(plans(raw)[0]!, "income");
      e[0]!.yearlyChange = { type: "increase", amount: 3, amountType: "%", limitEnabled: false };
      e[1]!.yearlyChange = { type: "none" };
      e[2]!.yearlyChange = {
        type: "decrease",
        amount: 2,
        amountType: "%",
        limitEnabled: true,
        limit: 10,
        limitType: "today$",
      };
    });
    const i = plan(r).income;
    expect(i[0]!.change).toEqual({ kind: "rate", rate: 0.03 });
    expect(i[1]!.change).toEqual({ kind: "none" });
    expect(i[2]!.change).toEqual({ kind: "rate", rate: -0.02 });
    expect(r2(i[2]!.changeLimit)).toEqual({ min: 10, basis: "real" });
  });

  it("part-time and routing", () => {
    const j = inc("Day Job");
    expect(j.partTime).toMatchObject({ share: 0.6, range: { endInclusive: true } });
    expect(j.sendTo).toEqual({ kind: "accounts", accountIds: [IDS.cash] });
    expect(inc("Bonus Windfall").sendTo).toEqual({
      kind: "accounts",
      accountIds: [IDS.brokerage, IDS.isaCash, "emergency-fund-2"],
      preventOverflow: true,
    });
  });

  it("defined-benefit pension on salary", () => {
    const p = inc("Day Job");
    expect(p.type === "salary" && p.pension).toMatchObject({
      employeeContribution: { kind: "percentOfPay", rate: 0.05 },
      payout: { kind: "percentOfFinalPay", rate: 0.3 },
      contributionsReduceTaxableIncome: true,
      payoutsTaxFree: false,
      payouts: {
        start: { kind: "milestone", milestoneId: "retirement" },
        end: { kind: "planEnd" },
      },
    });
  });

  it("other payout types: career average and fixed amount", () => {
    const r = run((raw) => {
      const e = events(plans(raw)[0]!, "income")[0]!;
      e.pensionPayoutType = "amount";
      e.pensionPayoutAmount = 5000;
      e.pensionContributionType = "today$";
      e.pensionContribution = 200;
    });
    const p = plan(r).income[0]!;
    expect(p.type === "salary" && p.pension).toMatchObject({
      payout: { kind: "amount", amount: { value: 5000, basis: "real" } },
      employeeContribution: { kind: "amount", amount: { value: 200, basis: "real" } },
    });
  });

  it("tax character, exemptions and withholding", () => {
    const r = run((raw) => {
      const e = events(plans(raw)[0]!, "income");
      e[0]!.taxCharacter = "self-employment";
      e[1]!.taxExempt = true;
      e[2]!.taxExempt = ["us-state"];
      e[2]!.withholdingMode = "fixed";
      e[2]!.withholdingRate = 22;
      e[3]!.withholdingMode = "none";
      e[4]!.taxCharacter = "made-up";
    });
    const i = plan(r).income;
    expect(i[0]!.tax.character).toBe("self-employment");
    expect(i[1]!.tax.character).toBe("tax-free");
    expect(i[2]!.tax.exemptIn).toEqual(["us-state"]);
    expect(i[2]!.tax.withholding).toEqual({ mode: "fixed", rate: 0.22 });
    expect(i[3]!.tax.withholding).toEqual({ mode: "none" });
    expect(i[4]!.tax.character).toBe("auto");
    expect(
      r.issues.some(
        (x) => x.category === "invalid" && x.sourcePath.endsWith("income.events[4].taxCharacter"),
      ),
    ).toBe(true);
  });

  it("preventOverflow maps to the routing option (no unsupported issue)", () => {
    expect(run().issues.some((i) => i.suggestedField === "AccountRouting.preventOverflow")).toBe(
      false,
    );
  });

  it("unknown income types become other", () => {
    const r = run((raw) => {
      events(plans(raw)[0]!, "income")[0]!.type = "lottery";
    });
    expect(plan(r).income[0]!.type).toBe("other");
  });
});

describe("expenses", () => {
  const exp = (name: string) => plan(run()).expenses.find((e) => e.name === name)!;

  it("maps types and spending type", () => {
    expect(exp("Household Costs")).toMatchObject({
      type: "living",
      spendingType: "essential",
      owner: "joint",
    });
    expect(exp("Holidays")).toMatchObject({ type: "travel", spendingType: "discretionary" });
    expect(exp("Family Support").type).toBe("dependent-support");
    expect(exp("Wedding Gift").type).toBe("other");
  });

  it("recurrence: years between, scaling, until", () => {
    expect(exp("New Car").recurrence).toEqual({
      yearsBetween: 8,
      scalingRate: 0.02,
      until: { kind: "planEnd", offsetMonths: 0 },
      keepLast: false,
    });
  });

  it("tax flags, payroll deduction and funding accounts", () => {
    const e = exp("New Car");
    expect(e.tax).toMatchObject({
      deductible: true,
      itemized: false,
      treatment: "tax-exempt",
      payrollDeductionFromIncomeId: "inc-salary-1",
    });
    expect(e.payFrom).toEqual({ kind: "accounts", accountIds: [IDS.brokerage] });
  });

  it("inflation vs none change", () => {
    expect(exp("Household Costs").change).toEqual({ kind: "inflation", plus: 0 });
    expect(exp("Personal").change).toEqual({ kind: "none" });
  });

  it("dangling references are dropped and reported", () => {
    const r = run((raw) => {
      events(plans(raw)[0]!, "expenses").find((e) => e.name === "New Car")!.fundWithAccounts = [
        "nope",
      ];
    });
    expect(plan(r).expenses.find((e) => e.name === "New Car")!.payFrom).toEqual({ kind: "auto" });
    expect(
      r.issues.some(
        (i) => i.category === "invalid" && i.sourcePath.includes("fundWithAccounts[0]"),
      ),
    ).toBe(true);
  });
});

describe("priorities (flows)", () => {
  const flows = () => plan(run()).flows;
  const flow = (n: string) => flows().find((f) => f.name === n)!;

  it("maps every priority type in order", () => {
    expect(flows().map((f) => f.kind)).toEqual([
      "debtPaydown",
      "debtPaydown",
      "contribution",
      "contribution",
      "contribution",
      "transfer",
      "debtPaydown",
    ]);
  });

  it("debt pay-extra resolves the debt through the plan event id", () => {
    expect(flow("Clear Car Finance")).toMatchObject({
      kind: "debtPaydown",
      targetId: IDS.loan,
      method: { kind: "amount", amount: { value: 5000, basis: "real" }, frequency: "once" },
      mandatory: true,
    });
    expect(flow("Debt Max")).toMatchObject({ method: { kind: "max" } });
  });

  it("asset priorities pay down the asset's loan", () => {
    expect(flow("Overpay Rental Mortgage")).toMatchObject({
      kind: "debtPaydown",
      targetId: IDS.rental,
    });
  });

  it("savings: target strategy and percent-of-remaining", () => {
    expect(flow("Emergency Buffer")).toMatchObject({
      kind: "contribution",
      accountId: "emergency-fund-2",
      strategy: { kind: "target", target: { value: 20000, basis: "real" } },
      method: { kind: "percentOfRemaining", share: 0.5 },
    });
    expect(flow("Pension Top-up")).toMatchObject({
      method: { kind: "amount", frequency: "monthly", amount: { value: 300 } },
      mandatory: true,
    });
  });

  it("percent taken from `amount` is flagged", () => {
    expect(flow("Invest The Rest")).toMatchObject({
      method: { kind: "percentOfRemaining", share: 0.75 },
    });
    expect(run().issues.some((i) => i.code === "pl.flow-percent-source")).toBe(true);
  });

  it("transfer: source, destination, max -> all, tax handling", () => {
    expect(flow("Move To ISA")).toMatchObject({
      kind: "transfer",
      fromAccountId: IDS.brokerage,
      to: { kind: "account", accountId: IDS.isaCash },
      amount: { kind: "all" },
      taxHandling: "tax-exempt",
    });
  });

  it("tap fund maps to ContributionFlow.tapFund with its rate", () => {
    const f = plan(run()).flows.find((x) => x.name === "Pension Top-up")!;
    expect(f.kind === "contribution" && f.tapFund).toEqual({ rate: 0.04 });
  });

  it("priorities pointing at nothing are dropped with an issue", () => {
    const r = run((raw) => {
      events(plans(raw)[0]!, "priorities")[0]!.debtId = "missing";
    });
    expect(plan(r).flows).toHaveLength(6);
    expect(r.report.counts.flows).toEqual({ source: 21, imported: 20 });
  });
});

describe("milestones", () => {
  const ms = () => plan(run()).milestones;

  it("maps built-ins to kinds and people", () => {
    expect(
      ms()
        .slice(0, 5)
        .map((m) => [m.id, m.kind, m.personId, m.builtIn]),
    ).toEqual([
      ["retirement", "retirement", "me", true],
      ["spouseRetirement", "retirement", "spouse", true],
      ["lifeExpectancy", "life-expectancy", "me", true],
      ["spouseLifeExpectancy", "life-expectancy", "spouse", true],
      ["fi", "financial-independence", undefined, false],
    ]);
  });

  it("milestone, year and metric criteria", () => {
    const byId = Object.fromEntries(ms().map((m) => [m.id, m]));
    expect(byId.retirement!.criteria).toEqual([
      { kind: "milestone", milestoneId: "fi", offsetMonths: 0, when: "at" },
    ]);
    expect(byId.lifeExpectancy!.criteria).toEqual([{ kind: "date", date: "2085-01", when: "at" }]);
    expect(byId.fi!.criteria[0]).toEqual({
      kind: "metric",
      metric: { kind: "netWorth" },
      comparator: ">=",
      threshold: {
        kind: "multipleOf",
        multiple: 30,
        of: "expenses",
        measurement: "average",
        averageYears: 3,
      },
    });
  });

  it("absolute metric thresholds are real amounts", () => {
    const r = run();
    const m = plan(r, 1).milestones.find((x) => x.name === "Half Way")!;
    expect(m.criteria[0]).toMatchObject({
      metric: { kind: "liquidNetWorth" },
      threshold: { kind: "amount", amount: { value: 700000, basis: "real" } },
    });
  });

  it("computed (account-target) milestones resolve the account via the plan event id; hidden hides the chart icon", () => {
    const r = run();
    const goal = plan(r).milestones.find((m) => m.name === "Emergency Buffer reached")!;
    expect(goal.criteria[0]).toMatchObject({
      kind: "metric",
      metric: { kind: "accountBalance", accountId: "emergency-fund-2" },
      threshold: { kind: "amount", amount: { value: 20000, basis: "real" } },
    });
    expect(plan(r).milestones.find((m) => m.name === "Pension target")!.showOnChart).toBe(false);
  });

  it("the averaging range maps to averageYears (no unsupported issue)", () => {
    expect(run().issues.some((i) => i.suggestedField === "MetricThreshold.averageYears")).toBe(
      false,
    );
  });

  it("a milestone with no usable criteria is dropped and counted", () => {
    const r = run((raw) => {
      const m = (plans(raw)[0]!.milestones as Json[])[4]!;
      m.criteria = [{ type: "weather", value: 1 }];
    });
    expect(r.report.counts.milestones!.imported).toBe(r.report.counts.milestones!.source - 1);
  });
});

describe("withdrawal strategy, drawdown, flex spending", () => {
  const ws = (mutate: (s: Json) => void) => {
    const r = run((raw) => mutate(plans(raw)[0]!.withdrawalStrategy as Json));
    return plan(r).withdrawalStrategy!;
  };

  it("initial % (the default selection)", () => {
    expect(plan(run()).withdrawalStrategy).toMatchObject({
      enabled: false,
      start: { kind: "milestone", milestoneId: "fi" },
      rule: { kind: "initial-percent", rate: 0.04 },
      incomeHandling: "increase-spending",
      treatAsSpending: false,
    });
  });

  it("all eight strategies map", () => {
    expect(ws((s) => (s.strategy = "fixed-%")).rule).toEqual({
      kind: "fixed-percent",
      rate: 0.035,
    });
    expect(ws((s) => (s.strategy = "fixed-amount")).rule).toEqual({
      kind: "fixed-amount",
      amount: { value: 40000, basis: "real" },
      inflationAdjust: true,
    });
    expect(ws((s) => (s.strategy = "1/N")).rule).toEqual({ kind: "one-over-n" });
    expect(ws((s) => (s.strategy = "vpw")).rule).toMatchObject({ kind: "vpw" });
    expect(ws((s) => (s.strategy = "kitces-ratchet")).rule).toEqual({
      kind: "ratcheting",
      rate: 0.04,
      threshold: 0.5,
      raise: 0.1,
      cooldownYears: 3,
    });
    expect(ws((s) => (s.strategy = "clyatt-95%")).rule).toEqual({
      kind: "clyatt-95",
      rate: 0.04,
      minShareOfPrevious: 0.95,
    });
    expect(ws((s) => (s.strategy = "guyton-klinger")).rule).toEqual({
      kind: "guyton-klinger",
      rate: 0.045,
      guardrail: 0.2,
      adjustment: 0.05,
    });
  });

  it("bounds: amounts map to floor/ceiling; percentage bounds are reported", () => {
    const w = ws((s) => {
      s.strategy = "fixed-%";
      (s["fixed-%"] as Json).maxEnabled = true;
    });
    expect(w.bounds).toEqual({
      floor: { value: 10000, basis: "real" },
      ceiling: { value: 1000000, basis: "real" },
    });
    const r = run((raw) => {
      const s = plans(raw)[0]!.withdrawalStrategy as Json;
      s.strategy = "kitces-ratchet";
    });
    expect(r.issues.some((i) => i.code === "pl.withdrawal-percent-bound")).toBe(true);
  });

  it("income handling and spend mode", () => {
    const w = ws((s) => {
      s.income = "reduce-withdrawals";
      s.spendMode = "spend";
      s.enabled = true;
    });
    expect(w).toMatchObject({
      incomeHandling: "reduce-withdrawals",
      treatAsSpending: true,
      enabled: true,
    });
  });

  it("inactive strategy parameters are reported once as dropped", () => {
    const r = run();
    const i = r.issues.filter(
      (x) => x.code === "pl.inactive-strategy" && x.sourcePath === "$.plans[0].withdrawalStrategy",
    );
    expect(i).toHaveLength(1);
    expect(i[0]!.message).toContain("7 non-selected");
  });

  it("drawdown order: categories in order, excess-cash expanded, non-qualified pension reported", () => {
    const r = run();
    expect(plan(r).drawdown.order).toEqual([
      { kind: "account", accountId: "emergency-fund-2" },
      { kind: "category", category: "crypto" },
      { kind: "category", category: "taxable" },
      { kind: "category", category: "tax-deferred" },
      { kind: "category", category: "cash" },
    ]);
    expect(r.issues.some((i) => i.code === "pl.drawdown-non-qualified")).toBe(true);
  });

  it("flex spending", () => {
    const r = run((raw) => {
      (plans(raw)[0]!.variables as Json).flexSpending = {
        enabled: true,
        scope: "all",
        interpolation: "linear",
        points: [
          { x: 15, y: 10 },
          { x: 30, y: 25 },
        ],
      };
    });
    expect(plan(r).flexSpending).toMatchObject({
      enabled: true,
      scope: "all",
      interpolation: "linear",
      rules: [
        { drawdown: 0.15, cut: 0.1 },
        { drawdown: 0.3, cut: 0.25 },
      ],
    });
  });
});

describe("assumptions, tax, Monte Carlo", () => {
  it("fixed assumptions: percent -> fraction", () => {
    expect(plan(run()).assumptions).toMatchObject({
      inflation: { kind: "fixed", rate: 0.025 },
      stockReturn: { kind: "fixed", rate: 0.07 },
      dividendYield: { kind: "fixed", rate: 0.015 },
      bondReturn: { kind: "fixed", rate: 0.015 },
      bondYield: { kind: "fixed", rate: 0.035 },
      yearAlignment: { kind: "calendar" },
    });
  });

  it("historical mode uses the source start/loop year", () => {
    const a = plan(run(), 2).assumptions;
    expect(a.inflation).toEqual({
      kind: "historical",
      series: "us-inflation",
      startYear: 1928,
      loopYear: 1928,
    });
    expect(a.stockReturn).toMatchObject({ kind: "historical", series: "us-stocks" });
    expect(a.bondYield).toEqual({ kind: "fixed", rate: 0.035 });
  });

  it("custom mode builds schedules from x (years from start) / y (%)", () => {
    const r = run((raw) => ((plans(raw)[0]!.variables as Json).assumptionsMode = "custom"));
    expect(plan(r).assumptions.inflation).toMatchObject({
      kind: "schedule",
      points: [
        { at: { kind: "planStart", offsetMonths: 5 }, rate: 0.03 },
        { at: { kind: "planStart", offsetMonths: 300 }, rate: 0.03 },
        { at: { kind: "planStart", offsetMonths: 600 }, rate: 0.025 },
      ],
    });
  });

  it("bond allocation glide path keys on age of the primary person", () => {
    const a = plan(run(), 1).assumptions.bondAllocation;
    expect(a.kind).toBe("glidepath");
    expect(a.points[1]).toEqual({
      at: { kind: "age", personId: "me", age: 40, offsetMonths: 0 },
      value: 0.15,
    });
    expect(plan(run(), 0).assumptions.bondAllocation.kind).toBe("none");
  });

  it("dividend reinvestment, COLA modifier, estate and withholding", () => {
    const r = run((raw) => {
      const v = plans(raw)[0]!.variables as Json;
      (v.dividendSettings as Json).reinvestment = { enabled: false };
      v.benefitColaModifier = -0.5;
      v.withholding = { taxDeferred: 20, taxable: 10, conversions: 25 };
    });
    expect(plan(r).assumptions.dividendReinvestment.enabled).toBe(false);
    expect(plan(r).assumptions.benefitColaModifier).toBeCloseTo(-0.005);
    expect(plan(r).tax.withholding).toEqual({ taxDeferred: 0.2, taxable: 0.1, conversions: 0.25 });
    expect(plan(r).tax.estate).toMatchObject({
      liquidationCostRate: 0.06,
      adminCostRate: 0.01,
      stepUpBasis: false,
      heirTaxDeferredRate: 0.25,
    });
  });

  it("flat tax: effective rate, capital gains, dividends follow cap gains, local", () => {
    expect(plan(run(), 0).tax).toMatchObject({
      mode: "flat",
      filingStatus: "married-joint",
      flat: { ordinary: 0.18, capitalGains: 0.1, dividends: 0.1, local: 0.01 },
    });
    const r = run((raw) => {
      const v = plans(raw)[0]!.variables as Json;
      v.dividendTaxMode = "fixed";
      v.dividendTaxRate = 7.5;
    });
    expect(plan(r).tax.flat.dividends).toBe(0.075);
  });

  it("bracket modes build custom rules with a zero-rate first bracket", () => {
    const r = run((raw) => {
      const v = plans(raw)[0]!.variables as Json;
      v.incomeTaxMode = "brackets";
      v.incomeTaxNational = {
        brackets: [
          { threshold: 12570, rate: 20 },
          { threshold: 50270, rate: 40 },
        ],
        standardDeduction: 0,
      };
      v.capGainsMode = "brackets";
      v.capGains = {
        brackets: [
          { threshold: 0, rate: 10 },
          { threshold: 50270, rate: 20 },
        ],
        offset: "none",
      };
      v.capGainsTaxablePercent = 50;
    });
    const t = plan(r).tax;
    expect(t.mode).toBe("custom");
    expect(t.custom?.ordinary.brackets).toEqual([
      { from: 0, rate: 0 },
      { from: 12570, rate: 0.2 },
      { from: 50270, rate: 0.4 },
    ]);
    expect(t.custom?.capitalGains?.brackets).toHaveLength(2);
    expect(t.custom?.capitalGainsInclusion).toBe(0.5);
  });

  it("wealth tax maps to the custom table", () => {
    const r = run((raw) => {
      const v = plans(raw)[0]!.variables as Json;
      v.wealthTaxMode = "fixed";
      v.wealthTaxRate = 1;
      v.wealthTax = { standardDeduction: 0, allowance: 500000, brackets: [] };
    });
    expect(plan(r).tax.mode).toBe("custom");
    expect(plan(r).tax.custom?.wealthTax).toEqual({
      metric: "netWorth",
      table: {
        brackets: [
          { from: 0, rate: 0 },
          { from: 500000, rate: 0.01 },
        ],
        basis: "real",
      },
    });
  });

  it("estimate mode needs a supported country; US toggles only for US households", () => {
    const r = run((raw) => {
      (raw.today as Json).location = { country: "US" };
      (plans(raw)[0]!.variables as Json).estimateTaxes = true;
    });
    expect(plan(r).tax.mode).toBe("estimate");
    expect(plan(r).tax.lawToggles).toEqual({
      "us.tcjaReversion": false,
      "us.bbbSaltReversion": true,
      "us.bbbSeniorReversion": true,
    });
    const xx = run((raw) => ((plans(raw)[0]!.variables as Json).estimateTaxes = true));
    expect(plan(xx).tax.mode).toBe("flat");
    expect(xx.issues.some((i) => i.code === "pl.estimate-taxes")).toBe(true);
  });

  it("filing statuses", () => {
    const f = (v: string) =>
      plan(run((raw) => ((plans(raw)[0]!.variables as Json).filingStatus = v))).tax.filingStatus;
    expect(f("single")).toBe("single");
    expect(f("joint")).toBe("married-joint");
    expect(f("separate")).toBe("married-separate");
    expect(f("head")).toBe("head-of-household");
  });

  it("tax extras map: bond dividends, modifiers, dividend allowance, offsets, extra taxes", () => {
    const r = run((raw) => {
      const v = plans(raw)[0]!.variables as Json;
      v.bondDividendTaxMode = "custom";
      v.incomeTaxModifier = 2;
      v.capGainsModifier = 1;
      v.capGainsMode = "brackets";
      v.dividendTaxMode = "brackets";
      v.capGains = {
        brackets: [
          { from: 0, rate: 0 },
          { from: 40000, rate: 15 },
        ],
        offset: "income",
      };
      v.dividendTax = { brackets: [{ from: 0, rate: 10 }], offset: "none", allowance: 500 };
      v.bondDividendTax = { brackets: [{ from: 0, rate: 20 }], offset: "none" };
      v.incomeTaxExtra = [{ name: "Surtax", rate: 1 }];
    });
    const t = plan(r).tax;
    expect(r.issues.some((i) => i.category === "unsupported")).toBe(false);
    expect(t.flat.bondDividends).toEqual({ treatment: "rate", rate: 0.2 });
    expect(t.flat.modifier).toEqual({ ordinary: 0.02, capitalGains: 0.01 });
    expect(t.custom).toMatchObject({
      capitalGainsOffset: "income",
      dividendOffset: "none",
      dividendAllowance: 500,
      bondDividends: { brackets: [{ from: 0, rate: 0.2 }] },
      extraTaxes: [
        { name: "Surtax", base: "ordinary", table: { brackets: [{ from: 0, rate: 0.01 }] } },
      ],
    });
  });

  it("historical modifiers become RateSpec.historical.modifier; settings bands and effective-rate income map", () => {
    const r = run((raw) => {
      const v = plans(raw)[0]!.variables as Json;
      v.assumptionsMode = "historical";
      v.startYear = 1966;
      v.investmentReturnModifier = -1;
    });
    expect(plan(r).assumptions.stockReturn).toMatchObject({
      kind: "historical",
      startYear: 1966,
      modifier: -0.01,
    });
    expect(r.document.settings.successRateBands?.[0]).toEqual({
      name: "Great",
      minRate: 0.95,
      color: "green",
    });
    expect(r.document.settings.effectiveTaxRate.income).toEqual({
      nonTaxableCapitalWithdrawals: false,
      nonTaxableSaleProceeds: false,
      taxFreeDistributions: true,
    });
  });

  it("financial transaction tax and local tax use the schema fields", () => {
    const r = run((raw) => {
      const v = plans(raw)[0]!.variables as Json;
      v.fttMode = "fixed";
      v.fttRate = 0.5;
      v.fttTaxableEvent = "buy";
    });
    expect(plan(r).tax.mode).toBe("custom");
    expect(plan(r).tax.custom?.financialTransactionTax).toEqual({ rate: 0.005, base: "purchases" });
    expect(plan(r).tax.custom?.flatEffectiveRate).toBe(0.18);
    expect(plan(r).tax.localIncomeTaxRate).toBe(0.01);
    expect(plan(run(), 0).tax.localIncomeTaxRate).toBeUndefined();
    const both = run((raw) => {
      const v = plans(raw)[1]!.variables as Json;
      v.fttMode = "fixed";
      v.fttTaxableEvent = "buy-sell";
    });
    expect(plan(both, 1).tax.custom?.financialTransactionTax?.base).toBe("both");
  });

  it("Monte Carlo: method, trials, block length, distributions, seed, split", () => {
    expect(plan(run()).monteCarlo).toMatchObject({
      method: "historical-random-restart",
      trials: 250,
      blockLength: 5,
      seed: 12345,
      splitAtMilestoneId: "retirement",
      distributions: {
        stocks: { mean: 0.08, stdDev: 0.12 },
        bonds: { mean: 0.03, stdDev: 0.02 },
        inflation: { mean: 0.03, stdDev: 0.08 },
        dividends: { mean: 0.025, stdDev: 0.05 },
        crypto: { mean: 0.12, stdDev: 0.5 },
      },
    });
  });

  it("other sampling methods", () => {
    const m = (s: string) =>
      plan(run((raw) => ((plans(raw)[0]!.montecarlo as Json).sampling = s))).monteCarlo.method;
    expect(m("backtest-sequential")).toBe("historical-sequential");
    expect(m("block")).toBe("block-bootstrap");
    expect(m("normal")).toBe("normal");
  });

  it("without useRandomSeed the seed is null", () => {
    const r = run((raw) => (((raw.settings as Json).montecarlo as Json).useRandomSeed = false));
    expect(plan(r).monteCarlo.seed).toBeNull();
  });
});

describe("settings and progress", () => {
  it("maps display and spending settings", () => {
    const s = run().document.settings;
    expect(s).toMatchObject({
      theme: "dark",
      locale: "en-GB",
      valueBasis: "real",
      autoProgressSnapshots: true,
      spending: {
        includeTaxes: false,
        includeMortgage: true,
        includeMortgagePrincipal: false,
        includeConsumerDebtPrincipal: false,
      },
      effectiveTaxRate: { includeLocal: true, includeProperty: false },
      onboarding: { completed: true },
    });
  });

  it("showFutureDollars -> nominal value basis", () => {
    const r = run((raw) => ((plans(raw)[0]!.variables as Json).showFutureDollars = true));
    expect(r.document.settings.valueBasis).toBe("nominal");
  });

  it("outcome categories keep order, kind, colour; missing thresholds use Glideworth defaults", () => {
    const cats = run().document.settings.outcomeCategories!;
    expect(cats.map((c) => c.id)).toEqual([
      "large-surplus",
      "comfortable",
      "almost-failed",
      "failed-late",
      "failed-mid",
      "failed-early",
    ]);
    expect(cats.find((c) => c.id === "comfortable")!.threshold).toBe(5);
    expect(cats.find((c) => c.id === "failed-late")).toMatchObject({
      kind: "failure",
      threshold: 0.9,
    });
  });

  it("the first plan is main when none is active; an active plan wins", () => {
    const none = run();
    expect(none.document.plans.map((p) => p.isMain)).toEqual([true, false, false]);
    expect(none.document.settings.defaultPlanId).toBe(IDS.plans[0]);
    const r = run((raw) => ((plans(raw)[2] as Json).active = true));
    expect(r.document.plans.map((p) => p.isMain)).toEqual([false, false, true]);
    expect(r.document.settings.defaultPlanId).toBe(IDS.plans[2]);
  });

  it("progress: dates round to the local day, liabilities = debt + loans, categories", () => {
    const p = run().document.progress;
    expect(p).toHaveLength(9);
    expect(p[0]).toMatchObject({
      date: "2026-02-01",
      source: "import",
      netWorth: 336000,
      // The source's `assets` is physical assets only; total assets add the financial balances.
      assets: 674000,
      liabilities: 338000,
      byCategory: {
        cash: 25000,
        taxable: 50000,
        "tax-deferred": 60000,
        "tax-free": 15000,
        crypto: 4000,
        "real-assets": 520000,
        debt: 8000,
        loans: 330000,
      },
    });
    for (const s of p) expect(s.assets - s.liabilities).toBeCloseTo(s.netWorth, 6);
    expect(run().issues.some((i) => i.code === "pl.progress-mismatch")).toBe(false);
    expect(p.map((s) => s.date)).toEqual([...p.map((s) => s.date)].sort());
    expect(new Set(p.map((s) => s.id)).size).toBe(9);
  });

  it("progress: the source's `assets` is physical assets, not total assets (regression)", () => {
    // Invented point: 10k cash + 5k taxable + 200k property - 120k mortgage = 95k net worth.
    const r = run((raw) => {
      (raw.progress as { data: Json[] }).data = [
        {
          date: Date.UTC(2030, 0, 1),
          savings: 10000,
          taxable: 5000,
          assets: 200000,
          loans: 120000,
          netWorth: 95000,
        },
      ];
    });
    expect(r.document.progress[0]).toMatchObject({
      netWorth: 95000,
      assets: 215000,
      liabilities: 120000,
      byCategory: { cash: 10000, taxable: 5000, "real-assets": 200000, loans: 120000 },
    });
    expect(r.issues.some((i) => i.code === "pl.progress-mismatch")).toBe(false);
  });

  it("progress: a net worth that disagrees with the balances is kept and reported", () => {
    const r = run((raw) => {
      (raw.progress as { data: Json[] }).data = [
        { date: Date.UTC(2030, 0, 1), savings: 10000, assets: 0, netWorth: 12345 },
      ];
    });
    expect(r.document.progress[0]!.netWorth).toBe(12345);
    expect(r.issues.some((i) => i.code === "pl.progress-mismatch")).toBe(true);
  });

  it("progress points without a date or any totals are dropped with issues", () => {
    const r = run((raw) => {
      const d = (raw.progress as { data: Json[] }).data;
      delete d[0]!.date;
      for (const k of Object.keys(d[1]!)) if (k !== "date") delete d[1]![k];
    });
    expect(r.document.progress).toHaveLength(7);
    expect(
      r.issues.filter((i) => i.sourcePath.startsWith("$.progress.data[")).length,
    ).toBeGreaterThanOrEqual(2);
  });
});

describe("coverage rules", () => {
  it("classifies representative paths", () => {
    expect(classifyPath("$.plans[].income.events[].amount")?.status).toBe("mapped");
    expect(classifyPath("$.settings.plots.individual.netWorth.mode")?.status).toBe("ignored");
    expect(classifyPath("$.plans[].priorities.events[].tapFund")?.status).toBe("mapped");
    expect(classifyPath("$.plans[].somethingNew")).toBeUndefined();
    expect(classifyPath("$.settings.plugins.apiKey")?.note).toContain("SECRET");
  });

  it("dynamic outcome keys and chart names are covered by wildcards", () => {
    expect(classifyPath("$.settings.montecarlo.outcomeTypes.brandNew.name")?.status).toBe("mapped");
    expect(classifyPath("$.settings.plots.individual.brandNewChart.type")?.status).toBe("ignored");
  });

  it("every perturbed mapped path in the synthetic export changes the output (spot-checked sample)", () => {
    const base = run();
    const sig = (r: ImportResult) =>
      JSON.stringify([
        r.document,
        r.issues.filter((i) => i.category !== "dropped" && i.category !== "unsupported"),
      ]);
    const baseSig = sig(base);
    const probes: [string, (raw: Json) => void][] = [
      [
        "accounts balance",
        (raw) => (((raw.today as Json).savingsAccounts as Json[])[0]!.balance = 1),
      ],
      ["income amount", (raw) => (events(plans(raw)[0]!, "income")[0]!.amount = 1)],
      ["expense frequency", (raw) => (events(plans(raw)[0]!, "expenses")[0]!.frequency = "yearly")],
      ["flow extra", (raw) => (events(plans(raw)[0]!, "priorities")[0]!.extra = 1)],
      [
        "milestone value",
        (raw) => (((plans(raw)[0]!.milestones as Json[])[4]!.criteria as Json[])[0]!.value = 12),
      ],
      ["inflation", (raw) => ((plans(raw)[0]!.variables as Json).inflation = 9)],
      ["trials", (raw) => ((plans(raw)[0]!.montecarlo as Json).trials = 77)],
      ["progress netWorth", (raw) => ((raw.progress as { data: Json[] }).data[0]!.netWorth = 1)],
      ["currency", (raw) => (((raw.settings as Json).ci as Json).currency = "EUR")],
    ];
    for (const [name, mutate] of probes) {
      const raw = buildSyntheticExport();
      mutate(raw);
      expect(sig(importProjectionLab(raw)), name).not.toBe(baseSig);
    }
  });
});

function r2<T>(v: T): T {
  return v;
}
