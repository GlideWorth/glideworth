/**
 * SQLite schema (Drizzle). Domain objects are stored as validated JSON documents (`body`) next to
 * a few indexed columns; the Zod schema in @glideworth/core stays the single source of truth for shape.
 * Every JSON blob carries the schemaVersion it was written with so migrations can upgrade lazily.
 */
import { sql } from "drizzle-orm";
import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const now = sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;

export const households = sqliteTable("households", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  schemaVersion: integer("schema_version").notNull(),
  /** Household JSON. */
  body: text("body", { mode: "json" }).notNull(),
  /** CurrentFinances JSON. */
  finances: text("finances", { mode: "json" }).notNull(),
  version: integer("version").notNull().default(0),
  createdAt: text("created_at").notNull().default(now),
  updatedAt: text("updated_at").notNull().default(now),
});

export const plans = sqliteTable(
  "plans",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    isMain: integer("is_main", { mode: "boolean" }).notNull().default(false),
    status: text("status", { enum: ["active", "archived"] })
      .notNull()
      .default("active"),
    parentPlanId: text("parent_plan_id"),
    /** Display order within the household (lower first; ties break by creation time). */
    sortOrder: integer("sort_order").notNull().default(0),
    schemaVersion: integer("schema_version").notNull(),
    /** Plan JSON (materialised for branch plans). */
    body: text("body", { mode: "json" }).notNull(),
    /** Optimistic concurrency; mirrors body.version. */
    version: integer("version").notNull().default(0),
    createdAt: text("created_at").notNull().default(now),
    updatedAt: text("updated_at").notNull().default(now),
  },
  (t) => [index("plans_household_idx").on(t.householdId)],
);

/** Immutable history: one row per plan write. Powers undo, audit log and "what changed". */
export const planVersions = sqliteTable(
  "plan_versions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    planId: text("plan_id")
      .notNull()
      .references(() => plans.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    schemaVersion: integer("schema_version").notNull(),
    body: text("body", { mode: "json" }).notNull(),
    /** Actor JSON ({kind, id, label}). */
    actor: text("actor", { mode: "json" }).notNull(),
    message: text("message"),
    changeSetId: text("change_set_id"),
    createdAt: text("created_at").notNull().default(now),
  },
  (t) => [uniqueIndex("plan_versions_plan_version_uq").on(t.planId, t.version)],
);

/** Proposed edits (MCP / UI What-If). Applied atomically with a base-version check. */
export const changeSets = sqliteTable(
  "change_sets",
  {
    id: text("id").primaryKey(),
    planId: text("plan_id")
      .notNull()
      .references(() => plans.id, { onDelete: "cascade" }),
    baseVersion: integer("base_version").notNull(),
    status: text("status", { enum: ["proposed", "applied", "discarded", "conflict"] }).notNull(),
    /** ChangeSet JSON (ops, summary, rationale, preview, createdBy). */
    body: text("body", { mode: "json" }).notNull(),
    createdAt: text("created_at").notNull().default(now),
    appliedAt: text("applied_at"),
  },
  (t) => [index("change_sets_plan_idx").on(t.planId)],
);

export const progressSnapshots = sqliteTable(
  "progress_snapshots",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    date: text("date").notNull(),
    schemaVersion: integer("schema_version").notNull(),
    body: text("body", { mode: "json" }).notNull(),
    createdAt: text("created_at").notNull().default(now),
  },
  (t) => [index("progress_household_date_idx").on(t.householdId, t.date)],
);

export const apiKeys = sqliteTable("api_keys", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  /** Public lookup part of the key (glideworth_<prefix>_<secret>). */
  prefix: text("prefix").notNull().unique(),
  /** sha256 hex of the full key. The key itself is never stored. */
  hash: text("hash").notNull(),
  /** JSON array of 'read' | 'write' | 'simulate'. */
  scopes: text("scopes", { mode: "json" }).$type<("read" | "write" | "simulate")[]>().notNull(),
  /** Owner of the key: its effective scopes are capped by this user's role. Null = the instance owner (legacy keys). */
  userId: text("user_id"),
  createdAt: text("created_at").notNull().default(now),
  lastUsedAt: text("last_used_at"),
  revokedAt: text("revoked_at"),
});

