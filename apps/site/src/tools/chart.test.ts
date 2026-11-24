import { describe, expect, it } from "vitest";
import { chartSvg } from "./chart";
import type { ChartSpec } from "./types";

const spec = (markers: { x: number; label: string }[]): ChartSpec => ({
  id: "c",
  kind: "line",
  title: "t",
  summary: "s",
  xLabel: "Age",
  yLabel: "£",
  x: Array.from({ length: 31 }, (_, i) => 60 + i),
  series: [
    {
      label: "Pot",
      values: Array.from({ length: 31 }, (_, i) => 300_000 - i * 10_000),
      tone: 1,
      style: "solid",
    },
  ],
  markers,
  currency: "GBP",
  table: { caption: "c", columns: [], rows: [] },
});

const labelYs = (svg: string) =>
  [...svg.matchAll(/<text class="tc-ref-label"[^>]* y="([\d.]+)"[^>]*>([^<]*)</g)].map(
    (m) => [m[2], Number(m[1])] as const,
  );

describe("chart marker labels", () => {
  it("drops a label to a second row when it would overlap the one before", () => {
    const ys = labelYs(
      chartSvg(
        spec([
          { x: 67, label: "State Pension from 67" },
          { x: 80, label: "Runs out at 80" },
        ]),
      ),
    );
    expect(ys).toHaveLength(2);
    expect(ys[0]![1]).not.toBe(ys[1]![1]);
  });

  it("keeps labels far apart on the same row", () => {
    const ys = labelYs(
      chartSvg(
        spec([
          { x: 61, label: "At 61" },
          { x: 88, label: "At 88" },
        ]),
      ),
    );
    expect(ys[0]![1]).toBe(ys[1]![1]);
  });
});
