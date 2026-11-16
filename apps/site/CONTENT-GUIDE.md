# Content guide for glideworth.com

For everyone who writes pages after the foundation. Read the honesty rules first; they matter more than
anything else here.

## 1. Honesty rules

1. **Every product claim must be true of the code today.** Take claims from the repository's `README.md`,
   `docs/STATUS.md`, `docs/PARITY.md`, `docs/API.md`, `docs/MCP.md` and the code. If you cannot point to
   where something is true, do not write it.
2. **Numbers come from `src/lib/facts.ts`**, not from memory or from the docs: `facts.taxCountryCount` (read
   from the engine), `facts.apiOperations` (counted from the generated OpenAPI document; the API reference page
   fails the build if it disagrees with the snapshot), `facts.mcpTools` with `mcpReadTools` and `mcpWriteTools`
   (counted as `apps/api/test/tool-count.test.ts` does). Never type one of these numbers into a page. In MDX
   bodies, import it: `import { facts } from '../../lib/facts';` then `{facts.taxCountryCount}`. In frontmatter
   (`title`, `description`, `ogTitle`, `summary`) write a token, `{{taxCountryCount}}` or `{{mcpTools}}`, and
   quote the value in YAML if it contains a colon. When the API or the MCP tools change, run
   `pnpm --filter @glideworth/site snapshot:openapi` and update `facts.ts`.
3. **Prices come from `src/config/pricing.ts`.** Never type "$9" or "30-day" into a page. Use
   `formatPrice(pricing.monthly)`, `pricing.trialDays`, `priceSentence()`.
4. **Tax figures are "estimates".** Say what each country's model leaves out (the list is
   `TAX_SIMPLIFICATIONS` in `packages/core/src/tax/data/`). Never imply a figure is a tax return or advice.
5. **The hosted service does not exist yet.** Nothing about it is running: no sign-up, billing, hosted
   servers or hosted endpoint, and no two-factor sign-in, automatic backups or email delivery. Things that are
   true of the software itself (you can self-host them today) are "available"; hosted-only things are
   "planned" (`status` in `src/config/pricing.ts`). While `site.cloudLaunched` is `false`, say the software
   exists and can be self-hosted today and the hosted service opens later; use `trialCta` from `site.ts` for
   the "try it" button, which then points at self-hosting.
6. **Cross-border:** the engine models residency changes, non-resident source taxation and treaty relief, and
   the web app has screens for them (`apps/web/src/features/crossborder`): the residency timeline,
   citizenship and past residence, a country on each item, tax by country and a stay-or-move comparison. Say
   what the product does, not only what the engine does.
   - **Model limits are not the law.** When a page says what a model leaves out, word it as Glideworth's
     simplification ("the model does not carry forward unused pension annual allowance, which UK law allows"),
     never as a rule of the law ("unused allowance is not carried forward").
7. **Never** claim security certifications, user counts, testimonials, awards, uptime, or logos of
   customers. No invented quotes.
8. **Comparisons** (`compare` collection) state facts about other products only with a source in
   `sources` and the date in `checkedOn`. Be fair: say where the other product is stronger.
9. **Illustrative visuals are labelled "Illustrative".** Real screenshots replace them later (see Figure).
10. The code is named Glideworth throughout: commands, environment variables (`GLIDEWORTH_…`), the Docker
    service, the cookies (`glideworth_session`, `glideworth_csrf`), the browser storage keys (`glideworth…`)
    and the MCP server. Its working name before launch was Cairn, and installs from that time keep working
    (old `CAIRN_…` variables, `cairn_…` API keys, the `cairn-data` volume, `cairn_*` cookies and `cairn…`
    storage keys). Use the new names everywhere; mention the old ones only on the upgrade page
    (`docs/self-hosting/upgrading`, "Upgrading from Cairn") and in the cookie policy's note about old names.

## 2. Tone

Plain, calm, specific. Short sentences. British spelling ("licence", "optimise", "colour") to match the
existing docs. Explain rather than hype: no "revolutionary", "seamless", "unlock", "supercharge", no
exclamation marks, no emoji. Prefer a concrete example over an adjective. Address the reader as "you".

## 3. Adding pages

### A hand-written page (`src/pages/*.astro`)

1. Add its title and description to `src/config/pages.ts` (this also creates its social image). Titles
   are unique and under about 60 characters (" · Glideworth" is appended unless `fullTitle: true`);
   descriptions are unique, 120 to 160 characters.
2. Create the page:

```astro
---
import Section from '../components/Section.astro';
import { page } from '../config/pages';
import PageLayout from '../layouts/PageLayout.astro';
---

<PageLayout {...page('/about/')} heading="Visible H1" eyebrow="About" lede="One-sentence summary."
  crumbs={[{ label: 'About', href: '/about/' }]}>
  <Section title="A section">…</Section>
</PageLayout>
```

3. Link it from `src/config/nav.ts` (footer site map at least).
4. Placeholder pages carry `placeholder: true` in `pages.ts`: they show a "being written" notice and are
   `noindex`. **Remove the flag when you write the page**, and delete the `PLACEHOLDER` comment at the top.

