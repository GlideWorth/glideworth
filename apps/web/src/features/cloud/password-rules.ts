/**
 * The server's password policy (packages/cloud password.ts `assertPasswordPolicy`), checked in the browser
 * first so the person sees what is wrong before sending anything: 12-1024 characters, not the email
 * address or its local part, and not containing a local part of 4 or more characters. The server stays the
 * authority; `WEAK_PASSWORD` answers are shown as they come.
 */
const MIN_PASSWORD = 12;
const MAX_PASSWORD = 1024;

export function passwordProblem(password: string, email: string): string | null {
  const len = [...password].length;
  if (len < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters (you have ${len}).`;
  if (len > MAX_PASSWORD) return `Use at most ${MAX_PASSWORD} characters.`;
  const pw = password.normalize("NFKC").toLowerCase().trim();
  const addr = email.normalize("NFKC").toLowerCase().trim();
  const local = addr.split("@")[0] ?? "";
  if (addr && (pw === addr || (local && pw === local) || (local.length >= 4 && pw.includes(local))))
    return "Do not use your email address, or the part before the @, in your password.";
  return null;
}

export const PASSWORD_RULES = `At least ${MIN_PASSWORD} characters, without your email address or the part before the @. A few unrelated words is easy to remember and hard to guess.`;
