/**
 * The whole cloud package in-process, on temporary directories, with no network: real control plane, real
 * registry over real SQLite tenant files (a fake `TenantOpener` with a tiny schema and Drizzle-style migration
 * table), real billing service on `FakeStripeGateway`, real backups on the memory object store, real HTTP routes.
 *
 * The fake verifiers mirror `apps/api` exactly where it matters for isolation: an API key is found by its
 * prefix and accepted only if SHA-256 of the whole presented string equals the stored hash; OAuth tokens by
 * hash and resource. Both run against the tenant database the credential names.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  BillingService,
  FakeStripeGateway,
  type PricingConfig,
  parsePricingConfig,
  syncPricing,
} from "@glideworth/billing";
import { hmacUnsubscribeSigner } from "@glideworth/email";
import { OpenAPIHono } from "@hono/zod-openapi";
import Database from "better-sqlite3";
import type { Context, MiddlewareHandler } from "hono";
import { staticCaptcha } from "../src/abuse/captcha.js";
import { memoryRateLimiter } from "../src/abuse/rate-limiter.js";
import { AccountsService } from "../src/accounts/service.js";
import { controlAudit } from "../src/audit.js";
import { memoryObjectStore } from "../src/backups/object-store.js";
import { BackupService } from "../src/backups/service.js";
import { billingLogBridge, billingNotifier, trackCheckoutSessions } from "../src/billing/glue.js";
import type { CloudConfig } from "../src/config.js";
import { controlBillingStore } from "../src/control/billing-store.js";
import { openControlDb } from "../src/control/db.js";
import { MailOutbox } from "../src/control/outbox.js";
import { deriveKey, keyring } from "../src/crypto/keyring.js";
import { API_KEY_RE, mintApiKey, mintRouted } from "../src/crypto/routed.js";
import { capScopes, createEntitlements } from "../src/entitlements.js";
import { CloudError } from "../src/errors.js";
import { googleIssuers } from "../src/federation/google.js";
import { OidcClient } from "../src/federation/oidc.js";
import { FederationService } from "../src/federation/service.js";
import type { PlanLimits } from "../src/external-types.js";
import { cloudErrorResponse } from "../src/http/common.js";
import { type CloudHttpDeps, isCloudRoute } from "../src/http/kit.js";
import { registerCloudRoutes } from "../src/http/routes/index.js";
import { type CredentialVerifiers, type TenantVars, tenantAuth } from "../src/http/tenant-auth.js";
import { fairThreadGate } from "../src/jobs/fair-gate.js";
import { createTenantPolicy } from "../src/policy.js";
import { QuotaService } from "../src/quotas.js";
import { CloudScheduler } from "../src/scheduler.js";
import { TenantRegistry, tenantPragmas } from "../src/tenancy/registry.js";
import type {
  AccountId,
  Role,
  TenantMemberPort,
  TenantOpener,
  TenantRuntimeBase,
} from "../src/types.js";
import { WorkspacesService } from "../src/workspaces/service.js";
import { CapturingMailer, remember, testLog } from "./helpers.js";

// ------------------------------------------------------------------------------------------ temp dirs
const dirs: string[] = [];
export function tempDir(tag = "gw-cloud"): string {
  const d = mkdtempSync(join(tmpdir(), `${tag}-`));
  dirs.push(d);
  return d;
}
export function removeTempDirs(): void {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
}

// ------------------------------------------------------------------------------------- fake tenant db
/** Synthetic financial figures: if one ever shows up in a log line or an operator page, a test fails. */
export const SENTINEL_AMOUNT = remember("918273.64");
export const SENTINEL_HOUSEHOLD = remember("Zephyrine Household");