### Collection entries (`src/content/<collection>/`)

Files are `.md` or `.mdx`; the file path is the URL slug. Files starting with `_` are ignored. All entries
accept `noindex: true` (keeps them out of search and the sitemap) and `ogTitle` (shorter social-image
title). `description` is required everywhere except changelog and authors, 50 to 200 characters
(aim for 120 to 160).

| Collection                         | URL                      | Required fields                                                                             | Optional                                                                    |
| ---------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `blog`                             | `/blog/<file>/`          | `title`, `description`, `pubDate`, `author` (list of author ids)                            | `updatedDate`, `tags`, `draft`                                              |
| `authors` (`authors/authors.json`) | `/authors/<id>/`         | `id`, `name`, `bio`                                                                         | `kind` (`person`/`organization`), `role`, `url`                             |
| `docs`                             | `/docs/<folder>/<file>/` | `title`, `description`, `section`                                                           | `order`, `lastChecked`                                                      |
| `legal`                            | `/legal/<file>/`         | `title`, `description`, `lastUpdated`                                                       | `draft` (default **true**), `order`                                         |
| `compare`                          | `/compare/<file>/`       | `title`, `description`, `competitor`, `checkedOn`, `sources` (label, url, accessed?)        |                                                                             |
| `countries`                        | `/planning/<file>/`      | `title`, `description`, `countryCode`, `countryName`, `modelled`, `notModelled`, `taxYears` |                                                                             |
| `features`                         | `/features/<file>/`      | `title`, `description`, `order`, `summary`                                                  |                                                                             |
| `changelog`                        | `/changelog/#<file>`     | `title`, `date`                                                                             | `version`, `tags` (engine, tax, api, mcp, web, import, docs, fix, security) |

Examples (each collection has one real or sample entry to copy):

```yaml
# src/content/blog/my-post.mdx
---
title: How Monte Carlo handles bad early years
description: Sequence-of-returns risk explained with the planner's own failure analysis, and what to change when early losses sink a plan.
pubDate: 2026-12-01
author: [glideworth-team]
tags: [Monte Carlo, Methodology]
draft: true # visible in `pnpm dev` only until you remove it
---
```

```yaml
# src/content/countries/us.mdx  ->  /planning/us/
---
title: Retirement planning in the United States
description: …
countryCode: US
countryName: United States
taxYears: ["2026 (OBBBA)"]
modelled: ["Federal income tax …", "…"]
notModelled: ["SALT cap and itemised phase-outs …", "…"]
---
```

- **Docs sections** order is set by `DOC_SECTIONS` in `src/lib/docs.ts`; a new section name works but sorts
  last until added there.
- **Legal:** `draft: true` means the document describes the hosted service and takes effect when it opens. It
  shows "These terms take effect when the hosted service opens. Last updated <date>." and is `noindex` (out of
  the sitemap) until you set `draft: false` at launch. Documents that apply today (disclaimer, notices) are
  `draft: false`. The decisions behind the wording are in `docs/launch/legal-decisions.md`.
- **Compare:** every entry needs sources and `checkedOn`; a `noindex` sample is shown in development only.
- **Related links** are not written into pages. Add a page to a cluster in `src/config/related.ts` and every
  page in the cluster links to the others under "Related" (the build fails on a path that is not a page).
- **Drafts** (`draft: true`, blog) build only in dev and never appear in RSS.

## 4. Components

Import from `src/components/`. In MDX entries these are available **without an import** (see
`src/components/mdx.ts`): `Button`, `Callout`, `Card`, `CodeBlock`, `FAQ`, `FeatureGrid`, `Figure`,
`Steps`, `ProjectionFan`.

