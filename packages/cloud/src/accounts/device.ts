/**
 * Human-readable device text from a user agent ("Firefox on macOS"), for the sessions list and sign-in alerts.
 * Deliberately coarse: no versions, so the text is not a fingerprint and never carries arbitrary UA content.
 */
const BROWSERS: Array<[RegExp, string]> = [
  [/edg(e|a|ios)?\//i, "Edge"],
  [/opr\/|opera/i, "Opera"],
  [/firefox\/|fxios\//i, "Firefox"],
  [/chrome\/|crios\//i, "Chrome"],
  [/safari\//i, "Safari"],
  [/curl\//i, "curl"],
];
const SYSTEMS: Array<[RegExp, string]> = [
  [/iphone|ipad|ios/i, "iOS"],
  [/android/i, "Android"],
  [/mac os x|macintosh/i, "macOS"],
  [/windows/i, "Windows"],
  [/cros/i, "ChromeOS"],
  [/linux/i, "Linux"],
];

export function describeDevice(userAgent: string | null | undefined): string {
  if (!userAgent) return "Unknown device";
  const ua = userAgent.slice(0, 512);
  const browser = BROWSERS.find(([re]) => re.test(ua))?.[1];
  const os = SYSTEMS.find(([re]) => re.test(ua))?.[1];
  if (browser && os) return `${browser} on ${os}`;
  return browser ?? os ?? "Unknown device";
}
