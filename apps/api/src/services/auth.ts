/**
 * Browser authentication for a single-user, self-hosted instance.
 *
 *   first run   POST /auth/setup sets the passphrase (only while none exists)
 *   login       POST /auth/login verifies it (scrypt, constant-time) and issues a session
 *   session     random 256-bit token in an httpOnly, SameSite=Strict cookie; only its sha256 is stored
 *   expiry      absolute lifetime + idle timeout; expired rows are purged opportunistically
 *   csrf        every session has a CSRF token; cookie-authenticated writes must echo it
 *   throttling  failed logins are rate limited per client and globally
 *
 * API keys are a separate, programmatic mechanism (auth.ts) and are untouched by any of this.
 */
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { and, eq, lt, or } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { authCredentials, authSessions, users } from "../db/schema.js";
import { ApiError } from "../errors.js";
import { nowIso, sha256 } from "../util.js";

export const MIN_PASSPHRASE_LENGTH = 12;
const MAX_PASSPHRASE_LENGTH = 1024;

// scrypt: N=2^15, r=8, p=1 (~32 MiB, ~100 ms). Parameters are stored with the hash so they can be raised later.
const SCRYPT = { N: 32_768, r: 8, p: 1, keylen: 32 } as const;
const scryptAsync = (
  pw: string,
  salt: Buffer,
  p: { N: number; r: number; p: number; keylen: number },
) =>
  new Promise<Buffer>((resolve, reject) => {
    scrypt(
      pw.normalize("NFKC"),
      salt,
      p.keylen,
      { N: p.N, r: p.r, p: p.p, maxmem: 128 * p.N * p.r + 1024 * 1024 },
      (err, key) => (err ? reject(err) : resolve(key)),
    );
  });

