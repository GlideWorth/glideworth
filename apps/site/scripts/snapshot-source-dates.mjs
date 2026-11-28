/**
 * Writes src/data/source-dates.json: the last commit date (YYYY-MM-DD) of every file under
 * src/pages, src/content and src/landing (the country versions of the home page). The sitemap uses
 * this when `git log` cannot see the file, which is what a shallow checkout (one commit) does for
 * anything the tip did not touch.
 *
 *   pnpm --filter @glideworth/site snapshot:dates
 *
 * Run it when those files change and commit the result. src/lib/sitemap-dates.test.ts fails on a
 * full clone when the snapshot has drifted. The date parser must stay in step with parseGitNameLog
 * in src/lib/sitemap-dates.ts.
 */
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const siteRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(siteRoot, "..", "..");
const out = join(siteRoot, "src", "data", "source-dates.json");
const roots = ["apps/site/src/pages/", "apps/site/src/content/", "apps/site/src/landing/"];

function isoDay(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return undefined;
  }
  return value;
}

const text = execFileSync("git", ["log", "--name-only", "--pretty=format:%cs"], {
  cwd: repoRoot,
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
});

const dates = {};
let date = "";
for (const line of text.split("\n")) {
  const day = isoDay(line);
  if (day) date = day;
  else if (
    line &&
    date &&
    dates[line] === undefined &&
    roots.some((root) => line.startsWith(root))
  ) {
    if (existsSync(join(repoRoot, line))) dates[line] = date;
  }
}

const sorted = Object.fromEntries(
  Object.entries(dates).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
);
writeFileSync(out, `${JSON.stringify(sorted, null, 2)}\n`);
console.log(`Wrote ${Object.keys(sorted).length} dates to ${out}`);
