/**
 * JSON Pointer (RFC 6901) with Glideworth's one extension: an array element may be addressed by id
 * with the segment `[id=<id>]`, e.g. `/income/[id=salary-1]/amount/value`.
 */

export type Segment = { kind: "key"; key: string } | { kind: "id"; id: string };

const ID_SEGMENT = /^\[id=([A-Za-z0-9_-]+)\]$/;

/**
 * Keys that would reach an object's prototype chain. Never valid in Glideworth documents: a pointer
 * naming one is rejected, and patch values containing one are refused (prototype pollution).
 */
export const UNSAFE_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

export function isUnsafeKey(key: string): boolean {
  return UNSAFE_KEYS.has(key);
}

export class UnsafePointerError extends Error {
  constructor(
    readonly pointer: string,
    readonly segment: string,
  ) {
    super(`JSON pointer segment '${segment}' is not allowed (${pointer})`);
    this.name = "UnsafePointerError";
  }
}

/** Parse a JSON pointer. @throws Error on a malformed pointer, UnsafePointerError on an unsafe segment. */
export function parsePointer(pointer: string): Segment[] {
  if (pointer === "") return [];
  if (!pointer.startsWith("/")) throw new Error(`JSON pointer must start with '/': ${pointer}`);
  return pointer
    .slice(1)
    .split("/")
    .map((raw): Segment => {
      const m = ID_SEGMENT.exec(raw);
      if (m) return { kind: "id", id: m[1]! };
      const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
      if (isUnsafeKey(key)) throw new UnsafePointerError(pointer, key);
      return { kind: "key", key };
    });
}

export function formatPointer(segments: Segment[]): string {
  return segments
    .map(
      (s) =>
        `/${s.kind === "id" ? `[id=${s.id}]` : s.key.replace(/~/g, "~0").replace(/\//g, "~1")}`,
    )
    .join("");
}

export const keySeg = (key: string | number): Segment => ({ kind: "key", key: String(key) });
export const idSeg = (id: string): Segment => ({ kind: "id", id });

/** Join a pointer prefix and more segments. */
export function joinPointer(prefix: string, ...more: (string | number | Segment)[]): string {
  const extra = more.map((m) => (typeof m === "object" ? m : keySeg(m)));
  return prefix + formatPointer(extra);
}
