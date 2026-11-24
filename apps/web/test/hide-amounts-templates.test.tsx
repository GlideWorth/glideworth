/**
 * Hide amounts on Insights life-event templates (issue #121). Titles and descriptions are sentences
 * core builds from the plan, so they have to go through the same prose mask as other insight text.
 * The branch-name field repeats a title and uses that mask until it is focused.
 */
import { buildSimulationInput, simulate } from "@glideworth/core";
import {
  createDeSampleDocument,
  createSampleDocument,
  createUkSampleDocument,
  DE_SAMPLE_PLAN_ID,
  UK_SAMPLE_PLAN_ID,
} from "@glideworth/core/samples";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PlanChangePreview } from "../src/features/insights/plan-preview";
import { TemplateGallery } from "../src/features/insights/scenario-panels";
import { buildTemplates } from "../src/features/insights/scenario-templates";
import { AMOUNT_MASK } from "../src/lib/format";
import { useUi } from "../src/stores/ui";

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => () => Promise.resolve(),
}));

afterEach(() => {
  cleanup();
  act(() => useUi.getState().setHideAmounts(false));
});

const hide = () => act(() => useUi.getState().setHideAmounts(true));

function visible(el: Element): string {
  const copy = el.cloneNode(true) as Element;
  for (const n of copy.querySelectorAll(".sr-only")) n.remove();
  return (copy.textContent ?? "").replace(/\s+/g, " ").trim();
}

function spoken(el: Element): string {
  const copy = el.cloneNode(true) as Element;
  for (const n of copy.querySelectorAll('[aria-hidden="true"]')) n.remove();
  return (copy.textContent ?? "").replace(/\s+/g, " ").trim();
}

/** A currency figure: symbol then digits, or digits then a symbol. Ages, years and percents are not this. */
const MONEY_FIGURE = /(?:£|\$|€)\s?\d|\d[\d.,]*\s?(?:£|\$|€)/;

function withWorkspace(node: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  });
  return createElement(QueryClientProvider, { client }, node);
}

const households = [
  { name: "UK", doc: () => createUkSampleDocument(), planId: UK_SAMPLE_PLAN_ID },
  { name: "US", doc: () => createSampleDocument(), planId: "plan-main" },
  { name: "DE", doc: () => createDeSampleDocument(), planId: DE_SAMPLE_PLAN_ID },
];

describe.each(households)("life-event template cards ($name)", ({ doc, planId }) => {
  const input = buildSimulationInput(doc(), planId);
  const result = simulate(input);
  const prose = buildTemplates(input, result).flatMap((b) =>
    b.template ? [b.template.title, b.template.description] : [],
  );

  it("derives money figures from the plan", () => {
    expect(prose.some((s) => MONEY_FIGURE.test(s))).toBe(true);
  });

  it("masks those figures in titles and descriptions, and leaves ages and years", () => {
    hide();
    const { container } = render(withWorkspace(<TemplateGallery input={input} result={result} />));
    const shown = visible(container);
    expect(shown).toContain("Life-event templates");
    expect(shown).toContain(AMOUNT_MASK);
    expect(shown).not.toMatch(MONEY_FIGURE);
    expect(shown).toMatch(/age 18/);
    expect(shown).toMatch(/\b20\d{2}\b/);
    expect(spoken(container)).toContain("amount hidden");
    expect(spoken(container)).not.toContain("•");
    expect(spoken(container)).not.toMatch(MONEY_FIGURE);
  });

  it("shows the derived figures when amounts are visible", () => {
    const { container } = render(withWorkspace(<TemplateGallery input={input} result={result} />));
    expect(visible(container)).toMatch(MONEY_FIGURE);
    expect(visible(container)).not.toContain(AMOUNT_MASK);
  });
});

describe("branch name copied from a template title", () => {
  const doc = createUkSampleDocument();
  const input = buildSimulationInput(doc, UK_SAMPLE_PLAN_ID);
  const result = simulate(input);
  const title = buildTemplates(input, result).find((b) => b.id === "inheritance")!.template!.title;

  function renderPreview() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={client}>
        <PlanChangePreview
          input={input}
          base={result}
          variant={{ plan: input.plan, changes: [] }}
          title={title}
        />
      </QueryClientProvider>,
    );
  }

  it("masks the amount until the field is focused, then restores the mask", () => {
    hide();
    renderPreview();
    const field = screen.getByLabelText("Name for the new branch") as HTMLInputElement;
    expect(field.value).toContain(AMOUNT_MASK);
    expect(field.value).not.toMatch(MONEY_FIGURE);
    const note = document.getElementById(field.getAttribute("aria-describedby") ?? "");
    expect(note?.textContent).toContain("amount hidden");
    expect(note?.textContent).not.toMatch(MONEY_FIGURE);
    expect(note?.textContent).not.toContain("•");
    fireEvent.focus(field);
    expect(field.value).toBe(`Plan · ${title}`);
    expect(field.value).toMatch(MONEY_FIGURE);
    fireEvent.blur(field);
    expect(field.value).toContain(AMOUNT_MASK);
    expect(field.value).not.toMatch(MONEY_FIGURE);
  });

  it("keeps the real title while amounts are shown", () => {
    renderPreview();
    const field = screen.getByLabelText("Name for the new branch") as HTMLInputElement;
    expect(field.value).toBe(`Plan · ${title}`);
    expect(field.getAttribute("aria-describedby")).toBeNull();
  });
});
