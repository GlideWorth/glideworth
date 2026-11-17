/**
 * Control-plane schema (spec 2.2). One SQLite database for the whole cell: people, workspaces (tenants),
 * memberships, billing state, audit, quotas, backups metadata, operators. Nothing in here is household data.
 *
 * Conventions as in the tenant schema: ISO-8601 text times, booleans as integers, JSON as text.
 * "hash" columns hold SHA-256 hex of a secret; "hmac" columns HMAC-SHA256 under a purpose key derived from
 * GLIDEWORTH_SECRETS_KEY; "enc" columns a value sealed with AES-256-GCM (see crypto/keyring.ts).
 *
 * Changing this file: run `pnpm --filter @glideworth/cloud db:generate` and commit the new migration.
 */
import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

const now = sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;

// ------------------------------------------------------------------------------------------- people
export const users = sqliteTable(
  "users",
  {
    /** `u_` + 20 base32 characters. */
    id: text("id").primaryKey(),
    /** As typed at sign-up (trimmed). Mail goes here. */
    email: text("email").notNull(),
    /** trim + NFKC + lowercase, IDNA domain (accounts/email.ts). The uniqueness key. */
    emailNormalized: text("email_normalized").notNull(),
    name: text("name").notNull(),
    /**
     * `scrypt$…` (password.ts), or the empty string for an account that has no password yet (created through
     * "Sign in with Google"). `verifyPassword` rejects the empty string without hashing, so it never matches;
     * callers use `hasPassword` (accounts/service.ts) and spend dummy scrypt work for such accounts.
     * Kept NOT NULL on purpose: making the column nullable would need a table rebuild of `users`, which with
     * foreign keys on would cascade-delete every child row.
     */
    passwordHash: text("password_hash").notNull(),
    emailVerifiedAt: text("email_verified_at"),
    totpSecretEnc: text("totp_secret_enc"),
    totpEnabledAt: text("totp_enabled_at"),
    /** Highest TOTP step accepted; a code at or below it is a replay. */
    totpLastStep: integer("totp_last_step"),
    signinAlerts: integer("signin_alerts", { mode: "boolean" }).notNull().default(true),
    checkinEmails: integer("checkin_emails", { mode: "boolean" }).notNull().default(true),
    termsVersion: text("terms_version").notNull(),
    /**
     * Not in spec 2.2 (terms: adults only): when the person confirmed at sign-up that they are 18 or over. A
     * boolean confirmation and its time, never a date of birth. Null only for rows created before it existed.
     */
    adultConfirmedAt: text("adult_confirmed_at"),
    createdAt: text("created_at").notNull().default(now),
    updatedAt: text("updated_at").notNull().default(now),
    lastSigninAt: text("last_signin_at"),
    disabledAt: text("disabled_at"),
  },
  (t) => [
    uniqueIndex("users_email_normalized_uq").on(t.emailNormalized),
    index("users_unverified_idx").on(t.emailVerifiedAt, t.createdAt),
  ],
);

export const userTokens = sqliteTable(
  "user_tokens",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    purpose: text("purpose", {
      enum: ["verify_email", "reset_password", "email_change", "signin_challenge"],
    }).notNull(),
    tokenHash: text("token_hash").notNull(),
    payload: text("payload", { mode: "json" }).$type<Record<string, unknown>>(),
    expiresAt: text("expires_at").notNull(),
    usedAt: text("used_at"),
    createdAt: text("created_at").notNull().default(now),
  },
  (t) => [
    uniqueIndex("user_tokens_token_hash_uq").on(t.tokenHash),
    index("user_tokens_user_purpose_idx").on(t.userId, t.purpose),
    index("user_tokens_expires_idx").on(t.expiresAt),
  ],
);

export const recoveryCodes = sqliteTable(
  "recovery_codes",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    codeHmac: text("code_hmac").notNull(),
    usedAt: text("used_at"),
    createdAt: text("created_at").notNull().default(now),
  },
  (t) => [uniqueIndex("recovery_codes_user_code_uq").on(t.userId, t.codeHmac)],
);

