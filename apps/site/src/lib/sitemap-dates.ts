/**
 * Last-modified date for one sitemap URL. Never the clock of the build.
 *
 * A content page uses its own frontmatter. An updated-style field wins over a published date:
 * updatedDate, updated, lastUpdated, lastChecked, checkedOn, then pubDate, published, date.
 * A listing (the blog index, the changelog, and the other collection indexes) uses the newest
 * of those dates across the entries it shows. Anything else uses the last commit of the source
 * file. A shallow checkout cannot see that commit when the file was not touched by the tip, so
 * the committed snapshot in src/data/source-dates.json (the same git date, recorded while history
 * was complete) fills in. Regenerate it with `pnpm snapshot:dates`.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const UPDATED_FIELDS = ["updatedDate", "updated", "lastUpdated", "lastChecked", "checkedOn"];
const PUBLISHED_FIELDS = ["pubDate", "published", "date"];

/** Collection indexes: the page has no date of its own, so the newest entry date is the page's. */
const LISTING_DIRS: Record<string, string> = {
  "/blog/": "src/content/blog",
  "/changelog/": "src/content/changelog",
  "/compare/": "src/content/compare",
  "/docs/": "src/content/docs",
  "/features/": "src/content/features",
  "/legal/": "src/content/legal",
  "/planning/": "src/content/countries",
};

export interface LastmodSources {
  /** Site-relative path to file text, or undefined when that path is not a file. */
  read(siteRelative: string): string | undefined;
  /** Site-relative files under a directory (recursive). Empty when the directory is absent. */
  list(siteRelativeDir: string): string[];
  /** Repo-relative path to YYYY-MM-DD, or undefined when git has no commit for it. */
  gitDate(repoRelative: string): string | undefined;
  committed: Readonly<Record<string, string>>;
  /** Path of apps/site inside the repo, for example "apps/site". Empty when the site is the repo. */
  repoPrefix: string;
}

const siteRoot = fileURLToPath(new URL("../..", import.meta.url));

export function canonicalPath(pathname: string): string {
  const withSlash = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return withSlash.endsWith("/") ? withSlash : `${withSlash}/`;
}

/** A real calendar day, or undefined. `new Date("2026-11-16")` is accepted; an impossible day is not. */
export function isoDay(value: string): string | undefined {
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

/** The frontmatter date of a markdown file, ignoring dates that appear in the body. */
export function dateFromFrontmatter(source: string): string | undefined {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source)?.[1];
  if (frontmatter === undefined) return undefined;
  const fields = new Map<string, string>();
  for (const line of frontmatter.split("\n")) {
    const field = /^([A-Za-z]\w*)\s*:\s*["']?(\d{4}-\d{2}-\d{2})\b/.exec(line);
    if (!field?.[1] || !field[2]) continue;
    const day = isoDay(field[2]);
    if (day) fields.set(field[1], day);
  }
  for (const key of [...UPDATED_FIELDS, ...PUBLISHED_FIELDS]) {
    const day = fields.get(key);
    if (day) return day;
  }
  return undefined;
}

function isDraft(source: string): boolean {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source)?.[1];
  return frontmatter !== undefined && /^draft:\s*true\s*$/m.test(frontmatter);
}

/**
 * Site-relative files that could be the page, content file first. The shared template
 * (`[slug].astro`) is not a candidate: its commit date is not the page's.
 */
export function sourceCandidates(pathname: string): string[] {
  const path = canonicalPath(pathname);
  if (path === "/") return ["src/pages/index.astro"];
  const rel = path.slice(1, -1);
  const candidates: string[] = [];
  const content = (dir: string, id: string) => {
    candidates.push(`src/content/${dir}/${id}.mdx`, `src/content/${dir}/${id}.md`);
  };
  if (rel.startsWith("blog/") && !rel.startsWith("blog/tags/")) content("blog", rel.slice(5));
  else if (rel.startsWith("docs/")) content("docs", rel.slice(5));
  else if (rel.startsWith("planning/") && !rel.slice(9).includes("/"))
    content("countries", rel.slice(9));
  else if (rel.startsWith("compare/")) content("compare", rel.slice(8));
  else if (rel.startsWith("features/") && !rel.slice(9).includes("/"))
    content("features", rel.slice(9));
  else if (rel.startsWith("legal/")) content("legal", rel.slice(6));
  else if (rel.startsWith("authors/")) candidates.push("src/content/authors/authors.json");
  candidates.push(`src/pages/${rel}.astro`, `src/pages/${rel}/index.astro`);
  return candidates;
}

