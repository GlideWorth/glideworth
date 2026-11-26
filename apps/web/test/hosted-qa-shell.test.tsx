/**
 * Hosted-mode QA follow-ups (docs/launch/qa-hosted.md, items D to I, 15 and the rest of C), end to end through
 * the real router and app shell where the bug was in the shell, and on the component where it was not.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Dialog, DialogContent } from "../src/components/ui/dialog";
import { greetingName } from "../src/features/dashboard/dashboard-view";
import { createAppRouter } from "../src/router";
import { useUi } from "../src/stores/ui";
import { apiError, json } from "./cloud-helpers";

const SELFHOST_STATUS = {
  setupRequired: false,
  authenticated: true,
  via: "session",
  user: { id: "owner", name: "Owner", role: "owner" },
};
const WORKSPACE = {
  id: "acc_1",
  name: "Home",
  role: "owner",
  access: { level: "full", reason: "active", changesAt: null },
  trialEndsAt: null,
};
const CLOUD_SIGNED_IN = {
  mode: "cloud",
  authenticated: true,
  user: { id: "u1", email: "ada@example.com", name: "Ada", role: "owner", totp: false },
  workspace: WORKSPACE,
  workspaces: [{ id: "acc_1", name: "Home", role: "owner", access: null }],
};

type Route = (body: unknown) => Response;

function stubFetch(status: object, routes: Record<string, Route> = {}) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      const key = `${(init?.method ?? "GET").toUpperCase()} ${url.pathname}`;
      calls.push(key);
      if (url.pathname === "/api/v1/auth/status") return json(status);
      const r = routes[key];
      if (r) return r(init?.body ? JSON.parse(String(init.body)) : undefined);
      return apiError(404, "NOT_FOUND", "not found");
    }),
  );
  return calls;
}

let router: ReturnType<typeof createAppRouter>;
async function open(path: string) {
  router = createAppRouter(createMemoryHistory({ initialEntries: [path] }));
  await router.load();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

const noHousehold = { "GET /api/v1/households": () => json({ items: [] }) };

beforeEach(() => {
  window.matchMedia ??= ((q: string) => ({
    matches: false,
    media: q,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    onchange: null,
    dispatchEvent: () => false,
  })) as never;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as never;
  Element.prototype.scrollTo ??= () => undefined;
  Element.prototype.scrollIntoView ??= () => undefined;
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.releasePointerCapture ??= () => undefined;
});
afterEach(() => {
  cleanup();
  useUi.getState().setNavOpen(false);
  vi.unstubAllGlobals();
});

describe("phone navigation (item D)", () => {
  it("someone in two workspaces can switch from the navigation drawer", async () => {
    stubFetch(
      {
        ...CLOUD_SIGNED_IN,
        workspaces: [
          { id: "acc_1", name: "Home", role: "owner", access: null },
          { id: "acc_2", name: "Shared", role: "editor", access: null },
        ],
      },
      noHousehold,
    );
    await open("/settings/profile");
    fireEvent.click(await screen.findByRole("button", { name: "Open navigation menu" }));
    const drawer = await screen.findByRole("dialog", { name: "Navigation" });
    const picker = await within(drawer).findByRole("combobox", { name: "Workspace" });
    expect(picker.textContent).toMatch(/Home/);
  });

  it("self-host has no workspace switcher in the drawer", async () => {
    stubFetch(SELFHOST_STATUS, noHousehold);
    await open("/settings/profile");
    fireEvent.click(await screen.findByRole("button", { name: "Open navigation menu" }));
    const drawer = await screen.findByRole("dialog", { name: "Navigation" });
    await new Promise((r) => setTimeout(r, 30));
    expect(within(drawer).queryByRole("combobox", { name: "Workspace" })).toBeNull();
  });
});

describe("welcome page footer (item E)", () => {
  it("hosted: describes the workspace, not a self-hosted install", async () => {
    stubFetch(CLOUD_SIGNED_IN, noHousehold);
    await open("/welcome");
    const footer = (await screen.findByText(/Your data stays yours/)).closest("footer")!;
    expect(footer.textContent).toMatch(/saved in your workspace, which only its members can open/);
    expect(footer.textContent).not.toMatch(/no account to create|your own machine or server/);
  });

  it("self-host keeps its wording", async () => {
    stubFetch(SELFHOST_STATUS, noHousehold);
    await open("/welcome");
    const footer = (await screen.findByText(/Your data stays yours/)).closest("footer")!;
    expect(footer.textContent).toMatch(/runs on your own machine or server/);
    expect(footer.textContent).toMatch(/there is no account to create/);
  });
});

describe("shared plan page (item F)", () => {
  it("does not claim the link came from a private install", async () => {
    stubFetch(CLOUD_SIGNED_IN, {
      "GET /api/v1/shared/tok": () => apiError(404, "NOT_FOUND", "gone"),
    });
    await open("/share/tok");
    await screen.findByRole("heading", { name: "This link is no longer available" });
    const footer = document.querySelector("footer")!;
    expect(footer.textContent).not.toMatch(/private Glideworth install/);
    expect(footer.textContent).toMatch(/Shared with a Glideworth link/);
  });
});

describe("read-only workspace (item G)", () => {
  it("loading a sample shows one explanation, not two toasts", async () => {
    stubFetch(
      {
        ...CLOUD_SIGNED_IN,
        workspace: {
          ...WORKSPACE,
          access: { level: "read_only", reason: "canceled", changesAt: null },
        },
      },
      {
        ...noHousehold,
        "POST /api/v1/import": () =>
          apiError(402, "ACCOUNT_READ_ONLY", "the workspace is read-only; subscribe to edit", {
            reason: "canceled",
          }),
      },
    );
    await open("/welcome");
    fireEvent.click(await screen.findByRole("button", { name: /^Sam/ }));
    await screen.findByText("This workspace is read-only");
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText("Could not load the sample")).toBeNull();
    const toasts = screen
      .getAllByRole("alert")
      .filter((a) => a.closest("[aria-live]") && a.textContent?.match(/read-only|not saved/i));
    expect(toasts).toHaveLength(1);
  });
});

describe("connected apps in hosted mode (item H)", () => {
  it("lists the apps allowed in this workspace and says how one gets there", async () => {
    stubFetch(CLOUD_SIGNED_IN, {
      ...noHousehold,
      "GET /api/v1/me/oauth-grants": () => json({ items: [] }),
      "GET /api/v1/oauth/clients": () => json({ items: [] }),
    });
    await open("/settings/apps");
    expect(await screen.findByText("Apps in this workspace (everyone)")).toBeTruthy();
    expect(screen.getByText(/someone in this workspace allowed/)).toBeTruthy();
    expect(screen.getByText(/once someone approves it on the consent screen/)).toBeTruthy();
    expect(screen.queryByText(/registered with this server/)).toBeNull();
  });

  it("marks an app's write permission inactive while the workspace does not allow AI changes", async () => {
    const grant = {
      id: "g1",
      clientId: "c1",
      clientName: "Claude",
      scopes: ["read", "simulate", "write"],
      createdAt: "2026-11-01T00:00:00.000Z",
      lastUsedAt: null,
      refreshExpiresAt: "2027-11-01T00:00:00.000Z",
    };
    const settings = (mcpWrites: boolean) => () =>
      json({ id: "acc_1", name: "Home", mcpWrites, role: "owner" });
    stubFetch(CLOUD_SIGNED_IN, {
      ...noHousehold,
      "GET /api/v1/me/oauth-grants": () => json({ items: [grant] }),
      "GET /api/v1/oauth/clients": () => json({ items: [] }),
      "GET /api/v1/workspace/settings": settings(false),
    });
    const view = await open("/settings/apps");
    expect(await screen.findByText("write · inactive")).toBeTruthy();
    view.unmount();
    cleanup();

    stubFetch(CLOUD_SIGNED_IN, {
      ...noHousehold,
      "GET /api/v1/me/oauth-grants": () => json({ items: [grant] }),
      "GET /api/v1/oauth/clients": () => json({ items: [] }),
      "GET /api/v1/workspace/settings": settings(true),
    });
    await open("/settings/apps");
    expect(await screen.findByText("Claude")).toBeTruthy();
    await waitFor(() => expect(screen.getByText("write")).toBeTruthy());
    expect(screen.queryByText("write · inactive")).toBeNull();
  });

  it("self-host keeps the server-wide registry wording", async () => {
    stubFetch(SELFHOST_STATUS, {
      ...noHousehold,
      "GET /api/v1/me/oauth-grants": () => json({ items: [] }),
      "GET /api/v1/oauth/clients": () => json({ items: [] }),
    });
    await open("/settings/apps");
    expect(await screen.findByText("Registered apps (everyone)")).toBeTruthy();
  });
});

describe("dashboard greeting (item I)", () => {
  it("chooses the account name when there is an account, else the household's person", () => {
    expect(greetingName("Ada Tester", "Alex Sample")).toBe("Ada Tester");
    expect(greetingName("  ", "Alex Sample")).toBe("there");
    expect(greetingName(undefined, "Sam")).toBe("Sam");
    expect(greetingName(undefined, undefined)).toBe("there");
  });
});

describe("signed in, nothing to show: never called offline (item C leftovers)", () => {
  it("an empty workspace is not offline: no offline badge, and settings say why they stay local", async () => {
    stubFetch(CLOUD_SIGNED_IN, noHousehold);
    await open("/settings/profile");
    await screen.findByRole("heading", { name: "Settings" });
    await waitFor(() =>
      expect(screen.getByText(/Nothing is set up yet, so settings are kept/)).toBeTruthy(),
    );
    expect(document.body.textContent).not.toMatch(/offline/i);
  });

  it("no workspace at all (403): says nothing is saved, not that the server is offline", async () => {
    stubFetch(
      { ...CLOUD_SIGNED_IN, workspace: null, workspaces: [] },
      {
        "GET /api/v1/households": () => apiError(403, "FORBIDDEN", "not a member of a workspace"),
      },
    );
    await open("/settings/profile");
    await screen.findByRole("heading", { name: "Settings" });
    await waitFor(() => expect(screen.getByText("Sample data · not saved")).toBeTruthy());
    expect(screen.getByText(/You are not in a workspace, so settings are kept/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/offline/i);
  });
});

describe("focus after a dialog closes (item 15)", () => {
  /** A form dialog that hands over to a second dialog as it closes, like "New key" and its reveal. */
  function Chain() {
    const [form, setForm] = useState(false);
    const [reveal, setReveal] = useState(false);
    return (
      <>
        <button type="button" onClick={() => setForm(true)}>
          New key
        </button>
        <Dialog open={form} onOpenChange={setForm}>
          <DialogContent title="New API key">
            <button
              type="button"
              onClick={() => {
                setForm(false);
                setReveal(true);
              }}
            >
              Create key
            </button>
          </DialogContent>
        </Dialog>
        <Dialog open={reveal} onOpenChange={setReveal}>
          <DialogContent title="Key created">
            <button type="button" onClick={() => setReveal(false)}>
              Done
            </button>
          </DialogContent>
        </Dialog>
      </>
    );
  }

  /** The control that opened the dialog is replaced while it is open, like "Turn on" becoming "Turn off". */
  function Replaced() {
    const [on, setOn] = useState(false);
    const [open, setOpen] = useState(false);
    return (
      <section>
        <h2>Two-step sign-in</h2>
        <div>
          {on ? (
            <p>
              <button type="button">Turn off</button>
            </p>
          ) : (
            <button type="button" onClick={() => setOpen(true)}>
              Turn on
            </button>
          )}
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent title="Turn on two-step sign-in">
            <button type="button" onClick={() => setOn(true)}>
              Confirm
            </button>
            <button type="button" onClick={() => setOpen(false)}>
              Finish
            </button>
          </DialogContent>
        </Dialog>
      </section>
    );
  }

  const settle = () => act(() => new Promise((r) => setTimeout(r, 20)));

  it("a dialog opened by another dialog returns focus to the first dialog's opener", async () => {
    render(<Chain />);
    const opener = screen.getByRole("button", { name: "New key" });
    opener.focus();
    fireEvent.click(opener);
    fireEvent.click(await screen.findByRole("button", { name: "Create key" }));
    await settle();
    fireEvent.click(await screen.findByRole("button", { name: "Done" }));
    await settle();
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it("a replaced opener hands focus to what took its place", async () => {
    render(<Replaced />);
    const opener = screen.getByRole("button", { name: "Turn on" });
    opener.focus();
    fireEvent.click(opener);
    fireEvent.click(await screen.findByRole("button", { name: "Confirm" }));
    fireEvent.click(screen.getByRole("button", { name: "Finish" }));
    await settle();
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Turn off" })),
    );
  });
});
