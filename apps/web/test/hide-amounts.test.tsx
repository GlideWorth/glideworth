/**
 * "Hide amounts" (privacy mode for screen sharing): the per-device preference, the primitives that
 * render money, money inputs, charts, the controls, and what must NOT be masked (exports).
 */
import { buildSimulationInput, simulate } from "@glideworth/core";
import { createSampleDocument } from "@glideworth/core/samples";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { hideChartAmounts } from "../src/components/charts/echarts";
import { toggleHideAmounts } from "../src/components/command/actions";
import { SHORTCUT_GROUPS } from "../src/components/layout/shortcuts";
import { Badge } from "../src/components/ui/badge";
import { CurrencyInput, PercentInput } from "../src/components/ui/number-input";
import { PrivateText } from "../src/components/ui/private-text";
import { Stat } from "../src/components/ui/stat";
import { Table, TBody, TD, TR } from "../src/components/ui/table";
import { buildEntityIndex, projectionCsv, tableColumns } from "../src/features/results/model";
import { setDemoModeForTests } from "../src/lib/demo";
import { AMOUNT_MASK, amountsHidden, formatMoney } from "../src/lib/format";
import { useUi } from "../src/stores/ui";

afterEach(() => {
  cleanup();
  act(() => useUi.getState().setHideAmounts(false));
  setDemoModeForTests(false);
  localStorage.clear();
});

const hide = () => act(() => useUi.getState().setHideAmounts(true));

/** What assistive technology reads: the text without anything marked aria-hidden. */
function spoken(el: Element): string {
  const copy = el.cloneNode(true) as Element;
  for (const n of copy.querySelectorAll('[aria-hidden="true"]')) n.remove();
  return (copy.textContent ?? "").replace(/\s+/g, " ").trim();
}
/** What a screen share shows: the text without the screen-reader-only copies. */
function visible(el: Element): string {
  const copy = el.cloneNode(true) as Element;
  for (const n of copy.querySelectorAll(".sr-only")) n.remove();
  return (copy.textContent ?? "").replace(/\s+/g, " ").trim();
}

function withWorkspace(node: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  });
  const doc = createSampleDocument();
  doc.household.currency = "USD";
  doc.household.locale = "en-US";
  doc.settings = { ...doc.settings, locale: "en-US", displayCurrency: "USD" };
  client.setQueryData(["workspace"], { doc, source: "sample" });
  return createElement(QueryClientProvider, { client }, node);
}

