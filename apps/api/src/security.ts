/**
 * Outbound-request safety for webhooks (SSRF). A webhook URL is supplied by an API caller, so by
 * default the server refuses to connect to loopback, private, link-local, carrier-grade-NAT,
 * multicast and other non-public addresses (cloud metadata endpoints live in 169.254.0.0/16).
 * `GLIDEWORTH_WEBHOOK_ALLOW_PRIVATE=true` opts out for self-hosters who deliver to a service on their LAN.
 *
 * Two layers: a syntactic check when the webhook is registered (literal IPs, `localhost`, `.local`,
 * `.internal`), and a connection-time check on every resolved address (defeats DNS names that point
 * at private space, and DNS rebinding, because the check runs inside the socket's own lookup).
 */
import { lookup as dnsLookup } from "node:dns";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";

const v4 = (ip: string): number[] => ip.split(".").map(Number);

/** True for IPv4 addresses that are not routable on the public internet. */
export function isPrivateIPv4(ip: string): boolean {
  const [a, b, c] = v4(ip) as [number, number, number, number];
  return (
    a === 0 || // "this network"
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local, cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) || // IETF protocol assignments, TEST-NET-1
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224 // multicast, reserved, broadcast
  );
}

/** Expand an IPv6 literal to eight 16-bit groups (handles `::` and an embedded dotted IPv4 tail). */
function expandV6(ip: string): number[] | null {
  let s = ip.toLowerCase().split("%")[0] ?? "";
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (tail) {
    const [p, q, r, t] = v4(tail[1]!) as [number, number, number, number];
    s = `${s.slice(0, s.length - tail[1]!.length)}${((p << 8) | q).toString(16)}:${((r << 8) | t).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - rest.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...rest].map(
    (g) => Number.parseInt(g, 16),
  );
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff)
    ? groups
    : null;
}

export function isPrivateIPv6(ip: string): boolean {
  const g = expandV6(ip);
  if (!g) return true; // unparseable: refuse
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const embeddedV4 = `${g6 >> 8}.${g6 & 255}.${g7 >> 8}.${g7 & 255}`;
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0) {
    if (g5 === 0xffff) return isPrivateIPv4(embeddedV4); // ::ffff:a.b.c.d (IPv4-mapped)
    if (g5 === 0) return true; // ::, ::1, and the deprecated IPv4-compatible range
  }
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0)
    return isPrivateIPv4(embeddedV4); // NAT64
  return (
    (g0 & 0xfe00) === 0xfc00 || // unique local fc00::/7
    (g0 & 0xffc0) === 0xfe80 || // link-local fe80::/10
    (g0 & 0xffc0) === 0xfec0 || // deprecated site-local
    (g0 & 0xff00) === 0xff00 || // multicast
    (g0 === 0x2001 && g1 === 0x0db8) || // documentation
    g0 === 0x0100 // discard-only
  );
}

export function isPrivateAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return isPrivateIPv4(ip);
  if (kind === 6) return isPrivateIPv6(ip);
  return true;
}

const PRIVATE_NAME = /(^|\.)(localhost|local|localdomain|internal|intranet|lan|home|corp)\.?$/i;

/** `url.hostname` without the brackets of an IPv6 literal. */
const bareHost = (u: URL): string => u.hostname.replace(/^\[|\]$/g, "");

/**
 * Registration-time check: throws a message if the URL is not http(s) or names an obviously
 * non-public host. DNS names are checked again, per address, at connection time.
 */
export function webhookUrlProblem(raw: string, allowPrivate: boolean): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "url must be an absolute http(s) URL";
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return "url must be http or https";
  if (u.username || u.password) return "url must not contain credentials";
  if (allowPrivate) return null;
  const host = bareHost(u);
  if (isIP(host) ? isPrivateAddress(host) : PRIVATE_NAME.test(host))
    return `url points at a private or local address (${host}); webhooks to non-public hosts are blocked unless the server sets GLIDEWORTH_WEBHOOK_ALLOW_PRIVATE=true`;
  return null;
}

export interface DeliveryResponse {
  status: number;
  ok: boolean;
}
export type DeliveryFn = (
  url: string,
  init: { method: "POST"; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<DeliveryResponse>;

/**
 * HTTP POST that refuses private destinations. The address check lives in the socket `lookup`, so it
 * sees exactly the address the connection will use (no resolve-then-connect gap). Redirects are never
 * followed. Resolves with the status code; the response body is discarded.
 */
export function safeDeliver(opts: { allowPrivate: boolean }): DeliveryFn {
  return (rawUrl, init) =>
    new Promise<DeliveryResponse>((resolve, reject) => {
      const u = new URL(rawUrl);
      const host = bareHost(u);
      if (!opts.allowPrivate && isIP(host) && isPrivateAddress(host))
        return reject(new Error("blocked: private address"));
      const lib = u.protocol === "https:" ? https : http;
      const req = lib.request(
        u,
        {
          method: init.method,
          headers: { ...init.headers, "content-length": String(Buffer.byteLength(init.body)) },
          signal: init.signal,
          // oxlint-disable-next-line typescript/no-explicit-any -- node's lookup callback has two shapes (all: true/false)
          lookup: ((hostname: string, options: any, cb: any) => {
            dnsLookup(hostname, { ...options, all: true }, (err, addrs) => {
              if (err) return cb(err);
              const list = addrs as unknown as { address: string; family: number }[];
              if (!opts.allowPrivate && list.some((a) => isPrivateAddress(a.address)))
                return cb(new Error("blocked: private address"));
              if (options?.all) return cb(null, list);
              const first = list[0];
              return first ? cb(null, first.address, first.family) : cb(new Error("no address"));
            });
          }) as never,
        },
        (res) => {
          res.resume();
          const status = res.statusCode ?? 0;
          resolve({ status, ok: status >= 200 && status < 300 });
        },
      );
      req.on("error", reject);
      req.end(init.body);
    });
}

// ---------------------------------------------------------------------------------------------
// Prototype pollution: JSON Patch / merge-patch input must never address Object.prototype.
// ---------------------------------------------------------------------------------------------
const UNSAFE_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);

/** True when a JSON Pointer path (or `from`) walks through `__proto__`, `constructor` or `prototype`. */
export function isUnsafePointer(path: string): boolean {
  return path
    .split("/")
    .some((seg) => UNSAFE_SEGMENTS.has(seg.replace(/~1/g, "/").replace(/~0/g, "~")));
}

/**
 * First offending location in request data, or null: an object key named `__proto__`, `constructor` or
 * `prototype`, or a `path`/`from` string that addresses one. No Glideworth document has such keys, and the
 * patch engine in @glideworth/core would otherwise follow `/__proto__/x` into Object.prototype.
 */
export function findUnsafeInput(value: unknown, where = "$", depth = 0): string | null {
  if (depth > 64 || value === null || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = findUnsafeInput(value[i], `${where}[${i}]`, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  for (const [k, v] of Object.entries(value)) {
    if (UNSAFE_SEGMENTS.has(k)) return `${where}.${k}`;
    if ((k === "path" || k === "from") && typeof v === "string" && isUnsafePointer(v))
      return `${where}.${k}`;
    const hit = findUnsafeInput(v, `${where}.${k}`, depth + 1);
    if (hit) return hit;
  }
  return null;
}
