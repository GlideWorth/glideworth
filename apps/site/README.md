# Glideworth site (`apps/site`)

The marketing site for **glideworth.com**: a static Astro build with MDX content collections, generated
social images, structured data, a sitemap and RSS. The app lives at `app.glideworth.com`; docs live under
`/docs` on this site. Writers: start with [CONTENT-GUIDE.md](CONTENT-GUIDE.md).

## Commands

Run from `apps/site` (or `pnpm --filter @glideworth/site <script>` from the repo root):

| Command                 | What it does                                                                                                                                                                                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm dev`              | Dev server on http://127.0.0.1:4321 (drafts visible)                                                                                                                                                                                                          |
| `pnpm build`            | Static build into `dist/` (pages, social images, sitemap, RSS)                                                                                                                                                                                                |
| `pnpm preview`          | Serves `dist/` on port 4321. Astro 7 runs it in the background: stop it with `pnpm astro preview stop`                                                                                                                                                        |
| `pnpm typecheck`        | `astro check` (TypeScript strict, Astro files and content schemas)                                                                                                                                                                                            |
| `pnpm check:dist`       | After a build: titles, descriptions (length, uniqueness), one h1, alt text, canonicals, OG images, JSON-LD, internal links (with trailing slash), `rel="noopener noreferrer"` on external links, third-party loads, sitemap, robots, RSS, XML, Markdown twins |
| `pnpm check:contrast`   | WCAG contrast of the colour tokens in both themes                                                                                                                                                                                                             |
| `pnpm icons`            | Regenerates the favicon set in `public/` from the mark                                                                                                                                                                                                        |
| `pnpm snapshot:openapi` | Rewrites `src/data/openapi.json` from the API's generated OpenAPI document (see "API reference" below)                                                                                                                                                        |
| `pnpm snapshot:dates`   | Rewrites `src/data/source-dates.json`: last commit date of each page source, the sitemap's fallback on a shallow checkout                                                                                                                                     |
| `pnpm indexnow:submit`  | Submits the live sitemap to IndexNow. Pass `-- --dry-run` to print the URLs and send nothing. Not part of CI or deploy; see [docs/INDEXNOW.md](docs/INDEXNOW.md)                                                                                              |

The scripts set `ASTRO_TELEMETRY_DISABLED=1`, and the dev toolbar is off, so nothing phones home.
Lint with oxlint and check formatting with oxfmt from the repo root (`pnpm lint`, `pnpm format:check`).
oxlint lints the frontmatter and `<script>` blocks of `.astro` files but not their markup, and does not
lint `.mdx`. oxfmt has no Astro support, and it corrupts JSX components wrapped around Markdown in `.mdx`
(for example a code block inside `<Steps>`), so `.astro` and `.mdx` files are not formatted: both are
listed in `.prettierignore`. Format MDX by hand and follow the surrounding file.

## Layout

```
astro.config.ts          site URL, trailing slashes, MDX, sitemap (noindex excluded, lastmod from the page), Shiki, Vite
src/config/site.ts       URLs (site, app, signup, repository), contact addresses, cloudLaunched switch
src/config/pricing.ts    THE source of truth for price, trial and plan features
src/config/pages.ts      title and description of every hand-written page (also feeds social images)
src/config/nav.ts        header navigation and footer site map
src/content.config.ts    content collections and their Zod schemas
src/content/             blog, authors, docs, legal, compare, countries, features, changelog
src/layouts/             BaseLayout (head, header, footer), PageLayout, EntryLayout, DocsLayout
src/components/          design-system components (see CONTENT-GUIDE.md) and visuals/
src/lib/                 facts (numbers read from @glideworth/core), jsonld, og (social images), docs, content
src/styles/              tokens.css (colours, type, space), global.css
src/pages/               routes; og/[...slug].png.ts draws the social images
scripts/                 check-dist, check-contrast, generate-icons, snapshot-openapi, snapshot-source-dates
src/data/openapi.json    snapshot of the API's OpenAPI document; the API reference page is built from it
src/data/source-dates.json  last commit date of each page source (sitemap lastmod when git history is shallow)
src/config/related.ts    clusters of related pages (every page in a cluster links to the others)
src/landing/             the country versions of the home page (see "Country landing pages" below)
public/                  favicons, app icons (generated from /brand) and the IndexNow key file
/llms.txt                short catalog of the site for language models, generated at build time
/llms-full.txt           the same catalog plus country tax limits and the legal pages
/docs/<slug>.md          Markdown twin of every docs page, written from the built HTML after the build
                         (src/lib/markdown-twin.ts, astro.config.ts); `astro dev` does not serve them
