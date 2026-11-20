/**
 * Serves the built web app (apps/web/dist) with SPA fallback, so the whole product runs as one
 * process on one port. Only used when a dist directory exists and serving is enabled.
 */
import { createHash } from "node:crypto";
import { type FileHandle, open } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import type { MiddlewareHandler } from "hono";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".wasm": "application/wasm",
};

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "same-origin",
};

/** Paths the API owns: they are never answered with the SPA shell. */
export function isApiPath(path: string): boolean {
  return (
    path.startsWith("/api/") ||
    path === "/api" ||
    path === "/mcp" ||
    path === "/docs" ||
    path === "/openapi.json" ||
    path === "/health"
  );
}

/**
 * GET/HEAD handler: the file if it exists under `root`, else (for extension-less paths, i.e. client
 * routes) `index.html`. Missing assets are real 404s so a broken deploy is visible.
 */
export function staticSite(rootDir: string): MiddlewareHandler {
  const root = resolve(rootDir);
  const etags = new Map<string, string>();

  async function load(file: string): Promise<{ body: Buffer; etag: string; type: string } | null> {
    let fh: FileHandle;
    try {
      fh = await open(file, "r");
    } catch {
      return null;
    }
    try {
      const st = await fh.stat();
      if (!st.isFile()) return null;
      const key = `${file}:${st.mtimeMs}:${st.size}`;
      const body = await fh.readFile();
      let etag = etags.get(key);
      if (!etag) {
        etag = `"${createHash("sha1").update(body).digest("base64url").slice(0, 20)}"`;
        etags.set(key, etag);
      }
      return { body, etag, type: TYPES[extname(file).toLowerCase()] ?? "application/octet-stream" };
    } catch {
      return null;
    } finally {
      await fh.close();
    }
  }

  return async (c, next) => {
    if (c.req.method !== "GET" && c.req.method !== "HEAD") return next();
    let path: string;
    try {
      path = decodeURIComponent(new URL(c.req.url).pathname);
    } catch {
      return c.json({ error: { code: "VALIDATION", message: "malformed path" } }, 400);
    }
    if (isApiPath(path)) return next();
    const rel = normalize(path).replace(/^([/\\])+/, "");
    const file = resolve(join(root, rel));
    if (file !== root && !file.startsWith(root + sep))
      return c.json({ error: { code: "NOT_FOUND", message: "not found" } }, 404);
    let hit = rel && extname(rel) ? await load(file) : null;
    const isShell = !hit;
    if (!hit && !extname(rel)) hit = await load(join(root, "index.html"));
    if (!hit) return c.json({ error: { code: "NOT_FOUND", message: `'${path}' not found` } }, 404);
    const immutable = !isShell && /(^|\/)assets\//.test(rel);
    const headers: Record<string, string> = {
      "content-type": hit.type,
      etag: hit.etag,
      "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
      ...SECURITY_HEADERS,
    };
    if (c.req.method === "HEAD") return c.body(null, 200, headers);
    return c.body(new Uint8Array(hit.body), 200, headers);
  };
}
