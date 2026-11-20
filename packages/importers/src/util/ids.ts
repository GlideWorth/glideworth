/** Id handling: Glideworth ids are `[A-Za-z0-9_-]{1,64}`; source ids may be anything. */

export function slug(input: string, fallback: string): string {
  const t = input
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+/, "");
  let end = t.length;
  while (end > 0 && t[end - 1] === "-") end--;
  const s = t.slice(0, Math.min(end, 56));
  return s.length > 0 ? s : fallback;
}

/**
 * Deterministic source-id -> Glideworth-id registry. Ids already valid are kept verbatim so that
 * references across entities line up; invalid or colliding ids are slugged and suffixed.
 */
export class IdRegistry {
  private readonly bySource = new Map<string, string>();
  /**
   * Ids handed out, and three that are never handed out: as keys of `accountSettings` and the like they would
   * set the object's prototype instead of an entry, and the API refuses them in JSON Patch paths.
   */
  private readonly used = new Set<string>(["__proto__", "constructor", "prototype"]);
  /**
   * Next suffix to try for each base. Without it, the n-th id colliding on one base would test suffixes 2..n
   * again, so a crafted export with many ids that shorten to the same base took time proportional to the
   * square of their number (security review: hostile-input cost of the importers).
   */
  private readonly nextSuffix = new Map<string, number>();

  /** `base`, or `base-<n>` with the smallest n not tried for this base before, that is not in use. */
  private allocate(base: string): string {
    let candidate = base;
    let n = this.nextSuffix.get(base) ?? 2;
    while (this.used.has(candidate)) {
      const suffix = `-${n++}`;
      candidate = `${base.slice(0, 64 - suffix.length)}${suffix}`;
    }
    this.nextSuffix.set(base, n);
    this.used.add(candidate);
    return candidate;
  }

  /** Glideworth id for a source id, allocating one on first use. */
  get(sourceId: string | undefined, fallbackHint: string): string {
    const key = sourceId ?? `\u0000${fallbackHint}`;
    const existing = this.bySource.get(key);
    if (existing) return existing;
    let base =
      sourceId !== undefined && /^[A-Za-z0-9_-]{1,64}$/.test(sourceId)
        ? sourceId
        : slug(sourceId ?? "", fallbackHint);
    if (base === "") base = fallbackHint;
    const candidate = this.allocate(base);
    this.bySource.set(key, candidate);
    return candidate;
  }

  /** Glideworth id for a source id if it was already allocated. */
  peek(sourceId: string | undefined): string | undefined {
    return sourceId === undefined ? undefined : this.bySource.get(sourceId);
  }

  has(sourceId: string | undefined): boolean {
    return sourceId !== undefined && this.bySource.has(sourceId);
  }

  /** Reserve an id for something with no source id (e.g. a derived loan). */
  fresh(base: string): string {
    return this.allocate(slug(base, "id"));
  }
}
