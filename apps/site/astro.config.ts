import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import mdx from "@astrojs/mdx";
import sitemap from "@astrojs/sitemap";
import type { AstroIntegration } from "astro";
import { defineConfig, envField } from "astro/config";
import { defaultClientConditions, defaultServerConditions, type Plugin } from "vite";
import { site } from "./src/config/site";
import { shikiDark, shikiLight } from "./src/lib/shiki-theme";
import { lastmodForUrl } from "./src/lib/sitemap-dates";

const outDir = fileURLToPath(new URL("./dist/", import.meta.url));

/**
 * A page is left out of the sitemap when its built HTML carries `<meta name="robots" content="noindex…">`.
 * One switch (the `noindex` prop on BaseLayout, or `noindex: true` in frontmatter) covers both.
 */
function isIndexable(page: string): boolean {
  const path = new URL(page).pathname;
  const file = join(outDir, path, path.endsWith("/") ? "index.html" : "");
  if (!existsSync(file)) return true;
  return !/<meta name="robots" content="[^"]*noindex/.test(readFileSync(file, "utf8"));
}

/**
 * Serves the sitemap index at the conventional /sitemap.xml too (issue #22): many crawlers and SEO tools
 * only try that URL, and @astrojs/sitemap writes sitemap-index.xml. An Astro `redirects` entry would emit
 * an HTML meta-refresh page, not an HTTP redirect, so a crawler would get HTML at sitemap.xml; a Caddy
 * redirect would only reach production with the next app deploy, not with deploy-site.sh. A copy of the
 * integration's own output ships with the site, is served as XML by any static host and cannot drift.
 * It must come after sitemap() in `integrations`: their build:done hooks run in that order.
 */
function sitemapAlias(): AstroIntegration {
  return {
    name: "glideworth:sitemap-alias",
    hooks: {
      "astro:build:done": ({ dir }) => {
        const out = fileURLToPath(dir);
        copyFileSync(join(out, "sitemap-index.xml"), join(out, "sitemap.xml"));
      },
    },
  };
}

/**
 * Workspace packages (`@glideworth/core`) resolve to their TypeScript source through the custom export
 * condition `@glideworth/source`, as in apps/web, so the browser bundle and build-time code run the real
 * engine without a separate package build. Astro 7 runs several Vite environments (client, ssr,
 * prerender, astro), so the condition is added to each one. See README.md.
 */
function workspaceSource(): Plugin {
  return {
    name: "glideworth:workspace-source",
    configEnvironment(name, config) {
      config.resolve ??= {};
      const base =
        config.resolve.conditions ??
        (name === "client" ? defaultClientConditions : defaultServerConditions);
      config.resolve.conditions = [
        "@glideworth/source",
        ...base.filter((c) => c !== "@glideworth/source"),
      ];
    },
  };
}

export default defineConfig({
  site: site.url,
  output: "static",
  // PUBLIC_GTM_ID is optional and empty unless the official production build sets it.
  // A missing or blank value must still build: self-hosted copies never load the tag.
  env: {
    schema: {
      PUBLIC_GTM_ID: envField.string({
        context: "server",
        access: "public",
        optional: true,
        default: "",
      }),
      // PostHog (cookieless, src/lib/posthog.ts): set only by the official production build.
      PUBLIC_POSTHOG_PROJECT_TOKEN: envField.string({
        context: "server",
        access: "public",
        optional: true,
        default: "",
      }),
      PUBLIC_POSTHOG_HOST: envField.string({
        context: "server",
        access: "public",
        optional: true,
        default: "",
      }),
    },
  },
  trailingSlash: "always",
  build: { format: "directory" },
  // Off: compression drops the space between text and an inline element that a line break separates
  // ("under the<a>licence</a>"), which many pages rely on.
  compressHTML: false,
  // Pages that were merged into another: the old address forwards to the new one.
  redirects: {
    "/docs/api-and-mcp/connect-an-ai-assistant/": "/docs/api-and-mcp/mcp-setup/",
    // Moving-country planning was removed from the product (2026-11); its pages forward to the nearest topic.
    "/planning/moving-country/": "/planning/",
    "/features/cross-border/": "/features/tax-estimates/",
    "/blog/planning-a-move-abroad-taxes-pensions/": "/blog/",
  },
  // No telemetry from the dev toolbar either; the scripts also set ASTRO_TELEMETRY_DISABLED.
  devToolbar: { enabled: false },
  prefetch: false,
  integrations: [
    mdx(),
    sitemap({
      filter: isIndexable,
      // A real date per URL (frontmatter, else the source file's last commit). Not the build clock.
      serialize(item) {
        const lastmod = lastmodForUrl(item.url);
        return lastmod ? { ...item, lastmod } : item;
      },
    }),
    sitemapAlias(),
  ],
  markdown: {
    shikiConfig: {
      themes: { light: shikiLight, dark: shikiDark },
      defaultColor: false,
      wrap: false,
      // Shiki has no Caddyfile grammar: show it as plain text rather than warn on every build.
      langAlias: { caddyfile: "text" },
    },
  },
  server: { port: 4321, host: "127.0.0.1" },
  vite: {
    plugins: [workspaceSource()],
    // The planning engine is one lazy chunk of about 0.5 MB (only pages that run it load it, on demand);
    // the limit matches apps/web, which ships the same engine.
    build: { assetsInlineLimit: 0, chunkSizeWarningLimit: 1500 },
  },
});
