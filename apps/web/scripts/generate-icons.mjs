/**
 * Writes the web app's icon set into public/ from the masters in /brand (the only source of the mark), so the
 * app and the marketing site share one identity:
 *   glideworth.svg                  favicon, brand/icon-tile-small.svg (simplified gaps, carries its own tile)
 *   icons/apple-touch-icon.png (180) brand/icon-tile.svg on an opaque square
 *   icons/icon-192.png, icon-512.png brand/icon-tile.svg
 *   icons/icon-maskable-192.png, icon-maskable-512.png   brand/icon-maskable.svg
 * Run after changing the artwork: `pnpm --filter @glideworth/web icons`. The outputs are committed.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";

const here = dirname(fileURLToPath(import.meta.url));
const pub = join(here, "..", "public");
const brand = (name) => readFileSync(join(here, "..", "..", "..", "brand", name), "utf8");

const TILE = brand("icon-tile.svg");
const SMALL = brand("icon-tile-small.svg");
const MASKABLE = brand("icon-maskable.svg");
const SQUARE = TILE.replace(' rx="112"', "");

const png = (svg, size) =>
  new Resvg(svg, { fitTo: { mode: "width", value: size }, font: { loadSystemFonts: false } })
    .render()
    .asPng();

mkdirSync(join(pub, "icons"), { recursive: true });
writeFileSync(join(pub, "glideworth.svg"), SMALL);
writeFileSync(join(pub, "icons", "apple-touch-icon.png"), png(SQUARE, 180));
writeFileSync(join(pub, "icons", "icon-192.png"), png(TILE, 192));
writeFileSync(join(pub, "icons", "icon-512.png"), png(TILE, 512));
writeFileSync(join(pub, "icons", "icon-maskable-192.png"), png(MASKABLE, 192));
writeFileSync(join(pub, "icons", "icon-maskable-512.png"), png(MASKABLE, 512));
console.log("Icons written to apps/web/public/");
