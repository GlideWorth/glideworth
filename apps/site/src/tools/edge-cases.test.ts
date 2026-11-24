/**
 * Edge cases and a seeded sweep over random valid inputs: no input may produce NaN or Infinity in a
 * result, a chart or the rendered HTML.
 */
import { createRng } from "@glideworth/core";
import { describe, expect, it } from "vitest";
import { chartSvg } from "./chart";
import { runTool } from "./engine";
import { esc } from "./format";
import { renderResults } from "./render";
import { SPECS } from "./specs";
import { defaults, validate } from "./state";
import type { ToolId, ToolSpec, Values, ViewModel } from "./types";

/** Every number anywhere in the view model is finite (null is allowed for gaps in a series). */
function nonFinitePaths(x: unknown, path = "vm"): string[] {
  if (typeof x === "number") return Number.isFinite(x) ? [] : [path];
  if (Array.isArray(x)) return x.flatMap((v, i) => nonFinitePaths(v, `${path}[${i}]`));
  if (x && typeof x === "object")
    return Object.entries(x).flatMap(([k, v]) => nonFinitePaths(v, `${path}.${k}`));
  return [];
}

function expectClean(vm: ViewModel, label: string) {
  expect(nonFinitePaths(vm), label).toEqual([]);
  const html = renderResults(vm);
  expect(html, label).not.toMatch(/NaN|Infinity|undefined|\[object Object\]/);
  expect(vm.headline.length, label).toBeGreaterThan(10);
}

async function run(id: ToolId, over: Values): Promise<ViewModel> {
  const spec = SPECS[id];
  const v = {
    ...defaults(spec),
    ...(spec.mode === "simulation" ? { trials: "500" } : {}),
    ...over,
  };
  expect(validate(spec, v), `${id} ${JSON.stringify(over)} should be valid`).toEqual({});
  const vm = await runTool(id, v);
  expectClean(vm, `${id} ${JSON.stringify(over)}`);
  return vm;
}

describe("edge cases", () => {
  it("zero balance", async () => {
    await run("coast-fire", { balance: 0 });
    await run("fire", { balance: 0 });
    await run("fat-fire", { balance: 0 });
    const h = await run("how-long", { balance: 0 });
    expect(h.headline).toMatch(/nothing to withdraw/);
    const m = await run("monte-carlo", { balance: 0 });
    expect(m.figures[0]!.value).toBe("0.0%");
    await run("withdrawal", { balance: 0 });
  });

  it("zero return", async () => {
    const c = await run("coast-fire", { ret: 0 });
    expect(c.figures[1]!.value).toBe("$1,000,000");
    const h = await run("how-long", { ret: 0 });
    expect(h.figures[0]!.value).toBe("16.7 years");
    await run("fire", { ret: 0 });
    await run("fat-fire", { ret: 0 });
    await run("barista-fire", { ret: 0 });
    await run("monte-carlo", { method: "parametric", mean: 0, vol: 0 });
  });

  it("already financially independent", async () => {
    const c = await run("coast-fire", { balance: 5_000_000 });
    expect(c.headline).toMatch(/You have reached Coast FIRE/);
    const f = await run("fire", { balance: 2_000_000 });
    expect(f.headline).toMatch(/already have/);
    const fat = await run("fat-fire", { balance: 20_000_000 });
    expect(fat.headline).toMatch(/already have/);
    expect(fat.figures[1]!.value).toBe("Already there");
    expect(f.figures[1]!.value).toBe("Already there");
    const h = await run("how-long", { balance: 10_000_000 });
    expect(h.headline).toMatch(/does not run out/);
  });

  it("withdrawals larger than the balance", async () => {
    const h = await run("how-long", { balance: 10_000, spend: 50_000 });
    expect(h.figures[0]!.value).toBe("0.2 years");
    const m = await run("monte-carlo", { balance: 10_000, spend: 50_000 });
    expect(m.figures[0]!.value).toBe("0.0%");
    await run("withdrawal", { balance: 1000, rate: 15 });
  });

  it("very long horizons", async () => {
    await run("coast-fire", { age: 16, retire: 96 });
    await run("fire", { age: 16, save: 1, ret: -10 });
    await run("fat-fire", { age: 16, save: 1, ret: -10 });
    await run("barista-fire", { age: 30, ptUntil: 31, planTo: 110 });
    await run("how-long", { ret: 6.5, spend: 1 });
    await run("monte-carlo", { years: 70 });
    await run("withdrawal", { years: 60, method: "history" });
  });

  it("negative real returns", async () => {
    const c = await run("coast-fire", { ret: -3 });
    expect(c.warnings.join(" ")).toMatch(/0% or less/);
    const h = await run("how-long", { ret: -5 });
    expect(Number.parseFloat(h.figures[0]!.value)).toBeLessThan(500_000 / 30_000);
    await run("barista-fire", { ret: -5 });
    await run("fire", { ret: -10, save: 0 });
    await run("fat-fire", { ret: -10, save: 0 });
    await run("monte-carlo", { method: "parametric", mean: -5, vol: 30 });
  });

  it("nothing to spend", async () => {
    await run("coast-fire", { spend: 0 });
    await run("fire", { spend: 0 });
    const fat = await run("fat-fire", { spend: 0 });
    expect(fat.headline).toMatch(/number is 0/);
    await run("barista-fire", { spend: 0, pt: 0 });
    await run("how-long", { spend: 0 });
    await run("monte-carlo", { spend: 0 });
  });

  it("part-time pay above spending is saved, and a flat tax is applied", async () => {
    await run("barista-fire", { pt: 60_000 });
    await run("barista-fire", { tax: 45 });
    await run("how-long", { tax: 60 });
    await run("withdrawal", { tax: 30 });
  });
});