export const TENANT_MIGRATIONS: string[] = [
  `CREATE TABLE users (id TEXT PRIMARY KEY, login TEXT NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL, hash TEXT);
   INSERT INTO users (id, login, name, role) VALUES ('owner', 'owner', 'Owner', 'owner');
   CREATE TABLE households (id TEXT PRIMARY KEY, name TEXT NOT NULL, net_worth REAL NOT NULL);`,
  `CREATE TABLE api_keys (id TEXT PRIMARY KEY, prefix TEXT NOT NULL UNIQUE, hash TEXT NOT NULL, user_id TEXT NOT NULL,
     scopes TEXT NOT NULL, revoked_at TEXT);
   CREATE TABLE oauth_tokens (id TEXT PRIMARY KEY, hash TEXT NOT NULL UNIQUE, user_id TEXT NOT NULL, resource TEXT NOT NULL);`,
];

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const sameHex = (a: string, b: string) => {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length === y.length && timingSafeEqual(x, y);
};

export class FakeRuntime implements TenantRuntimeBase {
  jobs = 0;
  closed = false;
  readonly members: TenantMemberPort;
  constructor(
    readonly accountId: AccountId,
    readonly db: Database.Database,
  ) {
    this.members = {
      upsert: (m) => {
        db.prepare(
          `INSERT INTO users (id, login, name, role) VALUES (?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET name = excluded.name, role = excluded.role`,
        ).run(m.tenantUserId, m.login, m.name, m.role);
        // As UsersService.update: a role change signs the person out and caps their keys (here: revoke writes).
      },
      remove: (id) => {
        db.prepare("DELETE FROM api_keys WHERE user_id = ?").run(id);
        db.prepare("DELETE FROM oauth_tokens WHERE user_id = ?").run(id);
        db.prepare("DELETE FROM users WHERE id = ?").run(id);
      },
      list: () =>
        db.prepare("SELECT id AS tenantUserId, role, name FROM users").all() as Array<{
          tenantUserId: string;
          role: Role;
          name: string;
        }>,
      revokeCredentials: (id) => {
        db.prepare("DELETE FROM api_keys WHERE user_id = ?").run(id);
        db.prepare("DELETE FROM oauth_tokens WHERE user_id = ?").run(id);
      },
      revokeOAuthGrants: (id) =>
        db.prepare("DELETE FROM oauth_tokens WHERE user_id = ?").run(id).changes,
    };
  }
  busy(): boolean {
    return this.jobs > 0;
  }
  async close(): Promise<void> {
    if (!this.closed) this.db.close();
    this.closed = true;
  }
  addHousehold(id: string, name: string, netWorth: number): void {
    this.db
      .prepare("INSERT INTO households (id, name, net_worth) VALUES (?, ?, ?)")
      .run(id, name, netWorth);
  }
  households(): Array<{ id: string; name: string; net_worth: number }> {
    return this.db.prepare("SELECT * FROM households ORDER BY id").all() as never;
  }
}

export interface FakeOpener extends TenantOpener<FakeRuntime> {
  opened: string[];
  failNext: { migration: string } | null;
  schemaVersion: number;
  migrations: string[];
}

export function fakeOpener(o: { migrations?: string[] } = {}): FakeOpener {
  const migrations = [...(o.migrations ?? TENANT_MIGRATIONS)];
  const opener: FakeOpener = {
    opened: [],
    failNext: null,
    migrations,
    get schemaVersion() {
      return migrations.length;
    },
    open(accountId: AccountId, dbPath: string, limits: PlanLimits) {
      opener.opened.push(accountId);
      const db = new Database(dbPath);
      try {
        db.pragma("journal_mode = WAL");
        for (const [k, v] of Object.entries(tenantPragmas(limits))) db.pragma(`${k} = ${v}`);
        db.exec(
          "CREATE TABLE IF NOT EXISTS __drizzle_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, hash TEXT NOT NULL, created_at INTEGER)",
        );
        const applied = (
          db.prepare("SELECT count(*) AS n FROM __drizzle_migrations").get() as { n: number }
        ).n;
        const pending = migrations.slice(applied);
        const failing = opener.failNext;
        opener.failNext = null;
        // One transaction for all pending migrations, as Drizzle's migrator does.
        db.transaction(() => {
          for (const m of pending) {
            db.exec(m);
            db.prepare("INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)").run(
              sha(m),
              Date.now(),
            );
          }
          if (failing) db.exec(failing.migration);
        })();
        return new FakeRuntime(accountId, db);
      } catch (err) {
        db.close();
        throw err;
      }
    },
  };
  return opener;
}

