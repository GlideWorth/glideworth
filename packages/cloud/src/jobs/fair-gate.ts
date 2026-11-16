/**
 * Global worker-thread semaphore shared by every tenant runtime (spec 6.1 Fairness): at most `maxThreads`
 * threads run at once, and a free slot goes round-robin to the next workspace with waiting work, so one
 * workspace queueing many shards cannot starve the others. Each workspace's wait queue is bounded.
 */
import { CloudError } from "../errors.js";
import type { AccountId, ThreadGate } from "../types.js";

export function fairThreadGate(o: {
  maxThreads: number;
  maxWaitingPerAccount?: number;
}): ThreadGate & { stats(): { running: number; waiting: Record<AccountId, number> } } {
  if (!Number.isInteger(o.maxThreads) || o.maxThreads < 1)
    throw new Error("maxThreads must be >= 1");
  const maxWaiting = o.maxWaitingPerAccount ?? 256;
  let running = 0;
  /** Insertion order is the rotation order: an account that was just served moves to the back. */
  const queues = new Map<AccountId, Array<(release: () => void) => void>>();

  const release = (): (() => void) => {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      running--;
      grant();
    };
  };

  const grant = () => {
    while (running < o.maxThreads && queues.size > 0) {
      const first = queues.entries().next();
      if (first.done) return;
      const [account, q] = first.value;
      const resolve = q.shift();
      queues.delete(account);
      if (q.length > 0) queues.set(account, q);
      if (!resolve) continue;
      running++;
      resolve(release());
    }
  };

  return {
    acquire(accountId: AccountId): Promise<() => void> {
      const q = queues.get(accountId) ?? [];
      if (q.length >= maxWaiting)
        return Promise.reject(
          new CloudError(429, "RATE_LIMITED", "too many queued computations for this workspace", {
            retryAfterSeconds: 5,
          }),
        );
      return new Promise((resolve) => {
        q.push(resolve);
        if (!queues.has(accountId)) queues.set(accountId, q);
        grant();
      });
    },
    stats() {
      const waiting: Record<AccountId, number> = {};
      for (const [a, q] of queues) waiting[a] = q.length;
      return { running, waiting };
    },
  };
}
