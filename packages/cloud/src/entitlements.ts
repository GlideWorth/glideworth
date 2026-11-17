/**
 * Entitlements (spec 6.1): the only function anything asks about what a workspace may do. It combines
 * `accounts.status`, `accessFor(subscription)` and the plan limits through `@glideworth/billing`'s pure
 * `entitlementFor`, so the access rule exists exactly once.
 *
 * Read-only (spec 4.4) is one mechanism, applied by the helpers below and by the host through them:
 * scopes capped to `read` + `simulate` (`capScopes`), no async job submission (`policy.admitJob`), no scheduler
 * (`CloudScheduler` skips), no outbound webhooks (`policy.webhooksSuppressed`). Nothing is ever deleted.
 */
import { entitlementFor, type PricingConfig } from "@glideworth/billing";
import { eq } from "drizzle-orm";
import { controlBillingStore } from "./control/billing-store.js";
import type { ControlDb } from "./control/db.js";
import { accounts } from "./control/schema.js";
import { isAccountId } from "./crypto/random.js";
import { CloudError } from "./errors.js";
import type { AccountId, Entitlements, EntitlementsService } from "./types.js";

export function createEntitlements(d: {
  db: ControlDb;
  pricing: PricingConfig;
  now?: () => Date;
}): EntitlementsService {
  const store = controlBillingStore(d.db);
  return {
    get(accountId: AccountId, now?: Date): Entitlements {
      const at = now ?? d.now?.() ?? new Date();
      const row = isAccountId(accountId)
        ? d.db
            .select({ status: accounts.status, mcpWrites: accounts.mcpWrites })
            .from(accounts)
            .where(eq(accounts.id, accountId))
            .get()
        : undefined;
      // An unknown account is treated like a deleted one: suspended, nothing allowed.
      const decision = entitlementFor({
        accountStatus: row?.status ?? "deleted",
        subscription: row ? store.getSubscription(accountId) : null,
        now: at,
        pricing: d.pricing,
      });
      return {
        accountId,
        level: decision.level,
        reason: decision.reason,
        limits: decision.limits,
        mcpWrites: row?.mcpWrites ?? false,
        trialEndsAt: decision.trialEndsAt,
        changesAt: decision.changesAt,
      };
    },
  };
}

export type Scope = "read" | "simulate" | "write";
/** What a workspace that is not at `full` keeps (spec 4.4): the same cap `capScopes` applies to a viewer. */
export const READ_ONLY_SCOPES: readonly Scope[] = ["read", "simulate"];

/**
 * A workspace that has never had a subscription: no access at all until the owner starts the trial (or
 * subscribes) in Stripe Checkout. Account settings, billing, invitations and deletion are control-plane routes and
 * stay open.
 */
export const notStarted = (e: Pick<Entitlements, "level" | "reason">): boolean =>
  e.level === "read_only" && e.reason === "no_subscription";

/**
 * Cap a principal's scopes by entitlement. Hosts call this from `CredentialVerifiers.cap` and set
 * `limitedBy: 'entitlement'` when `limited` is true, so `requireScope` answers 402 `ACCOUNT_READ_ONLY`.
 * A suspended workspace, and one that never subscribed, keeps nothing.
 */
export function capScopes<S extends string>(
  scopes: readonly S[],
  e: Entitlements,
): { scopes: S[]; limited: boolean } {
  if (e.level === "full") return { scopes: [...scopes], limited: false };
  const none = e.level === "suspended" || notStarted(e);
  const allowed: readonly string[] = none ? [] : READ_ONLY_SCOPES;
  const capped = scopes.filter((s) => allowed.includes(s));
  return { scopes: capped, limited: capped.length !== scopes.length || none };
}

/** The 402 error for a refused write (`requireScope`, MCP job tools, job admission). */
export function readOnlyError(e: Entitlements, billingUrl: string): CloudError {
  if (e.level === "suspended")
    return new CloudError(403, "ACCOUNT_SUSPENDED", "this workspace is suspended", {
      reason: e.reason,
    });
  return new CloudError(
    402,
    "ACCOUNT_READ_ONLY",
    notStarted(e)
      ? "the workspace has no subscription yet; the owner can start the free trial in billing settings"
      : "the workspace is read-only; the owner can subscribe in billing settings",
    { reason: e.reason, billingUrl },
  );
}
