/** Small helpers shared by pages that list collection entries. */
import { type CollectionEntry, getCollection } from "astro:content";

/** Published blog posts, newest first. Drafts appear only in `astro dev`. */
export async function publishedPosts(): Promise<CollectionEntry<"blog">[]> {
  const posts = await getCollection("blog", (p) => import.meta.env.DEV || !p.data.draft);
  return posts.sort((a, b) => b.data.pubDate.valueOf() - a.data.pubDate.valueOf());
}

/** URL-safe form of a tag: "Monte Carlo" -> "monte-carlo". */
export function tagSlug(tag: string): string {
  return tag
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/[\s_]+/g, "-");
}

export function formatDate(date: Date): string {
  return date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

export function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}