describe("the preference", () => {
  it("is off by default and drives the money formatter the moment it changes", () => {
    expect(useUi.getState().hideAmounts).toBe(false);
    expect(formatMoney(1234, { locale: "en-US", currency: "USD" })).toBe("$1,234");
    useUi.getState().setHideAmounts(true);
    // Synchronously: no render needed, so nothing paints a real figure first.
    expect(amountsHidden()).toBe(true);
    expect(formatMoney(1234, { locale: "en-US", currency: "USD" })).toBe(`$${AMOUNT_MASK}`);
    toggleHideAmounts();
    expect(useUi.getState().hideAmounts).toBe(false);
    expect(formatMoney(1234, { locale: "en-US", currency: "USD" })).toBe("$1,234");
  });

  it("persists per device in the UI store, and apart from the real workspace in the demo", () => {
    useUi.getState().setHideAmounts(true);
    expect(JSON.parse(localStorage.getItem("glideworth-ui")!).state.hideAmounts).toBe(true);
    useUi.getState().setHideAmounts(false);
    localStorage.clear();
    setDemoModeForTests(true);
    useUi.getState().setHideAmounts(true);
    expect(
      JSON.parse(localStorage.getItem("glideworth:demo:glideworth-ui")!).state.hideAmounts,
    ).toBe(true);
    expect(localStorage.getItem("glideworth-ui")).toBeNull();
    expect(formatMoney(5, { locale: "en-GB", currency: "GBP" })).toBe(`£${AMOUNT_MASK}`);
  });

  it("has a shortcut (⇧H) that clashes with no other single-key shortcut", () => {
    const anywhere = SHORTCUT_GROUPS.find((g) => g.title === "Anywhere")!;
    const keys = anywhere.items.flatMap((i) => i.keys.map((k) => k.join("+")));
    expect(keys).toContain("⇧+H");
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("money in the UI primitives", () => {
  it("masks a stat tile and tells screen readers the amount is hidden", () => {
    hide();
    const { container } = render(
      <Stat label="Net worth" value={formatMoney(987_654, { locale: "en-US", currency: "USD" })} />,
    );
    expect(visible(container)).toBe(`Net worth$${AMOUNT_MASK}`);
    expect(spoken(container)).toBe("Net worthamount hidden"); // label and value are separate blocks
    expect(spoken(container)).not.toContain("•");
  });

  it("masks figures inside prose in table cells and badges, keeping percentages and years", () => {
    hide();
    const { container } = render(
      <>
        <Table aria-label="t">
          <TBody>
            <TR>
              <TD>You could spend $1,200 more from 2041</TD>
            </TR>
          </TBody>
        </Table>
        <Badge>85% chance · £3.4m at the end</Badge>
      </>,
    );
    const shown = visible(container);
    expect(shown).toContain(`$${AMOUNT_MASK} more from 2041`);
    expect(shown).toContain(`85% chance · £${AMOUNT_MASK} at the end`);
    expect(shown).not.toMatch(/1,200|3\.4m/);
    expect(spoken(container)).toContain("You could spend amount hidden more from 2041");
    expect(spoken(container)).not.toContain("•");
  });

  it("renders text untouched while amounts are shown", () => {
    const { container } = render(<PrivateText>Spend $1,200 a month</PrivateText>);
    expect(container.innerHTML).toBe("Spend $1,200 a month");
  });

  it("switches live when the preference changes", () => {
    const { container } = render(<PrivateText>Spend $1,200 a month</PrivateText>);
    hide();
    expect(visible(container)).toBe(`Spend $${AMOUNT_MASK} a month`);
    act(() => useUi.getState().setHideAmounts(false));
    expect(visible(container)).toBe("Spend $1,200 a month");
  });
});

describe("money inputs", () => {
  it("shows the mask until focused, the real value while editing, and the mask again after", () => {
    render(
      withWorkspace(
        <>
          <CurrencyInput aria-label="Balance" value={250_000} onValueChange={() => {}} />
          <PercentInput aria-label="Rate" value={0.05} onValueChange={() => {}} />
        </>,
      ),
    );
    const balance = screen.getByLabelText("Balance") as HTMLInputElement;
    const rate = screen.getByLabelText("Rate") as HTMLInputElement;
    expect(balance.value).toBe("250,000");
    hide();
    expect(balance.value).toBe(AMOUNT_MASK);
    const note = document.getElementById(balance.getAttribute("aria-describedby") ?? "");
    expect(note?.textContent).toBe("amount hidden");
    expect(rate.value).toBe("5"); // rates are not money
    fireEvent.focus(balance);
    expect(balance.value).toBe("250,000");
    expect(balance.getAttribute("aria-describedby")).toBeNull();
    fireEvent.change(balance, { target: { value: "260000" } });
    fireEvent.blur(balance);
    expect(balance.value).toBe(AMOUNT_MASK);
  });
});

describe("charts", () => {
  const option = {
    yAxis: {
      type: "value",
      axisLabel: {
        formatter: (v: number) =>
          formatMoney(v, { locale: "en-US", currency: "USD", compact: true }),
      },
    },
    xAxis: { type: "category", axisLabel: { formatter: (v: string) => v } },
    series: [{ type: "bar", label: { show: true, formatter: "{b}: {c}" } }],
    aria: { enabled: true },
  };

  it("keeps the shape but blanks money axis labels and raw-value labels", () => {
    hide();
    const o = hideChartAmounts(option, "Net worth by year") as typeof option & {
      aria: { label: { description: string } };
    };
    expect(o.yAxis.axisLabel.formatter(1_000_000)).toBe("");
    expect(o.xAxis.axisLabel.formatter("2041")).toBe("2041");
    expect(o.series[0]!.label.formatter).toBe("{b}");
    expect(o.aria.label.description).toBe("Net worth by year. Amounts hidden.");
  });
});

describe("exports are deliberate and never masked", () => {
  it("writes real figures to the projection CSV while amounts are hidden", () => {
    const doc = createSampleDocument();
    const plan = doc.plans[0]!;
    const result = simulate(buildSimulationInput(doc, plan.id));
    const cols = tableColumns(result, buildEntityIndex(doc, plan)).filter(
      (c) => c.id === "year" || c.id === "netWorth",
    );
    hide();
    const csv = projectionCsv(result, cols, "real", doc.household.currency);
    expect(csv).not.toContain("•");
    expect(csv.split("\r\n")[1]).toMatch(/^\d{4},\d+(\.\d+)?$/);
  });
});
