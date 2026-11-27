/**
 * What the marketing site's PostHog may send, applied to every event in `before_send` (posthog-client.ts).
 *
 * The calculators under `/tools/` write the visitor's inputs into the page address (`?key=value`, ui/mount.ts),
 * and their results are text on the page. So, before anything leaves the browser:
 *  - On every page, every URL loses its query string and fragment: the current URL, the referrer (a visit to
 *    another page after a calculator has the calculator's address as its referrer), the session-entry and initial
 *    URLs, the keys of heatmap data, URLs nested in web vitals or element data, and any other string that is an
 *    absolute http(s) URL. posthog-js reads campaign tags (`utm_source`, …) from the address into their own
 *    properties before this runs, so those survive; no calculator input is named like one (posthog.test.ts).
 *  - On calculator pages, element text goes too (posthog-client.ts also sets `mask_all_text` there), as do the
 *    properties that can hold text or values a visitor typed or selected, and copy/cut events.
 * Pure functions with no posthog-js import, so tests can run them on recorded events.
 */

/** Property names that hold a URL or part of one (`$current_url`, `$referrer`, `$session_entry_url`, `attr__href`, …). */
const URL_KEY = /url|referrer|href|pathname/i;
const ABSOLUTE_URL = /^https?:\/\//i;
/** Nested objects (web vitals, element lists, `$set_once`) are scrubbed this deep; posthog-js nests two or three. */
const MAX_DEPTH = 8;
/** Text a visitor typed, selected or that the page shows; dropped on calculator pages whatever the config says. */
const TEXT_KEYS = new Set([
  "$el_text",
  "$selected_content",
  "$input_value",
  "$clipboard_text_length",
]);
/** Events that exist only to carry text, dropped on calculator pages. */
const TEXT_EVENTS = new Set(["$copy_autocapture"]);

/** A `/tools/` page: the calculators and their index. */
export function isCalculatorPath(pathname: string): boolean {
  const path = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return path === "/tools" || path.startsWith("/tools/");
}

/** Drop the query string and fragment. */
export function scrubUrl(value: string): string {
  return value.split(/[?#]/, 1)[0] ?? "";
}

/**
 * An autocapture elements chain (`a.cls:attr__href="…"href="…"nth-child="1"nth-of-type="1"text="…";div:…`):
 * attributes follow `:` or the previous attribute's closing quote.
 */
const CHAIN_TEXT = /(^|[:"])text="/;
const CHAIN_HREF = /(?<=^|[:"])((?:attr__)?href=")((?:[^"\\?#]|\\.)*)[?#](?:[^"\\]|\\.)*"/g;

function scrubChain(chain: string, calculator: boolean): string | undefined {
  // Text cannot be cut out of the chain reliably (quotes inside it are escaped, backslashes are not), so a
  // calculator page's chain that has any is dropped whole.
  if (calculator && CHAIN_TEXT.test(chain)) return undefined;
  return chain.replace(CHAIN_HREF, '$1$2"');
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function scrubValue(value: unknown, key: string, calculator: boolean, depth: number): unknown {
  if (typeof value === "string") {
    if (URL_KEY.test(key) || ABSOLUTE_URL.test(value)) return scrubUrl(value);
    if (key === "$elements_chain") return scrubChain(value, calculator);
    return value;
  }
  if (depth > MAX_DEPTH) return value;
  if (Array.isArray(value))
    return value.map((item) => scrubValue(item, key, calculator, depth + 1));
  if (!isRecord(value)) return value;
  if (key === "$heatmap_data") {
    // Heatmap points are keyed by page URL; merge the points of keys that become equal.
    const out: Record<string, unknown> = {};
    for (const [url, points] of Object.entries(value)) {
      const k = scrubUrl(url);
      const before = out[k];
      out[k] = Array.isArray(before) && Array.isArray(points) ? [...before, ...points] : points;
    }
    return out;
  }
  return scrubRecord(value, calculator, depth + 1);
}

function scrubRecord(
  record: Record<string, unknown>,
  calculator: boolean,
  depth: number,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(record)) {
    if (calculator && TEXT_KEYS.has(k)) continue;
    const value = scrubValue(v, k, calculator, depth);
    if (value !== undefined) out[k] = value;
  }
  return out;
}

/** The parts of a posthog-js `CaptureResult` this file touches. */
export interface ScrubbableEvent {
  event: string;
  properties?: Record<string, unknown>;
  $set?: Record<string, unknown>;
  $set_once?: Record<string, unknown>;
}

/**
 * `before_send` for the site. `onCalculatorPage` is where the page was when PostHog started; the event's own
 * `$pathname` counts too, so either one marks the event as a calculator page's. Returns null to drop the event.
 */
export function scrubSiteEvent<E extends ScrubbableEvent>(
  event: E | null,
  onCalculatorPage: boolean,
): E | null {
  if (!event) return event;
  const pathname = event.properties?.$pathname;
  const calculator =
    onCalculatorPage || (typeof pathname === "string" && isCalculatorPath(pathname));
  if (calculator && TEXT_EVENTS.has(event.event)) return null;
  const out = { ...event };
  if (event.properties) out.properties = scrubRecord(event.properties, calculator, 0);
  if (event.$set) out.$set = scrubRecord(event.$set, calculator, 0);
  if (event.$set_once) out.$set_once = scrubRecord(event.$set_once, calculator, 0);
  return out;
}
