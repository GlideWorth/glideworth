/**
 * Production QA (2026-11-17) follow-ups in the web app: keyboard focus after dialogs close (item 3), the
 * welcome tour stepping aside for dialogs (item 4), hosted wording (item 6), the report's method label
 * (item 7) and the link in the "export is ready" email (item 11). Each test drives the real component.
 */
import { createSampleDocument } from "@glideworth/core/samples";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Tour } from "../src/components/layout/tour";
import { ConfirmHost } from "../src/components/ui/confirm-dialog";
import { Dialog, DialogContent } from "../src/components/ui/dialog";
import { nav } from "../src/features/cloud/next";
import { ReauthHost } from "../src/features/cloud/reauth-dialog";
import { AccountSection } from "../src/features/cloud/settings/account-section";
import { MembersSection } from "../src/features/cloud/settings/members-section";
import { SecuritySection } from "../src/features/cloud/settings/security-section";
import { WorkspaceSection } from "../src/features/cloud/settings/workspace-section";
import { assumptionsRows } from "../src/features/reports/report-view";
import { DataSection } from "../src/features/settings/data-section";
import { KeysSection } from "../src/features/settings/keys-section";
import { usePrefs } from "../src/stores/prefs";
import { apiError, mockFetch, renderWithClient, signedIn, withCsrfCookie } from "./cloud-helpers";

vi.mock("@tanstack/react-router", async (importOriginal) =>
  (await import("./cloud-helpers")).routerMock(importOriginal as never),
);

