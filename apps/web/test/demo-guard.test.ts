/**
 * On a /demo page the network guard is installed at start-up (lib/demo.ts): `fetch` and `XMLHttpRequest`
 * refuse the server's paths, so even code that forgets about the demo cannot send the visitor's session
 * cookie to the API. Its own file: installing the guard changes this test environment's globals.
 */
import { afterAll, describe, expect, it, vi } from "vitest";
import { DemoNetworkBlocked, installDemoNetworkGuard } from "../src/lib/demo";

const realFetch = window.fetch;
const realOpen = XMLHttpRequest.prototype.open;

afterAll(() => {
  window.fetch = realFetch;
  XMLHttpRequest.prototype.open = realOpen;
});

describe("the demo network guard", () => {
  it("wraps the page's fetch and XMLHttpRequest once", async () => {
    const inner = vi.fn(async () => new Response("ok"));
    window.fetch = inner as unknown as typeof fetch;
    installDemoNetworkGuard();
    installDemoNetworkGuard();

    await expect(
      fetch("/api/v1/households", { credentials: "same-origin" }),
    ).rejects.toBeInstanceOf(DemoNetworkBlocked);
    await expect(fetch("/api/v1/auth/status")).rejects.toThrow(/does not contact the server/);
    expect(inner).not.toHaveBeenCalled();
    await fetch("/relay/e/");
    expect(inner).toHaveBeenCalledTimes(1);

    const xhr = new XMLHttpRequest();
    expect(() => xhr.open("GET", "/api/v1/plans")).toThrow(DemoNetworkBlocked);
    expect(() => new XMLHttpRequest().open("POST", "/relay/e/")).not.toThrow();
  });
});
