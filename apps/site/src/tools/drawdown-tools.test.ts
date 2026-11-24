/**
 * The guardrails, retirement spending and historical backtest calculators: answers checked against
 * their definitions and the engine, determinism, edge cases with no NaN or Infinity, the worker's
 * progress and cancel messages, and the path-group chart they draw.
 */
import { guytonKlingerGuardrails, MARKET_DATASETS } from "@glideworth/core";
import { describe, expect, it } from "vitest";
import { chartSvg } from "./chart";
import { runTool } from "./engine";
import { guardrails, RISK_DEFAULTS } from "./engine/guardrails";
import { backtest } from "./engine/historical-backtest";
import { HISTORY_DATASET } from "./engine/model";
import { aPct, maxSpending, spendDown } from "./engine/retirement-spending";
import { renderResults } from "./render";
import { SPECS } from "./specs";
import { defaults, validate } from "./state";
import type { ToolId, Values, ViewModel } from "./types";
import { handle } from "./worker/handle";
import type { WorkerResponse } from "./worker/protocol";

function nonFinite(x: unknown, path = "vm"): string[] {
  if (typeof x === "number") return Number.isFinite(x) ? [] : [path];
  if (Array.isArray(x)) return x.flatMap((v, i) => nonFinite(v, `${path}[${i}]`));
  if (x && typeof x === "object")
    return Object.entries(x).flatMap(([k, v]) => nonFinite(v, `${path}.${k}`));
  return [];
}

async function clean(id: ToolId, over: Values): Promise<ViewModel> {
  const v = { ...defaults(SPECS[id]), ...over };
  expect(validate(SPECS[id], v), JSON.stringify(over)).toEqual({});
  const vm = await runTool(id, v);
  expect(nonFinite(vm), `${id} ${JSON.stringify(over)}`).toEqual([]);
  expect(renderResults(vm)).not.toMatch(/NaN|Infinity|undefined|\[object Object\]/);
  expect(vm.headline.length).toBeGreaterThan(10);
  return vm;
}

const gr = defaults(SPECS.guardrails);
const rs = { ...defaults(SPECS["retirement-spending"]), trials: "250" };
const bt = defaults(SPECS["historical-backtest"]);
const firstYear = Number(MARKET_DATASETS[HISTORY_DATASET].label.match(/\d{4}/)![0]);

describe("guardrails calculator", () => {
  it("Guyton-Klinger thresholds are spending over the rate limits, with the visitor's band and step", async () => {
    const a = await guardrails({ ...gr, spend: 50_000, band: 25, adj: 15 });
    // 5% initial rate, ±25%: 6.25% and 3.75%.
    expect(a.gk.cutBelowPortfolio).toBeCloseTo(50_000 / 0.0625, 6);
    expect(a.gk.raiseAbovePortfolio).toBeCloseTo(50_000 / 0.0375, 6);
    expect(a.gk.spendingAfterCut).toBeCloseTo(42_500, 6);
    expect(a.gk.spendingAfterRaise).toBeCloseTo(57_500, 6);
    expect(a.gk.action).toBe("hold");
    expect(a.gk).toEqual(
      guytonKlingerGuardrails({
        portfolio: 1_000_000,
        spending: 50_000,
        guardrail: 0.25,
        adjustment: 0.15,
        yearsRemaining: 30,
        currency: "USD",
      }),
    );
  }, 60_000);

  it("risk-based guardrails: hold inside the band, raise above it, and thresholds bracket the portfolio", async () => {
    const hold = await guardrails(gr);
    const s0 = hold.risk.currentSuccessRate!;
    expect(s0).toBeGreaterThanOrEqual(RISK_DEFAULTS.lowerGuardrail);
    expect(s0).toBeLessThanOrEqual(RISK_DEFAULTS.upperGuardrail);
    expect(hold.risk.current.action).toBe("hold");
    const t = hold.risk.thresholds!;
    expect(t.recommendedSpending).toBe(50_000);
    expect(t.lowerPortfolio!).toBeLessThan(1_000_000);
    expect(t.upperPortfolio!).toBeGreaterThan(1_000_000);
    expect(t.cutTo!).toBeLessThan(50_000);
    expect(t.raiseTo!).toBeGreaterThan(50_000);

    const raise = await guardrails({ ...gr, spend: 30_000 });
    expect(raise.risk.current.action).toBe("raise");
    expect(raise.risk.thresholds!.recommendedSpending).toBeGreaterThan(30_000);
  }, 60_000);

  it("history: every start year once, the bad sequence is constant spending's worst, guardrails cut instead of running out", async () => {
    const a = await guardrails(gr);
    const n = a.history.constant.length;
    expect(n).toBe(98 - 30 + 1);
    expect(a.history.constant[0]!.startYear).toBe(firstYear);
    for (const runs of Object.values(a.history)) {
      expect(runs).toHaveLength(n);
      for (const r of runs) expect(r.portfolio).toHaveLength(31);
    }
    const bad = a.history.constant.find((r) => r.startYear === a.bad)!;
    for (const r of a.history.constant) {
      const fb = bad.firstShortYear ?? 99;
      const fr = r.firstShortYear ?? 99;
      expect(fb < fr || (fb === fr && bad.end <= r.end)).toBe(true);
    }
    // Guyton-Klinger's first year is the spending entered; risk-based starts from its spending now.
    expect(a.history.gk[0]!.spending[0]).toBeCloseTo(50_000, 0);
    const gkBad = a.history.gk.find((r) => r.startYear === a.bad)!;
    expect(gkBad.minSpending).toBeLessThan(50_000);
    expect(gkBad.end).toBeGreaterThan(bad.end);
  }, 60_000);

  it("is reproducible, and the seed only moves the risk-based part", async () => {
    const [a, b, c] = await Promise.all([
      runTool("guardrails", gr),
      runTool("guardrails", gr),
      guardrails({ ...gr, seed: 7 }),
    ]);
    expect(a).toEqual(b);
    const base = await guardrails(gr);
    expect(c.gk).toEqual(base.gk);
    expect(c.history.constant).toEqual(base.history.constant);
    expect(c.risk.currentSuccessRate).not.toBe(base.risk.currentSuccessRate);
  }, 90_000);

  it("validates the risk band around the target", () => {
    expect(validate(SPECS.guardrails, { ...gr, lower: 85 }).lower).toBeDefined();
    expect(validate(SPECS.guardrails, { ...gr, upper: 75 }).upper).toBeDefined();
  });

  it("edge cases give finite results", async () => {
    expect((await clean("guardrails", { balance: 0 })).headline).toMatch(/nothing to withdraw/);
    expect((await clean("guardrails", { spend: 0 })).headline).toMatch(/no spending/);
    await clean("guardrails", { spend: 400_000 });
    await clean("guardrails", { years: 10 });
    await clean("guardrails", { spend: 5_000, target: 99, lower: 99, upper: 100 });
  }, 120_000);
});

