/** Id handling: Glideworth ids are `[A-Za-z0-9_-]{1,64}`; source ids may be anything. */

export function slug(input: string, fallback: string): string {
  const s = input
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 56);
  return s.length > 0 ? s : fallback;
}

/**
 * Deterministic source-id -> Glideworth-id registry. Ids already valid are kept verbatim so that
 * references across entities line up; invalid or colliding ids are slugged and suffixed.
 */
export class IdRegistry {
  private readonly bySource = new Map<string, string>();
  private readonly used = new Set<string>();

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
    let candidate = base;
    let n = 2;
    while (this.used.has(candidate)) {
      const suffix = `-${n++}`;
      candidate = `${base.slice(0, 64 - suffix.length)}${suffix}`;
    }
    this.used.add(candidate);
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
    const root = slug(base, "id");
    let candidate = root;
    let n = 2;
    while (this.used.has(candidate)) {
      const suffix = `-${n++}`;
      candidate = `${root.slice(0, 64 - suffix.length)}${suffix}`;
    }
    this.used.add(candidate);
    return candidate;
  }
}
