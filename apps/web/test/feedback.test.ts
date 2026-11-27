import { act, renderHook } from "@testing-library/react";
import type { PostHog, Survey } from "posthog-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  openFeedback,
  resetFeedbackForTests,
  useFeedbackAvailable,
  watchFeedbackSurvey,
} from "../src/lib/feedback";

const ID = "0190feed-back-7000-8000-000000000001";

function fakePostHog() {
  let onLoaded: ((surveys: Survey[]) => void) | undefined;
  const client = {
    onSurveysLoaded: vi.fn((cb: (surveys: Survey[]) => void) => {
      onLoaded = cb;
      return () => {};
    }),
    displaySurvey: vi.fn(),
  };
  const load = (ids: string[]) =>
    act(() => onLoaded?.(ids.map((id) => ({ id }) as unknown as Survey)));
  return { client, posthog: client as unknown as PostHog, load };
}

afterEach(() => resetFeedbackForTests());

describe("feedback survey", () => {
  it("is unavailable until PostHog loads the survey", () => {
    const { posthog, client, load } = fakePostHog();
    const { result } = renderHook(() => useFeedbackAvailable());
    watchFeedbackSurvey(posthog, ID);
    expect(result.current).toBe(false);
    openFeedback(ID);
    expect(client.displaySurvey).not.toHaveBeenCalled();

    load([ID, "another-survey"]);
    expect(result.current).toBe(true);
  });

  it("stays unavailable when the project does not have the survey", () => {
    const { posthog, load } = fakePostHog();
    const { result } = renderHook(() => useFeedbackAvailable());
    watchFeedbackSurvey(posthog, ID);
    load(["another-survey"]);
    expect(result.current).toBe(false);
  });

  it("becomes unavailable again when a reload no longer has it", () => {
    const { posthog, load } = fakePostHog();
    const { result } = renderHook(() => useFeedbackAvailable());
    watchFeedbackSurvey(posthog, ID);
    load([ID]);
    load([]);
    expect(result.current).toBe(false);
  });

  it("does nothing without a survey id (self-host and local builds)", () => {
    const { posthog, client } = fakePostHog();
    watchFeedbackSurvey(posthog, undefined);
    expect(client.onSurveysLoaded).not.toHaveBeenCalled();
  });

  it("opens the survey as a popover, ignoring its targeting and delay", () => {
    const { posthog, client, load } = fakePostHog();
    watchFeedbackSurvey(posthog, ID);
    load([ID]);
    openFeedback(ID);
    expect(client.displaySurvey).toHaveBeenCalledWith(ID, {
      displayType: "popover",
      ignoreConditions: true,
      ignoreDelay: true,
    });
  });
});
