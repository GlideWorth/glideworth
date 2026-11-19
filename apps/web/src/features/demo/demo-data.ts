/**
 * The demo's household: the bundled SYNTHETIC sample (`createSampleDocument`, the same one the app shows
 * offline), or this browser's edited copy of it. Loaded on demand by the workspace query on a demo page.
 * Never reads anything a real workspace stored.
 */
import { GlideworthDocument } from "@glideworth/core";
import { createSampleDocument } from "@glideworth/core/samples";
import { DEMO_KEYS } from "../../lib/demo";

export function loadDemoDocument(): GlideworthDocument {
  try {
    const raw = localStorage.getItem(DEMO_KEYS.doc);
    if (raw) {
      const parsed = GlideworthDocument.safeParse(JSON.parse(raw));
      if (parsed.success) return parsed.data;
    }
  } catch {
    /* unreadable or blocked storage: start from the sample */
  }
  return createSampleDocument();
}
