/**
 * Browser session auth for production deployments (cookie session set by the API). In dev the Vite
 * proxy injects an API key, the session routes may not exist, and the app simply carries on:
 * a missing route means "sessions are not in use here".
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";

export const AUTH_PATHS = {
  session: "/api/v1/auth/status",
  setup: "/api/v1/auth/setup",
  login: "/api/v1/auth/login",
  logout: "/api/v1/auth/logout",
  logoutAll: "/api/v1/auth/logout-all",
  accept: "/api/v1/auth/accept",
  changePassphrase: "/api/v1/auth/change-passphrase",
} as const;

export interface SessionUser {
  id: string;
  name: string;
  role: "owner" | "editor" | "viewer";
}

/** Minimum passphrase length enforced by the server (apps/api services/auth.ts). */
export const MIN_PASSPHRASE = 12;
/**
 * The CSRF cookie: the cloud name first (`__Host-gw_csrf`, packages/cloud http/common.ts), then the
 * self-host name and its name before the rename (a session signed in before the upgrade).
 */
const CSRF_COOKIES = ["__Host-gw_csrf", "glideworth_csrf", "cairn_csrf"];

/** The session's CSRF token (cookie written by the server, readable by the app). */
export function csrfToken(): string | undefined {
  if (typeof document === "undefined") return undefined;
  for (const name of CSRF_COOKIES) {
    const m = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
    if (m) return decodeURIComponent(m[1]!);
  }
  return undefined;
}

/** Header to send on writes when signed in with a browser session (no-op otherwise). */
export function csrfHeaders(method: string): Record<string, string> {
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return {};
  const t = csrfToken();
  return t ? { "x-csrf-token": t } : {};
}

/**
 * How the server runs. `cloud` is announced by `mode: "cloud"` on `GET /api/v1/auth/status`; anything else
 * (including no field at all, the self-host server today) is `selfhost`.
 */
export type AppMode = "selfhost" | "cloud";

interface CloudAccess {
  level: "full" | "read_only" | "suspended";
  /** trial, active, past_due_grace, comped, trial_expired, past_due, unpaid, canceled, paused, ... */
  reason: string;
  changesAt: string | null;
}
interface CloudWorkspaceSummary {
  id: string;
  name: string;
  role: "owner" | "editor" | "viewer";
  access: CloudAccess | null;
}
interface CloudWorkspace extends CloudWorkspaceSummary {
  trialEndsAt: string | null;
}
/** What the cloud status response says about the signed-in person (see features/cloud). */
export interface CloudSession {
  /**
   * `password`: the account has a password (false: created with Google and none set yet).
   * `google`: a Google account is linked.
   */
  user: {
    id: string;
    email: string;
    name: string;
    totp: boolean;
    password: boolean;
    google: boolean;
  };
  /** "Sign in with Google" is configured on this server. */
  googleSignIn: boolean;
  workspace: CloudWorkspace | null;
  workspaces: CloudWorkspaceSummary[];
}

export type SessionState =
  /** No session routes (dev proxy, bearer-key deployments): no sign-in screen. */
  | { kind: "disabled" }
  | {
      kind: "authenticated";
      via?: "session" | "key";
      expiresAt?: string;
      user?: SessionUser;
      multiUser?: boolean;
      /** Cloud mode only. */
      cloud?: CloudSession;
    }
  /** Cloud mode, no session: the cloud sign-in and sign-up screens apply. */
  | {
      kind: "cloud-signed-out";
      captchaSiteKey?: string;
      termsVersion?: string;
      /** "Sign in with Google" is configured: show the button. */
      googleSignIn?: boolean;
    }
  /** A passphrase exists; the browser has no valid session. `multiUser`: ask for a sign-in name. */
  | { kind: "login"; multiUser?: boolean }
  /** First run of a production install: no passphrase has been set yet. */
  | { kind: "setup" }
  | { kind: "unreachable"; message: string };

const bool = (o: Record<string, unknown>, ...keys: string[]): boolean | undefined => {
  for (const k of keys) if (typeof o[k] === "boolean") return o[k] as boolean;
  return undefined;
};

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const obj = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
const ROLES = ["owner", "editor", "viewer"] as const;
const roleOf = (v: unknown) => ROLES.find((r) => r === v);

