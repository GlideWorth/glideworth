import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { TOUR } from "../src/components/layout/tour";
import { buttonVariants } from "../src/components/ui/button";
import { inputBase } from "../src/components/ui/input";

// jsdom applies no CSS, so these pin the class and stylesheet contracts that make the app usable on
// phones. The layout itself was checked in a browser at 320 to 844px wide with a touch pointer.

describe("touch targets", () => {
  it("makes every button size at least 44px on touch screens", () => {
    for (const size of ["sm", "md", "lg", "icon"] as const) {
      expect(buttonVariants({ size })).toContain("pointer-coarse:min-h-11");
    }
    expect(buttonVariants({ size: "icon" })).toContain("pointer-coarse:min-w-11");
  });

  it("makes text fields 44px tall on touch screens", () => {
    expect(inputBase).toContain("pointer-coarse:min-h-11");
  });
});

describe("form fields on touch screens", () => {
  const css = readFileSync(resolve(__dirname, "../src/styles.css"), "utf8");
  // The rule sits outside every @layer, so it wins over the compact text-[13px] utilities.
  const coarse = css.slice(css.indexOf("@media (pointer: coarse)"));

  it("sets text fields to 16px, so iOS does not zoom the page on focus", () => {
    expect(coarse).toMatch(/input:not\([^)]*\),\s*select,\s*textarea\s*\{\s*font-size:\s*16px;/);
  });

  it("keeps the touch rules out of the Tailwind layers", () => {
    const before = css.slice(0, css.indexOf("@media (pointer: coarse)"));
    const opened = (before.match(/@layer[^{]*\{/g) ?? []).length;
    const depth = [...before].reduce((d, ch) => d + (ch === "{" ? 1 : ch === "}" ? -1 : 0), 0);
    expect(opened).toBeGreaterThan(0);
    expect(depth).toBe(0);
  });
});

describe("import tabs on a narrow screen", () => {
  // overflow-x: auto with the other axis left at visible computes that axis to auto, so the tab
  // row gained a vertical scrollbar and collapsed into a tiny box. The triggers stay one row and
  // scroll sideways.
  const page = readFileSync(resolve(__dirname, "../src/features/import/import-page.tsx"), "utf8");

  it("scrolls the tab row sideways without a vertical scrollbar", () => {
    expect(page).toContain("flex-nowrap overflow-x-auto overflow-y-hidden");
    expect(page).toContain("shrink-0 whitespace-nowrap");
  });
});

describe("tour on phones", () => {
  // Below 640px the top bar has no menu button and no search button: the bottom bar's More button
  // opens the navigation drawer, and search moves into the top bar's overflow menu.
  const stop = (id: string) => TOUR.find((s) => s.id === id)!;

  it("falls back to the bottom bar's More button wherever it points at the menu button", () => {
    for (const s of TOUR.filter((t) => t.anchors.includes('[data-tour="menu-button"]'))) {
      expect(s.anchors, s.id).toContain('[data-tour="bottom-nav-more"]');
    }
  });

  it("falls back to the overflow menu for search", () => {
    expect(stop("search").anchors).toEqual(['[data-tour="search"]', '[data-tour="more-menu"]']);
  });
});
