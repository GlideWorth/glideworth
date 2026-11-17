/**
 * robots.txt, generated so the sitemap URLs follow src/config/site.ts. /sitemap.xml is a copy of the
 * index (sitemapAlias in astro.config.ts) for tools that only look there.
 */
import type { APIRoute } from "astro";
import { site } from "../config/site";

export const GET: APIRoute = () =>
  new Response(
    `User-agent: *\nAllow: /\n\nSitemap: ${site.url}/sitemap-index.xml\nSitemap: ${site.url}/sitemap.xml\n`,
    { headers: { "Content-Type": "text/plain; charset=utf-8" } },
  );
