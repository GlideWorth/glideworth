/**
 * In-memory sliding-window rate limiter (single process at launch, spec 3.2).
 *
 * Each key keeps the timestamps of its allowed hits inside the window, at most `limit` of them, so memory per
 * key is bounded by the limit. Refused hits are not recorded (an attacker hammering a closed bucket does not
 * keep it closed longer than the window). The key map is an LRU bounded by `maxKeys`: the least recently used
 * key is evicted when full, and keys whose window has passed are pruned lazily.
 */
export interface RateLimiter {
  hit(
    key: string,
    limit: number,
    windowMs: number,
  ): { allowed: boolean; remaining: number; retryAfterMs: number };
}

interface Bucket {
  hits: number[];
  windowMs: number;
}

export function memoryRateLimiter(o: { maxKeys?: number; now?: () => number } = {}): RateLimiter & {
  size(): number;
  clear(): void;
} {
  const maxKeys = o.maxKeys ?? 100_000;
  if (!Number.isInteger(maxKeys) || maxKeys < 1)
    throw new Error("maxKeys must be a positive integer");
  const clock = o.now ?? Date.now;
  const buckets = new Map<string, Bucket>();
  let sweepAt = 0;

  const sweep = (now: number) => {
    // Amortised: walk the oldest entries and drop the ones whose window is over.
    let budget = 64;
    for (const [k, b] of buckets) {
      if (budget-- <= 0) break;
      const last = b.hits[b.hits.length - 1];
      if (last === undefined || last <= now - b.windowMs) buckets.delete(k);
    }
  };

  return {
    hit(key, limit, windowMs) {
      if (typeof key !== "string" || key.length === 0) throw new Error("rate limit key required");
      if (!Number.isFinite(limit) || limit < 0 || !Number.isFinite(windowMs) || windowMs <= 0)
        throw new Error("invalid rate limit");
      const k = key.length > 256 ? key.slice(0, 256) : key;
      const now = clock();
      if (now >= sweepAt) {
        sweep(now);
        sweepAt = now + 1000;
      }
      let b = buckets.get(k);
      if (b) buckets.delete(k); // re-insert below: Map order is the LRU order
      else b = { hits: [], windowMs };
      b.windowMs = Math.max(b.windowMs, windowMs);
      const cutoff = now - windowMs;
      while (b.hits.length && (b.hits[0] as number) <= cutoff) b.hits.shift();
      // A smaller limit than before for the same key: keep only the newest `limit` hits.
      if (b.hits.length > limit) b.hits.splice(0, b.hits.length - limit);
      let result: { allowed: boolean; remaining: number; retryAfterMs: number };
      if (b.hits.length >= limit) {
        const oldest = b.hits[0] ?? now;
        result = {
          allowed: false,
          remaining: 0,
          retryAfterMs: Math.max(1, oldest + windowMs - now),
        };
      } else {
        b.hits.push(now);
        result = { allowed: true, remaining: limit - b.hits.length, retryAfterMs: 0 };
      }
      buckets.set(k, b);
      while (buckets.size > maxKeys) {
        const first = buckets.keys().next();
        if (first.done) break;
        buckets.delete(first.value);
      }
      return result;
    },
    size: () => buckets.size,
    clear: () => buckets.clear(),
  };
}
