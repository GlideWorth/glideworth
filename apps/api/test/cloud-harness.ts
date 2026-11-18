/**
 * The real cloud app for tests: `start()` from `@glideworth/cloud/server` with `apps/api`'s `cloudHost`, real
 * control plane and tenant SQLite files in a temporary data directory, real HTTP on 127.0.0.1 (random ports),
 * and the packages' fakes for everything outside: `FakeStripeGateway`, the memory email transport, the memory
 * object store, a static CAPTCHA. Jobs run in-process with the fake engine (fast, deterministic).
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { FakeStripeGateway, loadPricingConfig, syncPricing } from "@glideworth/billing";
import { memoryObjectStore, staticCaptcha } from "@glideworth/cloud";
import { createLogger } from "@glideworth/cloud/log";
import { start } from "@glideworth/cloud/server";
import { memoryTransport } from "@glideworth/email";
import { createSampleDocument } from "@glideworth/core/samples";
import { createCloudHost } from "../src/cloud-host.js";
import { type CoreDeps, coreDeps } from "../src/deps.js";
import { inlineExecutor } from "../src/jobs/executor.js";
import { fakeSimulate } from "./helpers.js";
import { captureLine } from "./log-capture.js";

export const PUBLIC_URL = "https://app.glideworth.test";
export const CAPTCHA = "captcha-ok";
export const PRICING_FILE = resolve(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "packages",
  "billing",
  "pricing.example.json",
);
export const WEBHOOK_SECRET = "whsec_cloud_api_tests";

export function cloudEnv(dataDir: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    GLIDEWORTH_MODE: "cloud",
    GLIDEWORTH_PUBLIC_URL: PUBLIC_URL,
    GLIDEWORTH_SECRETS_KEY: "11".repeat(32),
    GLIDEWORTH_BACKUP_KEK: "22".repeat(32),
    GLIDEWORTH_DATA_DIR: dataDir,
    GLIDEWORTH_PRICING_FILE: PRICING_FILE,
    GLIDEWORTH_TRUST_PROXY: "true",
    GLIDEWORTH_STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
    GLIDEWORTH_MAX_JOBS: "2",
    ...extra,
  };
}

/** Generous limits so a test's own request volume never trips them (quota tests pass their own). */
export const TEST_LIMITS = {
  editors: 3,
  apiRequestsPerMinute: 100_000,
  apiRequestsPerDay: 1_000_000,
  concurrentJobs: 2,
  queuedJobs: 50,
  jobsPerDay: 10_000,
};

export interface BootOptions {
  env?: Record<string, string>;
  /** Plan limits written into the pricing file (merged over `TEST_LIMITS` and the example's). */
  limits?: Record<string, number>;
  deps?: Partial<CoreDeps>;
  /** Captures every log line (T-LOG). */
  logSink?: (line: string) => void;
  fetch?: typeof fetch;
  /** "Sign in with Google": the HTTP client the OpenID client uses (an in-process fake; never Google). */
  oidcFetch?: typeof fetch;
  /** Server error reports: the HTTP client the PostHog reporter uses (only with GLIDEWORTH_POSTHOG_* set). */
  errorReportFetch?: typeof fetch;
}

