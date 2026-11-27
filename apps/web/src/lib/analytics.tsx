/**
 * Product analytics, session replay and browser error reports through PostHog, on the hosted service only.
 *
 * PostHog runs only when the bundle was built with VITE_PUBLIC_POSTHOG_PROJECT_TOKEN and
 * VITE_PUBLIC_POSTHOG_HOST. The official production image sets both (image-artifact workflow); self-host
 * images and local builds leave them empty, so they load no analytics at all.
 *
 * What is sent: page views and page leaves, the named product events (see the capture calls), clicks with their
 * text (element attributes masked), dead clicks, heatmaps, web vitals and network timings, uncaught errors, errors
 * a route's error boundary caught (`reportError`), and session recordings. Recordings show what is on screen,
 * figures included, with every form input masked; they are paused on shared-plan pages (`/share/<token>`), whose
 * visitors are not our users. URLs lose their query string and fragment (one-time tokens travel there) and
 * share-link tokens are replaced, in events, heatmaps, web vitals and recordings, before anything leaves the
 * browser. Signed-in people are identified by their user id, email address and name; each event carries the
 * workspace's plan status and the person's role. Answers to the feedback survey (lib/feedback.ts) are sent only
 * when someone opens it and presses submit. Storage: local storage only, no cookie.
 *
 * Production bundles send to `/relay` on the app's own origin, which Caddy forwards to PostHog (the snippet
 * infra/scripts/gen-csp.sh writes from the image's /app/posthog-host); development sends to the host directly.
 */
import {
  PostHogErrorBoundary,
  type PostHogErrorBoundaryFallbackProps,
  PostHogProvider,
  usePostHog,
} from "@posthog/react";
import { useRouterState } from "@tanstack/react-router";
import posthog, { type CaptureResult, type CapturedNetworkRequest } from "posthog-js";
import { type ComponentType, type ReactNode, useEffect, useRef } from "react";
import { useSession } from "./auth";
import { watchFeedbackSurvey } from "./feedback";

const token = import.meta.env.VITE_PUBLIC_POSTHOG_PROJECT_TOKEN as string | undefined;
const host = import.meta.env.VITE_PUBLIC_POSTHOG_HOST as string | undefined;

/** The path Caddy forwards to PostHog in production (infra/scripts/gen-csp.sh). */
const RELAY_PATH = "/relay";

const URL_KEY = /url|pathname|referrer|href/i;
/** Nested objects (web vitals, autocapture elements) are scrubbed this deep; PostHog's own nest two or three. */
const MAX_DEPTH = 6;

