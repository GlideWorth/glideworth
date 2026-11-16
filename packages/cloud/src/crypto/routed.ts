/**
 * Routed credentials (spec 2.5): `<kind>_<accountId>_<secret>`. The account id is not secret; it only says
 * which tenant database to look in. The tenant stores SHA-256 of the whole string, so a credential can verify
 * only inside the tenant it names. Parsing is strict and runs before anything touches the filesystem: the
 * account id must match `^t[a-z2-7]{15}$` (lowercase, fixed length, no separators), so `../`, absolute paths,
 * uppercase and wrong lengths are refused here.
 */
import { randomBytes } from "node:crypto";
import { base32Encode, isAccountId } from "./random.js";

export type AccountId = string;
export type RoutedKind = "key" | "oauth_access" | "oauth_refresh" | "oauth_code" | "share";

const PREFIX: Record<RoutedKind, string> = {
  key: "gwk",
  oauth_access: "gwa",
  oauth_refresh: "gwr",
  oauth_code: "gwc",
  share: "gws",
};
const KIND_OF: Record<string, RoutedKind> = Object.fromEntries(
  Object.entries(PREFIX).map(([k, p]) => [p, k as RoutedKind]),
);

/** 256-bit secret, lowercase base32 (52 characters). */
const secret = (): string => base32Encode(randomBytes(32));

/** `gwk_<acct>_<prefix 8>_<secret>`; the prefix is the tenant's lookup key, the secret 32 or more characters. */
export const API_KEY_RE = /^gwk_t[a-z2-7]{15}_[a-z2-7]{8}_[a-z2-7]{32,128}$/;
const OTHER_RE = /^(gwa|gwr|gwc|gws)_t[a-z2-7]{15}_[a-z2-7]{32,128}$/;
const MAX_LENGTH = 200;

function assertAccount(accountId: AccountId): void {
  if (!isAccountId(accountId)) throw new Error("invalid account id");
}

export function mintRouted(kind: Exclude<RoutedKind, "key">, accountId: AccountId): string {
  assertAccount(accountId);
  const p = PREFIX[kind];
  if (!p || kind === ("key" as RoutedKind)) throw new Error("invalid routed kind");
  return `${p}_${accountId}_${secret()}`;
}

export function mintApiKey(accountId: AccountId): { key: string; prefix: string } {
  assertAccount(accountId);
  const prefix = base32Encode(randomBytes(5)); // 40 bits -> exactly 8 characters
  return { key: `gwk_${accountId}_${prefix}_${secret()}`, prefix };
}

/** Kind and account of a routed credential, or null for anything that is not exactly well-formed. */
export function parseRouted(token: string): { kind: RoutedKind; accountId: AccountId } | null {
  if (typeof token !== "string" || token.length > MAX_LENGTH) return null;
  if (!API_KEY_RE.test(token) && !OTHER_RE.test(token)) return null;
  const kind = KIND_OF[token.slice(0, 3)];
  const accountId = token.slice(4, 20);
  if (!kind || !isAccountId(accountId) || token[20] !== "_") return null;
  return { kind, accountId };
}