/** `scrypt$N$r$p$<salt b64>$<hash b64>` */
export async function hashPassphrase(passphrase: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(passphrase, salt, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassphrase(passphrase: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, salt, hash] = stored.split("$");
  if (alg !== "scrypt" || !n || !r || !p || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64");
  const key = await scryptAsync(passphrase, Buffer.from(salt, "base64"), {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    keylen: expected.length,
  });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

export interface AuthOptions {
  /** Absolute session lifetime. Default 7 days. */
  sessionTtlMs?: number;
  /** A session unused for this long expires. Default 24 hours. */
  sessionIdleMs?: number;
  /** Failed logins allowed per client within the window. Default 5. */
  maxFailedLogins?: number;
  /** Failed logins allowed across all clients within the window (distributed guessing). Default 25. */
  maxFailedLoginsGlobal?: number;
  /** Throttling window. Default 15 minutes. */
  loginWindowMs?: number;
  /** When set, first-run setup must present this token (so a stranger cannot claim a fresh instance). */
  setupToken?: string | undefined;
  now?: () => number;
  /** Most clients the login throttle remembers (memory bound). Default `MAX_THROTTLED_CLIENTS`. */
  maxThrottledClients?: number;
}

export interface SessionInfo {
  id: string;
  userId: string;
  csrf: string;
  expiresAt: string;
}

export interface IssuedSession {
  /** The cookie value. Never stored. */
  token: string;
  csrf: string;
  expiresAt: Date;
  maxAgeSeconds: number;
}

// The `cairn-session:` domain separator predates the rename. It is part of every stored session id, so it
// stays: changing it would sign everybody out.
const tokenId = (token: string) => sha256(`cairn-session:${token}`);
/** Hash of a random passphrase: verified against when a sign-in name is unknown, so timing does not reveal it. */
const DUMMY_HASH =
  "scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

/** Most clients the login throttle remembers at once. */
export const MAX_THROTTLED_CLIENTS = 10_000;

export class AuthService {
  private readonly opts: Required<Omit<AuthOptions, "setupToken">> & {
    setupToken: string | undefined;
  };
  private failures = new Map<string, number[]>();
  private globalFailures: number[] = [];

  constructor(
    private readonly db: Db,
    opts: AuthOptions = {},
  ) {
    this.opts = {
      sessionTtlMs: opts.sessionTtlMs ?? 7 * 24 * 3600 * 1000,
      sessionIdleMs: opts.sessionIdleMs ?? 24 * 3600 * 1000,
      maxFailedLogins: opts.maxFailedLogins ?? 5,
      maxFailedLoginsGlobal: opts.maxFailedLoginsGlobal ?? 25,
      loginWindowMs: opts.loginWindowMs ?? 15 * 60 * 1000,
      setupToken: opts.setupToken,
      now: opts.now ?? Date.now,
      maxThrottledClients: opts.maxThrottledClients ?? MAX_THROTTLED_CLIENTS,
    };
  }

  private get now(): number {
    return this.opts.now();
  }

  // ------------------------------------------------------------------------- credentials
  isConfigured(): boolean {
    return !!this.db
      .select({ id: authCredentials.id })
      .from(authCredentials)
      .where(eq(authCredentials.id, "owner"))
      .get();
  }

  checkStrength(passphrase: string) {
    if (passphrase.length < MIN_PASSPHRASE_LENGTH)
      throw new ApiError(
        400,
        "VALIDATION",
        `the passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters`,
      );
    if (passphrase.length > MAX_PASSPHRASE_LENGTH)
      throw new ApiError(400, "VALIDATION", "the passphrase is too long");
  }

  /** Whether first-run setup must present GLIDEWORTH_SETUP_TOKEN. */
  setupTokenRequired(): boolean {
    return !!this.opts.setupToken;
  }

  /**
   * First-run: set the passphrase. 409 once one exists (use change-passphrase). A wrong setup token
   * counts as a failed attempt against the same per-client and global throttle as logins, so the token
   * cannot be guessed online.
   */
  async setup(passphrase: string, setupToken: string | undefined, client = "setup"): Promise<void> {
    if (this.isConfigured())
      throw new ApiError(409, "ALREADY_CONFIGURED", "a passphrase is already set; log in instead");
    if (this.opts.setupToken) {
      this.assertNotThrottled(client);
      const given = Buffer.from(sha256(setupToken ?? ""), "hex");
      const want = Buffer.from(sha256(this.opts.setupToken), "hex");
      if (!timingSafeEqual(given, want)) {
        this.recordFailure(client);
        throw new ApiError(
          403,
          "FORBIDDEN",
          "a valid setupToken (GLIDEWORTH_SETUP_TOKEN) is required for first-run setup",
        );
      }
    }
    this.checkStrength(passphrase);
    const hash = await hashPassphrase(passphrase);
    // onConflictDoNothing: two simultaneous setups cannot both win.
    const res = this.db
      .insert(authCredentials)
      .values({ id: "owner", hash })
      .onConflictDoNothing()
      .run();
    if (res.changes !== 1)
      throw new ApiError(409, "ALREADY_CONFIGURED", "a passphrase is already set; log in instead");
  }

  /** Change a user's own passphrase. Their other sessions are signed out. */
  async changePassphrase(
    userId: string,
    current: string,
    next: string,
    client = "change-passphrase",
  ): Promise<void> {
    await this.guardedVerify(userId, current, `change:${client}`);
    this.checkStrength(next);
    await this.setPassphrase(userId, next);
  }

  /** Store a new passphrase for a user and sign them out everywhere (whoever held the old one loses access). */
  async setPassphrase(userId: string, passphrase: string): Promise<void> {
    this.checkStrength(passphrase);
    const hash = await hashPassphrase(passphrase);
    if (userId === "owner")
      this.db
        .update(authCredentials)
        .set({ hash, updatedAt: nowIso() })
        .where(eq(authCredentials.id, "owner"))
        .run();
    else this.db.update(users).set({ hash }).where(eq(users.id, userId)).run();
    this.logoutUser(userId);
  }

  /** The stored hash for a user, or null when they have no passphrase yet (invited) or do not exist. */
  private hashFor(userId: string): string | null {
    if (userId === "owner")
      return (
        this.db.select().from(authCredentials).where(eq(authCredentials.id, "owner")).get()?.hash ??
        null
      );
    return this.db.select().from(users).where(eq(users.id, userId)).get()?.hash ?? null;
  }

  /** Verify a user's passphrase; unknown, disabled and not-yet-accepted users cost the same hash work. */
  private async verify(userId: string, passphrase: string): Promise<void> {
    const user = this.db.select().from(users).where(eq(users.id, userId)).get();
    const stored = user && !user.disabledAt ? this.hashFor(userId) : null;
    if (!stored) {
      if (userId === "owner" && !this.isConfigured())
        throw new ApiError(409, "SETUP_REQUIRED", "no passphrase is set yet; run first-run setup");
      await verifyPassphrase(passphrase, DUMMY_HASH);
      throw new ApiError(401, "UNAUTHORIZED", "wrong passphrase");
    }
    if (!(await verifyPassphrase(passphrase, stored)))
      throw new ApiError(401, "UNAUTHORIZED", "wrong passphrase");
  }

  /** Resolve a sign-in name to a user id (`owner` when omitted). Unknown names resolve to a missing id. */
  userIdForLogin(login: string | undefined): string {
    const name = (login ?? "owner").trim().toLowerCase();
    return this.db.select().from(users).where(eq(users.login, name)).get()?.id ?? `unknown:${name}`;
  }

  // ------------------------------------------------------------------------- throttling
  private recordFailure(client: string): void {
    const mine = this.failures.get(client) ?? [];
    this.failures.delete(client); // re-insert: Map order is then "least recently failed first"
    this.failures.set(client, [...mine, this.now]);
    this.globalFailures.push(this.now);
    if (this.failures.size > this.opts.maxThrottledClients) this.pruneClients();
  }

  /**
   * Keep the per-client map bounded (a flood of distinct addresses must not grow memory without limit): drop
   * clients with no failure inside the window, then the least recently failed. Dropping a client can only let
   * it through early; the global limit still applies to everyone.
   */
  private pruneClients(): void {
    const cutoff = this.now - this.opts.loginWindowMs;
    for (const [k, v] of this.failures) if (!v.some((t) => t > cutoff)) this.failures.delete(k);
    for (const k of this.failures.keys()) {
      if (this.failures.size <= this.opts.maxThrottledClients) break;
      this.failures.delete(k);
    }
  }

  /** Clients currently tracked by the login throttle (tests). */
  get throttledClients(): number {
    return this.failures.size;
  }

  /**
   * Verify under the throttle. The attempt is counted BEFORE the (slow, async) hash check and refunded on
   * success, so a burst of parallel guesses cannot all slip past the limit while the first is still hashing.
   */
  private async guardedVerify(userId: string, passphrase: string, client: string): Promise<void> {
    this.assertNotThrottled(client);
    this.recordFailure(client);
    await this.verify(userId, passphrase);
    this.failures.delete(client);
    this.globalFailures.pop();
  }

  private prune(list: number[]): number[] {
    const cutoff = this.now - this.opts.loginWindowMs;
    return list.filter((t) => t > cutoff);
  }

  private assertNotThrottled(client: string): void {
    const mine = this.prune(this.failures.get(client) ?? []);
    this.failures.set(client, mine);
    this.globalFailures = this.prune(this.globalFailures);
    const blockedBy =
      mine.length >= this.opts.maxFailedLogins
        ? mine
        : this.globalFailures.length >= this.opts.maxFailedLoginsGlobal
          ? this.globalFailures
          : null;
    if (blockedBy) {
      const retry = Math.max(
        1,
        Math.ceil(((blockedBy[0] ?? this.now) + this.opts.loginWindowMs - this.now) / 1000),
      );
      throw new ApiError(429, "RATE_LIMITED", "too many failed login attempts; try again later", {
        retryAfterSeconds: retry,
      });
    }
  }

  // ------------------------------------------------------------------------- sessions
  /** Verify the passphrase and open a session. `client` identifies the caller for throttling. */
  async login(
    passphrase: string,
    client: string,
    userAgent?: string,
    login?: string,
  ): Promise<IssuedSession & { userId: string }> {
    const userId = this.userIdForLogin(login);
    await this.guardedVerify(userId, passphrase, client);
    return { ...this.issue(userId, userAgent), userId };
  }

  /**
   * Open a session for a user. Login, first-run setup, invite/reset acceptance and a passphrase change all
   * sign the user in through here, so this is where `lastLoginAt` is recorded.
   */
  issue(userId: string, userAgent?: string): IssuedSession {
    this.purgeExpired();
    this.db
      .update(users)
      .set({ lastLoginAt: new Date(this.now).toISOString() })
      .where(eq(users.id, userId))
      .run();
    const token = randomBytes(32).toString("base64url");
    const csrf = randomBytes(24).toString("base64url");
    const expiresAt = new Date(this.now + this.opts.sessionTtlMs);
    this.db
      .insert(authSessions)
      .values({
        id: tokenId(token),
        userId,
        csrf,
        userAgent: userAgent?.slice(0, 200) ?? null,
        createdAt: new Date(this.now).toISOString(),
        lastSeenAt: new Date(this.now).toISOString(),
        expiresAt: expiresAt.toISOString(),
      })
      .run();
    return { token, csrf, expiresAt, maxAgeSeconds: Math.floor(this.opts.sessionTtlMs / 1000) };
  }

  /** The live session for a cookie value, or null (unknown, expired or idle). Touches `lastSeenAt`. */
  resolve(token: string | undefined): SessionInfo | null {
    if (!token) return null;
    const id = tokenId(token);
    const row = this.db.select().from(authSessions).where(eq(authSessions.id, id)).get();
    if (!row) return null;
    const idleLimit = new Date(this.now - this.opts.sessionIdleMs).toISOString();
    if (row.expiresAt <= new Date(this.now).toISOString() || row.lastSeenAt < idleLimit) {
      this.db.delete(authSessions).where(eq(authSessions.id, id)).run();
      return null;
    }
    // Writing on every request is wasteful: refresh at most once a minute.
    if (this.now - Date.parse(row.lastSeenAt) > 60_000)
      this.db
        .update(authSessions)
        .set({ lastSeenAt: new Date(this.now).toISOString() })
        .where(eq(authSessions.id, id))
        .run();
    return { id, userId: row.userId, csrf: row.csrf, expiresAt: row.expiresAt };
  }

  logout(token: string | undefined): void {
    if (token)
      this.db
        .delete(authSessions)
        .where(eq(authSessions.id, tokenId(token)))
        .run();
  }

  /** Sign out everywhere. */
  logoutAll(): number {
    return this.db.delete(authSessions).run().changes;
  }

  /** Sign one user out everywhere. */
  logoutUser(userId: string): number {
    return this.db.delete(authSessions).where(eq(authSessions.userId, userId)).run().changes;
  }

  /** A user's open sessions (no secrets). */
  sessionsOf(userId: string): {
    id: string;
    userAgent: string | null;
    createdAt: string;
    lastSeenAt: string;
    expiresAt: string;
  }[] {
    return this.db
      .select()
      .from(authSessions)
      .where(and(eq(authSessions.userId, userId)))
      .all()
      .map((r) => ({
        id: r.id.slice(0, 12),
        userAgent: r.userAgent,
        createdAt: r.createdAt,
        lastSeenAt: r.lastSeenAt,
        expiresAt: r.expiresAt,
      }));
  }

  private purgeExpired(): void {
    const now = new Date(this.now).toISOString();
    const idle = new Date(this.now - this.opts.sessionIdleMs).toISOString();
    this.db
      .delete(authSessions)
      .where(or(lt(authSessions.expiresAt, now), lt(authSessions.lastSeenAt, idle)))
      .run();
  }
}
