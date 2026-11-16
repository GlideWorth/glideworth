/**
 * A sliding-window limiter matching `BillingServiceDeps['limiter']`, in memory (per process). For tests and single
 * process deployments; the cloud package may pass its own shared limiter instead.
 */
export function memoryLimiter(
  now: () => Date = () => new Date(),
): (key: string, limit: number, windowMs: number) => boolean {
  const hits = new Map<string, number[]>();
  return (key, limit, windowMs) => {
    const t = now().getTime();
    const recent = (hits.get(key) ?? []).filter((h) => h > t - windowMs);
    if (recent.length >= limit) {
      hits.set(key, recent);
      return false;
    }
    recent.push(t);
    hits.set(key, recent);
    return true;
  };
}
