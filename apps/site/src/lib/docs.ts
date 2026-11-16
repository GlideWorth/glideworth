/** Docs sidebar: sections in this order, pages within a section by `order` then title. */
import { type CollectionEntry, getCollection } from "astro:content";

export const DOC_SECTIONS = [
  "Getting started",
  "Planning",
  "Self-hosting",
  "API and MCP",
  "Importing",
  "Reference",
] as const;

export interface DocSection {
  name: string;
  entries: CollectionEntry<"docs">[];
}

export async function docsSidebar(): Promise<DocSection[]> {
  const docs = await getCollection("docs");
  const names = [...new Set(docs.map((d) => d.data.section))].sort(
    (a, b) => rank(a) - rank(b) || a.localeCompare(b),
  );
  return names.map((name) => ({
    name,
    entries: docs
      .filter((d) => d.data.section === name)
      .sort((a, b) => a.data.order - b.data.order || a.data.title.localeCompare(b.data.title)),
  }));
}

function rank(section: string): number {
  const i = (DOC_SECTIONS as readonly string[]).indexOf(section);
  return i === -1 ? DOC_SECTIONS.length : i;
}

export function docHref(id: string): string {
  return `/docs/${id}/`;
}