describe("retirement spending calculator", () => {
  it("the answer meets the target on the same simulations, and 1% more does not", async () => {
    const a = await maxSpending(rs);
    expect(a.spending).not.toBeNull();
    expect(a.atLimit).toBe(false);
    const at = await spendDown(rs, a.spending!);
    expect(at.successRate).toBeGreaterThanOrEqual(0.85);
    expect(at.successRate).toBe(a.achieved);
    const more = await spendDown(rs, a.spending! * 1.01);
    expect(more.successRate).toBeLessThan(0.85);
  }, 60_000);

  it("spending falls as the chance rises, rises with a pension and falls with a longer plan", async () => {
    const [a, pension, longer] = await Promise.all([
      maxSpending(rs),
      maxSpending({ ...rs, inc: 20_000, incAge: 67 }),
      maxSpending({ ...rs, age: 55 }),
    ]);
    const levels = [
      ...a.neighbours.filter((x) => x.target < 0.85),
      { target: 0.85, spending: a.spending },
      ...a.neighbours.filter((x) => x.target > 0.85),
    ];
    expect(levels.map((x) => x.target)).toEqual([0.75, 0.8, 0.85, 0.9, 0.95]);
    for (let i = 1; i < levels.length; i++)
      expect(levels[i]!.spending!).toBeLessThanOrEqual(levels[i - 1]!.spending!);
    expect(pension.spending!).toBeGreaterThan(a.spending!);
    expect(longer.spending!).toBeLessThan(a.spending!);
  }, 90_000);

  it("zero volatility gives the deterministic answer: the level payment that spends the portfolio", async () => {
    const a = await maxSpending({
      ...rs,
      method: "parametric",
      mean: 0,
      vol: 0,
      age: 65,
      planTo: 85,
      timing: "start",
    });
    // No growth: 1,000,000 over 20 years is 50,000 a year, to the solver's tolerance.
    expect(a.spending!).toBeLessThanOrEqual(50_000 + 1e-6);
    expect(a.spending!).toBeGreaterThan(50_000 * 0.995);
  }, 60_000);

  it("is reproducible with a seed", async () => {
    expect(await runTool("retirement-spending", rs)).toEqual(
      await runTool("retirement-spending", rs),
    );
  }, 60_000);

  it("writes 'an' before 8, 11, 18 and the eighties", () => {
    expect(aPct(0.85)).toBe("an 85%");
    expect(aPct(0.9)).toBe("a 90%");
    expect(aPct(0.8)).toBe("an 80%");
    expect(aPct(0.75)).toBe("a 75%");
  });

  it("edge cases give finite results", async () => {
    expect((await clean("retirement-spending", { balance: 0, inc: 0 })).headline).toMatch(
      /nothing to spend/,
    );
    await clean("retirement-spending", { balance: 0, inc: 20_000, incAge: 65 });
    await clean("retirement-spending", { balance: 0, inc: 20_000, incAge: 70 });
    await clean("retirement-spending", { inc: 30_000, incAge: 100 });
    await clean("retirement-spending", { method: "parametric", mean: -5, vol: 30, target: 99 });
    await clean("retirement-spending", { age: 30, planTo: 100 });
  }, 120_000);
});

