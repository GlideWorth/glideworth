/**
 * robots.txt, generated so the sitemap URLs follow src/config/site.ts. /sitemap.xml is a copy of the
 * index (sitemapAlias in astro.config.ts) for tools that only look there.
 */
import type { APIRoute } from "astro";
import { site } from "../config/site";

export const GET: APIRoute = () =>
  new Response(
    [
      "User-agent: *",
      "Allow: /",
      "",
      `Sitemap: ${site.url}/sitemap-index.xml`,
      `Sitemap: ${site.url}/sitemap.xml`,
      "",
      "# LLM-readable descriptions of this site:",
      `# ${site.url}/llms.txt`,
      `# ${site.url}/llms-full.txt`,
      "",
    ].join("\n"),
    { headers: { "Content-Type": "text/plain; charset=utf-8" } },
  );
