import { describe, expect, it } from "vitest";
import { sitePostHog, sitePostHogOnPath } from "./posthog";

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

describe("sitePostHogOnPath", () => {
  it("stays off the calculators, where visitors type figures", () => {
    for (const p of ["/tools/", "/tools", "/tools/coast-fire-calculator/", "tools/engine-check/"])
      expect(sitePostHogOnPath(p, TOKEN, HOST), p).toBeUndefined();
  });

  it("loads on marketing pages when configured", () => {
    for (const p of ["/", "/pricing/", "/blog/coast-fire/", "/toolsmith/"])
      expect(sitePostHogOnPath(p, TOKEN, HOST)?.token, p).toBe(TOKEN);
  });

  it("loads nowhere without a token (self-hosted and default builds)", () => {
    expect(sitePostHogOnPath("/", undefined, HOST)).toBeUndefined();
  });
});
