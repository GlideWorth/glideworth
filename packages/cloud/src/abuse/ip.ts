/**
 * Network prefixes for per-network sign-up limits (spec 3.7): /24 for IPv4, /48 for IPv6. IPv4-mapped IPv6
 * addresses count as IPv4. Anything unparseable maps to a single shared bucket, so garbage cannot be used to
 * mint fresh buckets.
 */
import { isIP } from "node:net";

function expandV6(ip: string): number[] | null {
  const s = ip.toLowerCase().split("%")[0] ?? "";
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...tail].map(
    (g) => (/^[0-9a-f]{1,4}$/.test(g) ? Number.parseInt(g, 16) : Number.NaN),
  );
  return groups.length === 8 && groups.every((g) => Number.isInteger(g)) ? groups : null;
}

export function networkPrefix(ip: string): string {
  if (typeof ip !== "string") return "invalid";
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  const addr = mapped ? (mapped[1] as string) : ip;
  const kind = isIP(addr);
  if (kind === 4) return `v4:${addr.split(".").slice(0, 3).join(".")}`;
  if (kind === 6) {
    const g = expandV6(addr);
    if (!g) return "invalid";
    return `v6:${g
      .slice(0, 3)
      .map((x) => x.toString(16))
      .join(":")}`;
  }
  return "invalid";
}