// ------------------------------------------------------------------------------------------ verifiers
export interface TestPrincipal {
  accountId: string;
  userId: string;
  role: Role;
  scopes: Array<"read" | "simulate" | "write">;
  via: "key" | "oauth" | "session";
  limitedBy?: "entitlement";
}
const ROLE_SCOPES: Record<Role, TestPrincipal["scopes"]> = {
  owner: ["read", "simulate", "write"],
  editor: ["read", "simulate", "write"],
  viewer: ["read", "simulate"],
};

function userOf(r: FakeRuntime, id: string): { id: string; role: Role } | undefined {
  return r.db.prepare("SELECT id, role FROM users WHERE id = ?").get(id) as
    | { id: string; role: Role }
    | undefined;
}

export const verifiers: CredentialVerifiers<FakeRuntime, TestPrincipal> = {
  apiKey(r, token) {
    if (!API_KEY_RE.test(token)) return null;
    const prefix = token.split("_")[2] as string;
    const row = r.db
      .prepare("SELECT * FROM api_keys WHERE prefix = ? AND revoked_at IS NULL")
      .get(prefix) as { hash: string; user_id: string; scopes: string } | undefined;
    if (!row || !sameHex(row.hash, sha(token))) return null;
    const u = userOf(r, row.user_id);
    if (!u) return null;
    const scopes = (JSON.parse(row.scopes) as TestPrincipal["scopes"]).filter((s) =>
      ROLE_SCOPES[u.role].includes(s),
    );
    return { accountId: r.accountId, userId: u.id, role: u.role, scopes, via: "key" };
  },
  oauthAccess(r, token, resource) {
    const row = r.db.prepare("SELECT * FROM oauth_tokens WHERE hash = ?").get(sha(token)) as
      | { user_id: string; resource: string }
      | undefined;
    if (!row || row.resource !== resource) return null;
    const u = userOf(r, row.user_id);
    if (!u) return null;
    return {
      accountId: r.accountId,
      userId: u.id,
      role: u.role,
      scopes: ROLE_SCOPES[u.role],
      via: "oauth",
    };
  },
  session(r, m) {
    return {
      accountId: r.accountId,
      userId: m.tenantUserId,
      role: m.role,
      scopes: ROLE_SCOPES[m.role],
      via: "session",
    };
  },
  cap(p, e) {
    const c = capScopes(p.scopes, e);
    return { ...p, scopes: c.scopes, ...(c.limited ? { limitedBy: "entitlement" as const } : {}) };
  },
};

export function mintKeyIn(
  r: FakeRuntime,
  userId = "owner",
  scopes: TestPrincipal["scopes"] = ["read", "write"],
): string {
  const { key, prefix } = mintApiKey(r.accountId);
  r.db
    .prepare("INSERT INTO api_keys (id, prefix, hash, user_id, scopes) VALUES (?, ?, ?, ?, ?)")
    .run(`key_${prefix}`, prefix, sha(key), userId, JSON.stringify(scopes));
  return remember(key);
}

export function mintOauthIn(r: FakeRuntime, resource: string, userId = "owner"): string {
  const token = mintRouted("oauth_access", r.accountId);
  r.db
    .prepare("INSERT INTO oauth_tokens (id, hash, user_id, resource) VALUES (?, ?, ?, ?)")
    .run(`oat_${sha(token).slice(0, 8)}`, sha(token), userId, resource);
  return remember(token);
}