/.well-known/skills/default/skill.md   the agent skill, served unchanged from skills/glideworth/SKILL.md
```

## Analytics (optional, off by default)

The site can load Google Tag Manager. It does so only when `PUBLIC_GTM_ID` is set, at **build** time, to a
container id (`GTM-` and then letters and digits). [`.env.example`](./.env.example) leaves it unset. Leave it
unset for any build that is not the official hosted website, including a self-hosted copy: those pages then
never contact Google.

The production deploy sets the variable. Staging does not. The signed-in app (`apps/web`) does not read it
and does not load the tag. Pages under `/tools/` do not load it either, so figures typed into a calculator
stay in the browser.

The loader is the Google Tag Manager snippet, without the usual noscript iframe (it cannot respect consent).
Before `gtm.js` runs, the page sets Google Consent Mode v2 defaults: advertising storage, ad user data, ad
personalisation and analytics storage are denied. Pages that load the tag also show a consent banner
(`src/components/ConsentBanner.astro`) with "Accept analytics" and "Reject" given equal weight. Accepting grants
`analytics_storage` only; advertising storage is never granted. The answer is kept in local storage under
`glideworth-consent` for 12 months (`src/lib/consent.ts`), applied before `gtm.js` loads on later visits, and
"Cookie settings" in the footer reopens the banner. A build without `PUBLIC_GTM_ID` has no banner.

## Design system

- **Colour.** Warm paper neutrals, spruce accent (`--accent`), ochre emphasis (`--ochre`), terracotta for
  risk (`--risk`), and a deep spruce band for the hero panel and closing call to action. Every colour is
  defined once with `light-dark()` in `src/styles/tokens.css`; the theme follows the system unless the
  visitor uses the toggle (stored in `localStorage.theme`, applied before first paint). `pnpm
  check:contrast` verifies AA for every text pair in both themes.
- **Type.** Fraunces (variable, optical sizes) for display, Inter (variable) for text and figures, both
  self-hosted from Fontsource. Fluid scale `--text-xs` … `--text-4xl`.
- **Logo.** An origami bird in deep green with one sand wing-tip facet, and the Glideworth wordmark as
  outlines. The artwork lives in `/brand` (see `brand/README.md`); `src/components/Logo.astro` and
  `src/lib/brand.ts` (social images) read it from there, and `scripts/generate-icons.mjs` (`pnpm icons`)
  regenerates the favicons from it. After changing the artwork, also run `pnpm --filter @glideworth/web icons`.

## Honest numbers

`src/lib/facts.ts` reads what it can from the engine at build time (the number of countries with a
national tax model, the engine version, the count of written simplifications per tax model) so the site
cannot drift from the code. The API and MCP counts are counted from the code, not copied from the docs:

- `apiOperations` is the number of operations in the hosted service's OpenAPI 3.1 document
  (`https://app.glideworth.com/openapi.json`: cloud mode with Google sign-in configured), which is what people
  who sign up from this site use. It is typed into `facts.ts`; `apps/api/test/cloud-isolation.test.ts` boots
  that configuration and fails when the number differs.
- `apiOperationsSelfHost` is counted at build time from the self-host snapshot `src/data/openapi.json` (below);
  `apps/api/test/openapi.test.ts` fails when the snapshot's count differs from the code's.
- `mcpTools`, `mcpReadTools` and `mcpWriteTools` are what `apps/api/test/tool-count.test.ts` counts: the tools
  the MCP server registers with every scope and writes on, and how many of them carry the read-only hint.

When the API or the tools change, take a new snapshot (below) and update the typed numbers in `facts.ts`. In frontmatter, use
`{{apiOperations}}`-style tokens (see CONTENT-GUIDE.md); the content schemas replace them.

## Country landing pages

The home page has one version per country: `/` is the United States version and the default, and the
others live at `/<slug>/` (`/uk/`). The slug is the one of the country's `/planning/<slug>/` page. Nobody is
redirected, and no URL changes its content by location.

- **One entry per country**: `src/landing/countries/<slug>.ts` exports a `LandingEntry`
  (`src/landing/types.ts`). `src/landing/registry.ts` lists the entries; the first, the United States, is
  `/` and the `x-default`.
- **One template**: `src/components/landing/LandingPage.astro` renders every version with the home page's
  sections. `src/pages/index.astro` passes the US entry; `src/pages/[country].astro` the others.
- **Generated from the registry**: the route, the `hreflang` set on every version (each version plus
  `x-default`, absolute and reciprocal), the footer switcher, the banner, the sitemap, the social image and
  the `llms.txt` line.