export async function bootCloud(o: BootOptions = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "gw-cloud-api-"));
  const pricing = JSON.parse(readFileSync(PRICING_FILE, "utf8")) as {
    products: Array<{ limits: Record<string, number> }>;
  };
  for (const p of pricing.products) p.limits = { ...p.limits, ...TEST_LIMITS, ...o.limits };
  const pricingFile = join(dataDir, "pricing.json");
  writeFileSync(pricingFile, JSON.stringify(pricing));
  const env = cloudEnv(dataDir, { GLIDEWORTH_PRICING_FILE: pricingFile, ...o.env });
  const gateway = new FakeStripeGateway();
  await syncPricing(gateway, loadPricingConfig(pricingFile), {
    apply: true,
    archiveRemoved: false,
    returnUrl: `${PUBLIC_URL}/settings/billing`,
  });
  const transport = memoryTransport();
  const deps = { ...coreDeps, simulate: fakeSimulate, ...o.deps } as CoreDeps;
  const host = createCloudHost({
    executor: inlineExecutor(deps),
    deps,
    webDist: null,
    webhookRetryDelaysMs: [0, 0],
    ...(o.fetch ? { fetch: o.fetch } : {}),
  });
  // Capture the public app the host builds (route enumeration in T-ISO).
  let app: { routes?: Array<{ method: string; path: string }> } | null = null;
  const createApp = host.createApp.bind(host);
  host.createApp = (cloud) => {
    const built = createApp(cloud);
    app = built as never;
    return built;
  };
  const log = createLogger({ level: "debug", sink: o.logSink ?? captureLine });
  const started = await start({
    env,
    host,
    listen: { host: "127.0.0.1", port: 0, opsPort: 0 },
    timers: false,
    handleSignals: false,
    overrides: {
      gateway,
      transport,
      store: memoryObjectStore(),
      captcha: staticCaptcha(CAPTCHA),
      ...(o.oidcFetch ? { oidcFetch: o.oidcFetch } : {}),
      ...(o.errorReportFetch ? { errorReportFetch: o.errorReportFetch } : {}),
    },
    log,
  });
  const base = `http://127.0.0.1:${started.publicAddress.port}`;
  return {
    ...started,
    rt: started.runtime,
    base,
    dataDir,
    env,
    gateway,
    transport,
    host,
    app: () => app,
    async close() {
      await started.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}
export type Cloud = Awaited<ReturnType<typeof bootCloud>>;

export interface Res {
  status: number;
  // oxlint-disable-next-line typescript/no-explicit-any -- test payloads are untyped JSON
  json: any;
  text: string;
  headers: Headers;
}

let ipSeq = 10;
/** A browser (cookie jar, same-origin `Origin`, CSRF header) or a bearer client, over real HTTP. */
export class Client {
  jar = new Map<string, string>();
  bearer: string | null = null;
  ip = `198.51.100.${ipSeq++ % 250}`;
  /** A new client address on every request (sweeps: per-address limits are not under test there). */
  rotateIp = false;
  constructor(readonly cloud: Cloud) {}

  withBearer(token: string): Client {
    const c = new Client(this.cloud);
    c.bearer = token;
    c.rotateIp = this.rotateIp;
    return c;
  }

  async req(
    method: string,
    path: string,
    o: {
      body?: unknown;
      raw?: string;
      headers?: Record<string, string>;
      csrf?: boolean;
      form?: Record<string, string | string[]>;
    } = {},
  ): Promise<Res> {
    if (this.rotateIp) this.ip = `10.${ipSeq % 250}.${(ipSeq += 7) % 250}.${ipSeq % 199}`;
    const headers: Record<string, string> = { "x-forwarded-for": this.ip, ...(o.headers ?? {}) };
    if (this.bearer) headers.authorization = `Bearer ${this.bearer}`;
    if (this.jar.size) headers.cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");
    if (method !== "GET" && method !== "HEAD" && !headers.origin) headers.origin = PUBLIC_URL;
    const csrf = this.jar.get("__Host-gw_csrf");
    if (o.csrf !== false && csrf && method !== "GET") headers["x-csrf-token"] = csrf;
    let body: string | undefined;
    if (o.form) {
      const f = new URLSearchParams();
      for (const [k, v] of Object.entries(o.form))
        for (const x of Array.isArray(v) ? v : [v]) f.append(k, x);
      body = f.toString();
      headers["content-type"] = "application/x-www-form-urlencoded";
    } else if (o.raw !== undefined) body = o.raw;
    else if (o.body !== undefined) {
      body = JSON.stringify(o.body);
      headers["content-type"] ??= "application/json";
    }
    const res = await fetch(`${this.cloud.base}${path}`, {
      method,
      headers,
      redirect: "manual",
      ...(body !== undefined ? { body } : {}),
    });
    for (const sc of res.headers.getSetCookie()) {
      const [pair] = sc.split(";");
      const i = (pair as string).indexOf("=");
      const k = (pair as string).slice(0, i);
      const v = (pair as string).slice(i + 1);
      if (/Max-Age=0/i.test(sc) || v === "") this.jar.delete(k);
      else this.jar.set(k, v);
    }
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    return { status: res.status, json, text, headers: res.headers };
  }
  get = (p: string, o?: Parameters<Client["req"]>[2]) => this.req("GET", p, o);
  post = (p: string, body?: unknown, o: Parameters<Client["req"]>[2] = {}) =>
    this.req("POST", p, { ...o, body });
  patch = (p: string, body?: unknown, o: Parameters<Client["req"]>[2] = {}) =>
    this.req("PATCH", p, { ...o, body });
  put = (p: string, body?: unknown, o: Parameters<Client["req"]>[2] = {}) =>
    this.req("PUT", p, { ...o, body });
  del = (p: string, body?: unknown, o: Parameters<Client["req"]>[2] = {}) =>
    this.req("DELETE", p, { ...o, body });
}

/** The newest email to `email` (memory transport). */
export function lastMail(cloud: Cloud, email: string, template?: string) {
  const all = cloud.transport.sent.filter(
    (m) =>
      m.to.email.toLowerCase() === email.toLowerCase() && (!template || m.template === template),
  );
  return all.at(-1);
}

export const tokenIn = (text: string): string => {
  const m = /#token=([^\s"<]+)/.exec(text);
  if (!m) throw new Error("no token link in the message");
  return decodeURIComponent(m[1] as string);
};

let seq = 0;
export const uniqueEmail = (tag: string) =>
  `${tag}.${++seq}.${Date.now().toString(36)}@example.org`;
export const PASSWORD = "correct horse battery staple 42";

/** Sign up, verify from the email, end signed in. Returns the browser, its user and workspace. */
export async function signUp(cloud: Cloud, o: { name?: string; email?: string } = {}) {
  const b = new Client(cloud);
  const email = o.email ?? uniqueEmail("owner");
  const r = await b.post("/api/v1/auth/signup", {
    email,
    password: PASSWORD,
    name: o.name ?? "Robin Example",
    captchaToken: CAPTCHA,
    termsVersion: "2026-11",
    adultConfirmed: true,
  });
  if (r.status !== 202) throw new Error(`signup ${r.status} ${r.text}`);
  await cloud.rt.accounts.settled();
  const mail = lastMail(cloud, email, "verify-email");
  if (!mail) throw new Error("no verification email");
  const v = await b.post("/api/v1/auth/verify", { token: tokenIn(mail.text) });
  if (v.status !== 200) throw new Error(`verify ${v.status} ${v.text}`);
  const s = await b.get("/api/v1/auth/status");
  return {
    browser: b,
    email,
    userId: s.json.user.id as string,
    accountId: (s.json.workspace?.id ?? null) as string | null,
  };
}

/** Invite `role` into the owner's workspace; the invitee signs up, accepts and switches to it. */
export async function addMember(
  cloud: Cloud,
  owner: Client,
  accountId: string,
  role: "editor" | "viewer",
  name: string,
) {
  const email = uniqueEmail(role);
  const inv = await owner.post("/api/v1/workspace/invitations", { email, role });
  if (inv.status !== 201 && inv.status !== 200) throw new Error(`invite ${inv.status} ${inv.text}`);
  await cloud.rt.accounts.settled();
  await cloud.rt.outbox.drain();
  const member = await signUp(cloud, { email, name });
  const mail = lastMail(cloud, email, "invitation");
  if (!mail) throw new Error("no invitation email");
  const acc = await member.browser.post("/api/v1/workspace/invitations/accept", {
    token: tokenIn(mail.text),
  });
  if (acc.status !== 200) throw new Error(`accept ${acc.status} ${acc.text}`);
  const act = await member.browser.post(`/api/v1/workspaces/${accountId}/activate`, {});
  if (act.status !== 200 && act.status !== 204)
    throw new Error(`activate ${act.status} ${act.text}`);
  return { ...member, accountId };
}

/** Re-authenticate a browser session (sensitive actions). */
export const reauth = (b: Client) => b.post("/api/v1/auth/reauth", { password: PASSWORD });

/** A write-scoped API key of the browser's workspace (needs a recent re-authentication). */
export async function apiKey(b: Client, scopes: string[] = ["read", "write"]): Promise<string> {
  await reauth(b);
  // Personal keys: every member (a viewer too) may create keys for themselves, capped by their role.
  const r = await b.post("/api/v1/me/keys", { name: "test key", scopes });
  if (r.status !== 201) throw new Error(`key ${r.status} ${r.text}`);
  return r.json.key as string;
}

/** The first half of the OAuth flow (registration, consent in the browser): an unused authorization code. */
export async function oauthCode(
  cloud: Cloud,
  b: Client,
  accountId: string,
  scope = "read simulate write",
) {
  const { createHash, randomBytes } = await import("node:crypto");
  const anon = new Client(cloud);
  const reg = await anon.post("/oauth/register", {
    client_name: "Test MCP client",
    redirect_uris: ["http://127.0.0.1:9/callback"],
    token_endpoint_auth_method: "none",
  });
  if (reg.status !== 201) throw new Error(`register ${reg.status} ${reg.text}`);
  const clientId = reg.json.client_id as string;
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const q = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: "http://127.0.0.1:9/callback",
    code_challenge: challenge,
    code_challenge_method: "S256",
    scope,
    state: "s1",
    resource: `${PUBLIC_URL}/mcp`,
    _r: "1",
  });
  const page = await b.get(`/oauth/authorize?${q}`);
  const csrf = /name="csrf" value="([^"]+)"/.exec(page.text)?.[1];
  if (!csrf) throw new Error(`consent page ${page.status} ${page.text.slice(0, 200)}`);
  const form: Record<string, string | string[]> = {
    csrf,
    decision: "approve",
    workspace: accountId,
    grant: scope.split(" "),
  };
  for (const k of [
    "client_id",
    "redirect_uri",
    "state",
    "code_challenge",
    "code_challenge_method",
    "response_type",
    "resource",
    "scope",
  ])
    form[k] = q.get(k) as string;
  const approve = await b.req("POST", "/oauth/authorize", { form });
  const loc = approve.headers.get("location");
  if (approve.status !== 302 || !loc) throw new Error(`approve ${approve.status} ${approve.text}`);
  const code = new URL(loc).searchParams.get("code") as string;
  return { clientId, code, verifier };
}