beforeEach(() => {
  withCsrfCookie("csrf-tok");
  vi.spyOn(nav, "go").mockImplementation(() => undefined);
  Element.prototype.scrollIntoView ??= vi.fn();
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.releasePointerCapture ??= () => undefined;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const settle = () => act(() => new Promise((r) => setTimeout(r, 30)));
const active = () => document.activeElement;

const profile = (over: object = {}) => ({
  id: "u1",
  email: "ada@example.com",
  name: "Ada",
  twoFactorEnabled: false,
  signinAlerts: true,
  checkinEmails: true,
  ...over,
});

describe("focus returns to the page when a dialog closes (QA item 3)", () => {
  it("change email: Cancel, Escape and Close after sending all go back to Change email", async () => {
    mockFetch({
      "GET /api/v1/account/profile": profile(),
      "POST /api/v1/account/email": { status: "check-email" },
    });
    renderWithClient(<AccountSection />, signedIn("owner"));
    const opener = await screen.findByRole("button", { name: "Change email" });

    for (const exit of ["cancel", "escape", "send"] as const) {
      opener.focus();
      fireEvent.click(opener);
      const dlg = await screen.findByRole("dialog", { name: "Change your email address" });
      // The field takes focus as the dialog opens.
      await waitFor(() => expect(active()).toBe(within(dlg).getByLabelText("New email address")));
      if (exit === "cancel") fireEvent.click(within(dlg).getByRole("button", { name: "Cancel" }));
      else if (exit === "escape") fireEvent.keyDown(active() as Element, { key: "Escape" });
      else {
        fireEvent.change(within(dlg).getByLabelText("New email address"), {
          target: { value: "ada@new.example" },
        });
        fireEvent.click(within(dlg).getByRole("button", { name: "Send confirmation link" }));
        await within(dlg).findByText(/we have sent a confirmation link/);
        // The text button, not the dialog's X (also named Close).
        const close = within(dlg)
          .getAllByRole("button", { name: "Close" })
          .find((b) => b.textContent === "Close");
        fireEvent.click(close as HTMLElement);
      }
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      await settle();
      expect(active(), exit).toBe(opener);
    }
  });

  it("recovery codes Done: focus goes to the two-step section that replaced Turn on", async () => {
    let on = false;
    mockFetch({
      "GET /api/v1/account/profile": () => profile({ twoFactorEnabled: on }),
      "GET /api/v1/account/sessions": { items: [] },
      "POST /api/v1/account/totp/begin": {
        secret: "JBSWY3DPEHPK3PXP",
        otpauthUri: "otpauth://totp/Glideworth:ada?secret=JBSWY3DPEHPK3PXP&issuer=Glideworth",
      },
      "POST /api/v1/account/totp/confirm": () => {
        on = true;
        return { recoveryCodes: ["aaaa-bbbb", "cccc-dddd"] };
      },
    });
    renderWithClient(
      <>
        <SecuritySection />
        <ReauthHost />
      </>,
      signedIn("owner"),
    );
    const turnOn = await screen.findByRole("button", { name: "Turn on" });
    turnOn.focus();
    fireEvent.click(turnOn);
    const enrol = await screen.findByRole("dialog", { name: "Turn on two-step sign-in" });
    fireEvent.change(within(enrol).getByLabelText("6-digit code"), {
      target: { value: "123456" },
    });
    fireEvent.click(within(enrol).getByRole("button", { name: "Turn on" }));
    const codes = await screen.findByRole("dialog", { name: "Save your recovery codes" });
    fireEvent.click(within(codes).getByRole("checkbox"));
    fireEvent.click(within(codes).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await screen.findByRole("button", { name: /Turn off/ });
    await settle();
    await waitFor(() => {
      expect(active()).not.toBe(document.body);
      expect(active()?.closest("section, [data-settings-group], div")).toBeTruthy();
    });
    // Focus is in the two-step group: the first control of the group that is still there.
    expect(
      ["New recovery codes", "Turn off…"].some((n) => (active()?.textContent ?? "").includes(n)),
    ).toBe(true);
  });

  it("revoke key: focus moves on to what is left when the revoked key's row goes", async () => {
    let revoked = false;
    const key = (id: string, name: string) => ({
      id,
      name,
      prefix: id,
      scopes: ["read"],
      createdAt: "2026-11-01T00:00:00Z",
      lastUsedAt: null,
      revokedAt: null,
    });
    mockFetch({
      "GET /api/v1/keys": () => ({
        items: revoked
          ? [{ ...key("k1", "Laptop"), revokedAt: "2026-11-17T00:00:00Z" }, key("k2", "Sheet")]
          : [key("k1", "Laptop"), key("k2", "Sheet")],
      }),
      "DELETE /api/v1/keys/k1": () => {
        revoked = true;
        return { ...key("k1", "Laptop"), revokedAt: "2026-11-17T00:00:00Z" };
      },
    });
    renderWithClient(
      <>
        <KeysSection />
        <ConfirmHost />
      </>,
      signedIn("owner"),
    );
    await screen.findByText("Laptop");
    const revoke = screen.getAllByRole("button", { name: "Revoke" })[0] as HTMLElement;
    revoke.focus();
    fireEvent.click(revoke);
    const confirm = await screen.findByRole("alertdialog");
    fireEvent.click(within(confirm).getByRole("button", { name: "Revoke key" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Revoke" })).toHaveLength(1));
    await settle();
    await waitFor(() => expect(active()).not.toBe(document.body));
    expect(active()).toBe(screen.getByRole("button", { name: "Revoke" }));
  });

  it("remove member: focus stays in the member list after the row goes", async () => {
    let removed = false;
    const members = [
      { userId: "u1", role: "owner", name: "Ada", email: "ada@example.com" },
      { userId: "u2", role: "editor", name: "Grace", email: "grace@example.com" },
      { userId: "u3", role: "viewer", name: "Alan", email: "alan@example.com" },
    ];
    mockFetch({
      "GET /api/v1/workspace/settings": {
        id: "acc_1",
        name: "Home",
        mcpWrites: false,
        role: "owner",
        limits: { editors: 5, viewers: 5 },
      },
      "GET /api/v1/workspace/members": () => ({
        items: removed ? members.filter((m) => m.userId !== "u2") : members,
      }),
      "GET /api/v1/workspace/invitations": { items: [] },
      "DELETE /api/v1/workspace/members/u2": () => {
        removed = true;
        return null;
      },
    });
    renderWithClient(
      <>
        <MembersSection />
        <ConfirmHost />
      </>,
      signedIn("owner"),
    );
    const remove = await screen.findByRole("button", { name: "Remove Grace" });
    remove.focus();
    fireEvent.click(remove);
    const confirm = await screen.findByRole("alertdialog");
    fireEvent.click(within(confirm).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(screen.queryByText("Grace")).toBeNull());
    await settle();
    await waitFor(() => expect(active()).not.toBe(document.body));
    expect(active()?.closest("ul")).toBe(
      screen.getByRole("button", { name: "Remove Alan" }).closest("ul"),
    );
  });

  it("send invitation: focus goes back to the email field for the next one", async () => {
    mockFetch({
      "GET /api/v1/workspace/settings": {
        id: "acc_1",
        name: "Home",
        mcpWrites: false,
        role: "owner",
        limits: { editors: 5, viewers: 5 },
      },
      "GET /api/v1/workspace/members": {
        items: [{ userId: "u1", role: "owner", name: "Ada", email: "ada@example.com" }],
      },
      "GET /api/v1/workspace/invitations": { items: [] },
      "POST /api/v1/workspace/invitations": { id: "inv2" },
    });
    renderWithClient(<MembersSection />, signedIn("owner"));
    const field = await screen.findByLabelText("Email address");
    fireEvent.change(field, { target: { value: "new@example.com" } });
    const send = screen.getByRole("button", { name: /Send invitation/ });
    send.focus();
    fireEvent.click(send);
    await screen.findByText("Invitation sent to new@example.com.");
    await waitFor(() => expect(active()).toBe(screen.getByLabelText("Email address")));
  });
});

describe("the welcome tour steps aside for dialogs (QA item 4)", () => {
  function WithDialog() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          Delete workspace…
        </button>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent title="Delete this workspace?">
            <button type="button" onClick={() => setOpen(false)}>
              Keep it
            </button>
          </DialogContent>
        </Dialog>
        <Tour />
      </>
    );
  }

  beforeEach(() => usePrefs.setState({ tour: "welcome" }));
  afterEach(() => usePrefs.setState({ tour: null }));

  it("hides while a dialog is open, ignores its Escape, and comes back where it was", async () => {
    render(<WithDialog />);
    expect(screen.getByText(/Tour · 1 of/)).toBeTruthy();
    const opener = screen.getByRole("button", { name: "Delete workspace…" });
    opener.focus();
    fireEvent.click(opener);
    await screen.findByRole("dialog", { name: "Delete this workspace?" });
    await waitFor(() => expect(screen.queryByText(/Tour · 1 of/)).toBeNull());
    fireEvent.keyDown(active() as Element, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /Delete/ })).toBeNull());
    // The dialog's Escape closed the dialog only; the tour resumes at the same stop.
    expect(usePrefs.getState().tour).toBe("welcome");
    expect(await screen.findByText(/Tour · 1 of/)).toBeTruthy();
    await settle();
    expect(active()).toBe(opener);
  });
});

describe("hosted wording (QA item 6)", () => {
  it("the Data page says where the data is kept, for hosted and self-hosted", async () => {
    mockFetch({});
    const hosted = renderWithClient(<DataSection />, signedIn("owner"));
    expect(screen.getByText(/Your data is kept in this Glideworth Cloud workspace/)).toBeTruthy();
    expect(screen.queryByText(/your own Glideworth server/)).toBeNull();
    hosted.unmount();
    renderWithClient(<DataSection />, {
      kind: "authenticated",
      via: "session",
      user: { id: "owner", name: "Owner", role: "owner" },
    } as never);
    expect(screen.getByText(/Your data lives on your own Glideworth server/)).toBeTruthy();
  });
});

describe("report (QA item 7)", () => {
  it("names the chance-of-success method, not its internal id", () => {
    const plan = createSampleDocument().plans[0]!;
    const rows = assumptionsRows(
      { ...plan, monteCarlo: { ...plan.monteCarlo, method: "historical-random-restart" } },
      (v) => `${v}`,
    );
    const method = rows.find(([label]) => label === "Chance-of-success method")?.[1];
    expect(method).toBe(`Historical, random start years, ${plan.monteCarlo.trials} trials`);
  });
});

describe("the link in the export email (QA item 11)", () => {
  const workspace = {
    id: "acc_1",
    name: "Home",
    mcpWrites: false,
    role: "owner",
    limits: { editors: 3, viewers: 2 },
  };
  const open = (status: object | Response) => {
    window.history.replaceState(null, "", "/settings/workspace#export=exp_abc");
    const api = mockFetch({
      "GET /api/v1/workspace/settings": workspace,
      "GET /api/v1/workspace/support-grants": { items: [] },
      "GET /api/v1/workspace/exports/exp_abc/status": status,
    });
    renderWithClient(<WorkspaceSection />, signedIn("owner"));
    return api;
  };

  it("says when the export was already downloaded, and how to get another", async () => {
    const api = open({ status: "downloaded", expiresAt: "2026-11-18T06:00:00Z" });
    expect(
      await screen.findByText(/The export from your email has already been downloaded/),
    ).toBeTruthy();
    expect(screen.getByText(/To get a new copy, choose Prepare export/)).toBeTruthy();
    // Asking never uses the download up.
    expect(api.calls.some((c) => c.path === "/api/v1/workspace/exports/exp_abc")).toBe(false);
    expect(window.location.hash).toBe("");
  });

  it("says when it has expired, also once its record is gone (404)", async () => {
    open({ status: "expired", expiresAt: null });
    expect(await screen.findByText(/The export from your email has expired/)).toBeTruthy();
    cleanup();
    open(apiError(404, "NOT_FOUND", "no such export"));
    expect(await screen.findByText(/The export from your email has expired/)).toBeTruthy();
  });

  it("offers the download while it is still there", async () => {
    open({ status: "ready", expiresAt: new Date(Date.now() + 3600_000).toISOString() });
    const link = await screen.findByRole("link", { name: /Download/ });
    expect(link.getAttribute("href")).toBe("/api/v1/workspace/exports/exp_abc");
  });
});
