/**
 * OAuth dynamic client registration in cloud mode (spec 2.5, 2.6, 6.1): registration is unauthenticated and
 * happens before anyone signs in, so clients live in the control plane, not in a tenant. This is the store the
 * host's `OAuthService` uses through its `ClientStore` option (spec 9 step 14): the host validates the RFC 7591
 * metadata as today, then `register` applies the abuse limits and inserts the row. At consent the host copies
 * the row into the tenant's own `oauth_clients` (so its foreign keys hold) and calls `markConsented`.
 *
 * Limits: 20 registrations per minute and 200 per day per IPv4 address or IPv6 /48 (the daily count is read
 * from the table, so it survives restarts), and clients never consented to are purged after 24 hours. At the
 * global ceiling the oldest never-consented client makes room, so a flood from many addresses cannot stop
 * everyone else from registering (security review finding 18); only a table full of consented clients is a 503.
 */
import { isIP } from "node:net";
import { and, asc, count, eq, gt, isNull, lt } from "drizzle-orm";
import { networkPrefix } from "../abuse/ip.js";
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

/**
 * Who a registration is counted against: the address for IPv4, the /48 for IPv6 (one subscriber holds a whole
 * prefix, so per-address buckets would be unlimited there).
 */
function registrationBucket(ip: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return (mapped[1] as string).slice(0, 64);
  return isIP(ip) === 6 ? networkPrefix(ip) : ip.slice(0, 64);
}

export function controlOAuthClients(d: {
  db: ControlDb;
  limiter: RateLimiter;
  now?: () => Date;
  /** Tests: a smaller global ceiling. */
  maxTotal?: number;
}) {
  const clock = d.now ?? (() => new Date());
  const maxTotal = d.maxTotal ?? OAUTH_REGISTRATION_LIMITS.total;
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
      const bucket = registrationBucket(ip);
      const minute = d.limiter.hit(
        `oauth:reg:${bucket}`,
        OAUTH_REGISTRATION_LIMITS.perMinute,
        60_000,
      );
      if (!minute.allowed) throw tooMany(Math.ceil(minute.retryAfterMs / 1000));
      const now = clock();
      const since = new Date(now.getTime() - 24 * 3600_000).toISOString();
      const today =
        d.db
          .select({ n: count() })
          .from(oauthClients)
          .where(and(eq(oauthClients.registeredIp, bucket), gt(oauthClients.createdAt, since)))
          .get()?.n ?? 0;
      if (today >= OAUTH_REGISTRATION_LIMITS.perDay) throw tooMany(3600);
      purge();
      const total = d.db.select({ n: count() }).from(oauthClients).get()?.n ?? 0;
      if (total >= maxTotal) {
        const unused = d.db
          .select({ id: oauthClients.id })
          .from(oauthClients)
          .where(isNull(oauthClients.lastUsedAt))
          .orderBy(asc(oauthClients.createdAt))
          .limit(total - maxTotal + 1)
          .all();
        if (total - unused.length >= maxTotal)
          throw new CloudError(
            503,
            "TENANT_UNAVAILABLE",
            "client registration is temporarily unavailable",
          );
        for (const u of unused) d.db.delete(oauthClients).where(eq(oauthClients.id, u.id)).run();
      }
      d.db
        .insert(oauthClients)
        .values({
          id: c.id,
          name: c.name,
          redirectUris: c.redirectUris,
          scope: c.scope,
          createdAt: now.toISOString(),
          registeredIp: bucket,
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
