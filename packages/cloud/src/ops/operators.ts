/**
 * Operator accounts (spec 6.3): created only from the CLI, password plus mandatory TOTP (the secret is generated
 * at creation, so an operator without a second factor cannot exist), sessions 8 hours absolute and 30 minutes
 * idle, stored as hashes. Sign-in failures are one uniform answer and are throttled per address and per
 * operator email.
 */
import { randomBytes } from "node:crypto";
import { and, eq, isNull, lt, or } from "drizzle-orm";
import type { RateLimiter } from "../abuse/rate-limiter.js";
import { normalizeEmail } from "../accounts/email.js";
import type { ControlAudit } from "../audit.js";
import type { ControlDb } from "../control/db.js";
import { operatorSessions, operators } from "../control/schema.js";
import type { Keyring } from "../crypto/keyring.js";
import { newId, randomToken, safeEqual, sha256Hex, TOKEN_RE } from "../crypto/random.js";
import { newTotpSecret, otpauthUri, verifyTotp } from "../crypto/totp.js";
import { CloudError } from "../errors.js";
import { assertPasswordPolicy, DUMMY_HASH, hashPassword, verifyPassword } from "../password.js";

export const OPERATOR_SESSION = {
  absoluteMs: 8 * 3600_000,
  idleMs: 30 * 60_000,
  touchMs: 60_000,
} as const;
const TOTP_PURPOSE = "operator-totp";

export interface OperatorContext {
  sessionId: string;
  operatorId: string;
  email: string;
  role: "support" | "admin";
  csrf: string;
}

const failed = () => new CloudError(401, "UNAUTHORIZED", "sign-in failed");

export class OperatorService {
  private readonly clock: () => Date;

  constructor(
    private readonly d: {
      db: ControlDb;
      keys: Keyring;
      limiter: RateLimiter;
      audit: ControlAudit;
      now?: () => Date;
    },
  ) {
    this.clock = d.now ?? (() => new Date());
  }

  /** CLI only. Returns the TOTP secret and URI once; nothing else ever shows them. */
  async create(i: {
    email: string;
    name: string;
    role: "support" | "admin";
    password: string;
  }): Promise<{
    id: string;
    totpSecret: string;
    otpauthUri: string;
  }> {
    const email = normalizeEmail(i.email);
    if (!email) throw new CloudError(400, "VALIDATION", "a valid email address is required");
    if (i.role !== "support" && i.role !== "admin")
      throw new CloudError(400, "VALIDATION", "role must be support or admin");
    const name = String(i.name ?? "")
      .trim()
      .slice(0, 100);
    if (!name) throw new CloudError(400, "VALIDATION", "name is required");
    assertPasswordPolicy({ password: i.password, email });
    const secret = newTotpSecret();
    const id = newId("op");
    const passwordHash = await hashPassword(i.password);
    try {
      this.d.db
        .insert(operators)
        .values({
          id,
          email,
          name,
          passwordHash,
          totpSecretEnc: this.d.keys.seal(TOTP_PURPOSE, Buffer.from(secret, "utf8")),
          role: i.role,
          createdAt: this.clock().toISOString(),
        })
        .run();
    } catch {
      throw new CloudError(409, "CONFLICT", "an operator with that email exists");
    }
    this.d.audit.record({
      actorType: "system",
      actorId: null,
      event: "operator.action",
      detail: { action: "operator_created" },
    });
    return { id, totpSecret: secret, otpauthUri: otpauthUri(secret, `operator ${email}`) };
  }

  /**
   * CLI only, for an operator who lost their authenticator: a new TOTP secret for an existing, enabled
   * operator, sealed as `create` seals it. The old secret stops working at once and every session of that
   * operator ends. Returns the secret and URI once, like `create`.
   */
  resetTotp(email: string): { id: string; totpSecret: string; otpauthUri: string } {
    const norm = normalizeEmail(email);
    if (!norm) throw new CloudError(400, "VALIDATION", "a valid email address is required");
    const op = this.d.db.select().from(operators).where(eq(operators.email, norm)).get();
    if (!op) throw new CloudError(404, "NOT_FOUND", "no operator with that email");
    if (op.disabledAt) throw new CloudError(409, "CONFLICT", "that operator is disabled");
    const secret = newTotpSecret();
    const ended = this.d.db.transaction((tx) => {
      tx.update(operators)
        .set({
          totpSecretEnc: this.d.keys.seal(TOTP_PURPOSE, Buffer.from(secret, "utf8")),
          totpLastStep: null,
        })
        .where(eq(operators.id, op.id))
        .run();
      return tx.delete(operatorSessions).where(eq(operatorSessions.operatorId, op.id)).run()
        .changes;
    });
    this.d.audit.record({
      actorType: "system",
      actorId: null,
      event: "operator.action",
      detail: { action: "operator_totp_reset", objectId: op.id, count: ended },
    });
    return { id: op.id, totpSecret: secret, otpauthUri: otpauthUri(secret, `operator ${norm}`) };
  }

