import { describe, expect, it } from "vitest";
import {
  deferredChanceState,
  replaceShareLink,
  revokePrompt,
} from "../src/features/share/share-links";

describe("share list updates", () => {
  it("names the link in the revoke confirmation", () => {
    expect(revokePrompt({ label: "For Pat" })).toEqual({
      title: "Revoke “For Pat”?",
      description: "Anyone who has “For Pat” loses access immediately.",
    });
    expect(revokePrompt({ label: "  " }).title).toBe("Revoke “Untitled link”?");
    expect(revokePrompt({ label: null }).title).toBe("Revoke “Untitled link”?");
  });

  it("replaces the matching link and leaves the others", () => {
    const items = [
      { id: "a", status: "active" },
      { id: "b", status: "active" },
    ];
    expect(replaceShareLink(items, { id: "a", status: "revoked" })).toEqual([
      { id: "a", status: "revoked" },
      { id: "b", status: "active" },
    ]);
  });

  it("stops saying the run is in progress when the job cannot be read", () => {
    expect(deferredChanceState({ status: undefined, isError: false })).toBe("running");
    expect(deferredChanceState({ status: "running", isError: false })).toBe("running");
    expect(deferredChanceState({ status: undefined, isError: true })).toBe("unknown");
    expect(deferredChanceState({ status: "succeeded", isError: false })).toBe("added");
    expect(deferredChanceState({ status: "failed", isError: false })).toBe("failed");
    expect(deferredChanceState({ status: "cancelled", isError: true })).toBe("failed");
  });
});