export const userSettings = sqliteTable("user_settings", {
  id: text("id").primaryKey(),
  schemaVersion: integer("schema_version").notNull(),
  body: text("body", { mode: "json" }).notNull(),
  updatedAt: text("updated_at").notNull().default(now),
});

/** Optional result cache keyed by plan version + input hash (workstream e decides eviction). */
export const simulationRuns = sqliteTable(
  "simulation_runs",
  {
    id: text("id").primaryKey(),
    planId: text("plan_id")
      .notNull()
      .references(() => plans.id, { onDelete: "cascade" }),
    planVersion: integer("plan_version").notNull(),
    kind: text("kind", {
      enum: ["deterministic", "monte-carlo", "historical", "solver"],
    }).notNull(),
    inputHash: text("input_hash").notNull(),
    engineVersion: text("engine_version").notNull(),
    result: text("result", { mode: "json" }).notNull(),
    createdAt: text("created_at").notNull().default(now),
  },
  (t) => [index("simulation_runs_lookup_idx").on(t.planId, t.planVersion, t.kind, t.inputHash)],
);

/** Async jobs (Monte Carlo, historical, solvers, guardrails). Results are persisted so polling survives restarts. */
export const jobs = sqliteTable(
  "jobs",
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull(),
    planId: text("plan_id").notNull(),
    planVersion: integer("plan_version").notNull(),
    status: text("status", {
      enum: ["queued", "running", "succeeded", "failed", "cancelled"],
    }).notNull(),
    /** 0..1 */
    progress: real("progress").notNull().default(0),
    params: text("params", { mode: "json" }).notNull(),
    result: text("result", { mode: "json" }),
    error: text("error", { mode: "json" }),
    cached: integer("cached", { mode: "boolean" }).notNull().default(false),
    createdBy: text("created_by", { mode: "json" }).notNull(),
    createdAt: text("created_at").notNull().default(now),
    startedAt: text("started_at"),
    finishedAt: text("finished_at"),
  },
  (t) => [index("jobs_plan_idx").on(t.planId), index("jobs_status_idx").on(t.status)],
);

/** Idempotency-Key replay store for write requests (24h). */
export const idempotencyKeys = sqliteTable("idempotency_keys", {
  /** sha256(keyId + ':' + client-supplied key) */
  id: text("id").primaryKey(),
  method: text("method").notNull(),
  path: text("path").notNull(),
  requestHash: text("request_hash").notNull(),
  status: integer("status").notNull(),
  contentType: text("content_type").notNull(),
  etag: text("etag"),
  response: text("response").notNull(),
  createdAt: text("created_at").notNull().default(now),
});

/** Outgoing webhook subscriptions. The signing secret must be stored to sign payloads; it is shown once. */
export const webhooks = sqliteTable("webhooks", {
  id: text("id").primaryKey(),
  url: text("url").notNull(),
  description: text("description"),
  events: text("events", { mode: "json" }).$type<string[]>().notNull(),
  secret: text("secret").notNull(),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at").notNull().default(now),
});

export const webhookDeliveries = sqliteTable(
  "webhook_deliveries",
  {
    id: text("id").primaryKey(),
    webhookId: text("webhook_id")
      .notNull()
      .references(() => webhooks.id, { onDelete: "cascade" }),
    event: text("event").notNull(),
    payload: text("payload").notNull(),
    status: text("status", { enum: ["pending", "succeeded", "failed"] }).notNull(),
    attempts: integer("attempts").notNull().default(0),
    lastStatusCode: integer("last_status_code"),
    lastError: text("last_error"),
    createdAt: text("created_at").notNull().default(now),
    deliveredAt: text("delivered_at"),
  },
  (t) => [index("webhook_deliveries_hook_idx").on(t.webhookId)],
);

/** The single owner's passphrase hash (scrypt). One row, id = 'owner'; absent until first-run setup. */
export const authCredentials = sqliteTable("auth_credentials", {
  id: text("id").primaryKey(),
  /** `scrypt$N$r$p$salt$hash` (base64). The passphrase itself is never stored. */
  hash: text("hash").notNull(),
  createdAt: text("created_at").notNull().default(now),
  updatedAt: text("updated_at").notNull().default(now),
});

