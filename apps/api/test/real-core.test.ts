/**
 * Real @glideworth/core and @glideworth/importers implementations (no fakes): one or more tests per group of
 * endpoints that used to answer 501 before the engine landed. Jobs run in-process on the real engine.
 */
import { createUkSampleDocument } from "@glideworth/core/samples";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Harness, READ_KEY, setup } from "./helpers.js";

let h: Harness;
beforeAll(() => {
  h = setup({ realEngine: true });
  h.services.households.importDocument(createUkSampleDocument(), { kind: "system", label: "test" });
});
afterAll(() => h.close());

const P = "/api/v1/plans/plan-main";
const MC = { trials: 100, seed: 7 };
// oxlint-disable-next-line typescript/no-explicit-any -- API payloads are untyped JSON that tests probe freely
const post = <T = Record<string, any>>(path: string, body: unknown = {}, key?: string) =>
  h.call<T>(path, { method: "POST", body, ...(key ? { key } : {}) });

describe("insights on the real engine", () => {
  it("explains the projection, a single year and a range of years", async () => {
    const e = await post<{ headline: string; findings: unknown[] }>(`${P}/insights/explain`, {});
    expect(e.status).toBe(200);
    expect(e.json.headline).toMatch(/plan/i);

    const year = await post(`${P}/insights/explain-year`, { year: 2040 });
    expect(year.status).toBe(200);
    expect(year.json).toMatchObject({ year: 2040, basis: "real" });
    expect(year.json.sentences.length).toBeGreaterThan(1);
    expect(year.json.evidence).toBeUndefined(); // summary drops the evidence
    const full = await post(`${P}/insights/explain-year`, { year: 2040, detail: "full" });
    expect(full.json.evidence.length).toBeGreaterThan(0);
    expect((await post(`${P}/insights/explain-year`, { year: 1900 })).status).toBe(404);
    expect((await post(`${P}/insights/explain-year`, {})).status).toBe(400);

    const years = await post(`${P}/insights/explain-years`, {
      fromYear: 2030,
      toYear: 2050,
      everyNYears: 10,
    });
    expect(years.json.years.map((y: { year: number }) => y.year)).toEqual([2030, 2040, 2050]);
  });

  it("audits assumptions (static plus result-based findings) with severity counts", async () => {
    const a = await post(`${P}/insights/audit`);
    expect(a.status).toBe(200);
    expect(Array.isArray(a.json.findings)).toBe(true);
    const total = Object.values(a.json.counts as Record<string, number>).reduce((s, n) => s + n, 0);
    expect(total).toBe(a.json.findings.length);
  });

  it("runs a deterministic sensitivity analysis", async () => {
    const s = await post(`${P}/insights/sensitivity`, {});
    expect(s.status).toBe(200);
    expect(s.json.metric).toBe("endNetWorthReal");
    expect(s.json.bars.length).toBeGreaterThan(2);
    const swings = s.json.bars.map((b: { swing: number }) => b.swing);
    expect(swings).toEqual([...swings].sort((a, b) => b - a));
  });

  it("explains the difference between two plans and attributes it to individual edits", async () => {
    const r = await post(`${P}/insights/explain-difference`, { otherPlanId: "plan-early" });
    expect(r.status).toBe(200);
    expect(r.json.changeCount).toBeGreaterThan(0);
    expect(r.json.explanation.headline).toBeTruthy();
    expect(r.json.attribution.contributions.length).toBeGreaterThan(0);
    expect(r.json.attribution).toMatchObject({ metric: "endNetWorthReal" });
    expect(r.json.attribution.contributions[0].delta).toEqual(expect.any(Number));
    const light = await post(`${P}/insights/explain-difference`, {
      otherPlanId: "plan-early",
      attribute: false,
    });
    expect(light.json.attribution).toBeUndefined();
  });

  it("attributes a success-rate difference through an async job", async () => {
    const r = await post(`${P}/insights/explain-difference?wait=60`, {
      otherPlanId: "plan-early",
      metric: "successRate",
      monteCarlo: MC,
    });
    expect([200, 202]).toContain(r.status);
    const job = r.status === 200 ? r.json : await h.services.jobs.waitFor(r.json.id, 60_000);
    expect(job.status).toBe("succeeded");
    const res = (await h.call(`/api/v1/jobs/${job.id}/result`)).json;
    expect(res.metric).toBe("successRate");
  }, 60_000);

  it("Guyton-Klinger guardrails in money terms, with plan defaults and explicit inputs", async () => {
    const g = await post(`${P}/insights/guyton-klinger`, {});
    expect(g.status).toBe(200);
    expect(g.json.upperRateLimit).toBeGreaterThan(g.json.lowerRateLimit);
    expect(["hold", "cut", "raise"]).toContain(g.json.action);
    const explicit = await post(`${P}/insights/guyton-klinger`, {
      portfolio: 1_000_000,
      spending: 70_000,
      initialRate: 0.05,
    });
    expect(explicit.json).toMatchObject({ action: "cut", currentRate: 0.07, initialRate: 0.05 });
  });
});

