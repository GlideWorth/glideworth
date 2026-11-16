/**
 * OAuth dynamic client registration in cloud mode (spec 2.5, 2.6, 6.1): registration is unauthenticated and
 * happens before anyone signs in, so clients live in the control plane, not in a tenant. This is the store the
 * host's `OAuthService` uses through its `ClientStore` option (spec 9 step 14): the host validates the RFC 7591
 * metadata as today, then `register` applies the abuse limits and inserts the row. At consent the host copies
 * the row into the tenant's own `oauth_clients` (so its foreign keys hold) and calls `markConsented`.
 *
 * Limits: 20 registrations per minute and 200 per day per IP (the daily count is read from the table, so it
 * survives restarts), a global ceiling, and clients never consented to are purged after 24 hours.
 */
import { and, count, eq, gt, isNull, lt } from "drizzle-orm";
import type { RateLimiter } from "../abuse/rate-limiter.js";
import { CloudError } from "../errors.js";
import type { ControlDb } from "./db.js";
import { oauthClients } from "./schema.js";

export const OAUTH_REGISTRATION_LIMITS = {
  perMinute: 20,
  perDay: 200,
  total: 50_000,
  unusedTtlMs: 24 * 3600_000,
} as const;

export interface ControlOAuthClient {
  id: string;
  name: string;
  redirectUris: string[];
  scope: string | null;
  createdAt: string;
  lastUsedAt: string | null;
}

export function controlOAuthClients(d: { db: ControlDb; limiter: RateLimiter; now?: () => Date }) {
  const clock = d.now ?? (() => new Date());
  const tooMany = (retryAfterSeconds: number) =>
    new CloudError(429, "RATE_LIMITED", "too many client registrations from this address", {
      retryAfterSeconds,
    });
  const purge = (): number =>
    d.db
      .delete(oauthClients)
      .where(
        and(
          isNull(oauthClients.lastUsedAt),
          lt(
            oauthClients.createdAt,
            new Date(clock().getTime() - OAUTH_REGISTRATION_LIMITS.unusedTtlMs).toISOString(),
          ),
        ),
      )
      .run().changes;
  return {
    /** Insert a validated client registered from `ip`, or throw 429 / 503. */
    register(
      c: { id: string; name: string; redirectUris: string[]; scope: string | null },
      ip: string,
    ): void {
      const minute = d.limiter.hit(`oauth:reg:${ip}`, OAUTH_REGISTRATION_LIMITS.perMinute, 60_000);
      if (!minute.allowed) throw tooMany(Math.ceil(minute.retryAfterMs / 1000));
      const now = clock();
      const since = new Date(now.getTime() - 24 * 3600_000).toISOString();
      const today =
        d.db
          .select({ n: count() })
          .from(oauthClients)
          .where(
            and(eq(oauthClients.registeredIp, ip.slice(0, 64)), gt(oauthClients.createdAt, since)),
          )
          .get()?.n ?? 0;
      if (today >= OAUTH_REGISTRATION_LIMITS.perDay) throw tooMany(3600);
      purge();
      if (
        (d.db.select({ n: count() }).from(oauthClients).get()?.n ?? 0) >=
        OAUTH_REGISTRATION_LIMITS.total
      )
        throw new CloudError(
          503,
          "TENANT_UNAVAILABLE",
          "client registration is temporarily unavailable",
        );
      d.db
        .insert(oauthClients)
        .values({
          id: c.id,
          name: c.name,
          redirectUris: c.redirectUris,
          scope: c.scope,
          createdAt: now.toISOString(),
          registeredIp: ip.slice(0, 64),
        })
        .run();
    },
    get(id: string): ControlOAuthClient | null {
      if (typeof id !== "string" || id.length > 200) return null;
      const r = d.db.select().from(oauthClients).where(eq(oauthClients.id, id)).get();
      return r
        ? {
            id: r.id,
            name: r.name,
            redirectUris: r.redirectUris,
            scope: r.scope,
            createdAt: r.createdAt,
            lastUsedAt: r.lastUsedAt,
          }
        : null;
    },
    /** At consent: the client is in use and is never purged. */
    markConsented(id: string): void {
      d.db
        .update(oauthClients)
        .set({ lastUsedAt: clock().toISOString() })
        .where(eq(oauthClients.id, id))
        .run();
    },
    purge,
  };
}
