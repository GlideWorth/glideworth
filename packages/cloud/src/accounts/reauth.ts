/**
 * The re-authentication window (spec 3.2): sensitive actions need `sessions.reauth_at` within the last
 * 10 minutes. The stored value is authoritative (read from the database, not trusted from the context object).
 */
import { and, eq } from "drizzle-orm";
import type { ControlDb } from "../control/db.js";
import { sessions } from "../control/schema.js";
import { CloudError } from "../errors.js";
import type { SessionContext } from "../types.js";

export const REAUTH_WINDOW_MS = 10 * 60 * 1000;

export function assertRecentAuthIn(db: ControlDb, s: SessionContext, now: Date): void {
  const row = db
    .select({ reauthAt: sessions.reauthAt })
    .from(sessions)
    .where(and(eq(sessions.id, s.sessionId), eq(sessions.userId, s.userId)))
    .get();
  const at = row?.reauthAt ? Date.parse(row.reauthAt) : Number.NaN;
  if (!Number.isFinite(at) || now.getTime() - at > REAUTH_WINDOW_MS || at > now.getTime() + 60_000)
    throw new CloudError(403, "REAUTH_REQUIRED", "confirm your password or a 2FA code to continue");
}
