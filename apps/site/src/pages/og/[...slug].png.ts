/** One social image per page, built at build time. See src/lib/og.ts. */
import type { APIRoute, GetStaticPaths } from "astro";
import { type OgEntry, ogEntries, ogImagePath, renderOgImage } from "../../lib/og";

export const getStaticPaths = (async () => {
  const entries = await ogEntries();
  const fallback: OgEntry = {
    path: "/default/",
    title: "Plan your glide path to and through retirement",
    eyebrow: "Glideworth",
  };
  return [...entries, fallback].map((entry) => ({
    params: {
      slug: ogImagePath(entry.path)
        .replace(/^\/og\//, "")
        .replace(/\.png$/, ""),
    },
    props: { entry },
  }));
}) satisfies GetStaticPaths;

export const GET: APIRoute<{ entry: OgEntry }> = async ({ props }) => {
  const png = await renderOgImage(props.entry);
  return new Response(new Uint8Array(png), { headers: { "Content-Type": "image/png" } });
};
