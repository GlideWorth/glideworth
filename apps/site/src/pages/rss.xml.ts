/** RSS for the blog: published, indexable posts, newest first. */
import rss from "@astrojs/rss";
import type { APIRoute } from "astro";
import { site } from "../config/site";
import { publishedPosts } from "../lib/content";

export const GET: APIRoute = async () => {
  const posts = (await publishedPosts()).filter((p) => !p.data.noindex && !p.data.draft);
  return rss({
    title: `${site.name} blog`,
    description:
      "Articles from the Glideworth team on retirement planning, tax across countries and building an open-source planner.",
    site: site.url,
    items: posts.map((p) => ({
      title: p.data.title,
      description: p.data.description,
      pubDate: p.data.pubDate,
      link: `/blog/${p.id}/`,
      categories: p.data.tags,
    })),
    customData: `<language>${site.locale}</language>`,
    trailingSlash: true,
  });
};
