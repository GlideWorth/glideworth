import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Issue #39: on 360 to 390px phones the calculator form was wider than the screen. Its grids had an
// implicit auto column, which takes the min-content width of the widest <input> (about 20 characters
// plus a "years old" suffix), so the inputs ran off the edge and the page scrolled sideways.
// The layout was checked in a browser from 320px up; this pins the CSS that fixes it.
const css = readFileSync(new URL("./Calculator.astro", import.meta.url), "utf8");

/** The declarations of the first rule whose selector list is exactly `selector`. */
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/,\s*/g, ",\\s*");
  const match = new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  if (!match) throw new Error(`no rule for ${selector}`);
  return match[1]!;
}

describe("calculator form on a phone", () => {
  it("gives the form's grids a column that can shrink below its content", () => {
    for (const selector of [".tool-form", ".tool-fields"]) {
      expect(rule(selector), selector).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)/);
      expect(rule(selector), selector).toMatch(/min-width:\s*0/);
    }
    expect(rule(".tool-field")).toMatch(/min-width:\s*0/);
  });

  it("lets a number input shrink so its suffix stays visible", () => {
    const input = rule(".tool-input input");
    expect(input).toMatch(/width:\s*0;/);
    expect(input).toMatch(/min-width:\s*0;/);
    expect(input).toMatch(/flex:\s*1 1 auto;/);
  });

  it("keeps inputs, selects and buttons at least 44px tall on touch screens", () => {
    const coarse = css.slice(css.indexOf("@media (pointer: coarse)"));
    expect(coarse).toMatch(
      /\.tool-input input,\s*\.tool-field select,\s*\.tool-btn\s*\{\s*min-height:\s*2\.75rem;/,
    );
  });
});
