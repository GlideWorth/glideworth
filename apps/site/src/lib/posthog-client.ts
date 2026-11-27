/**
 * Starts PostHog on a marketing page (PostHog.astro renders the config into a meta tag), the calculators under
 * `/tools/` included.
 *
 * Cookieless: `cookieless_mode: "always"` stores nothing in cookies, local or session storage, and PostHog
 * counts visitors from a daily server-side hash instead, so there is no consent banner for it. That mode has
 * no session recordings; page views, page leaves, clicks, heatmaps, scroll depth and web vitals work.
 * Everything goes to `/relay` on this origin (Caddy forwards it to PostHog).
 *
 * Nothing a visitor types into a calculator, and no result it shows, goes with an event:
 *  - `before_send` (posthog-scrub.ts) strips the query string and fragment from every URL on every page (the
 *    calculators keep their inputs in the query string) and, on calculator pages, drops element text and any
 *    property that can carry typed or selected text.
 *  - On calculator pages `mask_all_text` keeps element text out of clicks, dead clicks and rage clicks in the
 *    first place. Element attributes (input `value`s included) are masked on every page, input values are
 *    never captured (no `capture_value_css_selector_allowlist`), copied text is not captured, and there are no
 *    session recordings.
 */
import { isCalculatorPath, scrubSiteEvent } from "./posthog-scrub";

export const SITE_POSTHOG_META = "glideworth-posthog";

/** The two events the "Email me this result" form sends (components/CalculatorEmail.astro). */
export const CALCULATOR_EMAIL_EVENTS = {
  viewed: "calculator_email_form_viewed",
  submitted: "calculator_email_form_submitted",
} as const;

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
    void import("posthog-js").then(({ default: posthog }) => {
      init(posthog, token, uiHost, isCalculatorPath(win.location.pathname));
      trackCalculatorEmail(doc, win, (event, properties) => posthog.capture(event, properties));
    });
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

function init(posthog: PostHog, token: string, uiHost: string, calculator: boolean): void {
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
    autocapture: { capture_copied_text: false },
    disable_session_recording: true,
    disable_surveys: true,
    advanced_disable_feature_flags: true,
    mask_all_element_attributes: true,
    mask_all_text: calculator,
    properties_string_max_length: 1000,
    before_send: (event) => scrubSiteEvent(event, calculator),
  });
  posthog.register({ site: "marketing" });
}

type Capture = (event: string, properties: { tool: string }) => void;

/**
 * The calculator's email form came into view (once per page load) and was submitted. The calculator id is the
 * only property; never the address, the inputs or the figures. A submit event fires only once the browser's
 * own checks pass (a well-formed address); whether the email was then sent is the server's
 * `calculator_email_requested`.
 */
export function trackCalculatorEmail(doc: Document, win: Window, capture: Capture): void {
  for (const form of doc.querySelectorAll<HTMLFormElement>("form[data-calc-email]")) {
    const tool = form.querySelector<HTMLInputElement>('input[name="tool"]')?.value;
    if (!tool) continue;
    form.addEventListener("submit", () => capture(CALCULATOR_EMAIL_EVENTS.submitted, { tool }));
    const Observer = (win as Window & typeof globalThis).IntersectionObserver;
    if (typeof Observer !== "function") continue;
    let seen = false;
    const observer = new Observer(
      (entries) => {
        if (seen || !entries.some((e) => e.isIntersecting)) return;
        seen = true;
        observer.disconnect();
        capture(CALCULATOR_EMAIL_EVENTS.viewed, { tool });
      },
      { threshold: 0.5 },
    );
    observer.observe(form);
  }
}
