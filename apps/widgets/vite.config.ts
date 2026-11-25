import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";

const here = fileURLToPath(new URL(".", import.meta.url));
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Inlines the entry script and the stylesheet into index.html, so the widget is one self-contained file: hosts
 * render it in a sandboxed iframe from an MCP resource, with no server to fetch assets from.
 */
function inlineAssets(): Plugin {
  return {
    name: "glideworth-widget-inline-assets",
    apply: "build",
    enforce: "post",
    generateBundle(_options, bundle) {
      const html = Object.values(bundle).find(
        (file) => file.type === "asset" && file.fileName.endsWith(".html"),
      );
      if (html?.type !== "asset") return;
      let source = String(html.source);
      for (const [name, file] of Object.entries(bundle)) {
        if (file.type === "chunk" && file.isEntry) {
          const code = file.code.replace(/<\/script/gi, "<\\/script");
          source = source.replace(
            new RegExp(`<script[^>]*src="[^"]*${escapeRegExp(name)}"[^>]*></script>`),
            () => `<script type="module">${code}</script>`,
          );
          delete bundle[name];
        } else if (file.type === "asset" && name.endsWith(".css")) {
          const css = String(file.source).replace(/<\/style/gi, "<\\/style");
          source = source.replace(
            new RegExp(`<link[^>]*href="[^"]*${escapeRegExp(name)}"[^>]*>`),
            () => `<style>${css}</style>`,
          );
          delete bundle[name];
        }
      }
      html.source = source;
    },
  };
}

export default defineConfig({
  root: here,
  base: "./",
  publicDir: false,
  plugins: [react(), inlineAssets()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    assetsInlineLimit: Number.MAX_SAFE_INTEGER,
    cssCodeSplit: false,
    modulePreload: false,
    sourcemap: false,
    target: "es2022",
    rolldownOptions: { output: { codeSplitting: false } },
  },
  test: {
    name: "widgets",
    environment: "jsdom",
    include: ["test/**/*.test.{ts,tsx}"],
  },
});