/** Browser sessions. The cookie holds a random token; only its sha256 is stored. */
export const authSessions = sqliteTable(
  "auth_sessions",
  {
    id: text("id").primaryKey(),
    /** The signed-in user. */
    userId: text("user_id").notNull().default("owner"),
    /** CSRF token for this session; cookie-authenticated writes must echo it in X-CSRF-Token. */
    csrf: text("csrf").notNull(),
    userAgent: text("user_agent"),
    createdAt: text("created_at").notNull().default(now),
    lastSeenAt: text("last_seen_at").notNull().default(now),
    /** Absolute expiry. */
    expiresAt: text("expires_at").notNull(),
  },
  (t) => [index("auth_sessions_expiry_idx").on(t.expiresAt)],
);

// ============================================================================= collaboration
/** Logins of one instance. `owner` always exists (id 'owner'); its passphrase hash lives in auth_credentials. */
export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    /** Sign-in name (lowercase, unique). */
    login: text("login").notNull(),
    name: text("name").notNull(),
    role: text("role", { enum: ["owner", "editor", "viewer"] }).notNull(),
    /** scrypt hash; null until an invite is accepted. The owner's hash is in auth_credentials. */
    hash: text("hash"),
    disabledAt: text("disabled_at"),
    createdBy: text("created_by"),
    createdAt: text("created_at").notNull().default(now),
    lastLoginAt: text("last_login_at"),
  },
  (t) => [uniqueIndex("users_login_uq").on(t.login)],
);

/** One-time invite / passphrase-reset tokens (only their sha256 is stored). */
export const userTokens = sqliteTable(
  "user_tokens",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["invite", "reset"] }).notNull(),
    tokenHash: text("token_hash").notNull(),
    expiresAt: text("expires_at").notNull(),
    usedAt: text("used_at"),
    createdAt: text("created_at").notNull().default(now),
  },
  (t) => [uniqueIndex("user_tokens_hash_uq").on(t.tokenHash)],
);

/** Who changed what: every write by a user, key, OAuth token or MCP client. */
export const auditLog = sqliteTable(
  "audit_log",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    at: text("at").notNull().default(now),
    userId: text("user_id"),
    userName: text("user_name"),
    /** 'session' | 'key' | 'oauth' | 'mcp' | 'system' */
    via: text("via").notNull(),
    /** API key id, OAuth client id... */
    credentialId: text("credential_id"),
    action: text("action").notNull(),
    resourceType: text("resource_type"),
    resourceId: text("resource_id"),
    status: integer("status"),
    detail: text("detail", { mode: "json" }),
  },
  (t) => [
    index("audit_log_at_idx").on(t.at),
    index("audit_log_resource_idx").on(t.resourceType, t.resourceId),
    index("audit_log_user_idx").on(t.userId),
  ],
);

// ============================================================================= share links
export const shareLinks = sqliteTable(
  "share_links",
  {
    id: text("id").primaryKey(),
    planId: text("plan_id")
      .notNull()
      .references(() => plans.id, { onDelete: "cascade" }),
    /** sha256 of the secret token (the token is shown once). */
    tokenHash: text("token_hash").notNull(),
    label: text("label"),
    /** 'full' = amounts; 'percent' = percentages of the starting value; 'hidden' = no amounts. */
    privacy: text("privacy", { enum: ["full", "percent", "hidden"] }).notNull(),
    basis: text("basis", { enum: ["real", "nominal"] })
      .notNull()
      .default("real"),
    expiresAt: text("expires_at").notNull(),
    revokedAt: text("revoked_at"),
    /** Precomputed public payload: the public route never computes and never reads other tables. */
    snapshot: text("snapshot", { mode: "json" }).notNull(),
    snapshotAt: text("snapshot_at").notNull(),
    createdBy: text("created_by", { mode: "json" }).notNull(),
    createdAt: text("created_at").notNull().default(now),
    viewCount: integer("view_count").notNull().default(0),
    lastViewedAt: text("last_viewed_at"),
  },
  (t) => [
    uniqueIndex("share_links_token_uq").on(t.tokenHash),
    index("share_links_plan_idx").on(t.planId),
  ],
);

