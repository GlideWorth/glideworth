# Glideworth brand artwork

The approved logo is an origami bird (the **mark**) with the word "Glideworth" (the **wordmark**). These
SVGs are the single source: the marketing site, the web app and every generated icon read from here.

The name and the logo are covered by [`TRADEMARKS.md`](../TRADEMARKS.md). The software licence does not
grant any right to use them; read that policy before using the files outside this repository.

## Files

| File                  | Use                                                                                      |
| --------------------- | ---------------------------------------------------------------------------------------- |
| `mark.svg`            | The bird, green facets and a sand wing tip, transparent background. Light backgrounds.   |
| `mark-light.svg`      | The bird with off-white facets and the sand wing tip. Dark backgrounds.                  |
| `mark-mono.svg`       | One colour via `currentColor` (all facets, wing tip included). Print, stamps, embossing. |
| `logo.svg`            | Horizontal lockup, mark plus wordmark, for light backgrounds.                            |
| `logo-light.svg`      | The same lockup for dark backgrounds.                                                    |
| `icon-tile.svg`       | Rounded green tile with the off-white bird (512 x 512). App and PWA icons.               |
| `icon-400.png`        | `icon-tile.svg` rendered at 400 x 400. Directory listings (Cline and others).            |
| `icon-maskable.svg`   | Full-bleed green square, bird inside the maskable safe zone (the central 80 % circle).   |
| `icon-tile-small.svg` | Small-size variant of the tile: wider facet gaps, larger bird.                           |
| `icon-tile-solid.svg` | Smallest-size variant: the facet gaps are closed, so the bird is a silhouette.           |

All files use `fill` attributes only (no styles), a tight `viewBox`, straight facet edges with at most one
decimal, and a `<title>`. The wordmark is outlines (no font needed); it was rebuilt from the traced letters
with true verticals, one stem width, one baseline and one x-height.

## Colours

| Name       | Hex       | Use                                                           |
| ---------- | --------- | ------------------------------------------------------------- |
| Deep green | `#1F4D3F` | Facets and wordmark on light backgrounds; tile background     |
| Sand       | `#D9C7A7` | The wing-tip facet, always                                    |
| Off-white  | `#F4EFE6` | Facets and wordmark on dark backgrounds; the bird on the tile |

## Clear space and minimum size

- Keep clear space of at least the height of the sand wing-tip facet (about 28 % of the bird's height) on every side of
  the lockup; keep it clear of text, edges and other logos.
- Mark alone: no smaller than 24 px tall on screen. Lockup: no smaller than 32 px tall (the wordmark is
  then about 7 px x-height). Below 24 px use the tile icons, not the bare mark.
- Never recolour the facets, rotate, stretch, outline, add shadows or place the green version on a dark or
  busy background; use the light version there.

## Dark backgrounds

Use `mark-light.svg` and `logo-light.svg`. On the site the inline logo switches between the two with
`light-dark()`; in the web app the facets follow the `--accent` token, which is pale green in the dark theme.

## Small sizes

At 16 and 32 px the 1.7 % facet gaps of the full mark would turn to mush, so the smallest icons use
simplified variants: `icon-tile-small.svg` (about 3.4 % gaps, larger bird) for 32 and 48 px and the SVG
favicon, and `icon-tile-solid.svg` (no gaps) for 16 px. Everything larger uses `icon-tile.svg`.

## Regenerating the icons

The PNG and ICO files are generated from these SVGs (using `@resvg/resvg-js`, already a dev dependency):

```sh
pnpm --filter @glideworth/site icons   # apps/site/public: favicon.svg, favicon.ico (16/32/48), apple-touch-icon, icon-192/512, icon-maskable-192/512
pnpm --filter @glideworth/web icons    # apps/web/public: glideworth.svg, icons/apple-touch-icon, icon-192/512, icon-maskable-192/512
```

The generated files are committed, so builds do not depend on the scripts. After editing an SVG here, run
both commands and commit the results. `apps/site/src/components/Logo.astro`, `apps/site/src/lib/brand.ts`
(social images) and `apps/web/src/components/layout/logo.tsx` import `mark.svg` and `logo.svg` directly.
There is no Safari pinned-tab icon because the site does not declare one.
