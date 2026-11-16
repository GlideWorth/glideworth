import { describe, expect, it } from "vitest";
import { migrateLegacyStorage, renamedStorageKey } from "../src/lib/legacy-storage";

/** A minimal in-memory Storage. */
function memoryStorage(entries: Record<string, string> = {}): Storage {
  const m = new Map(Object.entries(entries));
  return {
    get length() {
      return m.size;
    },
    key: (i) => [...m.keys()][i] ?? null,
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, String(v)),
    removeItem: (k) => void m.delete(k),
    clear: () => m.clear(),
  };
}

const dump = (s: Storage) =>
  Object.fromEntries(
    Array.from({ length: s.length }, (_, i) => s.key(i)!).map((k) => [k, s.getItem(k)]),
  );

describe("browser storage keys from before the rename", () => {
  it("maps every pre-rename key to its new name and leaves other keys alone", () => {
    expect(renamedStorageKey("cairn-ui")).toBe("glideworth-ui");
    expect(renamedStorageKey("cairn-prefs")).toBe("glideworth-prefs");
    expect(renamedStorageKey("cairn-chart-prefs")).toBe("glideworth-chart-prefs");
    expect(renamedStorageKey("cairn:settings:v1")).toBe("glideworth:settings:v1");
    expect(renamedStorageKey("cairn:drafts:v1:hh-1")).toBe("glideworth:drafts:v1:hh-1");
    expect(renamedStorageKey("cairn:chart-views:v1:p1")).toBe("glideworth:chart-views:v1:p1");
    expect(renamedStorageKey("glideworth-ui")).toBeNull();
    expect(renamedStorageKey("cairn-other")).toBeNull();
    expect(renamedStorageKey("something-else")).toBeNull();
  });

  it("moves theme, preferences and drafts to the new keys, once, without overwriting newer values", () => {
    const theme = JSON.stringify({ state: { theme: "dark", density: "compact" }, version: 0 });
    const s = memoryStorage({
      "cairn-ui": theme,
      "cairn-prefs": '{"state":{"tour":null},"version":1}',
      "cairn:drafts:v1:hh-1": '{"plan":1}',
      "cairn:settings:v1": '{"old":true}',
      "glideworth:settings:v1": '{"new":true}',
      unrelated: "x",
    });
    expect(migrateLegacyStorage(s)).toBe(3);
    expect(dump(s)).toEqual({
      "glideworth-ui": theme,
      "glideworth-prefs": '{"state":{"tour":null},"version":1}',
      "glideworth:drafts:v1:hh-1": '{"plan":1}',
      "glideworth:settings:v1": '{"new":true}',
      unrelated: "x",
    });
    expect(migrateLegacyStorage(s)).toBe(0);
  });

  it("never throws when storage is unavailable", () => {
    const broken = {
      get length(): number {
        throw new Error("SecurityError");
      },
    } as unknown as Storage;
    expect(migrateLegacyStorage(broken)).toBe(0);
  });
});