// --------------------------------------------------------------------------------------------- pricing
export function testPricing(): PricingConfig {
  const file = resolve(import.meta.dirname, "..", "..", "billing", "pricing.example.json");
  return parsePricingConfig(JSON.parse(readFileSync(file, "utf8")));
}

export const PUBLIC_URL = "https://app.example.test";
export const WEBHOOK_SECRET = "whsec_test_cloud_fixture_secret";

// ------------------------------------------------------------------------------------------- the stack
export interface GoogleTestClient {
  issuer: string;
  clientId: string;
  clientSecret: string;
  fetch: typeof fetch;
}

export async function makeCloud(
  o: {
    now?: () => Date;
    maxOpen?: number;
    opener?: FakeOpener;
    dataDir?: string;
    /** "Sign in with Google" against an in-process fake provider (test/fake-oidc.ts). Off when absent. */
    google?: GoogleTestClient;
  } = {},
) {
  const dataDir = o.dataDir ?? tempDir();
  const clock = { offset: 0 };
  const now = o.now ?? (() => new Date(Date.now() + clock.offset));
  const control = openControlDb(join(dataDir, "control", "control.db"));
  const db = control.db;
  const secretsKey = new Uint8Array(32).fill(7);
  const keys = keyring(secretsKey);
  const kek = { id: "kek-test", key: new Uint8Array(32).fill(9) };
  const mailer = new CapturingMailer();
  const limiter = memoryRateLimiter({ now: () => now().getTime() });
  const audit = controlAudit(db, { now, log: testLog });
  const pricing = testPricing();
  const fake = new FakeStripeGateway({ now });
  const sync = await syncPricing(fake, pricing, {
    apply: true,
    archiveRemoved: false,
    returnUrl: `${PUBLIC_URL}/settings/billing`,
  });
  const outbox = new MailOutbox({ db, mailer, log: testLog, now });
  const billing = new BillingService({
    gateway: trackCheckoutSessions(fake, db, now),
    store: controlBillingStore(db, { now }),
    pricing,
    publicUrl: PUBLIC_URL,
    webhookSecret: WEBHOOK_SECRET,
    portalConfigurationId: sync.portalConfigurationId ?? "",
    notify: billingNotifier({ db, outbox, audit, log: testLog, publicUrl: PUBLIC_URL }),
    limiter: (k, l, w) => limiter.hit(k, l, w).allowed,
    log: billingLogBridge({ log: testLog, audit }),
    now,
  });
  const entitlements = createEntitlements({ db, pricing, now });
  const quotas = new QuotaService({ db, limiter, entitlements, now });
  const opener = o.opener ?? fakeOpener();
  const registry = new TenantRegistry<FakeRuntime>({
    dataDir,
    control: db,
    opener,
    limitsOf: (a) => entitlements.get(a).limits,
    maxOpen: o.maxOpen ?? 16,
    log: testLog,
    now: () => now().getTime(),
    drainMs: 2000,
  });
  const store = memoryObjectStore();
  const backups = new BackupService({
    db,
    registry: registry as unknown as TenantRegistry<TenantRuntimeBase>,
    store,
    kek,
    dataDir,
    region: "test",
    log: testLog,
    now,
  });
  const workspaces = new WorkspacesService({
    db,
    registry: registry as unknown as TenantRegistry<TenantRuntimeBase>,
    billing,
    mailer,
    audit,
    keys,
    publicUrl: PUBLIC_URL,
    now,
    log: testLog,
    limiter,
    pricing,
    kek,
    dataDir,
    outbox,
    backups,
  });
  const accounts = new AccountsService({
    db,
    keys,
    mailer,
    captcha: staticCaptcha("captcha-ok"),
    limiter,
    audit,
    workspaces: () => workspaces,
    publicUrl: PUBLIC_URL,
    now,
    log: testLog,
  });
  const policy = createTenantPolicy({ entitlements, quotas, publicUrl: PUBLIC_URL, log: testLog });
  const unsubscribe = hmacUnsubscribeSigner({
    key: deriveKey(secretsKey, "email:unsubscribe"),
    baseUrl: PUBLIC_URL,
  });
  const config: CloudConfig = {
    publicUrl: PUBLIC_URL,
    dataDir,
    secretsKey,
    backupKek: kek,
    pricingFile: "/nonexistent",
    tenantCacheSize: 16,
    maxJobs: 2,
    opsListen: { host: "127.0.0.1", port: 0 },
    production: false,
    google: o.google
      ? {
          clientId: o.google.clientId,
          clientSecret: o.google.clientSecret,
          issuer: o.google.issuer,
          redirectUri: `${PUBLIC_URL}/api/v1/auth/google/callback`,
        }
      : null,
    heartbeats: { backup: null, restoreTest: null, liveness: null },
    errorReports: null,
  };
  const federation = o.google
    ? new FederationService({
        db,
        keys,
        accounts,
        audit,
        limiter,
        log: testLog,
        now,
        invitation: (token) => workspaces.liveInvitation(token),
        oidc: new OidcClient({
          issuer: o.google.issuer,
          acceptedIssuers: googleIssuers(o.google.issuer),
          clientId: o.google.clientId,
          clientSecret: o.google.clientSecret,
          redirectUri: `${PUBLIC_URL}/api/v1/auth/google/callback`,
          fetch: o.google.fetch,
          now,
          log: testLog,
        }),
      })
    : undefined;
  const http: CloudHttpDeps = {
    config,
    accounts,
    workspaces,
    billing,
    entitlements,
    quotas,
    backups,
    captcha: staticCaptcha("captcha-ok"),
    limiter,
    audit,
    log: testLog,
    unsubscribe,
    db,
    keys,
    pricing,
    outbox,
    trustProxy: true,
    registry: registry as unknown as TenantRegistry<TenantRuntimeBase>,
    mailgunWebhookSigningKey: "mailgun-signing-key-for-tests",
    now,
    ...(federation ? { federation } : {}),
  };
  const scheduled: string[] = [];
  const scheduler = new CloudScheduler<FakeRuntime>({
    db,
    registry,
    entitlements,
    runDue: async (r) => {
      scheduled.push(r.accountId);
      return { nextRunAt: new Date(now().getTime() + 3600_000).toISOString() };
    },
    log: testLog,
    now,
  });

  // The public app as apps/api will build it: cloud routes, then tenantAuth on every other /api route and /mcp.
  const app = new OpenAPIHono();
  app.onError((err, c) => cloudErrorResponse(err, c, testLog));
  registerCloudRoutes(app, http);
  const apiAuth = tenantAuth<FakeRuntime, TestPrincipal>({
    accounts,
    workspaces,
    registry,
    entitlements,
    quotas,
    verifiers,
    publicUrl: PUBLIC_URL,
    mode: "api",
  });
  const mcpAuth = tenantAuth<FakeRuntime, TestPrincipal>({
    accounts,
    workspaces,
    registry,
    entitlements,
    quotas,
    verifiers,
    publicUrl: PUBLIC_URL,
    mode: "mcp",
  });
  type Env = { Variables: TenantVars<FakeRuntime, TestPrincipal> };
  const tenantApp = app as unknown as OpenAPIHono<Env>;
  tenantApp.use("/api/*", (c, next) => (isCloudRoute(c.req.path) ? next() : apiAuth(c, next)));
  tenantApp.use("/mcp", mcpAuth as MiddlewareHandler<Env>);
  const requireWrite = (c: Context<Env>) => {
    const p = c.get("principal");
    if (!p.scopes.includes("write")) {
      if (p.limitedBy === "entitlement")
        throw new CloudError(402, "ACCOUNT_READ_ONLY", "the workspace is read-only", {
          reason: c.get("tenant").entitlements.reason,
        });
      throw new CloudError(403, "FORBIDDEN", "write scope required");
    }
  };
  tenantApp.get("/api/v1/whoami", (c) =>
    c.json({ accountId: c.get("tenant").accountId, principal: c.get("principal") }),
  );
  tenantApp.get("/api/v1/households", (c) =>
    c.json({ items: c.get("tenant").runtime.households() }),
  );
  tenantApp.post("/api/v1/households", async (c) => {
    requireWrite(c);
    const b = (await c.req.json()) as { id: string; name: string; netWorth: number };
    c.get("tenant").runtime.addHousehold(b.id, b.name, b.netWorth);
    return c.json({ ok: true }, 201);
  });
  tenantApp.post("/mcp", (c) =>
    c.json({ accountId: c.get("tenant").accountId, scopes: c.get("principal").scopes }),
  );

  return {
    dataDir,
    clock,
    now,
    advance: (ms: number) => {
      clock.offset += ms;
    },
    db,
    close: async () => {
      await registry.shutdown();
      control.close();
    },
    keys,
    kek,
    mailer,
    limiter,
    audit,
    pricing,
    fake,
    billing,
    entitlements,
    quotas,
    opener,
    registry,
    store,
    backups,
    workspaces,
    accounts,
    outbox,
    policy,
    unsubscribe,
    http,
    federation,
    scheduler,
    scheduled,
    threadGate: fairThreadGate({ maxThreads: 2 }),
    app,
  };
}
export type Cloud = Awaited<ReturnType<typeof makeCloud>>;

