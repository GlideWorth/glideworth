/**
 * "Send feedback": opens the in-app feedback survey from PostHog Surveys, on the hosted service only.
 *
 * The survey is an `api` survey in the Glideworth PostHog project: PostHog never shows it on its own, only when
 * someone presses a feedback button (`openFeedback`). Its id comes from VITE_PUBLIC_POSTHOG_FEEDBACK_SURVEY_ID at
 * build time. Without it, or without PostHog (self-host images, local builds), or before PostHog has loaded the
 * survey (a blocked relay, surveys off in the project), `useFeedbackAvailable` is false and no button shows.
 * Responses arrive in PostHog as `survey sent` events from the signed-in person.
 */
import type { PostHog, Survey } from "posthog-js";
import { useSyncExternalStore } from "react";

/** The part of the PostHog client this module uses (tests pass a fake). */
type SurveyClient = Pick<PostHog, "onSurveysLoaded" | "displaySurvey">;

export const FEEDBACK_SURVEY_ID = import.meta.env.VITE_PUBLIC_POSTHOG_FEEDBACK_SURVEY_ID as
  | string
  | undefined;

let client: SurveyClient | null = null;
const listeners = new Set<() => void>();

function set(next: SurveyClient | null) {
  if (client === next) return;
  client = next;
  for (const l of listeners) l();
}

/**
 * Called once PostHog has initialised (the `loaded` option in analytics.tsx). Marks feedback available when the
 * survey arrives with the project's surveys, and unavailable again if a later reload no longer has it.
 */
export function watchFeedbackSurvey(posthog: SurveyClient, surveyId = FEEDBACK_SURVEY_ID): void {
  if (!surveyId) return;
  posthog.onSurveysLoaded((surveys: Survey[]) => {
    set(surveys.some((s) => s.id === surveyId) ? posthog : null);
  });
}

/** Open the feedback survey as a popover. No-op when it is not available. */
export function openFeedback(surveyId = FEEDBACK_SURVEY_ID): void {
  if (!client || !surveyId) return;
  client.displaySurvey(surveyId, {
    displayType: "popover",
    // The button is the trigger: no targeting, no "seen it already", no delay.
    ignoreConditions: true,
    ignoreDelay: true,
  });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** True once the feedback survey can be opened. */
export function useFeedbackAvailable(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => client !== null,
    () => false,
  );
}

/** Tests only. */
export function resetFeedbackForTests(): void {
  set(null);
}
