/**
 * The public demo at `/demo`: the real planner on the bundled SYNTHETIC sample household, with no
 * account and no server.
 *
 * Demo mode is decided once, from the URL the page was loaded at (`/demo` or `/demo/...`), and holds for
 * the life of the page. The router then runs the whole app under the `/demo` base path, the workspace is
 * the sample (plus this browser's edits to it), and every engine run happens in this browser's workers.
 *
 * Isolation: a demo page never talks to the server about data. `installDemoNetworkGuard` wraps `fetch`
 * and `XMLHttpRequest` so a same-origin request is refused unless it is a static build asset or the
 * analytics relay. A signed-in visitor's session cookie therefore never reaches the API from a demo page,
 * so no workspace data can load into it, even through code that forgot to check for the demo.
 *
 * Part of the app shell: no runtime import of @glideworth/core, Zod or the API client.
 */

export const DEMO_BASE = "/demo";
/** The hosted sign-up page (outside the demo's base path, so links to it are plain `<a href>`). */
export const SIGNUP_PATH = "/signup";

/** Every key the demo writes to local storage starts with this, so "Reset demo" can remove them all. */
const DEMO_PREFIX = "glideworth:demo:";
export const DEMO_KEYS = {
  /** The sample household with this browser's edits (the editor's local copy). */
  doc: `${DEMO_PREFIX}doc:v1`,
  /** Settings changed in the demo (currency display, planning defaults). */
  settings: `${DEMO_PREFIX}settings:v1`,
  /** Session storage: `demo_started` was already sent from this tab. */
  started: `${DEMO_PREFIX}started`,
} as const;

/**
 * Local storage for the app's persisted stores (preferences, UI, charts). A demo page reads and writes
 * the same names under the demo prefix, so state this browser saved for a real workspace (an import
 * checklist naming people and plans, the last import report) never shows in the demo, the demo never
 * overwrites it, and "Reset demo" clears it. Keys are mapped on every call, not when a store is created.
 */
export const demoAwareStorage = {
  getItem: (name: string): string | null => {
    try {
      return localStorage.getItem(isDemo() ? `${DEMO_PREFIX}${name}` : name);
    } catch {
      return null;
    }
  },
  setItem: (name: string, value: string): void => {
    try {
      localStorage.setItem(isDemo() ? `${DEMO_PREFIX}${name}` : name, value);
    } catch {
      /* blocked or full: the store keeps working in memory */
    }
  },
  removeItem: (name: string): void => {
    try {
      localStorage.removeItem(isDemo() ? `${DEMO_PREFIX}${name}` : name);
    } catch {
      /* blocked */
    }
  },
};

/** `/demo`, `/demo/` and `/demo/<anything>`; not `/demonstration`. */
export function isDemoPath(pathname: string): boolean {
  return pathname === DEMO_BASE || pathname.startsWith(`${DEMO_BASE}/`);
}

let active = typeof window !== "undefined" && isDemoPath(window.location.pathname);

/** True when this page was loaded as the public demo. */
export function isDemo(): boolean {
  return active;
}

/** Tests only: switch demo mode without reloading the page. */
export function setDemoModeForTests(on: boolean): void {
  active = on;
}

/**
 * Same-origin paths a demo page may request: hashed build assets and the PostHog relay. Everything else on
 * this origin (the API, MCP, OAuth, the auth routes, `/health`, `/docs`) is the server's and is refused.
 * Other origins are left to the Content-Security-Policy (`connect-src 'self'` in production).
 */
const DEMO_ALLOWED = /^\/(assets|relay)(\/|$)/;

export function allowedInDemo(url: string | URL, origin = window.location.origin): boolean {
  let u: URL;
  try {
    u = new URL(String(url), origin);
  } catch {
    return false;
  }
  if (u.origin !== origin) return true;
  return DEMO_ALLOWED.test(u.pathname);
}

/** What a refused request rejects with: it looks like a network failure, so callers degrade as offline. */
export class DemoNetworkBlocked extends TypeError {
  constructor(url: string) {
    super(`The demo does not contact the server (${url}).`);
    this.name = "DemoNetworkBlocked";
  }
}

const urlOf = (input: RequestInfo | URL): string =>
  typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

/** `fetch` that refuses the server's paths (see `allowedInDemo`). */
export function demoFetch(inner: typeof fetch): typeof fetch {
  return (input, init) => {
    const url = urlOf(input);
    if (!allowedInDemo(url)) return Promise.reject(new DemoNetworkBlocked(url));
    return inner(input, init);
  };
}

let guarded = false;

/** Wrap the page's `fetch` and `XMLHttpRequest` (once). Called at start-up on a demo page. */
export function installDemoNetworkGuard(): void {
  if (guarded || typeof window === "undefined") return;
  guarded = true;
  window.fetch = demoFetch(window.fetch.bind(window));
  if (typeof XMLHttpRequest !== "undefined") {
    const open = XMLHttpRequest.prototype.open as (this: XMLHttpRequest, ...a: unknown[]) => void;
    XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, ...args: unknown[]) {
      const url = String(args[1]);
      if (!allowedInDemo(url)) throw new DemoNetworkBlocked(url);
      open.apply(this, args);
    } as typeof XMLHttpRequest.prototype.open;
  }
}

/** The demo session: nobody is signed in and there is no sign-in screen. */
export const DEMO_SESSION = { kind: "disabled" } as const;

function storages(): Storage[] {
  const out: Storage[] = [];
  try {
    out.push(localStorage);
  } catch {
    /* blocked */
  }
  try {
    out.push(sessionStorage);
  } catch {
    /* blocked */
  }
  return out;
}

/** True when this browser holds edits made in the demo. */
export function hasDemoEdits(): boolean {
  try {
    return localStorage.getItem(DEMO_KEYS.doc) !== null;
  } catch {
    return false;
  }
}

/** Forget everything the demo stored in this browser (only the demo's own keys). */
export function clearDemoStorage(): void {
  for (const s of storages()) {
    const keys: string[] = [];
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i);
      if (k?.startsWith(DEMO_PREFIX) && k !== DEMO_KEYS.started) keys.push(k);
    }
    for (const k of keys) s.removeItem(k);
  }
}

/** "Reset demo": drop this browser's demo edits and start again from the sample household. */
export function resetDemo(): void {
  clearDemoStorage();
  window.location.assign(DEMO_BASE);
}

/** Sends `demo_started` once per tab: true the first time it is asked on this tab. */
export function claimDemoStart(): boolean {
  try {
    if (sessionStorage.getItem(DEMO_KEYS.started)) return false;
    sessionStorage.setItem(DEMO_KEYS.started, "1");
    return true;
  } catch {
    return true;
  }
}

if (active) installDemoNetworkGuard();
