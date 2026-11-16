import { desc, eq } from "drizzle-orm";
import {
  generateKey,
  insertKey,
  type KeyFormat,
  SELFHOST_KEY_FORMAT,
  type Scope,
} from "../auth.js";
import { apiKeys, users } from "../db/schema.js";
import { ApiError, conflict, notFound } from "../errors.js";
import type { ServiceCtx } from "./context.js";

export interface KeyInfo {
  id: string;
  /** The user the key acts for (null = the owner, for keys created before collaboration). */
  userId: string | null;
  userName: string | null;
  name: string;
  prefix: string;
  scopes: Scope[];
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

const info = (r: typeof apiKeys.$inferSelect, userName: string | null = null): KeyInfo => ({
  id: r.id,
  userId: r.userId,
  userName,
  name: r.name,
  prefix: r.prefix,
  scopes: r.scopes,
  createdAt: r.createdAt,
  lastUsedAt: r.lastUsedAt,
  revokedAt: r.revokedAt,
});

export interface KeysOptions {
  /** Key format (cloud: routed `gwk_<account>_…` keys valid in this workspace only). */
  format?: KeyFormat;
  /** Cloud: most active keys a workspace may have. */
  maxActive?: () => number;
  /**
   * Self-host refuses to revoke the last active write key (it may be the only way in). Cloud people always
   * have a browser session, so it is off there.
   */
  guardLastWriteKey?: boolean;
}

export class KeysService {
  constructor(
    private readonly ctx: ServiceCtx,
    private readonly opts: KeysOptions = {},
  ) {}

  /** The key format of this database (verification uses the same one). */
  get format(): KeyFormat {
    return this.opts.format ?? SELFHOST_KEY_FORMAT;
  }

  private nameOf(userId: string | null): string | null {
    return (
      this.ctx.db
        .select()
        .from(users)
        .where(eq(users.id, userId ?? "owner"))
        .get()?.name ?? null
    );
  }

  /** The owner sees every key; anyone else only their own. */
  list(forUser?: { id: string; role: string }): KeyInfo[] {
    return this.ctx.db
      .select()
      .from(apiKeys)
      .orderBy(desc(apiKeys.createdAt))
      .all()
      .filter((r) => !forUser || forUser.role === "owner" || (r.userId ?? "owner") === forUser.id)
      .map((r) => info(r, this.nameOf(r.userId)));
  }

  /** Returns the secret ONCE; only its sha256 is stored. A key cannot grant scopes it lacks. */
  create(
    name: string,
    scopes: Scope[],
    creatorScopes: Scope[],
    userId?: string,
  ): KeyInfo & { key: string } {
    const allowed = new Set<Scope>(
      creatorScopes.includes("write") ? ["read", "write", "simulate"] : creatorScopes,
    );
    const denied = scopes.filter((s) => !allowed.has(s));
    if (denied.length)
      throw new ApiError(
        403,
        "FORBIDDEN",
        `cannot grant scopes this key does not have: ${denied.join(", ")}`,
      );
    const max = this.opts.maxActive?.();
    if (max !== undefined) {
      const active = this.ctx.db
        .select()
        .from(apiKeys)
        .all()
        .filter((k) => !k.revokedAt).length;
      if (active >= max)
        throw new ApiError(
          409,
          "LIMIT_REACHED",
          `a workspace can have at most ${max} active API keys`,
          {
            limit: max,
          },
        );
    }
    const { key } = generateKey(this.format);
    const id = insertKey(this.ctx.db, key, name, [...new Set(scopes)], userId, this.format);
    const row = this.ctx.db.select().from(apiKeys).where(eq(apiKeys.id, id)).get()!;
    return { ...info(row, this.nameOf(row.userId)), key };
  }

  /** `by` limits revocation to the caller's own keys unless they are the owner. */
  revoke(id: string, by?: { id: string; role: string }): KeyInfo {
    const row = this.ctx.db.select().from(apiKeys).where(eq(apiKeys.id, id)).get();
    if (!row || (by && by.role !== "owner" && (row.userId ?? "owner") !== by.id))
      throw notFound("api key", id);
    if (row.revokedAt) return info(row, this.nameOf(row.userId));
    const writers = this.ctx.db
      .select()
      .from(apiKeys)
      .all()
      .filter((k) => !k.revokedAt && k.scopes.includes("write"));
    if (
      (this.opts.guardLastWriteKey ?? true) &&
      row.scopes.includes("write") &&
      writers.length === 1
    )
      throw conflict(
        "refusing to revoke the last active write key (you would lock yourself out)",
        undefined,
        "LAST_WRITE_KEY",
      );
    this.ctx.db
      .update(apiKeys)
      .set({ revokedAt: new Date().toISOString() })
      .where(eq(apiKeys.id, id))
      .run();
    return info(
      this.ctx.db.select().from(apiKeys).where(eq(apiKeys.id, id)).get()!,
      this.nameOf(row.userId),
    );
  }
}
