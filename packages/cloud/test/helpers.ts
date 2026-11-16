/**
 * Test fixtures: an in-memory control plane, a capturing mailer, fakes for the tenant registry and billing,
 * a controllable clock, and the capture of every log line plus every secret the tests create. `setup.ts`
 * checks after each file that no secret (and nothing shaped like an email address or token) reached a log line.
 */
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { staticCaptcha } from "../src/abuse/captcha.js";
import { memoryRateLimiter } from "../src/abuse/rate-limiter.js";
import { AccountsService } from "../src/accounts/service.js";
import { controlAudit } from "../src/audit.js";
import { type ControlDb, openControlDb } from "../src/control/db.js";
import { accounts, auditEvents, users } from "../src/control/schema.js";
import { keyring } from "../src/crypto/keyring.js";
import { base32Decode } from "../src/crypto/random.js";
import { hotp, totpStep } from "../src/crypto/totp.js";
import type {
  Access,
  Address,
  BillingService,
  Mailer,
  PlanLimits,
  SendOutcome,
  TemplateData,
  TemplateId,
} from "../src/external-types.js";
import { createLogger } from "../src/log/index.js";
import type { TenantRegistry } from "../src/tenancy/registry.js";
import type {
  AccountId,
  RequestMeta,
  Role,
  SessionContext,
  TenantRuntimeBase,
  UserId,
} from "../src/types.js";
import { WorkspacesService } from "../src/workspaces/service.js";

// ------------------------------------------------------------------------------------- log capture
export const logLines: string[] = [];
export const secrets = new Set<string>();
export const remember = <T extends string>(s: T): T => {
  if (s && s.length >= 6) secrets.add(s);
  return s;
};
export const testLog = createLogger({ level: "debug", sink: (l) => logLines.push(l) });

// ------------------------------------------------------------------------------------------ mailer
export interface SentMail {
  to: Address;
  id: TemplateId;
  data: Record<string, unknown>;
  userId: string | undefined;
}
export class CapturingMailer implements Mailer {
  sent: SentMail[] = [];
  fail = false;
  async send<T extends TemplateId>(
    to: Address,
    id: T,
    data: TemplateData[T],
    opts?: { userId?: string },
  ): Promise<SendOutcome> {
    this.sent.push({
      to,
      id,
      data: data as unknown as Record<string, unknown>,
      userId: opts?.userId,
    });
    if (this.fail) return { status: "failed", code: "TEST_FAILURE" };
    return { status: "sent", providerMessageId: null };
  }
  to(email: string, id?: TemplateId): SentMail[] {
    return this.sent.filter(
      (m) => m.to.email.toLowerCase() === email.toLowerCase() && (!id || m.id === id),
    );
  }
  last(email: string, id: TemplateId): SentMail | undefined {
    return this.to(email, id).at(-1);
  }
  /** The token from the fragment of the link in the last mail of this kind. */
  token(email: string, id: TemplateId): string {
    const m = this.last(email, id);
    const url = m?.data.url;
    if (typeof url !== "string") throw new Error(`no ${id} mail to that address`);
    const t = decodeURIComponent(url.split("#token=")[1] ?? "");
    return remember(t);
  }
  clear() {
    this.sent = [];
  }
}

// ------------------------------------------------------------------------------------------ fakes
export const LIMITS: PlanLimits = {
  editors: 2,
  viewers: 3,
  apiRequestsPerMinute: 1200,
  apiRequestsPerDay: 100_000,
  concurrentJobs: 1,
  queuedJobs: 10,
  jobsPerDay: 300,
  workerSecondsPerDay: 1800,
  maxJobSeconds: 300,
  maxMonteCarloTrials: 20_000,
  webhooks: 10,
  webhookDeliveriesPerDay: 5000,
  shareLinks: 50,
  shareReadsPerDay: 10_000,
  apiKeys: 25,
  storageMb: 200,
};

export function fakeBilling(limits: PlanLimits = LIMITS): BillingService {
  const access: Access = { level: "full", reason: "trial", changesAt: null };
  return { status: () => ({ record: null, access, limits }) };
}

export interface MemberCall {
  op: "upsert" | "remove" | "revokeCredentials" | "revokeOAuthGrants" | "provision" | "destroy";
  accountId: AccountId;
  tenantUserId: string;
  role?: Role;
}
export function fakeRegistry(): {
  registry: TenantRegistry<TenantRuntimeBase>;
  calls: MemberCall[];
  failNext: { v: boolean };
} {
  const calls: MemberCall[] = [];
  const failNext = { v: false };
  const registry = {
    pathFor: (accountId: AccountId) => `/nonexistent/${accountId}/tenant.db`,
    async provision(accountId: AccountId) {
      calls.push({ op: "provision", accountId, tenantUserId: "owner" });
    },
    async destroy(accountId: AccountId) {
      calls.push({ op: "destroy", accountId, tenantUserId: "" });
    },
    async with<T>(accountId: AccountId, fn: (r: TenantRuntimeBase) => T | Promise<T>): Promise<T> {
      if (failNext.v) {
        failNext.v = false;
        throw new Error("tenant unavailable");
      }
      const runtime: TenantRuntimeBase = {
        accountId,
        busy: () => false,
        close: async () => {},
        members: {
          upsert: (m) =>
            calls.push({ op: "upsert", accountId, tenantUserId: m.tenantUserId, role: m.role }),
          remove: (id) => calls.push({ op: "remove", accountId, tenantUserId: id }),
          revokeCredentials: (id) =>
            calls.push({ op: "revokeCredentials", accountId, tenantUserId: id }),
          revokeOAuthGrants: (id) => {
            calls.push({ op: "revokeOAuthGrants", accountId, tenantUserId: id });
            return 0;
          },
          list: () => [],
        },
      };
      return fn(runtime);
    },
  };
  return { registry: registry as unknown as TenantRegistry<TenantRuntimeBase>, calls, failNext };
}

