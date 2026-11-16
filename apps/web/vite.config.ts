import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defaultClientConditions, loadEnv, type Plugin } from "vite";
import { defineConfig } from "vitest/config";

/**
 * Fills the service worker's asset lists at build time (public/sw.js has the placeholders):
 *  - PRECACHE: what the first render needs (the entry chunk, every chunk it imports statically, its
 *    CSS and the fonts), installed atomically, so the app opens offline after one online visit;
 *  - WARM: every other script (route chunks, workers), fetched in the background once the worker is
 *    active, so any page works offline too.
 * The cache version is a hash of both lists, so a new build replaces the old cache.
 */
function serviceWorkerManifest(): Plugin {
  let outDir = "dist";
  let precache: string[] = [];
  let warm: string[] = [];
  return {
    name: "glideworth-sw-manifest",
    apply: "build",
    configResolved(c) {
      outDir = resolve(c.root, c.build.outDir);
    },
    generateBundle(_o, bundle) {
      const files = Object.values(bundle);
      const entry = files.find(
        (f) => f.type === "chunk" && f.isEntry && f.facadeModuleId?.endsWith(".html"),
      );
      if (entry?.type !== "chunk") return;
      const initial = new Set<string>();
      const walk = (name: string) => {
        const c = bundle[name];
        if (c?.type !== "chunk" || initial.has(name)) return;
        initial.add(name);
        for (const css of c.viteMetadata?.importedCss ?? []) initial.add(css);
        for (const i of c.imports) walk(i);
      };
      walk(entry.fileName);
      for (const f of files) if (f.fileName.endsWith(".woff2")) initial.add(f.fileName);
      precache = [...initial].sort().map((f) => `/${f}`);
      // Hosted-mode ("cloud") screens are fetched on demand when the server says it is cloud; a self-host
      // install must not download them in the background. A chunk is cloud-only when it holds code from
      // features/cloud and no other app code, and no other chunk imports it statically (the guided setup
      // does import the small hand-off module, so that one stays in the list).
      const isCloudModule = (id: string) => id.includes("/apps/web/src/features/cloud/");
      const isAppModule = (id: string) => id.includes("/apps/web/src/");
      const modulesOf = (f: (typeof files)[number]) =>
        f.type === "chunk" ? Object.keys(f.modules) : [];
      const isCloudChunk = (f: (typeof files)[number]) =>
        modulesOf(f).some(isCloudModule) &&
        modulesOf(f).every((id) => !isAppModule(id) || isCloudModule(id));
      const staticallyImported = new Set<string>();
      for (const f of files)
        if (f.type === "chunk" && !isCloudChunk(f))
          for (const i of f.imports) staticallyImported.add(i);
      const cloudOnly = (f: (typeof files)[number]) =>
        isCloudChunk(f) && !staticallyImported.has(f.fileName);
      warm = files
        .filter((f) => f.fileName.endsWith(".js") && !initial.has(f.fileName) && !cloudOnly(f))
        .map((f) => `/${f.fileName}`)
        .sort();
    },
    closeBundle() {
      const file = resolve(outDir, "sw.js");
      const hash = createHash("sha256")
        .update(JSON.stringify([precache, warm]))
        .digest("hex")
        .slice(0, 12);
      const sw = readFileSync(file, "utf8")
        .replace("/*__PRECACHE__*/ []", JSON.stringify(precache))
        .replace("/*__WARM__*/ []", JSON.stringify(warm))
        .replace("/*__BUILD__*/ 'dev'", JSON.stringify(hash));
      writeFileSync(file, sw);
    },
  };
}

const root = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig(({ mode }) => {
  // Load GLIDEWORTH_* (and the pre-rename CAIRN_* aliases) from the repo-root .env. These stay on the dev
  // server (never exposed to the bundle). The new name wins when both are set, as in apps/api/src/config.ts.
  const env = loadEnv(mode, root, ["GLIDEWORTH_", "CAIRN_"]);
  const legacy: string[] = [];
  const read = (
    name: string,
    from: Record<string, string | undefined> = env,
  ): string | undefined => {
    if (from[`GLIDEWORTH_${name}`]) return from[`GLIDEWORTH_${name}`];
    if (from[`CAIRN_${name}`] !== undefined) legacy.push(`CAIRN_${name}`);
    return from[`CAIRN_${name}`];
  };
  const target = read("API_URL") ?? "http://localhost:8787";
  const apiKey = read("API_KEY");
  const headers: Record<string, string> = apiKey ? { authorization: `Bearer ${apiKey}` } : {};
  const port = Number(read("WEB_PORT", process.env) ?? 5173);
  if (legacy.length && mode !== "test")
    console.warn(
      `[glideworth] deprecated environment variable names in use (rename CAIRN_ to GLIDEWORTH_): ${legacy.join(", ")}`,
    );
  return {
    plugins: [react(), tailwindcss(), serviceWorkerManifest()],
    resolve: {
      conditions: ["@glideworth/source", ...defaultClientConditions],
      alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
    },
    worker: { format: "es" },
    server: {
      port,
      strictPort: true,
      proxy: {
        "/api": { target, changeOrigin: true, headers },
        "/health": { target, changeOrigin: true },
        "/docs": { target, changeOrigin: true },
        "/openapi.json": { target, changeOrigin: true },
        // (i) MCP endpoint, for the live connection test in Settings → AI & integrations.
        "/mcp": { target, changeOrigin: true, headers },
      },
    },
    build: { target: "es2022", sourcemap: true, chunkSizeWarningLimit: 1500 },
    test: {
      name: "web",
      environment: "jsdom",
      include: ["test/**/*.test.{ts,tsx}"],
    },
  };
});
