/** Remove C0 control characters and DEL (names are free text shown in emails and the UI). */
export function stripControl(s: string): string {
  let out = "";
  for (const ch of s) {
    const c = ch.codePointAt(0) as number;
    if (c > 0x1f && c !== 0x7f) out += ch;
  }
  return out;
}
