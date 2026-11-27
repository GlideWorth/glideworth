/**
 * Nothing a visitor types leaves the browser, except what they ask to have emailed to them. Three checks:
 *  1. The calculators' source (modules, worker, components, pages) uses no network or storage API. The one
 *     exception, the optional "Email me this result" form (components/CalculatorEmail.astro and
 *     lib/calculator-email.ts, outside these folders), posts its own form to this origin when submitted, and
 *     nothing else: checked separately.
 *  2. After a build, every script a calculator page can load (page script, the chunks it imports, the
 *     engine worker and the main-thread fallback) contains none either, engine included. When dist/
 *     is missing (tests run before a build), the second check is skipped with a note.
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
      for (const page of walk(join(dist, "tools")).filter((f) => f.endsWith("index.html"))) {
        const html = readFileSync(page, "utf8");
        // The calculator's own script (the site shell's theme toggle, which remembers only the theme, is not ours).
        for (const m of html.matchAll(/<script[^>]+src="\/_astro\/(ToolPage[^"]+\.js)"/g))
          queue.push(m[1]!);
        expect(html, page).not.toMatch(/<script[^>]+src="https?:/);
        expect(html, page).not.toMatch(/googletagmanager|google-analytics|gtag\(/);
        expect(html, page).not.toMatch(/glideworth-posthog|PostHog\.astro/);
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
      }
      expect([...seen].some((n) => n.startsWith("ToolPage"))).toBe(true);
      expect([...seen].some((n) => n.startsWith("engine.worker"))).toBe(true);
    },
  );
});
