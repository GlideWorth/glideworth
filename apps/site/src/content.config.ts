/**
 * Content collections. Each schema is the contract for its folder in src/content; the build fails on
 * a missing or wrong field. CONTENT-GUIDE.md documents every field with an example.
 *
 * Shared optional fields:
 *   noindex  keeps the page out of search engines and the sitemap (use for samples and templates)
 *   ogTitle  a shorter title for the social image
 */
import { defineCollection, reference } from "astro:content";
import { file, glob } from "astro/loaders";
import { z } from "astro/zod";
import { withFacts } from "./lib/facts";

const mdx = (base: string) => glob({ base: `./src/content/${base}`, pattern: "**/[^_]*.{md,mdx}" });

/** A string that may carry `{{fact}}` tokens (see withFacts in src/lib/facts.ts): numbers stay in step with the code. */
const text = () => z.string().transform(withFacts);

const seo = {
  /** 120 to 160 characters, unique on the site. May use `{{apiOperations}}`, `{{mcpTools}}` etc. */
  description: z.string().min(50).max(200).transform(withFacts),
  noindex: z.boolean().default(false),
  ogTitle: text().optional(),
};

const blog = defineCollection({
  loader: mdx("blog"),
  schema: z.object({
    title: z.string().max(90).transform(withFacts),
    ...seo,
    pubDate: z.coerce.date(),
    updatedDate: z.coerce.date().optional(),
    author: z.array(reference("authors")).min(1),
    tags: z.array(z.string()).default([]),
    /** Drafts render in `astro dev` only; they are left out of builds, listings and RSS. */
    draft: z.boolean().default(false),
  }),
});

const authors = defineCollection({
  loader: file("./src/content/authors/authors.json"),
  schema: z.object({
    name: z.string(),
    kind: z.enum(["person", "organization"]).default("person"),
    /** One or two sentences. */
    bio: z.string(),
    role: z.string().optional(),
    url: z.url().optional(),
  }),
});

const docs = defineCollection({
  loader: mdx("docs"),
  schema: z.object({
    title: text(),
    ...seo,
    /** Sidebar group. Add new sections to DOC_SECTIONS in src/lib/docs.ts to set their order. */
    section: z.string(),
    /** Position within the section, ascending. */
    order: z.number().default(100),
    /** Optional date the page was last checked against the code. */
    lastChecked: z.coerce.date().optional(),
  }),
});

const legal = defineCollection({
  loader: mdx("legal"),
  schema: z.object({
    title: text(),
    ...seo,
    lastUpdated: z.coerce.date(),
    /** True while the document is still being confirmed: keeps the page out of the sitemap (noindex) and shows a "draft" note. No lawyer will review the pages (docs/launch/legal-decisions.md). */
    draft: z.boolean().default(true),
    /** Position in the footer and on /legal/. */
    order: z.number().optional(),
  }),
});

const compare = defineCollection({
  loader: mdx("compare"),
  schema: z.object({
    title: text(),
    ...seo,
    /** The product or method compared with, e.g. "Spreadsheets". */
    competitor: z.string(),
    /** The kicker above the title and on the social image; "Comparison" when left out. */
    eyebrow: z.string().optional(),
    /** The date every claim about the other product was last checked against its sources. */
    checkedOn: z.coerce.date(),
    /** Every claim about another product needs a source here. */
    sources: z
      .array(
        z.object({
          label: z.string(),
          url: z.url(),
          /** When this source was read, if different from checkedOn. */
          accessed: z.coerce.date().optional(),
        }),
      )
      .min(1),
  }),
});

const countries = defineCollection({
  loader: mdx("countries"),
  schema: z.object({
    title: text(),
    ...seo,
    /** ISO 3166-1 alpha-2, upper case (GB for the UK). The URL comes from the file name: uk.mdx -> /planning/uk/. */
    countryCode: z.string().regex(/^[A-Z]{2}$/),
    /** Display name, e.g. "United Kingdom". */
    countryName: z.string(),
    /** What the tax estimate includes. Take each line from the code or docs/STATUS.md. */
    modelled: z.array(z.string()).min(1),
    /** What it leaves out (TAX_SIMPLIFICATIONS in packages/core). Never leave this empty. */
    notModelled: z.array(z.string()).min(1),
    /** Tax years in the tables, as written in docs/STATUS.md. */
    taxYears: z.array(z.string()).min(1),
  }),
});

const features = defineCollection({
  loader: mdx("features"),
  schema: z.object({
    title: text(),
    ...seo,
    /** Position on /features/, ascending. */
    order: z.number(),
    /** One-line summary for cards. */
    summary: z.string().max(160).transform(withFacts),
  }),
});

const changelog = defineCollection({
  loader: mdx("changelog"),
  schema: z.object({
    title: z.string(),
    date: z.coerce.date(),
    /** Engine or app version, if there is one. */
    version: z.string().optional(),
    tags: z
      .array(z.enum(["engine", "tax", "api", "mcp", "web", "import", "docs", "fix", "security"]))
      .default([]),
  }),
});

export const collections = { blog, authors, docs, legal, compare, countries, features, changelog };
