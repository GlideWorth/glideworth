/**
 * Audit log: who changed what. Every write (REST, MCP, OAuth) by a user, API key or OAuth client is
 * recorded with the person behind it. Plan edits are additionally stamped on the plan's version history
 * (`actor`), so "who changed this plan" is answered both places.
 */
import { and, desc, eq, lt } from "drizzle-orm";
import { auditLog } from "../db/schema.js";
import type { ServiceCtx } from "./context.js";

export interface AuditEntry {
  id: number;
  at: string;
  userId: string | null;
  userName: string | null;
  via: string;
  credentialId: string | null;
  action: string;
  resourceType: string | null;
  resourceId: string | null;
  status: number | null;
  detail: unknown;
}

export interface AuditInput {
  userId?: string | null | undefined;
  userName?: string | null | undefined;
  via: "session" | "key" | "oauth" | "mcp" | "system";
  credentialId?: string | null | undefined;
  action: string;
  resourceType?: string | null | undefined;
  resourceId?: string | null | undefined;
  status?: number | null | undefined;
  detail?: unknown;
}

const RETENTION_DAYS = 400;

export class AuditService {
  private writes = 0;
  constructor(private readonly ctx: ServiceCtx) {}
  private get db() {
    return this.ctx.db;
  }

  record(e: AuditInput): void {
    try {
      this.db
        .insert(auditLog)
        .values({
          userId: e.userId ?? null,
          userName: e.userName ?? null,
          via: e.via,
          credentialId: e.credentialId ?? null,
          action: e.action,
          resourceType: e.resourceType ?? null,
          resourceId: e.resourceId ?? null,
          status: e.status ?? null,
          detail: e.detail ?? null,
        })
        .run();
      // Old rows are trimmed now and then (a year and a bit is plenty for a household).
      if (++this.writes % 500 === 0)
        this.db
          .delete(auditLog)
          .where(lt(auditLog.at, new Date(Date.now() - RETENTION_DAYS * 86_400_000).toISOString()))
          .run();
    } catch {
      // Auditing must never break the request it describes.
    }
  }

  list(
    f: {
      userId?: string | undefined;
      resourceType?: string | undefined;
      resourceId?: string | undefined;
      limit?: number | undefined;
      before?: number | undefined;
    } = {},
  ): AuditEntry[] {
    const conds = [];
    if (f.userId) conds.push(eq(auditLog.userId, f.userId));
    if (f.resourceType) conds.push(eq(auditLog.resourceType, f.resourceType));
    if (f.resourceId) conds.push(eq(auditLog.resourceId, f.resourceId));
    if (f.before) conds.push(lt(auditLog.id, f.before));
    return this.db
      .select()
      .from(auditLog)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(auditLog.id))
      .limit(Math.min(f.limit ?? 100, 500))
      .all();
  }
}

/** The resource a REST path addresses: `/api/v1/plans/p1/...` -> plan p1. */
export function resourceOf(
  path: string,
  params: Record<string, string>,
): { type: string | null; id: string | null } {
  const m = /^\/api\/v1\/([a-z-]+)/.exec(path);
  const seg = m?.[1] ?? "";
  const map: Record<string, string> = {
    plans: "plan",
    households: "household",
    "change-sets": "change-set",
    keys: "api-key",
    webhooks: "webhook",
    users: "user",
    "share-links": "share-link",
    jobs: "job",
    settings: "settings",
    import: "household",
    me: "user",
    notifications: "notification",
    checkins: "check-in",
    schedule: "schedule",
    oauth: "oauth-client",
    auth: "user",
  };
  return { type: map[seg] ?? (seg || null), id: params.id ?? null };
}
