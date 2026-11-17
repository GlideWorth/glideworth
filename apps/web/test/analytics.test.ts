import type { CaptureResult } from "posthog-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { scrubEvent, scrubUrl } from "../src/lib/analytics";

const posthogMock = vi.hoisted(() => ({ __loaded: false, captureException: vi.fn() }));
vi.mock("posthog-js", () => ({ default: posthogMock }));

describe("scrubUrl", () => {
  it("drops the query string and fragment", () => {
    expect(scrubUrl("https://app.glideworth.com/verify-email#token=abc")).toBe(
      "https://app.glideworth.com/verify-email",
    );
    expect(scrubUrl("https://app.glideworth.com/settings/billing?checkout=success")).toBe(
      "https://app.glideworth.com/settings/billing",
    );
    expect(scrubUrl("/signin/2fa#challenge=x&next=/plans")).toBe("/signin/2fa");
  });

  it("hides share-link tokens", () => {
    expect(scrubUrl("https://app.glideworth.com/share/s3cr3t-token")).toBe(
      "https://app.glideworth.com/share/:token",
    );
    expect(scrubUrl("/share/s3cr3t/print?x=1")).toBe("/share/:token/print");
  });

  it("leaves ordinary paths alone", () => {
    expect(scrubUrl("https://app.glideworth.com/plans/abc123")).toBe(
      "https://app.glideworth.com/plans/abc123",
    );
  });
});

describe("scrubEvent", () => {
  it("scrubs URL properties, including person properties", () => {
    const event = {
      uuid: "1",
      event: "$pageview",
      properties: {
        $current_url: "https://app.glideworth.com/share/tok?a=1",
        $pathname: "/share/tok",
        $referrer: "https://www.google.com/search?q=retirement",
        utm_source: "newsletter",
        plan_count: 2,
      },
      $set_once: { $initial_current_url: "https://app.glideworth.com/accept#token=t" },
    } as unknown as CaptureResult;
    const out = scrubEvent(event)!;
    expect(out.properties).toMatchObject({
      $current_url: "https://app.glideworth.com/share/:token",
      $pathname: "/share/:token",
      $referrer: "https://www.google.com/search",
      utm_source: "newsletter",
      plan_count: 2,
    });
    expect(out.$set_once).toEqual({ $initial_current_url: "https://app.glideworth.com/accept" });
  });

  it("passes null through", () => {
    expect(scrubEvent(null)).toBeNull();
  });
});

describe("reportError", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    posthogMock.captureException.mockClear();
    posthogMock.__loaded = false;
  });

  /** The module reads the PostHog env at import, so load a fresh copy after stubbing it. */
  async function load(withPostHog: boolean) {
    vi.resetModules();
    vi.stubEnv("VITE_PUBLIC_POSTHOG_PROJECT_TOKEN", withPostHog ? "phc_test" : "");
    vi.stubEnv("VITE_PUBLIC_POSTHOG_HOST", withPostHog ? "https://us.i.posthog.com" : "");
    return (await import("../src/lib/analytics")).reportError;
  }

  it("sends a caught error to PostHog on the hosted build", async () => {
    const reportError = await load(true);
    posthogMock.__loaded = true;
    const err = new Error("boom");
    reportError(err);
    expect(posthogMock.captureException).toHaveBeenCalledWith(err);
  });

  it("does nothing without PostHog (self-host and local builds)", async () => {
    const reportError = await load(false);
    posthogMock.__loaded = true;
    reportError(new Error("boom"));
    expect(posthogMock.captureException).not.toHaveBeenCalled();
  });

  it("does nothing before PostHog has started", async () => {
    const reportError = await load(true);
    reportError(new Error("boom"));
    expect(posthogMock.captureException).not.toHaveBeenCalled();
  });
});
