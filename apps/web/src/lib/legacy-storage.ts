/**
 * Browser storage keys started with `cairn` before the rename to Glideworth. At start-up, before any store
 * reads its key, every old key is copied to its new name (unless the new one already exists) and removed, so
 * theme, preferences, drafts, the offline sample and saved chart views survive the upgrade.
 */
const LEGACY_NAMED = ["cairn-ui", "cairn-prefs", "cairn-chart-prefs"];

/** The current name of a pre-rename storage key, or null when `key` is not one. */
export function renamedStorageKey(key: string): string | null {
  if (key.startsWith("cairn:")) return `glideworth:${key.slice("cairn:".length)}`;
  if (LEGACY_NAMED.includes(key)) return `glideworth-${key.slice("cairn-".length)}`;
  return null;
}

/** Move pre-rename keys to their new names. Returns how many were moved. Never throws. */
export function migrateLegacyStorage(
  storage: Storage | undefined = globalThis.localStorage,
): number {
  let moved = 0;
  try {
    if (!storage) return 0;
    const keys: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i);
      if (k) keys.push(k);
    }
    for (const old of keys) {
      const next = renamedStorageKey(old);
      if (!next) continue;
      const value = storage.getItem(old);
      if (value !== null && storage.getItem(next) === null) {
        storage.setItem(next, value);
        moved++;
      }
      storage.removeItem(old);
    }
  } catch {
    // Storage unavailable (private mode, quota): the app starts with defaults, as before.
  }
  return moved;
}

migrateLegacyStorage();
