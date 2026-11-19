/**
 * Goal-seek curve (issue #58). The solver's search clusters evaluations near the answer, so a
 * category axis draws those points evenly and repeats rounded labels ("151%" four times). The
 * curve has to be a linear x-axis. The preview under the answer is a deterministic projection
 * and must say so, because it can show a shortfall while the Monte Carlo chance of success is
 * on target. The welcome tour has no anchor, so it must sit in a corner rather than over the chart.
 */
import { buildSimulationInput, simulate } from "@glideworth/core";
import { createSampleDocument } from "@glideworth/core/samples";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { SeriesChart } from "../src/components/charts/series-chart";
import { Tour } from "../src/components/layout/tour";
import { scaleExpenses } from "../src/features/insights/plan-edits";
import { PlanChangePreview, SOLVER_PROJECTION_NOTE } from "../src/features/insights/plan-preview";
import { usePrefs } from "../src/stores/prefs";

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

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => () => Promise.resolve(),
}));

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
  usePrefs.setState({ tour: null });
});

/** The max-spending search from the QA report: bounds at 0 and 4, a cluster around 1.51. */
const SPENDING_X = [
  0, 0.39, 0.48, 0.6, 0.92, 1.11, 1.19, 1.38, 1.45, 1.46, 1.47, 1.48, 1.5, 1.506, 1.508, 1.51,
  1.512, 1.52, 1.61, 1.73, 2.03, 2.36, 4,
];

const formatX = (v: number) => `${Math.round(v * 100)}%`;

type Axis = {
  type?: string;
  data?: string[];
  axisLabel?: { formatter?: (v: number) => string };
};
type Built = {
  xAxis: Axis;
  series: { data: (number | null)[] | [number, number | null][] }[];
  tooltip: { formatter: (params: unknown) => string };
};

async function chartOption(): Promise<Built> {
  await waitFor(() => expect(setOption).toHaveBeenCalled());
  return setOption.mock.calls.at(-1)![0] as Built;
}

describe("solver success curve", () => {
  it("plots evaluations on a linear axis, so clustered points are not repeated categories", async () => {
    const labels = SPENDING_X.map(formatX);
    // The old category labels: four different x values all round to "151%".
    expect(labels.filter((l) => l === "151%").length).toBe(4);

    render(
      <SeriesChart
        labels={labels}
        xValues={SPENDING_X}
        formatX={formatX}
        format="percent"
        locale="en-GB"
        height={160}
        ariaLabel="Success rate at each value the solver tried"
        refLines={[{ value: 0.9, label: "target" }]}
        series={[
          {
            name: "Chance of success",
            color: "#245",
            symbol: true,
            values: SPENDING_X.map((x) => Math.max(0, 1 - x / 4)),
          },
        ]}
      />,
    );

    const option = await chartOption();
    expect(option.xAxis.type).toBe("value");
    expect(option.xAxis.data).toBeUndefined();

    const data = option.series[0]!.data as [number, number][];
    expect(data.map((p) => p[0])).toEqual(SPENDING_X);
    // Spacing follows the value, not the evaluation index. The cluster is tight; the jump to the
    // upper bound is not the same width as the step before it.
    const cluster = data[16]![0] - data[15]![0];
    const jump = data[22]![0] - data[21]![0];
    expect(jump).toBeGreaterThan(cluster * 10);

    const fmt = option.xAxis.axisLabel?.formatter;
    expect(fmt).toBeTypeOf("function");
    const ticks = [0, 1, 2, 3, 4].map((t) => fmt!(t));
    expect(ticks).toEqual(["0%", "100%", "200%", "300%", "400%"]);
    expect(new Set(ticks).size).toBe(ticks.length);

    const html = option.tooltip.formatter([
      { dataIndex: 13, seriesIndex: 0, value: [1.506, 0.907], color: "#245" },
    ]);
    expect(html).toContain("151%");
    expect(html).toContain("90.7%");
  });

  it("keeps a category axis for evenly spaced series such as years", async () => {
    render(
      <SeriesChart
        labels={["2026", "2027", "2028"]}
        format="money"
        locale="en-GB"
        currency="GBP"
        ariaLabel="Net worth by year"
        series={[{ name: "Net worth", color: "#245", values: [1, 2, 3] }]}
      />,
    );
    const option = await chartOption();
    expect(option.xAxis.type).toBe("category");
    expect(option.xAxis.data).toEqual(["2026", "2027", "2028"]);
    expect(option.series[0]!.data).toEqual([1, 2, 3]);
  });
});

describe("solver answer card", () => {
  it("labels the preview as the deterministic projection, separate from Monte Carlo", async () => {
    const doc = createSampleDocument();
    const plan = doc.plans[0]!;
    const input = buildSimulationInput(doc, plan.id);
    const base = simulate(input);
    const variant = scaleExpenses(plan, 1.2);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <PlanChangePreview
          input={input}
          base={base}
          variant={variant}
          title="max spending"
          projectionNote={SOLVER_PROJECTION_NOTE}
        />
      </QueryClientProvider>,
    );
    expect(SOLVER_PROJECTION_NOTE).toMatch(/[Dd]eterministic/);
    expect(SOLVER_PROJECTION_NOTE).toMatch(/Monte Carlo/);
    expect(screen.getByText(SOLVER_PROJECTION_NOTE)).toBeTruthy();
    expect(await screen.findByText("Outcome at assumed rates")).toBeTruthy();
  });

  it("leaves other previews unlabelled", async () => {
    const doc = createSampleDocument();
    const plan = doc.plans[0]!;
    const input = buildSimulationInput(doc, plan.id);
    const base = simulate(input);
    const variant = scaleExpenses(plan, 0.9);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <PlanChangePreview input={input} base={base} variant={variant} title="spend less" />
      </QueryClientProvider>,
    );
    expect(screen.queryByText(/Deterministic projection/)).toBeNull();
    expect(await screen.findByText("Outcome")).toBeTruthy();
    expect(screen.queryByText("Outcome at assumed rates")).toBeNull();
  });
});

describe("welcome tour", () => {
  it("sits in the corner instead of covering the chart in the middle of the page", () => {
    usePrefs.setState({ tour: "welcome" });
    render(<Tour />);
    const card = screen.getByRole("dialog", { name: "Welcome to Glideworth" });
    expect(card.className).toContain("bottom-[calc(4.5rem+env(safe-area-inset-bottom))]");
    expect(card.style.top).toBe("");
    expect(card.style.transform).toBe("");
  });
});
