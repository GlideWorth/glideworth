/**
 * The Chart wrapper rebuilds its option when "Hide amounts" changes, so axes, tooltips and labels
 * re-format with the mask without the page re-rendering the chart itself. ECharts is replaced by a
 * stub that records each option it is given.
 */
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Chart } from "../src/components/charts/echarts";
import { AMOUNT_MASK, formatMoney } from "../src/lib/format";
import { useUi } from "../src/stores/ui";

const options: { yAxis: { axisLabel: { formatter: (v: number) => string } } }[] = [];
vi.mock("../src/components/charts/echarts-runtime", () => ({
  init: () => ({
    setOption: (o: (typeof options)[number]) => options.push(o),
    resize: () => {},
    on: () => {},
    off: () => {},
    dispose: () => {},
  }),
}));

afterEach(() => {
  cleanup();
  act(() => useUi.getState().setHideAmounts(false));
  options.length = 0;
});

describe("Chart under Hide amounts", () => {
  it("re-formats the option when amounts are hidden and shown again", async () => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    const build = () => ({
      yAxis: {
        type: "value",
        axisLabel: {
          formatter: (v: number) => formatMoney(v, { locale: "en-US", currency: "USD" }),
        },
      },
    });
    render(<Chart build={build} ariaLabel="Net worth" />);
    await waitFor(() => expect(options.length).toBeGreaterThan(0));
    expect(options.at(-1)!.yAxis.axisLabel.formatter(5000)).toBe("$5,000");

    act(() => useUi.getState().setHideAmounts(true));
    await waitFor(() => expect(options.at(-1)!.yAxis.axisLabel.formatter(5000)).toBe(""));
    // The chart's own formatter masks too (tooltips, labels): nothing shows the figure.
    expect(build().yAxis.axisLabel.formatter(5000)).toBe(`$${AMOUNT_MASK}`);

    act(() => useUi.getState().setHideAmounts(false));
    await waitFor(() => expect(options.at(-1)!.yAxis.axisLabel.formatter(5000)).toBe("$5,000"));
    vi.unstubAllGlobals();
  });
});
