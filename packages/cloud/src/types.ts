/**
 * Types of spec 8.3 shared by several modules.
 */
import type { Access, PlanLimits } from "./external-types.js";

export type AccountId = string;
export type UserId = string;
export type Role = "owner" | "editor" | "viewer";

export interface RequestMeta {
  ip: string;
  userAgent: string | null;
  /** Value of the `__Host-gw_device` cookie, if the browser sent one. */
  deviceToken: string | null;
}

export interface IssuedSession {
  /** The `__Host-gw_session` cookie value. Never stored. */
  token: string;
  csrf: string;
  expiresAt: Date;
  maxAgeSeconds: number;
  /** Set when the host must (re)write the `__Host-gw_device` cookie. */
  newDeviceToken: string | null;
}

export interface SessionContext {
  sessionId: string;
  userId: UserId;
  email: string;
  name: string;
  csrf: string;
  activeAccountId: AccountId | null;
  mfa: boolean;
  reauthAt: Date | null;
  expiresAt: Date;
}

export type SignInResult =
  | { kind: "signed-in"; session: IssuedSession; userId: UserId }
  | { kind: "totp-required"; challenge: string; expiresAt: Date };

export interface SessionView {
  id: string;
  device: string;
  ip: string | null;
  createdAt: string;
  lastSeenAt: string;
  current: boolean;
}

export interface Membership {
  accountId: AccountId;
  userId: UserId;
  role: Role;
  tenantUserId: string;
  userName: string;
}

export interface WorkspaceSummary {
  accountId: AccountId;
  name: string;
  role: Role;
  access: Access;
}

export interface InvitationView {
  id: string;
  email: string;
  role: "editor" | "viewer";
  expiresAt: string;
  invitedBy: string;
}

// ------------------------------------------------------------------------------------------- tenancy
export interface TenantMemberPort {
  upsert(m: { tenantUserId: string; login: string; name: string; role: Role }): void;
  /** apps/api: UsersService.delete (sessions, API keys and OAuth tokens go with the person). */
  remove(tenantUserId: string): void;
  /**
   * Every mirrored member. `name` is the copy of the person's account name (control-plane `users.name` is the
   * source); a runtime that leaves it out is never corrected for names, only for roles.
   */
  list(): Array<{ tenantUserId: string; role: Role; name?: string }>;
  /** API keys + OAuth tokens (ownership transfer). */
  revokeCredentials(tenantUserId: string): void;
  /**
   * Password reset: the person's OAuth access tokens, refresh tokens and unused authorization codes, and
   * nothing else (API keys and other members stay). Returns how many live grants were revoked.
   */
  revokeOAuthGrants(tenantUserId: string): number;
}

export interface TenantRuntimeBase {
  readonly accountId: AccountId;
  readonly members: TenantMemberPort;
  busy(): boolean;
  close(): Promise<void>;
}

export interface TenantOpener<R extends TenantRuntimeBase> {
  /**
   * Open (and migrate) the tenant database at `dbPath` and build its runtime. Must throw, leaving the file as it
   * was, when a migration fails (Drizzle's migrator runs pending migrations in one transaction). Apply
   * `tenantPragmas(limits)` to the handle.
   */
  open(accountId: AccountId, dbPath: string, limits: PlanLimits): R;
  /**
   * Not in spec 8.3: the number of tenant migrations the host ships. When given, the registry takes a
   * `pre-migrate/<ts>.db` copy before opening a file whose schema is behind (spec 2.3 Migrate).
   */
  readonly schemaVersion?: number;
}

export interface Lease<R> {
  readonly runtime: R;
  release(): void;
}

// ---------------------------------------------------------------------------- entitlements, quotas
export interface Entitlements {
  accountId: AccountId;
  level: "full" | "read_only" | "suspended";
  reason: import("./external-types.js").AccessReason | "suspended";
  limits: PlanLimits;
  mcpWrites: boolean;
  trialEndsAt: string | null;
  changesAt: string | null;
}
export interface EntitlementsService {
  get(accountId: AccountId, now?: Date): Entitlements;
}
export type Metric = "api_request" | "job" | "worker_ms" | "webhook_delivery" | "share_read";
export interface ThreadGate {
  acquire(accountId: AccountId): Promise<() => void>;
}

// ------------------------------------------------------------------------------------------- backups
export interface ObjectStore {
  put(key: string, body: NodeJS.ReadableStream, bytes: number): Promise<void>;
  get(key: string): Promise<NodeJS.ReadableStream>;
  delete(keys: string[]): Promise<void>;
  list(prefix: string): Promise<string[]>;
}
