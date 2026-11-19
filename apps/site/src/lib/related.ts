/** Resolves the "Related" links of a page from the clusters in src/config/related.ts. */
import { getCollection } from "astro:content";
import { pages } from "../config/pages";
import { clusters, selectRelatedPaths } from "../config/related";

export interface RelatedLink {
  href: string;
  title: string;
  kind: string;
}

let index: Promise<Map<string, RelatedLink>> | undefined;

async function titles(): Promise<Map<string, RelatedLink>> {
  const map = new Map<string, RelatedLink>();
  for (const [path, meta] of Object.entries(pages)) {
    if (!("placeholder" in meta && meta.placeholder) && !("noindex" in meta && meta.noindex))
      map.set(path, { href: path, title: meta.title, kind: "Page" });
  }
  for (const e of await getCollection("features"))
    map.set(`/features/${e.id}/`, {
      href: `/features/${e.id}/`,
      title: e.data.title,
      kind: "Feature",
    });
  for (const e of await getCollection("docs"))
    map.set(`/docs/${e.id}/`, { href: `/docs/${e.id}/`, title: e.data.title, kind: "Docs" });
  for (const e of await getCollection("blog", (p) => !p.data.draft))
    map.set(`/blog/${e.id}/`, { href: `/blog/${e.id}/`, title: e.data.title, kind: "Blog" });
  for (const e of await getCollection("compare", (p) => !p.data.noindex))
    map.set(`/compare/${e.id}/`, {
      href: `/compare/${e.id}/`,
      title: e.data.title,
      kind: "Comparison",
    });
  for (const e of await getCollection("countries"))
    map.set(`/planning/${e.id}/`, {
      href: `/planning/${e.id}/`,
      title: e.data.title,
      kind: "Country",
    });
  for (const c of clusters)
    for (const p of c.paths)
      if (!map.has(p))
        throw new Error(`src/config/related.ts: "${p}" (${c.subject}) is not a published page`);
  return map;
}

export async function relatedFor(path: string): Promise<RelatedLink[]> {
  index ??= titles();
  const map = await index;
  return selectRelatedPaths(path).flatMap((href) => {
    const link = map.get(href);
    return link ? [link] : [];
  });
}