export const sessions = sqliteTable(
  "sessions",
  {
    /** SHA-256 of the cookie value. The cookie value itself is never stored. */
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    csrf: text("csrf").notNull(),
    activeAccountId: text("active_account_id").references(() => accounts.id, {
      onDelete: "set null",
    }),
    /** The session was opened with a second factor. */
    mfa: integer("mfa", { mode: "boolean" }).notNull().default(false),
    reauthAt: text("reauth_at"),
    userAgent: text("user_agent"),
    ip: text("ip"),
    createdAt: text("created_at").notNull().default(now),
    lastSeenAt: text("last_seen_at").notNull().default(now),
    expiresAt: text("expires_at").notNull(),
  },
  (t) => [index("sessions_user_idx").on(t.userId), index("sessions_expires_idx").on(t.expiresAt)],
);

export const knownDevices = sqliteTable(
  "known_devices",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    deviceHmac: text("device_hmac").notNull(),
    firstSeenAt: text("first_seen_at").notNull().default(now),
    lastSeenAt: text("last_seen_at").notNull().default(now),
  },
  (t) => [primaryKey({ columns: [t.userId, t.deviceHmac] })],
);

/**
 * Not in spec 2.2: federated sign-in identities ("Sign in with Google"). A person is found by the provider's
 * stable subject (`sub`), never by email address. One identity per provider per user. `email_at_link` is the
 * address the provider asserted when the identity was linked (shown in settings and the personal-data export;
 * never used to find anyone). No provider token is ever stored.
 */
export const userIdentities = sqliteTable(
  "user_identities",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider", { enum: ["google"] }).notNull(),
    subject: text("subject").notNull(),
    emailAtLink: text("email_at_link"),
    createdAt: text("created_at").notNull().default(now),
    lastUsedAt: text("last_used_at"),
  },
  (t) => [
    uniqueIndex("user_identities_provider_subject_uq").on(t.provider, t.subject),
    uniqueIndex("user_identities_user_provider_uq").on(t.userId, t.provider),
  ],
);

/**
 * Not in spec 2.2: OpenID Connect sign-in state, server side. `authorize` rows hold the PKCE verifier, nonce,
 * `next` and intent of one authorization request (id = SHA-256 of `state`); `pending_signup` rows hold the
 * claims of a new Google user until they confirm the sign-up step (id = SHA-256 of the pending cookie).
 * `browser_hash` is SHA-256 of the `__Host-gw_oidc` cookie the flow is bound to. `payload_enc` is sealed
 * (keyring purpose `oidc-flow`). Rows are single use (`used_at`) and live 10 minutes (`pending_signup`: 15).
 */
export const oidcFlows = sqliteTable(
  "oidc_flows",
  {
    id: text("id").primaryKey(),
    kind: text("kind", { enum: ["authorize", "pending_signup", "pending_link"] }).notNull(),
    provider: text("provider", { enum: ["google"] }).notNull(),
    browserHash: text("browser_hash").notNull(),
    /** Linking only (`authorize`, `pending_link`): the signed-in user and session that started the flow. */
    userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
    sessionId: text("session_id"),
    payloadEnc: text("payload_enc").notNull(),
    createdAt: text("created_at").notNull().default(now),
    expiresAt: text("expires_at").notNull(),
    usedAt: text("used_at"),
  },
  (t) => [index("oidc_flows_expires_idx").on(t.expiresAt)],
);

// --------------------------------------------------------------------------------------- workspaces
export const accounts = sqliteTable(
  "accounts",
  {
    /** `t` + 15 lowercase base32 characters; checked against the regex before any path join. */
    id: text("id").primaryKey(),
    /** Null on `deleted` tombstones. */
    name: text("name"),
    ownerUserId: text("owner_user_id").references(() => users.id, { onDelete: "set null" }),
    status: text("status", {
      enum: ["active", "suspended", "deleting", "deleted", "migration_failed"],
    })
      .notNull()
      .default("active"),
    mcpWrites: integer("mcp_writes", { mode: "boolean" }).notNull().default(false),
    schemaVersion: integer("schema_version"),
    dbBytes: integer("db_bytes").notNull().default(0),
    createdAt: text("created_at").notNull().default(now),
    lastActiveAt: text("last_active_at"),
    deletedAt: text("deleted_at"),
  },
  (t) => [index("accounts_owner_idx").on(t.ownerUserId), index("accounts_status_idx").on(t.status)],
);

