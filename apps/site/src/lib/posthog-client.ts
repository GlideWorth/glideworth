/**
 * Starts PostHog on a marketing page (PostHog.astro renders the config into a meta tag).
 *
 * Cookieless: `cookieless_mode: "always"` stores nothing in cookies, local or session storage, and PostHog
 * counts visitors from a daily server-side hash instead, so there is no consent banner for it. That mode has
 * no session recordings; page views, page leaves, clicks, heatmaps, scroll depth and web vitals work.
 * Everything goes to `/relay` on this origin (Caddy forwards it to PostHog).
 */
export const SITE_POSTHOG_META = "glideworth-posthog";

/**
 * Reads the config and, once the page has loaded and the browser is idle, fetches posthog-js (a separate
 * same-origin chunk) and starts it, so the SDK never competes with the page's own text, styles and fonts.
 */
export function startSitePostHog(doc: Document = document, win: Window = window): boolean {
  const meta = doc.querySelector<HTMLMetaElement>(`meta[name="${SITE_POSTHOG_META}"]`);
  const token = meta?.content;
  const uiHost = meta?.dataset.uiHost;
  if (!token || !uiHost) return false;
  const load = () => {
    void import("posthog-js").then(({ default: posthog }) => init(posthog, token, uiHost));
  };
  const whenIdle = () => {
    if ("requestIdleCallback" in win) win.requestIdleCallback(load, { timeout: 2000 });
    else setTimeout(load, 200);
  };
  if (doc.readyState === "complete") whenIdle();
  else win.addEventListener("load", whenIdle, { once: true });
  return true;
}

type PostHog = typeof import("posthog-js").default;

function init(posthog: PostHog, token: string, uiHost: string): void {
  posthog.init(token, {
    api_host: "/relay",
    ui_host: uiHost,
    defaults: "2026-01-30",
    cookieless_mode: "always",
    person_profiles: "identified_only",
    capture_pageview: true,
    capture_pageleave: true,
    capture_heatmaps: true,
    capture_dead_clicks: true,
    capture_performance: { web_vitals: true, network_timing: false },
    capture_exceptions: false,
    disable_session_recording: true,
    disable_surveys: true,
    advanced_disable_feature_flags: true,
    mask_all_element_attributes: true,
    properties_string_max_length: 1000,
  });
  posthog.register({ site: "marketing" });
}
