/**
 * Nothing a visitor types leaves the browser, except what they ask to have emailed to them. Calculator pages
 * run the site's PostHog in the official hosted build, like every marketing page; what it may send is the
 * business of lib/posthog-scrub.ts and its tests, which strip inputs and figures from every event. Here:
 *  1. The calculators' source (modules, worker, components, pages) uses no network or storage API and never
 *     imports the PostHog SDK or the script that starts it. The one exception, the optional "Email me this result" form
 *     (components/CalculatorEmail.astro and lib/calculator-email.ts, outside these folders), posts its own form
 *     to this origin when submitted, and nothing else: checked separately.
 *  2. After a build, every script the calculator itself loads (page script, the chunks it imports, the engine
 *     worker and the main-thread fallback) contains none either, engine included, and does not reach the
 *     PostHog SDK. If the build has PostHog on calculator pages, it is the site's own same-origin script, and
 *     it starts PostHog with the scrubbing `before_send`, text masking and no session recording. When dist/ is
 *     missing (tests run before a build), the second check is skipped with a note.
 * The browser check (network log during real use) is part of the manual verification in README.md.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { site } from "../config/site";

const siteRoot = join(import.meta.dirname, "../..");
const FORBIDDEN: [string, RegExp][] = [
  ["fetch()", /\bfetch\s*\(/],
  ["XMLHttpRequest", /XMLHttpRequest/],
  ["sendBeacon", /sendBeacon/],
  ["WebSocket", /WebSocket/],
  ["EventSource", /EventSource/],
  ["localStorage", /localStorage/],
  ["sessionStorage", /sessionStorage/],
  ["indexedDB", /indexedDB/],
  ["document.cookie", /document\.cookie/],
  ["importScripts", /importScripts/],
  ["new Image()", /new\s+Image\s*\(/],
  ["remote import", /import\s*\(\s*['"`]https?:/],
];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

describe("no data leaves the browser", () => {
  it("calculator source uses no network or storage API", () => {
    const files = ["src/tools", "src/components/tools", "src/pages/tools"]
      .flatMap((d) => walk(join(siteRoot, d)))
      .filter((f) => /\.(ts|astro)$/.test(f) && !f.endsWith(".test.ts"));
    expect(files.length).toBeGreaterThan(20);
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      for (const [name, re] of FORBIDDEN) expect(re.test(text), `${name} in ${f}`).toBe(false);
      // The SDK and the script that starts it (lib/posthog.ts, the build-time config check, may be read).
      expect(text, f).not.toMatch(/posthog-js|posthog-client|posthog-scrub/);
    }
  });

  it("the email form posts only its own form, to this origin, only when submitted, and stores nothing", () => {
    const client = readFileSync(join(siteRoot, "src/lib/calculator-email.ts"), "utf8");
    const fetches = [...client.matchAll(/\bfetch\s*\(/g)];
    expect(fetches).toHaveLength(1);
    expect(client).toMatch(/\.fetch\(form\.action, \{/);
    expect(client).toMatch(/form\.addEventListener\("submit"/);
    for (const [name, re] of FORBIDDEN.filter(([n]) => n !== "fetch()"))
      expect(re.test(client), `${name} in lib/calculator-email.ts`).toBe(false);
    const component = readFileSync(join(siteRoot, "src/components/CalculatorEmail.astro"), "utf8");
    expect(component).toContain("action={site.calculatorEmailPath}");
    for (const [name, re] of FORBIDDEN)
      expect(re.test(component), `${name} in CalculatorEmail.astro`).toBe(false);
    // A path on this origin, never another site.
    expect(site.calculatorEmailPath).toMatch(/^\/[a-z]/);
  });

  const dist = join(siteRoot, "dist");
  const built = existsSync(join(dist, "tools", "coast-fire-calculator", "index.html"));
  it.skipIf(!built)(
    "built calculator scripts, the engine worker included, use no network or storage API",
    () => {
      const astro = join(dist, "_astro");
      const names = new Set(readdirSync(astro).filter((n) => n.endsWith(".js")));
      const queue: string[] = [];
      const postHogScripts = new Set<string>();
      for (const page of walk(join(dist, "tools")).filter((f) => f.endsWith("index.html"))) {
        const html = readFileSync(page, "utf8");
        for (const m of html.matchAll(/<script[^>]+src="\/_astro\/(ToolPage[^"]+\.js)"/g))
          queue.push(m[1]!);
        for (const m of html.matchAll(/<script[^>]+src="\/_astro\/(PostHog\.astro[^"]+\.js)"/g))
          postHogScripts.add(m[1]!);
        expect(html, page).not.toMatch(/<script[^>]+src="https?:/);
        expect(html, page).not.toMatch(/googletagmanager|google-analytics|gtag\(/);
        // PostHog comes with its meta tag or not at all (a self-hosted build has neither).
        expect(html.includes('name="glideworth-posthog"'), page).toBe(/PostHog\.astro/.test(html));
      }
      for (const n of postHogScripts) {
        const text = readFileSync(join(astro, n), "utf8");
        expect(text, n).toMatch(/before_send:/);
        expect(text, n).toMatch(/mask_all_text:/);
        expect(text, n).toMatch(/mask_all_element_attributes:!0/);
        expect(text, n).toMatch(/disable_session_recording:!0/);
        expect(text, n).not.toMatch(/capture_value_css_selector_allowlist/);
      }
      const seen = new Set<string>();
      while (queue.length) {
        const n = queue.pop()!;
        if (seen.has(n) || !names.has(n)) continue;
        seen.add(n);
        const text = readFileSync(join(astro, n), "utf8");
        // Follow every chunk this one names: static and dynamic imports and the worker URL.
        for (const m of text.matchAll(/([\w.-]+\.js)/g)) if (names.has(m[1]!)) queue.push(m[1]!);
        for (const [name, re] of FORBIDDEN) expect(re.test(text), `${name} in ${n}`).toBe(false);
        expect(text, n).not.toMatch(/posthog/i);
      }
      expect([...seen].some((n) => n.startsWith("ToolPage"))).toBe(true);
      expect([...seen].some((n) => n.startsWith("engine.worker"))).toBe(true);
    },
  );
});
