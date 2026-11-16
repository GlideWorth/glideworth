/**
 * Google as the OpenID provider. Google documents two `iss` forms for its ID tokens: "The value of iss in the
 * ID token is equal to https://accounts.google.com or accounts.google.com." Another issuer (a local fake
 * provider, never allowed in production: config.ts) accepts exactly its own issuer string.
 */
import { GOOGLE_ISSUER } from "../config.js";

export function googleIssuers(issuer: string): string[] {
  return issuer === GOOGLE_ISSUER ? [GOOGLE_ISSUER, "accounts.google.com"] : [issuer];
}