describe("seeded sweep over random valid inputs", () => {
  const rng = createRng(20261116);
  function fewestTrials(spec: ToolSpec): string {
    const field = spec.fields.find((f) => f.key === "trials");
    if (field?.kind !== "select") return "500";
    return field.options.map((o) => o.value).sort((a, b) => Number(a) - Number(b))[0]!;
  }
  function randomValues(spec: ToolSpec): Values {
    for (let attempt = 0; attempt < 50; attempt++) {
      const v = defaults(spec);
      for (const f of spec.fields) {
        if (f.kind === "select")
          v[f.key] = f.options[Math.floor(rng.next() * f.options.length)]!.value;
        else {
          // Money spans orders of magnitude: sample its logarithm.
          const x =
            f.unit === "money"
              ? rng.next() < 0.1
                ? 0
                : 10 ** (rng.next() * 7)
              : f.min + rng.next() * (f.max - f.min);
          v[f.key] = f.step >= 1 ? Math.round(x) : Number(x.toFixed(2));
        }
      }
      // Whether a result is finite does not depend on how many simulations it ran, so use the fewest
      // the form offers (500, or 250 for retirement spending, whose every input is a solve).
      if (spec.mode === "simulation") v.trials = fewestTrials(spec);
      if (Object.keys(validate(spec, v)).length === 0) return v;
    }
    return defaults(spec);
  }
  // Each input to these two is a solve over many simulations, so they sample fewer, one test per input
  // (a single solve can take most of a minute on a CI runner); their own edge cases are in
  // drawdown-tools.test.ts.
  const SOLVES: readonly ToolId[] = ["guardrails", "retirement-spending"];
  async function expectFinite(id: ToolId, v: Values) {
    expectClean(await runTool(id, v), `${id} ${JSON.stringify(v)}`);
  }
  for (const spec of Object.values(SPECS)) {
    const solve = SOLVES.includes(spec.id);
    const inputs = Array.from({ length: solve ? 3 : 12 }, () => randomValues(spec));
    if (solve)
      inputs.forEach((v, i) =>
        it(
          `${spec.id}: random input ${i + 1} of ${inputs.length} gives finite results`,
          () => expectFinite(spec.id, v),
          120_000,
        ),
      );
    else
      it(`${spec.id}: ${inputs.length} random inputs give finite results`, async () => {
        for (const v of inputs) await expectFinite(spec.id, v);
      }, 120_000);
  }
});

describe("charts and rendering", () => {
  it("a chart with gaps, a single point and an all-zero series draws without NaN", () => {
    const svg = chartSvg({
      id: "t",
      kind: "line",
      title: "T",
      summary: "S",
      xLabel: "Age",
      yLabel: "Money",
      x: [40],
      series: [
        { label: "a", values: [0], tone: 1, style: "solid" },
        { label: "b", values: [null], tone: 2, style: "dashed" },
      ],
      currency: "EUR",
      table: { caption: "c", columns: [], rows: [] },
    });
    expect(svg).not.toMatch(/NaN|Infinity/);
    expect(svg).toContain('role="img"');
  });
  it("escapes text in titles, labels and tables", () => {
    expect(esc("<script>\"x\" & 'y'</script>")).toBe(
      "&lt;script&gt;&quot;x&quot; &amp; &#39;y&#39;&lt;/script&gt;",
    );
    const html = renderResults({
      tool: "fire",
      headline: "<img src=x onerror=alert(1)>",
      announce: "",
      figures: [{ label: "<b>", value: "1" }],
      charts: [],
      method: ["<i>"],
      warnings: [],
    });
    expect(html).not.toMatch(/<img|<b>|<i>/);
  });
});