// ------------------------------------------------------------------------------------------ HTTP client
export interface Res {
  status: number;
  body: Record<string, unknown>;
  text: string;
  headers: Headers;
  setCookies: string[];
}

/** A browser: a cookie jar, same-origin `Origin`, and the CSRF header taken from the readable cookie. */
export class Browser {
  jar = new Map<string, string>();
  /** Each cookie's SameSite attribute, so a cross-site navigation can leave out the Strict ones. */
  sameSite = new Map<string, string>();
  ip = `203.0.113.${Math.floor(Math.random() * 200) + 1}`;
  constructor(
    readonly app: { request: (p: string, i?: RequestInit) => Response | Promise<Response> },
  ) {}

  async req(
    method: string,
    path: string,
    o: {
      body?: unknown;
      csrf?: boolean;
      origin?: string | null;
      headers?: Record<string, string>;
      raw?: string;
      /**
       * A top-level navigation that another site started (the redirect back from Google, a link in an
       * email): like a real browser, send no `SameSite=Strict` cookie, only Lax and None ones.
       */
      crossSite?: boolean;
    } = {},
  ): Promise<Res> {
    const headers: Record<string, string> = {
      "x-forwarded-for": this.ip,
      "user-agent": "Mozilla/5.0 Test",
      ...(o.headers ?? {}),
    };
    const sent = [...this.jar].filter(
      ([k]) => !o.crossSite || (this.sameSite.get(k) ?? "lax") !== "strict",
    );
    if (sent.length) headers.cookie = sent.map(([k, v]) => `${k}=${v}`).join("; ");
    if (method !== "GET" && o.origin !== null) headers.origin = o.origin ?? PUBLIC_URL;
    if (o.csrf !== false && method !== "GET" && this.jar.get("__Host-gw_csrf"))
      headers["x-csrf-token"] = this.jar.get("__Host-gw_csrf") as string;
    let body: string | undefined;
    if (o.raw !== undefined) body = o.raw;
    else if (o.body !== undefined) {
      body = JSON.stringify(o.body);
      headers["content-type"] = "application/json";
    }
    const res = await this.app.request(path, {
      method,
      headers,
      ...(body !== undefined ? { body } : {}),
    });
    const setCookies = res.headers.getSetCookie();
    for (const sc of setCookies) {
      const [pair] = sc.split(";");
      const i = (pair as string).indexOf("=");
      const k = (pair as string).slice(0, i);
      const v = (pair as string).slice(i + 1);
      if (/Max-Age=0/i.test(sc) || v === "") this.jar.delete(k);
      else {
        this.jar.set(k, v);
        this.sameSite.set(k, (/;\s*SameSite=(\w+)/i.exec(sc)?.[1] ?? "lax").toLowerCase());
      }
    }
    const text = await res.text();
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = {};
    }
    return { status: res.status, body: parsed, text, headers: res.headers, setCookies };
  }
  get = (p: string, o?: Parameters<Browser["req"]>[2]) => this.req("GET", p, o);
  post = (p: string, body?: unknown, o: Parameters<Browser["req"]>[2] = {}) =>
    this.req("POST", p, { ...o, body });
  patch = (p: string, body?: unknown, o: Parameters<Browser["req"]>[2] = {}) =>
    this.req("PATCH", p, { ...o, body });
  del = (p: string, body?: unknown, o: Parameters<Browser["req"]>[2] = {}) =>
    this.req("DELETE", p, { ...o, body });
}