/** Drop the query string and fragment, and hide share-link tokens (`/share/<token>` is a bearer secret). */
export function scrubUrl(value: string): string {
  return (value.split(/[?#]/, 1)[0] ?? "").replace(/\/share\/[^/]+/g, "/share/:token");
}

export function isSharePath(pathname: string): boolean {
  return /^\/share(\/|$)/.test(pathname);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function scrubRecord(r: Record<string, unknown> | undefined, depth = 0): void {
  if (!r || depth > MAX_DEPTH) return;
  for (const [k, v] of Object.entries(r)) {
    // Recording data is scrubbed by the recorder itself (maskCapturedNetworkRequestFn) and may be compressed.
    if (k === "$snapshot_data") continue;
    if (typeof v === "string") {
      if (URL_KEY.test(k)) r[k] = scrubUrl(v);
    } else if (k === "$heatmap_data" && isRecord(v)) {
      // Heatmap points are keyed by page URL.
      const out: Record<string, unknown> = {};
      for (const [url, points] of Object.entries(v)) {
        const key = scrubUrl(url);
        out[key] =
          Array.isArray(out[key]) && Array.isArray(points) ? [...out[key], ...points] : points;
      }
      r[k] = out;
    } else if (Array.isArray(v)) {
      for (const item of v) if (isRecord(item)) scrubRecord(item, depth + 1);
    } else if (isRecord(v)) {
      scrubRecord(v, depth + 1);
    }
  }
}

/** PostHog `before_send`: scrub every URL-like property, nested ones and person properties included. */
export function scrubEvent(event: CaptureResult | null): CaptureResult | null {
  if (!event) return event;
  scrubRecord(event.properties);
  scrubRecord(event.$set);
  scrubRecord(event.$set_once);
  return event;
}

/**
 * Replay's URL hook: network requests in recordings, and the page URLs the recorder stores (it passes those
 * through this function too, as `{ name: url }`).
 */
export function scrubNetworkRequest(request: CapturedNetworkRequest): CapturedNetworkRequest {
  return typeof request.name === "string" ? { ...request, name: scrubUrl(request.name) } : request;
}

/** `us.i.posthog.com` (ingestion) -> `us.posthog.com` (the app, for links from the toolbar and surveys). */
export function uiHostFor(ingestHost: string): string {
  return ingestHost.replace(/^(https?:\/\/[a-z]+)\.i\.posthog\.com/i, "$1.posthog.com");
}

/**
 * Send an error the app caught itself (the router's per-route error boundary) to PostHog. Those never reach
 * `PostHogErrorBoundary` or the window error handler, so they would go unreported. No-op without PostHog.
 */
export function reportError(error: unknown): void {
  if (token && host && posthog.__loaded) posthog.captureException(error);
}

/**
 * Follows the session: identify on sign-in (id, email, name), reset on sign-out or a different user. Registers
 * the workspace's plan status, access level and the person's role on every event, so funnels and replays can be
 * filtered by trial vs paying.
 */
function Identity() {
  const posthog = usePostHog();
  const session = useSession().data;
  const identified = useRef<string | null>(null);
  const cloud = session?.kind === "authenticated" ? session.cloud : undefined;
  const userId = cloud?.user.id;
  const email = cloud?.user.email;
  const name = cloud?.user.name;
  const workspace = cloud?.workspace;
  const planStatus = workspace?.access?.reason;
  const accessLevel = workspace?.access?.level;
  const role = workspace?.role;

  useEffect(() => {
    // An unresolved session must not clear the anonymous id during the first status request.
    if (!session) return;
    if (!userId) {
      if (identified.current) posthog.reset();
      identified.current = null;
      return;
    }
    if (identified.current === userId) return;
    if (identified.current) posthog.reset();
    posthog.identify(userId, {
      ...(email ? { email } : {}),
      ...(name && name !== email ? { name } : {}),
    });
    identified.current = userId;
  }, [posthog, session, userId, email, name]);

  useEffect(() => {
    if (!userId) return;
    posthog.register({
      ...(planStatus ? { plan_status: planStatus } : {}),
      ...(accessLevel ? { access_level: accessLevel } : {}),
      ...(role ? { workspace_role: role } : {}),
    });
  }, [posthog, userId, planStatus, accessLevel, role]);

  return null;
}

/** Pauses session recording on shared-plan pages and resumes it elsewhere. */
function RecordingScope() {
  const posthog = usePostHog();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const paused = useRef(false);
  const onShare = isSharePath(pathname);

  useEffect(() => {
    if (onShare) {
      posthog.stopSessionRecording();
      paused.current = true;
    } else if (paused.current) {
      posthog.startSessionRecording();
      paused.current = false;
    }
  }, [posthog, onShare]);

  return null;
}

export function Analytics({
  children,
  fallback: Fallback,
}: {
  children: ReactNode;
  fallback: ComponentType<{ error: Error; reset: () => void }>;
}) {
  if (!token || !host) return <>{children}</>;
  const onError = ({ error, resetError }: PostHogErrorBoundaryFallbackProps) => (
    <Fallback error={error as Error} reset={() => resetError?.()} />
  );
  return (
    <PostHogProvider
      apiKey={token}
      options={{
        api_host: import.meta.env.DEV ? host : RELAY_PATH,
        ui_host: uiHostFor(host),
        defaults: "2026-01-30",
        person_profiles: "identified_only",
        persistence: "localStorage",
        capture_pageview: "history_change",
        capture_pageleave: true,
        capture_exceptions: true,
        capture_heatmaps: true,
        capture_dead_clicks: true,
        capture_performance: true,
        // A visitor who lands on a shared plan starts with recording off (RecordingScope resumes it later).
        disable_session_recording: isSharePath(window.location.pathname),
        session_recording: {
          maskAllInputs: true,
          maskCapturedNetworkRequestFn: scrubNetworkRequest,
        },
        // Attributes can hold share-link URLs and one-time tokens (autocapture's element chain is not scrubbed).
        mask_all_element_attributes: true,
        before_send: scrubEvent,
        // The provider initialises the default instance, the one imported here.
        loaded: () => watchFeedbackSurvey(posthog),
        debug: import.meta.env.DEV,
      }}
    >
      <Identity />
      <RecordingScope />
      <PostHogErrorBoundary fallback={onError}>{children}</PostHogErrorBoundary>
    </PostHogProvider>
  );
}
