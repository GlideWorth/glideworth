import { randomBase32 } from "../crypto/random.js";

/**
 * Tenant sign-in name for a member: email local part (safe characters only) plus a random suffix. Used when the
 * mirror row is created; the host keeps an existing row's login on update.
 */
export function tenantLogin(emailNormalized: string): string {
  const local = emailNormalized.slice(0, emailNormalized.lastIndexOf("@"));
  const safe = local.replace(/[^a-z0-9._-]/g, "").slice(0, 24) || "member";
  return `${safe}-${randomBase32(4)}`;
}