let seq = 0;
export const uniqueEmail = (tag = "person") =>
  remember(`${tag}.${++seq}.${Date.now().toString(36)}@example.org`);
export const strongPassword = () =>
  remember(`correct horse ${Math.random().toString(36).slice(2)} battery`);

/** Sign up and verify through the HTTP routes; returns a signed-in browser. */
/**
 * The owner starts the free trial as in production: Checkout through the route, completed in the fake Stripe (card
 * given), and Stripe's events delivered to the signed webhook. Afterwards the workspace is `trialing`.
 */
export async function startTrial(cloud: Cloud, owner: Browser, lookupKey = "cloud_monthly_v1") {
  const r = await owner.post("/api/v1/billing/checkout", { lookupKey });
  if (r.status !== 200) throw new Error(`checkout failed ${r.status} ${r.text}`);
  const sessionId = String(r.body.url).split("/").at(-1) as string;
  for (const ev of cloud.fake.completeCheckout(sessionId)) {
    const { body, header } = cloud.fake.sign(ev, WEBHOOK_SECRET);
    const w = await cloud.app.request("/stripe/webhook", {
      method: "POST",
      headers: { "stripe-signature": header, "content-type": "application/json" },
      body,
    });
    if (w.status !== 200) throw new Error(`webhook failed ${w.status}`);
  }
}

