/**
 * Writes the site's icon set into public/ from the masters in /brand (the only source of the mark):
 *   favicon.svg        brand/icon-tile-small.svg (simplified gaps; it carries its own tile, so it reads on
 *                      light and dark tabs and needs no prefers-color-scheme variant)
 *   favicon.ico        16 (brand/icon-tile-solid.svg), 32 and 48 (brand/icon-tile-small.svg)
 *   apple-touch-icon.png  180, brand/icon-tile.svg on an opaque square (iOS rounds the corners itself)
 *   icon-192.png, icon-512.png                brand/icon-tile.svg (rounded tile, transparent corners)
 *   icon-maskable-192.png, icon-maskable-512.png   brand/icon-maskable.svg (full bleed, mark in the safe zone)
 * Run after changing the artwork: `pnpm --filter @glideworth/site icons`. The outputs are committed, so the
 * site build does not depend on this script. The web app has its own (apps/web/scripts/generate-icons.mjs).
 * The site declares no Safari pinned-tab mask-icon, so none is generated.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";

const here = dirname(fileURLToPath(import.meta.url));
const pub = join(here, "..", "public");
const brand = (name) => readFileSync(join(here, "..", "..", "..", "brand", name), "utf8");

const TILE = brand("icon-tile.svg");
const SMALL = brand("icon-tile-small.svg");
const SOLID = brand("icon-tile-solid.svg");
const MASKABLE = brand("icon-maskable.svg");
const SQUARE = TILE.replace(' rx="112"', "");

const png = (svg, size) =>
  new Resvg(svg, { fitTo: { mode: "width", value: size }, font: { loadSystemFonts: false } })
    .render()
    .asPng();

/** An .ico holding PNG images (supported by every current browser). */
function ico(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const dir = Buffer.alloc(16 * images.length);
  let offset = 6 + dir.length;
  images.forEach(({ size, data }, i) => {
    const o = i * 16;
    dir.writeUInt8(size >= 256 ? 0 : size, o);
    dir.writeUInt8(size >= 256 ? 0 : size, o + 1);
    dir.writeUInt8(0, o + 2);
    dir.writeUInt8(0, o + 3);
    dir.writeUInt16LE(1, o + 4);
    dir.writeUInt16LE(32, o + 6);
    dir.writeUInt32LE(data.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += data.length;
  });
  return Buffer.concat([header, dir, ...images.map((im) => im.data)]);
}

writeFileSync(join(pub, "favicon.svg"), SMALL);
writeFileSync(
  join(pub, "favicon.ico"),
  ico([
    { size: 16, data: png(SOLID, 16) },
    { size: 32, data: png(SMALL, 32) },
    { size: 48, data: png(SMALL, 48) },
  ]),
);
writeFileSync(join(pub, "apple-touch-icon.png"), png(SQUARE, 180));
writeFileSync(join(pub, "icon-192.png"), png(TILE, 192));
writeFileSync(join(pub, "icon-512.png"), png(TILE, 512));
writeFileSync(join(pub, "icon-maskable-192.png"), png(MASKABLE, 192));
writeFileSync(join(pub, "icon-maskable-512.png"), png(MASKABLE, 512));
console.log("Icons written to apps/site/public/");