// ============================================================================= scheduled check-ins
/** Plan health history: one row per scheduled or manual re-run of a plan. */
export const planHealth = sqliteTable(
  "plan_health",
  {
    id: text("id").primaryKey(),
    planId: text("plan_id")
      .notNull()
      .references(() => plans.id, { onDelete: "cascade" }),
    takenAt: text("taken_at").notNull().default(now),
    trigger: text("trigger", { enum: ["scheduled", "manual", "api"] }).notNull(),
    planVersion: integer("plan_version").notNull(),
    householdVersion: integer("household_version").notNull(),
    successRate: real("success_rate"),
    /** Year financial independence is reached (the milestone named "FI" or the retirement year). */
    fiYear: integer("fi_year"),
    /** Net worth now (from the household's current finances), today's money. */
    actualNetWorth: real("actual_net_worth"),
    /** What the plan projected for the current year (today's money). */
    plannedNetWorth: real("planned_net_worth"),
    /** milestones[], audit finding ids, end net worth... */
    body: text("body", { mode: "json" }).notNull(),
  },
  (t) => [index("plan_health_plan_idx").on(t.planId, t.takenAt)],
);

export const notifications = sqliteTable(
  "notifications",
  {
    id: text("id").primaryKey(),
    createdAt: text("created_at").notNull().default(now),
    kind: text("kind").notNull(),
    severity: text("severity", { enum: ["info", "warning", "critical"] }).notNull(),
    planId: text("plan_id"),
    healthId: text("health_id"),
    title: text("title").notNull(),
    body: text("body", { mode: "json" }).notNull(),
    readAt: text("read_at"),
  },
  (t) => [index("notifications_created_idx").on(t.createdAt)],
);

/** Scheduler configuration (one row, id 'default'). */
export const scheduleConfig = sqliteTable("schedule_config", {
  id: text("id").primaryKey(),
  body: text("body", { mode: "json" }).notNull(),
  lastRunAt: text("last_run_at"),
  updatedAt: text("updated_at").notNull().default(now),
});

// ============================================================================= OAuth 2.1 (remote MCP clients)
export const oauthClients = sqliteTable("oauth_clients", {
  /** The client_id. */
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  redirectUris: text("redirect_uris", { mode: "json" }).$type<string[]>().notNull(),
  /** Always 'none' (public clients with PKCE); kept for the registration response. */
  authMethod: text("auth_method").notNull().default("none"),
  scope: text("scope"),
  createdAt: text("created_at").notNull().default(now),
  lastUsedAt: text("last_used_at"),
});

export const oauthCodes = sqliteTable("oauth_codes", {
  /** sha256 of the authorization code. */
  id: text("id").primaryKey(),
  clientId: text("client_id")
    .notNull()
    .references(() => oauthClients.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull(),
  redirectUri: text("redirect_uri").notNull(),
  codeChallenge: text("code_challenge").notNull(),
  scopes: text("scopes", { mode: "json" }).$type<string[]>().notNull(),
  resource: text("resource"),
  expiresAt: text("expires_at").notNull(),
  usedAt: text("used_at"),
});

export const oauthTokens = sqliteTable(
  "oauth_tokens",
  {
    id: text("id").primaryKey(),
    /** sha256 of the access token / refresh token. */
    accessHash: text("access_hash").notNull(),
    refreshHash: text("refresh_hash").notNull(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClients.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    scopes: text("scopes", { mode: "json" }).$type<string[]>().notNull(),
    resource: text("resource"),
    accessExpiresAt: text("access_expires_at").notNull(),
    refreshExpiresAt: text("refresh_expires_at").notNull(),
    revokedAt: text("revoked_at"),
    createdAt: text("created_at").notNull().default(now),
    lastUsedAt: text("last_used_at"),
  },
  (t) => [
    uniqueIndex("oauth_tokens_access_uq").on(t.accessHash),
    uniqueIndex("oauth_tokens_refresh_uq").on(t.refreshHash),
  ],
);