/** The second half: exchange an authorization code at the token endpoint. */
export const exchangeCode = (
  cloud: Cloud,
  c: { clientId: string; code: string; verifier: string },
) =>
  new Client(cloud).req("POST", "/oauth/token", {
    form: {
      grant_type: "authorization_code",
      code: c.code,
      client_id: c.clientId,
      redirect_uri: "http://127.0.0.1:9/callback",
      code_verifier: c.verifier,
      resource: `${PUBLIC_URL}/mcp`,
    },
  });

/** The OAuth flow (registration, consent in the browser, code exchange): an access and refresh token. */
export async function oauthTokens(
  cloud: Cloud,
  b: Client,
  accountId: string,
  scope = "read simulate write",
) {
  const c = await oauthCode(cloud, b, accountId, scope);
  const { clientId, code } = c;
  const tok = await exchangeCode(cloud, c);
  if (tok.status !== 200) throw new Error(`token ${tok.status} ${tok.text}`);
  return {
    clientId,
    code,
    access: tok.json.access_token as string,
    refresh: tok.json.refresh_token as string,
  };
}

/** The synthetic sample, renamed and re-figured so that its values are recognisable (leak detection). */
export function markedSample(marker: string, amount: number) {
  const doc = createSampleDocument() as unknown as {
    household: { name: string };
    finances: { accounts: Array<{ name: string; balance: number }> };
    plans: Array<{ name: string }>;
  };
  doc.household.name = `${marker} Household`;
  const first = doc.finances.accounts[0];
  if (first) {
    first.name = `${marker} Savings`;
    first.balance = amount;
  }
  for (const p of doc.plans) p.name = `${marker} ${p.name}`;
  return doc;
}