function repoKey(sources: LastmodSources, siteRelative: string): string {
  return sources.repoPrefix ? `${sources.repoPrefix}/${siteRelative}` : siteRelative;
}

function newestEntryDate(dir: string, sources: LastmodSources): string | undefined {
  let best: string | undefined;
  for (const file of sources.list(dir)) {
    if (!file.endsWith(".md") && !file.endsWith(".mdx")) continue;
    const text = sources.read(file);
    if (text === undefined || isDraft(text)) continue;
    const day = dateFromFrontmatter(text);
    if (day && (best === undefined || day > best)) best = day;
  }
  return best;
}

export function lastmodForPath(pathname: string, sources: LastmodSources): string | undefined {
  const path = canonicalPath(pathname);
  let sourceRel: string | undefined;
  let sourceText: string | undefined;
  for (const candidate of sourceCandidates(path)) {
    const text = sources.read(candidate);
    if (text === undefined) continue;
    sourceRel = candidate;
    sourceText = text;
    break;
  }
  if (
    sourceRel &&
    sourceText !== undefined &&
    (sourceRel.endsWith(".md") || sourceRel.endsWith(".mdx"))
  ) {
    const dated = dateFromFrontmatter(sourceText);
    if (dated) return dated;
  }
  const listing = LISTING_DIRS[path];
  if (listing) {
    const newest = newestEntryDate(listing, sources);
    if (newest) return newest;
  }
  if (!sourceRel) return undefined;
  const key = repoKey(sources, sourceRel);
  return sources.gitDate(key) ?? sources.committed[key];
}

/** Newest commit date per path, from `git log --name-only --pretty=format:%cs` (newest first). */
export function parseGitNameLog(text: string): Map<string, string> {
  const dates = new Map<string, string>();
  let date = "";
  for (const line of text.split("\n")) {
    const day = isoDay(line);
    if (day) date = day;
    else if (line && date && !dates.has(line)) dates.set(line, date);
  }
  return dates;
}

export function gitCommitDates(repoRoot: string): Map<string, string> {
  try {
    const text = execFileSync("git", ["log", "--name-only", "--pretty=format:%cs"], {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return parseGitNameLog(text);
  } catch {
    return new Map();
  }
}

export function findRepoRoot(start: string): string {
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}

function listFiles(dir: string, root: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (current: string) => {
    for (const name of readdirSync(current)) {
      const path = join(current, name);
      if (statSync(path).isDirectory()) walk(path);
      else out.push(relative(root, path).split(sep).join("/"));
    }
  };
  walk(dir);
  return out;
}

export function readSourceDates(root: string): Record<string, string> {
  const file = join(root, "src", "data", "source-dates.json");
  if (!existsSync(file)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const dates: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== "string") continue;
    const day = isoDay(value);
    if (day) dates[key] = day;
  }
  return dates;
}

let cached: LastmodSources | undefined;

export function siteLastmodSources(): LastmodSources {
  if (cached) return cached;
  const repoRoot = findRepoRoot(siteRoot);
  const repoPrefix = relative(repoRoot, siteRoot).split(sep).join("/");
  const git = gitCommitDates(repoRoot);
  const committed = readSourceDates(siteRoot);
  cached = {
    repoPrefix,
    committed,
    gitDate: (path) => git.get(path),
    read: (path) => {
      const file = join(siteRoot, path);
      if (!existsSync(file) || !statSync(file).isFile()) return undefined;
      return readFileSync(file, "utf8");
    },
    list: (dir) => listFiles(join(siteRoot, dir), siteRoot),
  };
  return cached;
}

/** Absolute sitemap URL to YYYY-MM-DD, or undefined when no real date can be found. */
export function lastmodForUrl(pageUrl: string): string | undefined {
  let pathname = pageUrl;
  try {
    pathname = new URL(pageUrl).pathname;
  } catch {
    // A path rather than an absolute URL: use it as given.
  }
  return lastmodForPath(pathname, siteLastmodSources());
}
