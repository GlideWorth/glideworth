/**
 * WCAG contrast check for the colour tokens in src/styles/tokens.css, in both themes.
 * Text pairs need 4.5:1 (AA, normal text); large display text and UI parts need 3:1.
 * Run: `pnpm check:contrast`. Add a pair below when you add a token that carries text.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const css = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "src", "styles", "tokens.css"),
  "utf8",
);
const tokens = { light: {}, dark: {} };
for (const m of css.matchAll(/--([\w-]+):\s*light-dark\((#[0-9a-f]{6}),\s*(#[0-9a-f]{6})\)/gi)) {
  tokens.light[m[1]] = m[2];
  tokens.dark[m[1]] = m[3];
}
for (const m of css.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6});/gi)) {
  tokens.light[m[1]] ??= m[2];
  tokens.dark[m[1]] ??= m[2];
}

function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function ratio(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

const TEXT = 4.5;
const LARGE = 3;
// [foreground, background, minimum]
const pairs = [
  ...["bg", "surface", "surface-2"].flatMap((bg) => [
    ["ink", bg, TEXT],
    ["ink-2", bg, TEXT],
    ["ink-3", bg, TEXT],
    ["accent-text", bg, TEXT],
    ["ochre", bg, TEXT],
    ["risk", bg, TEXT],
    ["focus", bg, LARGE],
    ["line-strong", bg, 1.4],
  ]),
  ["accent-ink", "accent", TEXT],
  ["accent-ink", "accent-hover", TEXT],
  ["accent-text", "accent-soft", TEXT],
  ["ink", "accent-soft", TEXT],
  ["ochre", "ochre-soft", TEXT],
  ["ink", "ochre-soft", TEXT],
  ["ink-2", "ochre-soft", TEXT],
  ["risk", "risk-soft", TEXT],
  ["ink", "risk-soft", TEXT],
  ["ink-3", "code-bg", TEXT],
  ["band-ink", "band", TEXT],
  ["band-ink-2", "band", TEXT],
  ["band-accent", "band", TEXT],
  ["band-ink", "band-2", TEXT],
  ["band-ink-2", "band-2", TEXT],
];

let failures = 0;
for (const theme of ["light", "dark"]) {
  console.log(`\n${theme}`);
  for (const [fg, bg, min] of pairs) {
    const a = tokens[theme][fg];
    const b = tokens[theme][bg];
    if (!a || !b) {
      console.log(`  ?  ${fg} on ${bg}: token missing`);
      failures++;
      continue;
    }
    const r = ratio(a, b);
    const ok = r >= min;
    if (!ok) failures++;
    console.log(`  ${ok ? "ok" : "FAIL"}  ${fg} on ${bg}: ${r.toFixed(2)} (needs ${min})`);
  }
}
if (failures) {
  console.error(`\n${failures} pair(s) below the minimum.`);
  process.exit(1);
}
console.log("\nAll pairs meet their minimum.");
