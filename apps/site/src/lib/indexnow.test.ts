import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  INDEXNOW_ENDPOINT,
  INDEXNOW_KEY,
  collectSitemapUrls,
  indexNowPayload,
  isSitemapIndex,
  runIndexNow,
  sitemapLocs,
  validateUrls,
} from "../../scripts/submit-indexnow.mjs";

const index = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>https://glideworth.com/sitemap-0.xml</loc></sitemap>
</sitemapindex>`;

const child = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://glideworth.com/</loc></url>
  <url><loc>https://glideworth.com/pricing/</loc></url>
  <url><loc>https://glideworth.com/pricing/</loc></url>
  <url><loc>http://glideworth.com/insecure/</loc></url>
  <url><loc>https://example.com/elsewhere/</loc></url>
</urlset>`;

describe("sitemap reading", () => {
  it("follows a sitemap index and keeps only https URLs on that host", async () => {
    const docs = new Map([
      ["https://glideworth.com/sitemap.xml", index],
      ["https://glideworth.com/sitemap-0.xml", child],
    ]);
    expect(isSitemapIndex(index)).toBe(true);
    expect(sitemapLocs(child)).toHaveLength(5);
    const urls = validateUrls(
      await collectSitemapUrls("https://glideworth.com/sitemap.xml", async (url: string) => {
        const body = docs.get(url);
        if (body === undefined) throw new Error(`unexpected ${url}`);
        return body;
      }),
      "glideworth.com",
    );
    expect(urls).toEqual(["https://glideworth.com/", "https://glideworth.com/pricing/"]);
  });
});

describe("runIndexNow", () => {
  const docs = new Map([
    ["https://glideworth.com/sitemap.xml", index],
    ["https://glideworth.com/sitemap-0.xml", child],
    [`https://glideworth.com/${INDEXNOW_KEY}.txt`, `${INDEXNOW_KEY}\n`],
  ]);
  const fetchText = async (url: string) => {
    const body = docs.get(url);
    if (body === undefined) throw new Error(`unexpected ${url}`);
    return body;
  };

  it("does not POST on a dry run", async () => {
    let posted = false;
    const result = await runIndexNow({
      baseUrl: "https://glideworth.com",
      dryRun: true,
      fetchText,
      post: async () => {
        posted = true;
        return 200;
      },
    });
    expect(posted).toBe(false);
    expect(result.posted).toBe(false);
    expect(result.payload.urlList).toEqual([
      "https://glideworth.com/",
      "https://glideworth.com/pricing/",
    ]);
    expect(result.payload.key).toBe(INDEXNOW_KEY);
    expect(result.payload.keyLocation).toBe(`https://glideworth.com/${INDEXNOW_KEY}.txt`);
  });

  it("POSTs only after the live key file matches, and accepts 202", async () => {
    const calls: string[] = [];
    const result = await runIndexNow({
      baseUrl: "https://glideworth.com/",
      dryRun: false,
      fetchText: async (url: string) => {
        calls.push(url);
        return fetchText(url);
      },
      post: async (url: string) => {
        expect(url).toBe(INDEXNOW_ENDPOINT);
        return 202;
      },
    });
    expect(result.posted).toBe(true);
    expect(result.status).toBe(202);
    expect(calls).toContain(`https://glideworth.com/${INDEXNOW_KEY}.txt`);
  });

  it("refuses to submit a host that is not the production site", async () => {
    await expect(
      runIndexNow({
        baseUrl: "https://preview.example",
        dryRun: false,
        fetchText: async () => child.replaceAll("glideworth.com", "preview.example"),
        post: async () => 200,
      }),
    ).rejects.toThrow(/refusing to submit/);
  });
});

describe("the published key file", () => {
  it("contains the key and nothing else", () => {
    const file = fileURLToPath(new URL(`../../public/${INDEXNOW_KEY}.txt`, import.meta.url));
    expect(readFileSync(file, "utf8")).toBe(INDEXNOW_KEY);
    expect(indexNowPayload("https://glideworth.com", []).key).toBe(INDEXNOW_KEY);
  });
});
