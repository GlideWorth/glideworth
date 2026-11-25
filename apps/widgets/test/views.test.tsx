import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  answerRetireDate,
  answerSpending,
  compareOps,
  compareTemplate,
  FIXTURES,
  outcomeDeterministicShort,
  outcomeMonteCarlo,
  READ_ONLY_PLAN,
  resultOf,
  reviewReadOnly,
  taxView,
  yearShortfall,
  yearView,
} from "../src/fixtures";
import { renderApp } from "./helpers";

afterEach(cleanup);

describe("every view renders from its fixture", () => {
  it.each(Object.entries(FIXTURES))("%s", (_name, fixture) => {
    renderApp(fixture.result, { cancelled: fixture.cancelled });
    expect(screen.getByText("Estimates, not financial advice.")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/upgrade|subscription|pricing|per month/i);
  });
});

describe("outcome", () => {
  it("shows the chance of success, the plan, the basis and a labelled chart", () => {
    renderApp(resultOf(outcomeMonteCarlo));
    expect(screen.getByText("84%")).toBeTruthy();
    expect(screen.getByText("Our retirement plan")).toBeTruthy();
    expect(screen.getByText("today’s money")).toBeTruthy();
    const chart = screen.getByRole("img", { name: /Net worth from 2026 to 2070/ });
    expect(chart.tagName.toLowerCase()).toBe("svg");
    expect(screen.getByText("Median at end")).toBeTruthy();
    expect(screen.getByText("1 in 10 runs short")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Why could it fail?" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open in Glideworth" })).toBeTruthy();
  });

  it("labels only retirement and the shortfall on the chart; other milestones are ticks named in the readout", () => {
    const { container } = renderApp(resultOf(outcomeMonteCarlo));
    const labels = [...container.querySelectorAll(".marker-label")].map((t) => t.textContent);
    expect(labels).toEqual([
      "Retirement",
      `1 in 10 short by ${outcomeMonteCarlo.badCaseDepletionYear}`,
    ]);
    expect(container.querySelectorAll(".marker-line, .alert-line")).toHaveLength(2);
    expect(container.querySelectorAll(".tick-mark")).toHaveLength(4);
    const slider = screen.getByRole("slider", { name: "Year" });
    fireEvent.keyDown(slider, { key: "End" });
    expect(screen.getByText("Jordan life expectancy")).toBeTruthy();
  });

  it("says when a deterministic projection runs short", () => {
    renderApp(resultOf(outcomeDeterministicShort));
    expect(screen.getByText(/^Runs short in \d{4}$/)).toBeTruthy();
  });

  it("hides “Why could it fail?” when the host cannot send messages", () => {
    renderApp(resultOf(outcomeMonteCarlo), { canMessage: false });
    expect(screen.queryByRole("button", { name: "Why could it fail?" })).toBeNull();
  });

  it("hides “Open in Glideworth” without an app URL", () => {
    renderApp(resultOf({ ...outcomeMonteCarlo, plan: READ_ONLY_PLAN }));
    expect(screen.queryByRole("button", { name: "Open in Glideworth" })).toBeNull();
  });
});

describe("other views", () => {
  it("compare shows both labels, delta chips and the steppers", () => {
    renderApp(resultOf(compareTemplate));
    expect(screen.getAllByText("Current plan").length).toBeGreaterThan(0);
    expect(screen.getByText("End net worth")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Increase Retire in" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Make this my plan" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save as a what-if" })).toBeTruthy();
  });

  it("compare collapses a long change list", () => {
    renderApp(resultOf(compareOps));
    expect(screen.getByText("Home value")).toBeTruthy();
    expect(screen.queryByText("Moving costs")).toBeNull();
    expect(screen.getByRole("button", { name: "2 more" })).toBeTruthy();
  });

  it("answer shows the figure and the current value", () => {
    renderApp(resultOf(answerSpending));
    expect(screen.getByText("$104,600")).toBeTruthy();
    expect(screen.getByText("$96,000")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Use this" })).toBeTruthy();
  });

  it("answer formats a month", () => {
    renderApp(resultOf(answerRetireDate));
    expect(screen.getByText("Jun 2034")).toBeTruthy();
  });

  it("answer without a solution offers no actions", () => {
    renderApp(resultOf({ ...answerSpending, figure: { ...answerSpending.figure, value: null } }));
    expect(screen.getByText("No answer found")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Use this" })).toBeNull();
  });

  it("year shows the waterfall, withdrawals and no shortfall", () => {
    renderApp(resultOf(yearView));
    expect(screen.getByText("Where the money goes in 2041")).toBeTruthy();
    expect(
      screen.getByRole("img", { name: /Net worth from \$1,412,000 to \$1,436,500/ }),
    ).toBeTruthy();
    expect(screen.getByText("Joint brokerage")).toBeTruthy();
    expect(screen.queryByText(/falls short/)).toBeNull();
  });

  it("year calls out a shortfall", () => {
    renderApp(resultOf(yearShortfall));
    expect(screen.getByText(/falls short by/)).toBeTruthy();
  });

  it("tax shows the lifetime total", () => {
    renderApp(resultOf(taxView));
    expect(screen.getByText("Lifetime tax")).toBeTruthy();
    expect(screen.getByText("$1.1M")).toBeTruthy();
  });
});

describe("write access", () => {
  it("hides write buttons when canWrite is false", () => {
    renderApp(resultOf({ ...compareTemplate, plan: READ_ONLY_PLAN }));
    expect(screen.queryByRole("button", { name: "Make this my plan" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Save as a what-if" })).toBeNull();
    cleanup();

    renderApp(resultOf({ ...answerSpending, plan: READ_ONLY_PLAN }));
    expect(screen.queryByRole("button", { name: "Use this" })).toBeNull();
    expect(screen.getByRole("button", { name: "See it on my plan" })).toBeTruthy();
    cleanup();

    renderApp(resultOf(reviewReadOnly));
    expect(screen.queryByRole("button", { name: "Apply" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Discard" })).toBeNull();
    expect(screen.getByText(/needs write access/)).toBeTruthy();
  });
});

describe("theme", () => {
  it("follows the host theme and applies host CSS variables", () => {
    renderApp(resultOf(outcomeMonteCarlo), {
      context: {
        theme: "dark",
        styles: { variables: { "--color-background-primary": "#101010" } },
      },
    });
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.style.getPropertyValue("--color-background-primary")).toBe(
      "#101010",
    );
  });
});
