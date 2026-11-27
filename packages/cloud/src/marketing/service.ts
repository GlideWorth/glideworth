/**
 * "Email me this result" on the marketing site's free calculators: one result email on request, and, only for
 * people who tick the reminder box and then click the link in that email, a place on the marketing list (double
 * opt-in). Off unless the operator sets `GLIDEWORTH_CALCULATOR_EMAIL_ORIGIN` (config.ts), and part of cloud mode
 * only: a self-hosted Glideworth never loads it.
 *
 * Abuse (a public form that sends mail to any address it is given):
 *  - nothing the visitor types reaches the mail except the address itself (calculator-email.ts);
 *  - limits per client address, per recipient (keyed by an HMAC of the normalised address, so the limiter never
 *    holds an address) and in total, and a honeypot field;
 *  - the answer is the same whether or not the address is suppressed, subscribed or unknown;
 *  - bounces and complaints suppress the address for this mail too (the mailer checks before sending).
 *
 * What is stored: the outbox row of the result email (address and contents, deleted 30 days after sending, as for
 * every outbox message) and, for a ticked box, the consent record (`marketing_consents`). No IP address, no user
 * agent.
 */
import { and, eq } from "drizzle-orm";
import type { RateLimiter } from "../abuse/rate-limiter.js";
import { normalizeEmail } from "../accounts/email.js";
import { controlEmailStores } from "../control/email-stores.js";
import type { ControlDb } from "../control/db.js";
import type { MailOutbox } from "../control/outbox.js";
import { marketingConsents } from "../control/schema.js";
import type { Keyring } from "../crypto/keyring.js";
import { newId, randomToken, sha256Hex, TOKEN_RE } from "../crypto/random.js";
import { CloudError } from "../errors.js";
import type { UnsubscribeSigner } from "../external-types.js";
import type { Logger } from "../log/index.js";
import type { ProductEvents } from "../log/product-events.js";
import {
  acceptedFigures,
  CONSENT_TEXTS,
  calculatorById,
  describeInputs,
  LIMITS,
  readInputs,
  toQuery,
} from "./calculator-email.js";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/**
 * Per client address and per recipient. A person needs one or two; a mail bomb needs thousands. The total a day
 * is the operator's (`dailyLimit`), because these emails share the provider's quota with account email.
 */
export const CALCULATOR_EMAIL_LIMITS = {
  perIp: [
    { limit: 5, windowMs: 10 * MINUTE },
    { limit: 20, windowMs: DAY },
  ],
  perRecipient: [{ limit: 3, windowMs: DAY }],
} as const;
export const DEFAULT_DAILY_LIMIT = 50;

export interface CalculatorEmailRequest {
  email: string;
  tool: string;
  query: string;
  figureLabels: string[];
  figureValues: string[];
  /** The consent version sent with a ticked box, or null. */
  consentVersion: string | null;
  honeypot: string;
  ip: string;
}

export class CalculatorEmailService {
  private readonly now: () => Date;
  private readonly stores;

  constructor(
    private readonly d: {
      db: ControlDb;
      outbox: MailOutbox;
      limiter: RateLimiter;
      keys: Keyring;
      log: Logger;
      unsubscribe: UnsubscribeSigner;
      /** The marketing site, `https://glideworth.com`: reopen links point here. */
      siteOrigin: string;
      /** The app, where the confirm page lives. */
      publicUrl: string;
      /** Result emails a day in total (default 50). */
      dailyLimit?: number;
      events?: ProductEvents | null;
      /** Sends the outbox now instead of at the next 30-second tick. */
      kick?: () => void;
      now?: () => Date;
    },
  ) {
    this.now = d.now ?? (() => new Date());
    this.stores = controlEmailStores(d.db, { now: this.now });
  }

  private limit(key: string, rules: readonly { limit: number; windowMs: number }[]): void {
    for (const r of rules) {
      const hit = this.d.limiter.hit(`calc-email:${key}:${r.windowMs}`, r.limit, r.windowMs);
      if (!hit.allowed)
        throw new CloudError(429, "RATE_LIMITED", "too many requests; try again later", {
          retryAfterSeconds: Math.max(1, Math.ceil(hit.retryAfterMs / 1000)),
        });
    }
  }