/**
 * Sign up and verify; an owner then starts the free trial (`startTrial`), since a new workspace has no access
 * before Checkout. `trial: false` stops before Checkout.
 */
export async function signedUpBrowser(
  cloud: Cloud,
  o: { email?: string; name?: string; trial?: boolean } = {},
) {
  const b = new Browser(cloud.app);
  const email = o.email ?? uniqueEmail();
  const password = strongPassword();
  const r = await b.post("/api/v1/auth/signup", {
    email,
    password,
    name: o.name ?? "Robin Example",
    captchaToken: "captcha-ok",
    termsVersion: "2026-11",
    adultConfirmed: true,
  });
  if (r.status !== 202) throw new Error(`signup failed ${r.status} ${r.text}`);
  await cloud.accounts.settled();
  const token = cloud.mailer.token(email, "verify-email");
  const v = await b.post("/api/v1/auth/verify", { token });
  if (v.status !== 200) throw new Error(`verify failed ${v.status} ${v.text}`);
  remember(b.jar.get("__Host-gw_session") as string);
  remember(b.jar.get("__Host-gw_csrf") as string);
  const status = await b.get("/api/v1/auth/status");
  const ws = status.body.workspace as { id: string } | null;
  const user = status.body.user as { id: string };
  if (ws && o.trial !== false) await startTrial(cloud, b);
  return { browser: b, email, password, accountId: ws?.id ?? null, userId: user.id };
}
