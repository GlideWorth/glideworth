import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CALCULATOR_EMAIL_EVENTS, trackCalculatorEmail } from "./posthog-client";
import { sitePostHog } from "./posthog";

const TOKEN = "phc_testprojecttoken1234567890";
const HOST = "https://us.i.posthog.com";

describe("sitePostHog", () => {
  it("is off when either value is unset or blank", () => {
    expect(sitePostHog(undefined, undefined)).toBeUndefined();
    expect(sitePostHog("", HOST)).toBeUndefined();
    expect(sitePostHog(TOKEN, "")).toBeUndefined();
    expect(sitePostHog("  ", "  ")).toBeUndefined();
  });

  it("accepts a project token and a PostHog cloud ingestion host", () => {
    expect(sitePostHog(` ${TOKEN} `, `${HOST}/`)).toEqual({
      token: TOKEN,
      uiHost: "https://us.posthog.com",
    });
    expect(sitePostHog(TOKEN, "https://eu.i.posthog.com")?.uiHost).toBe("https://eu.posthog.com");
  });

  it("rejects anything else", () => {
    expect(sitePostHog("phx_personalapikey1234567890abcdef", HOST)).toBeUndefined();
    expect(sitePostHog('phc_abc"><script>alert(1)</script>', HOST)).toBeUndefined();
    expect(sitePostHog(TOKEN, "https://evil.example.com")).toBeUndefined();
    expect(sitePostHog(TOKEN, "http://us.i.posthog.com")).toBeUndefined();
    expect(sitePostHog(TOKEN, "https://us.posthog.com")).toBeUndefined();
  });
});

describe("the site's posthog.init", () => {
  const client = readFileSync(join(import.meta.dirname, "posthog-client.ts"), "utf8");
  const init = client.slice(client.indexOf("posthog.init("), client.indexOf("posthog.register("));

  it("keeps what a visitor types out of every event", () => {
    expect(init).toContain("before_send: (event) => scrubSiteEvent(event, calculator)");
    expect(init).toContain("mask_all_text: calculator");
    expect(init).toContain("mask_all_element_attributes: true");
    expect(init).toContain("autocapture: { capture_copied_text: false }");
    expect(client).toContain("isCalculatorPath(win.location.pathname)");
    // Typed values are captured only through this allowlist; recordings would show the page.
    expect(init).not.toContain("capture_value_css_selector_allowlist");
    expect(init).toContain("disable_session_recording: true");
    expect(init).toContain('cookieless_mode: "always"');
  });
});

describe("trackCalculatorEmail", () => {
  type Listener = () => void;
  function setup(tool: string | null) {
    const listeners: Listener[] = [];
    let observed: ((entries: { isIntersecting: boolean }[]) => void) | undefined;
    let disconnected = 0;
    const form = {
      querySelector: () => (tool === null ? null : { value: tool }),
      addEventListener: (type: string, fn: Listener) => type === "submit" && listeners.push(fn),
    };
    const doc = { querySelectorAll: () => [form] } as unknown as Document;
    class FakeObserver {
      constructor(cb: (entries: { isIntersecting: boolean }[]) => void) {
        observed = cb;
      }
      observe() {}
      disconnect() {
        disconnected++;
      }
    }
    const win = { IntersectionObserver: FakeObserver } as unknown as Window;
    const sent: [string, unknown][] = [];
    trackCalculatorEmail(doc, win, (e, p) => sent.push([e, p]));
    return {
      sent,
      submit: () => listeners.forEach((l) => l()),
      see: (v: boolean) => observed?.([{ isIntersecting: v }]),
      disconnects: () => disconnected,
    };
  }

  it("sends the view once and every submit, with the calculator id as the only property", () => {
    const t = setup("coast-fire");
    t.see(false);
    t.see(true);
    t.see(true);
    t.submit();
    expect(t.sent).toEqual([
      [CALCULATOR_EMAIL_EVENTS.viewed, { tool: "coast-fire" }],
      [CALCULATOR_EMAIL_EVENTS.submitted, { tool: "coast-fire" }],
    ]);
    expect(t.disconnects()).toBe(1);
  });

  it("sends nothing for a form without a calculator id", () => {
    const t = setup(null);
    t.see(true);
    t.submit();
    expect(t.sent).toEqual([]);
  });
});
