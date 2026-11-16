/**
 * Social images (Open Graph and Twitter), 1200x630 PNG, drawn at build time with satori (layout to SVG)
 * and resvg (SVG to PNG), using the self-hosted Fraunces and Inter files. No network access.
 *
 * Every page gets /og/<path>.png (the home page gets /og/index.png). The list of images is
 * ogEntries() below: hand-written pages from src/config/pages.ts plus every collection entry.
 */

import { getCollection } from "astro:content";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pages } from "../config/pages";
import { site } from "../config/site";
import { aspect, brandColors as c, LOGO_SVG, MARK_SVG, svgDataUri } from "./brand";
import { publishedPosts, tagSlug } from "./content";

export interface OgEntry {
  /** Site path of the page, with trailing slash. */
  path: string;
  title: string;
  eyebrow?: string;
  description?: string;
}

/** Image path for a page path: "/" -> "/og/index.png", "/blog/x/" -> "/og/blog/x.png". */
export function ogImagePath(path: string): string {
  const clean = path.replace(/^\/|\/$/g, "");
  return `/og/${clean || "index"}.png`;
}

export const DEFAULT_OG_PATH = "/og/default.png";

/** Every page that has its own social image. */
export async function ogEntries(): Promise<OgEntry[]> {
  const entries: OgEntry[] = Object.entries(pages).map(([path, m]) => ({
    path,
    title: "ogTitle" in m && m.ogTitle ? m.ogTitle : m.title,
    eyebrow: "ogEyebrow" in m ? m.ogEyebrow : undefined,
    description: m.description,
  }));

  const posts = await publishedPosts();
  for (const p of posts) {
    entries.push({
      path: `/blog/${p.id}/`,
      title: p.data.ogTitle ?? p.data.title,
      eyebrow: "Blog",
      description: p.data.description,
    });
  }
  for (const tag of new Set(posts.flatMap((p) => p.data.tags))) {
    entries.push({
      path: `/blog/tags/${tagSlug(tag)}/`,
      title: `Articles about ${tag}`,
      eyebrow: "Blog",
    });
  }
  for (const a of await getCollection("authors")) {
    entries.push({
      path: `/authors/${a.id}/`,
      title: a.data.name,
      eyebrow: "Author",
      description: a.data.bio,
    });
  }
  const simple = [
    ["docs", "/docs/", "Docs"],
    ["legal", "/legal/", "Legal"],
    ["compare", "/compare/", "Comparison"],
    ["features", "/features/", "Features"],
  ] as const;
  for (const [name, base, eyebrow] of simple) {
    for (const e of await getCollection(name)) {
      entries.push({
        path: `${base}${e.id}/`,
        title: e.data.ogTitle ?? e.data.title,
        eyebrow,
        description: e.data.description,
      });
    }
  }
  for (const e of await getCollection("countries")) {
    entries.push({
      path: `/planning/${e.id}/`,
      title: e.data.ogTitle ?? e.data.title,
      eyebrow: "Planning by country",
      description: e.data.description,
    });
  }
  return entries;
}

// ------------------------------------------------------------------------------------------ drawing

let fontsPromise:
  | Promise<{ name: string; data: Buffer; weight: 400 | 500 | 600; style: "normal" }[]>
  | undefined;

function loadFonts() {
  // Resolve from the site package, not from the bundled chunk that runs this code.
  const require = createRequire(join(process.cwd(), "package.json"));
  const file = (pkg: string, name: string) => readFile(require.resolve(`${pkg}/files/${name}`));
  fontsPromise ??= Promise.all([
    file("@fontsource/fraunces", "fraunces-latin-500-normal.woff"),
    file("@fontsource/fraunces", "fraunces-latin-600-normal.woff"),
    file("@fontsource/inter", "inter-latin-400-normal.woff"),
    file("@fontsource/inter", "inter-latin-600-normal.woff"),
  ]).then(([f500, f600, i400, i600]) => [
    { name: "Fraunces", data: f500, weight: 500, style: "normal" },
    { name: "Fraunces", data: f600, weight: 600, style: "normal" },
    { name: "Inter", data: i400, weight: 400, style: "normal" },
    { name: "Inter", data: i600, weight: 600, style: "normal" },
  ]);
  return fontsPromise;
}

