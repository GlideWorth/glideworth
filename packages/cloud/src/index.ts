/**
 * `@glideworth/cloud`: Glideworth Cloud (spec 8.3). Loaded only in cloud mode.
 *
 * Control plane, crypto, accounts and authentication, workspaces and members, tenant registry and lifecycle,
 * entitlements, quotas, the fair job gate, the global scheduler, backups, HTTP routes (`registerCloudRoutes`,
 * `tenantAuth`), the operator console (`createOpsApp`), configuration and logging (`./log`). The server boot is
 * `./server`; the operator CLI is the `glideworth-cloud` bin. What `apps/api` must provide: `CloudHost` in `./server`.
 */

export {
  type CaptchaVerifier,
  staticCaptcha,
  TURNSTILE_VERIFY_URL,
  turnstileVerifier,
} from "./abuse/captcha.js";
export {
  configureDisposableDomains,
  isDisposableEmail,
  loadDisposableOverrideFile,
} from "./abuse/disposable.js";
export { networkPrefix } from "./abuse/ip.js";
export { memoryRateLimiter, type RateLimiter } from "./abuse/rate-limiter.js";
export { describeDevice } from "./accounts/device.js";
export { normalizeEmail } from "./accounts/email.js";
export { REAUTH_WINDOW_MS } from "./accounts/reauth.js";
export {
  ACCOUNT_LIMITS,
  ACCOUNT_TTL,
  type AccountsDeps,
  AccountsService,
  publicSessionId,
} from "./accounts/service.js";
export {
  AUDIT_DETAIL_KEYS,
  CONTROL_AUDIT_EVENTS,
  type ControlAudit,
  type ControlAuditEvent,
  controlAudit,
} from "./audit.js";
export { BackupIntegrityError } from "./backups/envelope.js";
export { KeyUnavailableError } from "./backups/keys.js";
export {
  fsObjectStore,
  memoryObjectStore,
  ObjectNotFoundError,
  s3ObjectStore,
} from "./backups/object-store.js";
export { BACKUP_RETENTION, BackupService, restoreControlPlane } from "./backups/service.js";
export {
  billingLogBridge,
  billingNotifier,
  openCheckoutSession,
  trackCheckoutSessions,
} from "./billing/glue.js";
export { type CloudConfig, CloudConfigError, loadCloudConfig, parseKey32 } from "./config.js";
export { controlBillingStore } from "./control/billing-store.js";
export { type ControlDb, openControlDb } from "./control/db.js";
export { controlEmailStores } from "./control/email-stores.js";
export { controlOAuthClients, OAUTH_REGISTRATION_LIMITS } from "./control/oauth-clients.js";
export { MailOutbox } from "./control/outbox.js";
export { schema as controlSchema } from "./control/schema.js";
export { LockLostError, VersionConflictError, withWriterLock } from "./control/writer-lock.js";
export { deriveKey, type Keyring, keyring, SealedValueError } from "./crypto/keyring.js";
export {
  ACCOUNT_ID_RE,
  base32Decode,
  base32Encode,
  isAccountId,
  newAccountId,
  newUserId,
  USER_ID_RE,
} from "./crypto/random.js";
export {
  API_KEY_RE,
  mintApiKey,
  mintRouted,
  parseRouted,
  type RoutedKind,
} from "./crypto/routed.js";
export {
  hotp,
  newRecoveryCodes,
  newTotpSecret,
  normalizeRecoveryCode,
  otpauthUri,
  TOTP,
  totpStep,
  verifyTotp,
} from "./crypto/totp.js";
export { capScopes, createEntitlements, READ_ONLY_SCOPES, readOnlyError } from "./entitlements.js";
export {
  CloudError,
  type CloudErrorCode,
  NotImplementedError,
  storageQuotaError,
} from "./errors.js";
export {
  CSRF_COOKIE,
  CSRF_HEADER,
  cloudErrorResponse,
  DEVICE_COOKIE,
  SESSION_COOKIE,
  safeNext,
} from "./http/common.js";
export {
  CLOUD_ROUTE_PREFIXES,
  type CloudHttpDeps,
  isCloudRoute,
  type SupportView,
} from "./http/kit.js";
export { registerCloudRoutes } from "./http/routes/index.js";
export {
  type CredentialVerifiers,
  type TenantVars,
  tenantAuth,
  UNAUTHORIZED_BODY,
} from "./http/tenant-auth.js";
export { fairThreadGate } from "./jobs/fair-gate.js";
export type { ErrorReporter, Logger, LogValue } from "./log/index.js";
export { createOpsApp, type OpsAppOptions } from "./ops/app.js";
export { OperatorService } from "./ops/operators.js";
export {
  assertPasswordPolicy,
  hashPassword,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  needsRehash,
  verifyPassword,
} from "./password.js";
export { createTenantPolicy, type TenantPolicy } from "./policy.js";
export { dailyLimit, METRICS, QuotaService } from "./quotas.js";
export { CloudScheduler } from "./scheduler.js";
export { InvalidTenantIdError, tenantPath } from "./tenancy/paths.js";
export { TenantRegistry, type TenantRegistryOptions, tenantPragmas } from "./tenancy/registry.js";
export type {
  AccountId,
  Entitlements,
  EntitlementsService,
  InvitationView,
  IssuedSession,
  Lease,
  Membership,
  Metric,
  ObjectStore,
  RequestMeta,
  Role,
  SessionContext,
  SessionView,
  SignInResult,
  TenantMemberPort,
  TenantOpener,
  TenantRuntimeBase,
  ThreadGate,
  UserId,
  WorkspaceSummary,
} from "./types.js";
export {
  tenantLogin,
  USER_DELETE_STEPS,
  WORKSPACE_DELETE_STEPS,
  type WorkspacesDeps,
  WorkspacesService,
} from "./workspaces/service.js";