export const memberships = sqliteTable(
  "memberships",
  {
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["owner", "editor", "viewer"] }).notNull(),
    /** The person's id inside the tenant database: `owner` for the owner, `usr_…` for everyone else. */
    tenantUserId: text("tenant_user_id").notNull(),
    createdAt: text("created_at").notNull().default(now),
    createdBy: text("created_by"),
    /**
     * Set by a password reset: this member's OAuth grants in the tenant database are still to be revoked. The
     * registry revokes them before it hands out the next lease and clears this (tenancy/registry.ts).
     */
    oauthRevokePendingAt: text("oauth_revoke_pending_at"),
  },
  (t) => [
    primaryKey({ columns: [t.accountId, t.userId] }),
    uniqueIndex("memberships_account_tenant_user_uq").on(t.accountId, t.tenantUserId),
    index("memberships_user_idx").on(t.userId),
  ],
);

export const invitations = sqliteTable(
  "invitations",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    emailNormalized: text("email_normalized").notNull(),
    role: text("role", { enum: ["editor", "viewer"] }).notNull(),
    tokenHash: text("token_hash").notNull(),
    invitedBy: text("invited_by"),
    expiresAt: text("expires_at").notNull(),
    acceptedAt: text("accepted_at"),
    revokedAt: text("revoked_at"),
    createdAt: text("created_at").notNull().default(now),
  },
  (t) => [
    uniqueIndex("invitations_token_hash_uq").on(t.tokenHash),
    index("invitations_account_idx").on(t.accountId),
    index("invitations_email_idx").on(t.emailNormalized),
  ],
);

// ------------------------------------------------------------------------------------------ billing
export const subscriptions = sqliteTable(
  "subscriptions",
  {
    accountId: text("account_id")
      .primaryKey()
      .references(() => accounts.id),
    status: text("status", {
      enum: [
        "trialing_local",
        "incomplete",
        "incomplete_expired",
        "trialing",
        "active",
        "past_due",
        "unpaid",
        "canceled",
        "paused",
      ],
    }).notNull(),
    productId: text("product_id").notNull(),
    priceLookupKey: text("price_lookup_key"),
    trialEndsAt: text("trial_ends_at"),
    stripeCustomerId: text("stripe_customer_id"),
    stripeSubscriptionId: text("stripe_subscription_id"),
    currentPeriodEnd: text("current_period_end"),
    cancelAtPeriodEnd: integer("cancel_at_period_end", { mode: "boolean" })
      .notNull()
      .default(false),
    canceledAt: text("canceled_at"),
    pastDueSince: text("past_due_since"),
    compedUntil: text("comped_until"),
    /** `event.created` of the last applied Stripe state; never goes backwards. */
    stripeUpdated: integer("stripe_updated"),
    updatedAt: text("updated_at").notNull().default(now),
    /** Not in spec 2.2: incremented on every write; the compare-and-swap of a locked webhook writer. */
    version: integer("version").notNull().default(0),
  },
  (t) => [
    uniqueIndex("subscriptions_stripe_customer_uq").on(t.stripeCustomerId),
    uniqueIndex("subscriptions_stripe_subscription_uq").on(t.stripeSubscriptionId),
    index("subscriptions_trial_idx").on(t.status, t.trialEndsAt),
  ],
);

/** One trial per address, ever (kept 24 months). Only the HMAC of the normalised address is stored. */
export const trialGrants = sqliteTable("trial_grants", {
  emailHmac: text("email_hmac").primaryKey(),
  grantedAt: text("granted_at").notNull().default(now),
});

export const billingNotices = sqliteTable(
  "billing_notices",
  {
    accountId: text("account_id").notNull(),
    kind: text("kind").notNull(),
    dedupeKey: text("dedupe_key").notNull(),
    sentAt: text("sent_at").notNull().default(now),
  },
  (t) => [primaryKey({ columns: [t.accountId, t.kind, t.dedupeKey] })],
);

