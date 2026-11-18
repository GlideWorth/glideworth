import type { CaptureResult } from "posthog-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CapturedNetworkRequest } from "posthog-js";
import {
  isSharePath,
  scrubEvent,
  scrubNetworkRequest,
  scrubUrl,
  uiHostFor,
} from "../src/lib/analytics";

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

  it("scrubs nested URLs: web vitals and autocapture elements", () => {
    const event = {
      uuid: "2",
      event: "$web_vitals",
      properties: {
        $web_vitals_LCP_event: {
          value: 1200,
          $current_url: "https://app.glideworth.com/share/tok#x",
          attribution: { url: "https://app.glideworth.com/verify-email?token=t" },
        },
        $elements: [{ tag_name: "a", href: "/share/tok" }],
      },
    } as unknown as CaptureResult;
    const props = scrubEvent(event)!.properties as {
      $web_vitals_LCP_event: { value: number; $current_url: string; attribution: { url: string } };
      $elements: { href: string }[];
    };
    expect(props.$web_vitals_LCP_event.$current_url).toBe(
      "https://app.glideworth.com/share/:token",
    );
    expect(props.$web_vitals_LCP_event.attribution.url).toBe(
      "https://app.glideworth.com/verify-email",
    );
    expect(props.$web_vitals_LCP_event.value).toBe(1200);
    expect(props.$elements[0]!.href).toBe("/share/:token");
  });

  it("re-keys heatmap data by the scrubbed URL, merging points", () => {
    const event = {
      uuid: "3",
      event: "$$heatmap",
      properties: {
        $heatmap_data: {
          "https://app.glideworth.com/share/a?x=1": [{ x: 1 }],
          "https://app.glideworth.com/share/b": [{ x: 2 }],
          "https://app.glideworth.com/plans": [{ x: 3 }],
        },
      },
    } as unknown as CaptureResult;
    expect(scrubEvent(event)!.properties.$heatmap_data).toEqual({
      "https://app.glideworth.com/share/:token": [{ x: 1 }, { x: 2 }],
      "https://app.glideworth.com/plans": [{ x: 3 }],
    });
  });

  it("leaves recording data alone", () => {
    const data = [{ type: 4, data: { href: "https://app.glideworth.com/plans?x=1" } }];
    const event = {
      uuid: "4",
      event: "$snapshot",
      properties: { $snapshot_data: data },
    } as unknown as CaptureResult;
    expect(scrubEvent(event)!.properties.$snapshot_data).toBe(data);
    expect(data[0]!.data.href).toBe("https://app.glideworth.com/plans?x=1");
  });

  it("passes null through", () => {
    expect(scrubEvent(null)).toBeNull();
  });
});

describe("scrubNetworkRequest", () => {
  it("scrubs the URL the recorder passes for pages and network requests", () => {
    const req = {
      name: "https://app.glideworth.com/share/tok?a=1",
      isInitial: true,
    } as CapturedNetworkRequest;
    expect(scrubNetworkRequest(req)).toEqual({
      name: "https://app.glideworth.com/share/:token",
      isInitial: true,
    });
  });
});

describe("isSharePath", () => {
  it("matches shared-plan pages only", () => {
    expect(isSharePath("/share/tok")).toBe(true);
    expect(isSharePath("/share")).toBe(true);
    expect(isSharePath("/shared-things")).toBe(false);
    expect(isSharePath("/plans")).toBe(false);
  });
});

describe("uiHostFor", () => {
  it("maps the ingestion host to the PostHog app", () => {
    expect(uiHostFor("https://us.i.posthog.com")).toBe("https://us.posthog.com");
    expect(uiHostFor("https://eu.i.posthog.com")).toBe("https://eu.posthog.com");
    expect(uiHostFor("https://ph.example.com")).toBe("https://ph.example.com");
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