  disable(email: string): boolean {
    const norm = normalizeEmail(email);
    if (!norm) return false;
    const op = this.d.db.select().from(operators).where(eq(operators.email, norm)).get();
    if (!op) return false;
    this.d.db.transaction((tx) => {
      tx.update(operators)
        .set({ disabledAt: this.clock().toISOString() })
        .where(eq(operators.id, op.id))
        .run();
      tx.delete(operatorSessions).where(eq(operatorSessions.operatorId, op.id)).run();
    });
    return true;
  }

  /** Password and a current TOTP code, both always checked (same work and answer for an unknown address). */
  async signIn(
    i: { email: string; password: string; code: string },
    ip: string,
  ): Promise<{ token: string; csrf: string; maxAgeSeconds: number }> {
    const norm = normalizeEmail(typeof i.email === "string" ? i.email : "") ?? "invalid";
    const byIp = this.d.limiter.hit(`ops:signin:ip:${ip}`, 10, 15 * 60_000);
    const byEmail = this.d.limiter.hit(
      `ops:signin:e:${this.d.keys.hmac("ratelimit", norm).slice(0, 32)}`,
      10,
      15 * 60_000,
    );
    if (!byIp.allowed || !byEmail.allowed)
      throw new CloudError(429, "RATE_LIMITED", "too many attempts; try again later", {
        retryAfterSeconds: 900,
      });
    const op = this.d.db.select().from(operators).where(eq(operators.email, norm)).get();
    const passwordOk = await verifyPassword(
      String(i.password ?? ""),
      op?.passwordHash ?? DUMMY_HASH,
    );
    const now = this.clock();
    let step: number | null = null;
    if (op?.totpSecretEnc) {
      const secret = Buffer.from(this.d.keys.open(TOTP_PURPOSE, op.totpSecretEnc)).toString("utf8");
      step = verifyTotp(secret, String(i.code ?? ""), now.getTime(), op.totpLastStep ?? null);
    }
    if (!op || op.disabledAt || !passwordOk || step === null) {
      this.d.audit.record({
        actorType: "operator",
        actorId: op?.id ?? null,
        event: "operator.signin_failed",
        ip,
      });
      throw failed();
    }
    // Replay protection: the step only moves forward.
    const claimed = this.d.db
      .update(operators)
      .set({ totpLastStep: step, lastSigninAt: now.toISOString() })
      .where(
        and(
          eq(operators.id, op.id),
          or(isNull(operators.totpLastStep), lt(operators.totpLastStep, step)),
        ),
      )
      .run();
    if (claimed.changes !== 1) throw failed();
    const token = randomToken();
    const csrf = randomBytes(24).toString("base64url");
    this.d.db
      .insert(operatorSessions)
      .values({
        id: sha256Hex(token),
        operatorId: op.id,
        csrf,
        ip: ip.slice(0, 64),
        createdAt: now.toISOString(),
        lastSeenAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + OPERATOR_SESSION.absoluteMs).toISOString(),
      })
      .run();
    this.d.audit.record({ actorType: "operator", actorId: op.id, event: "operator.signin", ip });
    return { token, csrf, maxAgeSeconds: OPERATOR_SESSION.absoluteMs / 1000 };
  }

  resolve(token: string | undefined): OperatorContext | null {
    if (typeof token !== "string" || !TOKEN_RE.test(token)) return null;
    const id = sha256Hex(token);
    const row = this.d.db
      .select({ s: operatorSessions, o: operators })
      .from(operatorSessions)
      .innerJoin(operators, eq(operators.id, operatorSessions.operatorId))
      .where(eq(operatorSessions.id, id))
      .get();
    if (!row || !safeEqual(row.s.id, id) || row.o.disabledAt || !row.o.totpSecretEnc) return null;
    const now = this.clock();
    if (
      row.s.expiresAt <= now.toISOString() ||
      now.getTime() - Date.parse(row.s.lastSeenAt) > OPERATOR_SESSION.idleMs
    ) {
      this.d.db.delete(operatorSessions).where(eq(operatorSessions.id, id)).run();
      return null;
    }
    if (now.getTime() - Date.parse(row.s.lastSeenAt) > OPERATOR_SESSION.touchMs)
      this.d.db
        .update(operatorSessions)
        .set({ lastSeenAt: now.toISOString() })
        .where(eq(operatorSessions.id, id))
        .run();
    return {
      sessionId: id,
      operatorId: row.o.id,
      email: row.o.email,
      role: row.o.role,
      csrf: row.s.csrf,
    };
  }

  signOut(token: string | undefined): void {
    if (typeof token !== "string" || !TOKEN_RE.test(token)) return;
    this.d.db
      .delete(operatorSessions)
      .where(eq(operatorSessions.id, sha256Hex(token)))
      .run();
  }

  /** Drop expired sessions (sweeper). */
  maintenance(): number {
    const now = this.clock();
    return this.d.db
      .delete(operatorSessions)
      .where(lt(operatorSessions.expiresAt, now.toISOString()))
      .run().changes;
  }
}