function parseAccess(v: unknown): CloudAccess | null {
  const a = obj(v);
  if (!a || (a.level !== "full" && a.level !== "read_only" && a.level !== "suspended")) return null;
  return { level: a.level, reason: str(a.reason) ?? "", changesAt: str(a.changesAt) ?? null };
}
function parseWorkspace(v: unknown): CloudWorkspaceSummary | null {
  const w = obj(v);
  const role = roleOf(w?.role);
  if (!w || typeof w.id !== "string" || !role) return null;
  return { id: w.id, name: str(w.name) ?? "", role, access: parseAccess(w.access) };
}

/** The cloud status body (`mode: "cloud"`): signed out, or the person with their workspaces. */
function interpretCloud(status: number, o: Record<string, unknown>): SessionState {
  const user = obj(o.user);
  if (status >= 200 && status < 300 && o.authenticated === true && user && str(user.id)) {
    const ws = parseWorkspace(o.workspace);
    const list = Array.isArray(o.workspaces)
      ? o.workspaces.map(parseWorkspace).filter((w): w is CloudWorkspaceSummary => !!w)
      : [];
    const role = ws?.role ?? roleOf(user.role) ?? "viewer";
    const name = str(user.name) ?? str(user.email) ?? "";
    return {
      kind: "authenticated",
      via: "session",
      ...(str(o.expiresAt) ? { expiresAt: str(o.expiresAt)! } : {}),
      user: { id: str(user.id)!, name, role },
      cloud: {
        user: {
          id: str(user.id)!,
          email: str(user.email) ?? "",
          name,
          totp: user.totp === true,
          // Older servers do not send it: every account had a password then.
          password: user.password !== false,
          google: user.google === true,
        },
        googleSignIn: o.googleSignIn === true,
        workspace: ws ? { ...ws, trialEndsAt: str(obj(o.workspace)?.trialEndsAt) ?? null } : null,
        workspaces: list,
      },
    };
  }
  if ((status >= 200 && status < 300) || status === 401 || status === 403) {
    const site = str(obj(o.captcha)?.siteKey);
    const terms = str(obj(o.terms)?.version) ?? str(o.termsVersion);
    return {
      kind: "cloud-signed-out",
      ...(site ? { captchaSiteKey: site } : {}),
      ...(terms ? { termsVersion: terms } : {}),
      ...(o.googleSignIn === true ? { googleSignIn: true } : {}),
    };
  }
  return { kind: "unreachable", message: `session check failed (HTTP ${status})` };
}

/** Interpret a session-check response body (tolerant of field naming). */
export function interpretSession(status: number, body: unknown): SessionState {
  if (status === 404 || status === 405 || status === 501) return { kind: "disabled" };
  const o = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  if (o.mode === "cloud") return interpretCloud(status, o);
  const inner = (o.session && typeof o.session === "object" ? o.session : o) as Record<
    string,
    unknown
  >;
  const needsSetup =
    bool(inner, "setupRequired", "needsSetup", "firstRun") ??
    (bool(inner, "configured", "passphraseSet", "hasPassphrase", "setup") === false
      ? true
      : undefined);
  const authed = bool(inner, "authenticated", "loggedIn", "valid", "active");
  // Signed in (session, or an API key injected by the dev proxy) wins over first-run setup.
  if (status >= 200 && status < 300 && authed !== false && !(needsSetup && authed === undefined)) {
    if (bool(inner, "enabled", "authEnabled", "required") === false) return { kind: "disabled" };
    const exp = inner.expiresAt;
    const via = inner.via === "session" || inner.via === "key" ? inner.via : undefined;
    const user = parseUser(inner.user);
    const multi = bool(inner, "multiUser");
    return {
      kind: "authenticated",
      ...(via ? { via } : {}),
      ...(typeof exp === "string" ? { expiresAt: exp } : {}),
      ...(user ? { user } : {}),
      ...(multi !== undefined ? { multiUser: multi } : {}),
    };
  }
  if (needsSetup) return { kind: "setup" };
  if (status === 401 || status === 403 || authed === false)
    return { kind: "login", ...(bool(inner, "multiUser") ? { multiUser: true } : {}) };
  return { kind: "unreachable", message: `session check failed (HTTP ${status})` };
}

function parseUser(u: unknown): SessionUser | undefined {
  if (!u || typeof u !== "object") return undefined;
  const o = u as Record<string, unknown>;
  const role =
    o.role === "owner" || o.role === "editor" || o.role === "viewer" ? o.role : undefined;
  if (typeof o.id !== "string" || !role) return undefined;
  return { id: o.id, name: typeof o.name === "string" ? o.name : o.id, role };
}

/**
 * The session state to show after an API call answered 401 (signed out elsewhere, expired). The hosted
 * service has its own sign-in screens: sending a hosted user to the self-hosted passphrase screen leaves
 * them with a form that cannot sign them in.
 */
