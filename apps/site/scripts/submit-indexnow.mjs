/**
 * Tell IndexNow about the URLs in the live sitemap. Manual only: nothing in CI or the deploy
 * calls this. The key file has to be on the live site first (it ships with the site), and a
 * search engine ignores a URL it cannot fetch yet.
 *
 *   pnpm --filter @glideworth/site indexnow:submit -- --dry-run
 *   pnpm indexnow:submit -- --dry-run
 *   INDEXNOW_BASE_URL=https://glideworth.com pnpm indexnow:submit
 *
 * --dry-run reads the sitemap and prints the payload. It does not POST, and it does not fetch
 * the key file. A real run refuses any host other than glideworth.com, checks that the live key
 * file matches, then POSTs to https://api.indexnow.org/indexnow. 200 and 202 are success.
 *
 * /sitemap.xml on this site is a sitemap index. Child sitemaps are followed. Set
 * INDEXNOW_BASE_URL to read a different origin; the default is https://glideworth.com.
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const INDEXNOW_KEY = "90abf381325f8bcc1f145c06aeb4946e";
export const INDEXNOW_ENDPOINT = "https://api.indexnow.org/indexnow";
const PRODUCTION_HOST = "glideworth.com";

/** Every <loc> in a sitemap or a sitemap index. */
export function sitemapLocs(xml) {
  return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((match) => match[1]);
}

export function isSitemapIndex(xml) {
  return /<sitemapindex[\s>]/i.test(xml);
}

/**
 * URLs from a sitemap. When the document is a sitemap index, each child is fetched the same way.
 * Depth is capped so a cycle cannot recurse forever.
 */
export async function collectSitemapUrls(startUrl, fetchText, depth = 0) {
  if (depth > 3) throw new Error(`sitemap nesting too deep at ${startUrl}`);
  const xml = await fetchText(startUrl);
  const locs = sitemapLocs(xml);
  if (!isSitemapIndex(xml)) return locs;
  const urls = [];
  for (const loc of locs) urls.push(...(await collectSitemapUrls(loc, fetchText, depth + 1)));
  return urls;
}

/** https URLs on `host`, in first-seen order, with duplicates dropped. Anything else is left out. */
export function validateUrls(urls, host) {
  const seen = new Set();
  const kept = [];
  for (const url of urls) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      continue;
    }
    if (parsed.protocol !== "https:" || parsed.host !== host) continue;
    if (seen.has(parsed.href)) continue;
    seen.add(parsed.href);
    kept.push(parsed.href);
  }
  return kept;
}

export function indexNowPayload(baseUrl, urlList) {
  const base = baseUrl.replace(/\/$/, "");
  return {
    host: new URL(base).host,
    key: INDEXNOW_KEY,
    keyLocation: `${base}/${INDEXNOW_KEY}.txt`,
    urlList,
  };
}

/**
 * Read the sitemap and, unless dryRun, POST it. `fetchText` returns a response body.
 * `post` returns the HTTP status. A dry run never calls `post` or the key URL.
 */
export async function runIndexNow({ baseUrl, dryRun, fetchText, post }) {
  const base = baseUrl.replace(/\/$/, "");
  const host = new URL(base).host;
  const urls = validateUrls(await collectSitemapUrls(`${base}/sitemap.xml`, fetchText), host);
  const payload = indexNowPayload(base, urls);
  if (urls.length === 0) throw new Error(`no https URLs for ${host} in ${base}/sitemap.xml`);
  if (dryRun) return { dryRun: true, payload, posted: false };
  if (host !== PRODUCTION_HOST) {
    throw new Error(`refusing to submit ${host}; IndexNow is for ${PRODUCTION_HOST} only`);
  }
  const keyBody = (await fetchText(payload.keyLocation)).trim();
  if (keyBody !== INDEXNOW_KEY)
    throw new Error(`key file at ${payload.keyLocation} does not match`);
  const status = await post(INDEXNOW_ENDPOINT, payload);
  if (status !== 200 && status !== 202) throw new Error(`IndexNow responded ${status}`);
  return { dryRun: false, payload, posted: true, status };
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const baseUrl = process.env.INDEXNOW_BASE_URL || "https://glideworth.com";
  const fetchText = async (url) => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url} responded ${response.status}`);
    return response.text();
  };
  const post = async (url, payload) => {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(payload),
    });
    return response.status;
  };
  const result = await runIndexNow({ baseUrl, dryRun, fetchText, post });
  const { urlList } = result.payload;
  console.log(
    `${dryRun ? "Dry run" : "Submitted"}: ${urlList.length} URL${urlList.length === 1 ? "" : "s"} from ${baseUrl}/sitemap.xml`,
  );
  for (const url of urlList.slice(0, 5)) console.log(`  ${url}`);
  if (urlList.length > 5) console.log(`  … ${urlList.length - 5} more`);
  if (dryRun) console.log("No request was sent to IndexNow.");
  else console.log(`IndexNow responded ${result.status}.`);
}

function isDirectRun() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