describe("what-if templates and survivor scenarios", () => {
  it("lists the templates with a parameter schema each", async () => {
    const r = await h.call<{ items: { id: string; paramsSchema: { properties: object } }[] }>(
      "/api/v1/scenarios/templates",
      { key: READ_KEY },
    );
    expect(r.status).toBe(200);
    expect(r.json.items.map((t) => t.id)).toEqual(
      expect.arrayContaining(["market-crash", "job-loss", "early-retirement", "survivor"]),
    );
    expect(r.json.items.every((t) => t.paramsSchema?.properties)).toBe(true);
  });

  it("previews a template without storing anything, then instantiates it as a branch", async () => {
    const before = h.services.plans.list({ householdId: "hh-uk-sample" }).length;
    const prev = await post("/api/v1/plans/uk-plan-main/scenarios/early-retirement/preview", {
      params: { years: 2 },
    });
    expect(prev.status).toBe(200);
    expect(prev.json.ops.length).toBeGreaterThan(0);
    expect(prev.json.before.endNetWorthReal).not.toBe(prev.json.after.endNetWorthReal);
    expect(h.services.plans.list({ householdId: "hh-uk-sample" }).length).toBe(before);

    // A read key may preview but not create the branch.
    expect(
      (
        await post(
          "/api/v1/plans/uk-plan-main/scenarios/early-retirement/preview",
          { params: { years: 2 } },
          READ_KEY,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await post(
          "/api/v1/plans/uk-plan-main/scenarios/early-retirement/branch",
          { params: { years: 2 } },
          READ_KEY,
        )
      ).status,
    ).toBe(403);

    const b = await post("/api/v1/plans/uk-plan-main/scenarios/early-retirement/branch", {
      params: { years: 2 },
      name: "Two years earlier",
    });
    expect(b.status).toBe(201);
    expect(b.json).toMatchObject({
      name: "Two years earlier",
      lineage: { parentPlanId: "uk-plan-main" },
    });
    expect(h.services.plans.get("uk-plan-main").version).toBe(1); // parent untouched
  });

  it("rejects unknown templates (404) and bad parameters (400)", async () => {
    expect((await post(`${P}/scenarios/nope/preview`, {})).status).toBe(404);
    expect(
      (await post(`${P}/scenarios/market-crash/preview`, { params: { year: "soon" } })).status,
    ).toBe(400);
  });

  it("survivor scenarios for a couple, evaluated; none for a single person", async () => {
    const r = await h.call<{ scenarios: { id: string; before?: unknown; after?: unknown }[] }>(
      `${P}/scenarios/survivor?ages=70,80&evaluate=true`,
    );
    expect(r.status).toBe(200);
    expect(r.json.scenarios.length).toBe(4); // two partners x two ages
    expect(r.json.scenarios[0]).toMatchObject({
      before: expect.any(Object),
      after: expect.any(Object),
    });
    const single = await h.call<{ scenarios: unknown[] }>(
      "/api/v1/plans/uk-plan-main/scenarios/survivor",
    );
    expect(single.json.scenarios).toEqual([]);
  });
});

describe("solvers and guardrails as jobs on the real engine", () => {
  const run = async (path: string, body: unknown, plan = P) => {
    const r = await post(`${plan}/${path}?wait=100`, body);
    expect([200, 202]).toContain(r.status);
    const job = r.status === 200 ? r.json : await h.services.jobs.waitFor(r.json.id, 100_000);
    return {
      job,
      result:
        job.status === "succeeded" ? (await h.call(`/api/v1/jobs/${job.id}/result`)).json : null,
    };
  };
  const small = { monteCarlo: MC, maxEvaluations: 5 };

  it("max spending, earliest retirement, required savings, required portfolio", async () => {
    const spend = await run("solve/max-spending", { targetSuccessRate: 0.8, ...small });
    expect(spend.job.status).toBe("succeeded");
    expect(spend.result).toMatchObject({ value: expect.any(Number), status: expect.any(String) });
    const retire = await run("solve/earliest-retirement", {
      milestoneId: "ms-retire",
      targetSuccessRate: 0.8,
      ...small,
    });
    expect(retire.job.status).toBe("succeeded");
    const savings = await run("solve/required-savings", {
      flowId: "fl-401k",
      targetSuccessRate: 0.8,
      ...small,
    });
    expect(savings.job.status).toBe("succeeded");
    const portfolio = await run("solve/required-portfolio", { targetSuccessRate: 0.8, ...small });
    expect(portfolio.job.status).toBe("succeeded");
  }, 120_000);

  it("safe withdrawal rate and a generic goal seek", async () => {
    const swr = await run("solve/safe-withdrawal-rate", {
      targetSuccessRate: 0.8,
      years: 30,
      ...small,
    });
    expect(swr.job.status).toBe("succeeded");
    expect(JSON.stringify(swr.result)).toMatch(/value|converged/);
    const gs = await run("solve/goal-seek", {
      variable: { kind: "spendingScale" },
      objective: { kind: "noShortfall" },
      direction: "maximize",
      bounds: { min: 0.5, max: 2 },
      maxEvaluations: 8,
    });
    expect(gs.job.status).toBe("succeeded");
  }, 120_000);

  it("risk-based guardrails (needs guardrails on the plan or in the request)", async () => {
    const none = await post(`${P}/insights/guardrails`, {});
    expect(none.status).toBe(400);
    const g = await run("insights/guardrails", {
      guardrails: { enabled: true, start: { kind: "planStart", offsetMonths: 0 } },
      monteCarlo: MC,
    });
    expect(g.job.status).toBe("succeeded");
    expect(g.result).toMatchObject({
      current: { action: expect.stringMatching(/hold|cut|raise/) },
    });
  }, 120_000);

  it("optimises the tax strategy for the UK sample and compares custom candidates", async () => {
    const o = await run(
      "solve/tax-strategy",
      { objective: "lifetimeTaxesReal" },
      "/api/v1/plans/uk-plan-main",
    );
    expect(o.job.status).toBe("succeeded");
    expect(o.result.ranked.length).toBeGreaterThan(1);
    expect(o.result.baseline.status).toBe("ok");
    const custom = await run(
      "solve/tax-strategy",
      {
        candidates: [
          {
            id: "sipp-first",
            label: "Draw SIPP first",
            description: "",
            patch: [
              {
                op: "replace",
                path: "/drawdown/order",
                value: [
                  { kind: "category", category: "cash" },
                  { kind: "category", category: "tax-deferred" },
                  { kind: "category", category: "taxable" },
                ],
              },
            ],
          },
        ],
      },
      "/api/v1/plans/uk-plan-main",
    );
    expect(custom.result.ranked.map((r: { id: string }) => r.id)).toContain("sipp-first");
  }, 120_000);
});

describe("exports and CSV import on the real importers", () => {
  it("exports projection tables as JSON and CSV, progress history and report data", async () => {
    const t = await h.call(`${P}/export/tables/year-by-year?basis=real`);
    expect(t.status).toBe(200);
    expect(t.json.columns.map((c: { key: string }) => c.key)).toEqual(
      expect.arrayContaining(["year", "netWorth"]),
    );
    expect(t.json.rows.length).toBeGreaterThan(10);
    const csv = await h.call(`${P}/export/tables/taxes?format=csv`);
    expect(csv.status).toBe(200);
    expect(csv.headers.get("content-type")).toContain("text/csv");
    expect(csv.text.split("\n")[0]).toContain("Year");
    expect((await h.call(`${P}/export/tables/bogus`)).status).toBe(404);

    const progress = await h.call<{ rows: unknown[] }>(
      "/api/v1/households/hh-sample/export/progress",
    );
    expect(progress.json.rows.length).toBe(2);
    expect(
      (await h.call("/api/v1/households/hh-sample/export/progress?format=csv")).text,
    ).toContain("Net worth");

    const report = await h.call(`${P}/report?tableEvery=10`);
    expect(report.status).toBe(200);
    expect(report.json).toMatchObject({ plan: { id: "plan-main" }, basis: "real" });
    expect(report.json.caveats.length).toBeGreaterThan(0);
    expect(report.json.keyFigures.length).toBeGreaterThan(2);
  });

  const BALANCES =
    "Account,Balance,Date\nHigh-yield savings,31000,2026-11-15\nCar loan,11000,2026-11-15\nMystery,5,2026-11-15\n";

  it("previews a balances CSV (dry run is the default and writes nothing), then applies it atomically", async () => {
    const preview = await post("/api/v1/households/hh-sample/import/csv", {
      text: BALANCES,
      kind: "account-balances",
    });
    expect(preview.status).toBe(200);
    expect(preview.json).toMatchObject({ dryRun: true, applied: false });
    expect(preview.json.reconciliation.matched.map((m: { id: string }) => m.id)).toEqual(
      expect.arrayContaining(["acc-cash", "debt-car"]),
    );
    expect(preview.json.reconciliation.unmatched).toHaveLength(1);
    expect((await h.call("/api/v1/households/hh-sample/accounts/acc-cash")).json.balance).toBe(
      28_500,
    );

    const applied = await post("/api/v1/households/hh-sample/import/csv", {
      text: BALANCES,
      kind: "account-balances",
      dryRun: false,
    });
    expect(applied.json).toMatchObject({ applied: true, changes: { finances: true } });
    expect((await h.call("/api/v1/households/hh-sample/accounts/acc-cash")).json.balance).toBe(
      31_000,
    );
    expect((await h.call("/api/v1/households/hh-sample/debts/debt-car")).json.balance).toBe(11_000);
  });

  it("imports progress history and refuses a file with blocking errors", async () => {
    const hist = "Date,Net worth\n2024-01-01,500000\n2024-06-01,540000\n";
    const r = await post("/api/v1/households/hh-sample/import/csv", {
      text: hist,
      kind: "progress-snapshots",
      dryRun: false,
    });
    expect(r.status).toBe(200);
    expect(r.json.changes.snapshots.created).toBe(2);
    const list = await h.call<{ items: { date: string }[] }>(
      "/api/v1/households/hh-sample/snapshots?limit=50",
    );
    expect(list.json.items.map((s) => s.date)).toEqual(
      expect.arrayContaining(["2024-01-01", "2024-06-01"]),
    );

    const bad = await post("/api/v1/households/hh-sample/import/csv", {
      text: "foo,bar\n1,2\n",
      kind: "progress-snapshots",
      dryRun: false,
    });
    expect(bad.status).toBe(422);
    expect(bad.json.error.code).toBe("IMPORT_FAILED");
    const analyze = await post("/api/v1/households/hh-sample/import/csv/analyze", {
      text: hist,
      kind: "progress-snapshots",
    });
    expect(analyze.json).toMatchObject({ kind: "progress-snapshots", rowCount: 2 });
  });

  it("summarises transactions into annual expense events on a plan", async () => {
    const tx = ["Date,Description,Amount,Category"];
    for (let m = 1; m <= 12; m++)
      tx.push(`2025-${String(m).padStart(2, "0")}-05,Shop,-${400 + m},Groceries`);
    const dry = await post("/api/v1/households/hh-sample/import/csv", {
      text: tx.join("\n"),
      kind: "transactions",
      planId: "plan-early",
    });
    expect(dry.status).toBe(200);
    expect(dry.json.summary).toBeTruthy();
    expect(
      (
        await post("/api/v1/households/hh-sample/import/csv", {
          text: tx.join("\n"),
          kind: "transactions",
        })
      ).status,
    ).toBe(400);
    const before = h.services.plans.get("plan-early").version;
    const applied = await post("/api/v1/households/hh-sample/import/csv", {
      text: tx.join("\n"),
      kind: "transactions",
      planId: "plan-early",
      dryRun: false,
    });
    expect(applied.status).toBe(200);
    expect(h.services.plans.get("plan-early").version).toBe(before + 1);
  });
});

describe("core PatchConflictError is a 409", () => {
  it("maps PATCH_CONFLICT for a patch op whose target is missing", async () => {
    const r = await h.call(`${P}`, {
      method: "PATCH",
      headers: { "content-type": "application/json-patch+json" },
      body: [{ op: "replace", path: "/expenses/[id=does-not-exist]/amount/value", value: 1 }],
    });
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe("PATCH_CONFLICT");
    const test = await h.call(`${P}`, {
      method: "PATCH",
      headers: { "content-type": "application/json-patch+json" },
      body: [{ op: "test", path: "/name", value: "definitely not the name" }],
    });
    expect(test.status).toBe(409);
  });
});

describe("a retired dataset named in a request", () => {
  const warnings = (r: { json: Record<string, unknown> }) =>
    (r.json.warnings ?? []) as Array<{ code: string; refs?: string[] }>;

  it.each(["uk-1871", "us-1871"] as const)(
    "%s runs on its replacement and the result carries DATASET_REPLACED",
    async (dataset) => {
      const job = await post(`${P}/monte-carlo?wait=100`, {
        settings: { trials: 50, seed: 3, dataset },
      });
      const r = await h.call(`/api/v1/jobs/${job.json.id}/result`);
      expect(r.status).toBe(200);
      const replaced = warnings(r).filter((w) => w.code === "DATASET_REPLACED");
      expect(replaced).toHaveLength(1);
      expect(replaced[0]?.refs?.[0]).toBe(dataset);
      expect(replaced[0]?.refs?.[1]).toBe(dataset === "uk-1871" ? "uk-1983" : "us-1928");
    },
  );

  it("a current dataset gets no notice", async () => {
    const job = await post(`${P}/monte-carlo?wait=100`, {
      settings: { trials: 50, seed: 3, dataset: "us-1928" },
    });
    const r = await h.call(`/api/v1/jobs/${job.json.id}/result`);
    expect(r.status).toBe(200);
    expect(warnings(r).some((w) => w.code === "DATASET_REPLACED")).toBe(false);
  });
});
