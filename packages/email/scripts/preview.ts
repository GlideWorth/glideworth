/**
 * Renders every template with synthetic sample data to an output directory for visual review.
 * Usage: pnpm --filter @glideworth/email preview [outDir]   (default: packages/email/.preview)
 * Writes nothing anywhere else and sends nothing.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { render, TEMPLATE_CATEGORY, TEMPLATE_IDS } from "../src/index.js";
import { CHECKIN_CTX, CTX, FIXTURES } from "../test/fixtures.js";

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(process.argv[2] ?? join(here, "..", ".preview"));
mkdirSync(out, { recursive: true });

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const rows: string[] = [];
for (const id of TEMPLATE_IDS) {
  const r = render(
    id,
    FIXTURES[id] as never,
    TEMPLATE_CATEGORY[id] === "checkin" ? CHECKIN_CTX : CTX,
  );
  writeFileSync(join(out, `${id}.html`), r.html);
  writeFileSync(join(out, `${id}.txt`), `Subject: ${r.subject}\n\n${r.text}`);
  rows.push(
    `<tr><td><a href="${id}.html">${id}</a></td><td>${r.category}</td><td>${esc(r.subject)}</td><td><a href="${id}.txt">text</a></td></tr>`,
  );
}
writeFileSync(
  join(out, "index.html"),
  `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><title>Email previews</title></head>\n<body style="font-family:sans-serif;margin:24px"><h1>Email previews (synthetic data)</h1>\n<table cellpadding="6"><tr><th align="left">Template</th><th align="left">Category</th><th align="left">Subject</th><th></th></tr>\n${rows.join("\n")}\n</table></body></html>\n`,
);
console.log(`Rendered ${TEMPLATE_IDS.length} templates to ${out}`);
