# Glideworth site (`apps/site`)

The marketing site for **glideworth.com**: a static Astro build with MDX content collections, generated
social images, structured data, a sitemap and RSS. The app lives at `app.glideworth.com`; docs live under
`/docs` on this site. Writers: start with [CONTENT-GUIDE.md](CONTENT-GUIDE.md).

## Commands

Run from `apps/site` (or `pnpm --filter @glideworth/site <script>` from the repo root):

| Command                 | What it does                                                                                                                                                                                                                                  |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm dev`              | Dev server on http://127.0.0.1:4321 (drafts visible)                                                                                                                                                                                          |
| `pnpm build`            | Static build into `dist/` (pages, social images, sitemap, RSS)                                                                                                                                                                                |
| `pnpm preview`          | Serves `dist/` on port 4321. Astro 7 runs it in the background: stop it with `pnpm astro preview stop`                                                                                                                                        |
| `pnpm typecheck`        | `astro check` (TypeScript strict, Astro files and content schemas)                                                                                                                                                                            |
| `pnpm check:dist`       | After a build: titles, descriptions (length, uniqueness), one h1, alt text, canonicals, OG images, JSON-LD, internal links (with trailing slash), `rel="noopener noreferrer"` on external links, third-party loads, sitemap, robots, RSS, XML |
| `pnpm check:contrast`   | WCAG contrast of the colour tokens in both themes                                                                                                                                                                                             |
| `pnpm icons`            | Regenerates the favicon set in `public/` from the mark                                                                                                                                                                                        |
| `pnpm snapshot:openapi` | Rewrites `src/data/openapi.json` from the API's generated OpenAPI document (see "API reference" below)                                                                                                                                        |
| `pnpm snapshot:dates`   | Rewrites `src/data/source-dates.json`: last commit date of each page source, the sitemap's fallback on a shallow checkout                                                                                                                     |

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
public/                  favicons and app icons (generated from /brand)
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
