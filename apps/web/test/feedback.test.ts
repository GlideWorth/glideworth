import { act, renderHook } from "@testing-library/react";
import type { PostHog } from "posthog-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  dismissFeedback,
  enableFeedback,
  FEEDBACK_KIND_QUESTION,
  FEEDBACK_MESSAGE_QUESTION,
  openFeedback,
  resetFeedbackForTests,
  submitFeedback,
  useFeedbackAvailable,
  useFeedbackDialog,
} from "../src/lib/feedback";

const ID = "0190feed-back-7000-8000-000000000001";

function fakePostHog() {
  const capture = vi.fn();
  return { capture, posthog: { capture } as unknown as PostHog };
}

afterEach(() => resetFeedbackForTests());

describe("feedback", () => {
  it("is unavailable until PostHog has loaded", () => {
    const { posthog, capture } = fakePostHog();
    const { result } = renderHook(() => useFeedbackAvailable());
    expect(result.current).toBe(false);
    openFeedback();
    expect(useFeedbackDialog.getState().open).toBe(false);
    expect(capture).not.toHaveBeenCalled();

    act(() => enableFeedback(posthog, ID));
    expect(result.current).toBe(true);
  });

  it("stays unavailable without a survey id (self-host and local builds)", () => {
    const { posthog } = fakePostHog();
    const { result } = renderHook(() => useFeedbackAvailable());
    act(() => enableFeedback(posthog, undefined));
    expect(result.current).toBe(false);
  });

  it("opens the form and records that it was shown", () => {
    const { posthog, capture } = fakePostHog();
    enableFeedback(posthog, ID);
    openFeedback();
    expect(useFeedbackDialog.getState().open).toBe(true);
    expect(capture).toHaveBeenCalledWith("survey shown", {
      $survey_id: ID,
      $survey_name: "Send feedback",
    });
  });

  it("records a dismissal once, when the open form is closed", () => {
    const { posthog, capture } = fakePostHog();
    enableFeedback(posthog, ID);
    openFeedback();
    dismissFeedback();
    dismissFeedback();
    expect(useFeedbackDialog.getState().open).toBe(false);
    expect(capture.mock.calls.filter(([e]) => e === "survey dismissed")).toHaveLength(1);
  });

  it("sends the answers in the shape PostHog's survey results read", () => {
    const { posthog, capture } = fakePostHog();
    enableFeedback(posthog, ID);
    openFeedback();
    submitFeedback("I'd like a feature", "  Export to PDF  ");
    expect(useFeedbackDialog.getState().open).toBe(false);
    const [event, props] = capture.mock.calls.at(-1) ?? [];
    expect(event).toBe("survey sent");
    const k = FEEDBACK_KIND_QUESTION.id;
    const m = FEEDBACK_MESSAGE_QUESTION.id;
    expect(props).toMatchObject({
      $survey_id: ID,
      $survey_name: "Send feedback",
      $survey_completed: true,
      [`$survey_response_${k}`]: "I'd like a feature",
      [`$survey_response_${m}`]: "Export to PDF",
      $survey_response: "I'd like a feature",
      $survey_response_1: "Export to PDF",
      $survey_questions: [
        { id: k, question: FEEDBACK_KIND_QUESTION.question, response: "I'd like a feature" },
        { id: m, question: FEEDBACK_MESSAGE_QUESTION.question, response: "Export to PDF" },
      ],
    });
    expect(props.$survey_submission_id).toMatch(/^[0-9a-f-]{36}$/);
  });
});