| Component                              | Use                                                                                                          | Example                                                                     |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| `Section`                              | A page band with eyebrow, title, intro; `tone` plain / raised / band; `width` wide / narrow                  | `<Section eyebrow="Tax" title="…" intro="…" tone="raised">…</Section>`      |
| `Button`                               | Link or button; `variant` primary / secondary / ghost / inverse; `size` md / lg; `arrow`                     | `<Button href="/pricing/" arrow>See pricing</Button>`                       |
| `Card`                                 | Bordered block; whole card is a link with `href`; `tone` plain / raised / accent                             | `<Card title="Docker" href="/docs/self-hosting/docker/">…</Card>`           |
| `Prose`                                | Long-form typography (layouts already wrap entries in it)                                                    | `<Prose><Content /></Prose>`                                                |
| `Callout`                              | Note box; `type` note / tip / warning / risk / draft                                                         | `<Callout type="warning" title="Estimates">…</Callout>`                     |
| `FeatureGrid`                          | Grid of title + body (+ link, glyph)                                                                         | `<FeatureGrid items={[{ title, body, href, glyph: 'fan' }]} columns={3} />` |
| `PricingTable`                         | Hosted plan vs self-hosted, from `pricing.ts`                                                                | `<PricingTable />`                                                          |
| `FAQ`                                  | Disclosure list **with FAQPage JSON-LD**; answers are simple HTML; one per page (`schema={false}` on extras) | `<FAQ items={[{ q: '…?', a: '<p>…</p>' }]} />`                              |
| `Steps`                                | Numbered steps, from `items` or an ordered list in the slot                                                  | `<Steps items={[{ title, body }]} />`                                       |
| `CodeBlock`                            | Highlighted code with title and copy button (fenced code in MD/MDX is highlighted too)                       | `<CodeBlock lang="bash" title="Terminal" code={`pnpm build`} />`            |
| `Figure`                               | Screenshot or diagram in a frame with caption; `screenshot` names the slot                                   | see below                                                                   |
| `Breadcrumbs`                          | Trail + BreadcrumbList JSON-LD ("Home" added); PageLayout renders it from `crumbs`                           | `<Breadcrumbs items={[{ label, href }]} />`                                 |
| `TableOfContents`                      | "On this page" from `render(entry).headings`; EntryLayout includes it                                        | `<TableOfContents headings={headings} />`                                   |
| `CTABand`                              | Closing call to action (deep band); defaults from `pricing.ts`                                               | `<CTABand title="…" secondary={{ label, href }} />`                         |
| `visuals/ProjectionFan`                | Illustrative Monte Carlo fan chart (SVG)                                                                     | `<ProjectionFan retireAge={58} />`                                          |
| `visuals/AgentFlow`, `visuals/TaxYear` | Illustrative MCP flow and tax-year diagrams                                                                  |                                                                             |

**Figure and screenshots.** Every place that wants a real screenshot has a named slot:

```astro
<Figure screenshot="results-taxes" caption="…"><TaxYear /></Figure>          <!-- diagram for now -->
<Figure screenshot="results-taxes" src={shot} alt="Tax by year…" caption="…" /> <!-- later -->
```

Find all slots with `grep -rn 'screenshot="' src`. Put captures in `src/assets/screenshots/` and import
them (`import shot from '../assets/screenshots/results-taxes.png'`). Use the synthetic sample households
only; never real data.

**Links** inside the site end with a slash (`/pricing/`, not `/pricing`); `trailingSlash: 'always'` makes
a missing slash a 404 in dev, and `pnpm check:dist` reports broken internal links and links without the slash.
Links to other sites may go to any https address, and get `rel="noopener noreferrer"` automatically: Markdown
and MDX links through the `a` override in `src/components/mdx.ts`, components through `externalLinkProps` in
`src/lib/links.ts`, links into the repository with `<RepoLink path="LICENSING.md">`. In an `.astro` page, add
`{...externalLinkProps(href)}` to a hand-written external `<a>`. Tables in Markdown and MDX are wrapped in a
scrollable, focusable box automatically (`MdxTable`); wrap a hand-written table in
`<div class="table-scroll" tabindex="0" role="region" aria-label="…">`.

## 5. SEO, social images and structured data

- **`<head>`** is produced by `BaseLayout` + `SEO` from the title and description you pass: canonical URL
  (from `site.url` + path), Open Graph, Twitter card, robots, theme colour, icons, manifest, RSS link.
- **Social images** (`/og/<path>.png`, 1200×630) are drawn at build time by `src/lib/og.ts` (satori +
  resvg, self-hosted Fraunces and Inter). Every page in `pages.ts` and every collection entry gets one
  automatically; pages without one fall back to `/og/default.png`. Use `ogTitle` / `ogEyebrow` for shorter
  wording.
- **Structured data** helpers are in `src/lib/jsonld.ts`: `organization()`, `website()`,
  `softwareApplication()` (prices from `pricing.ts`), `breadcrumbList()`, `faqPage()`, `article()`. Pass
  nodes to a layout with `jsonLd={[…]}`; `Breadcrumbs` and `FAQ` emit their own. Blog posts get `Article`
  automatically. Never add ratings or reviews.
- **noindex** (page prop, frontmatter field, or `placeholder`) also removes the page from the sitemap.
- **RSS** at `/rss.xml` lists published, indexable blog posts.
- Site-wide values (domain, app URL, repository, contact addresses) are in `src/config/site.ts`.
- The site makes **no third-party requests**: no external fonts, scripts, analytics or embeds. Images
  and fonts live in the repository. Links to other sites are fine. `pnpm check:dist` enforces both halves:
  anything a page _loads_ (scripts, styles, images, fonts, iframes, preloads, `srcset`, CSS `url()` and
  `@import`) must be same-origin with no exceptions; hyperlinks may point at any https origin.

## 6. Checking your work

From `apps/site`:

```bash
pnpm dev               # write with live reload at http://127.0.0.1:4321
pnpm typecheck         # astro check: schemas, types
pnpm build             # must finish with no warnings
pnpm check:dist        # titles, descriptions, one h1, alt text, canonicals, OG images, JSON-LD, links, no third-party loads, sitemap, RSS
pnpm check:contrast    # only if you touched colours
```

From the repo root: `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm build`.

Look at your page at 390 px wide and in both themes (the toggle is in the header) before you call it
done.
