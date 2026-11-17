/**
 * Product analytics and browser error reports through PostHog, on the hosted service only.
 *
 * PostHog runs only when the bundle was built with VITE_PUBLIC_POSTHOG_PROJECT_TOKEN and
 * VITE_PUBLIC_POSTHOG_HOST. The official production image sets both (image-artifact workflow); self-host
 * images and local builds leave them empty, so they load no analytics at all.
 *
 * What is sent: page views, the named product events (see the capture calls), clicks with their text and
 * attributes masked, and uncaught errors. Session recording is off. URLs lose their query string and fragment
 * (one-time tokens travel there) and share-link tokens are replaced, before anything leaves the browser.
 * Signed-in people are identified by their user id and email address. Storage: local storage only, no cookie.
 */
import {
  PostHogErrorBoundary,
  type PostHogErrorBoundaryFallbackProps,
  PostHogProvider,
  usePostHog,
} from "@posthog/react";
import type { CaptureResult } from "posthog-js";
import { type ComponentType, type ReactNode, useEffect, useRef } from "react";
import { useSession } from "./auth";

const token = import.meta.env.VITE_PUBLIC_POSTHOG_PROJECT_TOKEN as string | undefined;
const host = import.meta.env.VITE_PUBLIC_POSTHOG_HOST as string | undefined;

const URL_KEY = /url|pathname|referrer|href/i;

/** Drop the query string and fragment, and hide share-link tokens (`/share/<token>` is a bearer secret). */
export function scrubUrl(value: string): string {
  return (value.split(/[?#]/, 1)[0] ?? "").replace(/\/share\/[^/]+/g, "/share/:token");
}

function scrubRecord(r: Record<string, unknown> | undefined): void {
  if (!r) return;
  for (const [k, v] of Object.entries(r))
    if (typeof v === "string" && URL_KEY.test(k)) r[k] = scrubUrl(v);
}

/** PostHog `before_send`: scrub every URL-like property, including the person properties set once. */
export function scrubEvent(event: CaptureResult | null): CaptureResult | null {
  if (!event) return event;
  scrubRecord(event.properties);
  scrubRecord(event.$set);
  scrubRecord(event.$set_once);
  return event;
}

/** Follows the session: identify on sign-in (id and email only), reset on sign-out or a different user. */
function Identity() {
  const posthog = usePostHog();
  const session = useSession().data;
  const identified = useRef<string | null>(null);
  const cloud = session?.kind === "authenticated" ? session.cloud : undefined;
  const userId = cloud?.user.id;
  const email = cloud?.user.email;

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
    posthog.identify(userId, email ? { email } : {});
    identified.current = userId;
  }, [posthog, session, userId, email]);

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
        api_host: host,
        person_profiles: "identified_only",
        persistence: "localStorage",
        capture_pageview: "history_change",
        capture_exceptions: true,
        disable_session_recording: true,
        // Off: heatmaps key their data by page URL and web vitals nest URLs, past what before_send scrubs.
        enable_heatmaps: false,
        capture_performance: false,
        capture_dead_clicks: false,
        mask_all_text: true,
        mask_all_element_attributes: true,
        before_send: scrubEvent,
        debug: import.meta.env.DEV,
      }}
    >
      <Identity />
      <PostHogErrorBoundary fallback={onError}>{children}</PostHogErrorBoundary>
    </PostHogProvider>
  );
}
