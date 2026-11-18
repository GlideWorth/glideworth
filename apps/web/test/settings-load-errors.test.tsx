/**
 * Settings lists that fail to load: a 402 is an answer from the server (trial not started, or the
 * workspace is read-only), not a network failure. Only a request with no HTTP answer says "not reachable".
 */
import { cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KeysSection } from "../src/features/settings/keys-section";
import { PeopleSection } from "../src/features/settings/people-section";
import { WebhooksSection } from "../src/features/settings/webhooks-section";
import { describeLoadError } from "../src/lib/api-problems";
import { ApiRequestError } from "../src/lib/api-error";
import { apiError, mockFetch, renderWithClient, signedIn, withCsrfCookie } from "./cloud-helpers";

vi.mock("@tanstack/react-router", async (importOriginal) =>
  (await import("./cloud-helpers")).routerMock(importOriginal as never),
);

beforeEach(() => withCsrfCookie("csrf-tok"));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const NO_SUB = () =>
  apiError(402, "ACCOUNT_READ_ONLY", "Read only.", {
    reason: "no_subscription",
    billingUrl: "/settings/billing",
  });
const ENDED = () => apiError(402, "ACCOUNT_READ_ONLY", "Read only.", { reason: "trial_ended" });
const READ_ONLY = "This workspace is read-only. The owner can subscribe in billing settings.";

const SECTIONS = [
  { name: "keys", path: "GET /api/v1/keys", ui: <KeysSection />, trial: "use API keys" },
  {
    name: "webhooks",
    path: "GET /api/v1/webhooks",
    ui: <WebhooksSection />,
    trial: "use webhooks",
  },
  { name: "people", path: "GET /api/v1/users", ui: <PeopleSection />, trial: "see this" },
] as const;

describe.each(SECTIONS)("$name section load errors", ({ path, ui, trial }) => {
  const extra = (p: string) => ({
    "GET /api/v1/oauth/grants": { items: [] },
    "GET /api/v1/oauth/clients": { items: [] },
    [p]: { items: [] },
  });

  it("no_subscription: asks to subscribe and links to billing", async () => {
    mockFetch({ ...extra(path), [path]: NO_SUB });
    renderWithClient(ui, signedIn("owner"));
    await screen.findByText(`Subscribe to ${trial}.`);
    expect(screen.getByRole("link", { name: "Open billing settings" })).toBeTruthy();
    expect(screen.queryByText(/not reachable/)).toBeNull();
  });

  it("another read-only reason: says the workspace is read-only", async () => {
    mockFetch({ ...extra(path), [path]: ENDED });
    renderWithClient(ui, signedIn("owner"));
    await screen.findByText(READ_ONLY);
    expect(screen.queryByText(/not reachable/)).toBeNull();
  });

  it("network failure: says the server is not reachable", async () => {
    const fn = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    vi.stubGlobal("fetch", fn);
    renderWithClient(ui, signedIn("owner"));
    await screen.findAllByText("The Glideworth server is not reachable.");
  });

  it("any other HTTP error: neutral line, not 'not reachable'", async () => {
    mockFetch({ ...extra(path), [path]: apiError(500, "INTERNAL", "Boom") });
    renderWithClient(ui, signedIn("owner"));
    await screen.findByText("Glideworth could not load this. Try again in a moment.");
    expect(screen.queryByText(/not reachable/)).toBeNull();
  });
});

describe("keys section", () => {
  it("keeps New key disabled after a 402", async () => {
    mockFetch({ "GET /api/v1/keys": NO_SUB });
    renderWithClient(<KeysSection />, signedIn("owner"));
    await screen.findByText("Subscribe to use API keys.");
    await waitFor(() =>
      expect((screen.getByRole("button", { name: /New key/ }) as HTMLButtonElement).disabled).toBe(
        true,
      ),
    );
  });
});

describe("describeLoadError", () => {
  const o = { use: "use X", forbidden: "F", missing: "M" };
  it("maps statuses", () => {
    expect(describeLoadError(new ApiRequestError(403, "FORBIDDEN", "x"), o).text).toBe("F");
    expect(describeLoadError(new ApiRequestError(501, "NOT_IMPLEMENTED", "x"), o).text).toBe("M");
    expect(describeLoadError(new ApiRequestError(0, "NETWORK", "x"), o).text).toBe(
      "The Glideworth server is not reachable.",
    );
    expect(describeLoadError(new Error("parse"), o).text).toBe(
      "Glideworth could not load this. Try again in a moment.",
    );
  });
});
