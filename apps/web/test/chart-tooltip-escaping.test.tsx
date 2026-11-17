/**
 * Chart tooltips are HTML strings (ECharts sets them with innerHTML). Names typed by a person (milestones,
 * income, expenses) must be escaped there, or a name like `<img src=x onerror=…>` runs in the browser of
 * everyone who hovers the chart: other members of the workspace, or whoever imports the file.
 */
import { buildSimulationInput, simulate } from "@glideworth/core";
import { createSampleDocument } from "@glideworth/core/samples";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { tooltipRow } from "../src/components/charts/tokens";
import { buildEntityIndex } from "../src/features/results/model";
import { ProjectionChart } from "../src/features/results/projection-chart";

const setOption = vi.fn();
vi.mock("../src/components/charts/echarts-runtime", () => ({
  init: () => ({
    resize: vi.fn(),
    setOption,
    on: vi.fn(),
    off: vi.fn(),
    dispose: vi.fn(),
    getZr: () => ({ on: vi.fn(), off: vi.fn() }),
    getOption: () => ({}),
  }),
}));

const EVIL = `<img src=x onerror="alert(1)">`;

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as never;
  window.matchMedia ??= ((q: string) => ({
    matches: false,
    media: q,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    onchange: null,
    dispatchEvent: () => false,
  })) as never;
});
afterEach(() => {
  cleanup();
  setOption.mockReset();
});

type Formatter = (params: unknown) => string;

describe("projection chart tooltip", () => {
  it("escapes milestone, income and expense names in the life-event lines", async () => {
    const doc = createSampleDocument();
    const plan = doc.plans[0]!;
    for (const m of plan.milestones) m.name = EVIL;
    for (const i of plan.income) i.name = EVIL;
    for (const e of plan.expenses) e.name = EVIL;
    const result = simulate(buildSimulationInput(doc, plan.id));
    const index = buildEntityIndex(doc, plan);

    render(
      <ProjectionChart
        result={result}
        basis="nominal"
        locale="en-GB"
        currency="GBP"
        index={index}
        plan={plan}
      />,
    );
    await waitFor(() => expect(setOption).toHaveBeenCalled());
    const option = setOption.mock.calls.at(-1)![0] as { tooltip: { formatter: Formatter } };
    const html = result.periods
      .map((_, dataIndex) =>
        option.tooltip.formatter([
          {
            dataIndex,
            seriesName: "x",
            value: 0,
            color: "#000",
            seriesType: "bar",
            seriesIndex: 0,
          },
        ]),
      )
      .join("");
    // The names do reach the tooltip (escaped), so the check below is not vacuous.
    expect(html).toContain("&#60;img src=x onerror=&#34;alert(1)&#34;&#62;");
    expect(html).not.toContain("<img");
  });

  it("escapes the people's names in the milestone-flag tooltip", async () => {
    const doc = createSampleDocument();
    for (const p of doc.household.people) p.name = EVIL;
    const plan = doc.plans[0]!;
    const result = simulate(buildSimulationInput(doc, plan.id));
    const index = buildEntityIndex(doc, plan);

    render(
      <ProjectionChart
        result={result}
        basis="nominal"
        locale="en-GB"
        currency="GBP"
        index={index}
        plan={plan}
      />,
    );
    await waitFor(() => expect(setOption).toHaveBeenCalled());
    const option = setOption.mock.calls.at(-1)![0] as {
      series: { data?: unknown[]; tooltip?: { formatter?: Formatter } }[];
    };
    const flags = option.series.filter((s) => typeof s.tooltip?.formatter === "function");
    expect(flags.length).toBeGreaterThan(0);
    const html = flags
      .flatMap((s) =>
        (s.data ?? []).map((_, dataIndex) => s.tooltip!.formatter!({ name: "Flag", dataIndex })),
      )
      .join("");
    expect(html).toContain("&#60;img");
    expect(html).not.toContain("<img");
  });
});

describe("tooltip rows", () => {
  it("escape the value as well as the label", () => {
    const row = tooltipRow(null, "Action", EVIL);
    expect(row).not.toContain("<img");
    expect(row).toContain("&#60;img");
  });
});