- **The banner** (`src/components/landing/CountryBanner.astro`) is sent hidden and empty to everyone. In the
  browser, `src/landing/guess.ts` guesses the country from the time zone (it wins when it lies in one
  country) and then the first language region (`en-GB`), with no network call. When the guess, or a
  version the visitor picked, has another version, the banner offers it with one link. Following a version
  link or closing the banner writes `localStorage.country` (a country code or `closed`); nothing else is
  stored or sent. None of this may reach `src/tools`: `src/tools/privacy.test.ts` checks the calculator
  bundles.

### Adding a country (`/ca/`, `/au/`)

1. Copy `src/landing/countries/uk.ts` to `src/landing/countries/<slug>.ts` and rewrite it for that country:
   `code`, `slug`, `hreflang` (`en-CA`), `countryName`, `label` (`Canada` reads well in "Looking for the
   Canada version?"), `lang`, `ogLocale`, `seo` (title, description, OG title and eyebrow, the primary
   keyword), `money`, `hero`, `proof`, `questions`, `working`, `taxSection`, and `local` (accounts,
   calculators from `src/tools/registry.ts`, notes the product makes about the country, further reading).
2. Add it to `LANDINGS` in `src/landing/registry.ts`. Nothing else in the template, layout or route changes.
3. Add a row for `/<slug>/` to `docs/seo-keyword-map.md` with a primary keyword no other URL owns (not the
   country's tax keyword, which `/planning/<slug>/`'s row owns), and link `/planning/<slug>/` to the new page
   with that keyword as the anchor.
4. **Figures**: type no tax rate, threshold, allowance or pension amount. Read each from `@glideworth/core` at
   build time (the country's tax tables, `defaultsForCountry`, `TAX_SIMPLIFICATIONS`), as `uk.ts` does. The tax
   visual (`working.taxYear`) comes from `richestTaxYear()` (`src/landing/tax-example.ts`) on a synthetic
   document from `@glideworth/core/samples`; if there is no sample for the country, leave `taxYear` out and
   the figure is not drawn. Leave out anything you cannot get this way.
5. `pnpm --filter @glideworth/site test` (`src/landing/landing.test.ts` checks the title length, the keyword
   map and, after a build, the hreflang set), then commit and run `pnpm snapshot:dates` (it reads git log, so
   after the commit) and commit `src/data/source-dates.json`.

## API reference

`/docs/api-and-mcp/api-reference/` lists every operation of the API grouped by tag: method, path, summary,
required scope, parameters, request body and response schema names. It is plain HTML generated at build time
by `src/components/ApiReference.astro` from `src/data/openapi.json`, so it needs no script, viewer or request
to another origin, and the browser's find command searches all of it.

The snapshot is produced by `pnpm --filter @glideworth/site snapshot:openapi` (`scripts/snapshot-openapi.mjs`).
The script runs the API app in memory under the API's own `tsx --conditions=@glideworth/source`, requests
`/openapi.json`, writes it to `src/data/openapi.json` and prints the operation count. Commit the snapshot with the API change that caused it. The file is
excluded from oxfmt and oxlint (`.prettierignore`, `.oxlintignore`) because it is generated.

## Running the engine in the browser

The free calculators (a later wave) run the real planning engine client-side. The groundwork:

1. `@glideworth/core` is a workspace dependency (`"@glideworth/core": "workspace:*"`).
2. Its `package.json` exports a custom condition, `@glideworth/source`, that points at the TypeScript source
   (`./src/index.ts`). `apps/web` resolves it in Vite; here a small Vite plugin in `astro.config.ts`
   (`workspaceSource`) adds the condition to every Vite environment Astro 7 creates (client, ssr,
   prerender, astro). No package build is needed first.
3. `tsconfig.json` sets `"customConditions": ["@glideworth/source"]` so `astro check` type-checks against the
   same source.
4. Proof: `/tools/engine-check/` (noindex, not in the sitemap). Its client `<script>` imports
   `progressiveTax` statically (tree-shaken to a 3 KB page script) and renders the result on load; a button
   lazily imports `src/lib/engine-demo.ts`, which runs `simulate()` on the synthetic sample household. The
   engine is a separate ~0.5 MB chunk that downloads only on demand (hence `chunkSizeWarningLimit`, as in
   apps/web).

For a calculator: put the engine call in a module under `src/lib/`, import it with `await import()` from
the page's `<script>` (or eagerly if the page needs it on load), and keep the inputs in the URL so they can
be carried into the full planner. No UI framework is installed; add one (`@astrojs/preact` is the light
choice) only if a calculator truly needs it.

Building `@glideworth/core` from source means its own tests are the guarantee of correctness; the site does
not re-test the engine.