export const stripeEvents = sqliteTable(
  "stripe_events",
  {
    /** `evt_…` */
    id: text("id").primaryKey(),
    type: text("type").notNull(),
    created: integer("created").notNull(),
    livemode: integer("livemode", { mode: "boolean" }).notNull(),
    accountId: text("account_id"),
    receivedAt: text("received_at").notNull().default(now),
    processedAt: text("processed_at"),
    status: text("status", { enum: ["received", "processed", "ignored", "failed", "orphaned"] })
      .notNull()
      .default("received"),
    attempts: integer("attempts").notNull().default(0),
    errorCode: text("error_code"),
  },
  (t) => [
    index("stripe_events_status_idx").on(t.status, t.receivedAt),
    index("stripe_events_received_idx").on(t.receivedAt),
  ],
);

// ---------------------------------------------------------------------------------------- audit, quotas
export const auditEvents = sqliteTable(
  "audit_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    at: text("at").notNull().default(now),
    actorType: text("actor_type", { enum: ["user", "operator", "system", "stripe"] }).notNull(),
    actorId: text("actor_id"),
    accountId: text("account_id"),
    subjectUserId: text("subject_user_id"),
    event: text("event").notNull(),
    /** Nulled after 90 days. */
    ip: text("ip"),
    userAgent: text("user_agent"),
    /** Allowlisted keys only (audit.ts). */
    detail: text("detail", { mode: "json" }).$type<
      Record<string, string | number | boolean | null>
    >(),
  },
  (t) => [
    index("audit_events_at_idx").on(t.at),
    index("audit_events_account_idx").on(t.accountId, t.at),
    index("audit_events_subject_idx").on(t.subjectUserId, t.at),
    index("audit_events_actor_idx").on(t.actorId, t.at),
  ],
);

export const usageCounters = sqliteTable(
  "usage_counters",
  {
    accountId: text("account_id").notNull(),
    metric: text("metric").notNull(),
    /** YYYY-MM-DD, UTC. */
    day: text("day").notNull(),
    value: integer("value").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.accountId, t.metric, t.day] })],
);

export const tenantSchedules = sqliteTable(
  "tenant_schedules",
  {
    accountId: text("account_id")
      .primaryKey()
      .references(() => accounts.id, { onDelete: "cascade" }),
    nextCheckinAt: text("next_checkin_at"),
    lastCheckinAt: text("last_checkin_at"),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
  },
  (t) => [index("tenant_schedules_next_idx").on(t.nextCheckinAt)],
);

// ------------------------------------------------------------------------------------------ backups
export const tenantKeys = sqliteTable("tenant_keys", {
  accountId: text("account_id").primaryKey(),
  /** The tenant's data key wrapped with GLIDEWORTH_BACKUP_KEK; overwritten (null) when destroyed. */
  wrappedDek: text("wrapped_dek"),
  kekId: text("kek_id").notNull(),
  createdAt: text("created_at").notNull().default(now),
  destroyedAt: text("destroyed_at"),
  /** Not in spec 2.2: when the wrapped key was also written to the object store (`keys/<id>.key`). */
  escrowedAt: text("escrowed_at"),
});

export const backups = sqliteTable(
  "backups",
  {
    id: text("id").primaryKey(),
    /** Null for a backup of the control plane itself. */
    accountId: text("account_id"),
    objectKey: text("object_key").notNull(),
    bytes: integer("bytes").notNull(),
    sha256: text("sha256").notNull(),
    schemaVersion: integer("schema_version"),
    createdAt: text("created_at").notNull().default(now),
    expiresAt: text("expires_at"),
    verifiedAt: text("verified_at"),
  },
  (t) => [
    uniqueIndex("backups_object_key_uq").on(t.objectKey),
    index("backups_account_created_idx").on(t.accountId, t.createdAt),
  ],
);

// -------------------------------------------------------------------------------------------- oauth
/** Same columns as the tenant `oauth_clients` (apps/api/src/db/schema.ts:380) plus `registered_ip`. */
export const oauthClients = sqliteTable(
  "oauth_clients",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    redirectUris: text("redirect_uris", { mode: "json" }).$type<string[]>().notNull(),
    authMethod: text("auth_method").notNull().default("none"),
    scope: text("scope"),
    createdAt: text("created_at").notNull().default(now),
    lastUsedAt: text("last_used_at"),
    registeredIp: text("registered_ip"),
  },
  (t) => [index("oauth_clients_ip_idx").on(t.registeredIp, t.createdAt)],
);

