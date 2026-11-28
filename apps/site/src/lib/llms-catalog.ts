/**
 * The two LLM catalogs, assembled at build time from the page list and the content collections.
 * /llms.txt is the map. /llms-full.txt repeats it and adds what each country's tax estimate
 * includes and leaves out, plus the legal pages.
 */
import { getCollection } from "astro:content";
import { type PageMeta, pages } from "../config/pages";
import { absoluteUrl, site } from "../config/site";
import { countryLandings, landingPath } from "../landing/registry";
import { TOOLS } from "../tools/registry";
import { publishedPosts } from "./content";
import { docHref, docsSidebar } from "./docs";
import { agentLinks, AGENTS_BODY } from "./llms-agents";
import { twinPath } from "./markdown-twin";
import { type LlmsDoc, type LlmsLink, mcpParagraph, pricingParagraph, renderLlms } from "./llms";

type PagePath = keyof typeof pages;

const PRODUCT: PagePath[] = [
  "/",
  "/pricing/",
  "/features/",
  "/open-source/",
  "/self-hosting/",
  "/security/",
  "/about/",
  "/changelog/",
];

function pageLink(path: PagePath): LlmsLink | undefined {
  const meta: PageMeta = pages[path];
  if (meta.noindex || meta.placeholder) return undefined;
  return { name: meta.title, url: absoluteUrl(path), note: meta.description };
}

function links(paths: PagePath[]): LlmsLink[] {
  return paths.flatMap((path) => {
    const link = pageLink(path);
    return link ? [link] : [];
  });
}

export async function llmsText(): Promise<string> {
  return renderLlms(await document(false));
}

export async function llmsFullText(): Promise<string> {
  return renderLlms(await document(true));
}

async function document(full: boolean): Promise<LlmsDoc> {
  const [countries, compares, features, legal, sections, posts] = await Promise.all([
    getCollection("countries"),
    getCollection("compare"),
    getCollection("features"),
    getCollection("legal"),
    docsSidebar(),
    publishedPosts(),
  ]);

  const countryLinks = countries
    .filter((entry) => !entry.data.noindex)
    .sort((a, b) => a.data.countryName.localeCompare(b.data.countryName))
    .map((entry) => ({
      name: entry.data.countryName,
      url: absoluteUrl(`/planning/${entry.id}/`),
      note: full
        ? `${entry.data.description} Modelled: ${entry.data.modelled.join("; ")}. Not modelled: ${entry.data.notModelled.join("; ")}.`
        : entry.data.description,
    }));

  const docLinks = sections.flatMap((section) =>
    section.entries
      .filter((entry) => !entry.data.noindex)
      .map((entry) => ({
        name: entry.data.title,
        url: absoluteUrl(twinPath(docHref(entry.id))),
        note: entry.data.description,
      })),
  );

  return {
    title: site.name,
    summary: site.description,
    body: [
      pricingParagraph(),
      mcpParagraph(),
      full
        ? "This file lists the public pages and, for each country, what the tax estimate models and what it leaves out."
        : `The longer catalog is ${absoluteUrl("/llms-full.txt")}.`,
    ],
    sections: [
      {
        heading: "Product",
        links: [
          ...links(["/"]),
          // The other country versions of the home page, right after the default one.
          ...countryLandings().map((e) => ({
            name: `${e.seo.title} (${e.countryName} version of the home page)`,
            url: absoluteUrl(landingPath(e)),
            note: e.seo.description,
          })),
          ...links(PRODUCT.filter((p) => p !== "/")),
        ],
      },
      {
        heading: "Calculators",
        links: [
          ...links(["/tools/"]),
          ...TOOLS.map((tool) => ({
            name: tool.name,
            url: absoluteUrl(tool.path),
            note: tool.summary,
          })),
        ],
      },
      {
        heading: "Planning by country",
        links: [...links(["/planning/"]), ...countryLinks],
      },
      {
        heading: "Comparisons",
        links: [
          ...links(["/compare/"]),
          ...compares
            .filter((entry) => !entry.data.noindex)
            .sort((a, b) => a.data.competitor.localeCompare(b.data.competitor))
            .map((entry) => ({
              name: entry.data.title,
              url: absoluteUrl(`/compare/${entry.id}/`),
              note: entry.data.description,
            })),
        ],
      },
      {
        heading: "Features",
        links: features
          .filter((entry) => !entry.data.noindex)
          .sort((a, b) => a.data.order - b.data.order)
          .map((entry) => ({
            name: entry.data.title,
            url: absoluteUrl(`/features/${entry.id}/`),
            note: full ? entry.data.description : entry.data.summary,
          })),
      },
      {
        heading: "Documentation",
        body: [
          "Each link below is the Markdown version of a docs page. The HTML page is the same address with a trailing slash in place of .md.",
        ],
        links: [
          {
            name: "Documentation",
            url: absoluteUrl(twinPath("/docs/")),
            note: pages["/docs/"].description,
          },
          ...docLinks,
        ],
      },
      {
        heading: "For AI agents",
        body: [AGENTS_BODY],
        links: agentLinks(),
      },
      {
        heading: "Blog",
        links: [
          ...links(["/blog/"]),
          ...posts
            .filter((entry) => !entry.data.noindex)
            .map((entry) => ({
              name: entry.data.title,
              url: absoluteUrl(`/blog/${entry.id}/`),
              note: entry.data.description,
            })),
        ],
      },
      {
        heading: "API and MCP",
        body: [mcpParagraph()],
        links: links(["/api/"]),
      },
      ...(full
        ? [
            {
              heading: "Legal",
              links: legal
                .filter((entry) => !entry.data.noindex && !entry.data.draft)
                .sort((a, b) => (a.data.order ?? 100) - (b.data.order ?? 100))
                .map((entry) => ({
                  name: entry.data.title,
                  url: absoluteUrl(`/legal/${entry.id}/`),
                  note: entry.data.description,
                })),
            },
          ]
        : []),
    ],
  };
}