  /** Validates, limits and queues the result email; records a pending consent when the box was ticked. */
  request(r: CalculatorEmailRequest): void {
    if (r.honeypot) throw new CloudError(400, "VALIDATION", "invalid request");
    const entry = calculatorById(r.tool);
    if (!entry) throw new CloudError(400, "VALIDATION", "unknown calculator", { fields: ["tool"] });
    const email = r.email.trim();
    const normalized = email.length <= 254 ? normalizeEmail(email) : null;
    if (!normalized)
      throw new CloudError(400, "VALIDATION", "enter a valid email address", { fields: ["email"] });
    if (r.consentVersion !== null && !Object.hasOwn(CONSENT_TEXTS, r.consentVersion))
      throw new CloudError(400, "VALIDATION", "reload the page and try again", {
        fields: ["updates"],
      });
    if (r.query.length > LIMITS.queryLength)
      throw new CloudError(400, "VALIDATION", "invalid request", { fields: ["q"] });

    this.limit(`ip:${r.ip}`, CALCULATOR_EMAIL_LIMITS.perIp);
    this.limit(
      `to:${this.d.keys.hmac("calculator-email-recipient", normalized)}`,
      CALCULATOR_EMAIL_LIMITS.perRecipient,
    );
    this.limit("total", [{ limit: this.d.dailyLimit ?? DEFAULT_DAILY_LIMIT, windowMs: DAY }]);

    const values = readInputs(entry, r.query);
    const query = toQuery(entry, values);
    const at = this.now();
    let confirmUrl: string | null = null;
    let alreadySubscribed = false;
    let consentId: string | null = null;
    if (r.consentVersion !== null) {
      const c = this.recordConsent(email, normalized, r.tool, values, r.consentVersion, at);
      confirmUrl = c.confirmUrl;
      alreadySubscribed = c.alreadySubscribed;
      consentId = c.id;
    }

    this.d.outbox.enqueue({
      to: { email },
      template: "calculator-result",
      data: {
        toolName: entry.name,
        inputs: describeInputs(entry, values),
        figures: acceptedFigures(entry, r.figureLabels, r.figureValues),
        reopenUrl: `${this.d.siteOrigin}${entry.path}?${query}`,
        demoUrl: `${this.d.publicUrl}/demo`,
        trialUrl: `${this.d.publicUrl}/signup`,
        confirmUrl,
        confirmExpiresInDays: LIMITS.confirmDays,
        alreadySubscribed,
      },
    });
    this.d.kick?.();
    this.d.events?.capture(consentId ?? newId("cer"), {
      event: "calculator_email_requested",
      properties: {
        tool: r.tool,
        updates_opt_in: r.consentVersion !== null,
        $process_person_profile: false,
      },
    });
    this.d.log.info("calculator_email.requested", {
      kind: r.tool,
      outcome: r.consentVersion !== null ? "with_opt_in" : "result_only",
    });
  }

