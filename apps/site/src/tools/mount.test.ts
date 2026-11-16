/**
 * The "continue in the planner" link is rendered by PlannerCta.astro, beside the calculator and not inside
 * its `[data-tool]` section. The page controller must therefore look for it in the whole document: looking
 * only inside the calculator left the link at the default inputs while the visitor typed their own.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(join(import.meta.dirname, rel), "utf8");

describe("planner link", () => {
  it("is updated from the whole page, because the box is outside the calculator section", () => {
    const mount = read("ui/mount.ts");
    expect(mount).toMatch(
      /document\.querySelectorAll<HTMLAnchorElement>\("\[data-planner-link\]"\)/,
    );
    expect(mount).not.toMatch(
      /root!?\.querySelectorAll<HTMLAnchorElement>\("\[data-planner-link\]"\)/,
    );
  });

  it("sits outside the calculator section on the page", () => {
    const page = read("../components/tools/ToolPage.astro");
    expect(page.indexOf("<Calculator")).toBeGreaterThan(-1);
    expect(page.indexOf("<PlannerCta")).toBeGreaterThan(page.indexOf("<Calculator"));
    expect(read("../components/tools/Calculator.astro")).not.toContain("data-planner-link");
  });
});
