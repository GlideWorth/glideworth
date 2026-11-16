/**
 * Control-plane audit trail (spec 6.2): account-security events in `audit_events`.
 *
 * What may be stored is fixed here, not by callers: the event name must be one of `CONTROL_AUDIT_EVENTS`;
 * `detail` keeps only `AUDIT_DETAIL_KEYS` with scalar values, and string values are short enumerations or ids
 * (no spaces, no `@`, at most 64 characters). A caller therefore cannot put a password, token, email address
 * or free text into the trail by mistake. IP and user agent are nulled after 90 days (`scrub`).
 */
import { and, isNotNull, lt, or } from "drizzle-orm";
import type { ControlDb } from "./control/db.js";
import { auditEvents } from "./control/schema.js";
import { type Logger, silentLogger } from "./log/index.js";

export type AccountId = string;
export type UserId = string;

export interface ControlAudit {
  record(e: {
    actorType: "user" | "operator" | "system" | "stripe";
    actorId: string | null;
    accountId?: AccountId | null;
    subjectUserId?: UserId | null;
    event: string;
    ip?: string | null;
    userAgent?: string | null;
    detail?: Record<string, string | number | boolean | null>;
  }): void;
}

export const CONTROL_AUDIT_EVENTS = [
  "user.signup",
  "user.email_verified",
  "user.signin",
  "user.signin_failed",
  "user.signin_new_device",
  "user.signout",
  "user.session_revoked",
  "user.password_changed",
  "user.password_reset",
  "user.email_changed",
  "user.totp_enabled",
  "user.totp_disabled",
  "user.recovery_codes_regenerated",
  "user.recovery_codes_used",
  "user.reauthenticated",
  "user.deleted",
  /** Not in spec 6.2: a federated sign-in identity ("Sign in with Google") linked or unlinked. */
  "identity.linked",
  "identity.unlinked",
  "workspace.created",
  "workspace.renamed",
  "workspace.deletion_started",
  "workspace.deleted",
  "workspace.restored",
  "workspace.exported",
  "workspace.suspended",
  "workspace.unsuspended",
  "workspace.mcp_writes_changed",
  /** Not in spec 6.2: a retention warning (terms: unpaid or cancelled workspaces deleted after 12 months). */
  "workspace.retention_warning",
  "member.invited",
  "member.invitation_revoked",
  "member.invitation_resent",
  "member.joined",
  "member.role_changed",
  "member.removed",
  "member.left",
  /** Not in spec 6.2: a password reset revoked the member's OAuth grants in this workspace (API keys stay). */
  "member.connected_apps_revoked",
  "ownership.transferred",
  "billing.checkout_started",
  "billing.subscription_changed",
  "billing.payment_failed",
  "billing.refund",
  "billing.dispute",
  "billing.duplicate_subscription",
  "billing.checkout_refused",
  "billing.alert",
  "email.suppressed",
  "operator.signin",
  "operator.signin_failed",
  "operator.signout",
  "operator.viewed_account",
  "operator.action",
  "support_grant.created",
  "support_grant.used",
  "support_grant.revoked",
] as const;
export type ControlAuditEvent = (typeof CONTROL_AUDIT_EVENTS)[number];

export const AUDIT_DETAIL_KEYS = [
  "role",
  "from",
  "to",
  "method",
  "mfa",
  "count",
  "revoked",
  "reason",
  "action",
  "invitationId",
  "sessionId",
  "grantId",
  "exportId",
  "days",
  "enabled",
  "status",
  "kind",
  "eventId",
  "newDevice",
  "step",
  "objectId",
  "backupId",
  "page",
  "at",
] as const;

const EVENTS = new Set<string>(CONTROL_AUDIT_EVENTS);
const KEYS = new Set<string>(AUDIT_DETAIL_KEYS);
const SAFE_STRING = /^[A-Za-z0-9_.:-]{1,64}$/;
const RETAIN_NETWORK_MS = 90 * 24 * 3600 * 1000;

function cleanDetail(
  detail: Record<string, string | number | boolean | null> | undefined,
): Record<string, string | number | boolean | null> | null {
  if (!detail) return null;
  const out: Record<string, string | number | boolean | null> = {};
  for (const [k, v] of Object.entries(detail)) {
    if (!KEYS.has(k)) continue;
    if (v === null || typeof v === "boolean") out[k] = v;
    else if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    else if (typeof v === "string" && SAFE_STRING.test(v) && !v.includes("@")) out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

export function controlAudit(
  db: ControlDb,
  o: { now?: () => Date; log?: Logger } = {},
): ControlAudit & { scrub(): number } {
  const clock = o.now ?? (() => new Date());
  const log = o.log ?? silentLogger;
  return {
    record(e) {
      if (!EVENTS.has(e.event)) {
        // Programming error: refuse loudly in development, never write an unknown event name.
        log.error("audit.unknown_event", { kind: e.actorType });
        throw new Error("unknown audit event");
      }
      db.insert(auditEvents)
        .values({
          at: clock().toISOString(),
          actorType: e.actorType,
          actorId: e.actorId,
          accountId: e.accountId ?? null,
          subjectUserId: e.subjectUserId ?? null,
          event: e.event,
          ip: typeof e.ip === "string" ? e.ip.slice(0, 64) : null,
          userAgent: typeof e.userAgent === "string" ? e.userAgent.slice(0, 256) : null,
          detail: cleanDetail(e.detail),
        })
        .run();
    },
    /** Null IP and user agent on rows older than 90 days. Returns the number of rows changed. */
    scrub() {
      const cutoff = new Date(clock().getTime() - RETAIN_NETWORK_MS).toISOString();
      return db
        .update(auditEvents)
        .set({ ip: null, userAgent: null })
        .where(
          and(
            lt(auditEvents.at, cutoff),
            or(isNotNull(auditEvents.ip), isNotNull(auditEvents.userAgent)),
          ),
        )
        .run().changes;
    },
  };
}
