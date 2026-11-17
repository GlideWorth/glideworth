/**
 * Self-host invite and passphrase-reset links (`/accept`). The one-time token goes in the URL fragment, which
 * is never sent to a server (so a reverse proxy cannot log it), and the page removes it from the address bar
 * and the history entry once read. Links handed out before this change carry it in the query string; they
 * still work and are cleared the same way.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AcceptPage, acceptLink } from "../src/features/share/accept-page";
import { mockFetch } from "./cloud-helpers";

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useSearch: () => Object.fromEntries(new URLSearchParams(window.location.search)),
}));

const PASS = "correct horse battery staple";

async function acceptWith(passphrase: string) {
  fireEvent.change(screen.getByLabelText("New passphrase"), { target: { value: passphrase } });
  fireEvent.change(screen.getByLabelText("Confirm passphrase"), { target: { value: passphrase } });
  fireEvent.click(screen.getByRole("button", { name: /Set passphrase and sign in/ }));
}

beforeEach(() => {
  window.history.replaceState(null, "", "/");
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("self-host /accept links", () => {
  it("are built with the token in the fragment", () => {
    expect(acceptLink("https://home.example", "tok/1")).toBe(
      "https://home.example/accept#token=tok%2F1",
    );
  });

  it("read the fragment token, clear it from the address bar, and send it in the body only", async () => {
    window.history.replaceState(null, "", "/accept#token=frag-tok");
    const api = mockFetch({ "POST /api/v1/auth/accept": {} });
    render(<AcceptPage />);
    expect(window.location.hash).toBe("");
    expect(window.location.href).not.toContain("frag-tok");
    await acceptWith(PASS);
    await waitFor(() => expect(api.last("POST /api/v1/auth/accept")).toBeDefined());
    expect(api.last("POST /api/v1/auth/accept")!.body).toEqual({
      token: "frag-tok",
      passphrase: PASS,
    });
  });

  it("still accept an older link with the token in the query string, and clear it", async () => {
    window.history.replaceState(null, "", "/accept?token=query-tok");
    const api = mockFetch({ "POST /api/v1/auth/accept": {} });
    render(<AcceptPage />);
    expect(window.location.search).toBe("");
    expect(window.location.href).not.toContain("query-tok");
    await acceptWith(PASS);
    await waitFor(() => expect(api.last("POST /api/v1/auth/accept")).toBeDefined());
    expect(api.last("POST /api/v1/auth/accept")!.body).toEqual({
      token: "query-tok",
      passphrase: PASS,
    });
  });
});