// -------------------------------------------------------------------------------------------- email
export const emailSuppressions = sqliteTable(
  "email_suppressions",
  {
    emailNormalized: text("email_normalized").notNull(),
    /** `essential`, `checkin` or `all`. */
    category: text("category").notNull(),
    reason: text("reason", { enum: ["unsubscribe", "bounce", "complaint"] }).notNull(),
    createdAt: text("created_at").notNull().default(now),
  },
  (t) => [primaryKey({ columns: [t.emailNormalized, t.category] })],
);

/** Never a body, subject or address. */
export const emailLog = sqliteTable(
  "email_log",
  {
    id: text("id").primaryKey(),
    userId: text("user_id"),
    template: text("template").notNull(),
    category: text("category").notNull(),
    providerMessageId: text("provider_message_id"),
    status: text("status", { enum: ["sent", "suppressed", "failed"] }).notNull(),
    createdAt: text("created_at").notNull().default(now),
  },
  (t) => [index("email_log_created_idx").on(t.createdAt), index("email_log_user_idx").on(t.userId)],
);

// ------------------------------------------------------------------------------------------ exports
export const exports = sqliteTable(
  "exports",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    requestedBy: text("requested_by").notNull(),
    path: text("path").notNull(),
    bytes: integer("bytes"),
    expiresAt: text("expires_at").notNull(),
    downloadedAt: text("downloaded_at"),
  },
  (t) => [
    index("exports_account_idx").on(t.accountId),
    index("exports_expires_idx").on(t.expiresAt),
  ],
);

// ---------------------------------------------------------------------------------------- operators
export const operators = sqliteTable(
  "operators",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    name: text("name").notNull(),
    passwordHash: text("password_hash").notNull(),
    /** Mandatory for operators; nullable only between `operator create` and first enrolment. */
    totpSecretEnc: text("totp_secret_enc"),
    /** Not in spec 2.2: TOTP replay protection needs the last accepted step, as for users. */
    totpLastStep: integer("totp_last_step"),
    role: text("role", { enum: ["support", "admin"] }).notNull(),
    createdAt: text("created_at").notNull().default(now),
    disabledAt: text("disabled_at"),
    lastSigninAt: text("last_signin_at"),
  },
  (t) => [uniqueIndex("operators_email_uq").on(t.email)],
);

export const operatorSessions = sqliteTable(
  "operator_sessions",
  {
    /** SHA-256 of the cookie value. */
    id: text("id").primaryKey(),
    operatorId: text("operator_id")
      .notNull()
      .references(() => operators.id, { onDelete: "cascade" }),
    csrf: text("csrf").notNull(),
    ip: text("ip"),
    createdAt: text("created_at").notNull().default(now),
    lastSeenAt: text("last_seen_at").notNull().default(now),
    expiresAt: text("expires_at").notNull(),
  },
  (t) => [index("operator_sessions_operator_idx").on(t.operatorId)],
);

export const supportGrants = sqliteTable(
  "support_grants",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    grantedByUserId: text("granted_by_user_id").notNull(),
    reason: text("reason").notNull(),
    expiresAt: text("expires_at").notNull(),
    revokedAt: text("revoked_at"),
    createdAt: text("created_at").notNull().default(now),
  },
  (t) => [index("support_grants_account_idx").on(t.accountId)],
);

// ------------------------------------------------------------------- second work package (not in 2.2)
/**
 * Resumable multi-step operations (workspace deletion, user deletion). A row exists while the operation is
 * unfinished; a crash leaves it behind and `resumeLifecycle()` completes it on the next start or sweep.
 */