export function sessionAfterUnauthorized(current: SessionState): SessionState {
  if (current.kind === "cloud-signed-out") return current;
  if (current.kind === "authenticated" && current.cloud) return { kind: "cloud-signed-out" };
  return { kind: "login" };
}

export async function checkSession(f: typeof fetch = fetch): Promise<SessionState> {
  try {
    const res = await f(AUTH_PATHS.session, {
      credentials: "same-origin",
      headers: { accept: "application/json" },
    });
    const body = await res.json().catch(() => null);
    return interpretSession(res.status, body);
  } catch (e) {
    return { kind: "unreachable", message: e instanceof Error ? e.message : String(e) };
  }
}

export class AuthError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

async function post(path: string, body?: unknown): Promise<void> {
  const res = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      ...csrfHeaders("POST"),
    },
    body: JSON.stringify(body ?? {}),
  });
  if (res.ok) return;
  const json = (await res.json().catch(() => null)) as {
    error?: { message?: string; code?: string };
  } | null;
  const fallback =
    res.status === 401
      ? "That sign-in name and passphrase did not match."
      : res.status === 429
        ? "Too many attempts. Wait a minute and try again."
        : `Request failed (HTTP ${res.status}).`;
  // A wrong passphrase gets our own sentence; the server's terse code-like message ("wrong
  // passphrase") is for API clients.
  const message =
    res.status === 401 && path === AUTH_PATHS.login
      ? fallback
      : res.status === 400 && json?.error?.code === "INVALID_TOKEN"
        ? "This link has expired or was already used. Ask the owner for a new one."
        : (json?.error?.message ?? fallback);
  throw new AuthError(message, res.status, json?.error?.code);
}

/** `user` is the sign-in name; omit it for the owner (and on single-user instances). */
export const signIn = (passphrase: string, user?: string) =>
  post(AUTH_PATHS.login, { passphrase, ...(user?.trim() ? { user: user.trim() } : {}) });
/** Accept an invite or a passphrase reset: choose a passphrase and be signed in. */
export const acceptInvite = (token: string, passphrase: string) =>
  post(AUTH_PATHS.accept, { token, passphrase });
export const signOutEverywhere = () => post(AUTH_PATHS.logoutAll);
export const setUpPassphrase = (passphrase: string, setupToken?: string) =>
  post(AUTH_PATHS.setup, { passphrase, ...(setupToken ? { setupToken } : {}) });
export const changePassphrase = (current: string, next: string) =>
  post(AUTH_PATHS.changePassphrase, { current, next });
export const signOut = () => post(AUTH_PATHS.logout);

export function useSession() {
  return useQuery({
    queryKey: ["session"],
    queryFn: () => checkSession(),
    staleTime: 5 * 60_000,
    retry: false,
  });
}

/** Hosted-mode pages for people who are not signed in (sign-up, sign-in, reset, invitations). */
export const CLOUD_PUBLIC_PATHS = [
  "/signup",
  "/check-email",
  "/verify-email",
  "/signin",
  "/signin/2fa",
  "/signin/google-exists",
  "/signup/google",
  "/forgot-password",
  "/reset-password",
  "/invite",
  "/confirm-email",
];

/** The mode the server announced (self-host until the status response says `cloud`). */
export function modeOf(state: SessionState | undefined): AppMode {
  return state?.kind === "cloud-signed-out" || (state?.kind === "authenticated" && state.cloud)
    ? "cloud"
    : "selfhost";
}

export function useMode(): AppMode {
  return modeOf(useSession().data);
}

/** The cloud person and workspace, or undefined (self-host, signed out, still loading). */
export function useCloudSession(): CloudSession | undefined {
  const s = useSession().data;
  return s?.kind === "authenticated" ? s.cloud : undefined;
}

export function useRefreshSession() {
  const qc = useQueryClient();
  return async () => {
    await qc.invalidateQueries({ queryKey: ["session"] });
    await qc.invalidateQueries({ queryKey: ["workspace"] });
  };
}

/** Rough passphrase strength for the setup screen: 0 (weak) .. 3 (strong). */
export function passphraseStrength(p: string): 0 | 1 | 2 | 3 {
  if (p.length < MIN_PASSPHRASE) return 0;
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(p)).length;
  const words = p.trim().split(/\s+/).length;
  if (p.length >= 20 || words >= 4) return 3;
  if (p.length >= 16 || classes >= 3) return 2;
  return 1;
}
