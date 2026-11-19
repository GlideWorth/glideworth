import { describe, expect, it } from "vitest";
import { pages } from "./pages";
import { site } from "./site";

const entries = Object.entries(pages);

describe("page descriptions", () => {
  // The same hard limit as scripts/check-dist.mjs; 120 to 160 is the aim, and a few pages run a little over.
  it.each(entries)("%s is at most 180 characters", (_path, meta) => {
    expect(meta.description.length).toBeLessThanOrEqual(180);
  });

  it("keeps /pricing/ within 120 to 160 characters", () => {
    expect(pages["/pricing/"].description.length).toBeGreaterThanOrEqual(120);
    expect(pages["/pricing/"].description.length).toBeLessThanOrEqual(160);
  });

  it("keeps the home page description within 120 to 155 characters", () => {
    expect(pages["/"].description.length).toBeGreaterThanOrEqual(120);
    expect(pages["/"].description.length).toBeLessThanOrEqual(155);
  });

  it("are unique", () => {
    const descriptions = entries.map(([, meta]) => meta.description);
    expect(new Set(descriptions).size).toBe(descriptions.length);
  });

  it.runIf(site.cloudLaunched)(
    "do not call the hosted service unopened once it has launched",
    () => {
      const stale = /opens later|about to open|opens soon|not open yet/i;
      const offenders = entries
        .filter(([, meta]) => stale.test(meta.description))
        .map(([path]) => path);
      expect(offenders).toEqual([]);
    },
  );
});