/** The real WorkspacesService, recording which workspaces were created and deleted. */
export class TestWorkspaces extends WorkspacesService {
  created: AccountId[] = [];
  deleted: AccountId[] = [];
  override async create(ownerUserId: UserId, name: string): Promise<AccountId> {
    const id = await super.create(ownerUserId, name);
    this.created.push(id);
    return id;
  }
  override async deleteOwnedByUser(ownerUserId: UserId, accountId: AccountId): Promise<void> {
    await super.deleteOwnedByUser(ownerUserId, accountId);
    const row = this.d.db.select().from(accounts).where(eq(accounts.id, accountId)).get();
    if (row?.status === "deleted") this.deleted.push(accountId);
  }
}

export const TEST_PRICING = { trialDays: 30, trialProductId: "gw_cloud" } as const;
export const testKek = () => ({ id: "k-test", key: new Uint8Array(randomBytes(32)) });

// ------------------------------------------------------------------------------------- environment
export const T0 = Date.parse("2026-11-16T10:00:00.000Z");

export function makeEnv(o: { limits?: PlanLimits } = {}) {
  const clock = { t: T0 };
  const now = () => new Date(clock.t);
  const { db, close } = openControlDb(":memory:");
  const keys = keyring(randomBytes(32));
  const mailer = new CapturingMailer();
  const limiter = memoryRateLimiter({ now: () => clock.t });
  const audit = controlAudit(db, { now, log: testLog });
  const reg = fakeRegistry();
  const workspaces = new TestWorkspaces({
    db,
    registry: reg.registry,
    billing: fakeBilling(o.limits),
    mailer,
    audit,
    keys,
    publicUrl: "https://app.example.test",
    now,
    log: testLog,
    limiter,
    pricing: TEST_PRICING,
    kek: testKek(),
  });
  const accountsSvc = new AccountsService({
    db,
    keys,
    mailer,
    captcha: staticCaptcha("captcha-ok"),
    limiter,
    audit,
    workspaces: () => workspaces,
    publicUrl: "https://app.example.test/",
    now,
    log: testLog,
  });
  let ipCounter = 10;
  return {
    db,
    close,
    keys,
    mailer,
    limiter,
    audit,
    reg,
    workspaces,
    accounts: accountsSvc,
    clock,
    now,
    advance(ms: number) {
      clock.t += ms;
    },
    /** A fresh client address per call, so per-IP limits do not interfere unless a test wants them to. */
    meta(over: Partial<RequestMeta> = {}): RequestMeta {
      ipCounter++;
      return {
        ip: `198.51.${Math.floor(ipCounter / 250)}.${ipCounter % 250}`,
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Gecko/20100101 Firefox/120.0",
        deviceToken: null,
        ...over,
      };
    },
  };
}
export type Env = ReturnType<typeof makeEnv>;

let seq = 0;
export const newEmail = (tag = "user") =>
  remember(`${tag}.${++seq}.${randomBytes(3).toString("hex")}@example.org`);
export const newPassword = () =>
  remember(`pw-${randomBytes(12).toString("base64url")}-long enough`);

/** Sign up and verify through the real flow. Returns the verified session and its context. */
export async function signUpVerified(
  env: Env,
  o: { email?: string; password?: string; name?: string } = {},
) {
  const email = o.email ?? newEmail();
  const password = o.password ?? newPassword();
  // One browser signs up and follows the link (its `__Host-gw_signup` cookie value).
  const browser = randomBytes(32).toString("base64url");
  await env.accounts.signUp(
    {
      email,
      password,
      name: o.name ?? "Alex Example",
      captchaToken: "captcha-ok",
      termsVersion: "2026-11",
      adultConfirmed: true,
      browser,
    },
    env.meta(),
  );
  await env.accounts.settled();
  const token = env.mailer.token(email, "verify-email");
  const verified = await env.accounts.verifyEmail(token, env.meta(), { browser });
  remember(verified.session.token);
  remember(verified.session.csrf);
  const ctx = env.accounts.resolveSession(verified.session.token);
  if (!ctx) throw new Error("session did not resolve");
  return { email, password, ...verified, ctx };
}

export function ctxOf(env: Env, token: string): SessionContext {
  const c = env.accounts.resolveSession(token);
  if (!c) throw new Error("no session");
  return c;
}

/** A valid TOTP code for `secret` at the env's current time (offset in steps). */
export function totpNow(env: Env, secret: string, offset = 0): string {
  return hotp(base32Decode(secret) as Uint8Array, totpStep(env.clock.t) + offset);
}

export function auditRows(db: ControlDb) {
  return db.select().from(auditEvents).all();
}

export function userRow(db: ControlDb, email: string) {
  return db
    .select()
    .from(users)
    .all()
    .find((u) => u.email.toLowerCase() === email.toLowerCase());
}

/** No secret, address or credential in the audit trail. */
export function assertAuditClean(db: ControlDb): void {
  const text = JSON.stringify(auditRows(db).map((r) => ({ ...r, ip: null, userAgent: null })));
  for (const s of secrets)
    if (text.includes(s)) throw new Error("a secret reached the audit trail");
  if (/[^\s"@]+@[^\s"@]+\.[a-z]{2,}/.test(text))
    throw new Error("an email address reached the audit trail");
}
