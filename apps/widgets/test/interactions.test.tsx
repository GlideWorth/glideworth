import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  answerSpending,
  compareFor,
  compareTemplate,
  errorResult,
  outcomeMonteCarlo,
  pending,
  pendingAnswer,
  resultOf,
  reviewProposed,
  yearView,
} from "../src/fixtures";
import type { ToolResult } from "../src/types";
import { deferred, FAST, renderApp } from "./helpers";

afterEach(cleanup);

const running = (progress: number): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify({ status: "running", progress }) }],
});

describe("compare: what-if steppers", () => {
  it("re-runs preview_whatif with the merged params and re-renders from the new payload", async () => {
    const { host } = renderApp(resultOf(compareTemplate), {
      handlers: {
        preview_whatif: (args) => {
          const params = args.params as { retirementYear: number; spending: number };
          return resultOf(compareFor(params.retirementYear, params.spending));
        },
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Increase Retire in" }));
    await waitFor(() => expect(screen.getAllByText("Retire in 2034").length).toBeGreaterThan(0));
    expect(host.calls).toEqual([
      {
        name: "preview_whatif",
        arguments: {
          planId: compareTemplate.plan.planId,
          templateId: "early-retirement",
          params: { retirementYear: 2034, spending: 96_000 },
        },
      },
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Decrease Spending a year" }));
    await waitFor(() => expect(host.calls).toHaveLength(2));
    expect(host.calls[1]?.arguments.params).toEqual({ retirementYear: 2034, spending: 94_000 });
  });

  it("debounces quick changes into one call", async () => {
    const { host } = renderApp(resultOf(compareTemplate), {
      timing: { ...FAST, debounceMs: 30 },
      handlers: { preview_whatif: () => resultOf(compareFor(2035, 96_000)) },
    });
    const up = screen.getByRole("button", { name: "Increase Retire in" });
    fireEvent.click(up);
    fireEvent.click(up);
    await waitFor(() => expect(host.calls).toHaveLength(1));
    expect(host.calls[0]?.arguments.params).toMatchObject({ retirementYear: 2035 });
  });

  it("ignores a stale response that arrives after a newer one", async () => {
    const first = deferred<ToolResult>();
    const second = deferred<ToolResult>();
    const queue = [first, second];
    const { host } = renderApp(resultOf(compareTemplate), {
      handlers: { preview_whatif: () => (queue.shift() ?? first).promise },
    });
    fireEvent.click(screen.getByRole("button", { name: "Increase Retire in" }));
    await waitFor(() => expect(host.calls).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "Increase Retire in" }));
    await waitFor(() => expect(host.calls).toHaveLength(2));

    await act(async () => second.resolve(resultOf(compareFor(2035, 96_000))));
    await waitFor(() => expect(screen.getAllByText("Retire in 2035").length).toBeGreaterThan(0));
    await act(async () => first.resolve(resultOf(compareFor(2034, 96_000))));
    expect(screen.queryAllByText("Retire in 2034")).toHaveLength(0);
    expect(screen.getAllByText("Retire in 2035").length).toBeGreaterThan(0);
  });

  it("proposes the what-if as a change set and opens the review, with Back", async () => {
    const { host } = renderApp(resultOf(compareTemplate), {
      handlers: { propose_change_set: () => resultOf(reviewProposed) },
    });
    fireEvent.click(screen.getByRole("button", { name: "Make this my plan" }));
    await screen.findByText("Review this change");
    expect(host.calls[0]).toMatchObject({
      name: "propose_change_set",
      arguments: { planId: compareTemplate.plan.planId, ops: compareTemplate.ops },
    });
    // The what-if label already names the change, so no parameter values are appended.
    expect(host.calls[0]?.arguments.summary).toBe("Retire in 2033");
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByText("What changes?")).toBeTruthy();
  });

  it("saves a what-if and tells the assistant", async () => {
    const { host } = renderApp(resultOf(compareTemplate), {
      handlers: {
        create_branch_from_template: () => ({
          content: [
            { type: "text", text: JSON.stringify({ id: "plan_b1", name: "Retire earlier" }) },
          ],
        }),
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save as a what-if" }));
    await screen.findByText(/Saved as a what-if/);
    expect(host.calls[0]).toEqual({
      name: "create_branch_from_template",
      arguments: {
        planId: compareTemplate.plan.planId,
        templateId: "early-retirement",
        params: { retirementYear: 2033, spending: 96_000 },
      },
    });
    expect(host.contextNotes[0]).toMatch(/saved the what-if/);
  });
});

describe("worse outcomes", () => {
  it("warns in compare and does not style “Make this my plan” as the endorsed action", () => {
    const worse = compareFor(2029, 120_000);
    expect(worse.after.depletionYear).not.toBeNull();
    renderApp(resultOf(worse));
    expect(
      screen.getByText(`This change makes your plan run short in ${worse.after.depletionYear}.`),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Make this my plan" }).className).not.toContain(
      "btn-primary",
    );
  });

  it("warns in review on a success-rate drop of 5 points, and keeps Apply available", () => {
    renderApp(
      resultOf({
        ...reviewProposed,
        before: { ...reviewProposed.before!, successRate: 0.84 },
        after: { ...reviewProposed.after!, successRate: 0.78 },
      }),
    );
    expect(
      screen.getByText("This change lowers your chance of success from 84% to 78%."),
    ).toBeTruthy();
    const apply = screen.getByRole("button", { name: "Apply" });
    expect(apply.className).not.toContain("btn-primary");
  });

  it("does not warn when the outcome improves", () => {
    renderApp(resultOf(reviewProposed));
    expect(screen.queryByText(/This change (makes|lowers)/)).toBeNull();
    expect(screen.getByRole("button", { name: "Apply" }).className).toContain("btn-primary");
  });
});

describe("review: apply and discard", () => {
  it("calls apply_change_set exactly once, even on a double tap, and tells the assistant", async () => {
    const reply = deferred<ToolResult>();
    const { host } = renderApp(resultOf(reviewProposed), {
      handlers: { apply_change_set: () => reply.promise },
    });
    expect(host.calls).toHaveLength(0);
    const apply = screen.getByRole("button", { name: "Apply" });
    fireEvent.click(apply);
    fireEvent.click(apply);
    await act(async () =>
      reply.resolve(
        resultOf(reviewProposed, {
          changeSetId: "cs_sample_01",
          status: "applied",
          newVersion: 13,
        }),
      ),
    );
    await screen.findByText("Applied — plan is now version 13.");
    expect(host.calls.filter((c) => c.name === "apply_change_set")).toHaveLength(1);
    expect(host.calls[0]?.arguments).toEqual({ changeSetId: "cs_sample_01" });
    expect(host.contextNotes).toEqual([
      "The user applied change set cs_sample_01 in the Glideworth view; the plan is now version 13.",
    ]);
    expect(screen.queryByRole("button", { name: "Apply" })).toBeNull();
  });

  it("shows the conflict state on CHANGESET_CONFLICT", async () => {
    renderApp(resultOf(reviewProposed), {
      handlers: {
        apply_change_set: () =>
          errorResult("CHANGESET_CONFLICT", "the plan changed after this proposal"),
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await screen.findByText("Your plan changed since this was proposed. Ask to propose it again.");
    expect(screen.queryByRole("button", { name: "Apply" })).toBeNull();
  });

  it("explains when the change set is no longer proposed", async () => {
    renderApp(resultOf(reviewProposed), {
      handlers: {
        apply_change_set: () =>
          errorResult("CHANGESET_NOT_PROPOSED", "change set cs_sample_01 is applied"),
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await screen.findByText("This change was already applied or discarded.");
    expect(screen.queryByRole("button", { name: "Apply" })).toBeNull();
  });

  it("renders sentence-only changes without an arrow", () => {
    renderApp(
      resultOf({
        ...reviewProposed,
        changes: [
          { label: "Retirement spending: 60,000 → 65,000 per year", before: null, after: null },
        ],
      }),
    );
    expect(screen.getByText("Retirement spending: 60,000 → 65,000 per year")).toBeTruthy();
    expect(screen.queryByLabelText("to")).toBeNull();
  });

  it("shows other errors inline and keeps the buttons", async () => {
    renderApp(resultOf(reviewProposed), {
      handlers: { apply_change_set: () => errorResult("VALIDATION", "something is off") },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await screen.findByText("Something is off");
    expect(screen.getByRole("button", { name: "Apply" })).toBeTruthy();
  });

  it("discards and tells the assistant", async () => {
    const { host } = renderApp(resultOf(reviewProposed), {
      handlers: { discard_change_set: () => resultOf(reviewProposed, { status: "discarded" }) },
    });
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    await screen.findByText("Discarded. Your plan is unchanged.");
    expect(host.calls).toEqual([
      { name: "discard_change_set", arguments: { changeSetId: "cs_sample_01" } },
    ]);
    expect(host.contextNotes[0]).toMatch(/discarded change set cs_sample_01/);
  });
});

describe("pending", () => {
  it("polls get_job until an outcome arrives, then renders it", async () => {
    const replies = [running(0.2), running(0.6), resultOf(outcomeMonteCarlo)];
    const { host } = renderApp(resultOf(pending), {
      handlers: { get_job: () => replies.shift() ?? running(0.9) },
    });
    expect(screen.getByText(/thousands of market paths/)).toBeTruthy();
    await screen.findByText("84%");
    expect(host.calls).toHaveLength(3);
    expect(host.calls[0]).toEqual({
      name: "get_job",
      arguments: { jobId: "job_sample_mc", wait: 20 },
    });
  });

  it("renders the answer when a pending solver job finishes", async () => {
    const replies = [running(0.5), resultOf(answerSpending)];
    renderApp(resultOf(pendingAnswer), {
      handlers: { get_job: () => replies.shift() ?? running(0.9) },
    });
    expect(screen.getByText("Working out the answer…")).toBeTruthy();
    await screen.findByText("$104,600");
  });

  it("gives up after the time limit and offers a retry", async () => {
    const { host } = renderApp(resultOf(pending), {
      timing: { ...FAST, pollBackoffMs: [5], pollGiveUpMs: 30 },
      handlers: { get_job: () => running(0.1) },
    });
    const retry = await screen.findByRole("button", { name: "Check again" });
    const before = host.calls.length;
    fireEvent.click(retry);
    await waitFor(() => expect(host.calls.length).toBeGreaterThan(before));
  });

  it("reports a failed job", async () => {
    renderApp(resultOf(pending), {
      handlers: {
        get_job: () => ({
          content: [
            { type: "text", text: JSON.stringify({ status: "failed", error: "Engine error" }) },
          ],
        }),
      },
    });
    await screen.findByText("Engine error");
  });
});

describe("outcome and answer actions", () => {
  it("opens the year view for the selected year", async () => {
    const { host } = renderApp(resultOf(outcomeMonteCarlo), {
      handlers: { explain_year: (args) => resultOf({ ...yearView, year: Number(args.year) }) },
    });
    expect(screen.queryByRole("button", { name: /What happens in/ })).toBeNull();
    const slider = screen.getByRole("slider", { name: "Year" });
    fireEvent.keyDown(slider, { key: "End" });
    fireEvent.keyDown(slider, { key: "ArrowLeft" });
    fireEvent.click(screen.getByRole("button", { name: "What happens in 2069?" }));
    await screen.findByText("Where the money goes in 2069");
    expect(host.calls[0]).toEqual({
      name: "explain_year",
      arguments: { planId: outcomeMonteCarlo.plan.planId, year: 2069 },
    });
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByText("Will my money last?")).toBeTruthy();
  });

  it("asks the assistant why the plan could fail", async () => {
    const { host } = renderApp(resultOf(outcomeMonteCarlo));
    fireEvent.click(screen.getByRole("button", { name: "Why could it fail?" }));
    await screen.findByText("Asked in the chat");
    expect(host.messages[0]).toMatch(/run short in bad markets/);
  });

  it("previews a solver answer on the plan", async () => {
    const { host } = renderApp(resultOf(answerSpending), {
      handlers: { preview_changes: () => resultOf({ ...compareTemplate, template: null }) },
    });
    fireEvent.click(screen.getByRole("button", { name: "See it on my plan" }));
    await screen.findByText("What changes?");
    expect(host.calls[0]).toEqual({
      name: "preview_changes",
      arguments: { planId: answerSpending.plan.planId, ops: answerSpending.ops },
    });
  });

  it("shows a tool error inline when a view cannot open", async () => {
    renderApp(resultOf(answerSpending), {
      handlers: {
        propose_change_set: () => errorResult("PATCH_CONFLICT", "an op path does not exist"),
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Use this" }));
    await screen.findByText("An op path does not exist");
  });
});
