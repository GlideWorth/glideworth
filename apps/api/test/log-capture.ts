/**
 * T-LOG (design 6.4, 10): every API test file runs with a capturing log sink (installed by
 * `log-capture.setup.ts`), and after the file the captured lines are checked: JSON with allowlisted keys only,
 * and no email address, credential, share token, query string, synthetic amount, or household, plan or person
 * name of the fixtures. Cloud tests feed the cloud package's logger into the same sink (cloud-harness.ts).
 */
import { LOG_FIELD_ALLOWLIST } from "../src/log.js";

export const captured: string[] = [];
export const captureLine = (line: string): void => {
  captured.push(line);
};

/** Fixture values that must never reach a log line (names, figures, markers of the test data). */
export const FORBIDDEN_VALUES = [
  // synthetic sample (packages/core samples) and the cloud tests' markers
  "Avery",
  "Jordan",
  "Robin Example",
  "Zephyrine",
  "Quillon",
  "Marravel",
  "Ostrava",
  "918273.64",
  "503112.27",
  "612034.18",
  "777001.5",
];

const PATTERNS: Array<[string, RegExp]> = [
  ["email address", /[^\s@"]+@[^\s@"]+\.[a-z]{2,}/i],
  ["credential", /\b(glideworth|cairn)_[a-z]+_|\bgw[karcs]_t[a-z2-7]{15}|whsec_|scrypt\$/],
  ["query string", /\?[A-Za-z_][A-Za-z0-9_]*=/],
];

const ALLOWED_KEYS = new Set<string>([
  ...LOG_FIELD_ALLOWLIST,
  "level",
  "time",
  "event",
  "droppedFields",
]);

/** Problems in the captured lines (empty = clean). */
export function logProblems(lines: readonly string[] = captured): string[] {
  const out: string[] = [];
  for (const line of lines) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      out.push(`not JSON: ${line.slice(0, 80)}`);
      continue;
    }
    for (const k of Object.keys(parsed))
      if (!ALLOWED_KEYS.has(k)) out.push(`field ${k} in ${String(parsed.event)}`);
    for (const v of FORBIDDEN_VALUES)
      if (line.includes(v)) out.push(`fixture value ${v} in ${String(parsed.event)}`);
    // Stack frames are code locations (pnpm store paths contain `name@version`): checked for credentials only.
    const { stack, ...rest } = parsed;
    for (const [what, re] of PATTERNS)
      if (re.test(JSON.stringify(rest)) || (what === "credential" && re.test(String(stack ?? ""))))
        out.push(`${what} in ${String(parsed.event)}`);
  }
  return out;
}
