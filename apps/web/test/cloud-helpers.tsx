/** Shared test plumbing for the hosted-mode screens: a mocked fetch with a route table, a query client, a router stub. */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import { vi } from "vitest";
import type { SessionState } from "../src/lib/auth";

export type Handler = (req: {
  body: unknown;
  url: string;
  headers: Headers;
}) => Response | object | null;

export interface Call {
  method: string;
  path: string;
  body: unknown;
  headers: Headers;
}

export const json = (body: unknown, status = 200) =>
  new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
export const apiError = (status: number, code: string, message: string, details?: unknown) =>
  json({ error: { code, message, ...(details === undefined ? {} : { details }) } }, status);

/**
 * Replace `fetch` with a route table keyed "METHOD /path". A handler returns a Response, or a plain object
 * (sent as 200 JSON), or null (204). Unlisted routes fail the test loudly. `calls` records every request.
 */
export function mockFetch(routes: Record<string, Handler | Response | object | null>) {
  const calls: Call[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: url.pathname, body, headers });
    const key = `${method} ${url.pathname}`;
    if (!(key in routes)) throw new Error(`unexpected request: ${key}`);
    const r = routes[key];
    const out = typeof r === "function" ? r({ body, url: url.toString(), headers }) : r;
    if (out instanceof Response) return out;
    return out === null ? json(null, 204) : json(out);
  });
  vi.stubGlobal("fetch", fn);
  return {
    fn,
    calls,
    last: (key: string) => calls.findLast((c) => `${c.method} ${c.path}` === key),
  };
}

export function renderWithClient(ui: ReactElement, session?: SessionState) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  if (session) qc.setQueryData(["session"], session);
  return { qc, ...render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>) };
}

export const signedOut = (extra: object = {}): SessionState =>
  ({ kind: "cloud-signed-out", ...extra }) as SessionState;

export const signedIn = (
  role: "owner" | "editor" | "viewer" = "owner",
  access: { level: string; reason: string; changesAt?: string | null } = {
    level: "full",
    reason: "active",
  },
  extra: {
    trialEndsAt?: string | null;
    totp?: boolean;
    workspaces?: number;
    /** Sign-in methods ("Sign in with Google"): defaults to a password account, no Google. */
    password?: boolean;
    google?: boolean;
    googleSignIn?: boolean;
  } = {},
): SessionState =>
  ({
    kind: "authenticated",
    via: "session",
    user: { id: "u1", name: "Ada", role },
    cloud: {
      user: {
        id: "u1",
        email: "ada@example.com",
        name: "Ada",
        totp: extra.totp ?? false,
        password: extra.password ?? true,
        google: extra.google ?? false,
      },
      googleSignIn: extra.googleSignIn ?? false,
      workspace: {
        id: "acc_1",
        name: "Ada's workspace",
        role,
        access: { changesAt: null, ...access },
        trialEndsAt: extra.trialEndsAt ?? null,
      },
      workspaces: Array.from({ length: extra.workspaces ?? 1 }, (_, i) => ({
        id: `acc_${i + 1}`,
        name: i === 0 ? "Ada's workspace" : "Shared",
        role: i === 0 ? role : "editor",
        access: null,
      })),
    },
  }) as SessionState;

/** `vi.mock("@tanstack/react-router", ...)` factory: a spy for navigation and plain anchors for links. */
export const navigateSpy = vi.fn();
export async function routerMock(original: () => Promise<Record<string, unknown>>) {
  const mod = await original();
  const { createElement } = await import("react");
  return {
    ...mod,
    useNavigate: () => navigateSpy,
    Link: ({
      to,
      children,
      search: _s,
      params: _p,
      asChild: _a,
      ...rest
    }: Record<string, unknown>) =>
      createElement("a", { href: String(to), ...rest }, children as never),
  };
}

/** A fake readable CSRF cookie (the real one is `__Host-gw_csrf`, which jsdom will not store without HTTPS). */
export function withCsrfCookie(value = "csrf-tok") {
  return vi.spyOn(Document.prototype, "cookie", "get").mockReturnValue(`__Host-gw_csrf=${value}`);
}
