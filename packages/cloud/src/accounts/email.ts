/**
 * Email address normalisation (spec 3.1): trim, NFKC, lowercase, and the domain in its IDNA ASCII form so
 * `bücher.example` and `xn--bcher-kva.example` are one address. No dot or plus stripping (that is
 * provider-specific). The result is the uniqueness key (`users.email_normalized`, invitations, suppressions).
 */
import { domainToASCII } from "node:url";

export const MAX_EMAIL_LENGTH = 254;

/** Normalised form, or null when the input cannot be an email address. */
export function normalizeEmail(input: string): string | null {
  if (typeof input !== "string" || input.length > 512) return null;
  const s = input.trim().normalize("NFKC").toLowerCase().normalize("NFKC");
  // Control characters, whitespace and characters that would let a value escape a header or a URL.
  // oxlint-disable-next-line eslint/no-control-regex -- rejecting control characters is the point
  if (/[\s\u0000-\u001f\u007f<>()[\]\\,;:"]/.test(s)) return null;
  const at = s.lastIndexOf("@");
  if (at <= 0 || at !== s.indexOf("@")) return null;
  const local = s.slice(0, at);
  const domainRaw = s.slice(at + 1).replace(/\.$/, "");
  if (local.length > 64 || local.startsWith(".") || local.endsWith(".") || local.includes(".."))
    return null;
  const domain = domainToASCII(domainRaw);
  if (!domain || domain.length > 253 || !domain.includes(".")) return null;
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain)) return null;
  if (
    domain
      .split(".")
      .some((l) => l.length === 0 || l.length > 63 || l.startsWith("-") || l.endsWith("-"))
  )
    return null;
  const out = `${local}@${domain}`;
  return out.length <= MAX_EMAIL_LENGTH ? out : null;
}

export const emailDomain = (normalized: string): string =>
  normalized.slice(normalized.lastIndexOf("@") + 1);
export const emailLocalPart = (normalized: string): string =>
  normalized.slice(0, normalized.lastIndexOf("@"));