export const lifecycleTasks = sqliteTable(
  "lifecycle_tasks",
  {
    id: text("id").primaryKey(),
    kind: text("kind", { enum: ["workspace_delete", "user_delete"] }).notNull(),
    subjectId: text("subject_id").notNull(),
    step: text("step").notNull(),
    state: text("state", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    actorId: text("actor_id"),
    attempts: integer("attempts").notNull().default(0),
    lastErrorCode: text("last_error_code"),
    createdAt: text("created_at").notNull().default(now),
    updatedAt: text("updated_at").notNull().default(now),
  },
  (t) => [uniqueIndex("lifecycle_tasks_subject_uq").on(t.kind, t.subjectId)],
);

/** Must-send mail (billing notices, export-ready, account-deleted): retried until sent, suppressed or dead. */
export const mailOutbox = sqliteTable(
  "mail_outbox",
  {
    id: text("id").primaryKey(),
    /** One row per logical message (null: no deduplication). */
    dedupeKey: text("dedupe_key"),
    userId: text("user_id"),
    toEmail: text("to_email").notNull(),
    toName: text("to_name"),
    template: text("template").notNull(),
    data: text("data", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    status: text("status", { enum: ["pending", "sent", "suppressed", "dead"] })
      .notNull()
      .default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: text("next_attempt_at").notNull(),
    lastErrorCode: text("last_error_code"),
    createdAt: text("created_at").notNull().default(now),
    sentAt: text("sent_at"),
  },
  (t) => [
    uniqueIndex("mail_outbox_dedupe_uq").on(t.dedupeKey),
    index("mail_outbox_due_idx").on(t.status, t.nextAttemptAt),
    index("mail_outbox_user_idx").on(t.userId),
  ],
);

/** Cross-process single-writer leases (billing writers per account). `token` is the fencing token. */
export const writerLocks = sqliteTable("writer_locks", {
  key: text("key").primaryKey(),
  holder: text("holder").notNull(),
  token: integer("token").notNull(),
  expiresAt: integer("expires_at").notNull(),
});

/** Checkout Sessions this cell created (one open session per account at a time). */
export const checkoutSessions = sqliteTable(
  "checkout_sessions",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    lookupKey: text("lookup_key"),
    priceId: text("price_id").notNull(),
    url: text("url").notNull(),
    status: text("status", { enum: ["open", "complete", "expired"] })
      .notNull()
      .default("open"),
    createdAt: text("created_at").notNull(),
    expiresAt: text("expires_at").notNull(),
  },
  (t) => [index("checkout_sessions_account_idx").on(t.accountId, t.status)],
);

/** Replay protection for provider webhooks that sign a nonce (Mailgun): hash of the token, kept 1 day. */
export const webhookNonces = sqliteTable("webhook_nonces", {
  id: text("id").primaryKey(),
  expiresAt: text("expires_at").notNull(),
});

/** Commands the CLI hands to the running server (restore, backup, migrate) and their results. */
export const opsCommands = sqliteTable(
  "ops_commands",
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull(),
    args: text("args", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    status: text("status", { enum: ["queued", "running", "done", "failed"] })
      .notNull()
      .default("queued"),
    result: text("result", { mode: "json" }).$type<Record<string, unknown>>(),
    errorCode: text("error_code"),
    createdAt: text("created_at").notNull().default(now),
    startedAt: text("started_at"),
    finishedAt: text("finished_at"),
  },
  (t) => [index("ops_commands_status_idx").on(t.status, t.createdAt)],
);

/** The running server's heartbeat (so the CLI knows whether to queue a command or run it itself). */
export const cellHeartbeat = sqliteTable("cell_heartbeat", {
  id: text("id").primaryKey(),
  pid: integer("pid").notNull(),
  at: text("at").notNull(),
});

/**
 * Not in spec 2.2: when each long-interval periodic job (restore test, prune, maintenance, backup sweep) last
 * ran and last succeeded, so a restart does not reset its clock (server.ts `DurableJobs`). Names and times only.
 */
export const jobRuns = sqliteTable("job_runs", {
  name: text("name").primaryKey(),
  lastStartedAt: text("last_started_at"),
  lastSuccessAt: text("last_success_at"),
  lastFailureAt: text("last_failure_at"),
  consecutiveFailures: integer("consecutive_failures").notNull().default(0),
});

/** Everything, for `drizzle(sqlite, { schema })` and the `ControlDb` type. */
export const schema = {
  users,
  userTokens,
  recoveryCodes,
  userIdentities,
  oidcFlows,
  sessions,
  knownDevices,
  accounts,
  memberships,
  invitations,
  subscriptions,
  trialGrants,
  billingNotices,
  stripeEvents,
  auditEvents,
  usageCounters,
  tenantSchedules,
  tenantKeys,
  backups,
  oauthClients,
  emailSuppressions,
  emailLog,
  exports,
  operators,
  operatorSessions,
  supportGrants,
  lifecycleTasks,
  mailOutbox,
  writerLocks,
  checkoutSessions,
  webhookNonces,
  opsCommands,
  cellHeartbeat,
  jobRuns,
};