type Node = {
  type: string;
  props: Record<string, unknown> & { style?: Record<string, unknown>; children?: unknown };
};
const h = (
  type: string,
  style: Record<string, unknown>,
  children?: unknown,
  extra: Record<string, unknown> = {},
): Node => ({
  type,
  props: { style, children, ...extra },
});

/** A large, faint copy of the bird on the right of every image (the green mark at low opacity). */
const WATERMARK = svgDataUri(MARK_SVG.replace("<svg ", '<svg opacity="0.09" '));
const WATERMARK_H = 470;
const LOGO_H = 64;

/** Shortens to `max` characters, preferring a whole sentence, else whole words with an ellipsis. */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const sentence = cut.lastIndexOf(". ");
  if (sentence > max * 0.5) return cut.slice(0, sentence + 1);
  return `${cut.replace(/\s+\S*$/, "").replace(/[,;:]$/, "")}…`;
}

function titleSize(title: string): number {
  if (title.length <= 28) return 76;
  if (title.length <= 48) return 64;
  if (title.length <= 70) return 54;
  return 46;
}

export async function renderOgImage(entry: OgEntry): Promise<Buffer> {
  const [{ default: satori }, { Resvg }] = await Promise.all([
    import("satori"),
    import("@resvg/resvg-js"),
  ]);
  const host = new URL(site.url).host;
  const urlText = entry.path === "/" ? host : `${host}${entry.path.replace(/\/$/, "")}`;

  const tree = h(
    "div",
    {
      width: "100%",
      height: "100%",
      display: "flex",
      flexDirection: "column",
      justifyContent: "space-between",
      padding: "64px 72px",
      background: c.paper,
      fontFamily: "Inter",
      position: "relative",
    },
    [
      h(
        "img",
        {
          position: "absolute",
          right: 56,
          top: 100,
          width: Math.round(WATERMARK_H * aspect(MARK_SVG)),
          height: WATERMARK_H,
        },
        undefined,
        { src: WATERMARK, width: Math.round(WATERMARK_H * aspect(MARK_SVG)), height: WATERMARK_H },
      ),
      h("img", { width: Math.round(LOGO_H * aspect(LOGO_SVG)), height: LOGO_H }, undefined, {
        src: svgDataUri(LOGO_SVG),
        width: Math.round(LOGO_H * aspect(LOGO_SVG)),
        height: LOGO_H,
      }),
      h("div", { display: "flex", flexDirection: "column", gap: 22, maxWidth: 820 }, [
        ...(entry.eyebrow
          ? [
              h(
                "div",
                {
                  fontSize: 22,
                  fontWeight: 600,
                  letterSpacing: 3,
                  textTransform: "uppercase",
                  color: c.ochre,
                },
                entry.eyebrow,
              ),
            ]
          : []),
        h(
          "div",
          {
            fontFamily: "Fraunces",
            fontWeight: 500,
            fontSize: titleSize(entry.title),
            lineHeight: 1.08,
            letterSpacing: -1.5,
            color: c.ink,
          },
          truncate(entry.title, 100),
        ),
        ...(entry.description
          ? [
              h(
                "div",
                { fontSize: 26, lineHeight: 1.45, color: c.ink2, maxWidth: 760 },
                truncate(entry.description, 125),
              ),
            ]
          : []),
      ]),
      h("div", { display: "flex", fontSize: 22, color: c.ink3, fontWeight: 600 }, urlText),
    ],
  );

  const svg = await satori(tree as unknown as Parameters<typeof satori>[0], {
    width: 1200,
    height: 630,
    fonts: await loadFonts(),
  });
  return new Resvg(svg, { fitTo: { mode: "width", value: 1200 }, font: { loadSystemFonts: false } })
    .render()
    .asPng();
}
