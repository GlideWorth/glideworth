import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyResultVisibility } from "./result-visibility";

function fakeResults() {
  const classes = new Set<string>();
  const attrs = new Map<string, string>();
  return {
    el: {
      classList: {
        toggle(token: string, force?: boolean) {
          const on = force ?? !classes.has(token);
          if (on) classes.add(token);
          else classes.delete(token);
          return on;
        },
      },
      setAttribute(name: string, value: string) {
        attrs.set(name, value);
      },
      removeAttribute(name: string) {
        attrs.delete(name);
      },
    },
    classes,
    attrs,
  };
}

describe("calculator results while the inputs are invalid", () => {
  it("hides the previous result instead of leaving it fully visible", () => {
    const r = fakeResults();
    applyResultVisibility(r.el, { invalid: false, busy: true });
    expect(r.classes.has("is-stale")).toBe(true);
    expect(r.classes.has("is-invalid")).toBe(false);

    applyResultVisibility(r.el, { invalid: true, busy: false });
    expect(r.classes.has("is-invalid")).toBe(true);
    expect(r.classes.has("is-stale")).toBe(false);
    expect(r.attrs.get("aria-hidden")).toBe("true");
  });

  it("shows the result again once the inputs are valid", () => {
    const r = fakeResults();
    applyResultVisibility(r.el, { invalid: true, busy: false });
    applyResultVisibility(r.el, { invalid: false, busy: false });
    expect(r.classes.has("is-invalid")).toBe(false);
    expect(r.attrs.has("aria-hidden")).toBe(false);
  });

  it("the invalid class removes the results from the page", () => {
    const css = readFileSync(
      join(import.meta.dirname, "../../components/tools/Calculator.astro"),
      "utf8",
    );
    expect(css).toMatch(/\.tool-results\.is-invalid\s*\{\s*display:\s*none;/);
  });
});
