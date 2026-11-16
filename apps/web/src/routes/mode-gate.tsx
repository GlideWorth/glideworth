/**
 * Mode gating for routes. The server says which mode it runs in (`mode` on the auth status answer, see
 * lib/auth.ts); until it says `cloud` the app is self-host. A cloud-only page renders "not found" on a
 * self-host server (and its code is never fetched, because it is only rendered after the check), and
 * the self-host passphrase pages render "not found" on a cloud server.
 */
import type { RouteComponent } from "@tanstack/react-router";
import type { ReactElement } from "react";
import { NotFound } from "../components/layout/route-states";
import { useMode, useSession } from "../lib/auth";

function gate(Page: RouteComponent, want: "cloud" | "selfhost"): () => ReactElement | null {
  return function ModeGate() {
    const loading = useSession().isLoading;
    const mode = useMode();
    if (loading) return null;
    return mode === want ? <Page /> : <NotFound />;
  };
}

export const cloudOnly = (Page: RouteComponent) => gate(Page, "cloud");
export const selfHostOnly = (Page: RouteComponent) => gate(Page, "selfhost");
