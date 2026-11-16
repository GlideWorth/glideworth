/**
 * `tenantAuth` (spec 2.5, 8.3): resolves every credential to exactly one tenant runtime, or refuses.
 *
 * Bearer credentials (`/api/*` and `/mcp`):
 *   `gwk_<acct>_…` API key and `gwa_<acct>_…` OAuth access token. The account id is parsed with the strict
 *   routed-credential grammar; the control plane is asked for the account's status before any file is opened;
 *   the runtime is leased and the host's verifier checks the secret inside that tenant only (the tenant stores
 *   SHA-256 of the whole string, which contains the account id, so a credential for tenant A presented with B's
 *   id cannot verify in B). Every failure (malformed, other kinds such as `gwr_`/`gwc_`/`gws_`, unknown,
 *   deleted, deleting or suspended account, wrong secret) is the same 401 with the same body.
 * Browser session (`/api/*` only, never `/mcp`):
 *   `__Host-gw_session` -> control-plane session -> the active workspace -> the membership row, read on every
 *   request (no cache), so a removed member loses access on their next request. Writes need the CSRF token and
 *   a same-origin request.
 *
 * Then: entitlements (one function) cap the principal (`verifiers.cap`), and the per-workspace request quota is
 * charged, only after the credential verified (an attacker cannot spend a workspace's quota with junk).
 */
import type { Context, MiddlewareHandler } from "hono";
import type { AccountsService } from "../accounts/service.js";
import { parseRouted } from "../crypto/routed.js";
import { CloudError } from "../errors.js";
import type { QuotaService } from "../quotas.js";
import type { TenantRegistry } from "../tenancy/registry.js";
import type {
  AccountId,
  Entitlements,
  EntitlementsService,
  Lease,
  Membership,
  SessionContext,
  TenantRuntimeBase,
} from "../types.js";
import type { WorkspacesService } from "../workspaces/service.js";
import { assertCsrfToken, assertSameOrigin, isSafeMethod, sessionCookie } from "./common.js";

/** Implemented by `apps/api` (spec 9 steps 7, 14): the existing verifiers, run inside one tenant runtime. */
export interface CredentialVerifiers<R, P> {
  /** `verifyKey` with the cloud key format; null when the key is unknown or revoked in this tenant. */
  apiKey(r: R, token: string): P | null;
  /** `OAuthService.verifyAccess(token, resource)`; null when not valid in this tenant. */
  oauthAccess(r: R, token: string, resource: string): P | null;
  /** The principal of a member using a browser session (role from the membership row). */
  session(r: R, m: Membership & { sessionId: string }): P;
  /** Cap scopes by entitlement and set `limitedBy: 'entitlement'` (see `capScopes`). */
  cap(p: P, e: Entitlements): P;
}

export interface TenantVars<R, P> {
  tenant: {
    accountId: AccountId;
    runtime: R;
    entitlements: Entitlements;
    session: SessionContext | null;
  };
  principal: P;
}

export interface TenantAuthDeps<R extends TenantRuntimeBase, P> {
  accounts: AccountsService;
  workspaces: WorkspacesService;
  registry: TenantRegistry<R>;
  entitlements: EntitlementsService;
  quotas: QuotaService;
  verifiers: CredentialVerifiers<R, P>;
  publicUrl: string;
  mode: "api" | "mcp";
}

export const UNAUTHORIZED_BODY = {
  error: { code: "UNAUTHORIZED", message: "missing or invalid credentials" },
} as const;

export function tenantAuth<R extends TenantRuntimeBase, P>(
  d: TenantAuthDeps<R, P>,
): MiddlewareHandler<{ Variables: TenantVars<R, P> }> {
  const publicOrigin = new URL(d.publicUrl).origin;
  const base = d.publicUrl.replace(/\/+$/, "");
  const mcpResource = `${base}/mcp`;

  const deny = (c: Context): Response => {
    c.header(
      "WWW-Authenticate",
      d.mode === "mcp"
        ? `Bearer realm="glideworth", error="invalid_token", resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`
        : 'Bearer realm="glideworth"',
    );
    c.header("Cache-Control", "no-store");
    return c.json(UNAUTHORIZED_BODY, 401);
  };

  /** Lease the tenant; anything but "temporarily unavailable" is indistinguishable from a bad credential. */
  const lease = (accountId: AccountId, o: { bearer: boolean }): Lease<R> | null => {
    try {
      return d.registry.acquire(accountId);
    } catch (err) {
      if (err instanceof CloudError && err.code === "TENANT_UNAVAILABLE") throw err;
      if (!o.bearer && err instanceof CloudError && err.code === "ACCOUNT_SUSPENDED") throw err;
      return null;
    }
  };

  return async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    const bearer = /^Bearer\s+/i.test(header) ? header.replace(/^Bearer\s+/i, "").trim() : "";
    let accountId: AccountId;
    let held: Lease<R>;
    let principal: P | null;
    let session: SessionContext | null = null;

    if (bearer || d.mode === "mcp") {
      const routed = bearer ? parseRouted(bearer) : null;
      if (!routed || (routed.kind !== "key" && routed.kind !== "oauth_access")) return deny(c);
      // OAuth access tokens are issued for the MCP endpoint (RFC 8707) and accepted nowhere else. On the REST
      // API one would bypass both the workspace's "MCP writes" switch and the re-authentication that minting a
      // write-scoped API key needs.
      if (routed.kind === "oauth_access" && d.mode !== "mcp") return deny(c);
      accountId = routed.accountId;
      const l = lease(accountId, { bearer: true });
      if (!l) return deny(c);
      held = l;
      try {
        principal =
          routed.kind === "key"
            ? d.verifiers.apiKey(held.runtime, bearer)
            : d.verifiers.oauthAccess(held.runtime, bearer, mcpResource);
      } catch (err) {
        held.release();
        throw err;
      }
      if (!principal) {
        held.release();
        return deny(c);
      }
    } else {
      const s = d.accounts.resolveSession(sessionCookie(c));
      if (!s) return deny(c);
      if (!isSafeMethod(c.req.method)) {
        assertSameOrigin(c, publicOrigin);
        assertCsrfToken(c, s.csrf);
      }
      if (!s.activeAccountId) throw new CloudError(403, "FORBIDDEN", "choose a workspace first");
      // Re-read on every request: removal or a role change applies to the very next request.
      const m = d.workspaces.membership(s.activeAccountId, s.userId);
      if (!m) throw new CloudError(403, "FORBIDDEN", "you are not a member of that workspace");
      accountId = m.accountId;
      const l = lease(accountId, { bearer: false });
      if (!l) throw new CloudError(403, "FORBIDDEN", "you are not a member of that workspace");
      held = l;
      try {
        principal = d.verifiers.session(held.runtime, { ...m, sessionId: s.sessionId });
      } catch (err) {
        held.release();
        throw err;
      }
      session = s;
    }

    try {
      const entitlements = d.entitlements.get(accountId);
      const capped = d.verifiers.cap(principal, entitlements);
      d.quotas.admitRequest(accountId);
      c.set("tenant", { accountId, runtime: held.runtime, entitlements, session });
      c.set("principal", capped);
      await next();
    } finally {
      held.release();
    }
  };
}
