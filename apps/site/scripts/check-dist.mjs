/**
 * Checks the built site in dist/ (run `pnpm build` first, then `pnpm check:dist`).
 *
 * Errors (exit 1):
 *  - every page has one viewport meta with width=device-width that does not block zooming
 *  - every page has exactly one <title>, one <h1>, a meta description and a canonical URL that is
 *    https://glideworth.com/<own path> with the trailing slash; indexable pages have unique titles and
 *    descriptions; titles over 70 characters and descriptions over 180 are errors
 *  - the Open Graph image of every page exists in dist/
 *  - every JSON-LD block parses; posts carry Article, nested pages BreadcrumbList, FAQ blocks FAQPage
 *  - every image has an alt attribute (alt="" is fine for decoration)
 *  - RESOURCES THE PAGE LOADS (script, style, image, font, iframe, preload, srcset, CSS url(), @import) stay
 *    on this origin and exist. The one exception is Google Tag Manager, and only on a page whose HTML
 *    contains the loader (a build with PUBLIC_GTM_ID set). A default build has no such page.
 *  - HYPERLINKS (<a href>): internal ones resolve and end with a slash; external ones may point at any
 *    https origin but must carry rel="noopener noreferrer"; plain http: links are errors
 *  - the sitemap lists every indexable page and no noindex page, and every URL has a calendar lastmod
 *    (frontmatter, not the build clock: the Coast FIRE post is 2026-11-16); tag archives are
 *    noindex, follow; sitemap.xml is a byte-for-byte copy of
 *    sitemap-index.xml; robots.txt points at both; .well-known/security.txt has a Contact, this site's
 *    Canonical and an Expires at least 30 days away; rss.xml lists
 *    every published post; XML is well-formed (when xmllint is available)
 *
 * Warnings (listed, exit 0): titles over 60 characters, descriptions over 160 or under 50.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, posix, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const SITE = "https://glideworth.com";

const TITLE_WARN = 60;
const TITLE_ERROR = 70;
const DESC_WARN = 160;
const DESC_ERROR = 180;
const DESC_MIN = 50;

const errors = [];
const warnings = [];
const notes = [];
const fail = (file, msg) => errors.push(`${file}: ${msg}`);
const warn = (file, msg) => warnings.push(`${file}: ${msg}`);

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

if (!existsSync(dist)) {
  console.error("dist/ not found: run `pnpm build` first.");
  process.exit(1);
}

const files = walk(dist);
const html = files.filter((f) => f.endsWith(".html"));
const css = files.filter((f) => f.endsWith(".css"));

/** Resolves a site path to a file in dist, following the directory build format. */
function exists(sitePath) {
  const clean = decodeURI(sitePath.split("#")[0].split("?")[0]);
  if (!clean) return true;
  const p = join(dist, clean);
  if (clean.endsWith("/")) return existsSync(join(p, "index.html"));
  return existsSync(p) && statSync(p).isFile();
}

const decode = (v) =>
  v
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
const TAG =
  /<([a-zA-Z][\w:-]*)((?:\s+[^\s"'<>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'<>]+))?)*)\s*\/?>/g;
const ATTR = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>]+)))?/g;

function attrsOf(raw) {
  const out = {};
  for (const m of raw.matchAll(ATTR)) out[m[1].toLowerCase()] = decode(m[2] ?? m[3] ?? m[4] ?? "");
  return out;
}

const isAbsolute = (u) => /^(https?:)?\/\//i.test(u);
const isSameSite = (u) => u.startsWith(`${SITE}/`) || u === SITE;
const urlsIn = (srcset) =>
  srcset
    .split(",")
    .map((c) => c.trim().split(/\s+/)[0])
    .filter(Boolean);

const titles = new Map();
const descriptions = new Map();
const indexable = new Set();
const noindex = new Set();
const posts = new Set();
const redirects = [];

/**
 * Hosts the GTM loader is allowed to contact. Permitted only when this page's HTML contains the loader,
 * so a default build (no PUBLIC_GTM_ID) still rejects every third-party URL.
 */
function allowedTagOrigin(url, raw) {
  if (!raw.includes("https://www.googletagmanager.com/gtm.js")) return false;
  let host;
  try {
    host = new URL(url, SITE).hostname;
  } catch {
    return false;
  }
  return (
    host === "www.googletagmanager.com" ||
    host === "www.google-analytics.com" ||
    host === "ssl.google-analytics.com" ||
    host === "www.google.com" ||
    host.endsWith(".google-analytics.com") ||
    host.endsWith(".analytics.google.com") ||
    host.endsWith(".googletagmanager.com")
  );
}

