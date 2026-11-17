/**
 * Remove control characters from free text shown in emails and the UI (names): C0 and DEL, C1 (U+0080 to
 * U+009F), the line and paragraph separators (U+2028, U+2029) and the direction overrides and isolates (U+202A
 * to U+202E, U+2066 to U+2069). The mailer refuses a recipient name with any of these, so leaving them in a
 * name would stop all mail to that person (security review pass 3, finding 20).
 */
export function stripControl(s: string): string {
  let out = "";
  for (const ch of s) {
    const c = ch.codePointAt(0) as number;
    if (c <= 0x1f || (c >= 0x7f && c <= 0x9f)) continue;
    if (c === 0x2028 || c === 0x2029) continue;
    if ((c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069)) continue;
    out += ch;
  }
  return out;
}
