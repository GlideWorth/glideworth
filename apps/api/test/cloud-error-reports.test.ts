/**
 * Server error reports in cloud mode (design 6.4): an unhandled route error is logged and sent to PostHog as a
 * `$exception` carrying the workspace's account id, the route template and the error's name, fingerprint and
 * stack frames, never its message or the request.
 */
import { createSampleDocument } from "@glideworth/core/samples";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootCloud, type Cloud, signUp } from "./cloud-harness.js";

// oxlint-disable-next-line typescript/no-explicit-any -- captured request bodies are untyped JSON
const sent: Array<{ url: string; body: Record<string, any> }> = [];
let cloud: Cloud;

beforeAll(async () => {
  cloud = await bootCloud({
    env: {
      GLIDEWORTH_POSTHOG_PROJECT_TOKEN: "phc_cloudapitests123",
      GLIDEWORTH_POSTHOG_HOST: "https://posthog.example.test",
    },
    deps: {
      simulate: () => {
        throw new Error("plan 'Zephyrine retirement' with 918273.64 is broken");
      },
    },
    errorReportFetch: (async (url: string, init: RequestInit) => {
      sent.push({ url, body: JSON.parse(String(init.body)) });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch,
  });
});
afterAll(async () => {
  await cloud?.close();
});

describe("cloud error reports", () => {
  it("reports a thrown route error to PostHog without its message", async () => {
    const { browser, accountId } = await signUp(cloud);
    const sample = createSampleDocument();
    const r = await browser.post("/api/v1/simulate?token=abc", {
      household: sample.household,
      finances: sample.finances,
      plan: sample.plans[0],
    });
    expect(r.status).toBe(500);
    await cloud.rt.errorReporter?.flush();

    const reports = sent.filter((s) => s.body.properties.logEvent === "http.unhandled");
    expect(reports).toHaveLength(1);
    const { url, body } = reports[0]!;
    expect(url).toBe("https://posthog.example.test/i/v0/e/");
    expect(body).toMatchObject({
      api_key: "phc_cloudapitests123",
      event: "$exception",
      distinct_id: accountId,
      properties: {
        $exception_list: [{ type: "Error" }],
        $process_person_profile: false,
        accountId,
        route: "/api/v1/simulate",
        method: "POST",
        errName: "Error",
      },
    });
    const frames = body.properties.$exception_list[0].stacktrace.frames as Array<{
      filename: string;
    }>;
    expect(frames.some((f) => f.filename.includes("cloud-error-reports.test.ts"))).toBe(true);
    const all = JSON.stringify(sent);
    for (const s of ["Zephyrine", "918273.64", "token=abc", "@example", "Avery", "Robin"])
      expect(all).not.toContain(s);
  });
});