/** A resource the page loads: same origin only, and it must exist. */
function checkLoad(rel, sitePath, what, url, raw) {
  if (!url || url.startsWith("data:") || url.startsWith("#")) return;
  if (isAbsolute(url) && !isSameSite(url)) {
    if (allowedTagOrigin(url, raw)) return;
    fail(rel, `loads from another origin: ${what} ${url}`);
    return;
  }
  const local = isSameSite(url) ? url.slice(SITE.length) || "/" : url;
  const resolved = local.startsWith("/") ? local : posix.join(sitePath, local);
  if (!exists(resolved)) fail(rel, `missing file for ${what}: ${url}`);
}

/** CSS text: url() and @import must be same-origin (and local files must exist). */
function checkCss(rel, sheetPath, text, what, raw) {
  for (const m of text.matchAll(/url\(\s*(['"]?)([^)'"]+)\1\s*\)/g)) {
    const u = decode(m[2].trim());
    if (u.startsWith("data:") || u.startsWith("#")) continue;
    if (isAbsolute(u) && !isSameSite(u)) {
      if (!allowedTagOrigin(u, raw)) fail(rel, `${what} loads from another origin: url(${u})`);
    } else if (u.startsWith("/") && !exists(u)) fail(rel, `${what} references missing file: ${u}`);
    else if (!u.startsWith("/") && !isAbsolute(u) && sheetPath) {
      const resolved = posix.join(posix.dirname(sheetPath), u.split(/[?#]/)[0]);
      if (!exists(resolved)) fail(rel, `${what} references missing file: ${u}`);
    }
  }
  for (const m of text.matchAll(/@import\s+(?:url\(\s*)?(['"]?)([^'")\s;]+)\1/g)) {
    if (isAbsolute(m[2]) && !isSameSite(m[2]))
      fail(rel, `${what} imports from another origin: ${m[2]}`);
  }
}

function jsonLdTypes(blocks) {
  const types = new Set();
  const visit = (node) => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== "object") return;
    const t = node["@type"];
    for (const x of Array.isArray(t) ? t : t ? [t] : []) types.add(x);
    for (const v of Object.values(node)) visit(v);
  };
  for (const b of blocks) visit(b);
  return types;
}

for (const file of html) {
  const rel = relative(dist, file);
  const raw = readFileSync(file, "utf8");
  // A redirect stub (astro.config.ts `redirects`): nothing to check except that its target exists.
  const redirect = raw.match(/<meta http-equiv="refresh" content="\d+;\s*url=([^"]+)"/)?.[1];
  if (redirect) {
    redirects.push(rel);
    if (!exists(redirect)) fail(rel, `redirects to a page that does not exist: ${redirect}`);
    continue;
  }
  const sitePath = `/${rel.replace(/index\.html$/, "").replace(/\.html$/, "/")}`;
  const isNoindex = /<meta name="robots" content="[^"]*noindex/.test(raw);
  (isNoindex ? noindex : indexable).add(sitePath);

  // JSON-LD first, then strip scripts, styles and comments so their text is not scanned as markup.
  const jsonLd = [];
  for (const m of raw.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)) {
    try {
      const data = JSON.parse(m[1]);
      jsonLd.push(data);
      if (!data["@context"]) fail(rel, "JSON-LD without @context");
    } catch (e) {
      fail(rel, `JSON-LD does not parse: ${e.message}`);
    }
  }
  const inlineStyles = [...raw.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]);
  const doc = raw
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, (s) =>
      s.replace(/>[\s\S]*<\/script>$/, "></script>"),
    )
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/g, "");

  // --- head: title, description, canonical, social image
  const titleTags = doc.match(/<title>[^<]*<\/title>/g) ?? [];
  if (titleTags.length !== 1) fail(rel, `expected one <title>, found ${titleTags.length}`);
  const title = decode(titleTags[0]?.replace(/<\/?title>/g, "") ?? "");
  const desc = decode(doc.match(/<meta name="description" content="([^"]*)"/)?.[1] ?? "");
  if (!desc) fail(rel, "missing meta description");
  // Phones: one responsive viewport, and pinch-zoom never blocked (WCAG 1.4.4).
  const viewports = doc.match(/<meta name="viewport" content="[^"]*"/g) ?? [];
  if (viewports.length !== 1) fail(rel, `expected one viewport meta, found ${viewports.length}`);
  else if (!/width=device-width/.test(viewports[0]))
    fail(rel, `viewport meta has no width=device-width: ${viewports[0]}`);
  else if (/maximum-scale|user-scalable\s*=\s*(no|0)/i.test(viewports[0]))
    fail(rel, `viewport meta blocks zooming: ${viewports[0]}`);
  const canonical = doc.match(/<link rel="canonical" href="([^"]*)"/)?.[1];
  if (!canonical?.startsWith(`${SITE}/`)) fail(rel, `canonical missing or off-site: ${canonical}`);
  else {
    if (!canonical.endsWith("/") && !/\.[a-z0-9]+$/i.test(canonical))
      fail(rel, `canonical has no trailing slash: ${canonical}`);
    if (canonical !== `${SITE}${sitePath}`)
      fail(rel, `canonical ${canonical} is not this page (${sitePath})`);
  }
  if (title.length > TITLE_ERROR)
    fail(rel, `title is ${title.length} characters (limit ${TITLE_ERROR}): ${title}`);
  else if (title.length > TITLE_WARN)
    warn(rel, `title is ${title.length} characters (aim for ${TITLE_WARN})`);
  if (desc.length > DESC_ERROR)
    fail(rel, `description is ${desc.length} characters (limit ${DESC_ERROR})`);
  else if (desc.length > DESC_WARN)
    warn(rel, `description is ${desc.length} characters (aim for ${DESC_WARN})`);
  else if (desc && desc.length < DESC_MIN)
    warn(rel, `description is only ${desc.length} characters`);
  if (!isNoindex) {
    if (titles.has(title)) fail(rel, `duplicate title with ${titles.get(title)}: ${title}`);
    else titles.set(title, rel);
    if (desc) {
      if (descriptions.has(desc)) fail(rel, `duplicate description with ${descriptions.get(desc)}`);
      else descriptions.set(desc, rel);
    }
  }
  const og = doc.match(/<meta property="og:image" content="([^"]*)"/)?.[1];
  if (!og) fail(rel, "missing og:image");
  else if (!og.startsWith(SITE) || !exists(og.slice(SITE.length)))
    fail(rel, `og:image not found in dist: ${og}`);

  // --- one <h1>
  const h1s = (doc.match(/<h1[\s>]/g) ?? []).length;
  if (h1s !== 1) fail(rel, `expected one <h1>, found ${h1s}`);

  // --- structured data by page kind
  const types = jsonLdTypes(jsonLd);
  if (
    /^\/blog\/[^/]+\/$/.test(sitePath) &&
    sitePath !== "/blog/tags/" &&
    !sitePath.startsWith("/blog/tags/")
  ) {
    posts.add(sitePath);
    if (!types.has("Article") && !types.has("BlogPosting"))
      fail(rel, "blog post without Article JSON-LD");
  }
  const depth = sitePath.split("/").filter(Boolean).length;
  if (depth >= 2 && !isNoindex && !types.has("BreadcrumbList"))
    fail(rel, "nested page without BreadcrumbList JSON-LD");
  if (doc.includes('class="faq-item"') && !types.has("FAQPage"))
    fail(rel, "FAQ block without FAQPage JSON-LD");

  // --- tags: loaded resources, links, images
  for (const m of doc.matchAll(TAG)) {
    const name = m[1].toLowerCase();
    const a = attrsOf(m[2]);
    switch (name) {
      case "script":
        checkLoad(rel, sitePath, "<script src>", a.src, raw);
        break;
      case "img":
        checkLoad(rel, sitePath, "<img src>", a.src, raw);
        for (const u of urlsIn(a.srcset ?? "")) checkLoad(rel, sitePath, "<img srcset>", u, raw);
        if (!("alt" in a)) fail(rel, `<img> without alt: ${a.src ?? "(no src)"}`);
        break;
      case "source":
        checkLoad(rel, sitePath, "<source src>", a.src, raw);
        for (const u of urlsIn(a.srcset ?? "")) checkLoad(rel, sitePath, "<source srcset>", u, raw);
        break;
      case "iframe":
      case "audio":
      case "track":
      case "embed":
      case "frame":
        checkLoad(rel, sitePath, `<${name} src>`, a.src, raw);
        break;
      case "video":
        checkLoad(rel, sitePath, "<video src>", a.src, raw);
        checkLoad(rel, sitePath, "<video poster>", a.poster, raw);
        break;
      case "object":
        checkLoad(rel, sitePath, "<object data>", a.data, raw);
        break;
      case "input":
        if (a.type === "image") checkLoad(rel, sitePath, "<input src>", a.src, raw);
        break;
      case "link": {
        const kind = (a.rel ?? "").toLowerCase();
        if (["canonical", "alternate", "sitemap"].includes(kind)) {
          if (a.href?.startsWith("/") && !exists(a.href))
            fail(rel, `missing <link rel="${kind}">: ${a.href}`);
          break;
        }
        checkLoad(rel, sitePath, `<link rel="${kind}">`, a.href, raw);
        for (const u of urlsIn(a.imagesrcset ?? ""))
          checkLoad(rel, sitePath, "<link imagesrcset>", u, raw);
        break;
      }
      case "a": {
        checkAnchor(rel, sitePath, a);
        break;
      }
      default:
    }
    if (a.style) checkCss(rel, null, a.style, "inline style", raw);
  }
  for (const text of inlineStyles) checkCss(rel, null, text, "<style>", raw);
}

/** A hyperlink: internal ones resolve and end with a slash; external ones carry rel="noopener noreferrer". */
function checkAnchor(rel, sitePath, a) {
  const href = a.href;
  if (href === undefined || href === "" || href.startsWith("#")) return;
  if (/^(mailto|tel):/i.test(href)) return;
  if (/^javascript:/i.test(href)) return fail(rel, `javascript: link: ${href}`);
  if (/^http:\/\//i.test(href)) return fail(rel, `plain http: link (use https): ${href}`);
  if (href.startsWith("//")) return fail(rel, `protocol-relative link (use https): ${href}`);
  if (/^https:\/\//i.test(href) && !isSameSite(href)) {
    const tokens = (a.rel ?? "").toLowerCase().split(/\s+/);
    for (const need of ["noopener", "noreferrer"])
      if (!tokens.includes(need)) fail(rel, `external link without rel="${need}": ${href}`);
    return;
  }
  const local = isSameSite(href) ? href.slice(SITE.length) || "/" : href;
  if (/^[a-z][a-z0-9+.-]*:/i.test(local)) return; // some other scheme
  const resolved = local.startsWith("/") ? local : posix.join(sitePath, local);
  const pathOnly = resolved.split(/[?#]/)[0];
  if (!exists(resolved)) fail(rel, `broken internal link: ${href}`);
  else if (!pathOnly.endsWith("/") && !/\.[a-z0-9]+$/i.test(pathOnly))
    fail(rel, `internal link without trailing slash: ${href}`);
}

for (const file of css) {
  const rel = relative(dist, file);
  const sheet = readFileSync(file, "utf8");
  checkCss(rel, `/${rel}`, sheet, "stylesheet");
}

for (const file of files.filter((f) => f.endsWith(".js"))) {
  const src = readFileSync(file, "utf8");
  for (const m of src.matchAll(/\b(fetch|import)\(\s*['"`](https?:\/\/[^'"`]+)/g)) {
    fail(relative(dist, file), `script requests another origin: ${m[2]}`);
  }
}

// Sitemap: every indexable page, no noindex page.
const sitemap = files
  .filter((f) => /sitemap-\d+\.xml$/.test(f))
  .map((f) => readFileSync(f, "utf8"))
  .join("");
const listed = new Set(
  [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].slice(SITE.length)),
);
for (const p of indexable) if (!listed.has(p)) fail("sitemap", `indexable page not listed: ${p}`);
for (const p of noindex) if (listed.has(p)) fail("sitemap", `noindex page listed: ${p}`);
for (const p of listed)
  if (!indexable.has(p)) fail("sitemap", `listed URL has no built page: ${p}`);

// lastmod is a calendar day from the page. The sitemap writer prints that day as midnight UTC
// (2026-11-16T00:00:00.000Z), which is not the clock of the build.
const lastmodByPath = new Map();
for (const block of sitemap.matchAll(/<url>([\s\S]*?)<\/url>/g)) {
  const loc = block[1].match(/<loc>([^<]+)<\/loc>/)?.[1];
  const lastmod = block[1].match(/<lastmod>([^<]*)<\/lastmod>/)?.[1];
  if (loc?.startsWith(SITE)) lastmodByPath.set(loc.slice(SITE.length), lastmod ?? "");
}
const calendarDay = (lastmod) => /^(\d{4}-\d{2}-\d{2})(?:T00:00:00\.000Z)?$/.exec(lastmod)?.[1];
for (const p of listed) {
  const day = calendarDay(lastmodByPath.get(p) ?? "");
  if (!day)
    fail("sitemap", `lastmod is not a calendar date: ${p} ${lastmodByPath.get(p) || "missing"}`);
}
const expectLastmod = (p, date) => {
  const got = calendarDay(lastmodByPath.get(p) ?? "");
  if (got !== date)
    fail("sitemap", `${p} lastmod is ${lastmodByPath.get(p) ?? "missing"}, expected ${date}`);
};
expectLastmod("/blog/coast-fire-explained/", "2026-11-16");
expectLastmod("/legal/privacy/", "2026-11-18");
expectLastmod("/changelog/", "2026-11-18");
expectLastmod("/docs/api-and-mcp/api-reference/", "2026-11-17");

for (const file of html) {
  const rel = relative(dist, file);
  if (!rel.startsWith(join("blog", "tags") + sep)) continue;
  const robots = readFileSync(file, "utf8").match(/<meta name="robots" content="([^"]*)"/);
  if (!robots || !robots[1].includes("noindex") || !robots[1].includes("follow"))
    fail(rel, `tag archive robots is "${robots?.[1] ?? "missing"}", expected noindex, follow`);
}

// sitemap.xml: the conventional URL serves the same index (issue #22).
const indexFile = join(dist, "sitemap-index.xml");
const aliasFile = join(dist, "sitemap.xml");
if (!existsSync(indexFile)) fail("sitemap-index.xml", "missing");
else if (!existsSync(aliasFile)) fail("sitemap.xml", "missing");
else if (!readFileSync(aliasFile).equals(readFileSync(indexFile)))
  fail("sitemap.xml", "differs from sitemap-index.xml");

// robots.txt
const robotsFile = join(dist, "robots.txt");
if (!existsSync(robotsFile)) fail("robots.txt", "missing");
else {
  const robots = readFileSync(robotsFile, "utf8");
  for (const name of ["sitemap-index.xml", "sitemap.xml"])
    if (!robots.split("\n").includes(`Sitemap: ${SITE}/${name}`))
      fail("robots.txt", `does not point at ${SITE}/${name}`);
  if (/^Disallow:\s*\/\s*$/m.test(robots)) fail("robots.txt", "disallows the whole site");
}

// security.txt (RFC 9116): present under the dot directory, with Contact, this site's Canonical, and an
// Expires at least 30 days away (renew it in packages/cloud/src/security-txt.ts).
const securityFile = join(dist, ".well-known", "security.txt");
if (!existsSync(securityFile)) fail(".well-known/security.txt", "missing");
else {
  const lines = readFileSync(securityFile, "utf8").split("\n");
  const field = (name) => lines.find((l) => l.startsWith(`${name}: `))?.slice(name.length + 2);
  if (!field("Contact")?.startsWith("mailto:"))
    fail(".well-known/security.txt", "no mailto: Contact");
  if (field("Canonical") !== `${SITE}/.well-known/security.txt`)
    fail(".well-known/security.txt", `Canonical is not ${SITE}/.well-known/security.txt`);
  const expires = Date.parse(field("Expires") ?? "");
  if (Number.isNaN(expires)) fail(".well-known/security.txt", "no valid Expires");
  else if (expires - Date.now() < 30 * 24 * 60 * 60 * 1000)
    fail(".well-known/security.txt", `expires ${field("Expires")}: renew it`);
}

// RSS: every published, indexable post.
const rssFile = join(dist, "rss.xml");
if (existsSync(rssFile)) {
  const rss = readFileSync(rssFile, "utf8");
  const items = new Set(
    [...rss.matchAll(/<link>([^<]+)<\/link>/g)].map((m) => m[1].slice(SITE.length)),
  );
  for (const p of posts)
    if (indexable.has(p) && !items.has(p)) fail("rss.xml", `post not in the feed: ${p}`);
}

// XML well-formedness, if xmllint is installed (it is on macOS and most Linux images).
for (const f of files.filter((x) => x.endsWith(".xml"))) {
  try {
    execFileSync("xmllint", ["--noout", f], { stdio: "pipe" });
  } catch (e) {
    if (e.code === "ENOENT") {
      notes.push("xmllint not found: XML well-formedness not checked");
      break;
    }
    fail(relative(dist, f), `XML is not well-formed: ${e.stderr?.toString().trim()}`);
  }
}

console.log(
  `Checked ${html.length - redirects.length} pages (${indexable.size} indexable, ${noindex.size} noindex, ${redirects.length} redirects), ${css.length} stylesheets, ${listed.size} sitemap URLs, ${posts.size} posts.`,
);
for (const n of notes) console.log(`note: ${n}`);
for (const w of warnings) console.log(`warning: ${w}`);
if (warnings.length) console.log(`${warnings.length} warning(s).`);
if (errors.length) {
  for (const e of errors) console.error(`error: ${e}`);
  console.error(`${errors.length} problem(s).`);
  process.exit(1);
}
console.log("No problems found.");