  /**
   * One row per address. New, pending or unsubscribed: (back to) pending with a fresh link, the new wording and
   * inputs. Confirmed: unchanged (anyone can type an address, so a request never edits a confirmed record).
   */
  private recordConsent(
    email: string,
    normalized: string,
    tool: string,
    inputs: Record<string, number | string>,
    version: string,
    at: Date,
  ): { id: string; confirmUrl: string | null; alreadySubscribed: boolean } {
    const existing = this.d.db
      .select()
      .from(marketingConsents)
      .where(eq(marketingConsents.emailNormalized, normalized))
      .get();
    if (existing?.status === "confirmed")
      return { id: existing.id, confirmUrl: null, alreadySubscribed: true };
    const token = randomToken();
    const fields = {
      email,
      status: "pending" as const,
      consentVersion: version,
      consentText: CONSENT_TEXTS[version] as string,
      source: `calculator:${tool}`,
      tool,
      inputs,
      requestedAt: at.toISOString(),
      confirmTokenHash: sha256Hex(token),
      confirmExpiresAt: new Date(at.getTime() + LIMITS.confirmDays * DAY).toISOString(),
      confirmedAt: null,
      unsubscribedAt: null,
      updatedAt: at.toISOString(),
    };
    const id = existing?.id ?? newId("mc");
    if (existing)
      this.d.db.update(marketingConsents).set(fields).where(eq(marketingConsents.id, id)).run();
    else
      this.d.db
        .insert(marketingConsents)
        .values({ id, emailNormalized: normalized, ...fields })
        .run();
    return {
      id,
      confirmUrl: `${this.d.publicUrl}/email/calculator/confirm?t=${token}`,
      alreadySubscribed: false,
    };
  }

  /** The pending record a link points at, if the link is well formed, known and in time. */
  private pendingFor(token: string) {
    if (typeof token !== "string" || !TOKEN_RE.test(token)) return null;
    const row = this.d.db
      .select()
      .from(marketingConsents)
      .where(
        and(
          eq(marketingConsents.confirmTokenHash, sha256Hex(token)),
          eq(marketingConsents.status, "pending"),
        ),
      )
      .get();
    if (!row || !row.confirmExpiresAt || row.confirmExpiresAt <= this.now().toISOString())
      return null;
    return row;
  }

  /** True when the link would confirm (the GET page asks before anything changes). */
  canConfirm(token: string): boolean {
    return this.pendingFor(token) !== null;
  }

  /** Confirms the double opt-in. Returns the one-click unsubscribe URL for the page, or null for a bad link. */
  confirm(token: string): { unsubscribeUrl: string; tool: string } | null {
    const row = this.pendingFor(token);
    if (!row) return null;
    const at = this.now().toISOString();
    const changed = this.d.db
      .update(marketingConsents)
      .set({
        status: "confirmed",
        confirmedAt: at,
        confirmTokenHash: null,
        confirmExpiresAt: null,
        updatedAt: at,
      })
      .where(and(eq(marketingConsents.id, row.id), eq(marketingConsents.status, "pending")))
      .run().changes;
    if (changed !== 1) return null;
    // A new, confirmed consent outranks an earlier unsubscribe from the list (never a bounce or complaint).
    this.stores.suppressions.lift(row.emailNormalized, "marketing", "unsubscribe");
    this.d.events?.capture(row.id, {
      event: "calculator_email_confirmed",
      properties: { tool: row.tool, $process_person_profile: false },
    });
    this.d.log.info("calculator_email.confirmed", { kind: row.tool });
    return {
      unsubscribeUrl: this.d.unsubscribe.url(row.emailNormalized, "marketing"),
      tool: row.tool,
    };
  }
}

/**
 * The list unsubscribe (`POST /email/unsubscribe` with a `marketing` token; the suppression itself is recorded by
 * the route). Works whether or not the calculator form is switched on, so old links keep working. The calculator
 * inputs go at once; the record of the consent and its withdrawal stays for 12 months (retention.ts).
 */
export function recordListUnsubscribe(
  db: ControlDb,
  emailNormalized: string,
  at: Date,
  events?: ProductEvents | null,
): void {
  const row = db
    .select({ id: marketingConsents.id, status: marketingConsents.status })
    .from(marketingConsents)
    .where(eq(marketingConsents.emailNormalized, emailNormalized))
    .get();
  if (!row || row.status === "unsubscribed") return;
  db.update(marketingConsents)
    .set({
      status: "unsubscribed",
      unsubscribedAt: at.toISOString(),
      inputs: {},
      confirmTokenHash: null,
      confirmExpiresAt: null,
      updatedAt: at.toISOString(),
    })
    .where(eq(marketingConsents.id, row.id))
    .run();
  events?.capture(row.id, {
    event: "calculator_email_unsubscribed",
    properties: { $process_person_profile: false },
  });
}
