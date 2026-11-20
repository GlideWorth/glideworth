/**
 * A demo page keeps its own copy of the persisted stores (lib/demo.ts `demoAwareStorage`): what this
 * browser saved for a real workspace, such as an import checklist naming people and plans, never shows
 * in the demo, and the demo never overwrites it.
 */
import { afterEach, describe, expect, it } from "vitest";
import { stashHandoff, readHandoff } from "../src/features/cloud/handoff";
import { clearDemoStorage, setDemoModeForTests } from "../src/lib/demo";
import { usePrefs } from "../src/stores/prefs";

const REAL_KEY = "glideworth-prefs";
const realChecklist = {
  source: "ProjectionLab",
  at: "2026-11-16T00:00:00Z",
  items: [
    { id: "people", label: "Check people", detail: "Real names · GBP", to: "/", done: false },
  ],
};

afterEach(() => {
  setDemoModeForTests(false);
  localStorage.clear();
});

describe("demo storage isolation", () => {
  it("does not load the real workspace's saved preferences into the demo", async () => {
    // Reset first: setState writes through to storage.
    usePrefs.setState({ importChecklist: null });
    localStorage.setItem(
      REAL_KEY,
      JSON.stringify({ state: { importChecklist: realChecklist }, version: 1 }),
    );
    setDemoModeForTests(true);
    await usePrefs.persist.rehydrate();
    expect(usePrefs.getState().importChecklist).toBeNull();
  });

  it("writes demo changes under the demo prefix and leaves the real key alone", async () => {
    const real = JSON.stringify({ state: { importChecklist: realChecklist }, version: 1 });
    localStorage.setItem(REAL_KEY, real);
    setDemoModeForTests(true);
    await usePrefs.persist.rehydrate();
    usePrefs.getState().set({ tour: "done" });

    expect(localStorage.getItem(REAL_KEY)).toBe(real);
    expect(localStorage.getItem(`glideworth:demo:${REAL_KEY}`)).toContain('"tour":"done"');

    clearDemoStorage();
    expect(localStorage.getItem(`glideworth:demo:${REAL_KEY}`)).toBeNull();
    expect(localStorage.getItem(REAL_KEY)).toBe(real);
  });

  it("still uses the real key outside the demo", async () => {
    localStorage.setItem(
      REAL_KEY,
      JSON.stringify({ state: { importChecklist: realChecklist }, version: 1 }),
    );
    await usePrefs.persist.rehydrate();
    expect(usePrefs.getState().importChecklist?.items[0]?.detail).toBe("Real names · GBP");
  });

  it("ignores a calculator hand-off in the demo", () => {
    stashHandoff({ tool: "fire", values: {} } as Parameters<typeof stashHandoff>[0]);
    expect(readHandoff()).not.toBeNull();
    setDemoModeForTests(true);
    expect(readHandoff()).toBeNull();
  });
});
