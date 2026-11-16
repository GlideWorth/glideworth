/** Start-up messages, kept out of server.ts so they can be tested. */

export interface ListenInfo {
  /** Address the socket is bound to (`AddressInfo.address`). */
  address?: string | undefined;
  port: number;
}

const isWildcard = (a: string | undefined) => !a || a === "::" || a === "0.0.0.0";
const isLoopback = (a: string | undefined) =>
  !!a && (a === "127.0.0.1" || a === "::1" || a === "localhost");

/** The URL users should open: `localhost` for a wildcard bind, otherwise the address actually bound. */
export function listenOrigin(info: ListenInfo): string {
  const a = info.address;
  const host = isWildcard(a) ? "localhost" : a!.includes(":") ? `[${a}]` : a;
  return `http://${host}:${info.port}`;
}

/**
 * Warning shown on a fresh production instance with no setup token. Only relevant when the port is
 * reachable by others: a loopback bind (127.0.0.1 / ::1) is only reachable from this machine (or a
 * reverse proxy on it), so no warning is shown there.
 */
export function setupTokenWarning(opts: {
  production: boolean;
  setupToken: string | undefined;
  address?: string | undefined;
}): string | null {
  if (!opts.production || opts.setupToken || isLoopback(opts.address)) return null;
  return (
    "[glideworth] WARNING: no GLIDEWORTH_SETUP_TOKEN is set, so anyone who can reach this port can choose the passphrase first. " +
    "Set GLIDEWORTH_SETUP_TOKEN (8+ characters) or bind to 127.0.0.1 (GLIDEWORTH_HOST) until you have signed in."
  );
}
