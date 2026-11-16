import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import mdx from "@astrojs/mdx";
import sitemap from "@astrojs/sitemap";
import { defineConfig } from "astro/config";
import { defaultClientConditions, defaultServerConditions, type Plugin } from "vite";
import { site } from "./src/config/site";
import { shikiDark, shikiLight } from "./src/lib/shiki-theme";

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
  trailingSlash: "always",
  build: { format: "directory" },
  // Pages that were merged into another: the old address forwards to the new one.
  redirects: {
    "/docs/api-and-mcp/connect-an-ai-assistant/": "/docs/api-and-mcp/mcp-setup/",
  },
  // No telemetry from the dev toolbar either; the scripts also set ASTRO_TELEMETRY_DISABLED.
  devToolbar: { enabled: false },
  prefetch: false,
  integrations: [mdx(), sitemap({ filter: isIndexable })],
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