describe("historical backtest calculator", () => {
  it("replays every start year whose horizon fits in the data, in order", async () => {
    const b30 = await backtest(bt);
    expect(b30.runs.map((r) => r.startYear)).toEqual(
      Array.from({ length: 69 }, (_, i) => firstYear + i),
    );
    const b70 = await backtest({ ...bt, years: 70 });
    expect(b70.runs).toHaveLength(98 - 70 + 1);
  });

  it("4% constant real from a 60/40 portfolio over 30 years: the 1960s are the worst starts", async () => {
    const b = await backtest({ ...bt, timing: "start" });
    expect(b.lasted).toBeGreaterThan(b.runs.length * 0.8);
    expect(b.worst[0]!.startYear).toBeGreaterThanOrEqual(1960);
    expect(b.worst[0]!.startYear).toBeLessThanOrEqual(1970);
    // Constant spending pays the same real amount until it runs short.
    for (const r of b.runs)
      if (r.firstShortYear === null) for (const s of r.spending) expect(s).toBeCloseTo(40_000, 0);
  });

  it("a fixed percentage never runs short; spending rules start at spending ÷ portfolio", async () => {
    const p = await backtest({ ...bt, rule: "percent" });
    expect(p.lasted).toBe(p.runs.length);
    const g = await backtest({ ...bt, rule: "guardrails" });
    expect(g.firstYear).toBeCloseTo(40_000, 0);
    expect(g.lowestSpending).toBeLessThan(40_000);
  });

  it("is reproducible with no seed at all", async () => {
    expect(await runTool("historical-backtest", bt)).toEqual(
      await runTool("historical-backtest", bt),
    );
  });

  it("draws one line per start year as path groups, with one legend entry each", async () => {
    const vm = await runTool("historical-backtest", { ...bt, spend: 55_000 });
    const paths = vm.charts.find((c) => c.id === "bt-paths")!;
    const lines = (paths.paths ?? []).reduce((s, g) => s + g.lines.length, 0);
    expect(lines).toBe(69);
    expect(paths.paths).toHaveLength(2);
    const svg = chartSvg(paths);
    expect(svg.match(/tc-path/g)?.length).toBe(69);
    const html = renderResults(vm);
    expect(html).toContain("Ran short (");
    expect(html).not.toMatch(/NaN|Infinity/);
  });

  it("edge cases give finite results", async () => {
    expect((await clean("historical-backtest", { balance: 0 })).headline).toMatch(/nothing/);
    await clean("historical-backtest", { spend: 0 });
    await clean("historical-backtest", { spend: 2_000_000 });
    for (const rule of ["guardrails", "percent", "vpw"]) {
      await clean("historical-backtest", { rule, balance: 0 });
      await clean("historical-backtest", { rule, years: 70, stocks: 100 });
      await clean("historical-backtest", { rule, inc: 30_000, incFrom: 0, tax: 40 });
    }
  }, 60_000);
});

describe("worker protocol for the new calculators", () => {
  for (const [id, values] of [
    ["guardrails", gr],
    ["retirement-spending", rs],
    ["historical-backtest", bt],
  ] as [ToolId, Values][]) {
    it(`${id}: progress, then a result`, async () => {
      const out: WorkerResponse[] = [];
      await handle({ type: "run", id: 100, tool: id, values }, (r) => out.push(r));
      const dones = out.flatMap((r) => (r.type === "progress" ? [r.done] : []));
      expect(dones.length).toBeGreaterThan(0);
      expect([...dones].sort((a, b) => a - b)).toEqual(dones);
      for (const r of out) if (r.type === "progress") expect(r.done).toBeLessThanOrEqual(r.total);
      expect(out.at(-1)?.type).toBe("result");
    }, 60_000);
  }

  for (const [id, values] of [
    ["guardrails", gr],
    ["retirement-spending", rs],
  ] as [ToolId, Values][])
    it(`${id}: a cancel message stops the solver midway`, async () => {
      const out: WorkerResponse[] = [];
      let sent = false;
      await handle({ type: "run", id: 200, tool: id, values }, (r) => {
        out.push(r);
        if (r.type === "progress" && !sent) {
          sent = true;
          void handle({ type: "cancel", id: 200 }, () => {});
        }
      });
      expect(out.at(-1)?.type).toBe("cancelled");
    }, 60_000);

  it("historical-backtest: a cancel message stops a long replay", async () => {
    const out: WorkerResponse[] = [];
    let sent = false;
    await handle(
      { type: "run", id: 300, tool: "historical-backtest", values: { ...bt, years: 5 } },
      (r) => {
        out.push(r);
        if (r.type === "progress" && !sent) {
          sent = true;
          void handle({ type: "cancel", id: 300 }, () => {});
        }
      },
    );
    expect(out.at(-1)?.type).toBe("cancelled");
  });
});
