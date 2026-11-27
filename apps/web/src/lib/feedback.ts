/**
 * "Send feedback": the app's own feedback form (components/feedback-dialog.tsx), on the hosted service only.
 *
 * Answers go to PostHog as the `survey sent` event of the "Send feedback" survey in the Glideworth PostHog project,
 * in the shape posthog-js gives its own surveys, so they appear in that survey's results. PostHog never draws the
 * survey (`disable_surveys` in analytics.tsx); this form does. Its id comes from VITE_PUBLIC_POSTHOG_FEEDBACK_SURVEY_ID
 * at build time. Without it, or without PostHog (self-host images, local builds), `useFeedbackAvailable` is false
 * and no button shows.
 *
 * The questions below mirror the survey's in PostHog, ids included. Change both together: a renamed choice in
 * one and not the other splits the results.
 */
import type { PostHog } from "posthog-js";
import { useSyncExternalStore } from "react";
import { create } from "zustand";

/** The part of the PostHog client this module uses (tests pass a fake). */
type CaptureClient = Pick<PostHog, "capture">;

export const FEEDBACK_SURVEY_ID = import.meta.env.VITE_PUBLIC_POSTHOG_FEEDBACK_SURVEY_ID as
  | string
  | undefined;

const SURVEY_NAME = "Send feedback";

export const FEEDBACK_KIND_QUESTION = {
  id: "adcda465-9b87-46b4-855e-ecef360c085b",
  question: "What would you like to tell us?",
  choices: ["Something isn't working", "I'd like a feature", "Something else"],
} as const;

export const FEEDBACK_MESSAGE_QUESTION = {
  id: "aa4b4949-17cc-4b7c-8da6-f30fc77fb5ba",
  question: "Tell us more",
} as const;

export type FeedbackKind = (typeof FEEDBACK_KIND_QUESTION.choices)[number];

let client: CaptureClient | null = null;
let surveyId: string | undefined;
const listeners = new Set<() => void>();

/** Whether the dialog is open; FeedbackDialog renders from this. */
export const useFeedbackDialog = create<{ open: boolean }>(() => ({ open: false }));

/** Called once PostHog has initialised (the `loaded` option in analytics.tsx). */
export function enableFeedback(posthog: CaptureClient, id = FEEDBACK_SURVEY_ID): void {
  if (!id) return;
  surveyId = id;
  client = posthog;
  for (const l of listeners) l();
}

/** Open the feedback form. No-op when feedback is not available. */
export function openFeedback(): void {
  if (!client || !surveyId) return;
  useFeedbackDialog.setState({ open: true });
  client.capture("survey shown", { $survey_id: surveyId, $survey_name: SURVEY_NAME });
}

/** Close the form without sending anything. */
export function dismissFeedback(): void {
  if (!useFeedbackDialog.getState().open) return;
  useFeedbackDialog.setState({ open: false });
  if (client && surveyId)
    client.capture("survey dismissed", { $survey_id: surveyId, $survey_name: SURVEY_NAME });
}

/** Send the answers and close the form. */
export function submitFeedback(kind: FeedbackKind, message: string): void {
  useFeedbackDialog.setState({ open: false });
  if (!client || !surveyId) return;
  const text = message.trim();
  const k = FEEDBACK_KIND_QUESTION;
  const m = FEEDBACK_MESSAGE_QUESTION;
  client.capture("survey sent", {
    $survey_id: surveyId,
    $survey_name: SURVEY_NAME,
    $survey_submission_id: crypto.randomUUID(),
    $survey_completed: true,
    $survey_questions: [
      { id: k.id, question: k.question, response: kind },
      { id: m.id, question: m.question, response: text },
    ],
    [`$survey_response_${k.id}`]: kind,
    [`$survey_response_${m.id}`]: text,
    // The older, index-keyed names, which some PostHog views still read.
    $survey_response: kind,
    $survey_response_1: text,
  });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** True once the feedback form can be opened. */
export function useFeedbackAvailable(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => client !== null,
    () => false,
  );
}

/** Tests only. */
export function resetFeedbackForTests(): void {
  client = null;
  surveyId = undefined;
  useFeedbackDialog.setState({ open: false });
  for (const l of listeners) l();
}
