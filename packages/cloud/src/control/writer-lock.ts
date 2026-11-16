/**
 * Cross-process single-writer leases on the control plane (review finding 1).
 *
 * Every process of the cell shares the control-plane SQLite file, so a lease row there serialises writers
 * across processes: `withWriterLock('billing:<account>', fn)` waits until it holds the row, runs `fn`, and
 * releases it. Each acquisition gets a new fencing token. Code running inside the lock is tagged through
 * AsyncLocalStorage, so the billing store can check, in the same transaction as the write, that the lease is
 * still held with that token and that the row's version is the one it read (compare-and-swap). A writer whose
 * lease expired (a stalled process) can therefore never overwrite what a later lease holder wrote.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { CloudError } from "../errors.js";
import type { ControlDb } from "./db.js";
import { writerLocks } from "./schema.js";

export interface LockScope {
  key: string;
  token: number;
  /** subscriptions.version as last read inside this scope, per account. */
  versions: Map<string, number>;
}

export const lockScope = new AsyncLocalStorage<LockScope>();

export class LockLostError extends Error {
  readonly code = "LOCK_LOST";
  constructor() {
    super("writer lease lost");
    this.name = "LockLostError";
  }
}

export class VersionConflictError extends Error {
  readonly code = "VERSION_CONFLICT";
  constructor() {
    super("row changed since it was read");
    this.name = "VersionConflictError";
  }
}

const HOLDER = `${process.pid}-${randomBytes(6).toString("hex")}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function withWriterLock<T>(
  db: ControlDb,
  key: string,
  fn: () => Promise<T>,
  o: { ttlMs?: number; waitMs?: number; now?: () => number } = {},
): Promise<T> {
  const ttl = o.ttlMs ?? 60_000;
  const clock = o.now ?? Date.now;
  const deadline = Date.now() + (o.waitMs ?? 15_000);
  // Re-entrant: an inner call for the same key inside the scope runs directly.
  const outer = lockScope.getStore();
  if (outer?.key === key) return fn();
  let token: number | null = null;
  for (let delay = 5; token === null; delay = Math.min(delay * 2, 100)) {
    token = db.transaction((tx) => {
      const now = clock();
      const row = tx.select().from(writerLocks).where(eq(writerLocks.key, key)).get();
      if (row && row.expiresAt > now) return null;
      const next = (row?.token ?? 0) + 1;
      tx.insert(writerLocks)
        .values({ key, holder: HOLDER, token: next, expiresAt: now + ttl })
        .onConflictDoUpdate({
          target: writerLocks.key,
          set: { holder: HOLDER, token: next, expiresAt: now + ttl },
        })
        .run();
      return next;
    });
    if (token === null) {
      if (Date.now() > deadline)
        throw new CloudError(503, "TENANT_UNAVAILABLE", "busy; try again shortly", {
          retryAfterSeconds: 2,
        });
      await sleep(delay);
    }
  }
  const scope: LockScope = { key, token, versions: new Map() };
  try {
    return await lockScope.run(scope, fn);
  } finally {
    db.delete(writerLocks)
      .where(and(eq(writerLocks.key, key), eq(writerLocks.token, scope.token)))
      .run();
  }
}

/** Inside a transaction: throw unless the current scope's lease is still held with its token. */
export function assertLeaseHeld(
  tx: Pick<ControlDb, "select">,
  scope: LockScope,
  now: number = Date.now(),
): void {
  const row = tx.select().from(writerLocks).where(eq(writerLocks.key, scope.key)).get();
  if (!row || row.token !== scope.token || row.expiresAt <= now) throw new LockLostError();
}
